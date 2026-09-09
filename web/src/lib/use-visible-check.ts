import { useEffect, useState } from "react";

export function useVisibleCheck() {
  const [view, setView] = useState({ active: !document.hidden && navigator.onLine, epoch: 0 });
  useEffect(() => {
    const update = () => setView((previous) => ({ active: !document.hidden && navigator.onLine, epoch: previous.epoch + 1 }));
    document.addEventListener("visibilitychange", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { document.removeEventListener("visibilitychange", update); window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return view;
}
