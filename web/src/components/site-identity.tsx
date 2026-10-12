import { Link } from "@/navigation";

export function SiteIdentity({ clientId, name }: { clientId?: string | undefined; name?: string | null | undefined }) {
  if (!clientId) return <span className="list-site-identity">所属网站未知</span>;
  return <Link to={"/sites/" + encodeURIComponent(clientId)} aria-label={(name ?? "网站名称暂不可用") + " · " + clientId} title={(name ?? "网站名称暂不可用") + " · " + clientId} className="list-site-identity">
    <span>{name ?? "网站名称暂不可用"}</span>
  </Link>;
}
