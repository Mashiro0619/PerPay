import { useEffect, useState } from "react";

// Navigation and list tools share the desktop lg breakpoint.
const LIST_COMPACT_BREAKPOINT = 1024;
export function useCompactList() {
  const [compact, setCompact] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: " + (LIST_COMPACT_BREAKPOINT - 1) + "px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia(
      "(max-width: " + (LIST_COMPACT_BREAKPOINT - 1) + "px)",
    );
    const update = () =>
      setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}
