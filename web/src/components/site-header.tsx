import { RefreshCw, ScanLine } from "lucide-react";
import { useIsFetching } from "@tanstack/react-query";
import { Link } from "@/navigation";
import { refreshOperationalData } from "@/api/client";
import { ThemeControl } from "@/theme";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";

export function SiteHeader({
  title,
  overview,
}: {
  title: string;
  overview: boolean;
}) {
  const fetching = useIsFetching({ queryKey: ["analytics"] }) > 0;
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" aria-label="切换导航" />
        <Separator
          orientation="vertical"
          className="mx-2 h-4 data-vertical:self-auto"
        />
        <h1 className="truncate text-base font-medium">{title}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          {overview && (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="刷新"
                disabled={fetching}
                onClick={() => {
                  void refreshOperationalData();
                }}
              >
                {fetching ? <Spinner aria-hidden="true" /> : <RefreshCw />}
              </Button>
              <Link
                to="/test-payment"
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "hidden sm:inline-flex",
                )}
              >
                <ScanLine data-icon="inline-start" />
                测试收款
              </Link>
            </>
          )}
          <ThemeControl />
        </div>
      </div>
    </header>
  );
}
