import { Link } from "@/navigation";

export function SiteIdentity({ clientId, name }: { clientId?: string | undefined; name?: string | null | undefined }) {
  if (!clientId) return <span className="text-muted-foreground">所属网站未知</span>;
  return <Link to={"/sites/" + encodeURIComponent(clientId)} aria-label={(name ?? "网站名称暂不可用") + " · " + clientId} title={clientId} className="block min-w-0 truncate text-sm text-muted-foreground hover:underline">
    <span>{name ?? "网站名称暂不可用"}</span>
  </Link>;
}
