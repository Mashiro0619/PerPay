import { useId, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type DetailSectionDefinition = {
  id: string;
  label: string;
  content: ReactNode;
  anchorPrefixes?: readonly string[];
};

/** Detail navigation belongs to the resource URL, never the background list. */
export function DetailSections({ sections, label = "详情分类" }: {
  sections: readonly DetailSectionDefinition[];
  label?: string;
}) {
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const requested = search.get("section");
  const anchor = location.hash.slice(1);
  const anchored = sections.find(section => section.anchorPrefixes?.some(prefix => anchor.startsWith(prefix)));
  const current = anchored?.id ?? sections.find(section => section.id === requested)?.id ?? sections[0]!.id;
  return <Tabs value={current} onValueChange={value => {
    const next = new URLSearchParams(search);
    if (value === sections[0]?.id) next.delete("section");
    else next.set("section", String(value));
    // Clearing the previous section anchor lets an explicit tab selection win.
    setSearch(next, { replace: true, preventScrollReset: true, state: location.state });
  }} className="detail-sections min-w-0 gap-4">
    <div className="min-w-0 overflow-x-auto overflow-y-hidden p-1">
      <TabsList aria-label={label} variant="line" activateOnFocus={false} className="min-w-max justify-start">
        {sections.map(section => <TabsTrigger key={section.id} value={section.id}>{section.label}</TabsTrigger>)}
      </TabsList>
    </div>
    {sections.map(section => <TabsContent key={section.id} value={section.id} className="min-w-0">
      <div className="detail-section-content flex min-w-0 flex-col gap-4">{section.content}</div>
    </TabsContent>)}
  </Tabs>;
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
