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
      className="flex-wrap justify-between gap-4"
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
      <PaginationContent>
        <PaginationItem>
          <Button
            size="sm"
            variant="outline"
            aria-label={previousLabel}
            disabled={page <= 1 || pending}
            onClick={onPrevious}
          >
            <ChevronLeft data-icon="inline-start" />
            {previousLabel}
          </Button>
        </PaginationItem>
        <PaginationItem>
          <Button
            size="sm"
            variant="outline"
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
