import { useWorkspace } from "@/workspace";
import { useLocation } from "react-router";
import { isGlobalNavigationPage } from "@/lib/navigation-selection";
import { Link } from "@/navigation";
import { RefreshButton } from "@/components/refresh-button";
import { ContentWidthControl } from "@/components/content-width";
import { PageHeaderActionsSlot } from "@/components/page-header-actions";
import { useIsFetching } from "@tanstack/react-query";
import { refreshOperationalData } from "@/api/client";
import { ThemeControl } from "@/theme";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { TestPaymentButton } from "@/components/test-payment-provider";

export function SiteHeader({
  title,
  overview,
}: {
  title: string;
  overview: boolean;
}) {
  const scope = useWorkspace();
  const { pathname } = useLocation();
  const workspaceName = scope.clientId
    ? (scope.site?.data?.data.configuration.name ?? scope.clientId)
    : isGlobalNavigationPage(pathname) ? "全局" : "全部网站";
  const fetching = useIsFetching({ queryKey: ["analytics"] }) > 0;
  return (
    <header className="site-header shrink-0 border-b bg-background">
      <div className="flex h-full w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" aria-label="切换导航" />
        <Separator
          orientation="vertical"
          className="mx-2 h-4 data-vertical:self-auto"
        />
        <nav aria-label="页面路径" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-2 text-sm">
          {scope.clientId && (
            <li className="hidden shrink-0 items-center gap-2 md:flex">
              <Link
                global
                to="/"
                className="text-muted-foreground"
              >
                全部网站
              </Link>
              <span
                aria-hidden="true"
                className="text-muted-foreground"
              >
                /
              </span>
            </li>
          )}
          <li
            className="min-w-0 max-w-40 truncate text-muted-foreground sm:max-w-64"
            title={workspaceName}
          >
            {workspaceName}
          </li>
          <li
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
          >
            /
          </li>
          <li
            aria-current="page"
            className="min-w-0 truncate font-medium"
            title={title}
          >
            {title}
          </li>
          </ol>
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          {overview && (
            <>
              <RefreshButton
                disabled={fetching}
                onClick={() => {
                  void refreshOperationalData();
                }}
                busy={fetching}
              />
              <TestPaymentButton size="sm" title="测试收款">
                <span className="sr-only sm:not-sr-only">测试收款</span>
              </TestPaymentButton>
            </>
          )}
          <PageHeaderActionsSlot />
          <ContentWidthControl />
          <ThemeControl />
        </div>
      </div>
    </header>
  );
}
