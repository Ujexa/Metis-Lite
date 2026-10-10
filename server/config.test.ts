import { describe, expect, it } from "vitest";
import { parseTrustProxyHops } from "./config.ts";

describe("parseTrustProxyHops", () => {
  it("defaults to trusting no proxy", () => {
    expect(parseTrustProxyHops(undefined)).toBe(0);
    expect(parseTrustProxyHops("")).toBe(0);
    expect(parseTrustProxyHops("   ")).toBe(0);
  });

  it("accepts non-negative integer hop counts", () => {
    expect(parseTrustProxyHops("0")).toBe(0);
    expect(parseTrustProxyHops("1")).toBe(1);
    expect(parseTrustProxyHops("3")).toBe(3);
  });

  it.each(["-1", "1.5", "one", "Infinity", "9007199254740992"])(
    "rejects an invalid hop count: %s",
    value => {
      expect(() => parseTrustProxyHops(value)).toThrow(/TRUST_PROXY_HOPS/);
    }
  );
});
