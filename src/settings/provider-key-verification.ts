import {
  AlipayLedgerProvider,
  AlipayProviderError,
  NodeV3Transport,
  type V3Transport,
} from "../infrastructure/alipay/index.ts";
import type { ProviderSettings } from "./model.ts";
import { SettingsError } from "./store.ts";

export interface ProviderKeyVerificationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly requestId?: string | undefined;
}

export type ProviderKeyVerifier = (
  provider: ProviderSettings,
  options: ProviderKeyVerificationOptions,
) => Promise<void>;

/** A single bounded, signed, read-only probe. No ledger data or readiness is published. */
export async function verifyProviderApplicationKey(
  provider: ProviderSettings,
  options: ProviderKeyVerificationOptions = {},
  dependencies: {
    readonly transport?: V3Transport;
    readonly clock?: () => number;
  } = {},
): Promise<void> {
  const clock = dependencies.clock ?? Date.now;
  const timeoutMilliseconds = Math.min(provider.timeoutMilliseconds, 8_000);
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMilliseconds),
    ...(options.signal ? [options.signal] : []),
  ]);
  const client = new AlipayLedgerProvider({
    appId: provider.appId,
    privateKey: provider.privateKey,
    alipayPublicKey: provider.publicKey,
    transport:
      dependencies.transport ??
      new NodeV3Transport({ endpoint: provider.endpoint }),
    timeoutMilliseconds,
    pageSize: 1,
    clock,
  });
  // Query a small recent window, allowing for the same provider clock lag as normal collection.
  const end =
    Math.floor((clock() - provider.safetyLagMilliseconds) / 1_000) * 1_000;
  const format = (time: number) =>
    new Date(time + 8 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
  try {
    await client.queryPage({
      startTime: format(end - 60_000),
      endTime: format(end),
      pageNo: 1,
      pageSize: 1,
      requestId: options.requestId,
      signal,
    });
    signal.throwIfAborted();
  } catch (error) {
    let message = "验证未通过，请核对支付宝配置后重试。";
    if (error instanceof AlipayProviderError) {
      if (error.kind === "authentication")
        message =
          "支付宝未接受新私钥的签名，请确认已向同一应用上传新的应用公钥，并等待其生效。";
      else if (error.kind === "authorization")
        message = "支付宝未允许账务明细查询，请检查此应用的查询权限。";
      else if (error.kind === "signature_invalid")
        message =
          "支付宝响应验签失败，请填写支付宝当前提供的支付宝公钥，不是应用公钥。";
      else if (error.kind === "rate_limited")
        message = "支付宝请求频率受限，请稍后重试。";
      else if (
        ["timeout", "network", "transient", "cancelled"].includes(error.kind)
      )
        message = "暂时无法完成支付宝验证，请检查网络后重试。";
    }
    throw new SettingsError(
      "provider_application_key_verification_failed",
      message + " 当前密钥未更换。",
    );
  }
}
