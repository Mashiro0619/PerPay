import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import { api, queryClient, result } from "@/api/client";
import { useDraftGuard } from "@/drafts";
import { RefreshButton } from "@/components/refresh-button";
import { PageHeaderActionLink, PageHeaderActions } from "@/components/page-header-actions";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { buttonVariants } from "@/components/ui/button";
import { alipayAccountsKey } from "@/lib/alipay-accounts";
import { AccountOnboarding } from "./AccountOnboarding";

export default function Onboarding() {
  const [editorVersion, setEditorVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [accountFlowLocked, setAccountFlowLocked] = useState(false);
  const accountFlowLock = useRef(false);
  const [refreshError, setRefreshError] = useState<Error | null>(null);
  const onRefreshLockChange = useCallback((locked: boolean) => {
    accountFlowLock.current = locked;
    setAccountFlowLocked(locked);
  }, []);
  const { requestDiscard } = useDraftGuard();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })),
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const instance = useQuery({
    queryKey: ["onboarding", "instance"],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  function reload() {
    requestDiscard(() => {
      if (accountFlowLock.current) return;
      setRefreshing(true);
      setRefreshError(null);
      void Promise.all([
        settings.refetch({ throwOnError: true }),
        instance.refetch({ throwOnError: true }),
        queryClient.refetchQueries({ queryKey: alipayAccountsKey, type: "active" }, { throwOnError: true }),
        queryClient.refetchQueries({ queryKey: ["onboarding", "sites"], type: "active" }, { throwOnError: true }),
        queryClient.refetchQueries({ queryKey: ["site-create-defaults"], type: "active" }, { throwOnError: true }),
      ]).then(
        () => {
          setEditorVersion((value) => value + 1);
          setRefreshing(false);
        },
        (error: unknown) => {
          setRefreshError(error instanceof Error ? error : new Error("刷新失败，请重试。"));
          setRefreshing(false);
        },
      );
    });
  }

  return (
    <div
      className="admin-settings-layout @container/onboarding mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-4"
      data-onboarding-workspace
    >
      <PageHeaderActions>
        <PageHeaderActionLink><a
          data-external-link
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          href="https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md"
          target="_blank"
          rel="noreferrer"
          aria-label="图文教程"
          title="图文教程"
        >
          <BookOpen data-icon="inline-start" />
          <span className="hidden sm:inline">图文教程</span>
        </a></PageHeaderActionLink>
        <RefreshButton disabled={
            refreshing ||
            settings.isFetching ||
            instance.isFetching ||
            accountFlowLocked
          } onClick={reload} busy={refreshing ||
            settings.isFetching ||
            instance.isFetching} />
      </PageHeaderActions>
      <ErrorNotice scope="page" error={refreshError} retry={reload} />
      <ErrorNotice
        scope="page"
        error={instance.error}
        retry={() => {
          void instance.refetch();
        }}
      />
      <QueryView query={settings}>
        {() => (
          <div className="min-w-0" inert={refreshing} aria-busy={refreshing}>
            <AccountOnboarding instanceId={instance.data?.data.instance_id ?? null}
              refreshVersion={editorVersion} onRefreshLockChange={onRefreshLockChange} />
          </div>
        )}
      </QueryView>
    </div>
  );
}
