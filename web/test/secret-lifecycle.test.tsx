import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { queryClient } from "../src/api/client";
import { SecuritySettings } from "../src/pages/SecuritySettings";
import { json, settings } from "./fixtures";

const syntheticSecret = "synthetic-test-key-never-real";

describe("secret visibility lifecycle", () => {
  it.each(["read", "rotate"])("closes the %s dialog when hidden before its response and never displays late plaintext", async (operation) => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let finish: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const configured = { ...settings, secrets: { ...settings.secrets, api_secret: { ...settings.secrets.api_secret, configured: true } } };
    const onSaved = vi.fn();
    render(<QueryClientProvider client={queryClient}><MemoryRouter><SecuritySettings settings={configured} onSaved={onSaved} /></MemoryRouter></QueryClientProvider>);
    const user = userEvent.setup();
    if (operation === "read") {
      await user.click(screen.getByRole("button", { name: "显示网站 API 密钥" }));
      await user.click(screen.getByRole("button", { name: "读取明文" }));
    } else {
      await user.click(screen.getByRole("button", { name: "生成 API 密钥" }));
      await user.click(screen.getByRole("checkbox", { name: "我已了解影响，并准备好更新业务服务端。" }));
      await user.click(screen.getByRole("button", { name: "确认生成新密钥" }));
    }
    hidden.mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => { finish(json({ data: operation === "read"
      ? { value: syntheticSecret }
      : { secret: syntheticSecret, settings: { ...settings, revision: 4 } } })); });
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
    hidden.mockReturnValue(false);
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByText(syntheticSecret)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    if (operation === "rotate") expect(onSaved).toHaveBeenCalledOnce();
  });
});
