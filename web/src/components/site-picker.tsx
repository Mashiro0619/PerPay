import { useId, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, result } from "@/api/client";
import { siteChoiceLabel } from "@/lib/site-choice-label";
import { Field, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorNotice, Loading } from "@/components/request-state";
export function SitePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (clientId: string) => void;
  disabled?: boolean;
}) {
  const id = useId(),
    [opened, setOpened] = useState(false);
  const query = useInfiniteQuery({
    queryKey: ["sites", "picker"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      result(
        api.listSites({
          query: { limit: 50, ...(pageParam ? { after: pageParam } : {}) },
          signal,
        }),
      ),
    getNextPageParam: (p) => p.page.next_cursor ?? undefined,
    enabled: opened && !disabled,
  });
  const sites = query.data?.pages.flatMap((p) => p.data) ?? [],
    selected = sites.find((s) => s.client_id === value);
  const current = useQuery({
    queryKey: ["site-choice", value],
    queryFn: ({ signal }) =>
      result(api.getSite({ path: { clientId: value }, signal })),
    enabled: !!value && !selected,
    refetchOnWindowFocus: false,
  });
  const named = selected ?? current.data?.data;
  return (
    <Field className="w-full min-w-0 max-w-md" data-disabled={disabled}>
      <FieldLabel htmlFor={id}>业务网站</FieldLabel>
      <Select
        onOpenChange={(open) => {
          if (open) setOpened(true);
        }}
        value={value || null}
        disabled={disabled}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
      >
        <SelectTrigger
          id={id}
          className="w-full min-w-0 gap-1 py-1 whitespace-normal data-[size=default]:h-auto data-[size=default]:min-h-8 *:data-[slot=select-value]:line-clamp-none *:data-[slot=select-value]:block"
        >
          <SelectValue className="min-w-0 whitespace-normal wrap-anywhere" placeholder="请选择网站">
            {value
              ? named
                ? siteChoiceLabel(named, sites)
                : current.isError
                  ? "网站读取失败"
                  : "正在读取…"
              : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {sites.map((site) => (
              <SelectItem key={site.client_id} value={site.client_id}>
                {siteChoiceLabel(site, sites)}
                {site.configuration.accepting_orders ? "" : "（暂停接单）"}
              </SelectItem>
            ))}
          </SelectGroup>
          {query.isLoading && <Loading label="正在读取网站…" />}
          {query.error && (
            <ErrorNotice
              error={query.error}
              retry={() => void query.refetch()}
            />
          )}
          {query.isSuccess && !sites.length && (
            <p className="p-2 text-sm text-muted-foreground">暂无网站</p>
          )}
          {query.hasNextPage && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              加载更多网站
            </Button>
          )}
        </SelectContent>
      </Select>
      {current.isError && !selected && (
        <ErrorNotice
          error={current.error}
          retry={() => void current.refetch()}
        />
      )}
    </Field>
  );
}
