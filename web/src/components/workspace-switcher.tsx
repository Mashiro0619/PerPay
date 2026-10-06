import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronsUpDown, Globe } from "lucide-react";
import { api, result } from "@/api/client";
import { useWorkspace } from "@/workspace";
import { Link } from "@/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import { QueryView } from "@/components/request-state";
export function WorkspaceSwitcher() {
  const { clientId, site } = useWorkspace();
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState("");
  const sites = useInfiniteQuery({
    queryKey: ["sites", "switcher", search],
    enabled: open,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      result(
        api.listSites({
          query: {
            q: search,
            limit: 30,
            ...(pageParam ? { after: pageParam } : {}),
          },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.page.next_cursor ?? undefined,
  });
  const name = clientId
    ? (site?.data?.data.configuration.name ?? clientId)
    : "全部网站";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="max-w-40 sm:max-w-64"
            aria-label="切换后台"
          />
        }
      >
        <Globe data-icon="inline-start" />
        <span className="truncate">{name}</span>
        <ChevronsUpDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverHeader>
          <PopoverTitle>切换管理空间</PopoverTitle>
        </PopoverHeader>
        <Link
          global
          to="/"
          onClick={() => setOpen(false)}
          className={buttonVariants({ variant: "outline" })}
        >
          全部网站 · 一级汇总
        </Link>
        <Field>
          <FieldLabel htmlFor="workspace-search">搜索网站</FieldLabel>
          <Input
            id="workspace-search"
            value={search}
            maxLength={128}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="名称或客户端 ID"
          />
        </Field>
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          <QueryView query={sites}>
            {(data) => (
              <>
                {data.pages
                  .flatMap((p) => p.data)
                  .map((value) => (
                    <Link
                      key={value.client_id}
                      to={"/sites/" + encodeURIComponent(value.client_id)}
                      onClick={() => setOpen(false)}
                      aria-current={
                        value.client_id === clientId ? "page" : undefined
                      }
                      className={buttonVariants({
                        variant: "ghost",
                        className: "h-auto justify-start py-2",
                      })}
                    >
                      <span className="flex min-w-0 flex-col items-start gap-1">
                        <span className="truncate">
                          {value.configuration.name}
                        </span>
                        <span className="max-w-full truncate text-xs text-muted-foreground">
                          {value.client_id}
                          {value.configuration.accepting_orders
                            ? ""
                            : " · 暂停接单"}
                        </span>
                      </span>
                    </Link>
                  ))}
                {!data.pages.some((p) => p.data.length) && (
                  <p className="p-2 text-muted-foreground">没有匹配的网站</p>
                )}
                {sites.hasNextPage && (
                  <Button
                    variant="outline"
                    disabled={sites.isFetchingNextPage}
                    onClick={() => void sites.fetchNextPage()}
                  >
                    加载更多网站
                  </Button>
                )}
              </>
            )}
          </QueryView>
        </div>
      </PopoverContent>
    </Popover>
  );
}
