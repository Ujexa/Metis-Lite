// Caches source-map results so a failed/regenerated run never re-pays for pages already mapped.
// Keys are hashes of the source text (+ model + map version). Values are plain JSON.

export interface MapCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // Non-cryptographic fallback (FNV-1a, two lanes) for environments without WebCrypto.
    let a = 0x811c9dc5, b = 0x01000193;
    for (let i = 0; i < input.length; i += 1) { a = Math.imul(a ^ input.charCodeAt(i), 0x01000193) >>> 0; b = Math.imul(b + input.charCodeAt(i), 0x85ebca6b) >>> 0; }
    return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}${input.length.toString(16)}`;
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createMemoryCache(): MapCache {
  const store = new Map<string, unknown>();
  return { async get(key) { return store.get(key); }, async set(key, value) { store.set(key, value); } };
}

const DB_NAME = "metis-map-cache";
const STORE = "maps";
const MAX_ENTRIES = 40;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** IndexedDB-backed cache; silently degrades to memory if the browser blocks storage. */
export function createPersistentMapCache(): MapCache {
  const fallback = createMemoryCache();
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  const db = () => (dbPromise ??= typeof indexedDB === "undefined" ? Promise.resolve(null) : openDb().catch(() => null));
  return {
    async get(key) {
      const handle = await db();
      if (!handle) return fallback.get(key);
      try { return ((await tx(handle, "readonly", (s) => s.get(key))) as { value?: unknown } | undefined)?.value; } catch { return fallback.get(key); }
    },
    async set(key, value) {
      const handle = await db();
      if (!handle) return fallback.set(key, value);
      try {
        await tx(handle, "readwrite", (s) => s.put({ value, savedAt: Date.now() }, key));
        // Keep the store bounded: evict oldest entries beyond MAX_ENTRIES.
        const keys = (await tx(handle, "readonly", (s) => s.getAllKeys())) as IDBValidKey[];
        if (keys.length > MAX_ENTRIES) {
          const rows = await Promise.all(keys.map(async (k) => ({ k, at: ((await tx(handle, "readonly", (s) => s.get(k))) as { savedAt?: number } | undefined)?.savedAt ?? 0 })));
          rows.sort((x, y) => x.at - y.at);
          for (const row of rows.slice(0, keys.length - MAX_ENTRIES)) await tx(handle, "readwrite", (s) => s.delete(row.k));
        }
      } catch { await fallback.set(key, value); }
    },
  };
}
