import {
  useQuery as query,
  useInfiniteQuery as infiniteQuery,
} from "@tanstack/react-query";
import { useWorkspace } from "@/workspace";
// Keep the domain prefix for invalidation; never share a resource cache across workspaces.
export const useQuery: typeof query = ((
  options: Parameters<typeof query>[0],
  client?: Parameters<typeof query>[1],
) => {
  const { clientId } = useWorkspace();
  return query(
    {
      ...options,
      queryKey: clientId
        ? [...options.queryKey, { workspace: clientId }]
        : options.queryKey,
    },
    client,
  );
}) as typeof query;
export const useInfiniteQuery: typeof infiniteQuery = ((
  options: Parameters<typeof infiniteQuery>[0],
  client?: Parameters<typeof infiniteQuery>[1],
) => {
  const { clientId } = useWorkspace();
  return infiniteQuery(
    {
      ...options,
      queryKey: clientId
        ? [...options.queryKey, { workspace: clientId }]
        : options.queryKey,
    },
    client,
  );
}) as typeof infiniteQuery;
