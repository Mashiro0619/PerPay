import { fingerprintSecret } from "../settings/model.ts";
import type { SiteStore } from "../sites/store.ts";
import { WebhookDeliveryService, type WebhookProcessResult } from "./service.ts";
import type { WebhookStore } from "./store.ts";
import { NodeWebhookTransport, type WebhookTransport } from "./transport.ts";

/** One processor for the existing serial scheduler, not one worker per website. */
export class SiteWebhookProcessor {
  readonly #sites: SiteStore;
  readonly #webhooks: WebhookStore;
  readonly #clock: () => number;
  readonly #transport: (clientId: string, origin: string) => WebhookTransport;
  #lastClientId: string | null = null;

  constructor(options: {
    sites: SiteStore; webhooks: WebhookStore;
    clock?: () => number;
    transport?: (clientId: string, origin: string) => WebhookTransport;
  }) {
    this.#sites = options.sites;
    this.#webhooks = options.webhooks;
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
    if (!origin || !secret) throw new Error("website notification settings are incomplete");
    const policy = site.configuration.policy.notification_delivery;
    const secretFingerprint = fingerprintSecret(secret, "webhook-signing-key");
    const service = new WebhookDeliveryService({
      store: {
        materialize: (limit, now) => this.#webhooks.materialize(limit, now, clientId),
        claimNext: input => this.#webhooks.claimNext({ ...input, clientId, siteRevision: site.revision, secretFingerprint }),
        completeAttempt: input => this.#webhooks.completeAttempt(input),
      },
      config: {
        secret,
        timeoutMilliseconds: policy.timeout_milliseconds,
        maximumAttempts: policy.maximum_attempts,
        retryBaseMilliseconds: policy.retry_base_seconds * 1000,
        retryMaximumMilliseconds: policy.retry_maximum_seconds * 1000,
      },
      transport: this.#transport(clientId, origin),
      clock: this.#clock,
    });
    return service.processOne(signal);
  }
}
function idle(): WebhookProcessResult {
  return { processed: false, deliveryId: null, status: null, outcome: null, errorCode: null };
}
