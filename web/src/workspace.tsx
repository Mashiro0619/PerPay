import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Navigate, Outlet, useLocation, useNavigation } from "react-router";
import { queryOptions, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, result, type Site } from "@/api/client";
import { workspaceApi } from "@/api/workspace";
import {
  legacyWorkspaceUrl,
  workspaceScope,
  type WorkspaceScope,
} from "@/lib/workspace-scope";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { navigationSelection } from "@/lib/navigation-selection";
import { WorkspaceSwitchingContext } from "@/lib/workspace-navigation-state";
import { readOverlayTarget } from "@/lib/overlay-navigation";

type Workspace = WorkspaceScope & { site?: UseQueryResult<{ data: Site }> };
const WorkspaceContext = createContext<Workspace>({ clientId: null, base: "" });
const NavigationWorkspaceContext = createContext<Workspace>({ clientId: null, base: "" });
export const useWorkspace = () => useContext(WorkspaceContext);
// Navigation can remember a site on shared pages without changing their API scope.
export const useNavigationWorkspace = () => useContext(NavigationWorkspaceContext);
export function adminRoutePathname(pathname: string) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return base && (pathname === base || pathname.startsWith(base + "/"))
    ? pathname.slice(base.length) || "/"
    : pathname;
}
export function useWorkspaceNavigation() {
  const { clientId } = useWorkspace();
  const location = useLocation();
  const navigation = useNavigation();
  const nextLocation = navigation.location && {
    ...navigation.location,
    pathname: adminRoutePathname(navigation.location.pathname),
  };
  const next = nextLocation ? workspaceScope(nextLocation.pathname) : null;
  const resource = workspaceScope(readOverlayTarget(location.search)?.pathname ?? location.pathname);
  const nextResource = nextLocation ? workspaceScope(readOverlayTarget(nextLocation.search)?.pathname ?? nextLocation.pathname) : null;
  return {
    switching: navigation.state === "loading" && next !== null && (next.clientId !== clientId || nextResource?.clientId !== resource.clientId),
    clientId: next?.clientId ?? nextResource?.clientId ?? null,
    selectedClientId: nextLocation ? navigationSelection(nextLocation).clientId : null,
  };
}
export function WorkspaceNavigationProvider({ children }: { children: ReactNode }) {
  const { switching } = useWorkspaceNavigation();
  return <WorkspaceSwitchingContext value={switching}>{children}</WorkspaceSwitchingContext>;
}
export function useWorkspaceApi() {
  const { clientId } = useWorkspace();
  return useMemo(() => workspaceApi(clientId), [clientId]);
}
export function workspaceSiteQuery(clientId: string | null) {
  return queryOptions({
    queryKey: ["workspace-site", clientId],
    queryFn: async ({ signal }) => {
      const response = await result(
        api.getSite({ path: { clientId: clientId! }, signal }),
      );
      if (
        response.data.client_id !== clientId ||
        response.data.deleted_at
      )
        throw new Error("网站身份不匹配，请重新加载。");
      return response;
    },
    enabled: !!clientId,
    staleTime: 0,
  });
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const scope = useMemo(
    () => workspaceScope(location.pathname),
    [location.pathname],
  );
  const selection = useMemo(
    () => navigationSelection(location),
    [location.pathname, location.search],
  );
  const site = useQuery(workspaceSiteQuery(scope.clientId));
  const selectedSite = useQuery({
    ...workspaceSiteQuery(selection.clientId),
    enabled: !!selection.clientId && selection.clientId !== scope.clientId,
  });
  const redirect = legacyWorkspaceUrl(location.pathname, location.search);
  if (redirect) return <Navigate to={redirect} replace />;
  return (
    <WorkspaceContext value={{ ...scope, site }}>
      <NavigationWorkspaceContext value={{
        ...selection,
        site: selection.clientId === scope.clientId ? site : selectedSite,
      }}>
        {children}
      </NavigationWorkspaceContext>
    </WorkspaceContext>
  );
}
export function WorkspaceOutlet() {
  const { clientId, site } = useWorkspace();
  if (!clientId) return <Outlet />;
  if (!site!.data) return <QueryView query={site!}>{() => null}</QueryView>;
  // A failed metadata refresh hides actions but keeps an already loaded draft/command alive.
  return (
    <div key={clientId} className="flex min-w-0 flex-col gap-4">
      <ErrorNotice scope="page" error={site!.error} retry={() => void site!.refetch()} />
      <div hidden={site!.isError} inert={site!.isError}>
        <Outlet />
      </div>
    </div>
  );
}

/** Detail resources keep their own API scope without changing the background workspace. */
export function ResourceWorkspaceProvider({ scope, children }: { scope: WorkspaceScope; children: ReactNode }) {
  const site = useQuery(workspaceSiteQuery(scope.clientId));
  const value = useMemo(() => ({ ...scope, site }), [scope.clientId, scope.base, site]);
  return <WorkspaceContext value={value}><NavigationWorkspaceContext value={value}>
    {scope.clientId && !site.data ? <QueryView query={site}>{() => null}</QueryView> : <>
      {scope.clientId && <ErrorNotice scope="page" error={site.error} retainedData retry={() => void site.refetch()} />}
      <div hidden={!!scope.clientId && site.isError} inert={!!scope.clientId && site.isError}>{children}</div>
    </>}
  </NavigationWorkspaceContext></WorkspaceContext>;
}
