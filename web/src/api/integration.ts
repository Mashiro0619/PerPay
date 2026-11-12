import { api, ApiError, getSessionRequestGeneration, result, type IntegrationExportRequest, type SiteEpayConfiguration } from "./client";
export type { SiteEpayConfiguration } from "./client";

export type IntegrationProtocol = "native" | "epay_v1" | "epay_v2";
export type EpaySecret = "epay_v1" | "epay_merchant" | "epay_platform";

export type IntegrationExport = IntegrationExportRequest;

const secretViewers = {
  epay_v1: api.viewSiteEpayV1Secret,
  epay_merchant: api.viewSiteEpayMerchantSecret,
  epay_platform: api.viewSiteEpayPlatformSecret,
};
const secretRotators = {
  epay_v1: api.rotateSiteEpayV1Secret,
  epay_merchant: api.rotateSiteEpayMerchantSecret,
  epay_platform: api.rotateSiteEpayPlatformSecret,
};
export const siteEpayKey = (clientId: string) => ["site-epay", clientId] as const;

function requireSiteEpay(configuration: SiteEpayConfiguration | undefined, clientId: string): SiteEpayConfiguration {
  if (!configuration || configuration.client_id !== clientId || typeof configuration.pid !== "string" || !Number.isSafeInteger(configuration.revision)) {
    throw new Error("接入配置读取不完整，请重新读取。");
  }
  return configuration;
}

export async function getSiteEpay(clientId: string, signal: AbortSignal): Promise<SiteEpayConfiguration> {
  const response = await result(api.getSiteEpay({ path: { clientId }, signal }));
  return requireSiteEpay(response.data, clientId);
}

export async function saveSiteEpay(clientId: string, body: Pick<SiteEpayConfiguration, "revision" | "v1_enabled" | "v2_enabled">, signal: AbortSignal) {
  const response = await result(api.updateSiteEpay({ path: { clientId }, body, signal }));
  return requireSiteEpay(response.data, clientId);
}

export async function viewEpaySecret(clientId: string, purpose: EpaySecret, signal: AbortSignal) {
  const response = await result(secretViewers[purpose]({ path: { clientId }, body: {}, signal }));
  return response.data;
}

export async function rotateEpaySecret(clientId: string, purpose: EpaySecret, revision: number, signal: AbortSignal) {
  const response = await result(secretRotators[purpose]({ path: { clientId }, body: { revision }, signal }));
  // Only the public snapshot may enter the mutation cache.
  return requireSiteEpay(response.data.configuration, clientId);
}

export async function exportSiteIntegration(clientId: string, body: IntegrationExport, signal: AbortSignal): Promise<Blob> {
  const generation = getSessionRequestGeneration();
  const response = await api.exportSiteIntegration({ path: { clientId }, body, signal, parseAs: "text" });
  signal.throwIfAborted();
  if (generation !== getSessionRequestGeneration()) {
    throw new DOMException("管理员会话已变化，已忽略旧请求结果。", "AbortError");
  }
  if (response.error instanceof Error && response.error.name === "AbortError") throw response.error;
  if (!response.response?.ok) throw new ApiError(response.response, response.error);
  if (response.error !== undefined || typeof response.data !== "string" ||
      !response.response.headers.get("content-type")?.startsWith("text/plain")) {
    throw new Error("未收到完整的配置文件，请重新下载。");
  }
  return new Blob([response.data], { type: "text/plain;charset=utf-8" });
}
