import {
  assessWebhookAck,
  webhookSignature,
  type WebhookDelivery,
} from "./model.ts";
import {
  type ClaimedWebhookAttempt,
  type CompleteWebhookAttemptInput,
} from "./store.ts";
import {
  WebhookTransportError,
  type WebhookTransport,
  type WebhookTransportErrorCode,
} from "./transport.ts";
import type { ActivityRecorder } from "../audit/activity.ts";
import { isEpaySuccessAck } from "../epay/protocol.ts";

export interface WebhookDeliveryConfig {
  readonly secret: string;
  readonly timeoutMilliseconds: number;
  readonly maximumAttempts: number;
  readonly retryBaseMilliseconds: number;
  readonly retryMaximumMilliseconds: number;
}

export interface WebhookProcessResult {
  readonly processed: boolean;
  readonly deliveryId: string | null;
  readonly status: WebhookDelivery["status"] | null;
  readonly outcome: "ACKNOWLEDGED" | "RETRYABLE_FAILURE" | "PERMANENT_FAILURE" | "OUTCOME_UNKNOWN" | null;
  readonly errorCode: string | null;
}

export interface WebhookDeliveryServiceOptions {
  readonly activity?: ActivityRecorder | undefined;
  readonly siteId?: string | undefined;
  readonly siteName?: string | undefined;
  readonly store: WebhookDeliveryStore;
  readonly config: WebhookDeliveryConfig;
  readonly transport: WebhookTransport;
  readonly clock?: (() => number) | undefined;
  readonly leaseMilliseconds?: number | undefined;
}

export interface WebhookDeliveryStore {
  canDeliver?(eventId: string): boolean;
  materialize(limit: number, now: number): number;
  claimNext(input: {
    readonly now: number;
    readonly leaseMilliseconds: number;
    readonly maximumAttempts: number;
  }): ClaimedWebhookAttempt | null;
  completeAttempt(input: CompleteWebhookAttemptInput): WebhookDelivery;
}

export class WebhookDeliveryService {
  readonly #activity: ActivityRecorder | undefined;
  readonly #siteId: string | undefined;
  readonly #siteName: string | undefined;
  readonly #store: WebhookDeliveryStore;
  readonly #config: WebhookDeliveryConfig;
  readonly #transport: WebhookTransport;
  readonly #clock: () => number;
  readonly #leaseMilliseconds: number;

  constructor(options: WebhookDeliveryServiceOptions) {
    this.#activity = options.activity;
    this.#siteId = options.siteId;
    this.#siteName = options.siteName;
    this.#store = options.store;
    this.#config = options.config;
    this.#transport = options.transport;
    this.#clock = options.clock ?? (() => Date.now());
    this.#leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
    if (!Number.isSafeInteger(this.#leaseMilliseconds) || this.#leaseMilliseconds < 1_000 || this.#leaseMilliseconds > 120_000) {
      throw new RangeError("webhook lease duration is invalid");
    }
  }

  async processOne(signal?: AbortSignal): Promise<WebhookProcessResult> {
    const now = safeNow(this.#clock());
    this.#store.materialize(64, now);
    const claimed = this.#store.claimNext({
      now: safeNow(this.#clock()),
      leaseMilliseconds: this.#leaseMilliseconds,
      maximumAttempts: this.#config.maximumAttempts,
    });
    if (!claimed) {
      return {
        processed: false,
        deliveryId: null,
        status: null,
        outcome: null,
        errorCode: null,
      };
    }
    return this.#activity ? this.#activity.runTask("webhook.delivery", {
      subjectType: "webhook_delivery", subjectId: claimed.delivery.deliveryId, siteId: this.#siteId, siteName: this.#siteName,
      details: { order_id: claimed.event.orderId, attempt_number: claimed.attempt.attemptNumber },
    }, () => this.#deliver(claimed, signal), result => ({ outcome: result.outcome === "ACKNOWLEDGED" ? "SUCCESS" : "FAILURE",
      details: { status: result.status, delivery_outcome: result.outcome, error_code: result.errorCode },
    })) : this.#deliver(claimed, signal);
  }

  async #deliver(
    claimed: ClaimedWebhookAttempt,
    signal: AbortSignal | undefined,
  ): Promise<WebhookProcessResult> {
    let response: Awaited<ReturnType<WebhookTransport["post"]>>;
    try {
      response = await this.#send(claimed, signal);
    } catch (error) {
      const transportError = error instanceof WebhookTransportError
        ? error
        : new WebhookTransportError({
          code: "transport_network",
          message: "通知投递发生未知错误",
          retryable: true,
          cause: error,
        });
      const outcome = isUncertainTransportOutcome(transportError.code)
        ? "OUTCOME_UNKNOWN"
        : transportError.retryable
          ? "RETRYABLE_FAILURE"
          : "PERMANENT_FAILURE";
      const delivery = this.#store.completeAttempt({
        deliveryId: claimed.delivery.deliveryId,
        attemptId: claimed.attempt.attemptId,
        leaseToken: claimed.attempt.leaseToken,
        outcome,
        now: safeNow(this.#clock()),
        maximumAttempts: this.#config.maximumAttempts,
        retryBaseMilliseconds: this.#config.retryBaseMilliseconds,
        retryMaximumMilliseconds: this.#config.retryMaximumMilliseconds,
        resolvedAddressesFingerprint: transportError.resolvedAddressesFingerprint,
        connectedAddress: transportError.connectedAddress,
        errorCode: transportError.code,
      });
      return resultFrom(delivery, outcome, transportError.code);
    }

    const compatible = claimed.attempt.protocol !== undefined && claimed.attempt.protocol !== "native";
    const ack = compatible ? assessEpayAck(response) : assessWebhookAck({
      status: response.status,
      contentType: response.contentType,
      contentEncoding: response.contentEncoding,
      body: response.body,
      eventId: claimed.event.eventId,
      deliveryId: claimed.delivery.deliveryId,
    });
    if (ack.acknowledged) {
      const delivery = this.#store.completeAttempt({
        deliveryId: claimed.delivery.deliveryId,
        attemptId: claimed.attempt.attemptId,
        leaseToken: claimed.attempt.leaseToken,
        outcome: "ACKNOWLEDGED",
        now: safeNow(this.#clock()),
        maximumAttempts: this.#config.maximumAttempts,
        retryBaseMilliseconds: this.#config.retryBaseMilliseconds,
        retryMaximumMilliseconds: this.#config.retryMaximumMilliseconds,
        resolvedAddressesFingerprint: response.resolvedAddressesFingerprint,
        connectedAddress: response.connectedAddress,
        httpStatus: response.status,
        responseBytes: response.body.byteLength,
        responseFingerprint: response.responseFingerprint,
        ackCode: ack.code,
        errorCode: null,
      });
      return resultFrom(delivery, "ACKNOWLEDGED", null);
    }
    const retryable = isRetryableAckFailure(response.status, ack.code, compatible);
    const outcome = retryable ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE";
    const delivery = this.#store.completeAttempt({
      deliveryId: claimed.delivery.deliveryId,
      attemptId: claimed.attempt.attemptId,
      leaseToken: claimed.attempt.leaseToken,
      outcome,
      now: safeNow(this.#clock()),
      maximumAttempts: this.#config.maximumAttempts,
      retryBaseMilliseconds: this.#config.retryBaseMilliseconds,
      retryMaximumMilliseconds: this.#config.retryMaximumMilliseconds,
      resolvedAddressesFingerprint: response.resolvedAddressesFingerprint,
      connectedAddress: response.connectedAddress,
      httpStatus: response.status,
      responseBytes: response.body.byteLength,
      responseFingerprint: response.responseFingerprint,
      ackCode: ack.code,
      errorCode: ack.code,
    });
    return resultFrom(delivery, outcome, ack.code);
  }
  async #send(claimed: ClaimedWebhookAttempt, signal: AbortSignal | undefined) {
    if (claimed.preparationError) {
      throw new WebhookTransportError({ code: claimed.preparationError, message: "历史通知地址不符合当前易支付参数要求，停止投递", retryable: false });
    }
    if (claimed.attempt.protocol && claimed.attempt.protocol !== "native") {
      const beforeSend = () => {
        if (!this.#store.canDeliver?.(claimed.event.eventId)) {
          throw new WebhookTransportError({ code: "payment_confirmation_revoked", message: "原付款确认已撤销，停止投递成功通知", retryable: false });
        }
      };
      beforeSend();
      if (!this.#transport.get || !claimed.attempt.requestUrl) {
        throw new WebhookTransportError({ code: "webhook_target_invalid", message: "易支付通知传输未配置", retryable: false });
      }
      return this.#transport.get({ targetUrl: claimed.attempt.requestUrl,
        timeoutMilliseconds: this.#config.timeoutMilliseconds, signal, beforeSend });
    }
    const body = Buffer.from(claimed.event.payloadJson, "utf8");
    const timestamp = claimed.attempt.requestTimestamp;
    const signature = webhookSignature({
      secret: this.#config.secret,
      keyId: claimed.key.keyId,
      timestamp,
      deliveryId: claimed.delivery.deliveryId,
      eventId: claimed.event.eventId,
      attemptNumber: claimed.attempt.attemptNumber,
      body,
    });
    const headers = {
      "x-perpay-webhook-version": "1",
      "x-perpay-webhook-key-id": claimed.key.keyId,
      "x-perpay-webhook-timestamp": String(timestamp),
      "x-perpay-webhook-delivery-id": claimed.delivery.deliveryId,
      "x-perpay-webhook-event-id": claimed.event.eventId,
      "x-perpay-webhook-attempt": String(claimed.attempt.attemptNumber),
      "x-perpay-webhook-signature": signature,
    } as const;


    return this.#transport.post({ targetUrl: claimed.target.targetUrl, body, headers,
      timeoutMilliseconds: this.#config.timeoutMilliseconds, signal });
  }

}

function isUncertainTransportOutcome(code: WebhookTransportErrorCode): boolean {
  return code === "transport_cancelled" ||
    code === "transport_timeout" ||
    code === "transport_network";
}

function isRetryableAckFailure(status: number, code: string, compatible = false): boolean {
  if (compatible && status >= 200 && status < 300) return code !== "ack_content_encoding_invalid";
  if ((status >= 201 && status <= 204) || (status >= 300 && status < 400) || status >= 500) return true;
  if ([401, 403, 404, 408, 409, 419, 422, 425, 429].includes(status)) return true;
  return status === 200 && code !== "ack_content_encoding_invalid";
}

function resultFrom(
  delivery: WebhookDelivery,
  outcome: WebhookProcessResult["outcome"],
  errorCode: string | null,
): WebhookProcessResult {
  return {
    processed: true,
    deliveryId: delivery.deliveryId,
    status: delivery.status,
    outcome,
    errorCode,
  };
}

function safeNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("webhook clock is invalid");
  return value;
}

function assessEpayAck(response: Awaited<ReturnType<WebhookTransport["post"]>>) {
  if (response.contentEncoding !== null && response.contentEncoding.toLowerCase() !== "identity") {
    return { acknowledged: false, code: "ack_content_encoding_invalid" };
  }
  const acknowledged = isEpaySuccessAck(response.status, response.body);
  return { acknowledged, code: acknowledged ? "acknowledged" : "ack_text_invalid" };
}
