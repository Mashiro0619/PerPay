import { useEffect, useId, useRef, useState } from "react";
import { OverlayFormActions } from "@/components/overlay-actions";
import { useOverlayCloseGuard, useOverlayContext } from "@/lib/overlay-context";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  queryClient,
  result,
  type CreateSiteRequest,
  type SiteConfiguration,
} from "@/api/client";
import { useDirtyDraft, useOperationNavigation } from "@/drafts";
import { useNavigate, Link } from "@/navigation";
import { useFixedOperation } from "@/lib/fixed-operation";
import { createOperationKey } from "@/lib/idempotency";
import { SiteTextField } from "@/components/SitePolicyFields";
import { CollectionChoices } from "@/components/site-collection-fields";
import { alipayAccountsQuery, defaultSiteCollection, type AlipayAccount } from "@/lib/alipay-accounts";
import { ErrorNotice, QueryView } from "@/components/request-state";
import { OperationRecoveryNotice } from "@/components/operation-recovery-notice";
import { OperationNavigationDialog } from "@/components/operation-navigation-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
export default function CreateSite({ onCreated }: { onCreated?: (clientId: string) => void } = {}) {
  const accounts = useQuery(alipayAccountsQuery);
  const defaults = useQuery({
    queryKey: ["site-create-defaults"],
    queryFn: ({ signal }) => result(api.getSiteDefaults({ signal })),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <QueryView query={defaults}>
      {(response) => <QueryView query={accounts}>{accountResponse => <CreateSiteForm policy={response.data.policy} accounts={accountResponse.data} onCreated={onCreated} />}</QueryView>}
    </QueryView>
  );
}
function CreateSiteForm({ policy, accounts, onCreated }: { policy: SiteConfiguration["policy"]; accounts: readonly AlipayAccount[]; onCreated?: (clientId: string) => void }) {
  const overlay = useOverlayContext();
  const formId = useId();
  const [template] = useState(() => structuredClone(policy)),
    [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientIdValidation, setClientIdValidation] = useState<string>();
  const clientIdInput = useRef<HTMLInputElement>(null);
  const clientIdFieldId = formId + "-client-id";
  const [initialCollection] = useState(() => defaultSiteCollection(accounts));
  const [collection, setCollection] = useState(initialCollection);
  const creationConfirmed = useRef(false);
  const clear = useDirtyDraft(!!name || !!clientId || JSON.stringify(collection) !== JSON.stringify(initialCollection)),
    navigate = useNavigate(),
    key = useRef(createOperationKey()),
    form = useRef<HTMLFormElement>(null);
  const create = useFixedOperation({
    execute: (
      input: CreateSiteRequest,
      signal,
    ) => result(api.createSite({ body: input, signal })),
    onSuccess: (response) => {
      creationConfirmed.current = true;
      clear();
      queryClient.setQueryData(
        ["workspace-site", response.data.client_id],
        response,
      );
      void queryClient.invalidateQueries({ queryKey: ["sites"] });
      void queryClient.invalidateQueries({ queryKey: ["site-overview"] });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (onCreated) onCreated(response.data.client_id);
      else void navigate("/sites/" + response.data.client_id + (overlay ? "/edit?section=basic" : ""), overlay ? { replace: true } : undefined);
    },
    isSafeRejection: (error) =>
      error instanceof ApiError && error.status === 422,
  });
  const clientIdError = clientIdValidation ?? (create.error instanceof ApiError ? create.error.fields.client_id : undefined);
  const isClientIdRejection = !create.recovery && create.error instanceof ApiError
    && (create.error.status === 422 || create.error.status === 409) && !!create.error.fields.client_id;
  useEffect(() => {
    if (isClientIdRejection) clientIdInput.current?.focus();
  }, [create.error, isClientIdRejection]);
  const navigation = useOperationNavigation(
    create.isPending || !!create.recovery,
    () => !creationConfirmed.current && (create.isBusy() || !!create.recovery),
  );
  useOverlayCloseGuard(() => !creationConfirmed.current && create.isBusy());
  function submit() {
    creationConfirmed.current = false;
    if (create.recovery) {
      create.submit(create.recovery);
      return;
    }
    const normalizedClientId = clientId.trim();
    if (normalizedClientId && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(normalizedClientId)) {
      setClientIdValidation("请填写 3–64 位客户端 ID，首位为英文字母或数字，其余仅可包含英文字母、数字、点、下划线或连字符。");
      clientIdInput.current?.focus();
      return;
    }
    const configuration: SiteConfiguration = {
      name,
      accepting_orders: true,
      notifications_enabled: false,
      notification_origin: null,
      return_origin: null,
      policy: template,
      collection,
    };
    const input = { configuration, ...(normalizedClientId ? { client_id: normalizedClientId } : {}) };
    create.submit({ operation_id: key.current(input), ...input });
  }
  return (
    <div className="admin-settings-layout">
      <form
        id={formId}
        ref={form}
        className="max-w-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Card>
          {!overlay && <CardHeader>
            <CardTitle>创建业务网站</CardTitle>
          </CardHeader>}
          <CardContent>
            <FieldGroup>
              <ErrorNotice error={isClientIdRejection ? null : create.error} />
              <FieldSet disabled={create.isPending || !!create.recovery}>
                <SiteTextField
                  label="业务网站名称"
                  value={name}
                  required
                  maxLength={40}
                  error={
                    create.error instanceof ApiError
                      ? create.error.fields["configuration.name"]
                      : undefined
                  }
                  onChange={(value) => {
                    setName(value);
                    create.reset();
                  }}
                />
                <Field className="max-w-md" data-invalid={!!clientIdError} data-disabled={create.isPending || !!create.recovery}>
                  <FieldLabel htmlFor={clientIdFieldId}>客户端 ID（可选）</FieldLabel>
                  <Input
                    ref={clientIdInput}
                    id={clientIdFieldId}
                    value={clientId}
                    placeholder="shop"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={!!clientIdError}
                    aria-describedby={clientIdFieldId + "-description" + (clientIdError ? " " + clientIdFieldId + "-error" : "")}
                    onChange={event => {
                      if (!create.reset()) return;
                      setClientId(event.target.value);
                      setClientIdValidation(undefined);
                    }}
                  />
                  <FieldDescription id={clientIdFieldId + "-description"}>
                    留空自动生成，区分大小写。3–64 位，首位为英文字母或数字，其余可用英文字母、数字、点、下划线和连字符。
                  </FieldDescription>
                  {clientIdError && <FieldError id={clientIdFieldId + "-error"}>{clientIdError}</FieldError>}
                </Field>
                <CollectionChoices accounts={accounts} value={collection} onChange={value => { setCollection(value); create.reset(); }} disabled={create.isPending || !!create.recovery} error={create.error instanceof ApiError ? Object.entries(create.error.fields).find(([field]) => field.startsWith("configuration.collection"))?.[1] : undefined} />
              </FieldSet>
              {create.recovery && (
                <OperationRecoveryNotice
                  heading="创建结果待确认"
                  operationId={create.recovery.operation_id}
                  error={create.error}
                  conflict={create.conflict}
                />
              )}
            </FieldGroup>
          </CardContent>
          <OverlayFormActions className="gap-2">
            <Button
              type="submit"
              form={formId}
              disabled={create.isPending || create.conflict}
            >
              {create.isPending
                ? "正在创建…"
                : create.recovery
                  ? "重试上一次操作"
                  : "创建业务网站"}
            </Button>
            {overlay ? <Button type="button" variant="outline" onClick={() => overlay.requestClose()} disabled={create.isPending}>取消</Button> : <Link to="/sites" className={buttonVariants({ variant: "ghost" })}>
              取消
            </Link>}
          </OverlayFormActions>
        </Card>
      </form>
      <OperationNavigationDialog
        navigation={navigation}
        operationId={create.submitted?.operation_id}
        pending={create.isPending}
        finalFocus={() => form.current}
        onLeave={() => create.stopWaiting()}
      />
    </div>
  );
}
