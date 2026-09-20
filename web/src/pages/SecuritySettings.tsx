import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { Eye, KeyRound, MoreHorizontal, ShieldCheck } from "lucide-react";
import {
  api,
  result,
  type RuntimeSecretName,
  type RuntimeSettings,
} from "@/api/client";
import { useSession } from "@/auth";
import {
  MIN_ADMIN_PASSWORD_CHARACTERS,
  dateTime,
  validatePassword,
} from "@/lib/format";
import { useDirtyDraft, useDraftGuard } from "@/drafts";
import { CopyValue } from "@/components/copy-value";
import { StatusBadge } from "@/components/business-status";
import { ErrorNotice, Loading } from "@/components/request-state";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldSet,
  FieldGroup,
} from "@/components/ui/field";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
const secrets: Array<[RuntimeSecretName, string, string]> = [
  ["api_secret", "网站 API 密钥", "业务服务端请求签名"],
  ["webhook_secret", "通知签名密钥", "业务网站验证付款通知"],
  ["provider_private_key", "应用私钥", "PerPay 请求支付宝"],
  ["provider_public_key", "支付宝公钥", "验证支付宝返回的数据"],
];
export function SecuritySettings({
  settings,
  onSaved,
}: {
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings, message?: string) => void;
}) {
  const { requestDiscard } = useDraftGuard();
  const [reveal, setReveal] = useState<RuntimeSecretName | null>(null);
  const [rotate, setRotate] = useState(false);
  const [revoke, setRevoke] = useState(false);
  const session = useSession();
  const dialogOrigin = useRef<HTMLButtonElement | null>(null);
  const rotateTrigger = useRef<HTMLButtonElement | null>(null);
  const revokeTrigger = useRef<HTMLButtonElement | null>(null);
  const revokeAll = useMutation({
    mutationFn: () => result(api.revokeAllAdministratorSessions({ body: {} })),
    onSuccess: session.forget,
  });
  return (
    <>
      <div className="grid min-w-0 items-start gap-4 @5xl/settings:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>
              密钥
            </CardTitle>
            <CardDescription>API 客户端 ID：default</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用途</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {secrets.map(([name, title, purpose]) => {
                  const metadata = settings.secrets[name];
                  const status = (
                    <StatusBadge
                      value={metadata.configured ? "CONFIRMED" : "UNPAID"}
                      label={metadata.configured ? "已配置" : "未配置"}
                    />
                  );
                  return (
                    <TableRow key={name}>
                      <TableCell className="whitespace-normal py-3">
                        <div className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{title}</span>
                            {status}
                          </div>
                          <span className="text-sm text-muted-foreground">
                            {purpose}
                          </span>
                          {metadata.configured &&
                            metadata.updatedAt !== null && (
                              <time
                                className="text-xs text-muted-foreground"
                                dateTime={new Date(
                                  metadata.updatedAt,
                                ).toISOString()}
                              >
                                更新于 {dateTime(metadata.updatedAt)}
                              </time>
                            )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!metadata.configured}
                            onClick={(event) => {
                              dialogOrigin.current = event.currentTarget;
                              setReveal(name);
                            }}
                            aria-label={"查看" + title}
                          >
                            <Eye data-icon="inline-start" />
                            查看
                          </Button>
                          {name === "api_secret" &&
                            (settings.completion.api ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  render={
                                    <Button
                                      ref={rotateTrigger}
                                      size="icon-sm"
                                      variant="ghost"
                                      aria-label="API 密钥操作"
                                    />
                                  }
                                >
                                  <MoreHorizontal />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuGroup>
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onClick={() => {
                                        dialogOrigin.current =
                                          rotateTrigger.current;
                                        setRotate(true);
                                      }}
                                    >
                                      轮换 API 密钥
                                    </DropdownMenuItem>
                                  </DropdownMenuGroup>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : (
                              <Button
                                size="sm"
                                aria-label="生成 API 密钥"
                                onClick={(event) => {
                                  dialogOrigin.current = event.currentTarget;
                                  setRotate(true);
                                }}
                              >
                                <KeyRound data-icon="inline-start" />
                                生成
                              </Button>
                            ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <FieldGroup className="min-w-0 gap-4">
          <PasswordForm />
          <Card>
            <CardHeader>
              <CardTitle role="heading" aria-level={2}>
                登录会话
              </CardTitle>
              <CardDescription>注销所有设备上的管理员会话。</CardDescription>
              <CardAction>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        ref={revokeTrigger}
                        variant="ghost"
                        size="icon-sm"
                        aria-label="会话操作"
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => requestDiscard(() => setRevoke(true))}
                      >
                        注销全部会话
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardAction>
            </CardHeader>
          </Card>
        </FieldGroup>
      </div>
      {reveal && (
        <SecretDialog
          finalFocus={() => dialogOrigin.current}
          name={reveal}
          title={secrets.find(([name]) => name === reveal)?.[1] ?? "密钥"}
          onClose={() => setReveal(null)}
        />
      )}
      {rotate && (
        <RotateKeyDialog
          finalFocus={() => dialogOrigin.current}
          settings={settings}
          onSaved={onSaved}
          onClose={() => setRotate(false)}
        />
      )}
      <AlertDialog
        open={revoke}
        onOpenChange={(open, event) => {
          if (!open && revokeAll.isPending) event.cancel();
          else setRevoke(open);
        }}
      >
        <AlertDialogContent finalFocus={() => revokeTrigger.current}>
          <AlertDialogHeader>
            <AlertDialogTitle>注销全部会话？</AlertDialogTitle>
            <AlertDialogDescription>
              包括当前设备，所有管理员都需要重新登录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ErrorNotice error={revokeAll.error} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeAll.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revokeAll.isPending}
              onClick={() => {
                if (!revokeAll.isPending) revokeAll.mutate();
              }}
            >
              {revokeAll.isPending && (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              )}
              注销全部会话
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
function useSecretLifetime(active: boolean, onClose: () => void) {
  const close = useRef(onClose);
  const mounted = useRef(false);
  close.current = onClose;
  useLayoutEffect(() => {
    mounted.current = true;
    const hide = () => {
      if (document.hidden) {
        mounted.current = false;
        close.current();
      }
    };
    document.addEventListener("visibilitychange", hide);
    hide();
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      mounted.current = false;
      close.current();
    }, 60000);
    return () => window.clearTimeout(timer);
  }, [active]);
  return useCallback(() => mounted.current && !document.hidden, []);
}

export function SecretDialog({
  name,
  title,
  onClose,
  finalFocus,
}: {
  name: RuntimeSecretName;
  title: string;
  onClose: () => void;
  finalFocus?: (() => HTMLElement | null) | undefined;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const canDisplay = useSecretLifetime(value !== null, onClose);
  const reveal = useCallback(async () => {
    if (controller.current && !controller.current.signal.aborted) return;
    setPending(true);
    setError(null);
    const operation = new AbortController();
    controller.current = operation;
    try {
      const response = await result(
        api.revealRuntimeSecret({
          path: { name },
          body: {},
          signal: operation.signal,
        }),
      );
      if (!operation.signal.aborted && canDisplay())
        setValue(response.data.value);
    } catch (failure) {
      if (!operation.signal.aborted && canDisplay()) setError(failure);
    } finally {
      if (controller.current === operation) controller.current = null;
      if (!operation.signal.aborted && canDisplay()) setPending(false);
    }
  }, [name, canDisplay]);
  // This component mounts only after an explicit View click. No secret enters the query cache.
  useEffect(() => {
    void reveal();
    return () => {
      controller.current?.abort();
    };
  }, [reveal]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        finalFocus={finalFocus}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>60 秒后或切换标签页时自动清除。</DialogDescription>
        </DialogHeader>
        {pending && <Loading label="正在读取密钥…" />}
        {value !== null && (
          <CopyValue value={value} label={"复制" + title} secret />
        )}
        <ErrorNotice
          error={error}
          retry={
            pending
              ? undefined
              : () => {
                  void reveal();
                }
          }
        />
        <DialogFooter>
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
export function RotateKeyDialog({
  settings,
  onSaved,
  onClose,
  onStored,
  finalFocus,
}: {
  settings: RuntimeSettings;
  onSaved: (settings: RuntimeSettings, message?: string) => void;
  onClose: () => void;
  onStored?: () => void;
  finalFocus?: (() => HTMLElement | null) | undefined;
}) {
  const [replacing] = useState(settings.completion.api);
  const [revision] = useState(settings.revision);
  const [secret, setSecret] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const attempted = useRef(false);
  const canDisplay = useSecretLifetime(secret !== null, onClose);
  async function rotate() {
    if (attempted.current) return;
    attempted.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await result(
        api.rotateApiClientSecret({ body: { revision } }),
      );
      if (canDisplay()) setSecret(response.data.secret);
      onSaved(response.data.settings, "API 密钥已更新，请同步业务服务端。");
    } catch (failure) {
      if (canDisplay()) setError(failure);
    } finally {
      if (canDisplay()) setPending(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (!open) {
          if (pending) event.cancel();
          else onClose();
        }
      }}
    >
      <DialogContent
        finalFocus={finalFocus}
        showCloseButton={!pending}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {secret
              ? "新的 API 密钥"
              : replacing
                ? "轮换 API 密钥？"
                : "生成 API 密钥"}
          </DialogTitle>
          <DialogDescription>
            {secret
              ? "60 秒后或切换标签页时自动清除。"
              : replacing
                ? "旧密钥立即失效。轮换后需更新业务服务端，否则无法创建订单。"
                : "密钥仅用于业务网站后端。"}
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <>
            <CopyValue value={secret} label="复制新的 API 密钥" secret />
            <DialogFooter>
              <Button
                onClick={() => {
                  onClose();
                  onStored?.();
                }}
              >
                完成
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <ErrorNotice error={error} />
            {error !== null && (
              <p className="text-sm text-muted-foreground">
                结果未确认，请关闭后刷新配置并查看当前密钥。本次不再重试。
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={pending} onClick={onClose}>
                {error ? "关闭" : "取消"}
              </Button>
              <Button
                variant={replacing ? "destructive" : "default"}
                disabled={pending || attempted.current}
                onClick={() => {
                  void rotate();
                }}
              >
                {pending && (
                  <Spinner aria-hidden="true" data-icon="inline-start" />
                )}
                {replacing ? "确认轮换" : "生成密钥"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
function PasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState<Error | null>(null);
  const [invalidField, setInvalidField] = useState<
    "password" | "confirmation" | null
  >(null);
  useDirtyDraft(password !== "" || confirmation !== "");
  const session = useSession();
  const submitting = useRef(false);
  const change = useMutation({
    mutationFn: () =>
      result(
        api.changeAdministratorPassword({ body: { new_password: password } }),
      ),
    onSuccess: () => {
      setPassword("");
      setConfirmation("");
      session.forget();
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || change.isPending) return;
    const error =
      validatePassword(password) ??
      (password !== confirmation ? "两次输入的密码不一致。" : null);
    if (error) {
      const field = validatePassword(password) ? "password" : "confirmation";
      setInvalidField(field);
      setValidation(new Error(error));
      (
        event.currentTarget.elements.namedItem(
          field === "password" ? "new-password" : "confirm-password",
        ) as HTMLInputElement
      )?.focus();
      return;
    }
    submitting.current = true;
    setInvalidField(null);
    setValidation(null);
    change.mutate();
  }
  function edited() {
    setValidation(null);
    setInvalidField(null);
    change.reset();
  }

  return (
    <form onSubmit={submit} className="min-w-0">
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2}>
            修改密码
          </CardTitle>
          <CardDescription>修改后所有设备都需重新登录。</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldSet disabled={change.isPending}>
            <FieldGroup>
              <FieldGroup className="grid sm:grid-cols-2">
                <Field data-invalid={invalidField === "password"}>
                  <FieldLabel htmlFor="new-password">新密码</FieldLabel>
                  <Input
                    id="new-password"
                    name="new-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      edited();
                    }}
                    aria-invalid={invalidField === "password"}
                    aria-describedby={
                      invalidField === "password"
                        ? "password-hint new-password-error"
                        : "password-hint"
                    }
                  />
                  <FieldDescription id="password-hint">
                    至少 {MIN_ADMIN_PASSWORD_CHARACTERS} 个字符。
                  </FieldDescription>
                  {invalidField === "password" && (
                    <FieldError id="new-password-error">
                      {validation?.message}
                    </FieldError>
                  )}
                </Field>
                <Field data-invalid={invalidField === "confirmation"}>
                  <FieldLabel htmlFor="confirm-password">
                    再次输入新密码
                  </FieldLabel>
                  <Input
                    id="confirm-password"
                    name="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirmation}
                    onChange={(event) => {
                      setConfirmation(event.target.value);
                      edited();
                    }}
                    aria-invalid={invalidField === "confirmation"}
                    aria-describedby={
                      invalidField === "confirmation"
                        ? "confirm-password-error"
                        : undefined
                    }
                  />
                  {invalidField === "confirmation" && (
                    <FieldError id="confirm-password-error">
                      {validation?.message}
                    </FieldError>
                  )}
                </Field>
              </FieldGroup>
              <ErrorNotice error={change.error} />
            </FieldGroup>
          </FieldSet>
        </CardContent>
        <CardFooter className="justify-end">
          <Button
            type="submit"
            disabled={!password || !confirmation || change.isPending}
          >
            {change.isPending ? (
              <Spinner aria-hidden="true" data-icon="inline-start" />
            ) : (
              <ShieldCheck data-icon="inline-start" />
            )}
            修改并重新登录
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
