export function alipayApplicationUrl(appId: string | null | undefined): string {
  const id = appId?.trim();
  if (!id) return "https://open.alipay.com/develop/manage";
  const url = new URL("https://open.alipay.com/develop/pm/sub/appinfo");
  url.searchParams.set("appId", id);
  return url.toString();
}
