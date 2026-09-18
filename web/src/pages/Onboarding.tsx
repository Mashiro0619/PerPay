import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  RefreshCw,
  CircleCheck,
  CircleAlert,
} from "lucide-react";
import { Navigate, useParams } from "react-router";
import {
  api,
  queryClient,
  refreshOperationalData,
  result,
  type RuntimeSettings,
} from "@/api/client";
import { ApplicationKey, SettingsEditor } from "@/components/SettingsForms";
import { useDraftGuard } from "@/drafts";
import {
  nextRequiredStep,
  onboardingPath,
  onboardingSteps,
  resolveOnboardingStep,
  type OnboardingStep,
} from "@/lib/onboarding";
import { useVisibleCheck } from "@/lib/use-visible-check";
import { Link, useNavigate } from "@/navigation";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemGroup,
} from "@/components/ui/item";
import { RotateKeyDialog, SecretDialog } from "./SecuritySettings";
export default function Onboarding() {
  const [editorVersion, setEditorVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const { requestDiscard } = useDraftGuard();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => result(api.getRuntimeSettings({ signal })),
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const instance = useQuery({
    queryKey: ["onboarding", "instance"],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  function reload() {
    requestDiscard(() => {
      setRefreshing(true);
      void settings.refetch().then(
        (response) => {
          if (!response.isError) setEditorVersion((value) => value + 1);
          setRefreshing(false);
        },
        () => setRefreshing(false),
      );
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <a
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          href="https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md"
          target="_blank"
          rel="noreferrer"
        >
          图文教程
        </a>
        <Button
          variant="outline"
          disabled={settings.isFetching}
          onClick={reload}
        >
          {settings.isFetching ? (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          刷新
        </Button>
      </div>
      <ErrorNotice
        error={instance.error}
        retry={() => {
          void instance.refetch();
        }}
      />
      <QueryView query={settings}>
        {({ data }) => (
          <div className="min-w-0" inert={refreshing} aria-busy={refreshing}>
            <OnboardingFlow
              key={editorVersion}
              settings={data}
              instanceId={instance.data?.data.instance_id ?? null}
              onReload={reload}
            />
          </div>
        )}
      </QueryView>
    </>
  );
}
function OnboardingFlow({
  settings,
  instanceId,
  onReload,
}: {
  settings: RuntimeSettings;
  instanceId: string | null;
  onReload: () => void;
}) {
  const { step: requested } = useParams();
  const step = resolveOnboardingStep(settings, requested);
  const index = onboardingSteps.findIndex((item) => item.id === step);
  const firstMissing = onboardingSteps.findIndex(
    (item) => item.id === nextRequiredStep(settings),
  );
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step]);
  const deferredState = { deferOnboardingFor: instanceId };
  function saved(data: RuntimeSettings, next?: OnboardingStep) {
    queryClient.setQueryData(["settings"], { data });
    void refreshOperationalData();
    if (next) void navigate(onboardingPath(next));
  }
  if (requested !== step) return <Navigate to={onboardingPath(step)} replace />;
  const completed = [
    settings.completion.application_key,
    settings.completion.provider,
    settings.completion.collection,
    settings.completion.api,
  ];
  return (
    <Tabs
      value={step}
      onValueChange={(value) => {
        void navigate(onboardingPath(value as OnboardingStep));
      }}
      className="min-w-0 gap-6"
    >
      <div className="overflow-x-auto">
        <TabsList aria-label="配置步骤">
          {onboardingSteps.map((item, position) => (
            <TabsTrigger
              key={item.id}
              value={item.id}
              disabled={position > firstMissing}
            >
              {completed[position] ? (
                <Check data-icon="inline-start" aria-label="已配置" />
              ) : (
                position + 1
              )}
              {item.title}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value={step}>
        <div className="flex min-w-0 max-w-4xl flex-col gap-5">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <h2
              tabIndex={-1}
              ref={heading}
              className="text-xl font-semibold outline-none"
            >
              {onboardingSteps[index]!.title}
            </h2>
            <span className="text-sm text-muted-foreground">
              第 {index + 1} 步，共 6 步
            </span>
          </header>
          {step === "application" && (
            <>
              <ApplicationKey
                settings={settings}
                guided
                onSaved={(data) => saved(data)}
              />
              <Collapsible>
                <CollapsibleTrigger
                  render={<Button variant="ghost" size="sm" />}
                >
                  <ChevronDown data-icon="inline-start" />
                  接入前准备
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="flex list-inside list-disc flex-col gap-2 pt-4 text-sm text-muted-foreground">
                    <li>
                      支付宝应用需有账务明细查询权限，申请资格以支付宝为准。
                    </li>
                    <li>支付宝搜索“经营码”申请，使用同一账户收款。</li>
                  </ul>
                </CollapsibleContent>
              </Collapsible>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={!settings.completion.application_key}
                  onClick={() => {
                    void navigate(onboardingPath("provider"));
                  }}
                >
                  下一步
                </Button>
                <Link
                  className={buttonVariants({ variant: "ghost" })}
                  to="/settings/provider"
                  state={deferredState}
                >
                  导入已有密钥
                </Link>
              </div>
            </>
          )}
          {step === "provider" && (
            <>
              <p className="text-sm text-muted-foreground">
                在
                <a
                  className="underline underline-offset-4"
                  href="https://open.alipay.com/develop/manage"
                  target="_blank"
                  rel="noreferrer"
                >
                  支付宝应用管理
                </a>
                上传应用公钥，选择密钥加签。
              </p>
              {settings.application_public_key && (
                <Collapsible>
                  <CollapsibleTrigger
                    render={<Button variant="outline" size="sm" />}
                  >
                    查看应用公钥
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="pt-4">
                      <CopyValue
                        value={settings.application_public_key}
                        label="复制应用公钥"
                      />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
              <SettingsEditor
                key="provider"
                section="provider"
                settings={settings}
                guided
                submitLabel="保存并继续"
                onSaved={(data) => saved(data, "collection")}
              />
            </>
          )}
          {step === "collection" && (
            <SettingsEditor
              key="collection"
              section="collection"
              settings={settings}
              guided
              submitLabel="保存并继续"
              onSaved={(data) => saved(data, "api")}
            />
          )}
          {step === "api" && (
            <ApiKeyStep
              settings={settings}
              onSaved={(data) => saved(data)}
              onContinue={() => {
                void navigate(onboardingPath("optional"));
              }}
            />
          )}
          {step === "optional" && (
            <OptionalSettings
              settings={settings}
              onSaved={(data) => saved(data)}
            />
          )}
          {step === "check" && (
            <ReadinessCheck
              settings={settings}
              instanceId={instanceId}
              onReload={onReload}
            />
          )}
          <footer className="flex flex-wrap items-center gap-2">
            {index > 0 && (
              <Link
                className={buttonVariants({ variant: "outline" })}
                to={onboardingPath(onboardingSteps[index - 1]!.id)}
              >
                上一步
              </Link>
            )}
            {instanceId && (
              <>
                <Link
                  to="/"
                  state={deferredState}
                  className={buttonVariants({ variant: "ghost" })}
                >
                  稍后配置
                </Link>
                <Link
                  to="/settings"
                  state={deferredState}
                  className={buttonVariants({ variant: "ghost" })}
                >
                  切换到常规设置
                </Link>
              </>
            )}
          </footer>
        </div>
      </TabsContent>
    </Tabs>
  );
}
function ApiKeyStep({
  settings,
  onSaved,
  onContinue,
}: {
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings) => void;
  onContinue: () => void;
}) {
  const [generate, setGenerate] = useState(false);
  const [reveal, setReveal] = useState(false);
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            网站接入凭据
          </CardTitle>
          <CardDescription>API 客户端 ID：default</CardDescription>
        </CardHeader>
        <CardContent>
          {settings.completion.api ? (
            <Button variant="outline" onClick={() => setReveal(true)}>
              查看密钥
            </Button>
          ) : (
            <Button onClick={() => setGenerate(true)}>生成 API 密钥</Button>
          )}
        </CardContent>
      </Card>
      <div className="flex justify-end">
        <Button disabled={!settings.completion.api} onClick={onContinue}>
          下一步
        </Button>
      </div>
      {generate && (
        <RotateKeyDialog
          settings={settings}
          onSaved={onSaved}
          onClose={() => setGenerate(false)}
          onStored={onContinue}
        />
      )}
      {reveal && (
        <SecretDialog
          name="api_secret"
          title="网站 API 密钥"
          onClose={() => setReveal(false)}
        />
      )}
    </>
  );
}
function OptionalSettings({
  settings,
  onSaved,
}: {
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings) => void;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <>
      <SettingsEditor
        key="notifications"
        section="notifications"
        settings={settings}
        guided
        submitLabel="保存通知"
        onSaved={onSaved}
        secondaryAction={
          settings.notifications.enabled && (
            <Button variant="outline" onClick={() => setReveal(true)}>
              查看签名密钥
            </Button>
          )
        }
      />
      <SettingsEditor
        key="backup"
        section="backup"
        settings={settings}
        guided
        submitLabel="保存备份"
        onSaved={onSaved}
      />
      <div className="flex justify-end">
        <Link className={buttonVariants()} to={onboardingPath("check")}>
          继续
        </Link>
      </div>
      {reveal && (
        <SecretDialog
          name="webhook_secret"
          title="通知签名密钥"
          onClose={() => setReveal(false)}
        />
      )}
    </>
  );
}
export function ReadinessCheck({
  settings,
  instanceId,
  onReload,
}: {
  settings: RuntimeSettings;
  instanceId: string | null;
  onReload: () => void;
}) {
  const view = useVisibleCheck();
  const query = useQuery({
    queryKey: [
      "onboarding",
      "readiness",
      instanceId,
      settings.revision,
      settings.payment_revision,
      view.epoch,
    ],
    queryFn: ({ signal }) =>
      result(api.getAdministratorSystemStatus({ signal })),
    enabled: view.active && instanceId !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: view.active ? 5000 : false,
    refetchIntervalInBackground: false,
  });
  const status = query.data?.data;
  const fresh =
    view.active &&
    query.isFetchedAfterMount &&
    !query.isFetching &&
    !query.isError &&
    !query.isPaused &&
    status?.instance_id === instanceId;
  const matches =
    status?.settings_revision === settings.revision &&
    status?.payment_revision === settings.payment_revision;
  const ready = Boolean(
    fresh &&
    matches &&
    settings.completion.complete &&
    status?.configured &&
    status.database.ok &&
    status.ledger.collection_ready &&
    status.reconciliation.confirmation_ready &&
    status.status !== "not_ready",
  );
  const missingConfiguration = [
    [settings.completion.application_key, "应用密钥"],
    [settings.completion.provider, "支付宝接入"],
    [settings.completion.collection, "经营码"],
    [settings.completion.api, "API 密钥"],
  ]
    .filter(([complete]) => !complete)
    .map(([, name]) => name)
    .join("、");
  function health(value: boolean | undefined, pending: string) {
    return fresh && matches ? (value ? "已通过" : pending) : "待检查";
  }

  const checks = [
    {
      title: "核心配置",
      status: health(
        settings.completion.complete && status?.configured,
        missingConfiguration ? "尚缺：" + missingConfiguration : "配置正在应用",
      ),
      action:
        fresh &&
        matches &&
        (!settings.completion.complete || !status?.configured) ? (
          <Link
            className={buttonVariants({ variant: "outline", size: "sm" })}
            to={onboardingPath(
              nextRequiredStep(settings) === "check"
                ? "provider"
                : nextRequiredStep(settings),
            )}
          >
            查看配置
          </Link>
        ) : null,
      error: null,
    },
    {
      title: "数据库",
      status: health(status?.database.ok, "数据库暂不可用"),
      action: null,
      error: null,
    },
    {
      title: "账本采集",
      status: health(status?.ledger.collection_ready, "等待成功采集"),
      action:
        fresh && matches && !status?.ledger.collection_ready ? (
          <Link
            className={buttonVariants({ variant: "outline", size: "sm" })}
            to={onboardingPath("provider")}
          >
            检查支付宝接入
          </Link>
        ) : null,
      error: fresh && matches ? status?.ledger.last_error_code : null,
    },
    {
      title: "自动确认",
      status: health(
        status?.reconciliation.confirmation_ready,
        "等待自动确认就绪",
      ),
      action: null,
      error: fresh && matches ? status?.reconciliation.last_error_code : null,
    },
  ];
  return (
    <>
      {!view.active && <p role="status">检查已暂停</p>}
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
      {fresh && !matches && (
        <Alert>
          <CircleAlert />
          <AlertTitle>配置已变化</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={onReload}>
              刷新配置
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {ready && (
        <Alert>
          <CircleCheck />
          <AlertTitle>
            {status?.status === "degraded"
              ? "可以收款，仍有事项待处理。"
              : "收款已就绪。"}
          </AlertTitle>
        </Alert>
      )}
      <ItemGroup>
        {checks.map((check) => (
          <Item key={check.title} variant="outline">
            <ItemContent>
              <ItemTitle>{check.title}</ItemTitle>
              {check.status !== "已通过" && (
                <ItemDescription role="status">{check.status}</ItemDescription>
              )}
              {check.error && (
                <p className="text-sm text-destructive">
                  最近错误：{check.error}
                </p>
              )}
            </ItemContent>
            <ItemActions>
              {check.status === "已通过" && (
                <Badge variant="outline" role="status">
                  <Check data-icon="inline-start" />
                  已通过
                </Badge>
              )}
              {check.action}
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      <div className="flex flex-wrap items-center gap-2">
        {ready && (
          <>
            <Link className={buttonVariants()} to="/">
              进入控制台
            </Link>
            <Link
              className={buttonVariants({ variant: "outline" })}
              to="/test-payment"
            >
              小额真实测试
            </Link>
          </>
        )}
        <Button
          variant="outline"
          disabled={!view.active || query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          {query.isFetching && (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          )}
          刷新
        </Button>
        {(!ready || status?.status === "degraded") && (
          <Link className={buttonVariants({ variant: "ghost" })} to="/system">
            运行状态
          </Link>
        )}
      </div>
      {!settings.notifications.enabled && (
        <p className="text-sm text-muted-foreground">
          业务通知未启用，网站需主动查单。
        </p>
      )}
    </>
  );
}
