import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { siteChoiceLabel } from "@/lib/site-choice-label";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, result } from "@/api/client";
import { Link } from "@/navigation";
import { money } from "@/lib/format";
import { QueryView } from "@/components/request-state";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
export function SiteOverviewList({ range }: { range: 7 | 30 | 90 }) {
  const query = useInfiniteQuery({
    queryKey: ["site-overview", range],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      result(
        api.listSiteOverview({
          query: {
            range,
            limit: 10,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
          signal,
        }),
      ),
    getNextPageParam: (p) => p.page.next_cursor ?? undefined,
  });
  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-1">
        <CardTitle>各网站概览</CardTitle><Popover><PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="网站指标说明"/>}><Info/></PopoverTrigger><PopoverContent><p>确认与实收按所选区间；待付款与待办为当前数量。一级总数包含全部网站，不受此列表分页影响。</p></PopoverContent></Popover>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryView query={query}>
          {(data) => (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>网站</TableHead>
                    <TableHead>区间确认</TableHead>
                    <TableHead>区间实收</TableHead>
                    <TableHead>待付款</TableHead>
                    <TableHead>待办</TableHead>
                    <TableHead>后台</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.pages
                    .flatMap((p) => p.data)
                    .map((site) => (
                      <TableRow key={site.client_id}>
                        <TableCell>
                          <div className="flex flex-col items-start gap-1">
                            <span>{siteChoiceLabel({client_id:site.client_id,configuration:{name:site.name}},data.pages.flatMap(page=>page.data).map(row=>({client_id:row.client_id,configuration:{name:row.name}})))}</span>
                            {!site.accepting_orders && (
                              <Badge variant="secondary">暂停接单</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{site.confirmed_count}</TableCell>
                        <TableCell>
                          {money(site.confirmed_amount_cents)}
                        </TableCell>
                        <TableCell>{site.pending_orders}</TableCell>
                        <TableCell>{site.work_items}</TableCell>
                        <TableCell>
                          <Link
                            to={"/sites/" + site.client_id}
                            className={buttonVariants({
                              variant: "outline",
                              size: "sm",
                            })}
                          >
                            进入后台
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
              {!data.pages.some((p) => p.data.length) && (
                <p>暂无网站。</p>
              )}
              {query.hasNextPage && (
                <Button
                  variant="outline"
                  disabled={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  加载更多网站汇总
                </Button>
              )}
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}
