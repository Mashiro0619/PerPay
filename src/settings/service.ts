import { randomBytes, randomUUID } from "node:crypto";

import type { ProviderIdentityActivation } from "../ledger/model.ts";

import {
  advancedSettingsInputSchema,
  collectionSettingsInputSchema,
  generateProviderApplicationKey,
  parseProviderApplicationPrivateKey,
  parseProviderKeys,
  parseWebhookOrigin,
  providerEndpoint,
  providerSettingsInputSchema,
  webhookSettingsInputSchema,
  type AdvancedSettingsInput,
  type CollectionSettingsInput,
  type ApiCredentialSnapshot,
  type ProviderSettingsInput,
  type RuntimeSecretName,
  type RuntimeSettingsSnapshot,
  type WebhookSettingsInput,
} from "./model.ts";
import {
  RuntimeSettingsStore,
  SettingsError,
  type SettingsAuditContext,
} from "./store.ts";

export interface RuntimeSettingsView {
  readonly revision: number;
  readonly payment_revision: number;
  readonly updated_at: string;
  readonly completion: {
    readonly complete: boolean;
    readonly application_key: boolean;
    readonly collection: boolean;
    readonly provider: boolean;
    readonly api: boolean;
    readonly notifications: boolean;
    readonly next_step:
      | "GENERATE_APPLICATION_KEY"
      | "CONFIGURE_PROVIDER"
      | "CONFIGURE_COLLECTION"
      | "GENERATE_API_KEY"
      | null;
  };
  readonly collection: {
    readonly code_payload: string;
    readonly order_ttl_seconds: number;
    readonly amount_offset_maximum_cents: number;
  } | null;
  readonly provider: {
    readonly environment: "PRODUCTION" | "SANDBOX";
    readonly app_id: string;
    readonly provider_account_key: string;
    readonly timeout_milliseconds: number;
    readonly scan_interval_seconds: number;
    readonly maximum_success_age_seconds: number;
  } | null;
  readonly application_public_key: string | null;
  readonly application_key_fingerprint: string | null;
  readonly provider_generations: readonly {
    readonly provider_account_key: string;
    readonly app_id: string;
    readonly environment: "PRODUCTION" | "SANDBOX";
    readonly activated_at: string;
    readonly active: boolean;
  }[];
  readonly notifications: {
    readonly enabled: boolean;
    readonly allowed_origin: string | null;
    readonly timeout_milliseconds: number;
    readonly maximum_attempts: number;
    readonly retry_base_seconds: number;
    readonly retry_maximum_seconds: number;
  };
  readonly advanced: {
    readonly checkout_key_rotation_days: number;
    readonly checkout_terminal_observation_seconds: number;
  };
  readonly secrets: Readonly<Record<RuntimeSecretName, ReturnType<RuntimeSettingsStore["secretMetadata"]>>>;
}

export type ProviderSwitchGuard = (input: {
  readonly current: RuntimeSettingsSnapshot;
  readonly currentProviderAccountKey: string;
  readonly nextAppId: string;
  readonly nextEndpoint: string;
}) => void | Promise<void>;

export type SettingsApplied = (snapshot: RuntimeSettingsSnapshot) => void | Promise<void>;
export type PaymentMutationStarted = () => void | Promise<void>;
export type CollectionApplied = (
  collection: NonNullable<RuntimeSettingsSnapshot["collection"]>,
  providerAccountKey: string,
) => void | Promise<void>;
export type ProviderHistory = () => readonly ProviderIdentityActivation[];

export class RuntimeSettingsService {
  readonly #store: RuntimeSettingsStore;
  readonly #guardProviderSwitch: ProviderSwitchGuard;
  readonly #onApplied: SettingsApplied;
  readonly #onCollectionApplied: CollectionApplied;
  readonly #onPaymentMutationStarted: PaymentMutationStarted;
  readonly #providerHistory: ProviderHistory;
  #mutation: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly store: RuntimeSettingsStore;
    readonly guardProviderSwitch?: ProviderSwitchGuard | undefined;
    readonly onApplied?: SettingsApplied | undefined;
    readonly onCollectionApplied?: CollectionApplied | undefined;
    readonly onPaymentMutationStarted?: PaymentMutationStarted | undefined;
    readonly providerHistory?: ProviderHistory | undefined;
  }) {
    this.#store = options.store;
    this.#guardProviderSwitch = options.guardProviderSwitch ?? (() => undefined);
    this.#onApplied = options.onApplied ?? (() => undefined);
    this.#onCollectionApplied = options.onCollectionApplied ?? (() => undefined);
    this.#onPaymentMutationStarted = options.onPaymentMutationStarted ?? (() => undefined);
    this.#providerHistory = options.providerHistory ?? (() => []);
  }

  initialize(): RuntimeSettingsSnapshot {
    this.#store.initialize();
    return this.#store.snapshot();
  }

  snapshot(): RuntimeSettingsSnapshot {
    return this.#store.snapshot();
  }

  apiCredential(): ApiCredentialSnapshot | null {
    return this.#store.apiCredential();
  }

  status() {
    return this.#store.status();
  }

  view(): RuntimeSettingsView {
    const snapshot = this.#store.snapshot();
    const status = this.#store.status();
    const applicationKey = this.#store.providerApplicationKey();
    return {
      revision: snapshot.revision,
      payment_revision: snapshot.paymentRevision,
      updated_at: new Date(snapshot.updatedAt).toISOString(),
      completion: {
        complete: status.complete,
        application_key: applicationKey !== null,
        collection: status.collectionConfigured,
        provider: status.providerConfigured,
        api: status.apiConfigured,
        notifications: status.notificationConfigured,
        next_step: configurationNextStep({
          applicationKeyConfigured: applicationKey !== null,
          providerConfigured: status.providerConfigured,
          collectionConfigured: status.collectionConfigured,
          apiConfigured: status.apiConfigured,
        }),
      },
      collection: snapshot.collection
        ? {
            code_payload: snapshot.collection.codePayload,
            order_ttl_seconds: snapshot.collection.orderTtlSeconds,
            amount_offset_maximum_cents: snapshot.collection.amountOffsetMaximumCents,
          }
        : null,
      provider: snapshot.provider && snapshot.activeProviderAccountKey
        ? {
            environment: snapshot.provider.environment,
            app_id: snapshot.provider.appId,
            provider_account_key: snapshot.activeProviderAccountKey,
            timeout_milliseconds: snapshot.provider.timeoutMilliseconds,
            scan_interval_seconds: snapshot.provider.scanIntervalMilliseconds / 1_000,
            maximum_success_age_seconds: snapshot.provider.maximumSuccessAgeMilliseconds / 1_000,
          }
        : null,
      application_public_key: applicationKey?.uploadPublicKey ?? null,
      application_key_fingerprint: applicationKey?.fingerprint ?? null,
      provider_generations: Object.freeze(this.#providerHistory().map((generation) => ({
        provider_account_key: generation.providerAccountKey,
        app_id: generation.externalAccountId,
        environment: generation.endpoint === providerEndpoint("SANDBOX")
          ? "SANDBOX" as const
          : "PRODUCTION" as const,
        activated_at: new Date(generation.activatedAt).toISOString(),
        active: generation.providerAccountKey === snapshot.activeProviderAccountKey,
      }))),
      notifications: {
        enabled: snapshot.webhook.enabled,
        allowed_origin: snapshot.webhook.allowedOrigin,
        timeout_milliseconds: snapshot.webhook.timeoutMilliseconds,
        maximum_attempts: snapshot.webhook.maximumAttempts,
        retry_base_seconds: snapshot.webhook.retryBaseMilliseconds / 1_000,
        retry_maximum_seconds: snapshot.webhook.retryMaximumMilliseconds / 1_000,
      },
      advanced: {
        checkout_key_rotation_days: snapshot.advanced.checkoutKeyRotationDays,
        checkout_terminal_observation_seconds:
          snapshot.advanced.checkoutTerminalObservationSeconds,
      },
      secrets: {
        api_secret: this.#store.secretMetadata("api_secret"),
        provider_private_key: this.#store.secretMetadata("provider_private_key"),
        provider_public_key: this.#store.secretMetadata("provider_public_key"),
        webhook_secret: this.#store.secretMetadata("webhook_secret"),
      },
    };
  }

  saveCollection(input: CollectionSettingsInput, audit: SettingsAuditContext): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      let committed = false;
      let transitionStarted = false;
      try {
        const parsed = collectionSettingsInputSchema.parse(input);
        transitionStarted = true;
        await this.#onPaymentMutationStarted();
        const snapshot = this.#store.saveCollection(parsed, audit);
        committed = true;
        const collection = snapshot.collection;
        if (!collection) throw new Error("collection settings were not published");
        await this.#applyCommitted(snapshot, async () => {
          if (snapshot.activeProviderAccountKey !== null) {
            await this.#onCollectionApplied(collection, snapshot.activeProviderAccountKey);
          }
        });
        return this.view();
      } catch (error) {
        if (!committed && transitionStarted) await this.#restoreCurrentRuntime(error);
        throw error;
      }
    });
  }

  saveProvider(input: ProviderSettingsInput, audit: SettingsAuditContext): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      let committed = false;
      let transitionStarted = false;
      try {
        const parsed = providerSettingsInputSchema.parse(input);
        const current = this.#store.snapshot();
        if (current.revision !== parsed.revision) throw revisionConflict(parsed.revision, current.revision);
        const endpoint = providerEndpoint(parsed.environment);
        const historicalActive = latestProviderGeneration(this.#providerHistory());
        const currentProviderAccountKey = current.activeProviderAccountKey ??
          historicalActive?.providerAccountKey ?? null;
        const currentAppId = current.provider?.appId ?? historicalActive?.externalAccountId ?? null;
        const currentEndpoint = current.provider?.endpoint ?? historicalActive?.endpoint ?? null;
        const identityChanged = currentAppId !== parsed.app_id || currentEndpoint !== endpoint;
        const stagedApplicationKey = current.provider === null && currentProviderAccountKey === null
          ? this.#store.providerApplicationKey()
          : null;
        if (stagedApplicationKey && parsed.private_key !== undefined) {
          const suppliedApplicationKey = parseProviderApplicationPrivateKey(parsed.private_key);
          if (suppliedApplicationKey.fingerprint !== stagedApplicationKey.fingerprint) {
            throw new RangeError(
              "the supplied application private key does not match the generated application public key",
            );
          }
        }
        if (current.provider !== null && !identityChanged && parsed.private_key !== undefined) {
          const suppliedApplicationKey = parseProviderApplicationPrivateKey(parsed.private_key);
          if (
            suppliedApplicationKey.fingerprint !== current.provider.applicationKeyFingerprint
          ) {
            throw new SettingsError(
              "provider_application_key_rotation_not_supported",
              "the active provider application key cannot be replaced without a two-phase rotation",
            );
          }
        }
        const privateKeyPem = stagedApplicationKey?.privateKeyPem ?? parsed.private_key ??
          current.provider?.privateKeyPem ?? null;
        if (
          privateKeyPem === null &&
          current.provider === null &&
          currentProviderAccountKey === null &&
          parsed.private_key === undefined
        ) {
          throw new SettingsError(
            "provider_application_key_missing",
            "generate an application key before configuring the provider",
          );
        }
        const publicKeyPem = parsed.platform_public_key ?? (
          identityChanged ? null : current.provider?.publicKeyPem ?? null
        );
        if (!privateKeyPem || !publicKeyPem) {
          throw new RangeError("both provider keys are required for a new collection application");
        }
        const provider = parseProviderKeys({
          environment: parsed.environment,
          appId: parsed.app_id,
          privateKey: privateKeyPem,
          publicKey: publicKeyPem,
          timeoutMilliseconds: parsed.timeout_milliseconds,
          scanIntervalMilliseconds: parsed.scan_interval_seconds * 1_000,
          maximumSuccessAgeMilliseconds: parsed.maximum_success_age_seconds * 1_000,
        });
        transitionStarted = true;
        await this.#onPaymentMutationStarted();
        if (identityChanged && currentProviderAccountKey !== null) {
          await this.#guardProviderSwitch({
            current,
            currentProviderAccountKey,
            nextAppId: parsed.app_id,
            nextEndpoint: endpoint,
          });
        }
        const accountKey = identityChanged
          ? `source:${randomUUID()}`
          : currentProviderAccountKey ?? `source:${randomUUID()}`;
        const snapshot = this.#store.saveProvider({
          expectedRevision: parsed.revision,
          accountKey,
          environment: parsed.environment,
          appId: parsed.app_id,
          privateKeyPem: provider.privateKeyPem,
          publicKeyPem: provider.publicKeyPem,
          privateKeyFingerprint: provider.applicationKeyFingerprint,
          publicKeyFingerprint: provider.platformKeyFingerprint,
          timeoutMilliseconds: provider.timeoutMilliseconds,
          scanIntervalMilliseconds: provider.scanIntervalMilliseconds,
          maximumSuccessAgeMilliseconds: provider.maximumSuccessAgeMilliseconds,
          providerIdentity: {
            endpoint: provider.endpoint,
            externalAccountId: provider.appId,
          },
          audit,
        });
        committed = true;
        await this.#applyCommitted(snapshot, async () => {
          if (snapshot.collection) {
            await this.#onCollectionApplied(snapshot.collection, accountKey);
          }
        });
        return this.view();
      } catch (error) {
        if (!committed && transitionStarted) await this.#restoreCurrentRuntime(error);
        throw error;
      }
    });
  }

  generateProviderApplicationKey(
    expectedRevision: number,
    audit: SettingsAuditContext,
  ): Promise<{
    readonly created: boolean;
    readonly settings: RuntimeSettingsView;
    readonly public_key: string;
    readonly fingerprint: string;
  }> {
    return this.#exclusive(async () => {
      const current = this.#store.snapshot();
      if (
        current.provider !== null ||
        current.activeProviderAccountKey !== null ||
        this.#providerHistory().length > 0
      ) {
        throw new SettingsError(
          "provider_application_key_rotation_not_supported",
          "an application key cannot be generated after a provider generation has been created",
        );
      }
      const existing = this.#store.providerApplicationKey();
      if (existing !== null) {
        if (expectedRevision > current.revision) {
          throw revisionConflict(expectedRevision, current.revision);
        }
        return {
          created: false,
          settings: this.view(),
          public_key: existing.uploadPublicKey,
          fingerprint: existing.fingerprint,
        };
      }
      if (current.revision !== expectedRevision) {
        throw revisionConflict(expectedRevision, current.revision);
      }
      const generated = await generateProviderApplicationKey();
      this.#store.saveGeneratedProviderApplicationKey({
        expectedRevision,
        privateKeyPem: generated.privateKeyPem,
        fingerprint: generated.fingerprint,
        audit,
      });
      return {
        created: true,
        settings: this.view(),
        public_key: generated.uploadPublicKey,
        fingerprint: generated.fingerprint,
      };
    });
  }

  rotateApiSecret(expectedRevision: number, audit: SettingsAuditContext): Promise<{
    readonly settings: RuntimeSettingsView;
    readonly client_id: "default";
    readonly secret: string;
  }> {
    return this.#exclusive(async () => {
      const secret = randomBytes(32).toString("base64url");
      const snapshot = this.#store.saveApiSecret(secret, expectedRevision, audit);
      await this.#applyCommitted(snapshot);
      return { settings: this.view(), client_id: "default", secret };
    });
  }

  saveWebhook(input: WebhookSettingsInput, audit: SettingsAuditContext): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      const parsed = webhookSettingsInputSchema.parse(input);
      const current = this.#store.snapshot();
      if (current.revision !== parsed.revision) throw revisionConflict(parsed.revision, current.revision);
      const allowedOrigin = parsed.enabled ? parseWebhookOrigin(parsed.allowed_origin ?? "") : undefined;
      const secret = parsed.enabled && current.webhook.secret === null
        ? randomBytes(32).toString("base64url")
        : null;
      const snapshot = this.#store.saveWebhook({
        ...parsed,
        ...(allowedOrigin === undefined ? {} : { allowed_origin: allowedOrigin }),
        secret,
      }, audit);
      await this.#applyCommitted(snapshot);
      return this.view();
    });
  }

  saveAdvanced(input: AdvancedSettingsInput, audit: SettingsAuditContext): Promise<RuntimeSettingsView> {
    return this.#exclusive(async () => {
      const parsed = advancedSettingsInputSchema.parse(input);
      this.#store.saveAdvanced(parsed, audit);
      return this.view();
    });
  }

  revealSecret(name: RuntimeSecretName, audit: SettingsAuditContext): string {
    return this.#store.reveal(name, audit);
  }

  async #applyCommitted(
    snapshot: RuntimeSettingsSnapshot,
    beforeApply?: (() => void | Promise<void>) | undefined,
  ): Promise<void> {
    const apply = async () => {
      await beforeApply?.();
      await this.#onApplied(snapshot);
    };
    try {
      await apply();
    } catch (firstError) {
      try {
        await apply();
      } catch (recoveryError) {
        throw new AggregateError(
          [firstError, recoveryError],
          "runtime settings were saved but could not be applied",
        );
      }
    }
  }

  async #restoreCurrentRuntime(originalError: unknown): Promise<void> {
    try {
      await this.#onApplied(this.#store.snapshot());
    } catch (recoveryError) {
      throw new AggregateError(
        [originalError, recoveryError],
        "settings mutation failed and the previous runtime could not be restored",
      );
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#mutation;
    let release!: () => void;
    this.#mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function revisionConflict(expected: number, current: number): SettingsError {
  return new SettingsError(
    "settings_revision_conflict",
    `settings changed concurrently: expected revision ${expected}, current revision ${current}`,
  );
}

function configurationNextStep(input: {
  readonly applicationKeyConfigured: boolean;
  readonly providerConfigured: boolean;
  readonly collectionConfigured: boolean;
  readonly apiConfigured: boolean;
}): RuntimeSettingsView["completion"]["next_step"] {
  if (!input.applicationKeyConfigured) return "GENERATE_APPLICATION_KEY";
  if (!input.providerConfigured) return "CONFIGURE_PROVIDER";
  if (!input.collectionConfigured) return "CONFIGURE_COLLECTION";
  if (!input.apiConfigured) return "GENERATE_API_KEY";
  return null;
}

function latestProviderGeneration(
  generations: readonly ProviderIdentityActivation[],
): ProviderIdentityActivation | null {
  let latest: ProviderIdentityActivation | null = null;
  for (const generation of generations) {
    if (latest === null || generation.sequence > latest.sequence) latest = generation;
  }
  return latest;
}
