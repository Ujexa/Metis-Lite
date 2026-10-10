import { describe, expect, it } from "vitest";
import { parseJsonObject } from "./openRouter";

describe("openRouter response parsing", () => {
  it("parses plain JSON", () => {
    expect(parseJsonObject('{"ok":true}')).toEqual({ ok: true });
  });

  it("parses fenced JSON", () => {
    expect(parseJsonObject('```json\n{"answer":"42"}\n```')).toEqual({ answer: "42" });
  });

  it("parses JSON embedded in a short wrapper", () => {
    expect(parseJsonObject('Result:\n{"items":[]}')).toEqual({ items: [] });
  });
});

import { afterEach, vi } from "vitest";
import { backoffDelayMs, callOpenRouterJson, parseRetryAfter } from "./openRouter";

describe("openRouter retry and backoff", () => {
  afterEach(() => vi.unstubAllGlobals());
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }), { status: 200 });

  it("parses Retry-After seconds and dates, capped", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("9999")).toBe(60_000);
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:05 GMT", Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"))).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
  it("backs off exponentially with jitter and honours Retry-After", () => {
    expect(backoffDelayMs(1, undefined, () => 0)).toBe(750);
    expect(backoffDelayMs(2, undefined, () => 1)).toBe(3000);
    expect(backoffDelayMs(9, undefined, () => 1)).toBe(30_000);
    expect(backoffDelayMs(1, 1234)).toBe(1234);
  });
  it("retries a 429 and then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    await expect(callOpenRouterJson("k", "a/b", [], { name: "x" })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not retry an auth failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(callOpenRouterJson("k", "a/b", [], { name: "x" })).rejects.toThrow(/bad key/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("gives up after three attempts on persistent 503s", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 503, headers: { "retry-after": "0" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(callOpenRouterJson("k", "a/b", [], { name: "x" })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
