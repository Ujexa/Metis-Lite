import { describe, expect, it } from "vitest";
import { isCommonsModel, safeCommonsAssetUrl, sanitizeCommonsModels, type CommonsModel } from "./models";

const FIXTURES: CommonsModel[] = [
  { id: "commons:1", title: "Spur gear.stl", format: "STL", size: 18_240, modelUrl: "https://upload.wikimedia.org/wikipedia/commons/a/1a/spur-gear.stl", previewUrl: null, sourceUrl: "https://commons.wikimedia.org/wiki/File%3ASpur_gear.stl", license: "CC0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", author: "Test creator", source: "Wikimedia Commons" },
  { id: "nasa:1", title: "Test motor.glb", format: "GLB", size: 2_048, modelUrl: "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/Test%20motor.glb", previewUrl: null, sourceUrl: "https://github.com/nasa/NASA-3D-Resources/blob/master/3D%20Models/Test%20motor.glb", license: "NASA 3D Resources", licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/", author: "NASA", source: "NASA 3D Resources" },
  { id: "poly:1", title: "Industrial gear.glb", format: "GLB", size: 3_072, modelUrl: "https://dl.polyhaven.org/file/ph-assets/Models/glb/industrial_gear/industrial_gear.glb", previewUrl: null, sourceUrl: "https://polyhaven.com/a/industrial_gear", license: "CC0 1.0", licenseUrl: "https://polyhaven.com/license", author: "Poly Haven", source: "Poly Haven" },
  { id: "assets:1", title: "Workshop tool.glb", format: "GLB", size: 4_096, modelUrl: "https://cdn.3dassets.dev/assets/workshop-tool/v1/model.glb", previewUrl: null, sourceUrl: "https://3dassets.dev/assets/workshop-tool", license: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", author: "3DAssets.dev", source: "3DAssets.dev" },
];

describe("open model trust boundary", () => {
  it("accepts verified records from every federated source", () => {
    for (const fixture of FIXTURES) expect(isCommonsModel(fixture)).toBe(true);
  });

  it("rejects external hosts, oversize files, and invalid source pages", () => {
    expect(isCommonsModel({ ...FIXTURES[0], modelUrl: "https://attacker.example/gear.stl" })).toBe(false);
    expect(isCommonsModel({ ...FIXTURES[1], modelUrl: "https://cdn.example/motor.glb" })).toBe(false);
    expect(isCommonsModel({ ...FIXTURES[0], size: 25 * 1024 * 1024 + 1 })).toBe(false);
    expect(isCommonsModel({ ...FIXTURES[2], sourceUrl: "https://polyhaven.com/" })).toBe(false);
  });

  it("drops malformed and duplicate saved models", () => {
    expect(sanitizeCommonsModels([FIXTURES[0], { ...FIXTURES[0], modelUrl: "javascript:alert(1)" }, FIXTURES[0]])).toEqual([FIXTURES[0]]);
  });

  it("allows only same-provider relative resources in GLTF/GLB files", () => {
    expect(safeCommonsAssetUrl("gear.bin", FIXTURES[0].modelUrl, "https://metis.example")).toContain("upload.wikimedia.org");
    expect(safeCommonsAssetUrl("part.bin", FIXTURES[1].modelUrl, "https://metis.example")).toContain("raw.githubusercontent.com");
    expect(safeCommonsAssetUrl("textures/basecolor.png", FIXTURES[2].modelUrl, "https://metis.example")).toBeNull();
    expect(safeCommonsAssetUrl("https://attacker.example/texture.png", FIXTURES[3].modelUrl, "https://metis.example")).toBeNull();
    expect(safeCommonsAssetUrl("data:application/octet-stream;base64,AA==", FIXTURES[0].modelUrl, "https://metis.example")).toBe("data:application/octet-stream;base64,AA==");
  });
});
