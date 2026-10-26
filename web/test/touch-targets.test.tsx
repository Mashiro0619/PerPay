import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { SiteIdentity } from "../src/components/site-identity";
import { Button } from "../src/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../src/components/ui/tabs";
import { Toggle } from "../src/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../src/components/ui/toggle-group";
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
function touchValue(element: Element, property: string, pseudo?: "before") {
  return rules.reduce((value, rule) =>
    (pseudo
      ? rule.selectorText.includes("::" + pseudo) && element.matches(rule.selectorText.replaceAll("::" + pseudo, ""))
      : !rule.selectorText.includes("::") && element.matches(rule.selectorText))
      ? rule.style.getPropertyValue(property) || value
      : value,
  "");
}

describe("composed touch targets", () => {
  it("gives independent summary links a full touch target beside row navigation", () => {
    render(<MemoryRouter>
      <SiteIdentity clientId="shop" name="网站" />
      <a href="/orders/example" className="list-secondary-link">关联订单</a>
    </MemoryRouter>);
    for (const link of screen.getAllByRole("link")) {
      expect(touchValue(link, "min-height")).toBe("40px");
      expect(touchValue(link, "min-width")).toBe("40px");
    }
  });
  it("keeps tab visuals compact while reserving the expanded touch area", () => {
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
    expect(touchValue(tab, "min-height")).toBe("32px");
    expect(touchValue(tab, "height").replaceAll(" ", "")).toBe("max(32px,2rem)");
    expect(touchValue(tab, "min-height", "before")).toBe("40px");
    expect(touchValue(list, "min-height").replaceAll(" ", "")).toBe("max(40px,8px+2rem)");
    expect(touchValue(list, "padding-block")).toBe("4px");
    expect(container.querySelector('[data-slot="tabs-list"]')).toBe(list);
  });

  it("separates compact button visuals from their touch region and submit emphasis", () => {
    render(<>
      <Button variant="outline">筛选</Button>
      <Button type="submit">保存</Button>
    </>);
    const filter = screen.getByRole("button", { name: "筛选" });
    const submit = screen.getByRole("button", { name: "保存" });
    expect(touchValue(filter, "min-height")).toBe("32px");
    expect(touchValue(submit, "min-height")).toBe("36px");
    expect(touchValue(filter, "margin-block")).toBe("4px");
    expect(touchValue(submit, "margin-block")).toBe("2px");
    for (const button of [filter, submit]) {
      expect(touchValue(button, "min-height", "before")).toBe("40px");
      expect(touchValue(button, "min-width", "before")).toBe("40px");
      expect(touchValue(button, "position", "before")).toBe("absolute");
    }
  });

  it("reserves the icon button's full touch slot without enlarging its painted surface", () => {
    render(<Button size="icon-sm" aria-label="关闭">×</Button>);
    const icon = screen.getByRole("button", { name: "关闭" });
    expect(icon).toHaveClass("touch-icon");
    expect(touchValue(icon, "width")).toBe("32px");
    expect(touchValue(icon, "height")).toBe("32px");
    expect(touchValue(icon, "margin-block")).toBe("4px");
    expect(touchValue(icon, "margin-inline")).toBe("4px");
    expect(touchValue(icon, "min-height", "before")).toBe("40px");
    expect(touchValue(icon, "min-width", "before")).toBe("40px");
  });

  it("reserves independent toggle slots and keeps joined choices inside their own layout cells", () => {
    render(<>
      <Toggle aria-label="独立开关">切换</Toggle>
      <ToggleGroup aria-label="独立选项" defaultValue={["a"]}>
        <ToggleGroupItem value="a">第一项</ToggleGroupItem>
        <ToggleGroupItem value="b">第二项</ToggleGroupItem>
      </ToggleGroup>
      <ToggleGroup spacing={0} variant="outline" aria-label="连体选项" defaultValue={["c"]}>
        <ToggleGroupItem value="c">第三项</ToggleGroupItem>
        <ToggleGroupItem value="d">第四项</ToggleGroupItem>
      </ToggleGroup>
    </>);
    const toggle = screen.getByRole("button", { name: "独立开关" });
    expect(toggle).toHaveAttribute("data-variant", "default");
    expect(touchValue(toggle, "margin-block")).toBe("4px");
    expect(touchValue(toggle, "width", "before")).toBe("100%");
    const independent = screen.getByRole("button", { name: "第一项" });
    expect(touchValue(independent, "min-height")).toBe("32px");
    expect(touchValue(independent, "margin-block")).toBe("4px");
    const joined = screen.getByRole("button", { name: "第三项" });
    expect(touchValue(joined, "min-height")).toBe("40px");
    expect(touchValue(joined, "margin")).toBe("0px");
    expect(touchValue(joined, "width", "before")).toBe("100%");
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
    expect(touchValue(input, "min-height")).toBe("40px");
    expect(touchValue(screen.getByRole("button"), "min-height")).toBe("40px");
    expect(touchValue(screen.getByRole("button"), "margin")).toBe("0px");
    expect(touchValue(group, "height")).toBe("auto");
    expect(touchValue(group, "min-height")).toBe("40px");
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

  it("keeps menu rows full height while compacting the composed trigger visual", async () => {
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
    expect(touchValue(checkbox, "min-height")).toBe("40px");
    expect(touchValue(screen.getByRole("menuitem", { name: "普通操作" }), "min-height")).toBe("40px");
    const trigger = screen.getByRole("button", { name: "显示列" });
    expect(touchValue(trigger, "min-height")).toBe("32px");
    expect(touchValue(trigger, "min-height", "before")).toBe("40px");
  });
});
