/** Public navigation only. Never resolves or fetches the configured target. */
export function checkoutHelpUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    new TextEncoder().encode(value).length > 2048 ||
    /[\p{Cc}\p{Cs}]/u.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !host.includes(".") ||
      host.length > 253 ||
      host.endsWith(".") ||
      /^[\d.]+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
      !host
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    )
      return null;
    return new TextEncoder().encode(url.href).length <= 2048 ? url.href : null;
  } catch {
    return null;
  }
}
