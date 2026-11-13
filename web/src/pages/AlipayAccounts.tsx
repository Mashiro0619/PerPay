import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { onlineManager, useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "react-router";
import { ChevronDown, KeyRound, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import { api, ApiError, queryClient, result, type AlipayAccountInput } from "@/api/client";
import { useDirtyDraft, useOperationNavigation } from "@/drafts";
import { useFixedOperation } from "@/lib/fixed-operation";
import { useOperationKey } from "@/lib/idempotency";
import { isOperationResultUnknown, useOperationWait } from "@/hooks/use-operation-wait";
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
import { ListIdentity, ListSummary, ListSummaryField } from "@/components/list-primitives";
import { OverlayActions } from "@/components/overlay-actions";
import { ScrollingTabs } from "@/components/scrolling-tabs";
import { useOverlayCloseGuard, useOverlayContext } from "@/lib/overlay-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CollectionCodeField } from "@/components/CollectionCodeField";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { useSuccessToast } from "@/components/Feedback";
import { OperationRecoveryNotice } from "@/components/operation-recovery-notice";
import { OperationNavigationDialog } from "@/components/operation-navigation-dialog";
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
  FieldTitle,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
      <QueryView query={accounts}>{({ data }) => data.length ? <BusinessTable id="alipay-accounts" items={data} columns={columns} rowId={account => account.id} density="compact" columnsMenu={false} aria-label="支付宝账号列表"
        renderSummary={(account, context) => <div className="w-full min-w-0" data-management-summary="account">
          <ListSummary identity={<ListIdentity>{columns[0]!.cell(account, context)}</ListIdentity>} aside={columns[5]!.cell(account, context)}>
            {columns.slice(1, 3).map(column => <ListSummaryField key={column.id} label={column.label}>
              {column.cell(account, context)}
            </ListSummaryField>)}
          </ListSummary>
        </div>}
      /> : <Empty><EmptyHeader><EmptyTitle>还没有支付宝账号</EmptyTitle><EmptyDescription>先添加一个账号，完成应用密钥、开放平台信息和收款码配置。</EmptyDescription></EmptyHeader></Empty>}</QueryView>
    </CardContent>
  </Card>;
}

export function AlipayAccountDetail({
  accountId,
  onSaved,
  onBack,
  onRefreshLockChange,
}: {
  accountId: string;
  onSaved?: (account: AlipayAccount) => void;
  onBack?: () => void;
  onRefreshLockChange?: (locked: boolean) => void;
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
      onRefreshLockChange={onRefreshLockChange}
    />
  ) : (
    <QueryView query={account}>
      {({ data }) => (
        <AlipayAccountEditor
          key={data.id}
          initial={data}
          onSaved={onSaved}
          onBack={onBack}
          onRefreshLockChange={onRefreshLockChange}
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
type AccountDraft = ReturnType<typeof accountConfiguration>;
type AccountField = keyof AccountDraft | "private_key";
const accountFieldLabels: Record<AccountField, string> = {
  name: "账号名称", enabled: "接收新订单", code_payload: "收款码",
  app_id: "应用 ID", platform_public_key: "支付宝公钥", private_key: "导入的应用私钥",
};
type AccountConflict = { field: AccountField; local: string | boolean; remote: string | boolean };
type AccountCreation = { body: AlipayAccountInput & { operation_id: string }; checkAfter: boolean };

function readCreatedAccount(value: unknown, operationId: string): AlipayAccount {
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
  const nullableText = (item: unknown) => item === null || typeof item === "string";
  const timestamp = (item: unknown) => typeof item === "string" && Number.isFinite(Date.parse(item));
  const account = object(value) ? value.data : undefined;
  if (!object(account) || account.id !== "alipay_" + operationId || !Number.isSafeInteger(account.revision) || Number(account.revision) < 0 ||
      typeof account.name !== "string" || !account.name || typeof account.enabled !== "boolean" ||
      !["PRODUCTION", "SANDBOX"].includes(String(account.environment)) ||
      !["code_payload", "app_id", "platform_public_key", "provider_account_key", "application_public_key", "application_key_fingerprint"].every(key => nullableText(account[key])) ||
      typeof account.configured !== "boolean" || typeof account.deletable !== "boolean" ||
      !Array.isArray(account.sites) || !account.sites.every(site => object(site) && typeof site.client_id === "string" && typeof site.name === "string") ||
      !timestamp(account.created_at) || !timestamp(account.updated_at) ||
      (account.last_check !== null && (!object(account.last_check) || typeof account.last_check.ok !== "boolean" ||
        !timestamp(account.last_check.checked_at) || typeof account.last_check.message !== "string")) ||
      (account.pending_application_key !== null && (!object(account.pending_application_key) ||
        !["change_id", "public_key", "fingerprint", "app_id"].every(key => typeof (account.pending_application_key as Record<string, unknown>)[key] === "string") ||
        !["PRODUCTION", "SANDBOX"].includes(String(account.pending_application_key.environment)) || !timestamp(account.pending_application_key.created_at))) ||
      (account.health !== undefined && (!object(account.health) || typeof account.health.state !== "string" ||
        !nullableText(account.health.last_success_at) || !nullableText(account.health.last_error_code) || typeof account.health.collection_ready !== "boolean"))) {
    throw new Error("服务未返回完整的账号结果，请重试上一次操作。");
  }
  return account as AlipayAccount;
}

const accountSections = [["basic", "基本信息"], ["application", "应用信息"], ["collection", "收款码"], ["usage", "使用情况"]] as const;
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
    <FieldDescription>上传到对应的支付宝应用，再将支付宝提供的公钥填入下方。</FieldDescription>
  </Field>;
}

export function AlipayAccountEditor({
  initial,
  onSaved,
  onBack,
  onRefreshLockChange,
}: {
  initial: AlipayAccount | null;
  onSaved?: (account: AlipayAccount) => void;
  onBack?: () => void;
  onRefreshLockChange?: (locked: boolean) => void;
}) {
  const overlay = useOverlayContext();
  const tabbed = !!overlay || !!onBack;
  const formId = useId();
  const successToast = useSuccessToast();
  const runOperation = useOperationWait();
  const navigate = useNavigate();
  const location = useLocation();
  const navigationFeedback = location.state as {
    savedAccountId?: string;
    savedAccountRevision?: number;
    checkFailure?: string;
    accountPanel?: string;
  } | null;
  const hasSavedFeedback = initial !== null &&
    navigationFeedback?.savedAccountId === initial.id &&
    navigationFeedback?.savedAccountRevision === initial.revision;
  const [panel, setPanel] = useState(() => hasSavedFeedback && accountSections.some(([value]) => value === navigationFeedback?.accountPanel)
    ? navigationFeedback!.accountPanel! : initial?.pending_application_key ? "application" : "basic");
  const [saved, setSaved] = useState(initial);
  const creationKey = useOperationKey();
  const creationConfirmed = useRef(false);
  const [leavingCreation, setLeavingCreation] = useState(false);
  const historical = saved?.environment === "SANDBOX";
  const [draft, setDraft] = useState(() => accountConfiguration(initial));
  const [privateKey, setPrivateKey] = useState("");
  const [privateKeyOpen, setPrivateKeyOpen] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [savedMessage, setSavedMessage] = useState(() =>
    hasSavedFeedback ? "账号已保存" : "",
  );
  const [initialCheckFailure, setInitialCheckFailure] = useState(() =>
    hasSavedFeedback
      ? navigationFeedback?.checkFailure
      : undefined,
  );
  const [confirmation, setConfirmation] = useState<
    "delete" | "regenerate" | "discard" | null
  >(null);
  const [activationKey, setActivationKey] = useState("");
  const [keyChangeId, setKeyChangeId] = useState(() => crypto.randomUUID());
  const [needsReload, setNeedsReload] = useState<"conflict" | "unknown" | null>(null);
  const [review, setReview] = useState<{ account: AlipayAccount; draft: AccountDraft; conflicts: AccountConflict[] } | null>(null);
  const [choices, setChoices] = useState<Partial<Record<AccountField, "local" | "remote">>>({});
  const form = useRef<HTMLFormElement>(null);
  const invalidDraftField = useRef<HTMLElement | null>(null);
  const focusedSaveError = useRef<Error | null>(null);
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
  const creating = tabbed && saved === null;
  const readyToCheck = !tabbed || !!(draft.app_id.trim() && draft.platform_public_key.trim() && (privateKey.trim() || saved?.application_public_key));
  const showFormActions = (!tabbed || panel !== "usage" || dirty) && !(tabbed && !historical && panel === "application" && saved?.pending_application_key && !dirty);
  const clear = useDirtyDraft(dirty);
  const clearActivationDraft = useDirtyDraft(activationKey !== "");

  function handleWriteError(error: Error) {
    const unknown = isOperationResultUnknown(error);
    if (unknown ||
        (error instanceof ApiError && error.code === "alipay_account_revision_conflict")) {
      setNeedsReload(unknown ? "unknown" : "conflict");
      setConfirmation(null);
      setSavedMessage("");
    }
  }

  function applyReload(account: AlipayAccount, configuration: AccountDraft, keepPrivateKey: boolean) {
    if (account.pending_application_key?.change_id !== saved?.pending_application_key?.change_id) {
      setActivationKey("");
      clearActivationDraft();
    }
    setSaved(account);
    setDraft(configuration);
    if (!keepPrivateKey) setPrivateKey("");
    setKeyChangeId(crypto.randomUUID());
    setNeedsReload(null);
    setReview(null);
    setChoices({});
    setConfirmation(null);
    setSavedMessage("账号配置已重新读取");
    setInitialCheckFailure(undefined);
    save.reset();
    key.reset();
    remove.reset();
    check.reset();
    queryClient.setQueryData(alipayAccountKey(account.id), { data: account });
  }
  const reload = useMutation({
    networkMode: "always",
    retry: false,
    mutationFn: async () => {
      if (!onlineManager.isOnline() || !navigator.onLine)
        throw new Error("网络已断开，恢复连接后请重新读取。");
      try {
        const response = await runOperation(signal => result(api.getAlipayAccount({ path: { accountId: saved!.id }, signal })));
        return response.data;
      } catch (error) {
        if (error instanceof ApiError && error.code === "alipay_account_not_found") return null;
        throw error;
      }
    },
    onSuccess: (account) => {
      if (!mounted.current) return;
      if (account === null) {
        leaveDeletedAccount();
        return;
      }
      const base = accountConfiguration(saved);
      const remote = accountConfiguration(account);
      const configuration = { ...remote };
      const conflicts: AccountConflict[] = [];
      const applicationChanged = saved?.app_id !== account.app_id || saved?.platform_public_key !== account.platform_public_key ||
        saved?.application_key_fingerprint !== account.application_key_fingerprint ||
        saved?.pending_application_key?.change_id !== account.pending_application_key?.change_id;
      for (const field of Object.keys(configuration) as (keyof AccountDraft)[]) {
        const local = draft[field];
        if (local === base[field]) continue;
        if (remote[field] !== local && (remote[field] !== base[field] ||
          (applicationChanged && (field === "app_id" || field === "platform_public_key")))) {
          conflicts.push({ field, local, remote: remote[field] });
        } else Object.assign(configuration, { [field]: local });
      }
      if (privateKey.trim() && applicationChanged)
        conflicts.push({ field: "private_key", local: "使用已填写的私钥", remote: "保留服务器私钥" });
      if (conflicts.length) {
        setReview({ account, draft: configuration, conflicts });
        setChoices({});
      } else applyReload(account, configuration, !!privateKey);
    },
  });

  async function accepted(account: AlipayAccount, message: string) {
    if (mounted.current) {
      check.reset();
      setInitialCheckFailure(undefined);
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
    retry: false,
    onMutate: () => { completedNavigation.current = false; setInitialCheckFailure(undefined); },
    mutationFn: (id: string) => {
      if (historical) throw new Error("此账号仅保留历史记录，请添加已上线应用的支付宝账号。");
      return runOperation(signal => result(api.checkAlipayAccount({ path: { accountId: id }, body: {}, signal })));
    },
    onSuccess: ({ data }) => {
      setSaved(account => account ? { ...account, last_check: data } : account);
      if (data.ok) successToast("查账连接检查通过");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: alipayAccountsKey });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
  const save = useMutation({
    networkMode: "always",
    retry: false,
    onError: handleWriteError,
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
      if (!saved) throw new Error("请先创建账号。");
      const response = await runOperation(signal => result(
        api.updateAlipayAccount({
          path: { accountId: saved.id },
          body: { ...input, revision: saved.revision },
          signal,
        }),
      ));
      return { account: response.data, checkAfter, created: false };
    },
    onSuccess: finishSave,
  });
  async function finishSave({ account, checkAfter, created }: { account: AlipayAccount; checkAfter: boolean; created: boolean }) {
    await accepted(account, "账号已保存");
    if (created && onBack) setPanel("application");
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
        state: { savedAccountId: account.id, savedAccountRevision: account.revision, checkFailure,
          ...(tabbed ? { accountPanel: panel === "basic" ? "application" : panel } : {}) },
      });
    }
  }
  const creation = useFixedOperation({
    execute: async (input: AccountCreation, signal) => {
      const response = await result(api.createAlipayAccount({ body: input.body, signal }));
      return { account: readCreatedAccount(response, input.body.operation_id), checkAfter: input.checkAfter, created: true };
    },
    onSuccess: value => {
      creationConfirmed.current = true;
      void finishSave(value);
    },
    isSafeRejection: error => error instanceof ApiError && error.status === 422 && error.code === "settings_validation_failed",
  });
  const key = useMutation({
    networkMode: "always",
    retry: false,
    onError: handleWriteError,
    onMutate: () => { completedNavigation.current = false; },
    mutationFn: async (
      action: "generate" | "regenerate" | "activate" | "discard",
    ) => {
      if (!saved) throw new Error("请先保存账号，再生成应用密钥。");
      if (historical && action !== "discard") throw new Error("此账号仅保留历史记录，请添加已上线应用的支付宝账号。");
      const path = { accountId: saved.id };
      if (action === "generate")
        return runOperation(signal => result(
          api.generateAlipayAccountApplicationKey({
            path,
            body: { revision: saved.revision },
            signal,
          }),
        ));
      if (action === "regenerate")
        return runOperation(signal => result(
          api.regenerateAlipayAccountApplicationKey({
            path,
            body: {
              revision: saved.revision,
              change_id: keyChangeId,
              base_fingerprint: saved.application_key_fingerprint!,
            },
            signal,
          }),
        ));
      const pending = saved.pending_application_key;
      if (!pending) throw new Error("没有待启用的应用密钥。");
      const body = { revision: saved.revision, change_id: pending.change_id };
      return action === "activate"
        ? runOperation(signal => result(
            api.activateAlipayAccountApplicationKey({
              path,
              body: { ...body, platform_public_key: activationKey.trim() },
              signal,
            }),
          ))
        : runOperation(signal => result(api.discardAlipayAccountApplicationKey({ path, body, signal })));
    },
    onSuccess: async ({ data }, action) => {
      setConfirmation(null);
      setActivationKey("");
      clearActivationDraft();
      if (action === "discard" || action === "activate" ||
          (action === "regenerate" && !data.pending_application_key))
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
    retry: false,
    onError: handleWriteError,
    onMutate: () => { completedNavigation.current = false; },
    mutationFn: async () => {
      try {
        return await runOperation(signal => result(
          api.deleteAlipayAccount({
            path: { accountId: saved!.id },
            body: { revision: saved!.revision },
            signal,
          }),
        ));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && error.code === "alipay_account_not_found") return null;
        throw error;
      }
    },
    onSuccess: leaveDeletedAccount,
  });
  function leaveDeletedAccount() {
    clear();
    clearActivationDraft();
    setConfirmation(null);
    completedNavigation.current = true;
    queryClient.removeQueries({ queryKey: alipayAccountKey(saved!.id) });
    void queryClient.invalidateQueries({ queryKey: alipayAccountsKey });
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    if (onBack) onBack();
    else void navigate("/settings/accounts");
  }
  const saving = save.isPending || creation.isPending;
  const saveError = saved ? save.error : creation.error;
  const busy = saving || key.isPending || remove.isPending || check.isPending || reload.isPending;
  const refreshLocked = busy || decoding || !!creation.recovery;
  useEffect(() => {
    onRefreshLockChange?.(refreshLocked);
    return () => onRefreshLockChange?.(false);
  }, [onRefreshLockChange, refreshLocked]);
  const requiresReview = needsReload !== null || review !== null;
  const editingBlocked = busy || requiresReview || !!creation.recovery;
  const navigation = useOperationNavigation(creation.isPending || !!creation.recovery,
    () => !creationConfirmed.current && (creation.isBusy() || !!creation.recovery));
  // A confirmed create/delete may navigate before React Query clears isPending.
  useOverlayCloseGuard(() => decoding || (busy && !completedNavigation.current));
  const errors = saveError instanceof ApiError ? saveError.fields : {};
  const activationKeyError = key.error instanceof ApiError ? key.error.fields.platform_public_key : undefined;
  useEffect(() => {
    if (saving || !errors.private_key) return;
    setPrivateKeyOpen(true);
  }, [errors.private_key, saving]);
  useEffect(() => {
    if (saving || !saveError || creation.recovery || focusedSaveError.current === saveError) return;
    const invalid = form.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"]',
    );
    if (!invalid) return;
    const nextPanel = invalid.closest<HTMLElement>("[data-account-panel]")?.dataset.accountPanel;
    if (tabbed && nextPanel && panel !== nextPanel) {
      setPanel(nextPanel);
      return;
    }
    focusedSaveError.current = saveError;
    requestAnimationFrame(() => { if (invalid.isConnected) invalid.focus(); });
  }, [saveError, saving, tabbed, privateKeyOpen, panel, creation.recovery]);
  useEffect(() => {
    if (key.isPending || !activationKeyError) return;
    if (tabbed) setPanel("application");
    requestAnimationFrame(() => form.current?.querySelector<HTMLElement>("#alipay-activation-key")?.focus());
  }, [activationKeyError, key.isPending, tabbed]);
  function change<T extends keyof typeof draft>(
    field: T,
    value: (typeof draft)[T],
  ) {
    if (!saved && !creation.reset()) return;
    setDraft((previous) => ({ ...previous, [field]: value }));
    setSavedMessage("");
    save.reset();
    check.reset();
    setInitialCheckFailure(undefined);
  }
  function submitSave(checkAfter: boolean) {
    if (editingBlocked || decoding || historical) return;
    completedNavigation.current = false;
    check.reset();
    if (saved) { save.mutate(checkAfter); return; }
    const input: AlipayAccountInput = {
      ...draft, environment: "PRODUCTION", name: draft.name.trim(),
      code_payload: draft.code_payload.trim() || null, app_id: draft.app_id.trim() || null,
      platform_public_key: draft.platform_public_key.trim() || null,
      ...(privateKey.trim() ? { private_key: privateKey.trim() } : {}),
    };
    creation.submit({ body: { ...input, operation_id: creationKey(input) }, checkAfter });
  }
  function saveDraft() {
    if (editingBlocked) return;
    const owningForm = form.current;
    if (!owningForm) return;
    if (!owningForm.reportValidity()) {
      invalidDraftField.current = owningForm.querySelector<HTMLElement>(
        "input:invalid, textarea:invalid, select:invalid",
      );
      return;
    }
    submitSave(false);
  }
  const error = saveError || key.error || remove.error;
  const pending = historical ? null : saved?.pending_application_key;
  const platformKeyError = pending ? activationKeyError : errors.platform_public_key;
  const checkResult = historical ? null : check.data?.data ?? (!dirty ? saved?.last_check : null);
  const lastCheck = historical ? null : check.data?.data ?? saved?.last_check;
  const checkFailure = historical ? undefined : check.error?.message ?? initialCheckFailure;
  const setupGaps = saved ? [
    !saved.app_id && { label: "应用 ID", panel: "application", field: "alipay-app-id" },
    !saved.application_public_key && { label: "应用密钥", panel: "application", field: "alipay-app-id" },
    !saved.platform_public_key && { label: "支付宝公钥", panel: "application", field: "alipay-platform-key" },
    !saved.code_payload && { label: "收款码", panel: "collection", field: null },
  ].filter((gap): gap is { label: string; panel: string; field: string | null } => !!gap) : [];
  const nextSetupGap = setupGaps[0];
  const collectionReady = saved?.health?.collection_ready === true;
  const showSetupNotice = !historical && (!saved || setupGaps.length > 0 || (saved.enabled && !collectionReady));
  const setupStatus = !saved ? "先创建支付宝账号" : setupGaps.length ? "待补充：" + setupGaps.map(gap => gap.label).join("、")
    : "暂不可收款";
  return (
    <div className="flex min-w-0 flex-col gap-4" data-alipay-account-editor>
      <Tabs value={panel} onValueChange={value => { if (value) setPanel(value); }} className="min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">
          {saved?.name ?? "添加支付宝账号"}
        </h2>
        {onBack ? (
          <Button variant="ghost" disabled={creation.isPending} onClick={() => creation.recovery ? setLeavingCreation(true) : onBack()}>
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
      {tabbed && <ScrollingTabs selection={{
        items: accountSections.filter(([value]) => value !== "usage" || saved !== null).map(([value, label]) => ({ value, label })),
        value: panel,
        onValueChange: setPanel,
        label: "支付宝账号配置分组",
      }}><TabsList aria-label="支付宝账号配置分组" variant="line" activateOnFocus={false} className="min-w-max">
        {accountSections.filter(([value]) => value !== "usage" || saved !== null).map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}
      </TabsList></ScrollingTabs>}
      <ErrorNotice error={requiresReview || creation.recovery ? null : error} />
      {creation.recovery && <>
        <OperationRecoveryNotice heading="创建结果待确认" operationId={creation.recovery.body.operation_id} error={creation.error} conflict={creation.conflict} />
        <OverlayActions><Button type="button" disabled={creation.isPending || creation.conflict}
          onClick={() => creation.recovery && creation.submit(creation.recovery)}>
          {creation.isPending ? "正在重试…" : "重试上一次操作"}
        </Button></OverlayActions>
      </>}
      {needsReload && !review && <Alert>
        <AlertTitle>{needsReload === "unknown" ? "操作结果待核对" : "账号配置已在其他会话中更新"}</AlertTitle>
        <AlertDescription>
          <p>{needsReload === "unknown" ? "你的输入已保留。请重新读取账号，核对操作是否完成后再继续。" : "你的修改已保留，重新读取后可继续操作。"}</p>
          <Button variant="outline" disabled={busy} onClick={() => reload.mutate()}>{reload.isPending ? "正在读取…" : "重新读取账号"}</Button>
        </AlertDescription>
      </Alert>}
      {review && <Card>
        <CardHeader><CardTitle>账号配置存在不同修改</CardTitle><CardDescription>选择要保留的配置，核对后再保存。</CardDescription></CardHeader>
        <CardContent><FieldGroup>
          {review.conflicts.map(conflict => <Field key={conflict.field}>
            <FieldTitle>{accountFieldLabels[conflict.field]}</FieldTitle>
            <FieldDescription className="whitespace-pre-wrap break-all">服务器值：{typeof conflict.remote === "boolean" ? conflict.remote ? "开启" : "关闭" : conflict.remote || "未填写"}</FieldDescription>
            <FieldDescription className="whitespace-pre-wrap break-all">我的值：{typeof conflict.local === "boolean" ? conflict.local ? "开启" : "关闭" : conflict.local || "未填写"}</FieldDescription>
            {!!review.account.pending_application_key && ["app_id", "platform_public_key", "private_key"].includes(conflict.field) && <FieldDescription>服务器有待启用密钥，请先采用服务器配置，再处理该密钥。</FieldDescription>}
            <ToggleGroup aria-label={accountFieldLabels[conflict.field] + "冲突处理"} variant="outline" className="max-w-full flex-wrap"
              value={choices[conflict.field] ? [choices[conflict.field]!] : []} onValueChange={value => {
                const next = value[0];
                setChoices(previous => ({ ...previous, [conflict.field]: next === "local" || next === "remote" ? next : undefined }));
              }}>
              <ToggleGroupItem value="local" disabled={!!review.account.pending_application_key && ["app_id", "platform_public_key", "private_key"].includes(conflict.field)}>保留我的修改</ToggleGroupItem>
              <ToggleGroupItem value="remote">采用服务器值</ToggleGroupItem>
            </ToggleGroup>
          </Field>)}
        </FieldGroup></CardContent>
        <CardFooter><Button disabled={review.conflicts.some(conflict => !choices[conflict.field])} onClick={() => {
          const configuration = { ...review.draft };
          for (const conflict of review.conflicts) {
            if (conflict.field !== "private_key") Object.assign(configuration, {
              [conflict.field]: choices[conflict.field] === "local" ? conflict.local : conflict.remote,
            });
          }
          applyReload(review.account, configuration, choices.private_key !== "remote" && !!privateKey);
        }}>应用核对结果</Button></CardFooter>
      </Card>}
      <ErrorNotice error={reload.error} />
      {historical && (
        <Alert>
          <AlertTitle>旧版测试账号已停用</AlertTitle>
          <AlertDescription>
            <p>历史记录仍可查看。请添加状态为“已上线”的支付宝应用账号用于收款和查账。</p>
            <Link to="/settings/accounts/new">添加支付宝账号</Link>
          </AlertDescription>
        </Alert>
      )}
      {showSetupNotice && <Alert role="status">
        <AlertTitle>{setupStatus}</AlertTitle>
        <AlertDescription>
          {!saved ? <p>填写账号名称并创建，再生成应用密钥、配置支付宝应用和收款码。</p>
            : nextSetupGap ? <>
              <p>账号补齐配置并通过查账后，才会接收新订单。</p>
              <Button type="button" variant="outline" disabled={busy} onClick={() => {
                setPanel(nextSetupGap.panel);
                requestAnimationFrame(() => {
                  const target = nextSetupGap.field ? document.getElementById(nextSetupGap.field)
                    : form.current?.querySelector<HTMLElement>('[data-account-panel="collection"] input, [data-account-panel="collection"] button');
                  target?.focus(); target?.scrollIntoView({ block: "nearest" });
                });
              }}>继续配置{nextSetupGap.label}</Button>
            </> : <>
              <p>请查看运行状态，核对查账连接和最近一次查账结果。</p>
              <Link to="/system" className={buttonVariants({ variant: "outline" })}>查看收款状态</Link>
            </>}
          {dirty && saved && <p>以上为已保存的配置，当前修改尚未保存。</p>}
        </AlertDescription>
      </Alert>}
      {savedMessage && (
        <Alert role="status">
          <AlertTitle>{savedMessage}</AlertTitle>
        </Alert>
      )}
      {(checkFailure || checkResult?.ok === false || check.isPending) && (
        <Alert
          role="status"
          variant={
            !check.isPending && (checkFailure || checkResult?.ok === false)
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
          {!check.isPending && <AlertDescription>
            {checkFailure ?? checkResult?.message}
            {(checkFailure || checkResult?.ok === false) && (
              <p>账号配置已保留。修正应用信息后保存，或直接重试检查。</p>
            )}
          </AlertDescription>}
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
          submitSave(!creating && readyToCheck);
        }}
      >
        <FieldSet disabled={editingBlocked || historical}>
          <Card className={tabbed && panel === "usage" ? "hidden" : undefined}>
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
                      {saved?.configured ? "暂停只影响新订单，已有订单继续查账。" : "完成配置并通过查账后生效。"}
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
                <FieldSet data-account-application>
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
                      disabled={!!pending}
                      onChange={(event) =>
                        change("app_id", event.currentTarget.value)
                      }
                      autoComplete="off"
                      aria-invalid={!!errors.app_id}
                    />
                    {errors.app_id && <FieldError>{errors.app_id}</FieldError>}
                  </Field>
                  {pending && <Alert>
                    <AlertTitle>新应用密钥待启用</AlertTitle>
                    <AlertDescription>当前仍使用原密钥。上传下面的待启用应用公钥，再填入支付宝提供的公钥并验证启用。</AlertDescription>
                  </Alert>}
                  {(pending?.public_key || saved?.application_public_key) && !privateKey.trim() ? (
                    <AccountPublicKeyField value={pending?.public_key ?? saved!.application_public_key!}
                      title={pending ? "待启用应用公钥" : "应用公钥"} copyLabel={pending ? "复制待启用应用公钥" : "复制应用公钥"} />
                  ) : (
                    <Field>
                      <FieldLabel>应用公钥</FieldLabel>
                      <FieldDescription>
                        {privateKey.trim() ? "保存导入的应用私钥后，这里会显示对应的应用公钥。" : saved ? "点击“生成应用密钥”由系统生成密钥对，再将应用公钥上传到支付宝。" : tabbed ? "先填写账号名称，点击“创建账号并继续”，再生成应用密钥。" : "先填写账号名称并保存草稿，再点击“生成应用密钥”。"}
                      </FieldDescription>
                    </Field>
                  )}
                  {!historical && <div className="flex min-w-0 flex-wrap items-center gap-2" data-account-key-actions>
                    {!pending && !privateKey.trim() && <Button type="button" variant="outline" size="sm"
                      className="h-auto min-h-8 max-w-full whitespace-normal py-1.5" disabled={editingBlocked || dirty || !saved}
                      onClick={() => saved?.application_public_key ? setConfirmation("regenerate") : key.mutate("generate")}>
                      <KeyRound data-icon="inline-start" />{saved?.application_public_key ? "更换应用密钥" : "生成应用密钥"}
                    </Button>}
                    {saved && <a data-external-link href={alipayApplicationUrl(draft.app_id)} target="_blank" rel="noopener noreferrer"
                      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-auto min-h-8 max-w-full whitespace-normal py-1.5")}>打开支付宝应用管理</a>}
                  </div>}
                  <Field data-invalid={!!platformKeyError}>
                    <FieldLabel htmlFor={pending ? "alipay-activation-key" : "alipay-platform-key"}>
                      {pending ? "新的支付宝公钥" : "支付宝公钥"}
                    </FieldLabel>
                    <Textarea
                      id={pending ? "alipay-activation-key" : "alipay-platform-key"}
                      name={pending ? undefined : "platform_public_key"}
                      rows={4}
                      className="settings-long-text"
                      value={pending ? activationKey : draft.platform_public_key}
                      onChange={(event) => {
                        if (pending) {
                          setActivationKey(event.currentTarget.value);
                          key.reset();
                        } else change("platform_public_key", event.currentTarget.value);
                      }}
                      maxLength={16384}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={!!platformKeyError}
                    />
                    <FieldDescription>
                      上传应用公钥后，将支付宝提供的“支付宝公钥”填到这里。
                    </FieldDescription>
                    {platformKeyError && (
                      <FieldError>{platformKeyError}</FieldError>
                    )}
                  </Field>
                  {pending && <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={editingBlocked || dirty || !activationKey.trim()} onClick={() => key.mutate("activate")}>验证并启用</Button>
                    <Button type="button" variant="outline" disabled={editingBlocked || dirty} onClick={() => setConfirmation("discard")}>放弃新密钥</Button>
                  </div>}
                  <FieldDescription>应用私钥保存在服务器，无需上传到支付宝。{dirty && saved ? "先保存当前修改，再操作应用密钥。" : ""}</FieldDescription>
                </FieldSet>
                {!pending && <Collapsible open={privateKeyOpen} onOpenChange={setPrivateKeyOpen} className="flex min-w-0 flex-col gap-2">
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
                          if (!saved && !creation.reset()) return;
                          setPrivateKey(event.currentTarget.value);
                          save.reset();
                        }}
                        maxLength={16384}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={!!errors.private_key}
                      />
                      <FieldDescription>
                        留空会保留当前密钥；没有密钥时，可点击上方“生成应用密钥”。保存后不会回显私钥。
                      </FieldDescription>
                      {errors.private_key && (
                        <FieldError>{errors.private_key}</FieldError>
                      )}
                    </Field>
                  </CollapsibleContent>
                </Collapsible>}
                </AccountPanel>
                <AccountPanel tabbed={tabbed} value="collection">
                <FieldSet>
                  <FieldLegend>收款码</FieldLegend>
                  <FieldDescription>
                    支持支付宝收款码或经营码。可以先保存草稿，填写收款码后再接收订单。
                  </FieldDescription>
                  <CollectionCodeField
                    key={(saved?.id ?? "new") + ":" + (saved?.revision ?? 0)}
                    defaultValue={draft.code_payload}
                    onDecoded={() => {}}
                    onValueChange={(value) => change("code_payload", value)}
                    onPendingChange={setDecoding}
                    disabled={editingBlocked}
                    required={false}
                    error={errors.code_payload}
                  />
                </FieldSet>
                </AccountPanel>
              </FieldGroup>
            </CardContent>
            <AccountFormFooter tabbed={tabbed}>
              {showFormActions && !creation.recovery && (
              <OverlayActions className={tabbed ? "w-full" : undefined}>
              <Button form={formId} type="submit" className={tabbed ? "h-auto min-h-8 min-w-0 whitespace-normal py-1.5 max-sm:flex-1" : undefined} disabled={editingBlocked || decoding || historical || (!saved && creation.conflict)}>
                {saving && <Spinner data-icon="inline-start" />}
                <span className="min-w-0">{saving ? "正在保存…" : creating ? "创建账号并继续" : readyToCheck ? "保存并检查" : "保存配置"}</span>
              </Button>
              {tabbed ? <DropdownMenu onOpenChange={open => { if (open) invalidDraftField.current = null; }}>
                <DropdownMenuTrigger render={<Button type="button" variant="outline" size="icon" aria-label="更多账号操作" disabled={editingBlocked || historical} />}>
                  <MoreHorizontal aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" aria-label="更多账号操作"
                  finalFocus={() => invalidDraftField.current?.isConnected
                    ? invalidDraftField.current
                    : !form.current?.contains(document.activeElement)}>
                  <DropdownMenuGroup>
                    <DropdownMenuItem disabled={editingBlocked || decoding || historical || (!dirty && !!saved)} onClick={saveDraft}>
                      保存草稿
                    </DropdownMenuItem>
                    {saved && <DropdownMenuItem disabled={editingBlocked || dirty || historical} onClick={() => check.mutate(saved.id)}>
                      <RefreshCw aria-hidden="true" />重新检查
                    </DropdownMenuItem>}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu> : <>
              <Button
                type="button"
                variant="outline"
                disabled={editingBlocked || decoding || historical || (!dirty && !!saved)}
                onClick={saveDraft}
              >
                保存草稿
              </Button>
              {saved && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={editingBlocked || dirty || historical}
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
      <OperationNavigationDialog
        navigation={leavingCreation ? { blocked: true, hasDrafts: dirty, stay: () => setLeavingCreation(false),
          proceed: onLeave => { onLeave(); clear(); onBack?.(); } } : navigation}
        operationId={creation.submitted?.body.operation_id} pending={creation.isPending}
        finalFocus={() => form.current} onLeave={() => creation.stopWaiting()}
      />
      {saved && (
        <AccountPanel tabbed={tabbed} value="usage">
        <Card data-account-usage-card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>使用情况</CardTitle>
            {!historical && <CardAction className="max-w-full">
              <Link to="/system" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-auto min-h-8 max-w-full whitespace-normal py-1.5")}>查看收款状态</Link>
            </CardAction>}
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-4">
            <dl className="flex min-w-0 flex-wrap gap-x-6 gap-y-3">
              <div className="flex flex-wrap items-center gap-2"><dt className="text-muted-foreground">账号状态</dt><dd><Badge variant="outline">{accountState(saved)}</Badge></dd></div>
              <div className="flex flex-wrap items-center gap-2"><dt className="text-muted-foreground">查账连接</dt><dd><Badge variant="outline">{accountHealth(saved)}</Badge></dd></div>
              {!historical && <div className="flex flex-wrap items-center gap-2"><dt className="text-muted-foreground">收款状态</dt><dd><Badge variant="outline">{setupGaps.length ? "配置未完成" : !saved.enabled ? "已暂停新订单" : collectionReady ? "当前可收款" : "暂不可收款"}</Badge></dd></div>}
              <div className="flex flex-wrap items-center gap-2"><dt className="text-muted-foreground">更新于</dt><dd>{dateTime(saved.updated_at)}</dd></div>
            </dl>
            {lastCheck && <div className="flex min-w-0 flex-col gap-1">
              <dl className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <dt className="text-sm text-muted-foreground">最近连接检查</dt>
                <dd><Badge variant={lastCheck.ok ? "outline" : "destructive"}>{lastCheck.ok ? "通过" : "未通过"}</Badge></dd>
                <dd className="text-sm text-muted-foreground"><time dateTime={lastCheck.checked_at}>{dateTime(lastCheck.checked_at)}</time></dd>
              </dl>
              <p className="text-sm text-muted-foreground">{lastCheck.message}</p>
            </div>}
            {dirty && <p className="text-sm text-muted-foreground">以上为已保存的配置，当前修改尚未保存。</p>}
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
              <>
                <p className="text-sm text-muted-foreground">尚未分配给网站。</p>
                {!historical && <Link to="/sites/new" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "self-start")}>创建业务网站</Link>}
              </>
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
                  disabled={editingBlocked || dirty || !saved.deletable}
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
              disabled={editingBlocked}
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
