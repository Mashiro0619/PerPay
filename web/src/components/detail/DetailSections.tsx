import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";

export type DetailSectionDefinition = {
  id: string;
  label: string;
  content: ReactNode;
  anchorPrefixes?: readonly string[];
};

/** Keep every business section mounted; old section links still locate their content. */
export function DetailSections({ sections, label = "详情内容" }: {
  sections: readonly DetailSectionDefinition[];
  label?: string;
}) {
  const [search] = useSearchParams();
  const location = useLocation();
  const container = useRef<HTMLDivElement>(null);
  const requested = search.get("section");
  let anchor = "";
  try { anchor = decodeURIComponent(location.hash.slice(1)); } catch { /* Ignore malformed bookmark fragments. */ }
  const destination = sections.find(section => anchor && section.anchorPrefixes?.some(prefix => anchor.startsWith(prefix)))?.id
    ?? sections.find(section => section.id === requested)?.id;

  useLayoutEffect(() => {
    const root = container.current;
    if (!root || (!anchor && !destination)) return;
    let frame = 0;
    let complete = false;
    const locate = () => {
      if (complete) return;
      const exact = anchor ? Array.from(root.querySelectorAll<HTMLElement>("[id]")).find(element => element.id === anchor) : null;
      const section = Array.from(root.children).find(element => element.getAttribute("data-detail-section") === destination) as HTMLElement | undefined;
      const target = exact ?? section;
      if (!target || target.closest("[hidden], [inert]")) return;
      // Wait only for content that can move this destination, not later sections.
      const pendingBefore = Array.from(root.querySelectorAll('[data-slot="skeleton"]')).some(placeholder =>
        target.contains(placeholder) || !!(placeholder.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (pendingBefore) return;
      complete = true;
      observer.disconnect();
      target.scrollIntoView?.({ block: "start", behavior: "instant" });
      target.focus({ preventScroll: true });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(locate); };
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    schedule();
    return () => { complete = true; cancelAnimationFrame(frame); observer.disconnect(); };
  }, [location.pathname, anchor, destination]);

  return <div ref={container} role="group" aria-label={label} className="detail-sections flex min-w-0 flex-col gap-4">
    {sections.map(section => <section key={section.id} aria-label={section.label} data-detail-section={section.id} tabIndex={-1} className="min-w-0 scroll-mt-4">
      <div className="detail-section-content flex min-w-0 flex-col gap-4">{section.content}</div>
    </section>)}
  </div>;
}

export function DetailSection({ title, children, actions, headingLevel = 2 }: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3 | 4;
}) {
  const id = useId();
  const Heading = `h${headingLevel}` as const;
  return <section aria-labelledby={id} className="detail-section flex min-w-0 flex-col gap-3">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <Heading id={id} className="text-sm font-semibold">{title}</Heading>
      {actions}
    </div>
    {children}
  </section>;
}
