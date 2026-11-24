type OriginConstructor = {
  from(value: unknown): {
    readonly opaque: boolean;
    isSameOrigin(other: unknown): boolean;
  };
};

function nativeOriginApi(): OriginConstructor | null {
  const candidate = (globalThis as { Origin?: unknown }).Origin;
  if (typeof candidate !== "function" && (typeof candidate !== "object" || candidate === null)) {
    return null;
  }
  const api = candidate as Partial<OriginConstructor>;
  return typeof api.from === "function" ? (api as OriginConstructor) : null;
}

/**
 * Compare candidate URL against the current execution context's origin,
 * rejecting opaque ("null") origins so two unrelated opaque contexts never match.
 */
export function isSameOriginUrl(candidate: string | URL, base?: string): boolean {
  try {
    const resolvedBase =
      base ??
      (typeof window !== "undefined" ? window.location.href : globalThis.location?.href);
    if (!resolvedBase) return false;
    const targetUrl = candidate instanceof URL ? candidate : new URL(candidate, resolvedBase);
    const OriginApi = nativeOriginApi();
    if (OriginApi) {
      const targetOrigin = OriginApi.from(targetUrl);
      const currentOrigin =
        base || typeof self === "undefined"
          ? OriginApi.from(resolvedBase)
          : OriginApi.from(self);
      return !targetOrigin.opaque && !currentOrigin.opaque && targetOrigin.isSameOrigin(currentOrigin);
    }
    const currentUrl = new URL(resolvedBase);
    return (
      targetUrl.origin !== "null" &&
      currentUrl.origin !== "null" &&
      targetUrl.origin === currentUrl.origin
    );
  } catch {
    return false;
  }
}
