import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "@archstone/schema";
import { compile } from "@archstone/compiler";
import { invokeRest, type FetchLike } from "../src/index";

// End-to-end coverage for #26: a binding's `rest.query` map correctly remaps camelCase
// CDL input field names to a backend's snake_case wire query-param names, instead of
// embedding them in the path template.
//
// Originally this test loaded ArtVinci's real, production-verified manifest from
// examples/manifests/artvinci. That manifest was retired from ai-gateway as part of #35
// (its real contract now lives solely in artvinci-website's own repository — see
// Issue #34's manifest-ownership pattern). This test now loads a small, wholly fictional
// fixture manifest (test/fixtures/query-remap/) that exercises the exact same
// load() -> compile() -> invokeRest() shape, so the #26 regression coverage survives the
// migration (BR-3).

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, "fixtures/query-remap");

describe("#26 widget.estimate-price: rest.query end to end", () => {
  it("sends width_cm/height_cm on the wire from widthCm/heightCm CDL input", async () => {
    const ir = compile(load(fixtureDir));
    const tool = ir.tools.find((t) => t.id === "widget.estimate-price")!;
    expect(tool.connector?.rest?.path).toBe("/api/v1/catalog/widgets/{widgetId}/price");
    expect(tool.connector?.rest?.query).toEqual({ widthCm: "width_cm", heightCm: "height_cm" });

    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response(JSON.stringify({ estimatedPrice: 42, currency: "RON" }), { status: 200 });
    };

    const r = await invokeRest(
      tool,
      { widgetId: "W8", widthCm: 40, heightCm: 60 },
      { env: { WIDGETS_API_URL: "https://api.acme-widgets.example" }, fetchImpl },
    );

    expect(r.ok).toBe(true);
    expect(captured?.url).toBe(
      "https://api.acme-widgets.example/api/v1/catalog/widgets/W8/price?width_cm=40&height_cm=60",
    );
  });
});
