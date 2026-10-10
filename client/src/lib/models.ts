export type ModelSource = "Wikimedia Commons" | "NASA 3D Resources" | "Poly Haven" | "3DAssets.dev";

export type CommonsModel = {
  id: string;
  title: string;
  format: "STL" | "GLB" | "GLTF";
  size: number;
  modelUrl: string;
  previewUrl: string | null;
  sourceUrl: string;
  license: string;
  licenseUrl: string | null;
  author: string;
  source: ModelSource;
};

export type OpenModel = CommonsModel;
export const MAX_MODEL_BYTES = 25 * 1024 * 1024;

const MODEL_HOSTS: Record<ModelSource, Set<string>> = {
  "Wikimedia Commons": new Set(["upload.wikimedia.org"]),
  "NASA 3D Resources": new Set(["raw.githubusercontent.com"]),
  "Poly Haven": new Set(["dl.polyhaven.org"]),
  "3DAssets.dev": new Set(["cdn.3dassets.dev"]),
};
const SOURCE_HOSTS: Record<ModelSource, Set<string>> = {
  "Wikimedia Commons": new Set(["commons.wikimedia.org"]),
  "NASA 3D Resources": new Set(["github.com"]),
  "Poly Haven": new Set(["polyhaven.com"]),
  "3DAssets.dev": new Set(["3dassets.dev"]),
};
const PREVIEW_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org", "cdn.polyhaven.com", "cdn.3dassets.dev"]);
const VALID_SOURCES = new Set<ModelSource>(Object.keys(MODEL_HOSTS) as ModelSource[]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeHttps(value: unknown, hosts?: Set<string>): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!hosts || hosts.has(url.hostname));
  } catch {
    return false;
  }
}

function decodedPathname(url: URL): string {
  try { return decodeURIComponent(url.pathname); } catch { return url.pathname; }
}

function validSourcePath(source: ModelSource, sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl);
    // Wikimedia file pages carry an encoded colon ("/wiki/File%3A…"), so decode before matching.
    if (source === "Wikimedia Commons") return decodedPathname(url).toLowerCase().startsWith("/wiki/file:");
    if (source === "NASA 3D Resources") return url.hostname === "github.com" && url.pathname.startsWith("/nasa/NASA-3D-Resources/");
    if (source === "Poly Haven") return url.hostname === "polyhaven.com" && url.pathname.startsWith("/a/");
    return url.hostname === "3dassets.dev" && url.pathname.startsWith("/assets/");
  } catch {
    return false;
  }
}

export function isCommonsModel(value: unknown): value is CommonsModel {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 256) return false;
  if (typeof value.title !== "string" || value.title.trim().length < 1 || value.title.length > 500) return false;
  if (value.format !== "STL" && value.format !== "GLB" && value.format !== "GLTF") return false;
  if (typeof value.source !== "string" || !VALID_SOURCES.has(value.source as ModelSource)) return false;
  const source = value.source as ModelSource;
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_MODEL_BYTES) return false;
  if (typeof value.license !== "string" || value.license.trim().length < 1 || value.license.length > 200) return false;
  if (typeof value.author !== "string" || value.author.trim().length < 1 || value.author.length > 500) return false;
  if (!safeHttps(value.modelUrl, MODEL_HOSTS[source]) || !safeHttps(value.sourceUrl, SOURCE_HOSTS[source])) return false;
  if (!validSourcePath(source, value.sourceUrl)) return false;
  const extension = value.modelUrl.toLocaleLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/)?.[1];
  if (extension !== value.format.toLocaleLowerCase()) return false;
  if (value.previewUrl !== null && !safeHttps(value.previewUrl, PREVIEW_HOSTS)) return false;
  if (value.licenseUrl !== null && !safeHttps(value.licenseUrl)) return false;
  return true;
}

function allowedResourceHost(source: ModelSource): Set<string> {
  return MODEL_HOSTS[source];
}

export function safeCommonsAssetUrl(resource: string, modelUrl: string, localOrigin: string): string | null {
  if (resource.slice(0, 5).toLocaleLowerCase() === "data:") return resource;
  try {
    const base = new URL(modelUrl);
    const resolved = new URL(resource, base);
    if (resolved.protocol === "blob:" && resolved.origin === new URL(localOrigin).origin) return resolved.href;
    const source = (Object.keys(MODEL_HOSTS) as ModelSource[]).find((candidate) => MODEL_HOSTS[candidate].has(base.hostname));
    if (!source) return null;
    if (resolved.protocol !== "https:" || resolved.username || resolved.password || !allowedResourceHost(source).has(resolved.hostname)) return null;
    if (source === "Wikimedia Commons" && !resolved.pathname.startsWith("/wikipedia/commons/")) return null;
    if (source === "NASA 3D Resources" && !resolved.pathname.startsWith("/nasa/NASA-3D-Resources/")) return null;
    // Poly Haven serves whole, self-contained assets from "/file/…"; only their "/files/" bucket may host sub-resources.
    if (source === "Poly Haven" && !resolved.pathname.startsWith("/files/")) return null;
    if (source === "3DAssets.dev" && !resolved.pathname.startsWith("/assets/")) return null;
    return resolved.href;
  } catch {
    return null;
  }
}

export function sanitizeCommonsModels(value: unknown): CommonsModel[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, CommonsModel>();
  for (const candidate of value) {
    if (isCommonsModel(candidate) && !unique.has(candidate.id)) unique.set(candidate.id, candidate);
    if (unique.size >= 40) break;
  }
  return [...unique.values()];
}
