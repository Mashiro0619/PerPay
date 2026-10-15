import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

type Heading = { title: string; description?: string };
const HeadingContext = createContext<{ heading: Heading | null; setHeading: (heading: Heading | null) => void } | null>(null);

/** The route owns the title; refreshes update its text without moving focus. */
export function PageHeadingProvider({ children }: { children: ReactNode }) {
  const [heading, setHeading] = useState<Heading | null>(null);
  const value = useMemo(() => ({ heading, setHeading }), [heading]);
  return <HeadingContext value={value}>{children}</HeadingContext>;
}
function HeadingContent({ title, description }: Heading) {
  return <div className="flex min-w-0 flex-col gap-2" data-page-heading>
    <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    {description && <p className="text-sm text-muted-foreground">{description}</p>}
  </div>;
}
export function PageHeadingSlot({ title }: { title: string }) {
  const host = useContext(HeadingContext);
  return <HeadingContent {...(host?.heading ?? { title })} />;
}
export function PageHeading({ title, description }: Heading) {
  const host = useContext(HeadingContext);
  const setHeading = host?.setHeading;
  useLayoutEffect(() => {
    setHeading?.({ title, ...(description ? { description } : {}) });
    return () => setHeading?.(null);
  }, [setHeading, title, description]);
  return host ? null : <HeadingContent title={title} {...(description ? { description } : {})} />;
}
