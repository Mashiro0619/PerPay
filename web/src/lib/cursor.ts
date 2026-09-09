import { useLocation, useSearchParams } from "react-router";

type PageTrail = { scope: string; firstPage: number; cursors: Array<string | null> };

/** The active cursor is shareable; the visited cursor trail lives only in history. */
export function useCursor(key = "cursor") {
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const pageKey = key === "cursor" ? "page" : key + "_page";
  const scopeSearch = new URLSearchParams(search);
  scopeSearch.delete(key); scopeSearch.delete(pageKey); scopeSearch.sort();
  const scope = location.pathname + "?" + scopeSearch.toString() + ":" + key;
  const cursor = search.get(key) || null;
  const suppliedPage = Number(search.get(pageKey));
  const page = cursor ? (Number.isSafeInteger(suppliedPage) && suppliedPage >= 2 ? suppliedPage : 2) : 1;
  const state = location.state && typeof location.state === "object" ? location.state : {};
  const saved: unknown = state.pagination?.[key];
  const trail = validTrail(saved, scope, cursor, page) ? saved : { scope, firstPage: page, cursors: [cursor] };
  function go(next: PageTrail) {
    const current = next.cursors.at(-1);
    const nextSearch = new URLSearchParams(search);
    if (current) { nextSearch.set(key, current); nextSearch.set(pageKey, String(next.firstPage + next.cursors.length - 1)); }
    else { nextSearch.delete(key); nextSearch.delete(pageKey); }
    setSearch(nextSearch, { state: { ...state, pagination: { ...state.pagination, [key]: next } } });
  }
  return {
    cursor: cursor ?? undefined,
    page,
    previousLabel: trail.cursors.length === 1 && page > 2 ? "返回首页" : "上一页",
    previous: () => go(trail.cursors.length > 1 ? { ...trail, cursors: trail.cursors.slice(0, -1) } : { scope, firstPage: 1, cursors: [null] }),
    next: (value: string | null | undefined) => { if (value) go({ ...trail, cursors: [...trail.cursors, value] }); },
  };
}

function validTrail(value: unknown, scope: string, cursor: string | null, page: number): value is PageTrail {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PageTrail>;
  return candidate.scope === scope && Number.isSafeInteger(candidate.firstPage) && candidate.firstPage! >= 1 &&
    Array.isArray(candidate.cursors) && candidate.cursors.length > 0 &&
    candidate.cursors.every((item) => item === null || typeof item === "string") &&
    candidate.cursors.at(-1) === cursor && candidate.firstPage! + candidate.cursors.length - 1 === page;
}
