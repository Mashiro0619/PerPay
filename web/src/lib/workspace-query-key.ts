import type { QueryKey } from "@tanstack/react-query";

/** Preserve the resource prefix for invalidation and isolate every workspace. */
export function workspaceQueryKey(queryKey: QueryKey, clientId: string | null): QueryKey {
  return clientId ? [...queryKey, { workspace: clientId }] : queryKey;
}
