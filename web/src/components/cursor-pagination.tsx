import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
export function CursorPagination({
  page,
  hasNext,
  pending,
  onPrevious,
  onNext,
  count,
  previousLabel = "上一页",
}: {
  page: number;
  hasNext: boolean;
  pending?: boolean;
  onPrevious: () => void;
  onNext: () => void;
  count: number;
  previousLabel?: string;
}) {
  if (page === 1 && !hasNext) return null;
  return (
    <Pagination
      className="list-pagination flex-wrap justify-between gap-4"
      aria-label="列表分页"
    >
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-sm text-muted-foreground"
      >
        {pending
          ? "正在读取第 " + page + " 页…"
          : "第 " + page + " 页 · 本页 " + count + " 条"}
      </p>
      <PaginationContent className="min-w-0 max-w-full flex-wrap justify-end gap-2">
        <PaginationItem className="min-w-0 max-w-full">
          <Button
            size="sm"
            variant="outline"
            className="h-auto min-h-7 max-w-full whitespace-normal"
            aria-label={previousLabel}
            disabled={page <= 1 || pending}
            onClick={onPrevious}
          >
            <ChevronLeft data-icon="inline-start" />
            {previousLabel}
          </Button>
        </PaginationItem>
        <PaginationItem className="min-w-0 max-w-full">
          <Button
            size="sm"
            variant="outline"
            className="h-auto min-h-7 max-w-full whitespace-normal"
            aria-label="下一页"
            disabled={!hasNext || pending}
            onClick={onNext}
          >
            下一页
            <ChevronRight data-icon="inline-end" />
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
