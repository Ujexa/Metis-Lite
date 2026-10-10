import { describe, expect, it } from "vitest";
import { findNodes, formatForPath, normalizeQuery, parse3DAssetsRecords } from "./modelSearch.ts";

describe("federated 3D search helpers", () => {
  it("normalizes and bounds user search terms", () => {
    expect(normalizeQuery("  motor\u0000 pump  ")).toBe("motor pump");
    expect(normalizeQuery("x".repeat(130))).toHaveLength(100);
  });

  it("recognizes supported model paths", () => {
    expect(formatForPath("3D Models/Engine.glb")).toBe("GLB");
    expect(formatForPath("part.STL")).toBe("STL");
    expect(formatForPath("assembly.gltf")).toBe("GLTF");
    expect(formatForPath("preview.obj")).toBeNull();
  });

  it("parses the 3DAssets.dev response wrapper", () => {
    expect(parse3DAssetsRecords({ data: [{ slug: "pump" }, { slug: "motor" }] })).toHaveLength(2);
    expect(parse3DAssetsRecords([{ slug: "bearing" }])).toHaveLength(1);
    expect(parse3DAssetsRecords(null)).toEqual([]);
  });

  it("finds model file nodes even when providers call the size field bytes", () => {
    const found = findNodes({ glb: { url: "https://dl.polyhaven.org/files/model.glb", bytes: 1234 }, ignored: { value: "x" } });
    expect(found).toContainEqual({ url: "https://dl.polyhaven.org/files/model.glb", size: 1234, name: undefined });
  });
});
