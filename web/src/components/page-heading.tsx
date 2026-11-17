import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

/** `eyebrow` names what the record belongs to; only record overlays show it, above the title. */
type Heading = { title: string; description?: string; eyebrow?: string | undefined };
const HeadingContext = createContext<{ heading: Heading | null; setHeading: (heading: Heading | null) => void } | null>(null);

/** The route owns the title; refreshes update its text without moving focus. */
export function PageHeadingProvider({ children, routeKey = "default" }: { children: ReactNode; routeKey?: string }) {
  const [registered, setRegistered] = useState<{ routeKey: string; heading: Heading | null } | null>(null);
  const heading = registered?.routeKey === routeKey ? registered.heading : null;
  const setHeading = useCallback((heading: Heading | null) => setRegistered({ routeKey, heading }), [routeKey]);
  const value = useMemo(() => ({ heading, setHeading }), [heading, setHeading]);
  return <HeadingContext value={value}>{children}</HeadingContext>;
}
function HeadingContent({ title, description, actions }: Heading & { actions?: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-start justify-between gap-3" data-page-heading>
    <div className="flex min-w-0 flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {actions}
  </div>;
}
/** The heading registered by the current route, if any. */
export function usePageHeading(): Heading | null {
  return useContext(HeadingContext)?.heading ?? null;
}
export function PageHeadingSlot({ title, actions }: { title: string; actions?: ReactNode }) {
  const host = useContext(HeadingContext);
  const heading = host?.heading;
  return <HeadingContent title={heading?.title ?? title} {...(heading?.description ? { description: heading.description } : {})} actions={actions} />;
}
export function PageHeading({ title, description, eyebrow }: Heading) {
  const host = useContext(HeadingContext);
  const setHeading = host?.setHeading;
  useLayoutEffect(() => {
    setHeading?.({ title, ...(description ? { description } : {}), ...(eyebrow ? { eyebrow } : {}) });
    return () => setHeading?.(null);
  }, [setHeading, title, description, eyebrow]);
  return host ? null : <HeadingContent title={title} {...(description ? { description } : {})} />;
}
