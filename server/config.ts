/** Parse the number of trusted reverse-proxy hops. Zero means trust no proxy. */
export function parseTrustProxyHops(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      "TRUST_PROXY_HOPS must be a non-negative integer (use 0 to trust no proxy)."
    );
  }

  const hops = Number(normalized);
  if (!Number.isSafeInteger(hops)) {
    throw new Error("TRUST_PROXY_HOPS must be a safe non-negative integer.");
  }
  return hops;
}
