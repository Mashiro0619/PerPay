import { useEffect, useState } from "react";

// The sidebar switches at 768px, leaving a narrow content area on landscape
// phones and small tablets. Keep list tools compact until the desktop lg size.
const LIST_COMPACT_BREAKPOINT = 1024;
export function useCompactList() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(
      "(max-width: " + (LIST_COMPACT_BREAKPOINT - 1) + "px)",
    );
    const update = () =>
      setCompact(window.innerWidth < LIST_COMPACT_BREAKPOINT);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}
