import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function conflictServer() {
  const state = {
    account: structuredClone(first), rejectWrites: true, failRead: false,
    writes: [] as { method: string; path: string; body: Record<string, unknown> }[],
  };
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET") return state.failRead
      ? json({ error: { code: "temporarily_unavailable", message: "账号读取失败" } }, 503)
      : json({ data: path.endsWith("alipay-accounts") ? [state.account] : state.account });
    const body = await request.json();
    state.writes.push({ method: request.method, path, body });
    if (state.rejectWrites) return json({ error: { code: "alipay_account_revision_conflict", message: "账号设置已变化，请刷新后重试。" } }, 409);
    state.account = { ...state.account, ...body, revision: state.account.revision + 1 };
    return json({ data: state.account });
  }));
  return state;
}

describe("支付宝账号设置", () => {
  it("未完成配置的账号可连续两次更换应用密钥，每次使用新的操作编号和当前版本", async () => {
    const initial: AlipayAccount = { ...first, configured: false, app_id: null, platform_public_key: null, provider_account_key: null };
    let account = initial;
    const requests: Array<{ path: string; revision: number; change_id: string; base_fingerprint: string }> = [];
    const usedIds = new Set<string>();
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET") return json({ data: path.endsWith("alipay-accounts") ? [account] : account });
      const body = await request.json();
      requests.push({ path, ...body });
      if (usedIds.has(body.change_id))
        return json({ error: { code: "provider_application_key_change_conflict", message: "这次换钥操作与原请求不一致。" } }, 409);
      if (body.revision !== account.revision || body.base_fingerprint !== account.application_key_fingerprint)
        return json({ error: { code: "alipay_account_revision_conflict" } }, 409);
      usedIds.add(body.change_id);
      account = { ...account, revision: account.revision + 1, application_public_key: "新公钥-" + usedIds.size,
        application_key_fingerprint: String(usedIds.size).repeat(64), pending_application_key: null };
      return json({ data: account });
    }));
    mount(<AlipayAccountEditor initial={initial} />);
    const user = userEvent.setup();
    for (const attempt of [1, 2]) {
      await user.click(screen.getByRole("button", { name: "更换应用密钥" }));
      await user.click(screen.getByRole("button", { name: "确认" }));
      await waitFor(() => expect(screen.getByRole("textbox", { name: "应用公钥" })).toHaveValue("新公钥-" + attempt));
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({ path: "/api/admin/v1/alipay-accounts/" + first.id + "/application-key/regenerate",
      revision: first.revision, change_id: expect.any(String), base_fingerprint: first.application_key_fingerprint });
    expect(requests[1]).toEqual({ path: requests[0]!.path, revision: first.revision + 1,
      change_id: expect.any(String), base_fingerprint: "1".repeat(64) });
    expect(requests[1]!.change_id).not.toBe(requests[0]!.change_id);
    expect(screen.queryByText("这次换钥操作与原请求不一致。")).not.toBeInTheDocument();
  });
  it("版本冲突后重读合并本地名称和服务器收款码，再显式保存新版本", async () => {
    const server = conflictServer();
    mount(<AlipayAccountEditor initial={first} />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("账号名称"));
    await user.type(screen.getByLabelText("账号名称"), "本地名称");
    server.account = { ...first, revision: 3, code_payload: "https://qr.alipay.com/remote-new" };
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await user.click(await screen.findByRole("button", { name: "重新读取账号" }));
    await screen.findByText("账号配置已重新读取");
    expect(screen.getByLabelText("账号名称")).toHaveValue("本地名称");
    expect(screen.getByDisplayValue("https://qr.alipay.com/remote-new")).toBeEnabled();
    expect(server.writes).toHaveLength(1);
    server.rejectWrites = false;
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("账号已保存");
    expect(server.writes[1]?.body).toMatchObject({ revision: 3, name: "本地名称", code_payload: "https://qr.alipay.com/remote-new" });
  });
  it.each(["保留我的修改", "采用服务器值"])("同字段冲突经%s后再恢复编辑", async choice => {
    const server = conflictServer();
    mount(<AlipayAccountEditor initial={first} />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("账号名称"));
    await user.type(screen.getByLabelText("账号名称"), "本地名称");
    server.account = { ...first, revision: 3, name: "服务器名称" };
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await user.click(await screen.findByRole("button", { name: "重新读取账号" }));
    await screen.findByText("账号配置存在不同修改");
    expect(screen.getByRole("button", { name: "应用核对结果" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: choice }));
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(screen.getByLabelText("账号名称")).toHaveValue(choice === "保留我的修改" ? "本地名称" : "服务器名称");
    expect(server.writes).toHaveLength(1);
  });
  it.each(["删除账号", "更换应用密钥"])("%s发生版本冲突时重读状态并关闭旧确认，不重放操作", async action => {
    const server = conflictServer();
    mount(<AlipayAccountEditor initial={first} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: action }));
    await user.click(screen.getByRole("button", { name: "确认" }));
    const reload = await screen.findByRole("button", { name: "重新读取账号" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    server.account = { ...first, revision: 3, deletable: false, pending_application_key: {
      change_id: "33333333-3333-4333-8333-333333333333", public_key: "remote-pending-key", fingerprint: "b".repeat(64),
      app_id: first.app_id!, environment: first.environment, created_at: first.created_at,
    } };
    await user.click(reload);
    await screen.findByText("账号配置已重新读取");
    expect(screen.getByRole("button", { name: "删除账号" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "待启用应用公钥" })).toHaveValue("remote-pending-key");
    expect(screen.queryByRole("button", { name: "更换应用密钥" })).not.toBeInTheDocument();
    expect(server.writes).toHaveLength(1);
    expect(server.writes[0]?.method).toBe(action === "删除账号" ? "DELETE" : "POST");
  });
  it("待启用密钥改变后清除旧支付宝公钥输入，避免用于新一轮启用", async () => {
    const server = conflictServer();
    const pending = { change_id: "33333333-3333-4333-8333-333333333333", public_key: "pending-key", fingerprint: "b".repeat(64), app_id: first.app_id!, environment: first.environment, created_at: first.created_at };
    mount(<AlipayAccountEditor initial={{ ...first, pending_application_key: pending }} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("新的支付宝公钥"), "old-activation-key");
    await user.click(screen.getByRole("button", { name: "验证并启用" }));
    server.account = { ...first, revision: 3, pending_application_key: { ...pending, change_id: "44444444-4444-4444-8444-444444444444", public_key: "new-pending-key" } };
    await user.click(await screen.findByRole("button", { name: "重新读取账号" }));
    await screen.findByText("账号配置已重新读取");
    expect(screen.getByLabelText("新的支付宝公钥")).toHaveValue("");
    expect(screen.getByRole("button", { name: "验证并启用" })).toBeDisabled();
    expect(server.writes).toHaveLength(1);
  });
  it("导入私钥时遇到远端待启用密钥，先核对服务器应用状态", async () => {
    const server = conflictServer();
    mount(<AlipayAccountEditor initial={first} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "导入已有应用私钥（可选）" }));
    await user.type(screen.getByLabelText("应用私钥（可选）"), "local-import-key");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    server.account = { ...first, revision: 3, pending_application_key: {
      change_id: "33333333-3333-4333-8333-333333333333", public_key: "remote-pending-key", fingerprint: "b".repeat(64),
      app_id: first.app_id!, environment: first.environment, created_at: first.created_at,
    } };
    await user.click(await screen.findByRole("button", { name: "重新读取账号" }));
    const choices = await screen.findByRole("group", { name: "导入的应用私钥冲突处理" });
    expect(within(choices).getByRole("button", { name: "保留我的修改" })).toBeDisabled();
    await user.click(within(choices).getByRole("button", { name: "采用服务器值" }));
    await user.click(screen.getByRole("button", { name: "应用核对结果" }));
    expect(screen.getByRole("textbox", { name: "待启用应用公钥" })).toHaveValue("remote-pending-key");
    expect(screen.getByRole("button", { name: "放弃新密钥" })).toBeEnabled();
    expect(server.writes).toHaveLength(1);
  });
  it("账号重读失败仍保留草稿，成功后恢复操作", async () => {
    const server = conflictServer();
    mount(<AlipayAccountEditor initial={first} />);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("账号名称"));
    await user.type(screen.getByLabelText("账号名称"), "保留的草稿");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    server.failRead = true;
    await user.click(await screen.findByRole("button", { name: "重新读取账号" }));
    await screen.findByText("账号读取失败");
    expect(screen.getByLabelText("账号名称")).toHaveValue("保留的草稿");
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
    server.failRead = false;
    server.account = { ...first, revision: 3 };
    await user.click(screen.getByRole("button", { name: "重新读取账号" }));
    await screen.findByText("账号配置已重新读取");
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeEnabled();
    expect(server.writes).toHaveLength(1);
  });
  it("preserves the production configuration through saving and retrying only that account's connection check", async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    const initial = first;
    let saved = structuredClone(initial);
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
    mount(<AlipayAccountEditor initial={initial} />);
    expect(screen.queryByLabelText("支付宝环境")).not.toBeInTheDocument();
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
    expect(writes[0]!.body).toMatchObject({ environment: "PRODUCTION", revision: initial.revision });
  });

  it("keeps retired test accounts read-only and directs setup to a new live account", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const retired: AlipayAccount = {
      ...first,
      environment: "SANDBOX",
      configured: false,
      last_check: { ok: true, checked_at: first.created_at, message: "历史查询成功" },
      pending_application_key: {
        change_id: "33333333-3333-4333-8333-333333333333",
        public_key: "retired-public-key",
        fingerprint: "b".repeat(64),
        app_id: first.app_id!,
        environment: "SANDBOX",
        created_at: first.created_at,
      },
    };
    mount(<AlipayAccountEditor initial={retired} />);
    expect(screen.getByText("旧版测试账号已停用")).toBeVisible();
    expect(screen.queryByText("连接检查通过")).not.toBeInTheDocument();
    expect(screen.getByLabelText("账号名称")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存并检查" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新检查" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /验证并启用|生成应用密钥|更换应用密钥/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "添加支付宝账号" })).toHaveAttribute("href", "/settings/accounts/new");
    fireEvent.submit(screen.getByLabelText("账号名称").closest("form")!);
    expect(fetch).not.toHaveBeenCalled();
    expect(defaultSiteCollection([{ ...retired, configured: true }]).accounts).toEqual([]);
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
    expect(screen.queryByLabelText("支付宝环境")).not.toBeInTheDocument();
    expect(screen.getByText(/请使用状态为“已上线”的支付宝应用/)).toBeVisible();
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
      environment: "PRODUCTION",
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
    expect(screen.getAllByRole("textbox", { name: "待启用应用公钥" })).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "待启用应用公钥" })).toHaveValue(pending.public_key);
    expect(screen.queryByRole("textbox", { name: "当前应用公钥" })).not.toBeInTheDocument();
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
  it("distinguishes same-name fixed choices and keeps the selected application visible", async () => {
    function Choices() {
      const [value, onChange] = useState<SiteCollection>({ mode: "FIXED", accounts: [] });
      return <><CollectionChoices accounts={[first, { ...second, name: first.name }]} value={value} onChange={onChange} /><output>{JSON.stringify(value)}</output></>;
    }
    mount(<Choices />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "支付宝账号" }));
    expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual([
      "主收款账号 · App ID app-one", "主收款账号 · App ID app-two",
    ]);
    await user.click(screen.getByRole("option", { name: "主收款账号 · App ID app-two" }));
    expect(screen.getByRole("combobox", { name: "支付宝账号" })).toHaveTextContent("主收款账号 · App ID app-two");
    expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify({ mode: "FIXED", accounts: [{ account_id: second.id, weight: 1 }] }));
  });

  for (const mode of ["RANDOM", "WEIGHTED"] as const) {
    it(`shows distinct visible application identities for same-name ${mode} choices`, async () => {
      function Choices() {
        const [value, onChange] = useState<SiteCollection>({ mode, accounts: [{ account_id: first.id, weight: 1 }] });
        return <><CollectionChoices accounts={[first, { ...second, name: first.name }]} value={value} onChange={onChange} /><output>{JSON.stringify(value)}</output></>;
      }
      mount(<Choices />);
      expect(screen.getByText("主收款账号 · App ID app-one")).toBeVisible();
      expect(screen.getByText("主收款账号 · App ID app-two")).toBeVisible();
      await userEvent.setup().click(screen.getByRole("checkbox", { name: "主收款账号 · App ID app-two" }));
      expect(screen.getByRole("status")).toHaveTextContent(JSON.stringify({ mode, accounts: [{ account_id: first.id, weight: 1 }, { account_id: second.id, weight: 1 }] }));
      if (mode === "WEIGHTED") expect(screen.getByRole("spinbutton", { name: "主收款账号 · App ID app-two权重" })).toBeVisible();
    });
  }

  it("uses enough stable ID for duplicate drafts while leaving unique names concise", () => {
    const drafts = [
      { ...first, id: "alipay_12345678-aaaa-4000-8000-111111111111", app_id: null, configured: false },
      { ...second, id: "alipay_12345678-bbbb-4000-8000-222222222222", name: first.name, app_id: null, configured: false },
    ];
    mount(<CollectionChoices accounts={[...drafts, second]} value={{ mode: "RANDOM", accounts: drafts.map(account => ({ account_id: account.id, weight: 1 })) }} onChange={() => {}} />);
    expect(screen.getByText("主收款账号 · 12345678-aaa（配置未完成）")).toBeVisible();
    expect(screen.getByText("主收款账号 · 12345678-bbb（配置未完成）")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "备用账号" })).toBeVisible();
    expect(screen.queryByText(/app-two/)).not.toBeInTheDocument();
  });

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
