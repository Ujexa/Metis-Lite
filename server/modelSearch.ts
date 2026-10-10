import type { Request, Response } from "express";

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const NASA_API_BASE = "https://api.github.com/repos/nasa/NASA-3D-Resources";
const POLYHAVEN_API = "https://api.polyhaven.com";
const ASSETS3D_API = "https://3dassets.dev/api/v1/assets";
const MAX_MODEL_BYTES = 25 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const NASA_INDEX_TTL_MS = 30 * 60_000;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_CLIENTS = 5_000;
const MAX_RESULTS_PER_SOURCE = 8;
const MAX_RESULTS_TOTAL = 24;

export type ModelSource =
  | "Wikimedia Commons"
  | "NASA 3D Resources"
  | "Poly Haven"
  | "3DAssets.dev";

export type OpenModel = {
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

type SearchCacheEntry = {
  expiresAt: number;
  results: OpenModel[];
  sources: ModelSource[];
  failures: ModelSource[];
};
const cache = new Map<string, SearchCacheEntry>();
const requestsByIp = new Map<string, { windowEndsAt: number; count: number }>();
let nasaIndex: { expiresAt: number; entries: GithubTreeEntry[] } | null = null;

const SOURCE_ORDER: ModelSource[] = [
  "Wikimedia Commons",
  "NASA 3D Resources",
  "Poly Haven",
  "3DAssets.dev",
];

const MODEL_EXTENSIONS = new Set(["stl", "glb", "gltf"]);
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

function plainText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function safeHttpsUrl(value: unknown, hosts?: Set<string>): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (hosts && !hosts.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeQuery(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[<>\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function rateLimit(ip: string): boolean {
  const now = Date.now();

  // Prune before evaluating the request so cache hits and upstream failures cannot
  // skip cleanup. Bound memory if a public deployment receives many distinct IPs.
  if (requestsByIp.size > 2_000) {
    for (const [key, entry] of requestsByIp) {
      if (entry.windowEndsAt <= now) requestsByIp.delete(key);
    }
  }
  if (!requestsByIp.has(ip) && requestsByIp.size >= MAX_RATE_LIMIT_CLIENTS) {
    let evicted = 0;
    const targetEvictions = Math.floor(MAX_RATE_LIMIT_CLIENTS * 0.2);
    for (const key of requestsByIp.keys()) {
      requestsByIp.delete(key);
      evicted += 1;
      if (evicted >= targetEvictions) break;
    }
  }

  const current = requestsByIp.get(ip);
  if (!current || now >= current.windowEndsAt) {
    requestsByIp.set(ip, {
      windowEndsAt: now + RATE_LIMIT_WINDOW_MS,
      count: 1,
    });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT_MAX;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/json",
      "User-Agent": "MetisLite/1.3 (open 3D model atlas)",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok)
    throw new Error(`Upstream returned HTTP ${response.status}.`);
  return response.json();
}

function getFormat(value: string): OpenModel["format"] | null {
  const extension = value
    .toLocaleLowerCase()
    .match(/\.([a-z0-9]+)(?:[?#].*)?$/)?.[1];
  if (extension === "stl") return "STL";
  if (extension === "glb") return "GLB";
  if (extension === "gltf") return "GLTF";
  return null;
}

function formatForPath(path: string): OpenModel["format"] | null {
  return getFormat(path);
}

function buildSourceUrl(source: ModelSource, identifier: string): string {
  if (source === "Wikimedia Commons")
    return `https://commons.wikimedia.org/wiki/${encodeURIComponent(identifier.replaceAll(" ", "_"))}`;
  if (source === "NASA 3D Resources")
    return `https://github.com/nasa/NASA-3D-Resources/tree/master/${identifier.split("/").slice(0, -1).map(encodeURIComponent).join("/")}`;
  if (source === "Poly Haven")
    return `https://polyhaven.com/a/${encodeURIComponent(identifier)}`;
  return `https://3dassets.dev/assets/${encodeURIComponent(identifier)}`;
}

function validModel(model: OpenModel): boolean {
  if (!model.id || !model.title || !model.source) return false;
  if (
    !Number.isSafeInteger(model.size) ||
    model.size <= 0 ||
    model.size > MAX_MODEL_BYTES
  )
    return false;
  const modelUrl = safeHttpsUrl(model.modelUrl, MODEL_HOSTS[model.source]);
  const sourceUrl = safeHttpsUrl(model.sourceUrl, SOURCE_HOSTS[model.source]);
  if (!modelUrl || !sourceUrl) return false;
  const format = getFormat(modelUrl);
  if (!format || format !== model.format) return false;
  if (!model.license || !model.author) return false;
  return true;
}

// ── Wikimedia Commons ────────────────────────────────────────────────────────

type CommonsMetadata = { value?: string };
type CommonsImageInfo = {
  url?: string;
  thumburl?: string;
  mime?: string;
  size?: number;
  extmetadata?: Record<string, CommonsMetadata>;
};
type CommonsPage = {
  pageid: number;
  title: string;
  imageinfo?: CommonsImageInfo[];
};

function firstMetadata(
  info: Record<string, CommonsMetadata> | undefined,
  keys: string[]
): string {
  for (const key of keys) {
    const value = plainText(info?.[key]?.value);
    if (value) return value;
  }
  return "";
}

function acceptsMime(format: OpenModel["format"], mime: string): boolean {
  const normalized = mime.toLocaleLowerCase().split(";")[0].trim();
  if (
    ["", "application/octet-stream", "binary/octet-stream"].includes(normalized)
  )
    return true;
  if (format === "STL")
    return ["application/sla", "model/stl"].includes(normalized);
  if (format === "GLB")
    return [
      "model/gltf-binary",
      "application/gltf",
      "application/gltf+binary",
      "model/gltf",
    ].includes(normalized);
  return ["model/gltf+json", "application/json", "model/gltf"].includes(
    normalized
  );
}

async function searchCommons(query: string): Promise<OpenModel[]> {
  const terms = [
    ...new Set([`${query} filetype:3D`, query, `${query} 3D model`]),
  ];
  const responses = await Promise.all(
    terms.map(async term => {
      const endpoint = new URL(COMMONS_API);
      endpoint.searchParams.set("action", "query");
      endpoint.searchParams.set("generator", "search");
      endpoint.searchParams.set("gsrsearch", term);
      endpoint.searchParams.set("gsrnamespace", "6");
      endpoint.searchParams.set("gsrlimit", "40");
      endpoint.searchParams.set("gsrsort", "relevance");
      endpoint.searchParams.set("prop", "imageinfo");
      endpoint.searchParams.set("iiprop", "url|size|mime|extmetadata");
      endpoint.searchParams.set("iiurlwidth", "640");
      endpoint.searchParams.set(
        "iiextmetadatafilter",
        "Artist|Creator|Credit|LicenseShortName|UsageTerms|License|LicenseUrl"
      );
      endpoint.searchParams.set("format", "json");
      const data = await fetchJson(endpoint.toString());
      return Object.values(
        (data as { query?: { pages?: Record<string, CommonsPage> } }).query
          ?.pages ?? {}
      );
    })
  );

  const unique = new Map<string, OpenModel>();
  for (const page of responses.flat()) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const format = getFormat(page.title);
    const size = Number(info.size ?? 0);
    const modelUrl = safeHttpsUrl(info.url, MODEL_HOSTS["Wikimedia Commons"]);
    const license = firstMetadata(info.extmetadata, [
      "LicenseShortName",
      "UsageTerms",
      "License",
    ]);
    const author = firstMetadata(info.extmetadata, [
      "Artist",
      "Creator",
      "Credit",
    ]);
    if (
      !format ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MAX_MODEL_BYTES ||
      !modelUrl ||
      !acceptsMime(format, String(info.mime ?? "")) ||
      !license ||
      !author
    )
      continue;
    const previewUrl = safeHttpsUrl(
      info.thumburl,
      new Set(["upload.wikimedia.org", "thumb.wikimedia.org"])
    );
    const rawLicenseUrl = firstMetadata(info.extmetadata, ["LicenseUrl"]);
    const licenseUrl = safeHttpsUrl(rawLicenseUrl) ?? null;
    const model: OpenModel = {
      id: `commons:${page.pageid}:${page.title}`,
      title: page.title.replace(/^File:/, ""),
      format,
      size,
      modelUrl,
      previewUrl,
      sourceUrl: buildSourceUrl("Wikimedia Commons", page.title),
      license,
      licenseUrl,
      author,
      source: "Wikimedia Commons",
    };
    if (validModel(model)) unique.set(model.id, model);
    if (unique.size >= MAX_RESULTS_PER_SOURCE) break;
  }
  return [...unique.values()];
}

// ── NASA 3D Resources ───────────────────────────────────────────────────────

type GithubTreeEntry = {
  path: string;
  type: string;
  size?: number;
  url?: string;
};

async function loadNasaIndex(): Promise<GithubTreeEntry[]> {
  if (nasaIndex && nasaIndex.expiresAt > Date.now()) return nasaIndex.entries;
  for (const branch of ["master", "main"]) {
    try {
      const data = await fetchJson(
        `${NASA_API_BASE}/git/trees/${branch}?recursive=1`
      );
      const entries = (
        (data as { tree?: GithubTreeEntry[] }).tree ?? []
      ).filter(
        entry =>
          entry.type === "blob" &&
          /(?:^|\/)3D (?:Models|Printing)(?:\/|$)/i.test(entry.path) &&
          Boolean(getFormat(entry.path))
      );
      nasaIndex = { expiresAt: Date.now() + NASA_INDEX_TTL_MS, entries };
      return entries;
    } catch {
      // Try the other common branch name.
    }
  }
  throw new Error("NASA 3D Resources index is unavailable.");
}

function scoreTextMatch(title: string, query: string): number {
  const haystack = title.toLocaleLowerCase();
  const terms = query.toLocaleLowerCase().split(/\W+/).filter(Boolean);
  let score = haystack.includes(query.toLocaleLowerCase()) ? 100 : 0;
  for (const term of terms) if (haystack.includes(term)) score += 20;
  return score;
}

async function searchNASA(query: string): Promise<OpenModel[]> {
  const entries = await loadNasaIndex();
  return entries
    .map(entry => ({ entry, score: scoreTextMatch(entry.path, query) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path)
    )
    .slice(0, MAX_RESULTS_PER_SOURCE)
    .map(({ entry }) => {
      const format = formatForPath(entry.path);
      const size = Number(entry.size ?? 0);
      if (
        !format ||
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        size > MAX_MODEL_BYTES
      )
        return null;
      const path = entry.path.split("/").map(encodeURIComponent).join("/");
      const modelUrl = `https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/${path}`;
      const model: OpenModel = {
        id: `nasa:${entry.path}`,
        title: entry.path.split("/").pop() ?? entry.path,
        format,
        size,
        modelUrl,
        previewUrl: null,
        sourceUrl: `https://github.com/nasa/NASA-3D-Resources/blob/master/${path}`,
        license: "NASA 3D Resources",
        licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
        author: "NASA",
        source: "NASA 3D Resources",
      };
      return validModel(model) ? model : null;
    })
    .filter((model): model is OpenModel => Boolean(model));
}

// ── Poly Haven ───────────────────────────────────────────────────────────────

function findNodes(
  value: unknown
): Array<{ url?: string; size?: number; name?: string }> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(findNodes);
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : undefined;
  const name =
    typeof record.name === "string"
      ? record.name
      : typeof record.filename === "string"
        ? record.filename
        : undefined;
  const sizeRaw = record.size ?? record.bytes;
  const size = typeof sizeRaw === "number" ? sizeRaw : Number(sizeRaw ?? 0);
  const current: Array<{ url?: string; size?: number; name?: string }> =
    url || name ? [{ url, size, name }] : [];
  return current.concat(...Object.values(record).flatMap(findNodes));
}

async function searchPolyHaven(query: string): Promise<OpenModel[]> {
  const endpoint = new URL(`${POLYHAVEN_API}/search`);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("t", "models");
  endpoint.searchParams.set("min", "0");
  endpoint.searchParams.set("limit", String(MAX_RESULTS_PER_SOURCE));
  const searchData = (await fetchJson(endpoint.toString())) as
    | Array<{ id?: string; score?: number } | string>
    | { results?: Array<{ id?: string; score?: number }> };
  const ranked = Array.isArray(searchData)
    ? searchData
    : (searchData.results ?? []);
  const ids = ranked
    .map(item => (typeof item === "string" ? item : item.id))
    .filter((id): id is string => Boolean(id))
    .slice(0, MAX_RESULTS_PER_SOURCE);

  const output = await Promise.all(
    ids.map(async (id): Promise<OpenModel | null> => {
      try {
        const [info, files] = await Promise.all([
          fetchJson(
            `${POLYHAVEN_API}/info/${encodeURIComponent(id)}`
          ) as Promise<Record<string, unknown>>,
          fetchJson(`${POLYHAVEN_API}/files/${encodeURIComponent(id)}`),
        ]);
        const candidates = findNodes(files)
          .map(file => ({
            ...file,
            format: getFormat(file.name ?? file.url ?? ""),
          }))
          .filter(
            (
              file
            ): file is {
              url?: string;
              size: number;
              name?: string;
              format: OpenModel["format"];
            } =>
              Boolean(
                file.url &&
                  file.format &&
                  MODEL_EXTENSIONS.has(file.format.toLocaleLowerCase())
              )
          )
          .map(file => ({
            file,
            url: safeHttpsUrl(file.url, MODEL_HOSTS["Poly Haven"]),
          }))
          .filter(
            (
              item
            ): item is {
              file: {
                url: string;
                size: number;
                name?: string;
                format: OpenModel["format"];
              };
              url: string;
            } =>
              Boolean(item.url) &&
              Number.isSafeInteger(item.file.size) &&
              item.file.size > 0 &&
              item.file.size <= MAX_MODEL_BYTES
          )
          .sort((a, b) => {
            const formatRank = (format: OpenModel["format"]) =>
              format === "GLB" ? 0 : format === "STL" ? 1 : 2;
            return (
              formatRank(a.file.format) - formatRank(b.file.format) ||
              a.file.size - b.file.size
            );
          });
        const picked = candidates[0];
        if (!picked) return null;
        const authors =
          typeof info.authors === "object" && info.authors !== null
            ? Object.values(info.authors as Record<string, unknown>)
                .map(plainText)
                .filter(Boolean)
                .join(", ")
            : "";
        const title = plainText(info.name) || id;
        if (!authors) return null;
        const model: OpenModel = {
          id: `polyhaven:${id}`,
          title: `${title}${picked.file.format === "STL" || picked.file.name?.toLocaleLowerCase().endsWith(`.${picked.file.format.toLocaleLowerCase()}`) ? "" : ".glb"}`,
          format: picked.file.format,
          size: picked.file.size,
          modelUrl: picked.url,
          previewUrl: null,
          sourceUrl: buildSourceUrl("Poly Haven", id),
          license: "CC0 1.0",
          licenseUrl: "https://polyhaven.com/license",
          author: authors,
          source: "Poly Haven",
        };
        return validModel(model) ? model : null;
      } catch {
        // One malformed asset must not discard the provider's other results.
        return null;
      }
    })
  );
  return output
    .filter((model): model is OpenModel => Boolean(model))
    .slice(0, MAX_RESULTS_PER_SOURCE);
}

// ── 3DAssets.dev ─────────────────────────────────────────────────────────────

function parse3DAssetsRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value))
    return value.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item))
    );
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return (value as { data: unknown[] }).data.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item))
    );
  }
  return [];
}

async function search3DAssets(query: string): Promise<OpenModel[]> {
  const endpoint = new URL(ASSETS3D_API);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("sort", "relevance");
  endpoint.searchParams.set("limit", String(MAX_RESULTS_PER_SOURCE));
  const records = parse3DAssetsRecords(await fetchJson(endpoint.toString()));
  return records.flatMap(record => {
    const modelUrl = safeHttpsUrl(record.cdnUrl, MODEL_HOSTS["3DAssets.dev"]);
    const title = plainText(record.title ?? record.name);
    const slug = plainText(record.slug ?? record.id);
    const rawLicense = record.license;
    const license =
      typeof rawLicense === "string"
        ? rawLicense
        : plainText(
            (rawLicense as Record<string, unknown> | undefined)?.name ??
              "CC0 1.0"
          );
    const contributor = record.contributor;
    const author =
      typeof contributor === "string"
        ? plainText(contributor)
        : plainText(
            (contributor as Record<string, unknown> | undefined)?.name ??
              (contributor as Record<string, unknown> | undefined)?.username
          );
    const sizeData = record.stats;
    const size = Number(
      typeof sizeData === "object" && sizeData !== null
        ? (sizeData as Record<string, unknown>).fileSize
        : 0
    );
    if (
      !modelUrl ||
      !title ||
      !slug ||
      !author ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MAX_MODEL_BYTES
    )
      return [];
    const format = getFormat(modelUrl);
    if (format !== "GLB") return [];
    const model: OpenModel = {
      id: `3dassets:${slug}`,
      title,
      format,
      size,
      modelUrl,
      previewUrl:
        safeHttpsUrl(
          record.thumbnailUrl ?? record.posterUrl,
          new Set(["cdn.3dassets.dev"])
        ) ?? null,
      sourceUrl: buildSourceUrl("3DAssets.dev", slug),
      license: license || "CC0 1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      author,
      source: "3DAssets.dev",
    };
    return validModel(model) ? [model] : [];
  });
}

const PROVIDERS: Array<[ModelSource, (query: string) => Promise<OpenModel[]>]> =
  [
    ["Wikimedia Commons", searchCommons],
    ["NASA 3D Resources", searchNASA],
    ["Poly Haven", searchPolyHaven],
    ["3DAssets.dev", search3DAssets],
  ];

function dedupeAndRank(results: OpenModel[], query: string): OpenModel[] {
  const q = query.toLocaleLowerCase();
  const terms = q.split(/\W+/).filter(Boolean);
  const unique = new Map<string, OpenModel>();
  for (const result of results) {
    if (!validModel(result)) continue;
    const key = `${result.source}:${result.modelUrl}`;
    if (!unique.has(key)) unique.set(key, result);
  }
  return [...unique.values()]
    .sort((a, b) => {
      const score = (model: OpenModel) => {
        const title = model.title.toLocaleLowerCase();
        let value = title === q ? 200 : title.includes(q) ? 120 : 0;
        value += terms.reduce(
          (sum, term) => sum + (title.includes(term) ? 12 : 0),
          0
        );
        value += model.format === "GLB" ? 4 : 0;
        const sourceBoost =
          model.source === "Wikimedia Commons"
            ? 8
            : model.source === "NASA 3D Resources"
              ? 6
              : 4;
        return value + sourceBoost;
      };
      return score(b) - score(a) || a.title.localeCompare(b.title);
    })
    .slice(0, MAX_RESULTS_TOTAL);
}

export async function searchOpenModels(
  req: Request,
  res: Response
): Promise<void> {
  const query = normalizeQuery(
    typeof req.query.q === "string" ? req.query.q : ""
  );
  if (query.length < 2) {
    res.status(400).json({
      error: "Enter at least two characters to search the open 3D libraries.",
    });
    return;
  }

  const ip = req.ip || "unknown";
  if (!rateLimit(ip)) {
    res
      .set("Retry-After", "60")
      .status(429)
      .json({ error: "Search limit reached. Please try again shortly." });
    return;
  }

  const cacheKey = query.toLocaleLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.set("Cache-Control", "public, max-age=60").json({
      results: cached.results,
      sources: cached.sources,
      failures: cached.failures,
    });
    return;
  }

  const settled = await Promise.allSettled(
    PROVIDERS.map(([, search]) => search(query))
  );
  const results: OpenModel[] = [];
  const failures: ModelSource[] = [];
  settled.forEach((item, index) => {
    const [source] = PROVIDERS[index];
    if (item.status === "fulfilled") results.push(...item.value);
    else failures.push(source);
  });

  const finalResults = dedupeAndRank(results, query);
  const sources = SOURCE_ORDER.filter(source => !failures.includes(source));
  if (failures.length === PROVIDERS.length) {
    res.status(502).json({
      error:
        "None of the open 3D libraries responded. Check your connection and try again.",
      failures,
    });
    return;
  }
  cache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    results: finalResults,
    sources,
    failures,
  });

  if (cache.size > 120) {
    for (const [key, entry] of cache)
      if (entry.expiresAt <= Date.now()) cache.delete(key);
    while (cache.size > 120) cache.delete(cache.keys().next().value as string);
  }
  res
    .set("Cache-Control", "public, max-age=60")
    .json({ results: finalResults, sources, failures });
}

export {
  findNodes,
  formatForPath,
  normalizeQuery,
  parse3DAssetsRecords,
  search3DAssets,
  searchNASA,
  searchPolyHaven,
};
