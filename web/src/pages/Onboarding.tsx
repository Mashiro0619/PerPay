import { PageHeaderActions } from "@/components/page-header-actions";
import { useSystemName } from "@/branding";
import { TestPaymentButton } from "@/components/test-payment-provider";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useIsFetching, useQuery } from "@tanstack/react-query";
import {
  BookOpen,
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
import { ApplicationKeyActivation } from "@/components/ApplicationKey";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { useDraftGuard } from "@/drafts";
import {
  nextRequiredStep,
  onboardingPath,
  onboardingSteps,
  onboardingRuntimeWarnings,
  resolveOnboardingStep,
  type OnboardingStep,
} from "@/lib/onboarding";
import {
  alipayApplicationUrl,
  applicationKeyState,
} from "@/lib/application-key";
import { useVisibleCheck } from "@/lib/use-visible-check";
import { Link, useNavigate } from "@/navigation";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { OnboardingSteps } from "@/components/onboarding-steps";
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
import { NotificationKeyActions } from "./SecuritySettings";
export default function Onboarding() {
  const [editorVersion, setEditorVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [activationLocked, setActivationLocked] = useState(false);
  const readinessFetching =
    useIsFetching({ queryKey: ["onboarding", "readiness"] }) > 0;
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
      void Promise.all([settings.refetch(), instance.refetch()]).then(
        ([response]) => {
          if (!response.isError) setEditorVersion((value) => value + 1);
          setRefreshing(false);
        },
        () => setRefreshing(false),
      );
    });
  }

  return (
    <div
      className="@container/onboarding flex w-full min-w-0 flex-col gap-5"
      data-onboarding-workspace
    >
      <PageHeaderActions>
        <a
          className={buttonVariants({ variant: "ghost", size: "sm" })}
          href="https://github.com/Mashiro0619/PerPay/blob/main/docs/alipay-setup.md"
          target="_blank"
          rel="noreferrer"
          aria-label="图文教程"
          title="图文教程"
        >
          <BookOpen data-icon="inline-start" />
          <span className="hidden sm:inline">图文教程</span>
        </a>
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新"
          title="刷新"
          disabled={
            refreshing ||
            settings.isFetching ||
            instance.isFetching ||
            readinessFetching ||
            activationLocked
          }
          onClick={reload}
        >
          {refreshing ||
          settings.isFetching ||
          instance.isFetching ||
          readinessFetching ? (
            <Spinner aria-hidden="true" />
          ) : (
            <RefreshCw />
          )}
        </Button>
      </PageHeaderActions>
      <p className="text-sm text-muted-foreground">
        按步骤完成收款配置，已有配置可直接复用。
      </p>
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
              onActivationLockChange={setActivationLocked}
            />
          </div>
        )}
      </QueryView>
    </div>
  );
}
function OnboardingFlow({
  settings,
  instanceId,
  onReload,
  onActivationLockChange,
}: {
  settings: RuntimeSettings;
  instanceId: string | null;
  onReload: () => void;
  onActivationLockChange: (locked: boolean) => void;
}) {
  const systemName = useSystemName();
  const { step: requested } = useParams();
  const step = resolveOnboardingStep(settings, requested);
  const pendingApplicationKey = settings.pending_application_key;
  const [success, setSuccess] = useFeedback();
  const index = onboardingSteps.findIndex((item) => item.id === step);
  const firstMissing = onboardingSteps.findIndex(
    (item) => item.id === nextRequiredStep(settings),
  );
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [requested, step]);
  const deferredState = { deferOnboardingFor: instanceId };
  function saved(
    data: RuntimeSettings,
    next?: OnboardingStep,
    message?: string,
  ) {
    if (message) setSuccess(message);
    queryClient.setQueryData(["settings"], { data });
    void refreshOperationalData();
    if (next) void navigate(onboardingPath(next));
  }
  if (requested === "api") return <Navigate to="/settings/security" replace />;
  if (requested !== step) return <Navigate to={onboardingPath(step)} replace />;
  const completed = [
    settings.completion.application_key,
    settings.completion.provider && !pendingApplicationKey,
    settings.completion.collection,
  ];
  const renderActions = (actions: ReactNode) => (
    <OnboardingFooter
      index={index}
      instanceId={instanceId}
      complete={settings.completion.complete}
    >
      {actions}
    </OnboardingFooter>
  );
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <OnboardingSteps
        current={step}
        completed={completed}
        firstMissing={firstMissing}
      />
      <section
        aria-labelledby="onboarding-step-heading"
        className="min-w-0 text-sm"
      >
        <div className="flex min-w-0 flex-col gap-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <h2
                id="onboarding-step-heading"
                tabIndex={-1}
                ref={heading}
                className="text-xl font-semibold outline-none"
              >
                {onboardingSteps[index]!.title}
              </h2>
            </div>
          </header>
          <SuccessMessage message={success} multiline />
          {pendingApplicationKey && index > 1 && (
            <Alert role="status" data-onboarding-pending-key-warning>
              <CircleAlert />
              <AlertTitle>新应用公钥尚未启用</AlertTitle>
              <AlertDescription className="min-w-0">
                {systemName}{" "}
                当前仍使用原密钥，其他配置可以继续修改。若已在支付宝上传新公钥，请尽快完成验证启用，避免影响账本采集。
              </AlertDescription>
              <div className="col-start-2 flex flex-wrap gap-2 pt-2">
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  to={onboardingPath("provider")}
                >
                  前往验证启用
                </Link>
              </div>
            </Alert>
          )}
          {step === "application" && (
            <OnboardingStepLayout
              help={
                <OnboardingHelp title="公钥与私钥">
                  <p>应用公钥和应用私钥是一对，合称“应用密钥对”。</p>
                  <p>应用公钥：复制到支付宝的接口加签设置。</p>
                  <p>
                    应用私钥：由 {systemName}{" "}
                    加密保存，用于向支付宝发送签名请求。
                  </p>
                  <p>
                    {pendingApplicationKey
                      ? `支付宝公钥：上传新应用公钥后，从支付宝重新复制，下一步填入 ${systemName}。`
                      : `支付宝公钥：上传应用公钥后，从支付宝复制，下一步填入 ${systemName}。`}
                  </p>
                  <Collapsible>
                    <CollapsibleTrigger
                      render={<Button variant="ghost" size="sm" />}
                    >
                      <ChevronDown data-icon="inline-start" />
                      接入前准备
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ul className="flex list-inside list-disc flex-col gap-2 pt-3">
                        <li>使用收款账户创建“网页应用”。</li>
                        <li>账号默认拥有账务明细查询权限。</li>
                        <li>支付宝搜索“经营码”申请，使用同一账户收款。</li>
                      </ul>
                    </CollapsibleContent>
                  </Collapsible>
                  {applicationKeyState(settings) === "missing" && (
                    <>
                      <p>若已有应用私钥，请先导入，不要先生成新的密钥对。</p>
                      <Link
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                        to="/settings/provider"
                        state={deferredState}
                      >
                        导入已有应用私钥
                      </Link>
                    </>
                  )}
                </OnboardingHelp>
              }
            >
              <ApplicationKey
                settings={settings}
                guided
                onSaved={(data) => saved(data)}
              />
              {renderActions(
                <Button
                  disabled={!settings.completion.application_key}
                  onClick={() => {
                    void navigate(onboardingPath("provider"));
                  }}
                >
                  下一步
                </Button>,
              )}
            </OnboardingStepLayout>
          )}
          {step === "provider" && (
            <OnboardingStepLayout
              help={
                <OnboardingHelp
                  title={
                    pendingApplicationKey
                      ? "填回支付宝公钥"
                      : "在支付宝完成的操作"
                  }
                >
                  <p>
                    在{" "}
                    <a
                      className="underline underline-offset-4"
                      href={alipayApplicationUrl(
                        pendingApplicationKey?.app_id ??
                          settings.provider?.app_id,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      支付宝应用管理
                    </a>{" "}
                    {pendingApplicationKey
                      ? "上传新的待启用应用公钥，选择密钥加签。"
                      : "上传应用公钥，选择密钥加签。"}
                  </p>
                  {pendingApplicationKey ? (
                    <>
                      <p>
                        待启用公钥对应应用{" "}
                        <span className="break-all">
                          {pendingApplicationKey.app_id}
                        </span>
                        （
                        {pendingApplicationKey.environment === "PRODUCTION"
                          ? "生产环境"
                          : "沙箱环境"}
                        ）。 {systemName} 当前仍使用原密钥。
                      </p>
                      <p>
                        上传完成后，将支付宝页面显示的支付宝公钥填入本页表单。
                        点击“验证并启用后继续”，通过验证后即可进入下一步。
                      </p>
                    </>
                  ) : (
                    <p>
                      将同一应用的 App ID
                      和支付宝公钥填入表单。生产收款使用生产环境；采集参数可保留当前值。
                    </p>
                  )}
                  {(pendingApplicationKey?.public_key ||
                    settings.application_public_key) && (
                    <Collapsible>
                      <CollapsibleTrigger
                        render={<Button variant="outline" size="sm" />}
                      >
                        {pendingApplicationKey
                          ? "查看待启用应用公钥"
                          : "查看应用公钥"}
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="pt-3">
                          <CopyValue
                            value={
                              pendingApplicationKey?.public_key ??
                              settings.application_public_key!
                            }
                            label={
                              pendingApplicationKey
                                ? "复制待启用应用公钥"
                                : "复制应用公钥"
                            }
                          />
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </OnboardingHelp>
              }
            >
              {pendingApplicationKey ? (
                <ApplicationKeyActivation
                  key={pendingApplicationKey.change_id}
                  settings={settings}
                  renderActions={(actions) =>
                    renderActions(
                      <>
                        <Link
                          className={buttonVariants({ variant: "ghost" })}
                          to={onboardingPath("collection")}
                        >
                          暂不启用，继续配置
                        </Link>
                        {actions}
                      </>,
                    )
                  }
                  onReload={onReload}
                  onLockChange={onActivationLockChange}
                  onSaved={(data, message) => saved(data, undefined, message)}
                  onContinue={() => {
                    void navigate(onboardingPath("collection"));
                  }}
                />
              ) : (
                <SettingsEditor
                  key="provider"
                  section="provider"
                  settings={settings}
                  guided
                  submitLabel="保存并继续"
                  renderGuidedActions={renderActions}
                  onSaved={(data) => saved(data, "collection")}
                />
              )}
            </OnboardingStepLayout>
          )}
          {step === "collection" && (
            <OnboardingStepLayout
              help={
                <OnboardingHelp title="确认收款账户与金额规则">
                  <p>
                    经营码应属于已接入的支付宝账户。上传图片后先核对识别内容，也可直接粘贴经营码内容。
                  </p>
                  <p>
                    金额尾差用于区分订单。付款人需要按收银台显示的应付金额付款。
                  </p>
                  <p>
                    金额复用冷却不会延长订单有效期，已有订单继续使用创建时的配置。
                  </p>
                </OnboardingHelp>
              }
            >
              <SettingsEditor
                key="collection"
                section="collection"
                settings={settings}
                guided
                submitLabel="保存并继续"
                renderGuidedActions={renderActions}
                onSaved={(data) => saved(data, "optional")}
              />
            </OnboardingStepLayout>
          )}
          {step === "optional" && (
            <OptionalSettings
              settings={settings}
              onSaved={(data) => saved(data)}
              renderActions={renderActions}
            />
          )}
          {step === "check" && (
            <ReadinessCheck
              settings={settings}
              instanceId={instanceId}
              onReload={onReload}
              renderActions={renderActions}
              showRefresh={false}
            />
          )}
        </div>
      </section>
    </div>
  );
}
function OnboardingStepLayout({
  children,
  help,
}: {
  children: ReactNode;
  help: ReactNode;
}) {
  return (
    <div
      className="grid min-w-0 items-start gap-5 @5xl/onboarding:grid-cols-[minmax(0,1fr)_18rem]"
      data-onboarding-step-layout
    >
      <div className="flex min-w-0 flex-col gap-5" data-onboarding-main>
        {children}
      </div>
      <aside className="min-w-0" aria-label="本步说明">
        {help}
      </aside>
    </div>
  );
}
function OnboardingHelp({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3 text-sm text-muted-foreground">
          {children}
        </div>
      </CardContent>
    </Card>
  );
}
function OnboardingFooter({
  index,
  instanceId,
  complete,
  children,
}: {
  index: number;
  instanceId: string | null;
  complete: boolean;
  children: ReactNode;
}) {
  const deferredState = { deferOnboardingFor: instanceId };
  return (
    <footer className="flex min-w-0 flex-col gap-3" data-onboarding-actions>
      <Separator />
      <div
        className="flex min-w-0 flex-wrap items-start justify-between gap-3"
        data-onboarding-primary-actions
      >
        {index > 0 && (
          <Link
            className={buttonVariants({ variant: "outline" })}
            to={onboardingPath(onboardingSteps[index - 1]!.id)}
          >
            上一步
          </Link>
        )}
        <div
          className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2"
          data-onboarding-next
        >
          {children}
        </div>
      </div>
      {instanceId && index < onboardingSteps.length - 1 && (
        <div className="flex flex-wrap items-center gap-2">
          {!complete && (
            <Link
              to="/"
              state={deferredState}
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              稍后配置
            </Link>
          )}
          <Link
            to="/settings"
            state={deferredState}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            切换到常规设置
          </Link>
        </div>
      )}
    </footer>
  );
}
function OptionalSettings({
  settings,
  onSaved,
  renderActions,
}: {
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings) => void;
  renderActions: (actions: ReactNode) => ReactNode;
}) {
  return (
    <>
      <div
        className="grid min-w-0 items-start gap-5 @3xl/onboarding:grid-cols-2"
        data-onboarding-optional
      >
        <section
          className="flex min-w-0 flex-col gap-3"
          aria-labelledby="onboarding-notifications-title"
        >
          <h3 id="onboarding-notifications-title" className="font-medium">
            业务通知（可选）
          </h3>
          <SettingsEditor
            key="notifications"
            section="notifications"
            settings={settings}
            guided
            submitLabel="保存通知"
            onSaved={onSaved}
            secondaryAction={
              <NotificationKeyActions settings={settings} onSaved={onSaved} />
            }
          />
        </section>
        <section
          className="flex min-w-0 flex-col gap-3"
          aria-labelledby="onboarding-backup-title"
        >
          <h3 id="onboarding-backup-title" className="font-medium">
            自动备份（可选）
          </h3>
          <SettingsEditor
            key="backup"
            section="backup"
            settings={settings}
            guided
            submitLabel="保存备份"
            onSaved={onSaved}
          />
        </section>
      </div>
      {renderActions(
        <Link className={buttonVariants()} to={onboardingPath("check")}>
          继续
        </Link>,
      )}
    </>
  );
}
export function ReadinessCheck({
  settings,
  instanceId,
  onReload,
  renderActions,
  showRefresh = true,
}: {
  settings: RuntimeSettings;
  instanceId: string | null;
  onReload: () => void;
  renderActions?: (actions: ReactNode) => ReactNode;
  /** The full wizard refreshes settings and remounts this check from its header. */
  showRefresh?: boolean;
}) {
  const systemName = useSystemName();
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
    [settings.completion.application_key, "应用公钥"],
    [settings.completion.provider, "支付宝接入"],
    [settings.completion.collection, "经营码"],
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
      error: fresh && matches && !ready ? status?.ledger.last_error_code : null,
    },
    {
      title: "自动确认",
      status: health(
        status?.reconciliation.confirmation_ready,
        "等待自动确认就绪",
      ),
      action: null,
      error:
        fresh && matches && !ready
          ? status?.reconciliation.last_error_code
          : null,
    },
  ];
  const runtimeWarnings =
    ready && status ? onboardingRuntimeWarnings(status) : [];
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {ready && (
        <>
          <Link className={buttonVariants()} to="/">
            进入控制台
          </Link>
          <TestPaymentButton>小额真实测试</TestPaymentButton>
          <Link
            className={buttonVariants({ variant: "outline" })}
            to="/settings/security"
          >
            获取接入凭证
          </Link>
        </>
      )}
      {showRefresh && (
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
      )}
      {!ready && (
        <Link className={buttonVariants({ variant: "ghost" })} to="/system">
          运行状态
        </Link>
      )}
    </div>
  );
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
        <Alert role="status" data-onboarding-ready>
          <CircleCheck />
          <AlertTitle>收款服务就绪</AlertTitle>
          <AlertDescription>
            业务网站仍需配置接入凭证并完成通知或查单联调。
          </AlertDescription>
        </Alert>
      )}
      <ItemGroup className="grid min-w-0 grid-cols-1 gap-3 @3xl/onboarding:grid-cols-2">
        {checks.map((check) => (
          <Item key={check.title} variant="outline" className="min-w-0">
            <ItemContent className="min-w-0">
              <ItemTitle>{check.title}</ItemTitle>
              {check.status !== "已通过" && (
                <ItemDescription role="status">{check.status}</ItemDescription>
              )}
              {check.error && (
                <p className="break-words text-sm text-destructive">
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
      {runtimeWarnings.length > 0 && (
        <Alert role="status" data-onboarding-runtime-warnings>
          <CircleAlert />
          <AlertTitle>运行提醒（不是配置缺项）</AlertTitle>
          <AlertDescription className="min-w-0">
            <ul className="flex list-inside list-disc flex-col gap-1 break-words">
              {runtimeWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
          <div className="col-start-2 flex pt-2">
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              to="/system"
            >
              查看运行状态
            </Link>
          </div>
        </Alert>
      )}
      {!settings.notifications.enabled && (
        <p className="text-sm text-muted-foreground">
          业务通知未启用（可选），不影响收款；业务系统后端需主动向 {systemName}{" "}
          查询订单状态。
        </p>
      )}
      {renderActions ? renderActions(actions) : actions}
    </>
  );
}
