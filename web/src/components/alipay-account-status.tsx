import { useMutation } from "@tanstack/react-query";
import {
  api,
  refreshOperationalData,
  result,
  type AlipayAccount,
} from "@/api/client";
import { accountHealth, accountState } from "@/lib/alipay-accounts";
import { manualScanActive } from "@/lib/manual-ledger-scan";
import { AlipayAccountIdentity } from "@/components/alipay-account-identity";
import { ListDateTime } from "@/components/list-primitives";
import { ErrorNotice } from "@/components/request-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function AlipayAccountStatus({
  accounts,
}: {
  accounts: readonly AlipayAccount[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>支付宝账号查账</CardTitle>
        <CardDescription>
          各账号独立查账，暂停新订单的账号仍继续处理原有订单。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col divide-y">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex min-w-0 flex-col gap-3 py-3 first:pt-0 last:pb-0"
              data-account-runtime={account.id}
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2" data-account-runtime-heading>
                <AlipayAccountIdentity id={account.id} name={account.name} />
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="outline">{accountState(account)}</Badge>
                  <Badge variant={account.health?.last_error_code ? "destructive" : "outline"}>
                    {accountHealth(account)}
                  </Badge>
                </div>
              </div>
              <p className="text-sm text-muted-foreground" data-account-runtime-time>
                {account.health?.last_success_at
                  ? <>最近成功查账：<ListDateTime value={account.health.last_success_at} inline /></>
                  : "尚无成功查账记录"}
              </p>
              <AccountScan account={account} />
            </div>
          ))}
          {accounts.length === 0 && (
            <p className="text-sm text-muted-foreground">
              尚未添加支付宝账号。
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AccountScan({ account }: { account: AlipayAccount }) {
  const scan = useMutation({
    networkMode: "always",
    mutationFn: () =>
      result(
        api.requestLedgerScan({ body: { alipay_account_id: account.id } }),
      ),
    onSuccess: () => {
      void refreshOperationalData();
    },
  });
  const serverRequest = account.manual_scan?.request;
  const submittedRequest = scan.data?.data;
  const request =
    submittedRequest &&
    (!serverRequest ||
      (submittedRequest.id !== serverRequest.id &&
        Date.parse(submittedRequest.requested_at) >
          Date.parse(serverRequest.requested_at)))
      ? submittedRequest
      : serverRequest;
  const active = manualScanActive(request);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-account-runtime-actions>
      <Button
        variant="outline"
        size="sm"
        disabled={scan.isPending || active || !account.manual_scan?.available}
        onClick={() => scan.mutate()}
        aria-label={"立即查账：" + account.name}
      >
        {scan.isPending ? "正在提交…" : active ? "查账处理中…" : "立即查账"}
      </Button>
      {request && !active && (
        <span className="text-sm text-muted-foreground">
          {request.state === "FAILED"
            ? "本次查账失败"
            : request.outcome === "COMPLETED"
              ? "本次查账完成"
              : request.outcome === "PARTIAL"
                ? "本次部分完成"
                : "本次未执行查账"}
        </span>
      )}
      <ErrorNotice error={scan.error} />
    </div>
  );
}
