import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  ApiError,
  queryClient,
  result,
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
import { FieldGroup, FieldSet } from "@/components/ui/field";
import {
  Card,
  CardContent,
  CardFooter,
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
  const [template] = useState(() => structuredClone(policy)),
    [name, setName] = useState("");
  const [initialCollection] = useState(() => defaultSiteCollection(accounts));
  const [collection, setCollection] = useState(initialCollection);
  const clear = useDirtyDraft(!!name || JSON.stringify(collection) !== JSON.stringify(initialCollection)),
    navigate = useNavigate(),
    key = useRef(createOperationKey()),
    form = useRef<HTMLFormElement>(null);
  const create = useFixedOperation({
    execute: (
      input: { operation_id: string; configuration: SiteConfiguration },
      signal,
    ) => result(api.createSite({ body: input, signal })),
    onSuccess: (response) => {
      clear();
      queryClient.setQueryData(
        ["workspace-site", response.data.client_id],
        response,
      );
      void queryClient.invalidateQueries({ queryKey: ["sites"] });
      void queryClient.invalidateQueries({ queryKey: ["site-overview"] });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (onCreated) onCreated(response.data.client_id);
      else void navigate("/sites/" + response.data.client_id);
    },
    isSafeRejection: (error) =>
      error instanceof ApiError && error.status === 422,
  });
  const navigation = useOperationNavigation(
    create.isPending || !!create.recovery,
    () => create.isBusy() || !!create.recovery,
  );
  function submit() {
    const configuration: SiteConfiguration = {
      name,
      accepting_orders: true,
      notifications_enabled: false,
      notification_origin: null,
      return_origin: null,
      policy: template,
      collection,
    };
    create.submit({ operation_id: key.current(configuration), configuration });
  }
  return (
    <div className="admin-settings-layout">
      <form
        ref={form}
        className="max-w-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle>创建业务网站</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <ErrorNotice error={create.error} />
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
          <CardFooter className="gap-2">
            <Button
              type="submit"
              disabled={create.isPending || create.conflict}
            >
              {create.isPending
                ? "正在创建…"
                : create.recovery
                  ? "重试上一次操作"
                  : "创建业务网站"}
            </Button>
            <Link to="/sites" className={buttonVariants({ variant: "ghost" })}>
              取消
            </Link>
          </CardFooter>
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
