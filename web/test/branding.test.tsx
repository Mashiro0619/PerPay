import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { getSystemName, setSystemName, useSystemName } from "../src/branding";
import { queryClient } from "../src/api/client";
import { SettingsEditor } from "../src/components/SettingsForms";
import { LoginForm } from "../src/components/login-form";
import { CheckoutApp } from "../src/checkout/CheckoutApp";
import { withBackendInitialization } from "../dev/initialization";
import { json, settings } from "./fixtures";

function Name() { return <output>{useSystemName()}</output>; }

describe("custom system branding", () => {
  it("updates subscribers from settings and retains the public name on logout", () => {
    render(<Name />);
    expect(screen.getByRole("status")).toHaveTextContent("PerPay");
    act(() => queryClient.setQueryData(["settings"], { data: { ...settings, display: { ...settings.display, system_name: "星河收款" } } }));
    expect(screen.getByRole("status")).toHaveTextContent("星河收款");
    act(() => queryClient.clear());
    expect(getSystemName()).toBe("星河收款");
    act(() => setSystemName("PerPay"));
    expect(screen.getByRole("status")).toHaveTextContent("PerPay");
  });

  it("keeps the name as a draft until a successful save and sends it with display settings", async () => {
    const saved = { ...settings, display: { ...settings.display!, system_name: "星河收款" } };
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => { requests.push(request); return json({ data: saved }); }));
    render(<QueryClientProvider client={queryClient}><MemoryRouter>
      <Name /><SettingsEditor section="display" settings={settings} onSaved={vi.fn()} />
    </MemoryRouter></QueryClientProvider>);
    const user = userEvent.setup();
    const input = screen.getByRole("textbox", { name: "支付系统名称" });
    expect(input).toHaveValue("PerPay");
    expect(input).toHaveAttribute("maxlength", "40");
    await user.clear(input);
    await user.type(input, "星河收款");
    expect(getSystemName()).toBe("PerPay");
    expect(requests).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("星河收款"));
    expect(await requests[0]!.json()).toMatchObject({ system_name: "星河收款" });
  });

  it("shows escaped public branding on login and reacts in the browser title", () => {
    const meta = document.createElement("meta");
    meta.name = "perpay-initialized"; meta.content = "true"; document.head.append(meta);
    const name = '<img src=x onerror=alert(1)>';
    setSystemName(name);
    const { container } = render(<MemoryRouter><LoginForm onLogin={vi.fn()} /></MemoryRouter>);
    expect(screen.getByRole("link", { name })).toBeVisible();
    expect(document.title).toBe("登录管理后台 · " + name);
    expect(container.querySelector("img")).toBeNull();
    act(() => setSystemName("星河收款"));
    expect(document.title).toBe("登录管理后台 · 星河收款");
  });

  it("uses the server-provided name in checkout errors and the browser title", () => {
    render(<CheckoutApp initial={{ systemName: "星河收款", checkout: null,
      initialError: { status: 404, code: "checkout_not_found", message: "收银台不存在", retryAfterSeconds: null },
      apiUrl: "", qrUrl: "", qrAvailable: false, serverTime: Date.now() }} />);
    expect(screen.getByText("星河收款")).toBeVisible();
    expect(document.title).toContain("星河收款 收银台");
    expect(document.title).not.toContain("PerPay");
  });

  it("forwards escaped backend branding into the Vite development page without interpreting replacement tokens", async () => {
    const html = '<meta name="perpay-initialized" content="__PERPAY_INITIALIZED__"><meta name="perpay-system-name" content="__PERPAY_SYSTEM_NAME__"><title>__PERPAY_SYSTEM_NAME__</title>';
    const request = vi.fn().mockResolvedValue(new Response('<meta name="perpay-initialized" content="true"><meta name="perpay-system-name" content="星河 &quot; &lt; $&amp;">'));
    const result = await withBackendInitialization(html, "http://localhost:6190", request);
    expect(result).toContain('<title>星河 &quot; &lt; $&amp;</title>');
    expect(result).not.toContain("__PERPAY_");
  });
});
