import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  getRestoreSessionHold,
  invalidateSessionRequests,
  queryClient,
  result,
  sessionKey,
  subscribeRestoreSessionHold,
  type AdminSessionEnvelope,
} from "@/api/client";
import { AuthShell } from "@/components/auth-shell";
import { ErrorNotice, Loading } from "@/components/request-state";
import { LoginForm } from "@/components/login-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { clearOnboardingDeferrals } from "@/lib/onboarding";
import { OVERLAY_HISTORY_KEY, OVERLAY_PARAMETER, legacyOverlayLocation, overlayBackground, stateRecord } from "@/lib/overlay-navigation";
const SessionContext = createContext<{
  username: string;
  forget: () => void;
  error: Error | null;
  retry: () => void;
}>({
  username: "admin",
  forget: () => undefined,
  error: null,
  retry: () => undefined,
});
export const useSession = () => useContext(SessionContext);

export function AuthBoundary({ children }: { children: ReactNode }) {
  const authenticated = useRef(false);
  const restoreSessionHold = useSyncExternalStore(subscribeRestoreSessionHold, getRestoreSessionHold);
  const [resetOverlay, setResetOverlay] = useState(false);
  const finishReset = useCallback(() => setResetOverlay(false), []);
  const session = useQuery<AdminSessionEnvelope | null>({
    queryKey: sessionKey,
    queryFn: ({ signal }) => result(api.getAdministratorSession({ signal })),
    retry: false,
    staleTime: 60_000,
    enabled: restoreSessionHold === null,
  });
  if (session.data && !resetOverlay) authenticated.current = true;
  const forget = () => {
    // Initial sign-in may restore a shared record URL. An expired authenticated
    // session must discard its foreground request and editor before signing in again.
    if (authenticated.current) {
      authenticated.current = false;
      setResetOverlay(true);
    }
    clearOnboardingDeferrals();
    invalidateSessionRequests();
    void queryClient.cancelQueries();
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== "session",
    });
    queryClient.getMutationCache().clear();
    queryClient.setQueryData(sessionKey, null);
  };
  useEffect(() => {
    window.addEventListener("perpay:session-expired", forget);
    return () => window.removeEventListener("perpay:session-expired", forget);
  }, []);
  const rejected =
    restoreSessionHold === null &&
    session.error instanceof ApiError &&
    [401, 403].includes(session.error.status);
  useEffect(() => {
    if (rejected) forget();
  }, [rejected]);

  if (session.isPending)
    return (
      <AuthShell>
        <Card className="auth-card min-w-0">
          <CardHeader className="auth-card-header">
            <CardTitle className="auth-card-title">
              <h1 className="w-full">正在检查登录状态</h1>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Loading label="正在检查登录状态…" />
          </CardContent>
        </Card>
      </AuthShell>
    );
  if (session.isError && !session.data && !rejected) {
    return (
      <AuthShell>
        <Card className="auth-card min-w-0">
          <CardHeader className="auth-card-header">
            <CardTitle className="auth-card-title">
              <h1 className="w-full">无法检查登录状态</h1>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ErrorNotice
              error={session.error}
              retry={() => {
                void session.refetch();
              }}
            />
          </CardContent>
        </Card>
      </AuthShell>
    );
  }
  if (!session.data || rejected || resetOverlay)
    return (
      <>
      {resetOverlay && <ResetExpiredOverlay onComplete={finishReset} />}
      <AuthPage
        onLogin={() => {
          void session.refetch();
        }}
      />
      </>
    );
  return (
    <SessionContext
      value={{
        username: session.data.data.username,
        forget,
        error: restoreSessionHold === null ? session.error : null,
        retry: () => {
          void session.refetch();
        },
      }}
    >
      {children}
    </SessionContext>
  );
}

/** Runs after the protected subtree and its single navigation blocker unmount. */
function ResetExpiredOverlay({ onComplete }: { onComplete: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const legacy = legacyOverlayLocation(location);
    const state = { ...stateRecord(location.state) };
    const hadHistory = Object.hasOwn(state, OVERLAY_HISTORY_KEY);
    delete state[OVERLAY_HISTORY_KEY];
    if (legacy || hadHistory || new URLSearchParams(location.search).has(OVERLAY_PARAMETER)) {
      void Promise.resolve(navigate(overlayBackground(legacy?.to ?? location), {
        replace: true, state, preventScrollReset: true, viewTransition: false,
      })).then(onComplete);
    } else onComplete();
  }, [location, navigate, onComplete]);
  return null;
}

export function AuthPage({ onLogin }: { onLogin: () => void }) {
  return <LoginForm onLogin={onLogin} />;
}
