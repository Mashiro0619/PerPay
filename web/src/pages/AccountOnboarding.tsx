import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router";
import { api, queryClient, result } from "@/api/client";
import { alipayAccountKey, alipayAccountsQuery } from "@/lib/alipay-accounts";
import { useDraftGuard } from "@/drafts";
import { Link, useNavigate } from "@/navigation";
import { AlipayAccountDetail, AlipayAccountList } from "./AlipayAccounts";
import CreateSite from "./CreateSite";
import { QueryView } from "@/components/request-state";
import { TestPaymentButton } from "@/components/test-payment-provider";
import { SitePicker } from "@/components/site-picker";
import { useCurrentTestPayment } from "@/lib/test-payment-request";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const steps = [
  { id: "accounts", title: "配置支付宝账号" },
  { id: "sites", title: "配置网站" },
  { id: "check", title: "试收款" },
] as const;

export function AccountOnboarding({
  instanceId,
  refreshVersion = 0,
  onRefreshLockChange,
}: {
  instanceId: string | null;
  refreshVersion?: number;
  onRefreshLockChange?: (locked: boolean) => void;
}) {
  const { step: requested } = useParams();
  const navigate = useNavigate();
  const { requestDiscard } = useDraftGuard();
  const accounts = useQuery(alipayAccountsQuery);
  const sites = useQuery({
    queryKey: ["onboarding", "sites"],
    queryFn: ({ signal }) =>
      result(api.listSites({ query: { limit: 100 }, signal })),
  });
  const [accountId, setAccountId] = useState<string | null>(null);
  const [createSite, setCreateSite] = useState(false);
  const [createdSiteId, setCreatedSiteId] = useState<string | null>(null);
  const savedAccountId = useRef<string | null>(null);
  const previousRefreshVersion = useRef(refreshVersion);
  useLayoutEffect(() => {
    if (previousRefreshVersion.current === refreshVersion) return;
    previousRefreshVersion.current = refreshVersion;
    setCreatedSiteId(null);
    if (accountId === "new" && savedAccountId.current) {
      const saved = accounts.data?.data.find(account => account.id === savedAccountId.current);
      if (saved) queryClient.setQueryData(alipayAccountKey(saved.id), { data: saved });
      setAccountId(saved?.id ?? null);
    }
  }, [refreshVersion, accountId, accounts.data]);
  const accountReady =
    accounts.data?.data.some(
      (account) => account.enabled && account.configured,
    ) ?? false;
  const siteReady =
    (sites.data?.data.some(
      (site) =>
        site.configuration.accepting_orders &&
        !!site.configuration.collection?.accounts.length,
    ) ??
      false) ||
    !!createdSiteId;
  const firstMissing = !accountReady ? 0 : !siteReady ? 1 : 2;
  const aliases: Record<string, string> = {
    application: "accounts",
    provider: "accounts",
    collection: "accounts",
    optional: "sites",
    api: "sites",
  };
  const requestedId = requested
    ? (aliases[requested] ?? requested)
    : steps[firstMissing]!.id;
  const requestedIndex = steps.findIndex((step) => step.id === requestedId);
  const index =
    requestedIndex < 0 ? firstMissing : Math.min(requestedIndex, firstMissing);
  const current = steps[index]!;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [current.id]);
  const path = "/settings/onboarding/" + current.id;
  if (accounts.isSuccess && sites.isSuccess && requested !== current.id)
    return <Navigate to={path} replace />;
  return (
    <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-4" data-account-onboarding>
      <nav aria-label="配置步骤">
        <div data-onboarding-step-selector className="flex min-w-0 flex-col gap-2">
          <p className="text-sm text-muted-foreground">第 {index + 1} / {steps.length} 步</p>
          <Select
            value={current.id}
            items={steps.map(step => ({ value: step.id, label: step.title }))}
            onValueChange={value => { if (value) void navigate("/settings/onboarding/" + value); }}
          >
            <SelectTrigger aria-label="选择配置步骤" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} data-onboarding-step-options className="min-w-0 max-w-(--available-width)">
              <SelectGroup>
                {steps.map((step, position) => (
                  <SelectItem key={step.id} value={step.id} disabled={position > firstMissing}>
                    {position + 1}. {step.title}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <ol className="grid grid-cols-3 gap-2" data-onboarding-step-list>
          {steps.map((step, position) => (
            <li key={step.id} className="min-w-0">
              {position > firstMissing ? (
                <span
                  role="link"
                  aria-disabled="true"
                  className="flex min-h-11 items-center justify-center gap-2 rounded-md p-2 text-center text-sm text-muted-foreground"
                >
                  <span>{position + 1}</span>
                  {step.title}
                </span>
              ) : (
                <Link
                  to={"/settings/onboarding/" + step.id}
                  aria-current={step.id === current.id ? "step" : undefined}
                  className={cn(
                    buttonVariants({
                      variant: step.id === current.id ? "secondary" : "ghost",
                    }),
                    "h-auto min-h-11 w-full whitespace-normal text-center",
                  )}
                >
                  <span>{position + 1}</span>
                  {step.title}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <h2
        ref={heading}
        tabIndex={-1}
        className="text-lg font-medium"
        data-onboarding-step-heading
      >
        {current.title}
      </h2>
      <QueryView query={accounts}>
        {() => (
          <QueryView query={sites}>
            {() => (
              <>
                {current.id === "accounts" && <>
                  {!accountId && <Alert>
                    <AlertTitle>开始前确认支付宝准备条件</AlertTitle>
                    <AlertDescription>
                      <ul className="list-disc pl-4">
                        <li>收款码与开放平台应用属于同一收款账号。</li>
                        <li>应用已上线，且已获得该账号的账务明细查询权限。</li>
                      </ul>
                      <a href="https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md#准备条件自检" target="_blank" rel="noopener noreferrer">查看应用准备与配置步骤</a>
                    </AlertDescription>
                  </Alert>}
                  {accountId ? (
                    <AlipayAccountDetail
                      key={accountId + ":" + refreshVersion}
                      accountId={accountId}
                      onSaved={account => { savedAccountId.current = account.id; }}
                      onRefreshLockChange={onRefreshLockChange}
                      onBack={() => requestDiscard(() => setAccountId(null))}
                    />
                  ) : (
                    <AlipayAccountList onSelect={id => { savedAccountId.current = null; setAccountId(id); }} />
                  )}</>}
                {current.id === "sites" && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      为网站选择收款账号。只接收试收款时，可先跳过 API
                      密钥与通知设置。
                    </p>
                    {createSite || !sites.data?.data.length ? (
                      <CreateSite
                        key={refreshVersion}
                        onRefreshLockChange={onRefreshLockChange}
                        onCreated={(id) => {
                          setCreatedSiteId(id);
                          setCreateSite(false);
                          void sites.refetch();
                        }}
                      />
                    ) : (
                      <>
                        <div className="flex flex-col divide-y rounded-lg border">
                          {sites.data.data.map((site) => (
                            <div
                              key={site.client_id}
                              className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-2.5"
                            >
                              <div className="min-w-0 flex-1">
                                <p className="font-medium">
                                  {site.configuration.name}
                                </p>
                                <Badge variant="outline">
                                  {site.configuration.collection?.accounts
                                    .length
                                    ? "已选择收款账号"
                                    : "待选择收款账号"}
                                </Badge>
                              </div>
                              <Link
                                to={
                                  "/sites/" +
                                  site.client_id +
                                  (site.configuration.collection?.accounts.length ? "/edit?section=integration" : "/settings/collection")
                                }
                                className={buttonVariants({
                                  variant: "outline",
                                  size: "sm",
                                })}
                              >
                                {site.configuration.collection?.accounts.length ? "接入业务网站" : "配置收款账号"}
                              </Link>
                            </div>
                          ))}
                        </div>
                        <Button
                          variant="outline"
                          className="self-start"
                          onClick={() => setCreateSite(true)}
                        >
                          再添加一个网站
                        </Button>
                      </>
                    )}
                  </>
                )}
                {current.id === "check" && (
                  <>
                  <Card>
                    <CardHeader>
                      <CardTitle>检查实际收款流程</CardTitle>
                      <CardDescription>
                        选择业务网站创建小额测试订单，使用该网站的分配规则。结果会显示本次使用的账号。
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col items-start gap-4">
                      <Alert>
                        <AlertTitle>配置已保存</AlertTitle>
                        <AlertDescription>
                          试收款会创建真实订单。请按收银台显示的实际应付金额付款，再查看确认结果。
                        </AlertDescription>
                      </Alert>
                      <TestPaymentButton />
                      <Link
                        to="/system"
                        className={buttonVariants({ variant: "outline" })}
                      >
                        查看运行状态
                      </Link>
                    </CardContent>
                  </Card>
                  <BusinessIntegrationSteps initialSiteId={createdSiteId ?? sites.data?.data[0]?.client_id ?? ""} />
                  </>
                )}
                <div
                  className="flex flex-wrap items-center justify-between gap-3 [&_:is(a,button)]:h-auto [&_:is(a,button)]:min-h-9 [&_:is(a,button)]:max-w-full [&_:is(a,button)]:whitespace-normal"
                  data-onboarding-actions
                >
                  {index > 0 && (
                    <Link
                      to={"/settings/onboarding/" + steps[index - 1]!.id}
                      className={buttonVariants({ variant: "outline" })}
                    >
                      上一步
                    </Link>
                  )}
                  <Link
                    to="/"
                    state={{ deferOnboardingFor: instanceId }}
                    className={buttonVariants({ variant: "ghost" })}
                  >
                    稍后继续
                  </Link>
                  {index < 2 ? (
                    <Button
                      disabled={index === firstMissing}
                      onClick={() => {
                        void navigate(
                          "/settings/onboarding/" + steps[index + 1]!.id,
                        );
                      }}
                    >
                      下一步：{steps[index + 1]!.title}
                    </Button>
                  ) : (
                    <Link to="/" className={buttonVariants()}>
                      进入控制台
                    </Link>
                  )}
                </div>
              </>
            )}
          </QueryView>
        )}
      </QueryView>
    </div>
  );
}

function BusinessIntegrationSteps({ initialSiteId }: { initialSiteId: string }) {
  const payment = useCurrentTestPayment();
  const [clientId, setClientId] = useState(payment.clientId || initialSiteId);
  useEffect(() => {
    if (payment.clientId) setClientId(payment.clientId);
  }, [payment.clientId]);
  const sitePath = "/sites/" + encodeURIComponent(clientId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>完成业务联调</CardTitle>
        <CardDescription>
          管理员测试订单用于检查收款与账号分配。接下来请从业务网站签名下单，并核对通知回执或主动查单结果。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <SitePicker value={clientId} onChange={setClientId} />
        {clientId && <div className="flex flex-wrap gap-2">
          <Link to={sitePath + "/edit?section=integration"} className={buttonVariants({ variant: "outline" })}>配置网站接入</Link>
          <Link to={sitePath + "/orders"} className={buttonVariants({ variant: "outline" })}>查看网站订单</Link>
          <Link to={sitePath + "/notifications"} className={buttonVariants({ variant: "outline" })}>查看通知记录</Link>
        </div>}
        <div className="flex flex-wrap gap-2">
          <a data-external-link href="https://github.com/Mashiro0619/PerPay/blob/main/docs/integration-quickstart.md" target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline" })}>原生 API 接入文档</a>
          <a data-external-link href="https://github.com/Mashiro0619/PerPay/blob/main/docs/epay-integration.md" target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline" })}>易支付接入文档</a>
        </div>
      </CardContent>
    </Card>
  );
}
