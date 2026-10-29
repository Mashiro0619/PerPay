import { Link } from "@/navigation";

export function AlipayAccountIdentity({
  id,
  name,
}: {
  id?: string | null;
  name?: string | null;
}) {
  return id ? (
    <Link
      global
      className="wrap-anywhere underline-offset-4 hover:underline"
      to={"/settings/accounts/" + encodeURIComponent(id)}
    >
      {name || "支付宝账号"}
    </Link>
  ) : (
    <span className="text-muted-foreground">历史账号</span>
  );
}
