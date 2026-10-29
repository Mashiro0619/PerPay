import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "react-router";
import { KeyRound, Plus, RefreshCw } from "lucide-react";
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
import { dateTime } from "@/lib/format";
import { PageHeading } from "@/components/page-heading";
import { CollectionCodeField } from "@/components/CollectionCodeField";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

export function AlipayAccountList({
  onSelect,
}: {
  onSelect?: (id: string) => void;
}) {
  const accounts = useQuery(alipayAccountsQuery);
  const createLink = onSelect ? (
    <Button onClick={() => onSelect("new")}>
      <Plus data-icon="inline-start" />
      添加支付宝账号
    </Button>
  ) : (
    <Link to="/settings/accounts/new" className={buttonVariants()}>
      <Plus data-icon="inline-start" />
      添加支付宝账号
    </Link>
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          每个账号分别保存收款码和开放平台应用信息，再分配给业务网站。
        </p>
        {createLink}
      </div>
      <QueryView query={accounts}>
        {({ data }) =>
          data.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>还没有支付宝账号</EmptyTitle>
                <EmptyDescription>
                  先添加一个账号，完成应用密钥、开放平台信息和收款码配置。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div
              className="flex min-w-0 flex-col divide-y rounded-lg border"
              data-account-list
            >
              {data.map((account) => (
                <div
                  key={account.id}
                  className="flex min-w-0 flex-wrap items-start gap-3 p-4"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    {onSelect ? (
                      <Button
                        variant="link"
                        className="h-auto justify-start p-0"
                        onClick={() => onSelect(account.id)}
                      >
                        {account.name}
                      </Button>
                    ) : (
                      <Link
                        className="font-medium underline-offset-4 hover:underline"
                        to={"/settings/accounts/" + account.id}
                      >
                        {account.name}
                      </Link>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Badge
                        variant={
                          account.enabled && account.configured
                            ? "secondary"
                            : "outline"
                        }
                      >
                        {accountState(account)}
                      </Badge>
                      <Badge variant="outline">{accountHealth(account)}</Badge>
                      {account.environment === "SANDBOX" && (
                        <Badge variant="outline">沙箱</Badge>
                      )}
                    </div>
                    <p className="break-all text-sm text-muted-foreground">
                      {account.app_id
                        ? "App ID：" + account.app_id
                        : "尚未填写 App ID"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {account.sites.length
                        ? "用于：" +
                          account.sites.map((site) => site.name).join("、")
                        : "尚未分配给网站"}
                    </p>
                  </div>
                  {onSelect ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onSelect(account.id)}
                    >
                      配置
                    </Button>
                  ) : (
                    <Link
                      to={"/settings/accounts/" + account.id}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                      aria-label={"配置" + account.name}
                    >
                      配置
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )
        }
      </QueryView>
    </div>
  );
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
    environment:
      account?.environment ?? ("PRODUCTION" as "PRODUCTION" | "SANDBOX"),
    app_id: account?.app_id ?? "",
    platform_public_key: account?.platform_public_key ?? "",
  };
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
  const navigate = useNavigate();
  const location = useLocation();
  const navigationFeedback = location.state as {
    savedAccountId?: string;
    checkFailure?: string;
  } | null;
  const [saved, setSaved] = useState(initial);
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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(accountConfiguration(saved)) ||
    privateKey !== "";
  const clear = useDirtyDraft(dirty);

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
    onMutate: () => setInitialCheckFailure(undefined),
    mutationFn: (id: string) =>
      result(api.checkAlipayAccount({ path: { accountId: id }, body: {} })),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: alipayAccountsKey });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
  const save = useMutation({
    networkMode: "always",
    mutationFn: async (checkAfter: boolean) => {
      const input = {
        ...draft,
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
      if (created && mounted.current && !onBack)
        void navigate("/settings/accounts/" + account.id, {
          replace: true,
          state: { savedAccountId: account.id, checkFailure },
        });
    },
  });
  const key = useMutation({
    networkMode: "always",
    mutationFn: async (
      action: "generate" | "regenerate" | "activate" | "discard",
    ) => {
      if (!saved) throw new Error("请先保存账号，再生成应用密钥。");
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
    mutationFn: () =>
      result(
        api.deleteAlipayAccount({
          path: { accountId: saved!.id },
          body: { revision: saved!.revision },
        }),
      ),
    onSuccess: () => {
      clear();
      void queryClient.invalidateQueries({ queryKey: alipayAccountsKey });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (onBack) onBack();
      else void navigate("/settings/accounts");
    },
  });
  const busy =
    save.isPending || key.isPending || remove.isPending || check.isPending;
  const errors = save.error instanceof ApiError ? save.error.fields : {};
  useEffect(() => {
    if (save.isPending || !save.error) return;
    const invalid = form.current?.querySelector<HTMLElement>(
      '[aria-invalid="true"]',
    );
    invalid?.focus();
  }, [save.error, save.isPending]);
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
  const error = save.error || key.error || remove.error;
  const pending = saved?.pending_application_key;
  const checkResult = check.data?.data ?? (!dirty ? saved?.last_check : null);
  const checkFailure = check.error?.message ?? initialCheckFailure;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-alipay-account-editor>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">
          {saved?.name ?? "添加支付宝账号"}
        </h2>
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            返回账号列表
          </Button>
        ) : (
          <Link
            to="/settings/accounts"
            className={buttonVariants({ variant: "ghost" })}
          >
            返回账号列表
          </Link>
        )}
      </div>
      <ErrorNotice error={error} />
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
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !decoding) {
            check.reset();
            save.mutate(true);
          }
        }}
      >
        <FieldSet disabled={busy}>
          <Card>
            <CardHeader>
              <CardTitle>账号信息</CardTitle>
              <CardDescription>
                收款码、App ID
                和密钥应属于同一个支付宝收款账号。经营码也可以使用。
              </CardDescription>
            </CardHeader>
            <CardContent>
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
                  <FieldContent>
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
                <FieldSet>
                  <FieldLegend>开放平台应用</FieldLegend>
                  <Field data-invalid={!!errors.environment}>
                    <FieldLabel htmlFor="alipay-environment">
                      支付宝环境
                    </FieldLabel>
                    <Select
                      value={draft.environment}
                      onValueChange={(value) => {
                        if (value === "PRODUCTION" || value === "SANDBOX")
                          change("environment", value);
                      }}
                      items={[
                        { value: "PRODUCTION", label: "生产环境" },
                        { value: "SANDBOX", label: "沙箱环境" },
                      ]}
                    >
                      <SelectTrigger id="alipay-environment" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="PRODUCTION">生产环境</SelectItem>
                          <SelectItem value="SANDBOX">沙箱环境</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
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
                      先把下方应用公钥上传到支付宝，再复制支付宝页面显示的公钥填到这里。
                    </FieldDescription>
                    {errors.platform_public_key && (
                      <FieldError>{errors.platform_public_key}</FieldError>
                    )}
                  </Field>
                </FieldSet>
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
                <Collapsible>
                  <CollapsibleTrigger
                    render={<Button type="button" variant="ghost" size="sm" />}
                  >
                    导入已有应用私钥
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <Field className="pt-4" data-invalid={!!errors.private_key}>
                      <FieldLabel htmlFor="alipay-private-key">
                        应用私钥
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
                        已有应用密钥时使用。留空会保留当前密钥，保存后不回显私钥。
                      </FieldDescription>
                      {errors.private_key && (
                        <FieldError>{errors.private_key}</FieldError>
                      )}
                    </Field>
                  </CollapsibleContent>
                </Collapsible>
              </FieldGroup>
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || decoding}>
                {save.isPending && <Spinner data-icon="inline-start" />}
                {save.isPending ? "正在保存…" : "保存并检查"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || decoding || (!dirty && !!saved)}
                onClick={() => {
                  if (form.current?.reportValidity()) {
                    check.reset();
                    save.mutate(false);
                  }
                }}
              >
                保存草稿
              </Button>
              {saved && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || dirty}
                  onClick={() => check.mutate(saved.id)}
                >
                  <RefreshCw data-icon="inline-start" />
                  重新检查
                </Button>
              )}
            </CardFooter>
          </Card>
        </FieldSet>
      </form>
      <Card data-account-key-card>
        <CardHeader>
          <CardTitle>应用密钥</CardTitle>
          <CardDescription>
            应用私钥保存在服务器，只需把应用公钥上传到对应支付宝应用。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {!saved ? (
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
              <CopyValue
                value={pending.public_key}
                label="复制待启用应用公钥"
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
              <CopyValue
                value={saved.application_public_key}
                label="复制应用公钥"
              />
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
          {saved && (
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
      {saved && (
        <Card>
          <CardHeader>
            <CardTitle>使用情况</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{accountState(saved)}</Badge>
              <Badge variant="outline">{accountHealth(saved)}</Badge>
            </div>
            {saved.sites.length ? (
              <div className="flex flex-wrap gap-2">
                {saved.sites.map((site) => (
                  <Link
                    key={site.client_id}
                    to={"/sites/" + site.client_id + "/settings/collection"}
                    className={buttonVariants({ variant: "link", size: "sm" })}
                  >
                    {site.name}
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">尚未分配给网站。</p>
            )}
            <p className="text-sm text-muted-foreground">
              更新于 {dateTime(saved.updated_at)}
            </p>
          </CardContent>
          <CardFooter>
            <Button
              variant="destructive"
              disabled={busy || dirty || !saved.deletable}
              onClick={() => setConfirmation("delete")}
            >
              删除账号
            </Button>
            {!saved.deletable && (
              <span className="ml-3 text-sm text-muted-foreground">
                账号已被网站或订单使用，可暂停新订单。
              </span>
            )}
          </CardFooter>
        </Card>
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
    </div>
  );
}
