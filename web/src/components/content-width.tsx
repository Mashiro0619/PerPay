import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type ContentWidth = "compact" | "full";
export const CONTENT_WIDTH_KEY = "perpay:content-width";
const normalize = (value: string | null): ContentWidth => value === "full" ? "full" : "compact";
function storedWidth(): ContentWidth {
  try { return normalize(localStorage.getItem(CONTENT_WIDTH_KEY)); }
  catch { return "compact"; }
}
const WidthContext = createContext<{
  mode: ContentWidth;
  toggle: () => void;
} | null>(null);

/** Browser-only presentation preference, deliberately outside all business query state. */
export function ContentWidthProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ContentWidth>(storedWidth);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== CONTENT_WIDTH_KEY) return;
      try { if (event.storageArea !== localStorage) return; }
      catch { return; }
      setMode(event.key === null ? "compact" : normalize(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const toggle = useCallback(() => {
    const next = mode === "compact" ? "full" : "compact";
    setMode(next);
    try { localStorage.setItem(CONTENT_WIDTH_KEY, next); }
    catch { /* The current page still works when storage is unavailable. */ }
  }, [mode]);
  const value = useMemo(() => ({ mode, toggle }), [mode, toggle]);
  return <WidthContext value={value}>{children}</WidthContext>;
}
function useContentWidth() {
  const value = useContext(WidthContext);
  if (!value) throw new Error("Content width requires its administrator provider");
  return value;
}

export function AdminContent({ children, busy = false, layout = "default" }: { children: ReactNode; busy?: boolean; layout?: "default" | "detail" }) {
  const { mode } = useContentWidth();
  return (
    <div
      id="main-content"
      tabIndex={-1}
      inert={busy}
      aria-busy={busy}
      className="flex min-w-0 flex-1 flex-col px-4 outline-none lg:px-6"
    >
      <div
        className={cn(
          "@container/main mx-auto w-full min-w-0",
          layout === "detail"
            ? mode === "compact" ? "max-w-5xl" : "max-w-7xl"
            : mode === "compact" ? "max-w-7xl" : "max-w-none",
        )}
        data-content-width={mode}
        data-content-layout={layout}
      >
        <div className="flex min-w-0 flex-col gap-6 py-4 md:py-6">
          {children}
        </div>
      </div>
    </div>
  );
}

export function ContentWidthControl() {
  const { mode, toggle } = useContentWidth();
  const label = mode === "compact" ? "切换为全屏布局" : "切换为收缩布局";
  const Icon = mode === "compact" ? Maximize2 : Minimize2;
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          variant="ghost"
          size="icon"
          className="hidden lg:inline-flex"
          aria-label={label}
          aria-pressed={mode === "full"}
          onClick={toggle}
          data-content-width-toggle
        />
      }>
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
