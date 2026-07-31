// The OpenAPI 3.x adapter (ADD-37 §6 step 5, amended by D-10 / D-11 / D-12 / D-13).
//
// The FIRST `SourceAdapter`. It reads an OpenAPI document (3.0 or 3.1, YAML or JSON) that the
// host already fetched, and produces a Draft Model. It decides nothing a human must decide:
// no `effect`, no capability id, no domain, no resource name, no `ref:`. Those all live in the
// Decision Record, and this file cannot reach them.
//
// NO LLM. Every fact here is read out of the document or reported as absent.
//
// D-13 — spec `example:` values are SEEDED onto `DraftInputField.example` and are read by the
// gate as a pre-fill and by the emitter as a legibility comment. They are NEVER read as probe
// input: the probe reads `DecisionRecord.sampleInput` and nothing else. The reason is not
// fussiness — a probe is a live request to a production backend carrying a value the human did
// not choose, and in the oracle document `id.example: AV45` is a real product code while
// `artwork_id.example` is a made-up UUID. `init` cannot tell those apart, and the general case
// is not the benign one.

import { absent, declared, type DraftModel, type SourceAdapter, type SourceInput } from "../../model";
import { note, type Note } from "../../reasons";
import { DocumentSet, PRIMARY, collectDocumentReferences, isObject, type JsonObject } from "./document";
import { collectOperations } from "./operations";

/** Company facts, such as they are. `info.title` is a product name, not a company name — but
 *  it is what the document has, and the human confirms it at the gate anyway. `company.id` is
 *  deliberately never derived: it must match `^[a-z][a-z0-9-]*$` and a wrong guess produces a
 *  manifest whose every file names the wrong company. */
function companyOf(root: JsonObject | undefined): DraftModel["company"] {
  const info = root !== undefined && isObject(root["info"]) ? root["info"] : undefined;
  const title = info?.["title"];
  const description = info?.["description"];
  return {
    id: absent<string>("no OpenAPI construct carries a company id — the Decision Record supplies it"),
    name: typeof title === "string" && title.trim() !== "" ? declared(title.trim(), "#/info/title") : absent<string>(),
    description:
      typeof description === "string" && description.trim() !== ""
        ? declared(description.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? description.trim(), "#/info/description")
        : absent<string>(),
  };
}

function emptyModel(origin: string, notes: Note[]): DraftModel {
  return {
    version: "0",
    source: { adapter: "openapi", origin },
    company: companyOf(undefined),
    baseUrl: absent<string>("no document"),
    operations: [],
    notes,
  };
}

export const openApiAdapter: SourceAdapter = {
  id: "openapi",
  summary: "an OpenAPI 3.0/3.1 document (YAML or JSON), including multi-file component sets",

  /**
   * D-11 — the documents this adapter still needs before it can see the whole spec.
   *
   * A `$ref` into another file is not exotic: on the oracle, `FrameProfileList.allOf[0]` points
   * at a shared `Pagination` schema in a component library, and an adapter that cannot resolve
   * it must fail closed — an unresolved member could contribute an array-of-objects property
   * and change the item-locus census. Failing closed there skips the list capability, which is
   * half the oracle. So the host fetches, and this stays pure.
   */
  references(input: SourceInput): string[] {
    const docs = new DocumentSet(input.document, input.documents);
    const have = new Set(docs.keys());
    return collectDocumentReferences(docs).filter((key) => key !== PRIMARY && !have.has(key));
  },

  adapt(input: SourceInput): DraftModel {
    const notes: Note[] = [];
    const docs = new DocumentSet(input.document, input.documents);

    if (input.document === undefined) {
      notes.push(note("unsupported-operation-shape", "manifest", undefined, "this adapter needs a document; none was supplied"));
      return emptyModel(input.origin, notes);
    }
    for (const key of docs.unparsable) {
      notes.push(note("unsupported-operation-shape", "manifest", undefined, `${key === PRIMARY ? "the document" : key} is not parseable YAML or JSON`));
    }
    const root = docs.primary;
    if (!isObject(root)) return emptyModel(input.origin, notes);

    const version = root["openapi"];
    if (typeof version !== "string" || !/^3\./.test(version)) {
      // Refused rather than attempted: a Swagger 2.0 document uses `definitions`, `basePath`
      // and a different parameter model, and reading it with 3.x rules produces a manifest
      // that is confidently wrong instead of honestly absent.
      notes.push(note("unsupported-operation-shape", "manifest", undefined, `not an OpenAPI 3.x document (openapi: ${String(version ?? "absent")})`));
      return emptyModel(input.origin, notes);
    }

    // Anything still unresolved after the host's closure loop. Named here rather than
    // discovered per-`$ref`, so the report can say "you are missing this file" once.
    const stillMissing = this.references!(input);
    for (const key of stillMissing) {
      notes.push(note("unsupported-ref", "manifest", undefined, `referenced document '${key}' was not supplied — operations that need it are skipped`));
    }

    const collected = collectOperations(docs, notes);

    return {
      version: "0",
      source: { adapter: "openapi", origin: input.origin },
      company: companyOf(root),
      baseUrl: collected.baseUrl,
      ...(collected.auth ? { auth: collected.auth } : {}),
      operations: collected.operations,
      notes,
    };
  },
};
