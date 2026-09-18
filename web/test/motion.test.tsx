import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../src/components/ui/collapsible";
import { Button } from "../src/components/ui/button";
import { Input } from "../src/components/ui/input";

describe("official component visibility and motion", () => {
  it("keeps a collapsed advanced setting in FormData and restores its edited value", async () => {
    const { container } = render(
      <form>
        <Collapsible>
          <CollapsibleTrigger render={<Button />}>高级设置</CollapsibleTrigger>
          <CollapsibleContent keepMounted>
            <Input name="timeout" aria-label="超时" defaultValue="30" />
          </CollapsibleContent>
        </Collapsible>
      </form>,
    );
    const form = container.querySelector("form")!;
    expect(new FormData(form).get("timeout")).toBe("30");
    expect(
      screen.queryByRole("textbox", { name: "超时" }),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "高级设置" }));
    const input = screen.getByRole("textbox", { name: "超时" });
    await user.clear(input);
    await user.type(input, "60");
    await user.click(screen.getByRole("button", { name: "高级设置" }));
    expect(new FormData(form).get("timeout")).toBe("60");
    await user.click(screen.getByRole("button", { name: "高级设置" }));
    expect(screen.getByRole("textbox", { name: "超时" })).toBe(input);
    expect(input).toHaveValue("60");
  });
  it("does not import the retired route staging or selection animation layers", () => {
    const app = readFileSync(resolve(process.cwd(), "web/src/App.tsx"), "utf8");
    expect(app).not.toMatch(
      /RouteTransition|SelectionIndicator|is-entering|is-leaving/,
    );
    expect(app).toContain("SidebarInset");
  });
  it("honors reduced motion and coarse-pointer targets without a legacy CSS overlay", () => {
    const css = readFileSync(
      resolve(process.cwd(), "web/src/styles.css"),
      "utf8",
    );
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (pointer: coarse)");
    expect(css).toContain("min-height: 44px");
    expect(css).not.toMatch(new RegExp("@import.*styles/|data-palette"));
  });
});
