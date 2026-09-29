// Preload the real chart module outside per-interaction timeouts.
import "../src/pages/Dashboard";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";

import { appRoutes } from "../src/App";
import {
  queryClient,
  type RuntimeSettings,
  type SystemStatus,
} from "../src/api/client";
import { apiError, json, settings } from "./fixtures";

export const instanceId = "onboarding-test-instance";
export const syntheticSecret = "synthetic-onboarding-key-not-a-real-secret";
export function configuredThrough(stage: number): RuntimeSettings {
  const value = structuredClone(settings);
  for (const name of Object.keys(value.secrets) as Array<
    keyof typeof value.secrets
  >)
    value.secrets[name] = { ...value.secrets[name] };
  value.application_public_key =
    stage >= 1 ? "synthetic-application-public-key" : null;
  value.application_key_fingerprint = stage >= 1 ? "a".repeat(64) : null;
  value.collection = stage >= 3 ? value.collection : null;
  value.provider =
    stage >= 2
      ? {
          provider_account_key: "synthetic-provider",
          environment: "PRODUCTION",
          app_id: "test-app-id",
          platform_public_key: "synthetic-saved-alipay-public-key",
          timeout_milliseconds: 8000,
          scan_interval_seconds: 10,
          active_scan_interval_seconds: 10,
          safety_lag_seconds: 10,
          maximum_success_age_seconds: 60,
        }
      : null;
  value.secrets.api_secret.configured = stage >= 4;
  value.secrets.provider_private_key.configured = stage >= 1;
  value.secrets.provider_public_key.configured = stage >= 2;
  return completion(value);
}
export function pendingApplicationKey(value = configuredThrough(4)): RuntimeSettings {
  return {
    ...value,
    pending_application_key: {
      change_id: "00000000-0000-4000-8000-000000000001",
      public_key: "synthetic-pending-application-public-key",
      fingerprint: "b".repeat(64),
      app_id: value.provider!.app_id,
      environment: value.provider!.environment,
      created_at: "2026-09-27T00:00:00Z",
    },
  };
}

function completion(value: RuntimeSettings): RuntimeSettings {
  value.completion = {
    application_key: value.application_public_key !== null,
    provider: value.provider !== null,
    collection: value.collection !== null,
    api: value.secrets.api_secret.configured,
    complete: Boolean(value.provider && value.collection),
    notifications:
      !value.notifications.enabled || value.secrets.webhook_secret.configured,
    next_step: !value.application_public_key
      ? "GENERATE_APPLICATION_KEY"
      : !value.provider
        ? "CONFIGURE_PROVIDER"
        : !value.collection
          ? "CONFIGURE_COLLECTION"
          : null,
  };
  return value;
}
export function systemStatus(value = configuredThrough(4)): SystemStatus {
  const health = {
    enabled: true,
    state: "healthy" as const,
    in_flight: false,
    last_attempt_at: 1,
    last_success_at: 1,
    last_error_code: null,
    consecutive_failures: 0,
  };
  return {
    status: value.completion.complete ? "ready" : "not_ready",
    version: "0.1.0",
    instance_id: instanceId,
    initialized: true,
    configured: value.completion.complete,
    settings_revision: value.revision,
    payment_revision: value.payment_revision,
    provider_account_key: "synthetic-provider",
    database: { ok: true, result: "ok" },
    work_items: { total: 0, financial_exceptions: 0, ledger_conflicts: 0, notification_failures: 0 },
    ledger: {
      ...health,
      collection_ready: true,
      last_success_age_milliseconds: 0,
      maximum_success_age_milliseconds: 60000,
      conflicts: null,
    },
    reconciliation: {
      ...health,
      confirmation_ready: true,
      pending_orders: 0,
      continuation_pending: false,
      last_success_age_milliseconds: 0,
      maximum_success_age_milliseconds: 60000,
      exceptions: null,
    },
    webhook: { ...health, pending_deliveries: 0, dead_letters: 0 },
    backup: {
      enabled: true,
      ok: true,
      status: "healthy",
      last_attempt_at: null,
      last_success_at: null,
      last_error_at: null,
      last_error_stage: null,
      backup_name: null,
      backup_sha256: null,
      backup_size_bytes: null,
      instance_id: instanceId,
      schema_version: 1,
      interval_milliseconds: 86400000,
      keep_count: 7,
      retained_count: 0,
      maximum_age_milliseconds: null,
      backup_required: false,
      backup_in_progress: false,
      backup_available: false,
      recovery_required: false,
      clock_moved_backwards: false,
      configuration_mismatch: false,
      instance_matches: true,
    },
  };
}
export function mountOnboarding(
  options: {
    stage?: number;
    path?: string;
    signedIn?: boolean;
    pendingKey?: boolean;
    notificationKey?: boolean;
    status?: (settings: RuntimeSettings) => SystemStatus;
    handle?: (request: Request) => Response | Promise<Response> | undefined;
  } = {},
) {
  // A configured instance's HTML carries this even when its session has expired.
  if (!document.querySelector('meta[name="perpay-initialized"]')) {
    const meta = document.createElement("meta");
    meta.name = "perpay-initialized";
    meta.content = "true";
    document.head.append(meta);
  }

  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  let saved = options.pendingKey ? pendingApplicationKey() : configuredThrough(options.stage ?? 0);
  if (options.notificationKey) {
    saved.notifications = { ...saved.notifications, enabled: true, allowed_origin: "https://business.example" };
    saved.secrets.webhook_secret = { ...saved.secrets.webhook_secret, configured: true, version: 1 };
  }
  let signedIn = options.signedIn ?? true;
  const fetchMock = vi.fn(async (request: Request) => {
    const override = options.handle?.(request);
    if (override !== undefined) return override;
    const url = new URL(request.url);
    const endpoint = url.pathname;
    if (endpoint.endsWith("/session/login")) {
      signedIn = true;
      return json({ data: { username: "admin" } });
    }
    if (endpoint.endsWith("/session/logout")) {
      signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (endpoint.endsWith("/session"))
      return json(
        signedIn
          ? {
              data: {
                username: "admin",
                csrf_token_required: true,
                idle_expires_at: "2099-01-01T00:00:00Z",
                absolute_expires_at: "2099-01-01T00:00:00Z",
              },
            }
          : null,
      );
    if (endpoint.endsWith("/setup"))
      return json({ data: { initialized: true } });
    if (endpoint.endsWith("/system/status"))
      return json({ data: options.status?.(saved) ?? systemStatus(saved) });
    if (endpoint.endsWith("/system/analytics"))
      return json({
        data: {
          range_days: 30,
          from: "2026-09-01",
          to: "2026-09-08",
          orders: {
            created: 0,
            unpaid: 0,
            confirmed: 0,
            disputed: 0,
            closed: 0,
            expired: 0,
          },
          confirmations: { count: 0, amount_cents: 0 },
          pending: { orders: 0, exceptions: 0, conflicts: 0, notifications: 0 },
          notifications: { acknowledged: 0, failed: 0, pending: 0 },
          daily: [
            {
              date: "2026-09-08",
              orders_created: 0,
              confirmations: 0,
              confirmed_amount_cents: 0,
              notifications_acknowledged: 0,
              notifications_failed: 0,
            },
          ],
        },
      });
    if (endpoint.endsWith("/orders") || endpoint.endsWith("/work-items"))
      return json({ data: [], page: { next_cursor: null } });
    if (endpoint.endsWith("/settings")) return json({ data: saved });
    if (endpoint.includes("/secrets/") && endpoint.endsWith("/actions/reveal"))
      return json({ data: { value: syntheticSecret } });
    if (endpoint.endsWith("/application-key/actions/generate")) {
      saved = completion({
        ...saved,
        revision: saved.revision + 1,
        application_public_key: "synthetic-application-public-key",
        application_key_fingerprint: "a".repeat(64),
      });
      return json({
        data: {
          created: true,
          settings: saved,
          public_key: saved.application_public_key,
          fingerprint: "synthetic",
        },
      });
    }
    if (endpoint.endsWith("/application-key/actions/regenerate")) {
      const input = await request.clone().json() as { change_id: string };
      saved = saved.provider
        ? { ...pendingApplicationKey(saved), revision: saved.revision + 1,
            pending_application_key: { ...pendingApplicationKey(saved).pending_application_key!, change_id: input.change_id } }
        : { ...saved, revision: saved.revision + 1,
            application_public_key: "synthetic-regenerated-application-public-key", application_key_fingerprint: "b".repeat(64) };
      return json({ data: { created: true, settings: saved,
        public_key: saved.pending_application_key?.public_key ?? saved.application_public_key,
        fingerprint: saved.pending_application_key?.fingerprint ?? saved.application_key_fingerprint } });
    }
    if (endpoint.endsWith("/application-key/actions/activate")) {
      const input = await request.clone().json() as { platform_public_key?: unknown };
      if (typeof input.platform_public_key !== "string" || !input.platform_public_key.trim())
        return json({ error: { code: "validation_failed", message: "请求字段校验失败" } }, 422);
      const pending = saved.pending_application_key!;
      saved = { ...saved, revision: saved.revision + 1, payment_revision: saved.payment_revision + 1,
        application_public_key: pending.public_key, application_key_fingerprint: pending.fingerprint,
        provider: { ...saved.provider!, platform_public_key: input.platform_public_key },
        pending_application_key: null };
      return json({ data: saved });
    }
    if (endpoint.endsWith("/application-key/actions/discard")) {
      saved = { ...saved, revision: saved.revision + 1, pending_application_key: null };
      return json({ data: saved });
    }
    if (endpoint.endsWith("/notification-key/actions/rotate")) {
      const { revision } = await request.clone().json();
      if (revision !== saved.revision) return apiError("settings_revision_conflict", "stale revision");
      saved = { ...saved, revision: revision + 1, secrets: { ...saved.secrets, webhook_secret: { ...saved.secrets.webhook_secret, version: (saved.secrets.webhook_secret.version ?? 0) + 1 } } };
      return json({ data: { settings: saved, secret: "synthetic-rotated-notification-secret" } });
    }
    if (endpoint.endsWith("/api-key/actions/rotate")) {
      saved = completion({
        ...saved,
        revision: saved.revision + 1,
        secrets: {
          ...saved.secrets,
          api_secret: { ...saved.secrets.api_secret, configured: true },
        },
      });
      return json({
        data: {
          settings: saved,
          secret: syntheticSecret,
          client_id: "default",
        },
      });
    }
    if (request.method === "PUT") {
      const { revision, ...body } = await request.clone().json();
      if (revision !== saved.revision)
        return apiError("settings_revision_conflict", "stale revision");
      const section = endpoint.split("/").at(-1)!;
      saved = completion({
        ...saved,
        revision: revision + 1,
        payment_revision:
          saved.payment_revision +
          (section === "provider" || section === "collection" ? 1 : 0),
        [section]: body,
      });
      if (section === "notifications")
        saved.secrets.webhook_secret.configured = body.enabled;
      return json({ data: saved });
    }
    return apiError(
      "route_not_found",
      "unexpected test request: " + endpoint,
      404,
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const router = createMemoryRouter(appRoutes, {
    initialEntries: [options.path ?? "/settings/onboarding"],
  });
  const view = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router }),
    ),
  );
  return {
    ...view,
    router,
    fetchMock,
    get saved() {
      return saved;
    },
    writes: () =>
      fetchMock.mock.calls
        .map(([request]) => request)
        .filter((request) => !["GET", "HEAD"].includes(request.method)),
  };
}
