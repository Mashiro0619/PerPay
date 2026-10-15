import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  invalidateSessionRequests,
  queryClient,
  result,
  sessionKey,
  type AdminSessionEnvelope,
} from "@/api/client";
import { ErrorNotice, Loading } from "@/components/request-state";
import { LoginForm } from "@/components/login-form";
import { PageHeading } from "@/components/page-heading";
import { clearOnboardingDeferrals } from "@/lib/onboarding";
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
  const session = useQuery<AdminSessionEnvelope | null>({
    queryKey: sessionKey,
    queryFn: ({ signal }) => result(api.getAdministratorSession({ signal })),
    retry: false,
    staleTime: 60_000,
  });
  const forget = () => {
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
    session.error instanceof ApiError &&
    [401, 403].includes(session.error.status);
  useEffect(() => {
    if (rejected) forget();
  }, [session.error]);

  if (session.isPending)
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 p-6">
        <PageHeading title="正在验证管理员会话" />
        <Loading label="正在验证管理员会话…" />
      </main>
    );
  if (session.isError && !session.data && !rejected) {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-6 p-6">
        <PageHeading title="无法验证管理员会话" />
        <ErrorNotice
          error={session.error}
          retry={() => {
            void session.refetch();
          }}
        />
      </main>
    );
  }
  if (!session.data || rejected)
    return (
      <AuthPage
        onLogin={() => {
          void session.refetch();
        }}
      />
    );
  return (
    <SessionContext
      value={{
        username: session.data.data.username,
        forget,
        error: session.error,
        retry: () => {
          void session.refetch();
        },
      }}
    >
      {children}
    </SessionContext>
  );
}

export function AuthPage({ onLogin }: { onLogin: () => void }) {
  return <LoginForm onLogin={onLogin} />;
}
