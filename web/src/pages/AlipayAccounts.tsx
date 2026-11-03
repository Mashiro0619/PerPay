import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "react-router";
import { ChevronDown, KeyRound, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { api, ApiError, queryClient, result } from "@/api/client";
import { useDirtyDraft } from "@/drafts";
import { Link, useNavigate } from "@/navigation";
import {
  accountHealth,
  accountSaved,
  accountState,
  alipayAccountKey,
  alipayAccountsKey,
  alipayAccountsQuery,
  type AlipayAccount,
} from "@/lib/alipay-accounts";
import { alipayApplicationUrl } from "@/lib/application-key";
import { cn } from "@/lib/utils";
import { dateTime } from "@/lib/format";
import { PageHeading } from "@/components/page-heading";
import { BusinessTable, type BusinessColumn } from "@/components/business-table";
import { OverlayActions } from "@/components/overlay-actions";
import { ScrollingTabs } from "@/components/scrolling-tabs";
import { useOverlayCloseGuard, useOverlayContext } from "@/lib/overlay-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CollectionCodeField } from "@/components/CollectionCodeField";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldContent,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/admin-dialog";

export default function AlipayAccountsPage() {
  const { accountId } = useParams();
  return (
    <div
      className="admin-settings-layout flex min-w-0 flex-col gap-5"
      data-alipay-accounts
    >
      <PageHeading title="支付宝账号" />
      {accountId ? (
        <AlipayAccountDetail accountId={accountId} />
      ) : (
        <AlipayAccountList />
      )}
    </div>
  );
}

export function AlipayAccountList({ onSelect }: { onSelect?: (id: string) => void }) {
  const accounts = useQuery(alipayAccountsQuery);
  const titleId = useId();
  const addClassName = "h-auto min-h-8 max-w-full whitespace-normal py-1.5";
  const columns: BusinessColumn<AlipayAccount>[] = [
    { id: "name", label: "账号", layout: "identity", hideable: false, cell: account => onSelect
      ? <Button variant="link" className="h-auto justify-start p-0" onClick={() => onSelect(account.id)}>{account.name}</Button>
      : <Link data-row-link to={"/settings/accounts/" + encodeURIComponent(account.id)}>{account.name}</Link> },
    { id: "status", label: "状态", layout: "status", summaryDefault: true, cell: account => <Badge variant={account.enabled && account.configured ? "secondary" : "outline"}>{accountState(account)}</Badge> },
    { id: "health", label: "查账", layout: "status", summaryDefault: true, cell: account => accountHealth(account) },
    { id: "app", label: "App ID", cell: account => account.app_id || "未配置" },
    { id: "sites", label: "用于网站", layout: "number", cell: account => account.sites.length ? <span title={account.sites.map(site => site.name).join("、")}>{account.sites.length} 个网站</span> : "未分配" },
    { id: "actions", label: "操作", layout: "actions", hideable: false, cell: account => onSelect
      ? <Button variant="outline" size="sm" onClick={() => onSelect(account.id)}>配置</Button>
      : <Link to={"/settings/accounts/" + encodeURIComponent(account.id)} className={buttonVariants({ variant: "outline", size: "sm" })} aria-label={"配置" + account.name}>配置</Link> },
  ];
  return <Card size="sm" className="min-w-0" data-account-list aria-labelledby={titleId}>
    <CardHeader className="min-w-0">
      <CardTitle id={titleId} role="heading" aria-level={2}>支付宝账号</CardTitle>
      <CardDescription>每个账号分别保存收款码和开放平台应用信息，再分配给业务网站。</CardDescription>
      <CardAction className="max-w-full">
        {onSelect ? <Button size="sm" className={addClassName} onClick={() => onSelect("new")}><Plus data-icon="inline-start" /><span className="min-w-0">添加支付宝账号</span></Button> : <Link to="/settings/accounts/new" className={cn(buttonVariants({ size: "sm" }), addClassName)}><Plus data-icon="inline-start" /><span className="min-w-0">添加支付宝账号</span></Link>}
      </CardAction>
    </CardHeader>
    <CardContent>
      <QueryView query={accounts}>{({ data }) => data.length ? <BusinessTable id="alipay-accounts" items={data} columns={columns} rowId={account => account.id} density="compact" columnsMenu={false} aria-label="支付宝账号列表" /> : <Empty><EmptyHeader><EmptyTitle>还没有支付宝账号</EmptyTitle><EmptyDescription>先添加一个账号，完成应用密钥、开放平台信息和收款码配置。</EmptyDescription></EmptyHeader></Empty>}</QueryView>
    </CardContent>
  </Card>;
}

export function AlipayAccountDetail({
  accountId,
  onSaved,
  onBack,
}: {
  accountId: string;
  onSaved?: (account: AlipayAccount) => void;
  onBack?: () => void;
}) {
  const account = useQuery({
    queryKey: alipayAccountKey(accountId),
    queryFn: async ({ signal }): Promise<{ data: AlipayAccount }> =>
      result(api.getAlipayAccount({ path: { accountId }, signal })),
    enabled: accountId !== "new",
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  return accountId === "new" ? (
    <AlipayAccountEditor
      key="new"
      initial={null}
      onSaved={onSaved}
      onBack={onBack}
    />
  ) : (
    <QueryView query={account}>
      {({ data }) => (
        <AlipayAccountEditor
          key={data.id}
          initial={data}
          onSaved={onSaved}
          onBack={onBack}
        />
      )}
    </QueryView>
  );
}

function accountConfiguration(account: AlipayAccount | null) {
  return {
    name: account?.name ?? "",
    enabled: account?.enabled ?? true,
    code_payload: account?.code_payload ?? "",
    app_id: account?.app_id ?? "",
    platform_public_key: account?.platform_public_key ?? "",
  };
}

const accountSections = [["basic", "基本信息"], ["application", "应用信息"], ["collection", "收款码"], ["keys", "应用密钥"], ["usage", "使用情况"]] as const;
function AccountPanel({ tabbed, value, children }: { tabbed: boolean; value: string; children: ReactNode }) {
  return tabbed ? <TabsContent value={value} keepMounted data-account-panel={value}><FieldGroup>{children}</FieldGroup></TabsContent> : <>{children}</>;
}
function AccountFormFooter({ tabbed, children }: { tabbed: boolean; children: ReactNode }) {
  return tabbed ? <>{children}</> : <CardFooter className="flex flex-wrap gap-2">{children}</CardFooter>;
}
function AccountPublicKeyField({ value, title = "应用公钥", copyLabel = "复制应用公钥" }: { value: string; title?: string; copyLabel?: string }) {
  const id = useId();
  return <Field data-account-public-key>
    <FieldLabel htmlFor={id}>{title}</FieldLabel>
    <InputGroup>
      <InputGroupTextarea id={id} value={value} readOnly rows={3} className="settings-long-text min-w-0 resize-none" spellCheck={false} />
      <InputGroupAddon align="inline-end" className="self-start">
        <CopyValue value={value} label={copyLabel} buttonOnly />
      </InputGroupAddon>
    </InputGroup>
    <FieldDescription>复制并上传到对应的支付宝开放平台应用。</FieldDescription>
  </Field>;
}

export function AlipayAccountEditor({
  initial,
  onSaved,
  onBack,
}: {
  initial: AlipayAccount | null;
  onSaved?: (account: AlipayAccount) => void;
  onBack?: () => void;
}) {
  const overlay = useOverlayContext();
  const tabbed = !!overlay && !onBack;
  const formId = useId();
  const [panel, setPanel] = useState(initial?.pending_application_key ? "keys" : "basic");
  const navigate = useNavigate();
  const location = useLocation();
  const navigationFeedback = location.state as {
    savedAccountId?: string;
    checkFailure?: string;
  } | null;
  const [saved, setSaved] = useState(initial);
  const historical = saved?.environment === "SANDBOX";
  const [draft, setDraft] = useState(() => accountConfiguration(initial));
  const [privateKey, setPrivateKey] = useState("");
  const [decoding, setDecoding] = useState(false);
  const [savedMessage, setSavedMessage] = useState(() =>
    navigationFeedback?.savedAccountId === initial?.id ? "账号已保存" : "",
  );
  const [initialCheckFailure, setInitialCheckFailure] = useState(() =>
    navigationFeedback?.savedAccountId === initial?.id
      ? navigationFeedback?.checkFailure
      : undefined,
  );
  const [confirmation, setConfirmation] = useState<
    "delete" | "regenerate" | "discard" | null
  >(null);
  const [activationKey, setActivationKey] = useState("");
  const [keyChangeId, setKeyChangeId] = useState(() => crypto.randomUUID());
  const form = useRef<HTMLFormElement>(null);
  const invalidDraftField = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  const completedNavigation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(accountConfiguration(saved)) ||
    privateKey !== "";
  const showFormActions = !tabbed || (panel !== "keys" && panel !== "usage") || dirty;
  const clear = useDirtyDraft(dirty);
  const clearActivationDraft = useDirtyDraft(activationKey !== "");

  async function accepted(account: AlipayAccount, message: string) {
    if (mounted.current) {
      setSaved(account);
      setDraft(accountConfiguration(account));
      setPrivateKey("");
      setSavedMessage(message);
      clear();
      onSaved?.(account);
    }
    await accountSaved(account);
  }
  const check = useMutation({
    networkMode: "always",
    onMutate: () => { completedNavigation.current = false; setInitialCheckFailure(undefined); },
    mutationFn: (id: string) => {
      if (historical) throw new Error("此账号仅保留历史记录，请添加已上线应用的支付宝账号。");
      return result(api.checkAlipayAccount({ path: { accountId: id }, body: {} }));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: alipayAccountsKey });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
  const save = useMutation({
    networkMode: "always",
    onMutate: () => { completedNavigation.current = false; },
    mutationFn: async (checkAfter: boolean) => {
      if (historical) throw new Error("此账号仅保留历史记录，请添加已上线应用的支付宝账号。");
      const input = {
        ...draft,
        environment: "PRODUCTION" as const,
        name: draft.name.trim(),
        code_payload: draft.code_payload.trim() || null,
        app_id: draft.app_id.trim() || null,
        platform_public_key: draft.platform_public_key.trim() || null,
        ...(privateKey.trim() ? { private_key: privateKey.trim() } : {}),
      };
      const response = saved
        ? await result(
            api.updateAlipayAccount({
              path: { accountId: saved.id },
              body: { ...input, revision: saved.revision },
            }),
          )
        : await result(api.createAlipayAccount({ body: input }));
      return { account: response.data, checkAfter, created: saved === null };
    },
    onSuccess: async ({ account, checkAfter, created }) => {
      await accepted(account, "账号已保存");
      let checkFailure: string | undefined;
      if (checkAfter && mounted.current) {
        try {
          const checked = await check.mutateAsync(account.id);
          queryClient.setQueryData(alipayAccountKey(account.id), {
            data: { ...account, last_check: checked.data },
          });
        } catch (error) {
          checkFailure =
            error instanceof Error ? error.message : "连接检查暂不可用";
        }
      }
      if (created && mounted.current && !onBack) {
        completedNavigation.current = true;
        void navigate("/settings/accounts/" + account.id, {
          replace: true,
          state: { savedAccountId: account.id, checkFailure },
        });
      }
    },
  });
  const key = useMutation({
    networkMode: "always",
    onMutate: () => { completedNavigation.current = false; },
    mutationFn: async (
      action: "generate" | "regenerate" | "activate" | "discard",
    ) => {
      if (!saved) throw new Error("请先保存账号，再生成应用密钥。");
      if (historical && action !== "discard") throw new Error("此账号仅保留历史记录，请添加已上线应用的支付宝账号。");
      const path = { accountId: saved.id };
      if (action === "generate")
        return result(
          api.generateAlipayAccountApplicationKey({
            path,
            body: { revision: saved.revision },
          }),
        );
      if (action === "regenerate")
        return result(
          api.regenerateAlipayAccountApplicationKey({
            path,
            body: {
              revision: saved.revision,
              change_id: keyChangeId,
              base_fingerprint: saved.application_key_fingerprint!,
            },
          }),
        );
      const pending = saved.pending_application_key;
      if (!pending) throw new Error("没有待启用的应用密钥。");
      const body = { revision: saved.revision, change_id: pending.change_id };
      return action === "activate"
        ? result(
            api.activateAlipayAccountApplicationKey({
              path,
              body: { ...body, platform_public_key: activationKey.trim() },
            }),
          )
        : result(api.discardAlipayAccountApplicationKey({ path, body }));
    },
    onSuccess: async ({ data }, action) => {
      setConfirmation(null);
      setActivationKey("");
      clearActivationDraft();
      if (action === "discard" || action === "activate")
        setKeyChangeId(crypto.randomUUID());
      await accepted(
        data,
        action === "activate"
          ? "新应用密钥已启用"
          : action === "discard"
            ? "已放弃待启用密钥"
            : "应用密钥已保存，请把应用公钥上传到支付宝",
      );
    },
  });
  const remove = useMutation({
    networkMode: "always",
    onMutate: () => { completedNavigation.current = false; },
    mutationFn: () =>
      result(
        api.deleteAlipayAccount({
          path: { accountId: saved!.id },
          body: { revision: saved!.revision },
        }),
      ),
    onSuccess: () => {
      clear();
      clearActivationDraft();
      completedNavigation.current = true;
      queryClient.removeQueries({ queryKey: alipayAccountKey(saved!.id) });
      void queryClient.invalidateQueries({ queryKey: alipayAccountsKey });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (onBack) onBack();
      else void navigate("/settings/accounts");
    },
  });
  const busy =
    save.isPending || key.isPending || remove.isPending || check.isPending;
  // A confirmed create/delete may navigate before React Query clears isPending.
  useOverlayCloseGuard(() => decoding || (busy && !completedNavigation.current));
  const errors = save.error instanceof ApiError ? save.error.fields : {};
  useEffect(() => {
    if (save.isPending || !save.error) return;
    const invalid = form.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"]',
    );
    if (!invalid) return;
    const nextPanel = invalid.closest<HTMLElement>("[data-account-panel]")?.dataset.accountPanel;
    if (tabbed && nextPanel && nextPanel !== panel) setPanel(nextPanel);
    requestAnimationFrame(() => { if (invalid.isConnected) invalid.focus(); });
  }, [save.error, save.isPending, panel, tabbed]);
  function change<T extends keyof typeof draft>(
    field: T,
    value: (typeof draft)[T],
  ) {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setSavedMessage("");
    save.reset();
    check.reset();
    setInitialCheckFailure(undefined);
  }
  function saveDraft() {
    const owningForm = form.current;
    if (!owningForm) return;
    if (!owningForm.reportValidity()) {
      invalidDraftField.current = owningForm.querySelector<HTMLElement>(
        "input:invalid, textarea:invalid, select:invalid",
      );
      return;
    }
    check.reset();
    save.mutate(false);
  }
  const error = save.error || key.error || remove.error;
  const pending = saved?.pending_application_key;
  const checkResult = historical ? null : check.data?.data ?? (!dirty ? saved?.last_check : null);
  const checkFailure = historical ? undefined : check.error?.message ?? initialCheckFailure;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-alipay-account-editor>
      <Tabs value={panel} onValueChange={value => { if (value) setPanel(value); }} className="min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">
          {saved?.name ?? "添加支付宝账号"}
        </h2>
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            返回账号列表
          </Button>
        ) : !overlay ? (
          <Link
            to="/settings/accounts"
            className={buttonVariants({ variant: "ghost" })}
          >
            返回账号列表
          </Link>
        ) : null}
      </div>
      {tabbed && <ScrollingTabs><TabsList aria-label="支付宝账号配置分组" variant="line" activateOnFocus={false} className="min-w-max">
        {accountSections.map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}
      </TabsList></ScrollingTabs>}
      <ErrorNotice error={error} />
      {historical && (
        <Alert>
          <AlertTitle>旧版测试账号已停用</AlertTitle>
          <AlertDescription>
            <p>历史记录仍可查看。请添加状态为“已上线”的支付宝应用账号用于收款和查账。</p>
            <Link to="/settings/accounts/new">添加支付宝账号</Link>
          </AlertDescription>
        </Alert>
      )}
      {savedMessage && (
        <Alert role="status">
          <AlertTitle>{savedMessage}</AlertTitle>
          {!saved?.configured && (
            <AlertDescription>
              配置尚未完成，此账号暂不参与新订单分配。可以稍后继续填写。
            </AlertDescription>
          )}
        </Alert>
      )}
      {(checkResult || checkFailure || check.isPending) && (
        <Alert
          role="status"
          variant={
            checkFailure || checkResult?.ok === false
              ? "destructive"
              : "default"
          }
        >
          <AlertTitle>
            {check.isPending
              ? "正在检查查账连接…"
              : checkFailure || checkResult?.ok === false
                ? "连接检查未通过"
                : "连接检查通过"}
          </AlertTitle>
          <AlertDescription>
            {checkFailure ?? checkResult?.message}
            {(checkFailure || checkResult?.ok === false) && (
              <p>账号配置已保留。修正应用信息后保存，或直接重试检查。</p>
            )}
          </AlertDescription>
        </Alert>
      )}
      <form
        id={formId}
        ref={form}
        onInvalidCapture={event => {
          if (!tabbed || !(event.target instanceof HTMLElement)) return;
          const nextPanel = event.target.closest<HTMLElement>("[data-account-panel]")?.dataset.accountPanel;
          if (nextPanel && nextPanel !== panel) {
            event.preventDefault(); setPanel(nextPanel);
            const field = event.target; requestAnimationFrame(() => { if (field.isConnected) field.focus(); });
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !decoding && !historical) {
            check.reset();
            save.mutate(true);
          }
        }}
      >
        <FieldSet disabled={busy || historical}>
          <Card className={tabbed && (panel === "keys" || panel === "usage") ? "hidden" : undefined}>
            <CardHeader hidden={tabbed && panel !== "basic"}>
              <CardTitle>账号信息</CardTitle>
              <CardDescription>
                收款码、App ID
                和密钥应属于同一个支付宝收款账号。经营码也可以使用。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <AccountPanel tabbed={tabbed} value="basic">
                <FieldGroup>
                <Field data-invalid={!!errors.name}>
                  <FieldLabel htmlFor="alipay-name">账号名称</FieldLabel>
                  <Input
                    id="alipay-name"
                    name="name"
                    value={draft.name}
                    onChange={(event) =>
                      change("name", event.currentTarget.value)
                    }
                    required
                    maxLength={80}
                    placeholder="例如：主收款账号"
                    aria-invalid={!!errors.name}
                  />
                  {errors.name && <FieldError>{errors.name}</FieldError>}
                </Field>
                <Field orientation="horizontal">
                  <FieldContent className="min-w-0">
                    <FieldLabel htmlFor="alipay-enabled">接收新订单</FieldLabel>
                    <FieldDescription>
                      暂停只影响新订单，已有订单继续查账。
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="alipay-enabled"
                    checked={draft.enabled}
                    onCheckedChange={(value) => change("enabled", value)}
                  />
                </Field>
                </FieldGroup>
                </AccountPanel>
                <AccountPanel tabbed={tabbed} value="application">
                <FieldSet>
                  <FieldLegend>开放平台应用</FieldLegend>
                  <FieldDescription>
                    请使用状态为“已上线”的支付宝应用；“开发中”的应用无法查账。
                  </FieldDescription>
                  <Field data-invalid={!!errors.app_id}>
                    <FieldLabel htmlFor="alipay-app-id">
                      应用 ID（App ID）
                    </FieldLabel>
                    <Input
                      id="alipay-app-id"
                      name="app_id"
                      value={draft.app_id}
                      maxLength={64}
                      onChange={(event) =>
                        change("app_id", event.currentTarget.value)
                      }
                      autoComplete="off"
                      aria-invalid={!!errors.app_id}
                    />
                    {errors.app_id && <FieldError>{errors.app_id}</FieldError>}
                  </Field>
                  {saved?.application_public_key && !privateKey.trim() ? (
                    <AccountPublicKeyField value={saved.application_public_key} title={pending ? "当前应用公钥" : "应用公钥"} />
                  ) : (
                    <Field>
                      <FieldLabel>应用公钥</FieldLabel>
                      <FieldDescription>
                        {privateKey.trim() ? "保存导入的应用私钥后，这里会显示对应的应用公钥。" : saved ? "尚未生成应用密钥。请在“应用密钥”中由系统生成密钥对，或导入已有应用私钥。" : "先填写账号名称并保存草稿，再在“应用密钥”中由系统生成密钥对。"}
                      </FieldDescription>
                      {tabbed && !privateKey.trim() && <Button type="button" variant="outline" size="sm" className="h-auto min-h-8 max-w-full self-start whitespace-normal py-1.5" onClick={() => setPanel("keys")}>前往应用密钥</Button>}
                    </Field>
                  )}
                  <Field data-invalid={!!errors.platform_public_key}>
                    <FieldLabel htmlFor="alipay-platform-key">
                      支付宝公钥
                    </FieldLabel>
                    <Textarea
                      id="alipay-platform-key"
                      name="platform_public_key"
                      rows={4}
                      className="settings-long-text"
                      value={draft.platform_public_key}
                      onChange={(event) =>
                        change("platform_public_key", event.currentTarget.value)
                      }
                      maxLength={16384}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={!!errors.platform_public_key}
                    />
                    <FieldDescription>
                      上传应用公钥后，将支付宝提供的“支付宝公钥”填到这里。
                    </FieldDescription>
                    {errors.platform_public_key && (
                      <FieldError>{errors.platform_public_key}</FieldError>
                    )}
                  </Field>
                </FieldSet>
                <Collapsible className="flex min-w-0 flex-col gap-2">
                  <CollapsibleTrigger
                    render={<Button type="button" variant="outline" size="sm" className="h-auto min-h-8 max-w-full justify-between whitespace-normal py-1.5" />}
                  >
                    <span className="min-w-0">导入已有应用私钥（可选）</span>
                    <ChevronDown aria-hidden="true" data-icon="inline-end" />
                  </CollapsibleTrigger>
                  <FieldDescription>推荐由系统生成应用密钥；仅使用自己已有的密钥时才需要导入。</FieldDescription>
                  <CollapsibleContent>
                    <Field className="pt-4" data-invalid={!!errors.private_key}>
                      <FieldLabel htmlFor="alipay-private-key">
                        应用私钥（可选）
                      </FieldLabel>
                      <Textarea
                        id="alipay-private-key"
                        name="private_key"
                        className="settings-long-text"
                        rows={4}
                        value={privateKey}
                        onChange={(event) => {
                          setPrivateKey(event.currentTarget.value);
                          save.reset();
                        }}
                        maxLength={16384}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={!!errors.private_key}
                      />
                      <FieldDescription>
                        留空会保留当前密钥；尚未生成时，请在“应用密钥”中生成。保存后不会回显私钥。
                      </FieldDescription>
                      {errors.private_key && (
                        <FieldError>{errors.private_key}</FieldError>
                      )}
                    </Field>
                  </CollapsibleContent>
                </Collapsible>
                </AccountPanel>
                <AccountPanel tabbed={tabbed} value="collection">
                <FieldSet>
                  <FieldLegend>收款码</FieldLegend>
                  <FieldDescription>
                    支持支付宝收款码或经营码。可以先保存草稿，填写收款码后再接收订单。
                  </FieldDescription>
                  <CollectionCodeField
                    key={saved?.id ?? "new"}
                    defaultValue={draft.code_payload}
                    onDecoded={() => {}}
                    onValueChange={(value) => change("code_payload", value)}
                    onPendingChange={setDecoding}
                    disabled={busy}
                    required={false}
                    error={errors.code_payload}
                  />
                </FieldSet>
                </AccountPanel>
              </FieldGroup>
            </CardContent>
            <AccountFormFooter tabbed={tabbed}>
              {showFormActions && (
              <OverlayActions className={tabbed ? "w-full" : undefined}>
              {overlay && !tabbed && <Button type="button" variant="outline" disabled={busy || decoding} onClick={() => overlay.requestClose()}>关闭</Button>}
              <Button form={formId} type="submit" className={tabbed ? "h-auto min-h-8 min-w-0 whitespace-normal py-1.5 max-sm:flex-1" : undefined} disabled={busy || decoding || historical}>
                {save.isPending && <Spinner data-icon="inline-start" />}
                <span className="min-w-0">{save.isPending ? "正在保存…" : "保存并检查"}</span>
              </Button>
              {tabbed ? <DropdownMenu onOpenChange={open => { if (open) invalidDraftField.current = null; }}>
                <DropdownMenuTrigger render={<Button type="button" variant="outline" size="icon" aria-label="更多账号操作" disabled={busy || historical} />}>
                  <MoreHorizontal aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" aria-label="更多账号操作"
                  finalFocus={() => invalidDraftField.current?.isConnected ? invalidDraftField.current : true}>
                  <DropdownMenuGroup>
                    <DropdownMenuItem disabled={busy || decoding || historical || (!dirty && !!saved)} onClick={saveDraft}>
                      保存草稿
                    </DropdownMenuItem>
                    {saved && <DropdownMenuItem disabled={busy || dirty || historical} onClick={() => check.mutate(saved.id)}>
                      <RefreshCw aria-hidden="true" />重新检查
                    </DropdownMenuItem>}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu> : <>
              <Button
                type="button"
                variant="outline"
                disabled={busy || decoding || historical || (!dirty && !!saved)}
                onClick={saveDraft}
              >
                保存草稿
              </Button>
              {saved && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || dirty || historical}
                  onClick={() => check.mutate(saved.id)}
                >
                  <RefreshCw data-icon="inline-start" />
                  重新检查
                </Button>
              )}
              </>}
              </OverlayActions>
              )}
            </AccountFormFooter>
          </Card>
        </FieldSet>
      </form>
      <AccountPanel tabbed={tabbed} value="keys">
      <Card data-account-key-card>
        <CardHeader>
          <CardTitle>应用密钥</CardTitle>
          <CardDescription>
            由系统生成密钥对，或导入已有应用私钥。私钥保存在服务器，应用公钥用于配置支付宝。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {historical ? (
            <p className="text-sm text-muted-foreground">此账号仅保留历史记录。</p>
          ) : !saved ? (
            <p className="text-sm text-muted-foreground">
              先填写账号名称并保存草稿，即可生成应用密钥。
            </p>
          ) : pending ? (
            <>
              <Alert>
                <AlertTitle>新应用密钥待启用</AlertTitle>
                <AlertDescription>
                  当前仍使用原密钥。把下面的新公钥上传到支付宝应用{" "}
                  {pending.app_id}，再填写新的支付宝公钥并验证启用。
                </AlertDescription>
              </Alert>
              <AccountPublicKeyField
                value={pending.public_key}
                title="待启用应用公钥"
                copyLabel="复制待启用应用公钥"
              />
              <Field>
                <FieldLabel htmlFor="alipay-activation-key">
                  新的支付宝公钥
                </FieldLabel>
                <Textarea
                  id="alipay-activation-key"
                  rows={4}
                  value={activationKey}
                  onChange={(event) =>
                    setActivationKey(event.currentTarget.value)
                  }
                  className="settings-long-text"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || dirty || !activationKey.trim()}
                  onClick={() => key.mutate("activate")}
                >
                  验证并启用
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || dirty}
                  onClick={() => setConfirmation("discard")}
                >
                  放弃新密钥
                </Button>
              </div>
            </>
          ) : saved.application_public_key ? (
            <>
              {tabbed && <AccountPublicKeyField
                value={saved.application_public_key}
              />}
              <Button
                className="self-start"
                variant="outline"
                disabled={busy || dirty}
                onClick={() => setConfirmation("regenerate")}
              >
                <KeyRound data-icon="inline-start" />
                更换应用密钥
              </Button>
            </>
          ) : (
            <Button
              className="self-start"
              disabled={busy || dirty}
              onClick={() => key.mutate("generate")}
            >
              <KeyRound data-icon="inline-start" />
              生成应用密钥
            </Button>
          )}
          {saved && !historical && (
            <a
              data-external-link
              href={alipayApplicationUrl(saved.app_id)}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({
                variant: "outline",
                className: "self-start",
              })}
            >
              打开支付宝应用管理
            </a>
          )}
          {dirty && saved && (
            <p className="text-sm text-muted-foreground">
              先保存当前修改，再操作应用密钥。
            </p>
          )}
        </CardContent>
      </Card>
      </AccountPanel>
      {saved && (
        <AccountPanel tabbed={tabbed} value="usage">
        <Card data-account-usage-card>
          <CardHeader>
            <CardTitle>使用情况</CardTitle>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-4">
            <dl className="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
              <div className="flex flex-wrap items-center gap-2"><dt className="text-muted-foreground">账号状态</dt><dd><Badge variant="outline">{accountState(saved)}</Badge></dd></div>
              <div className="flex flex-wrap items-center gap-2"><dt className="text-muted-foreground">查账连接</dt><dd><Badge variant="outline">{accountHealth(saved)}</Badge></dd></div>
              <div className="flex flex-wrap items-center gap-2"><dt className="text-muted-foreground">更新于</dt><dd>{dateTime(saved.updated_at)}</dd></div>
            </dl>
            <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm text-muted-foreground">用于网站 · {saved.sites.length} 个</p>
            {saved.sites.length ? (
              <div className="flex flex-wrap gap-2">
                {saved.sites.map((site) => (
                  <Link
                    key={site.client_id}
                    to={"/sites/" + site.client_id + "/settings/collection"}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-auto min-h-8 max-w-full whitespace-normal py-1.5")}
                  >
                    {site.name}
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">尚未分配给网站。</p>
            )}
            </div>
            <Separator />
            <Item size="xs" className="px-0">
              <ItemContent className="min-w-0 flex-[1_1_18rem]">
                <ItemTitle>账号删除</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {saved.deletable ? "未分配给网站且没有收款记录的账号可以删除。" : historical ? "账号已被网站或订单使用，保留历史记录。" : "账号已被网站或订单使用，无法删除。可在“基本信息”中暂停接收新订单。"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy || dirty || !saved.deletable}
                  onClick={() => setConfirmation("delete")}
                >
                  删除账号
                </Button>
              </ItemActions>
            </Item>
          </CardContent>
        </Card>
        </AccountPanel>
      )}
      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation === "delete"
                ? "删除此支付宝账号？"
                : confirmation === "discard"
                  ? "放弃待启用密钥？"
                  : "生成新的应用密钥？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation === "delete"
                ? "未被使用的账号可以删除。删除后需要重新配置才能使用。"
                : confirmation === "discard"
                  ? "待启用密钥将被丢弃，当前使用的密钥保持不变。"
                  : "新密钥按此账号保存。上传到支付宝并验证启用后生效。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ErrorNotice error={remove.error || key.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (confirmation === "delete") remove.mutate();
                else if (confirmation) key.mutate(confirmation);
              }}
            >
              {busy ? "处理中…" : "确认"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </Tabs>
    </div>
  );
}
