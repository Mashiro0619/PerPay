import * as React from "react";

const MOBILE_BREAKPOINT = 1024;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(() =>
    typeof window !== "undefined" && !window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT}px)`).matches,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT}px)`);
    const onChange = () => {
      setIsMobile(!mql.matches);
    };
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}
