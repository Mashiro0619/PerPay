import { Link } from "@/navigation";

export function SiteIdentity({ clientId, name }: { clientId?: string | undefined; name?: string | null | undefined }) {
  if (!clientId) return <span className="text-muted-foreground">所属网站未知</span>;
  return <Link to={"/sites/" + encodeURIComponent(clientId)} aria-label={(name ?? "网站名称暂不可用") + " · " + clientId} className="flex min-w-0 flex-col gap-1 break-all hover:underline">
    <span>{name ?? "网站名称暂不可用"}</span>
    <span className="text-xs text-muted-foreground">{clientId}</span>
  </Link>;
}
