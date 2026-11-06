/** Names are the everyday identity; reveal a short suffix only to disambiguate loaded names. */
export function siteChoiceLabel(
  site: { client_id: string; configuration: { name: string } },
  sites: readonly { client_id: string; configuration: { name: string } }[],
): string {
  const duplicates = sites.filter(
    (item) => item.configuration.name === site.configuration.name,
  );
  const ids = [...new Set([site.client_id, ...duplicates.map(item => item.client_id)])];
  if (ids.length < 2) return site.configuration.name;
  const shortenedIds = ids.map(id => id.replace(/^site_/, ""));
  // Fall back for the whole group so prefix removal cannot merge two identities.
  const keepPrefixes = shortenedIds.includes("") || new Set(shortenedIds).size !== ids.length;
  const compact = (id: string, length: number) =>
    (keepPrefixes ? id : id.replace(/^site_/, "")).slice(0, length);
  let length = 8;
  while (
    length < site.client_id.length &&
    ids.some(
      (otherId) =>
        otherId !== site.client_id &&
        compact(otherId, length) === compact(site.client_id, length),
    )
  )
    length += 4;
  return site.configuration.name + " · " + compact(site.client_id, length);
}
