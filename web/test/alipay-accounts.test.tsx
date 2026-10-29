import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient, type SiteCollection } from "../src/api/client";
import { DraftProvider } from "../src/drafts";
import { AlipayAccountEditor } from "../src/pages/AlipayAccounts";
import { CollectionChoices } from "../src/components/site-collection-fields";
import {
  defaultSiteCollection,
  type AlipayAccount,
} from "../src/lib/alipay-accounts";
import {
  mergeSiteConfiguration,
  resolveSiteConflicts,
} from "../src/lib/site-configuration";
import { AccountOnboarding } from "../src/pages/AccountOnboarding";
import { AlipayAccountStatus } from "../src/components/alipay-account-status";
import { json } from "./fixtures";

const first: AlipayAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  revision: 2,
  name: "主收款账号",
  enabled: true,
  code_payload: "https://qr.alipay.com/account-one",
  environment: "PRODUCTION",
  app_id: "app-one",
  platform_public_key: "platform-key-one",
  provider_account_key: "provider-one",
  configured: true,
  application_public_key: "public-key-one",
  application_key_fingerprint: "a".repeat(64),
  pending_application_key: null,
  sites: [],
  deletable: true,
  last_check: null,
  created_at: "2026-10-29T00:00:00Z",
  updated_at: "2026-10-29T00:00:00Z",
};
const second: AlipayAccount = {
  ...first,
  id: "22222222-2222-4222-8222-222222222222",
  name: "备用账号",
  app_id: "app-two",
};

beforeEach(() => queryClient.removeQueries({ queryKey: ["alipay-accounts"] }));

function mount(element: React.ReactNode, path = "/settings/accounts/first") {
  const router = createMemoryRouter(
    [
      {
        element: (
          <DraftProvider>
            <Outlet />
          </DraftProvider>
        ),
        children: [
          { path: "/settings/accounts/:accountId", element },
          { path: "/settings/onboarding/:step", element },
          { path: "/settings/accounts", element: <h1>账号列表</h1> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("支付宝账号设置", () => {
  it("retains saved configuration when the subsequent connection check fails and retries only that account", async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    let saved = structuredClone(first);
    let checks = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "GET")
          return json({
            data: path.endsWith("alipay-accounts") ? [saved] : saved,
          });
        const body = await request.clone().json();
        writes.push({ path, body });
        if (path.endsWith("/check"))
          return json({
            data: {
              ok: ++checks > 1,
              checked_at: "2026-10-29T00:02:00Z",
              message: checks > 1 ? "查账连接正常" : "支付宝公钥不匹配",
            },
          });
        saved = { ...saved, ...body, revision: saved.revision + 1 };
        return json({ data: saved });
      }),
    );
    mount(<AlipayAccountEditor initial={first} />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("账号名称"));
    await user.type(screen.getByLabelText("账号名称"), "主账号（更新）");
    await user.click(screen.getByRole("button", { name: "保存并检查" }));
    expect(await screen.findByText("连接检查未通过")).toBeVisible();
    expect(screen.getByLabelText("账号名称")).toHaveValue("主账号（更新）");
    expect(screen.getByText("账号已保存")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重新检查" }));
    expect(await screen.findByText("连接检查通过")).toBeVisible();
    expect(writes.map((write) => write.path)).toEqual([
      "/api/admin/v1/alipay-accounts/" + first.id,
      "/api/admin/v1/alipay-accounts/" + first.id + "/check",
      "/api/admin/v1/alipay-accounts/" + first.id + "/check",
    ]);
  });

  it("saves an incomplete account without a QR code or application data, then generates its own key", async () => {
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        const body =
          request.method === "GET" ? {} : await request.clone().json();
        if (request.method !== "GET") writes.push({ path, body });
        const account = {
          ...first,
          ...body,
          revision: 3,
          configured: false,
          application_public_key: path.endsWith("application-key")
            ? "generated-public-key"
            : null,
          app_id: null,
          code_payload: null,
          platform_public_key: null,
        };
        return json({
          data:
            path.endsWith("alipay-accounts") && request.method === "GET"
              ? [account]
              : account,
        });
      }),
    );
    mount(<AlipayAccountEditor initial={null} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("账号名称"), "新账号");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await user.click(
      await screen.findByRole("button", { name: "生成应用密钥" }),
    );
    expect(
      await screen.findByText("应用密钥已保存，请把应用公钥上传到支付宝"),
    ).toBeVisible();
    expect(writes[0]?.body).toMatchObject({
      name: "新账号",
      code_payload: null,
      app_id: null,
      platform_public_key: null,
    });
    expect(writes[1]?.path).toBe(
      "/api/admin/v1/alipay-accounts/" + first.id + "/application-key",
    );
    expect(writes.some((write) => write.path.endsWith("/check"))).toBe(false);
  });

  it("activates a pending key using that account and change ID", async () => {
    const pending = {
      change_id: "33333333-3333-4333-8333-333333333333",
      public_key: "new-public-key",
      fingerprint: "b".repeat(64),
      app_id: first.app_id!,
      environment: first.environment,
      created_at: first.created_at,
    };
    const requests: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (request.method !== "GET")
          requests.push({ path, body: await request.clone().json() });
        return json({
          data: path.endsWith("alipay-accounts") ? [first] : first,
        });
      }),
    );
    mount(
      <AlipayAccountEditor
        initial={{ ...first, pending_application_key: pending }}
      />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("新的支付宝公钥"),
      "platform-key-new",
    );
    await user.click(screen.getByRole("button", { name: "验证并启用" }));
    expect(await screen.findByText("新应用密钥已启用")).toBeVisible();
    expect(requests).toEqual([
      {
        path:
          "/api/admin/v1/alipay-accounts/" +
          first.id +
          "/application-key/activate",
        body: {
          revision: first.revision,
          change_id: pending.change_id,
          platform_public_key: "platform-key-new",
        },
      },
    ]);
  });
});

describe("网站收款账号分配", () => {
  it("preselects only one eligible account", () => {
    expect(defaultSiteCollection([first])).toEqual({
      mode: "FIXED",
      accounts: [{ account_id: first.id, weight: 1 }],
    });
    expect(defaultSiteCollection([first, second]).accounts).toEqual([]);
    expect(
      defaultSiteCollection([{ ...first, enabled: false }, second]).accounts,
    ).toEqual([{ account_id: second.id, weight: 1 }]);
  });

  it("shows weight percentages and narrows selection when switching to fixed mode", async () => {
    function Choices() {
      const [value, setValue] = useState<SiteCollection>({
        mode: "WEIGHTED",
        accounts: [
          { account_id: first.id, weight: 1 },
          { account_id: second.id, weight: 3 },
        ],
      });
      return (
        <>
          <CollectionChoices
            accounts={[first, second]}
            value={value}
            onChange={setValue}
          />
          <output>{JSON.stringify(value)}</output>
        </>
      );
    }
    mount(<Choices />);
    expect(screen.getByLabelText("主收款账号分配比例")).toHaveTextContent(
      "25.0%",
    );
    fireEvent.change(screen.getByLabelText("主收款账号权重"), {
      target: { value: "3" },
    });
    expect(screen.getByLabelText("主收款账号分配比例")).toHaveTextContent(
      "50.0%",
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "指定账号" }));
    expect(screen.queryByLabelText("主收款账号权重")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      JSON.stringify({
        mode: "FIXED",
        accounts: [{ account_id: first.id, weight: 1 }],
      }),
    );
  });

  it("treats the complete allocation rule as one conflict while retaining unrelated remote settings", () => {
    const base = {
      name: "网站",
      accepting_orders: true,
      notifications_enabled: false,
      notification_origin: null,
      return_origin: null,
      policy: {} as never,
      collection: {
        mode: "FIXED" as const,
        accounts: [{ account_id: first.id, weight: 1 }],
      },
    };
    const local = {
      ...base,
      collection: {
        mode: "RANDOM" as const,
        accounts: [
          { account_id: first.id, weight: 1 },
          { account_id: second.id, weight: 1 },
        ],
      },
    };
    const remote = {
      ...base,
      name: "远端改名",
      collection: {
        mode: "FIXED" as const,
        accounts: [{ account_id: second.id, weight: 1 }],
      },
    };
    const merge = mergeSiteConfiguration(base, local, remote, "collection");
    expect(merge.conflicts.map((conflict) => conflict.path)).toEqual([
      "collection",
    ]);
    const resolved = resolveSiteConflicts(
      merge.configuration,
      merge.conflicts,
      { collection: "local" },
    );
    expect(resolved?.name).toBe("远端改名");
    expect(resolved?.collection).toEqual(local.collection);
  });
});

describe("账号配置向导", () => {
  it("uses account, website, and test payment steps with no backup step", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) =>
        json({
          data: new URL(request.url).pathname.endsWith("alipay-accounts")
            ? [first]
            : [],
        }),
      ),
    );
    mount(
      <AccountOnboarding instanceId="test-instance" />,
      "/settings/onboarding/accounts",
    );
    expect(
      await screen.findByRole("heading", { name: "配置支付宝账号" }),
    ).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "配置步骤" }),
    ).toHaveTextContent("1配置支付宝账号2配置网站3试收款");
    expect(screen.queryByText("自动备份")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "下一步：配置网站" }),
      ).toBeEnabled(),
    );
  });
});

it("submits a new manual scan to its account while retaining another account's availability", async () => {
  const requests: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      requests.push(await request.json());
      return json(
        {
          data: {
            id: "new-request",
            state: "WAITING",
            requested_at: "2026-10-29T00:02:00Z",
            started_at: null,
            finished_at: null,
            next_attempt_at: null,
            outcome: null,
            error_code: null,
            ingest_run_id: null,
          },
        },
        202,
      );
    }),
  );
  mount(
    <AlipayAccountStatus
      accounts={[
        {
          ...first,
          manual_scan: {
            available: true,
            unavailable_reason: null,
            request: {
              id: "old-request",
              state: "COMPLETED",
              requested_at: "2026-10-29T00:00:00Z",
              started_at: null,
              finished_at: "2026-10-29T00:01:00Z",
              next_attempt_at: null,
              outcome: "COMPLETED",
              error_code: null,
              ingest_run_id: null,
            },
          },
        },
        {
          ...second,
          manual_scan: {
            available: true,
            unavailable_reason: null,
            request: null,
          },
        },
      ]}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "立即查账：主收款账号" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "立即查账：主收款账号" }),
    ).toHaveTextContent("查账处理中"),
  );
  expect(
    screen.getByRole("button", { name: "立即查账：备用账号" }),
  ).toBeEnabled();
  expect(requests).toEqual([{ alipay_account_id: first.id }]);
});
