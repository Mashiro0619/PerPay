import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, KeyRound, RefreshCw } from "lucide-react";
import { ApiError, api, result, type RuntimeSettings } from "@/api/client";
import type {
  ActivateProviderApplicationKeyRequest,
  ApplicationKeyChangeActionRequest,
  RegenerateProviderApplicationKeyRequest,
} from "@/api/generated";
import { useDirtyDraft, useDraftGuard, useOperationNavigation } from "@/drafts";
import { OperationNavigationDialog } from "@/components/operation-navigation-dialog";
import {
  alipayApplicationUrl,
  applicationKeyState,
  canRegenerateApplicationKey,
} from "@/lib/application-key";
import { useFixedOperation } from "@/lib/fixed-operation";
import { SuccessMessage, useFeedback } from "@/components/Feedback";
import { CopyValue } from "@/components/copy-value";
import { ErrorNotice } from "@/components/request-state";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";

type ChangeMode = "regenerate" | "activate" | "discard";
type ChangeCommand =
  | { mode: "regenerate"; body: RegenerateProviderApplicationKeyRequest }
  | { mode: "activate"; body: ActivateProviderApplicationKeyRequest }
  | { mode: "discard"; body: ApplicationKeyChangeActionRequest };
type Saved = (settings: RuntimeSettings, message?: string) => void;
type ChangePresentation =
  | {
      kind: "dialog";
      onClose: () => void;
      finalFocus: () => HTMLElement | null;
    }
  | {
      kind: "guided";
      renderActions: (actions: ReactNode) => ReactNode;
      onReload: () => void;
      onLockChange: (locked: boolean) => void;
      onContinue: () => void;
    };

export function ApplicationKey({
  settings,
  onSaved,
  guided = false,
}: {
  settings: RuntimeSettings;
  onSaved: Saved;
  guided?: boolean;
}) {
  const { requestDiscard } = useDraftGuard();
  const keyState = applicationKeyState(settings);
  const pending = settings.pending_application_key;
  const [dialog, setDialog] = useState<ChangeMode | null>(null);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const dialogOrigin = useRef<HTMLElement | null>(null);
  const [success, setSuccess] = useFeedback();
  function saved(value: RuntimeSettings, message?: string) {
    setMaintenanceOpen(false);
    setSuccess(message ?? "");
    onSaved(value, message);
  }
  const generate = useMutation({
    mutationFn: () =>
      result(
        api.generateProviderApplicationKey({
          body: { revision: settings.revision },
        }),
      ),
    onSuccess: ({ data }) =>
      saved(
        data.settings,
        data.created ? "应用公钥已生成" : "已复用现有应用公钥",
      ),
  });
  function open(mode: ChangeMode, origin: HTMLElement) {
    dialogOrigin.current = origin;
    requestDiscard(() => {
      setSuccess("");
      setDialog(mode);
    });
  }
  const current = settings.application_public_key;
  const currentKey = current ? (
    <CopyValue value={current} label="复制应用公钥" />
  ) : null;
  return (
    <Card data-application-key-card>
      <CardHeader>
        {guided ? (
          <CardDescription>
            {pending
              ? "新的应用公钥（待启用）"
              : keyState === "missing"
                ? "首次生成"
                : "当前应用公钥"}
          </CardDescription>
        ) : (
          <>
            <CardTitle role="heading" aria-level={2}>
              应用公钥
            </CardTitle>
            {pending && (
              <CardDescription>新的应用公钥（待启用）</CardDescription>
            )}
          </>
        )}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {pending ? (
          <>
            <CopyValue value={pending.public_key} label="复制待启用应用公钥" />
            <p className="text-sm text-muted-foreground">
              当前仍使用原密钥。请将这把新公钥上传到支付宝应用{" "}
              <span className="break-all">{pending.app_id}</span>（
              {pending.environment === "PRODUCTION" ? "生产环境" : "沙箱环境"}
              ）。
              {guided
                ? "上传后点击下一步，填写支付宝公钥并验证启用。"
                : "然后复制上传后显示的支付宝公钥，填回 PerPay 验证并启用。"}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {!guided && (
                <Button
                  data-application-key-action
                  onClick={(event) => open("activate", event.currentTarget)}
                >
                  验证并启用
                </Button>
              )}
              <a
                data-application-key-action={guided ? "" : undefined}
                className={buttonVariants({ variant: "outline" })}
                href={alipayApplicationUrl(pending.app_id)}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开支付宝应用管理
              </a>
              <Button
                variant="ghost"
                onClick={(event) => open("discard", event.currentTarget)}
              >
                放弃新公钥
              </Button>
            </div>
            <Collapsible>
              <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
                <ChevronDown data-icon="inline-start" />
                查看当前使用的应用公钥
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="pt-3">{currentKey}</div>
              </CollapsibleContent>
            </Collapsible>
            <p className="text-sm text-muted-foreground">
              待启用密钥已保存，离开或刷新页面不会丢失，也不会自动启用。
            </p>
          </>
        ) : current ? (
          <>
            {guided ? (
              currentKey
            ) : (
              <Collapsible>
                <CollapsibleTrigger
                  render={<Button variant="outline" size="sm" />}
                >
                  查看应用公钥
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="pt-4">{currentKey}</div>
                </CollapsibleContent>
              </Collapsible>
            )}
            {canRegenerateApplicationKey(settings) ? (
              <Collapsible
                open={maintenanceOpen}
                onOpenChange={setMaintenanceOpen}
              >
                <CollapsibleTrigger
                  data-application-key-action
                  render={<Button variant="ghost" size="sm" />}
                >
                  <ChevronDown data-icon="inline-start" />
                  密钥维护
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="flex min-w-0 flex-col items-start gap-3 pt-3">
                    <p className="text-sm text-muted-foreground">
                      {settings.provider
                        ? "重新生成会同时生成配套私钥，验证启用前不会更换当前密钥。"
                        : "重新生成会同时更换配套私钥；此前复制或上传的应用公钥需要更新。"}
                    </p>
                    <Button
                      variant="outline"
                      onClick={(event) =>
                        open("regenerate", event.currentTarget)
                      }
                    >
                      <RefreshCw data-icon="inline-start" />
                      重新生成应用公钥
                    </Button>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <p className="text-sm text-muted-foreground">
                请先在常规设置中恢复支付宝接入配置，再更换此应用的公钥。
              </p>
            )}
          </>
        ) : keyState === "missing" ? (
          <>
            <Button
              className="w-fit"
              disabled={generate.isPending}
              onClick={() => requestDiscard(() => generate.mutate())}
            >
              {generate.isPending ? (
                <Spinner aria-hidden="true" data-icon="inline-start" />
              ) : (
                <KeyRound data-icon="inline-start" />
              )}
              生成应用公钥
            </Button>
            <p className="text-sm text-muted-foreground">
              同时生成配套的应用私钥，由 PerPay
              加密保存；只需将公钥上传到支付宝。
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            当前未能读取应用公钥，请在常规设置中检查支付宝接入配置。
          </p>
        )}
        <ErrorNotice error={generate.error} />
        <SuccessMessage message={success} multiline />
      </CardContent>
      {dialog && (
        <ApplicationKeyChange
          mode={dialog}
          settings={settings}
          onSaved={saved}
          presentation={{
            kind: "dialog",
            onClose: () => setDialog(null),
            finalFocus: () =>
              dialogOrigin.current?.isConnected
                ? dialogOrigin.current
                : document.querySelector<HTMLElement>(
                    "[data-application-key-action]",
                  ),
          }}
        />
      )}
    </Card>
  );
}

export function ApplicationKeyActivation({
  settings,
  onSaved,
  renderActions,
  onReload,
  onLockChange,
  onContinue,
}: {
  settings: RuntimeSettings;
  onSaved: Saved;
  renderActions: (actions: ReactNode) => ReactNode;
  onReload: () => void;
  onLockChange: (locked: boolean) => void;
  onContinue: () => void;
}) {
  return (
    <ApplicationKeyChange
      mode="activate"
      settings={settings}
      onSaved={onSaved}
      presentation={{
        kind: "guided",
        renderActions,
        onReload,
        onLockChange,
        onContinue,
      }}
    />
  );
}

function ApplicationKeyChange({
  mode,
  settings,
  onSaved,
  presentation,
}: {
  mode: ChangeMode;
  settings: RuntimeSettings;
  onSaved: Saved;
  presentation: ChangePresentation;
}) {
  const guided = presentation.kind === "guided";
  const formId = useId();
  const submitRef = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const operationFocus = () =>
    submitRef.current && !submitRef.current.disabled
      ? submitRef.current
      : refreshRef.current && !refreshRef.current.disabled
        ? refreshRef.current
        : headingRef.current;
  const completed = useRef(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  // Keep the operation identity and revision fixed while a request may be unresolved.
  const [initial] = useState(() => ({
    revision: settings.revision,
    changeId:
      settings.pending_application_key?.change_id ?? crypto.randomUUID(),
    fingerprint: settings.application_key_fingerprint!,
    appId:
      settings.pending_application_key?.app_id ?? settings.provider?.app_id,
    environment:
      settings.pending_application_key?.environment ??
      settings.provider?.environment,
  }));
  const [platformKey, setPlatformKey] = useState("");
  const [platformError, setPlatformError] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const platformField = useRef<HTMLTextAreaElement>(null);
  const operation = useFixedOperation<
    ChangeCommand,
    { settings: RuntimeSettings; message: string }
  >({
    execute: async (command, signal) => {
      if (command.mode === "regenerate") {
        const { data } = await result(
          api.regenerateProviderApplicationKey({ body: command.body, signal }),
        );
        return {
          settings: data.settings,
          message: data.settings.pending_application_key
            ? "新应用公钥已生成，上传到支付宝后再验证启用。"
            : "应用公钥已重新生成，请使用新的公钥配置支付宝。",
        };
      }
      if (command.mode === "activate") {
        const { data } = await result(
          api.activateProviderApplicationKey({ body: command.body, signal }),
        );
        return { settings: data, message: "应用公钥已验证并启用。" };
      }
      const { data } = await result(
        api.discardProviderApplicationKey({ body: command.body, signal }),
      );
      return { settings: data, message: "已放弃待启用公钥，当前密钥未更换。" };
    },
    isSafeRejection: (error) =>
      error instanceof ApiError &&
      error.status === 422 &&
      (error.code === "provider_application_key_verification_failed" ||
        Boolean(error.fields.platform_public_key)),
    // An already-activated change returns success/conflict, never a verification failure.
    confirmsNotApplied: (error, command) =>
      command.mode === "activate" &&
      error instanceof ApiError &&
      error.status === 422 &&
      error.code === "provider_application_key_verification_failed",
    onSuccess: (value) => {
      completed.current = true;
      clearDraft();
      setPlatformKey("");
      if (presentation.kind === "dialog") presentation.onClose();
      onSaved(value.settings, value.message);
      if (presentation.kind === "guided" && !navigation.blocked)
        presentation.onContinue();
      if (presentation.kind === "dialog")
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>("[data-application-key-action]")
            ?.focus(),
        );
    },
  });
  const clearDraft = useDirtyDraft(
    guided && platformKey !== "" && !completed.current,
  );
  const operationLocked = operation.isPending || Boolean(operation.recovery);
  const onLockChange =
    presentation.kind === "guided" ? presentation.onLockChange : undefined;
  useEffect(() => {
    onLockChange?.(operationLocked);
  }, [onLockChange, operationLocked]);
  useEffect(() => () => onLockChange?.(false), [onLockChange]);
  const navigation = useOperationNavigation(
    guided && operationLocked,
    () =>
      guided &&
      !completed.current &&
      (operation.isBusy() || Boolean(operation.recovery)),
  );
  const fieldError =
    platformError ??
    (operation.error instanceof ApiError
      ? operation.error.fields.platform_public_key
      : undefined);
  useEffect(() => {
    if (fieldError && !operation.isPending) platformField.current?.focus();
  }, [fieldError, operation.isPending]);
  const locked =
    operation.isPending || Boolean(operation.recovery) || operation.conflict;
  const title =
    mode === "regenerate"
      ? "重新生成应用公钥？"
      : mode === "activate"
        ? "验证并启用新应用公钥"
        : "放弃新公钥？";
  const description =
    mode === "regenerate"
      ? settings.provider
        ? "将生成一对新的应用公钥和私钥，并暂存为待启用状态。当前收款继续使用原密钥；上传到支付宝并验证通过后才会切换。"
        : "将生成一对新的应用公钥和私钥，替换尚未接入的原密钥对。此前复制或上传的应用公钥需要重新上传，不能只更换公钥。"
      : mode === "activate"
        ? "上传新应用公钥后，请复制支付宝页面显示的支付宝公钥并填入下方。PerPay 会用新私钥进行一次只读账单查询并验签，通过后才启用，不会发起支付。"
        : "仅删除 PerPay 暂存的新密钥，不会撤回支付宝侧的上传。若已上传，请先在支付宝恢复当前应用公钥，并在 PerPay 的支付宝设置中同步恢复后获取的支付宝公钥，再放弃，以免影响查账。";
  function submit() {
    if (
      operation.isBusy() ||
      operation.conflict ||
      (mode === "discard" && !confirmed)
    )
      return;
    if (mode === "activate" && !platformKey.trim()) {
      setPlatformError("请先上传新应用公钥，再填写上传后获取的支付宝公钥。");
      platformField.current?.focus();
      return;
    }
    if (mode === "regenerate")
      operation.submit({
        mode,
        body: {
          revision: initial.revision,
          change_id: initial.changeId,
          base_fingerprint: initial.fingerprint,
        },
      });
    else if (mode === "activate")
      operation.submit({
        mode,
        body: {
          revision: initial.revision,
          change_id: initial.changeId,
          platform_public_key: platformKey.trim(),
        },
      });
    else
      operation.submit({
        mode,
        body: { revision: initial.revision, change_id: initial.changeId },
      });
  }
  const fields = mode !== "regenerate" && (
    <FieldGroup>
      {mode === "activate" && (
        <Field data-invalid={Boolean(fieldError)} data-disabled={locked}>
          <FieldLabel htmlFor="activation-platform-key">支付宝公钥</FieldLabel>
          <Textarea
            id="activation-platform-key"
            name="platform_public_key"
            ref={platformField}
            rows={4}
            value={platformKey}
            onChange={(event) => {
              setPlatformKey(event.target.value);
              setPlatformError(undefined);
              operation.reset();
            }}
            disabled={locked}
            required
            maxLength={16384}
            autoComplete="off"
            spellCheck={false}
            placeholder="粘贴本次上传后获取的支付宝公钥"
            aria-invalid={Boolean(fieldError)}
            aria-describedby={
              fieldError
                ? "activation-platform-hint activation-platform-error"
                : "activation-platform-hint"
            }
          />
          <FieldDescription id="activation-platform-hint">
            必填。请从同一支付宝应用重新复制，不会自动沿用旧值。
          </FieldDescription>
          {fieldError && (
            <FieldError id="activation-platform-error">{fieldError}</FieldError>
          )}
        </Field>
      )}
      {mode === "discard" && (
        <Field orientation="horizontal" data-disabled={locked}>
          <Checkbox
            id="application-key-confirmed"
            checked={confirmed}
            onCheckedChange={setConfirmed}
            disabled={locked}
          />
          <FieldLabel htmlFor="application-key-confirmed" className="min-h-11">
            我尚未上传新公钥，或已恢复原配置并同步支付宝公钥
          </FieldLabel>
        </Field>
      )}
    </FieldGroup>
  );
  const feedback = (
    <>
      <ErrorNotice error={operation.error} />
      {operation.recovery && (
        <p className="text-sm text-muted-foreground">
          {guided
            ? "上次启用结果尚未确认。重试会保留同一操作和原公钥；也可刷新配置核对启用状态。"
            : "上次操作结果尚未确认。重试会使用同一个操作，不会再生成另一把密钥；也可关闭后刷新状态。"}
        </p>
      )}
      {operation.conflict && (
        <p className="text-sm text-muted-foreground">
          {guided
            ? "配置已变化，请刷新配置，核对当前公钥和待启用状态。"
            : "配置已变化，请关闭弹窗后刷新，核对当前公钥和待启用状态。"}
        </p>
      )}
    </>
  );
  const submitButton = (
    <Button
      ref={submitRef}
      type="submit"
      form={formId}
      variant={mode === "discard" ? "destructive" : "default"}
      disabled={
        operation.isPending ||
        operation.conflict ||
        (mode === "discard" && !confirmed)
      }
    >
      {operation.isPending && (
        <Spinner aria-hidden="true" data-icon="inline-start" />
      )}
      {operation.recovery
        ? "重试同一操作"
        : mode === "regenerate"
          ? "生成新公钥"
          : mode === "activate"
            ? guided
              ? "验证并启用后继续"
              : "验证并启用"
            : "确认放弃"}
    </Button>
  );
  if (presentation.kind === "guided")
    return (
      <>
        <form
          id={formId}
          aria-label="验证并启用新应用公钥"
          noValidate
          className="flex min-w-0 flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Card data-application-key-activation>
            <CardHeader>
              <CardTitle
                ref={headingRef}
                role="heading"
                aria-level={3}
                tabIndex={-1}
                className="outline-none"
              >
                验证并启用新应用公钥
              </CardTitle>
              <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-col gap-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="activation-app-id">
                    应用 ID（App ID）
                  </FieldLabel>
                  <Input
                    id="activation-app-id"
                    value={initial.appId ?? ""}
                    readOnly
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="activation-environment">
                    支付宝环境
                  </FieldLabel>
                  <Input
                    id="activation-environment"
                    value={
                      initial.environment === "PRODUCTION"
                        ? "生产环境"
                        : "沙箱环境"
                    }
                    readOnly
                  />
                </Field>
                {fields}
              </FieldGroup>
              <p className="text-sm text-muted-foreground">
                本次只更新上述应用的密钥，保留当前账本采集参数。
              </p>
              {feedback}
            </CardContent>
          </Card>
          {presentation.renderActions(
            <div className="flex flex-wrap items-center gap-2">
              {(operation.conflict || operation.recovery) && (
                <Button
                  ref={refreshRef}
                  type="button"
                  variant="outline"
                  disabled={operation.isPending}
                  onClick={() => {
                    if (operation.isBusy()) return;
                    if (operation.recovery) setConfirmRefresh(true);
                    else presentation.onReload();
                  }}
                >
                  刷新配置
                </Button>
              )}
              {submitButton}
            </div>,
          )}
        </form>
        <OperationNavigationDialog
          navigation={navigation}
          operationId={initial.changeId}
          pending={operation.isPending}
          finalFocus={operationFocus}
          onLeave={() => {
            completed.current = true;
            clearDraft();
            operation.stopWaiting();
          }}
          description={
            operation.isPending
              ? "正在等待启用结果。离开只会停止本页等待，不会撤销已完成的启用。稍后请返回“支付宝接入”刷新核对，不要直接再次换钥。"
              : "本次启用可能已生效。离开会关闭原请求的重试入口；稍后请返回“支付宝接入”刷新核对。"
          }
        />
        <AlertDialog open={confirmRefresh} onOpenChange={setConfirmRefresh}>
          <AlertDialogContent
            finalFocus={operationFocus}
            className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto"
          >
            <AlertDialogHeader>
              <AlertDialogTitle>刷新并核对启用结果？</AlertDialogTitle>
              <AlertDialogDescription>
                上次启用可能已完成。刷新会重新读取配置并清除本页填写的支付宝公钥，不会再次发起启用。若尚未启用，需要重新填写公钥。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {operation.conflict ? "暂不刷新" : "保留并重试"}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  clearDraft();
                  setConfirmRefresh(false);
                  presentation.onReload();
                }}
              >
                刷新配置
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (!open && operation.isPending) event.cancel();
        else if (!open) presentation.onClose();
      }}
    >
      <DialogContent
        finalFocus={presentation.finalFocus}
        showCloseButton={!operation.isPending}
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          noValidate
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {initial.appId && (
            <p className="text-sm text-muted-foreground">
              支付宝应用：<span className="break-all">{initial.appId}</span>（
              {initial.environment === "PRODUCTION" ? "生产环境" : "沙箱环境"}）
            </p>
          )}
          {fields}
          {feedback}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={operation.isPending}
              onClick={presentation.onClose}
            >
              取消
            </Button>
            {submitButton}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
