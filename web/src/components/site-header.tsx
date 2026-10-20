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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { TestPaymentButton } from "@/components/test-payment-provider";
import { useState } from "react";
import { useMeasuredHeight } from "@/components/list-layout";

export function SiteHeader({
  title,
  overview,
  busy = false,
}: {
  title: string;
  overview: boolean;
  busy?: boolean;
}) {
  const scope = useWorkspace();
  const [header, setHeader] = useState<HTMLElement | null>(null);
  useMeasuredHeight(header, "--admin-header-height");
  const { pathname } = useLocation();
  const workspaceName = scope.clientId
    ? (scope.site?.data?.data.configuration.name ?? scope.clientId)
    : isGlobalNavigationPage(pathname) ? "全局" : "全部网站";
  const fetching = useIsFetching({ queryKey: ["analytics"] }) > 0;
  return (
    <header ref={setHeader} className="site-header shrink-0 border-b bg-background">
      <div className="flex h-full w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" aria-label="切换导航" />
        <Separator
          orientation="vertical"
          className="mx-2 h-4 data-vertical:self-auto"
        />
        <Breadcrumb aria-label="页面路径" className="min-w-0 flex-1">
          <BreadcrumbList className="min-w-0 flex-nowrap">
          {scope.clientId && (
            <>
              <BreadcrumbItem className="hidden shrink-0 md:inline-flex">
                <BreadcrumbLink render={<Link global to="/" />}>
                  全部网站
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:list-item" />
            </>
          )}
          <BreadcrumbItem className="min-w-0 max-w-40 sm:max-w-64">
            <span className="truncate" title={workspaceName}>{workspaceName}</span>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="truncate" title={title}>
              {title}
            </BreadcrumbPage>
          </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2" inert={busy}>
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
