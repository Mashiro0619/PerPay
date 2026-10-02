/** Exact decimal conversion: rejects values that cannot be represented in base integer units. */
export function integerUnits(text: string, multiplier: number): number | null {
  if (
    !/^\d+(?:\.\d+)?$/.test(text) ||
    text.length > 32 ||
    !Number.isSafeInteger(multiplier) ||
    multiplier < 1
  )
    return null;
  const [whole = "", fraction = ""] = text.split(".");
  const divisor = 10n ** BigInt(fraction.length);
  const value = BigInt(whole + fraction) * BigInt(multiplier);
  if (value % divisor) return null;
  const result = Number(value / divisor);
  return Number.isSafeInteger(result) ? result : null;
}
