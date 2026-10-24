/** Width and input capabilities are independent on real touch tablets. */
export function matchesTestMedia(media: string, width: number, coarse = width < 1024) {
  const bounds = [...media.matchAll(/\((min|max)-width:\s*([\d.]+)(px|rem)\)/g)];
  if (bounds.some(([, kind, value, unit]) => kind === "min"
    ? width < Number(value) * (unit === "rem" ? 16 : 1)
    : width > Number(value) * (unit === "rem" ? 16 : 1))) return false;
  if (/pointer:\s*coarse|hover:\s*none/.test(media)) return coarse;
  if (/pointer:\s*fine|hover:\s*hover/.test(media)) return !coarse;
  return bounds.length > 0;
}
