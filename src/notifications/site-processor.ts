import { fingerprintSecret } from "../settings/model.ts";
import type { SiteSnapshot } from "../sites/model.ts";
import type { SiteStore } from "../sites/store.ts";
import type { WebhookDelivery } from "./model.ts";
import { WebhookDeliveryService, type WebhookProcessResult } from "./service.ts";
import { WebhookStoreError, type ClaimDeliveryForRetryInput, type WebhookStore } from "./store.ts";
import { NodeWebhookTransport, type WebhookTransport } from "./transport.ts";
import type { ActivityRecorder } from "../audit/activity.ts";
import type { EpayCredentials, EpayStore } from "../epay/store.ts";

export interface SiteRetryWebhookInput {
  readonly expectedClientId?: string | undefined;
  readonly deliveryId: string;
  readonly actorId: string;
  readonly requestId?: string | undefined;
  readonly remoteAddressHash?: string | undefined;
}

/** One processor for the existing serial scheduler, not one worker per website. */
export class SiteWebhookProcessor {
  readonly #activity: ActivityRecorder | undefined;
  readonly #sites: SiteStore;
  readonly #webhooks: WebhookStore;
  readonly #epay: EpayStore | undefined;
  readonly #clock: () => number;
  readonly #transport: (clientId: string, origin: string) => WebhookTransport;
  #lastClientId: string | null = null;

  constructor(options: {
    activity?: ActivityRecorder | undefined;
    sites: SiteStore; webhooks: WebhookStore;
    epay?: EpayStore | undefined;
    clock?: () => number;
    transport?: (clientId: string, origin: string) => WebhookTransport;
  }) {
    this.#activity = options.activity;
    this.#sites = options.sites;
    this.#webhooks = options.webhooks;
    this.#epay = options.epay;
    this.#clock = options.clock ?? Date.now;
    this.#transport = options.transport ?? ((_clientId, origin) => new NodeWebhookTransport(origin));
  }

  async processOne(signal?: AbortSignal): Promise<WebhookProcessResult> {
    const clientId = this.#sites.nextNotificationSite(this.#lastClientId, this.#clock());
    if (!clientId) return idle();
    this.#lastClientId = clientId;
    const site = this.#sites.get(clientId);
    if (!site || !site.configuration.notifications_enabled) return idle();
    const origin = site.configuration.notification_origin;
    const secret = this.#sites.notificationSecret(clientId);
    if (!origin) throw new Error("website notification settings are incomplete");
    const epayCredentials = this.#epay?.credentialsForSite(clientId);
    return this.#serviceForSite(site, origin, secret, epayCredentials).processOne(signal);
  }

  retryDelivery(input: SiteRetryWebhookInput): {
    readonly delivery: WebhookDelivery;
    readonly execute: (signal?: AbortSignal) => Promise<WebhookProcessResult>;
  } {
    const now = this.#clock();
    const detail = this.#webhooks.delivery(input.deliveryId);
    if (!detail || (input.expectedClientId && detail.target.apiClientId !== input.expectedClientId)) {
      // Delegate to the store so site-scope and missing-delivery errors stay identical to replay().
      this.#webhooks.claimDeliveryForRetry({
        ...input,
        activeAllowedOrigin: null,
        now,
        leaseMilliseconds: 30_000,
        maximumAttempts: 1,
      });
      throw new Error("unreachable");
    }
    const clientId = detail.target.apiClientId;
    const site = this.#sites.get(clientId);
    if (!site || !site.configuration.notifications_enabled) {
      throw new WebhookStoreError("webhook_disabled", "通知功能未启用");
    }
    const origin = site.configuration.notification_origin;
    if (!origin) {
      throw new WebhookStoreError("webhook_disabled", "通知功能未启用");
    }
    const secret = this.#sites.notificationSecret(clientId);
    const epayCredentials = this.#epay?.credentialsForSite(clientId);
    const policy = site.configuration.policy.notification_delivery;
    const secretFingerprint = secret ? fingerprintSecret(secret, "webhook-signing-key") : undefined;
    const claimInput: ClaimDeliveryForRetryInput = {
      ...input,
      activeAllowedOrigin: origin,
      now,
      leaseMilliseconds: 30_000,
      maximumAttempts: policy.maximum_attempts,
      siteRevision: site.revision,
      ...(secretFingerprint ? { secretFingerprint } : {}),
      ...(epayCredentials ? { epayCredentials } : {}),
    };
    const claimed = this.#webhooks.claimDeliveryForRetry(claimInput);
    const service = this.#serviceForSite(site, origin, secret, epayCredentials);
    return {
      delivery: claimed.delivery,
      execute: (signal?: AbortSignal) => service.deliverClaimed(claimed, signal),
    };
  }

  #serviceForSite(
    site: SiteSnapshot,
    origin: string,
    secret: string | null,
    epayCredentials: EpayCredentials | null | undefined,
  ): WebhookDeliveryService {
    const clientId = site.clientId;
    const policy = site.configuration.policy.notification_delivery;
    const secretFingerprint = secret ? fingerprintSecret(secret, "webhook-signing-key") : undefined;
    return new WebhookDeliveryService({
      activity: this.#activity,
      siteId: clientId,
      siteName: site.configuration.name,
      store: {
        materialize: (limit, now) => this.#webhooks.materialize(limit, now, clientId),
        claimNext: input => this.#webhooks.claimNext({ ...input, clientId, siteRevision: site.revision,
          ...(secretFingerprint ? { secretFingerprint } : {}), ...(epayCredentials ? { epayCredentials } : {}) }),
        completeAttempt: input => this.#webhooks.completeAttempt(input),
        canDeliver: eventId => this.#webhooks.isPaymentConfirmationActive(eventId),
      },
      config: {
        secret: secret ?? "",
        timeoutMilliseconds: policy.timeout_milliseconds,
        maximumAttempts: policy.maximum_attempts,
        retryBaseMilliseconds: policy.retry_base_seconds * 1000,
        retryMaximumMilliseconds: policy.retry_maximum_seconds * 1000,
      },
      transport: this.#transport(clientId, origin),
      clock: this.#clock,
    });
  }
}
function idle(): WebhookProcessResult {
  return { processed: false, deliveryId: null, status: null, outcome: null, errorCode: null };
}
