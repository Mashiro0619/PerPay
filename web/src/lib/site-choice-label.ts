/** Names are the everyday identity; reveal a short suffix only to disambiguate loaded names. */
export function siteChoiceLabel(
  site: { client_id: string; configuration: { name: string } },
  sites: readonly { client_id: string; configuration: { name: string } }[],
): string {
  const duplicates = sites.filter(
    (item) => item.configuration.name === site.configuration.name,
  );
  if (duplicates.length < 2) return site.configuration.name;
  const compact = (id: string, length: number) =>
    id.replace(/^site_/, "").slice(0, length);
  let length = 8;
  while (
    length < site.client_id.length &&
    duplicates.some(
      (item) =>
        item.client_id !== site.client_id &&
        compact(item.client_id, length) === compact(site.client_id, length),
    )
  )
    length += 4;
  return site.configuration.name + " · " + compact(site.client_id, length);
}
