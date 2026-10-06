import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { useWorkspace } from "@/workspace";
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
                className="hidden text-sm text-muted-foreground lg:inline"
              >
                全部网站
              </Link>
              <span className="hidden text-muted-foreground lg:inline">/</span>
            </>
          )}
          <WorkspaceSwitcher />
          <span className="hidden text-muted-foreground md:inline">/</span>
          <h1
            className="sr-only md:not-sr-only md:truncate md:text-sm md:font-medium"
            title={
              scope.clientId
                ? `${scope.site?.data?.data.configuration.name ?? scope.clientId} / ${title}`
                : title
            }
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
      >
        {scope.clientId
          ? `${scope.site?.data?.data.configuration.name ?? scope.clientId} / `
          : "全部网站 / "}
        {title}
      </div>
    </header>
  );
}
