// `archstone audit <file…>` — the I/O half of the audit reader (`audit-report.ts` holds the
// pure half). Reads the deployer's own JSON Lines files, filters, and renders.
//
// Note what it is not: there is no service, no index, no daemon and no upload. The records live
// on the deployer's disk, Archstone never receives them, and this verb is a reader over local
// files — which is also why it needs no configuration beyond the paths.

import { readFileSync } from "node:fs";
import { applyFilter, parseAuditLines, summarize, toCsv, type AuditFilter } from "./audit-report";

const FORMATS = ["summary", "jsonl", "csv"] as const;
type Format = (typeof FORMATS)[number];

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function isoOrExit(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  // Accept a date (2026-08-21) as well as a full timestamp: an auditor asks for "August", not
  // for an RFC 3339 instant. A bare date compares correctly against a stored ISO timestamp
  // because both are lexicographically ordered — which is the same property the records rely on.
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value)) {
    console.error(`archstone audit: ${name} must be a date or ISO timestamp (e.g. 2026-08-21 or 2026-08-21T09:00:00Z), got '${value}'`);
    process.exit(2);
  }
  return value;
}

export function printAuditUsage(): void {
  console.error(
    "usage: archstone audit <file…> [--since <date>] [--until <date>] [--capability <id>]\n" +
      "                            [--principal <p>] [--phase succeeded|failed|denied]\n" +
      "                            [--format summary|jsonl|csv]\n" +
      "\n" +
      "  Read Execution audit records (JSON Lines) that your own deployment wrote, and report on\n" +
      "  them. Nothing is uploaded: these are your files, read locally.\n" +
      "\n" +
      "  --since <date>       inclusive lower bound on startedAt (date or ISO timestamp)\n" +
      "  --until <date>       exclusive upper bound — so adjacent ranges tile without overlap\n" +
      "  --capability <id>    exact CDL capability id, e.g. framing.estimate-frame-price\n" +
      "  --principal <p>      exact principal, e.g. user:alice\n" +
      "  --anonymous          only invocations that carried no principal at all\n" +
      "  --phase <p>          succeeded | failed | denied\n" +
      "  --format <f>         summary (default) · jsonl (filtered passthrough) · csv (spreadsheet)\n" +
      "\n" +
      "  Pass rotated generations too — the sink writes <path>.1, <path>.2, …:\n" +
      "    archstone audit audit.log audit.log.1 --since 2026-08-01 --format csv > q3.csv\n",
  );
}

export function runAuditCmd(argv: string[]): number {
  const files = argv.slice(1).filter((a, i, all) => {
    if (a.startsWith("--")) return false;
    const prev = all[i - 1];
    return !(prev?.startsWith("--") && prev !== "--json"); // not a flag's value
  });

  if (files.length === 0) {
    printAuditUsage();
    return 2;
  }

  const format = (flag(argv, "--format") ?? "summary") as Format;
  if (!FORMATS.includes(format)) {
    console.error(`archstone audit: --format must be one of ${FORMATS.join(" | ")}, got '${format}'`);
    return 2;
  }

  const filter: AuditFilter = {
    since: isoOrExit(flag(argv, "--since"), "--since"),
    until: isoOrExit(flag(argv, "--until"), "--until"),
    capability: flag(argv, "--capability"),
    principal: argv.includes("--principal") ? (flag(argv, "--principal") ?? "") : undefined,
    anonymous: argv.includes("--anonymous"),
    phase: flag(argv, "--phase"),
  };

  // An empty `--principal` used to be how anonymous invocations were selected (v0.12.0). It
  // reads like a mistake in a shell, and it is indistinguishable from one — so it is now an
  // error that names the right flag rather than a subtlety that quietly answers a different
  // question than the operator asked.
  if (filter.principal === "") {
    console.error(
      "archstone audit: --principal '' is not how you select anonymous invocations — use --anonymous.\n" +
        "  (An empty principal would mean the host supplied the empty string, which is a different thing.)",
    );
    return 2;
  }
  if (filter.anonymous && filter.principal !== undefined) {
    console.error("archstone audit: --anonymous and --principal are mutually exclusive — a call is one or the other.");
    return 2;
  }

  const records = [];
  let skipped = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      console.error(`archstone audit: cannot read '${file}': ${(err as Error).message}`);
      return 1;
    }
    const outcome = parseAuditLines(text);
    records.push(...outcome.records);
    // Never silent: an unreadable line in an audit trail is either corruption or a record from a
    // version this reader does not understand, and both are the operator's business.
    for (const s of outcome.skipped) console.error(`archstone audit: ${file}:${s.line} skipped — ${s.reason}`);
    skipped += outcome.skipped.length;
  }

  // Chronological regardless of the order the files were given, so `audit.log.1 audit.log` and
  // `audit.log audit.log.1` produce the same report.
  const filtered = applyFilter(records, filter).sort((a, b) =>
    a.metadata.startedAt.localeCompare(b.metadata.startedAt),
  );

  if (format === "jsonl") console.log(filtered.map((r) => JSON.stringify(r)).join("\n"));
  else if (format === "csv") console.log(toCsv(filtered));
  else console.log(summarize(filtered));

  if (skipped > 0) console.error(`archstone audit: ${skipped} line(s) skipped — see above.`);
  return 0;
}
