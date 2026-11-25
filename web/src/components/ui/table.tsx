import * as React from "react"
import { cn } from "cn"
import { createRafCoalescer } from "@/lib/raf-coalesce"

function Table({
  className,
  containerLabel,
  containerLabelledBy,
  ...props
}: React.ComponentProps<"table"> & {
  containerLabel?: string
  containerLabelledBy?: string
}) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const tableRef = React.useRef<HTMLTableElement>(null)
  const [overflowing, setOverflowing] = React.useState(false)
  const regionLabel =
    containerLabel ??
    (!containerLabelledBy && props["aria-label"]
      ? `${props["aria-label"]}横向滚动区域`
      : undefined)
  const wantsScrollRegion = Boolean(regionLabel || containerLabelledBy)

  React.useLayoutEffect(() => {
    if (!wantsScrollRegion) {
      setOverflowing(false)
      return
    }
    const container = containerRef.current
    const table = tableRef.current
    if (!container) return
    const measure = () => {
      const next = container.scrollWidth > container.clientWidth + 1
      setOverflowing((prev) => (prev === next ? prev : next))
    }
    const coalesced = createRafCoalescer(measure)
    measure()
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(coalesced.schedule)
    observer?.observe(container)
    if (table) observer?.observe(table)
    window.addEventListener("resize", coalesced.schedule)
    return () => {
      coalesced.cancel()
      observer?.disconnect()
      window.removeEventListener("resize", coalesced.schedule)
    }
  }, [wantsScrollRegion])

  const isScrollRegion = wantsScrollRegion && overflowing
  return (
    <div
      ref={containerRef}
      data-slot="table-container"
      tabIndex={isScrollRegion ? 0 : undefined}
      role={isScrollRegion ? "region" : undefined}
      aria-label={isScrollRegion ? regionLabel : undefined}
      aria-labelledby={isScrollRegion ? containerLabelledBy : undefined}
      className={cn(
        "relative w-full overflow-x-auto",
        isScrollRegion &&
          "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      )}
    >
      <table
        ref={tableRef}
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({
  className,
  scope = "col",
  ...props
}: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope={scope}
      className={cn(
        "min-h-10 px-2 py-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
