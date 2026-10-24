import { queryOptions } from "@tanstack/react-query";
import { api, queryClient, result, type Site, type SiteConfiguration } from "@/api/client";

export type SiteEditorSnapshot = { site: Site; configuration: SiteConfiguration };
export const siteEditorKey = (clientId: string) => ["site-editor", clientId] as const;

export function latestEditorSnapshot(site: Site): SiteEditorSnapshot {
  const cached = queryClient.getQueryData<SiteEditorSnapshot>(siteEditorKey(site.client_id));
  return cached && cached.site.revision > site.revision
    ? cached
    : { site, configuration: site.configuration };
}

export function siteEditorQueryOptions(clientId: string | undefined) {
  return queryOptions({
    queryKey: siteEditorKey(clientId ?? "new"),
    staleTime: Infinity,
    gcTime: clientId ? 5 * 60_000 : 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }): Promise<SiteEditorSnapshot> => {
      if (!clientId) throw new Error("缺少业务网站身份");
      const response = await result(api.getSite({ path: { clientId }, signal }));
      if (response.data.client_id !== clientId || response.data.deleted_at) {
        throw new Error("网站身份不匹配，请重新加载。");
      }
      return latestEditorSnapshot(response.data);
    },
  });
}
