import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { showSection } from "./Sections";

export type SectionLink = { id: string; label: string; count?: number };

/** In-page links to the record's sections; the one being read is marked. */
export function SectionNav({ items, label = "分区导航" }: { items: readonly SectionLink[]; label?: string }) {
  const root = useRef<HTMLElement>(null);
  const [active, setActive] = useState(items[0]?.id);
  const ids = items.map(item => item.id).join(" ");

  useEffect(() => {
    const scope = root.current?.closest("[data-overlay-primary]") ?? document.body;
    const scroller = scope.querySelector<HTMLElement>("[data-overlay-detail]");
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      const edge = scroller.getBoundingClientRect().top + 24;
      const wanted = ids.split(" ");
      const sections = Array.from(scroller.querySelectorAll<HTMLElement>("[data-detail-section]")).filter(element => wanted.includes(element.dataset.detailSection!));
      // The last section whose title has reached the top edge; a short final section counts once the end is reached.
      let current = sections[0];
      for (const section of sections) if (section.getBoundingClientRect().top <= edge) current = section;
      if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) current = sections.at(-1);
      if (current) setActive(current.dataset.detailSection);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    scroller.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => { cancelAnimationFrame(frame); scroller.removeEventListener("scroll", schedule); };
  }, [ids]);

  return <nav ref={root} aria-label={label} data-record-nav className="-mb-px flex min-w-0 gap-4 overflow-x-auto">
    {items.map(item => <Button key={item.id} type="button" variant="link" size="sm" aria-current={active === item.id ? "true" : undefined}
      onClick={() => { if (showSection(root.current, item.id)) setActive(item.id); }}
      className="h-auto gap-0 rounded-none border-0 border-b-2 border-transparent px-0 pt-1 pb-2 text-[0.8125rem] leading-5 font-normal text-muted-foreground transition-colors duration-(--motion-instant) hover:text-foreground hover:no-underline focus-visible:text-foreground focus-visible:underline focus-visible:ring-0 aria-[current=true]:border-foreground aria-[current=true]:text-foreground pointer-coarse:min-h-10">
      {item.label}{item.count !== undefined && <span className="ml-1 tabular-nums">{item.count}</span>}
    </Button>)}
  </nav>;
}

/**
 * The fixed head of a record: its amount or status phrase, badges, and at most
 * two lines of conclusion. Status colour stays in the badges; the value turns
 * red only when it is itself the problem.
 */
export function RecordSummary({ label, value, size = "amount", status, tone = "default", meta = [], compare = [], nav = [] }: {
  /** Accessible name of the summary group. */
  label: string;
  /** Left out by records that have neither; their badges or conclusion lead instead. */
  value?: ReactNode;
  /** Amounts are large; records without an amount lead with a short phrase. */
  size?: "amount" | "phrase";
  status?: ReactNode;
  tone?: "default" | "danger";
  meta?: ReadonlyArray<ReactNode | false | null | undefined>;
  compare?: ReadonlyArray<{ label: string; left: ReactNode; right: ReactNode; differs: boolean }>;
  /** Shown when the record has at least three sections, while the summary stays fixed above the content. */
  nav?: readonly SectionLink[];
}) {
  const hasValue = value !== undefined && value !== null && value !== false && value !== "";
  const lines = meta.filter(line => line !== false && line !== null && line !== undefined && line !== "").slice(0, 2);
  return <div role="group" aria-label={label} data-record-summary className="flex min-w-0 flex-col gap-3">
    {(hasValue || status) && <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      {hasValue && <p data-record-summary-value className={cn("min-w-0 font-semibold wrap-anywhere",
        size === "amount" ? "text-[1.75rem] leading-9 tracking-tight tabular-nums max-md:text-2xl max-md:leading-8" : "text-base leading-6",
        tone === "danger" ? "text-destructive" : "text-foreground")}>{value}</p>}
      {status}
    </div>}
    {lines.length > 0 && <div data-record-summary-meta className="flex min-w-0 flex-col text-[0.8125rem] leading-5 text-muted-foreground tabular-nums">
      {lines.map((line, index) => <p key={index} className="min-w-0 wrap-anywhere">{line}</p>)}
    </div>}
    {compare.length > 0 && <dl data-record-compare className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm leading-5">
      {compare.map(row => <div key={row.label} data-differs={row.differs || undefined} className="col-span-full grid min-w-0 grid-cols-subgrid items-baseline">
        <dt className="text-[0.8125rem] text-muted-foreground">{row.label}</dt>
        <dd className="min-w-0 tabular-nums wrap-anywhere">{row.left}</dd>
        <dd className={cn("min-w-0 tabular-nums wrap-anywhere", row.differs && "font-medium text-destructive")}>{row.right}</dd>
      </div>)}
    </dl>}
    {nav.length >= 3 && <SectionNav items={nav} />}
  </div>;
}

/** States why a record needs attention and what was concluded. It never holds buttons. */
export function RecordNotice({ tone, children, jump }: {
  tone: "warning" | "danger";
  children: ReactNode;
  jump?: { section: string; label: string } | { to: string; label: string };
}) {
  const root = useRef<HTMLDivElement>(null);
  const link = "w-fit text-left underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
  const button = "h-auto w-fit gap-0 rounded-sm border-0 p-0 text-sm leading-5 font-normal whitespace-normal text-foreground underline";
  return <div ref={root} data-record-notice={tone} className={cn("flex min-w-0 flex-col gap-1 border-l-2 pl-3 text-sm leading-5",
    tone === "danger" ? "border-destructive" : "border-warning-foreground")}>
    <div className="min-w-0 wrap-anywhere">{children}</div>
    {jump && ("section" in jump
      ? <Button type="button" variant="link" size="sm" className={button} onClick={() => showSection(root.current, jump.section)}>{jump.label}<span aria-hidden="true" className="whitespace-pre"> ›</span></Button>
      : <Link to={jump.to} className={link}>{jump.label}<span aria-hidden="true"> ›</span></Link>)}
  </div>;
}
