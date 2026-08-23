// @archstone/runtime — file-backed audit retention.
//
// `@archstone/emitter-support` ships `jsonLinesAuditSink`: one line, one write, no retention,
// because that package imports no `node:` module and must stay usable on an edge runtime. A
// self-hosted deployment that has to *keep* its audit trail — the whole point of an evidentiary
// log — then has to solve rotation itself, which is where this lives: `runtime` already reads
// the filesystem (`registry`), so fs belongs here and only here.
//
// Deliberately NOT a shipping/collector sink. Sending records to Splunk, an OTLP endpoint or an
// S3 bucket is HTTP, and HTTP appears in exactly one package in this repository (`providers/rest`)
// — a rule worth more than the convenience. Wrap this sink, or write your own; a sink is a
// function.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditSink, ExecutionRecord } from "@archstone/emitter-support";

export interface RotatingFileAuditSinkOptions {
  /** Where the live file goes. Rotated generations are `<path>.1` … `<path>.<maxFiles>`. */
  path: string;
  /** Rotate once the live file would exceed this. Default 64 MiB. */
  maxBytes?: number;
  /** How many rotated generations to keep. The oldest is deleted on rotation. Default 10. */
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10;

/**
 * A JSON Lines audit sink that rotates by size and bounds its own disk use.
 *
 * **Size, not time.** An audit stream grows with invocations, not with the clock: hourly
 * rotation on a quiet deployment produces a directory of empty files, and on a busy one produces
 * a single file that outgrows the disk between rotations. Size-based rotation gives the one
 * guarantee an operator actually needs — total footprint is at most
 * `maxBytes × (maxFiles + 1)`, computable before deployment and independent of traffic.
 *
 * **Synchronous, on purpose.** `appendFileSync` per record costs a syscall; a buffered writer
 * would be faster and would lose the last N records exactly when they matter most — a crash,
 * an OOM kill, a `SIGKILL` during an incident. An audit record still in a buffer when the
 * process dies is a record that never existed. Evidentiary logs trade throughput for durability;
 * if that trade is wrong for a deployment, wrap a buffered writer yourself and own the loss.
 *
 * **Single writer.** The live file's size is tracked in memory (seeded from `statSync` at
 * construction) so the common path is one `append` and no `stat`. Two processes appending to the
 * same path therefore rotate on each other's estimates — give each instance its own path, which
 * a shared volume makes trivial and which also keeps records attributable to an instance.
 *
 * Rotation is `rename`, so the live inode is replaced and no record is ever rewritten in place.
 * A failure to rotate (permissions, a full disk) surfaces as an ordinary sink failure:
 * `emitExecutionRecord` catches it, announces the loss on stderr, and the invocation itself is
 * unaffected — an audit backend must never be able to take the capability down.
 */
export function rotatingFileAuditSink(opts: RotatingFileAuditSinkOptions): AuditSink {
  const { path } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

  if (!path) throw new Error("rotatingFileAuditSink: `path` is required.");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`rotatingFileAuditSink: maxBytes must be a positive integer, got ${String(maxBytes)}.`);
  }
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new Error(`rotatingFileAuditSink: maxFiles must be a positive integer, got ${String(maxFiles)}.`);
  }

  // Fail at wiring time, not at the first denied invocation: a deployer who mistyped the path
  // should learn now, while they are looking at the config, and not from a stream of caught
  // sink failures under load.
  mkdirSync(dirname(path), { recursive: true });

  let liveBytes = existsSync(path) ? statSync(path).size : 0;

  function rotate(): void {
    // Oldest first, so nothing is overwritten before it has been moved along.
    const oldest = `${path}.${maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
    }
    if (existsSync(path)) renameSync(path, `${path}.1`);
    liveBytes = 0;
  }

  return (record: ExecutionRecord) => {
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line);
    // A single record larger than the whole budget still gets written, to its own generation,
    // rather than being silently dropped: losing an oversized record is losing evidence, and a
    // deployer who sees one file over budget can raise maxBytes. Dropping it teaches nothing.
    if (liveBytes > 0 && liveBytes + size > maxBytes) rotate();
    appendFileSync(path, line);
    liveBytes += size;
  };
}
