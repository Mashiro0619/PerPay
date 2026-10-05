import { useId, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, result } from "@/api/client";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorNotice } from "@/components/request-state";

/** No implicit first/default website: the operator must choose the owner. */
export function SitePicker({ value, onChange, disabled = false }: {
  value: string; onChange: (clientId: string) => void; disabled?: boolean;
}) {
  const id = useId();
  const [opened, setOpened] = useState(false);
  const [search, setSearch] = useState("");
  const query = useInfiniteQuery({
    queryKey: ["sites", "picker", search], initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => result(api.listSites({ query: { q: search, limit: 50, ...(pageParam ? { after: pageParam } : {}) }, signal })),
    getNextPageParam: page => page.page.next_cursor ?? undefined,
    enabled: opened && !disabled,
  });
  const sites = query.data?.pages.flatMap(page => page.data) ?? [];
  const selected = sites.find(site => site.client_id === value);
  return <Field data-disabled={disabled}>
    <FieldLabel htmlFor={id}>业务网站</FieldLabel>
    <Input aria-label="搜索业务网站" placeholder="搜索名称或客户端 ID" value={search} maxLength={128} disabled={disabled} onChange={event => { setOpened(true); setSearch(event.target.value); }} />
    <Select onOpenChange={open => { if (open) setOpened(true); }} value={value || null} disabled={disabled} onValueChange={next => { if (next) onChange(next); }}>
      <SelectTrigger id={id} className="w-full"><SelectValue placeholder="请选择业务网站">{value ? selected ? selected.configuration.name + " · " + value : value : undefined}</SelectValue></SelectTrigger>
      <SelectContent><SelectGroup>
        {sites.map(site => <SelectItem key={site.client_id} value={site.client_id}>{site.configuration.name} · {site.client_id}{site.configuration.accepting_orders ? "" : "（暂停接单）"}</SelectItem>)}
      </SelectGroup></SelectContent>
    </Select>
    {query.error && <ErrorNotice error={query.error} />}
    {query.isLoading && <FieldDescription>正在读取网站…</FieldDescription>}
    {query.isSuccess && !sites.length && <FieldDescription>没有匹配的网站，请先创建网站或更换搜索条件。</FieldDescription>}
    {query.hasNextPage && <Button type="button" variant="outline" disabled={disabled || query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>加载更多网站</Button>}
    <FieldDescription>选择网站后按该网站查看或操作；不会改变其他网站的配置。</FieldDescription>
  </Field>;
}
