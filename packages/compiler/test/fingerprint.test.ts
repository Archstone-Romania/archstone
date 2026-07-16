import { describe, it, expect } from "vitest";
import { fingerprintShape } from "../src/fingerprint";

describe("fingerprintShape (ADD-18)", () => {
  it("is stable across value variation (same keys/types, different data)", () => {
    const a = { stays: [{ name: "Hotel A", price: 100, rating: 4.5 }] };
    const b = { stays: [{ name: "Hotel B", price: 200, rating: 3.1 }] };
    expect(fingerprintShape(a)).toBe(fingerprintShape(b));
  });

  it("changes when a key is renamed", () => {
    const a = { stays: [{ name: "Hotel A", price: 100 }] };
    const b = { stays: [{ name: "Hotel A", cost: 100 }] };
    expect(fingerprintShape(a)).not.toBe(fingerprintShape(b));
  });

  it("changes when a value's type changes", () => {
    const a = { price: 100 };
    const b = { price: "100" };
    expect(fingerprintShape(a)).not.toBe(fingerprintShape(b));
  });

  it("is insensitive to key order", () => {
    const a = { name: "X", price: 1 };
    const b = { price: 1, name: "X" };
    expect(fingerprintShape(a)).toBe(fingerprintShape(b));
  });

  it("distinguishes an empty array from an absent one", () => {
    const withEmpty = fingerprintShape({ stays: [] });
    const without = fingerprintShape({});
    expect(withEmpty).not.toBe(without);
  });

  it("is prefixed sha256: and stable for a fixed input", () => {
    const fp = fingerprintShape({ a: 1 });
    expect(fp).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprintShape({ a: 1 })).toBe(fp);
  });
});
