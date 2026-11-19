import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Count, REVEAL_EVENT } from "./Sections";

/**
 * Secondary or historical content, collapsed by default. The panel stays
 * mounted so deep links can find anchors inside it and open it.
 */
export function Disclosure({ label, count, defaultOpen = false, children }: {
  label: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const reveal = () => setOpen(true);
    element.addEventListener(REVEAL_EVENT, reveal);
    return () => element.removeEventListener(REVEAL_EVENT, reveal);
  }, []);
  return <Collapsible ref={root} open={open} onOpenChange={setOpen} data-record-disclosure className="flex min-w-0 flex-col">
    <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group/disclosure -ml-2 h-auto min-h-7 max-w-full self-start whitespace-normal text-left text-[0.8125rem] font-medium text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted aria-expanded:hover:text-foreground" />}>
      <ChevronRight data-icon="inline-start" aria-hidden="true" className="transition-transform duration-(--motion-base) ease-(--motion-ease-move) group-aria-expanded/disclosure:rotate-90" />
      <span>{label}{count !== undefined && <Count value={count} className="ml-1 font-normal" />}</span>
    </CollapsibleTrigger>
    {/* The negative margin and inner padding leave room for focus rings inside the clipped panel. */}
    <CollapsibleContent keepMounted className="-mx-1 h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--motion-base) ease-(--motion-ease-move) data-ending-style:h-0 data-starting-style:h-0">
      <div className="flex min-w-0 flex-col gap-3 px-1 pt-2 pb-1">{children}</div>
    </CollapsibleContent>
  </Collapsible>;
}
