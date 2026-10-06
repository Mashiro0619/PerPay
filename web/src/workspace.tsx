import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, result, type Site } from "@/api/client";
import { workspaceApi } from "@/api/workspace";
import {
  legacyWorkspaceUrl,
  workspaceScope,
  type WorkspaceScope,
} from "@/lib/workspace-scope";
import { ErrorNotice, QueryView } from "@/components/request-state";
const WorkspaceContext = createContext<
  WorkspaceScope & { site?: UseQueryResult<{ data: Site }> }
>({ clientId: null, base: "" });
export const useWorkspace = () => useContext(WorkspaceContext);
export function useWorkspaceApi() {
  const { clientId } = useWorkspace();
  return useMemo(() => workspaceApi(clientId), [clientId]);
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const location = useLocation(),
    scope = useMemo(
      () => workspaceScope(location.pathname),
      [location.pathname],
    );
  const site = useQuery({
    queryKey: ["workspace-site", scope.clientId],
    queryFn: async ({ signal }) => {
      const response = await result(
        api.getSite({ path: { clientId: scope.clientId! }, signal }),
      );
      if (
        response.data.client_id !== scope.clientId ||
        response.data.deleted_at
      )
        throw new Error("网站身份与当前后台不一致，请重新加载。");
      return response;
    },
    enabled: !!scope.clientId,
    staleTime: 0,
  });
  const redirect = legacyWorkspaceUrl(location.pathname, location.search);
  if (redirect) return <Navigate to={redirect} replace />;
  return (
    <WorkspaceContext value={{ ...scope, site }}>{children}</WorkspaceContext>
  );
}
export function WorkspaceOutlet() {
  const { clientId, site } = useWorkspace();
  if (!clientId) return <Outlet />;
  if (!site!.data) return <QueryView query={site!}>{() => null}</QueryView>;
  // A failed metadata refresh hides actions but keeps an already loaded draft/command alive.
  return (
    <div key={clientId} className="flex min-w-0 flex-col gap-4">
      <ErrorNotice error={site!.error} retry={() => void site!.refetch()} />
      <div hidden={site!.isError} inert={site!.isError}>
        <Outlet />
      </div>
    </div>
  );
}
