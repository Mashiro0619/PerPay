import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { cn } from "@/lib/utils";

/** Bubbles from a located anchor so every enclosing disclosure opens. */
export const REVEAL_EVENT = "record:reveal";
/** Bubbles from a section that was brought into view on request, so the navigation marks that one. */
export const SECTION_EVENT = "record:section";
const ANCHOR_HIT_MS = 1200;

/**
 * Keeps every section mounted in one scrolling column. A `#anchor` or
 * `?section=` link is located once: collapsed ancestors are opened first, and
 * an exact sub-record hit is highlighted briefly.
 */
export function Sections({ label = "详情内容", className, children }: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const [search] = useSearchParams();
  const location = useLocation();
  const container = useRef<HTMLDivElement>(null);
  const requested = search.get("section");
  let anchor = "";
  try { anchor = decodeURIComponent(location.hash.slice(1)); } catch { /* Ignore malformed bookmark fragments. */ }

  useLayoutEffect(() => {
    const root = container.current;
    if (!root || (!anchor && !requested)) return;
    let frame = 0;
    let highlight = 0;
    let highlighted: HTMLElement | null = null;
    let complete = false;
    const locate = () => {
      if (complete) return;
      const sections = Array.from(root.children).filter((element): element is HTMLElement => element.hasAttribute("data-detail-section"));
      const exact = anchor ? Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(element => element.id === anchor) : null;
      const section = (anchor ? sections.find(element => (element.dataset.anchorPrefixes ?? "").split(" ").some(prefix => prefix && anchor.startsWith(prefix))) : undefined)
        ?? sections.find(element => element.dataset.detailSection === requested);
      const target = exact ?? section;
      if (!target) return;
      if (target.closest("[inert]")) {
        // Another step/modal already owns focus on this record; stop waiting so
        // closing that step cannot yank focus back to the initial anchor.
        complete = true;
        observer.disconnect();
        return;
      }
      // Wait only for content that can move this destination, not later sections.
      const pendingBefore = Array.from(root.querySelectorAll('[data-slot="skeleton"]')).some(placeholder =>
        target.contains(placeholder) || !!(placeholder.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (pendingBefore) return;
      if (target.closest("[hidden]")) {
        // The observer runs this again once the disclosure has shown its panel.
        target.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true }));
        return;
      }
      complete = true;
      observer.disconnect();
      target.scrollIntoView?.({ block: "start", behavior: "instant" });
      target.focus({ preventScroll: true });
      (sections.find(element => element.contains(target)) ?? section)?.dispatchEvent(new CustomEvent(SECTION_EVENT, { bubbles: true }));
      if (exact) {
        highlighted = exact;
        exact.setAttribute("data-anchor-hit", "");
        highlight = window.setTimeout(() => exact.removeAttribute("data-anchor-hit"), ANCHOR_HIT_MS);
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(locate); };
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    schedule();
    return () => {
      complete = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(highlight);
      highlighted?.removeAttribute("data-anchor-hit");
      observer.disconnect();
    };
  }, [location.pathname, anchor, requested]);

  return <div ref={container} role="group" aria-label={label} data-record-sections className={cn("flex min-w-0 flex-col gap-5", className)}>{children}</div>;
}

/** A count beside a name: shown as the bare number, read as "，共 N 项" so the name never runs into it. */
export function Count({ value, className, ...props }: { value: number; className?: string; "data-section-count"?: true }) {
  return <span {...props} className={cn("tabular-nums", className)}><span className="sr-only">，共 </span>{value}<span className="sr-only"> 项</span></span>;
}

/** Scrolls a section of the record that contains `origin` into view and moves focus to it. */
export function showSection(origin: Element | null, id: string) {
  const scope = origin?.closest("[data-overlay-primary]") ?? document.body;
  const target = Array.from(scope.querySelectorAll<HTMLElement>("[data-detail-section]")).find(element => element.dataset.detailSection === id);
  if (!target) return false;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  target.scrollIntoView?.({ block: "start", behavior: reduced ? "instant" : "smooth" });
  target.focus({ preventScroll: true });
  target.dispatchEvent(new CustomEvent(SECTION_EVENT, { bubbles: true }));
  return true;
}

/** A top-level section with a visible title. Rules separate top-level sections only. */
export function Section({ id, title, count, empty, anchorPrefixes, actions, children }: {
  id: string;
  title: string;
  count?: number;
  /** When set, the section collapses to its title row with this note beside it. */
  empty?: ReactNode;
  anchorPrefixes?: readonly string[];
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const heading = useId();
  const isEmpty = empty !== undefined && empty !== null && empty !== false;
  return <section aria-labelledby={heading} data-detail-section={id} data-section-empty={isEmpty || undefined}
    data-anchor-prefixes={anchorPrefixes?.join(" ")} tabIndex={-1}
    className="flex min-w-0 scroll-mt-4 flex-col gap-3 outline-none [&+&]:scroll-mt-[calc(-1rem-1px)] [&+&]:border-t [&+&]:pt-5">
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 id={heading} className="text-sm font-semibold text-foreground">
        {title}
        {count !== undefined && <Count data-section-count value={count} className="ml-1.5 text-xs font-normal text-muted-foreground" />}
      </h2>
      {isEmpty && <p className="min-w-0 text-[0.8125rem] leading-5 text-muted-foreground">{empty}</p>}
      {actions && <div className="ml-auto flex min-w-0 items-center gap-2">{actions}</div>}
    </div>
    {!isEmpty && children}
  </section>;
}
