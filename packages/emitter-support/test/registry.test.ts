import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Registry } from "../src/registry";
import { compile } from "@archstone/compiler";
import { load } from "@archstone/schema";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

describe("Registry over IR", () => {
  const registry = new Registry(compile(load(join(manifests, "booking"))));

  it("lists and resolves capabilities", () => {
    expect(registry.size).toBe(4);
    expect(registry.listCapabilities().map((t) => t.id)).toContain("tourism.search");
    expect(registry.getCapability("tourism.search")?.effect).toBe("read");
    expect(registry.getCapability("does.not-exist")).toBeUndefined();
  });
});
