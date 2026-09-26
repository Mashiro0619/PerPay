import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../src/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../src/components/ui/tabs";
import {
  InputGroup, InputGroupAddon, InputGroupButton,
  InputGroupInput, InputGroupTextarea,
} from "../src/components/ui/input-group";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuGroup, DropdownMenuItem, DropdownMenuCheckboxItem,
} from "../src/components/ui/dropdown-menu";

// JSDOM has no layout engine. Check that the coarse-pointer rules actually match
// the composed DOM slots, in addition to the real-browser geometry checks.
const css = readFileSync(resolve(process.cwd(), "web/src/styles.css"), "utf8");
const sheet = new CSSStyleSheet();
sheet.insertRule(css.slice(
  css.indexOf("@media (pointer: coarse)"),
  css.indexOf("@media (prefers-reduced-motion: reduce)"),
));
const rules = Array.from((sheet.cssRules[0] as CSSMediaRule).cssRules) as CSSStyleRule[];
function touchValue(element: Element, property: string) {
  return rules.reduce((value, rule) =>
    element.matches(rule.selectorText)
      ? rule.style.getPropertyValue(property) || value
      : value,
  "");
}

describe("composed touch targets", () => {
  it("reserves the trigger height plus both list paddings for every TabsList", () => {
    const { container } = render(
      <Tabs defaultValue="all">
        <TabsList aria-label="记录类型">
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="open">待处理</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const list = screen.getByRole("tablist");
    const tab = screen.getByRole("tab", { name: "全部" });
    expect(list).toHaveClass("p-[3px]");
    expect(touchValue(tab, "min-height")).toBe("44px");
    expect(touchValue(list, "min-height")).toBe("50px");
    expect(container.querySelector('[data-slot="tabs-list"]')).toBe(list);
  });

  it("grows the input group with its input and inline button, not only the button", () => {
    const { container } = render(
      <InputGroup>
        <InputGroupInput aria-label="管理员密码" type="password" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton aria-label="显示密码">显示</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    );
    const group = container.querySelector('[data-slot="input-group"]')!;
    const addon = container.querySelector('[data-slot="input-group-addon"]')!;
    const input = screen.getByLabelText("管理员密码");
    expect(input).toHaveAttribute("data-slot", "input-group-control");
    expect(touchValue(input, "min-height")).toBe("44px");
    expect(touchValue(screen.getByRole("button"), "min-height")).toBe("44px");
    expect(touchValue(group, "height")).toBe("auto");
    expect(touchValue(group, "min-height")).toBe("44px");
    expect(Number.parseFloat(touchValue(addon, "padding-block"))).toBe(0);
  });

  it("does not flatten multiline controls or block addons", () => {
    const { container } = render(
      <InputGroup>
        <InputGroupTextarea aria-label="备注" rows={4} />
        <InputGroupAddon align="block-end">补充说明</InputGroupAddon>
      </InputGroup>,
    );
    expect(touchValue(screen.getByRole("textbox"), "min-height")).toBe("");
    expect(touchValue(container.querySelector('[data-slot="input-group-addon"]')!, "padding-block")).toBe("");
  });

  it("keeps composed triggers and checkbox menu items at the same touch minimum", async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger render={<Button variant="outline" />}>显示列</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuItem>普通操作</DropdownMenuItem>
            <DropdownMenuCheckboxItem defaultChecked>实收金额</DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const checkbox = await screen.findByRole("menuitemcheckbox", { name: "实收金额" });
    expect(touchValue(checkbox, "min-height")).toBe("44px");
    expect(touchValue(screen.getByRole("menuitem", { name: "普通操作" }), "min-height")).toBe("44px");
    expect(touchValue(screen.getByRole("button", { name: "显示列" }), "min-height")).toBe("44px");
  });
});
