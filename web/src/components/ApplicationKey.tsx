import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, KeyRound, RefreshCw } from "lucide-react";
import { ApiError, api, result, type RuntimeSettings } from "@/api/client";
import type {
  ActivateProviderApplicationKeyRequest,
  ApplicationKeyChangeActionRequest,
  RegenerateProviderApplicationKeyRequest,
} from "@/api/generated";
import { useDraftGuard } from "@/drafts";
import {
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
import { Checkbox } from "@/components/ui/checkbox";

type ChangeMode = "regenerate" | "activate" | "discard";
type ChangeCommand =
  | { mode: "regenerate"; body: RegenerateProviderApplicationKeyRequest }
  | { mode: "activate"; body: ActivateProviderApplicationKeyRequest }
  | { mode: "discard"; body: ApplicationKeyChangeActionRequest };
type Saved = (settings: RuntimeSettings, message?: string) => void;

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
  const dialogOrigin = useRef<HTMLElement | null>(null);
  const [success, setSuccess] = useFeedback();
  function saved(value: RuntimeSettings, message?: string) {
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
              ），然后复制上传后显示的支付宝公钥，填回 PerPay 验证并启用。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                data-application-key-action
                onClick={(event) => open("activate", event.currentTarget)}
              >
                验证并启用
              </Button>
              <a
                className={buttonVariants({ variant: "outline" })}
                href="https://open.alipay.com/develop/manage"
                target="_blank"
                rel="noreferrer"
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
              <>
                <Button
                  className="w-fit"
                  variant="outline"
                  data-application-key-action
                  onClick={(event) => open("regenerate", event.currentTarget)}
                >
                  <RefreshCw data-icon="inline-start" />
                  重新生成应用公钥
                </Button>
                <p className="text-sm text-muted-foreground">
                  {settings.provider
                    ? "重新生成会同时生成配套私钥，验证启用前不会更换当前密钥。"
                    : "重新生成会同时更换配套私钥；此前复制或上传的应用公钥需要更新。"}
                </p>
              </>
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
        <ApplicationKeyChangeDialog
          mode={dialog}
          settings={settings}
          onSaved={saved}
          onClose={() => setDialog(null)}
          finalFocus={() =>
            dialogOrigin.current?.isConnected
              ? dialogOrigin.current
              : document.querySelector<HTMLElement>(
                  "[data-application-key-action]",
                )
          }
        />
      )}
    </Card>
  );
}

function ApplicationKeyChangeDialog({
  mode,
  settings,
  onSaved,
  onClose,
  finalFocus,
}: {
  mode: ChangeMode;
  settings: RuntimeSettings;
  onSaved: Saved;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  // Keep the operation identity and revision fixed while a request may be unresolved.
  const [initial] = useState(() => ({
    revision: settings.revision,
    changeId:
      settings.pending_application_key?.change_id ?? crypto.randomUUID(),
    fingerprint: settings.application_key_fingerprint!,
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
      onClose();
      onSaved(value.settings, value.message);
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>("[data-application-key-action]")
          ?.focus(),
      );
    },
  });
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
  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (!open && operation.isPending) event.cancel();
        else if (!open) onClose();
      }}
    >
      <DialogContent
        finalFocus={finalFocus}
        showCloseButton={!operation.isPending}
        className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {settings.provider && (
            <p className="text-sm text-muted-foreground">
              支付宝应用：
              <span className="break-all">{settings.provider.app_id}</span>（
              {settings.provider.environment === "PRODUCTION"
                ? "生产环境"
                : "沙箱环境"}
              ）
            </p>
          )}
          {mode !== "regenerate" && (
            <FieldGroup>
              {mode === "activate" && (
                <Field
                  data-invalid={Boolean(fieldError)}
                  data-disabled={locked}
                >
                  <FieldLabel htmlFor="activation-platform-key">
                    支付宝公钥
                  </FieldLabel>
                  <Textarea
                    id="activation-platform-key"
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
                    必填。请从同一支付宝应用重新复制，不是 PerPay
                    生成的应用公钥；不会自动沿用旧值。
                  </FieldDescription>
                  {fieldError && (
                    <FieldError id="activation-platform-error">
                      {fieldError}
                    </FieldError>
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
                  <FieldLabel
                    htmlFor="application-key-confirmed"
                    className="min-h-11"
                  >
                    我尚未上传新公钥，或已恢复原配置并同步支付宝公钥
                  </FieldLabel>
                </Field>
              )}
            </FieldGroup>
          )}
          <ErrorNotice error={operation.error} />
          {operation.recovery && (
            <p className="text-sm text-muted-foreground">
              上次操作结果尚未确认。重试会使用同一个操作，不会再生成另一把密钥；也可关闭后刷新状态。
            </p>
          )}
          {operation.conflict && (
            <p className="text-sm text-muted-foreground">
              配置已变化，请关闭弹窗后刷新，核对当前公钥和待启用状态。
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={operation.isPending}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              type="submit"
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
                    ? "验证并启用"
                    : "确认放弃"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
