import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "@archstone/schema";
import { compile } from "@archstone/compiler";
import { invokeRest, type FetchLike } from "../src/index";

// End-to-end coverage for #26: the artvinci manifest's framing.estimate-frame-price
// binding declares `rest.query` to remap camelCase CDL fields to the backend's
// snake_case wire params, instead of embedding them in the path template. Load the
// real manifest, compile to IR, and invoke — asserting the actual request URL.

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

describe("#26 artvinci framing.estimate-frame-price: rest.query end to end", () => {
  it("sends width_cm/height_cm on the wire from widthCm/heightCm CDL input", async () => {
    const ir = compile(load(join(manifests, "artvinci")));
    const tool = ir.tools.find((t) => t.id === "framing.estimate-frame-price")!;
    expect(tool.connector?.rest?.path).toBe("/api/v1/catalog/frames/{frameProfileId}/price");
    expect(tool.connector?.rest?.query).toEqual({ widthCm: "width_cm", heightCm: "height_cm" });

    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response(JSON.stringify({ estimatedPrice: 42, currency: "RON" }), { status: 200 });
    };

    const r = await invokeRest(
      tool,
      { frameProfileId: "AV8", widthCm: 40, heightCm: 60 },
      { env: { ARTVINCI_API_URL: "https://api.artvinci.ro" }, fetchImpl },
    );

    expect(r.ok).toBe(true);
    expect(captured?.url).toBe(
      "https://api.artvinci.ro/api/v1/catalog/frames/AV8/price?width_cm=40&height_cm=60",
    );
  });
});
