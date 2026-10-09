import { useWorkspace } from "@/workspace";
import { useLocation } from "react-router";
import { isGlobalNavigationPage } from "@/lib/navigation-selection";
import { Link } from "@/navigation";
import { RefreshButton } from "@/components/refresh-button";
import { ContentWidthControl } from "@/components/content-width";
import { PageHeaderActionsSlot } from "@/components/page-header-actions";
import { DemoNotice } from "@/components/demo-notice";
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
  const pagePath = `${workspaceName} / ${title}`;
  const fetching = useIsFetching({ queryKey: ["analytics"] }) > 0;
  return (
    <header className="flex min-h-(--header-height) shrink-0 flex-col gap-1 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex min-h-(--header-height) w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" aria-label="切换导航" />
        <Separator
          orientation="vertical"
          className="mx-2 h-4 data-vertical:self-auto"
        />
        <div className="flex min-w-0 items-center gap-1">
          {scope.clientId && (
            <>
              <Link
                global
                to="/"
                className="hidden shrink-0 text-sm text-muted-foreground md:inline"
              >
                全部网站
              </Link>
              <span
                aria-hidden="true"
                className="hidden shrink-0 text-muted-foreground md:inline"
              >
                /
              </span>
            </>
          )}
          <span
            className="min-w-0 max-w-40 truncate text-sm text-muted-foreground sm:max-w-64"
            title={workspaceName}
          >
            {workspaceName}
          </span>
          <span
            aria-hidden="true"
            className="hidden shrink-0 text-muted-foreground md:inline"
          >
            /
          </span>
          <h1
            className="sr-only md:not-sr-only md:min-w-0 md:truncate md:text-sm md:font-medium"
            title={pagePath}
          >
            {title}
          </h1>
        </div>
        <DemoNotice />
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
      <div
        aria-hidden="true"
        className="w-full truncate px-4 pb-2 text-xs text-muted-foreground md:hidden"
        title={pagePath}
      >
        {pagePath}
      </div>
    </header>
  );
}
