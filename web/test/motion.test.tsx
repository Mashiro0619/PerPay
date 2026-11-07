import { createHash } from "node:crypto";
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
  it("uses the unmodified shadcn 4.21.4 stylesheet without a CLI CSS import", () => {
    const css = readFileSync(resolve(process.cwd(), "web/src/styles.css"), "utf8");
    const upstream = readFileSync(
      resolve(process.cwd(), "web/src/vendor/shadcn-tailwind.css"),
    );
    expect(css).toContain('@import "./vendor/shadcn-tailwind.css";');
    expect(css).not.toContain('@import "shadcn/tailwind.css";');
    expect(createHash("sha256").update(upstream).digest("hex")).toBe(
      "4c371f7a1ff5d219ae2f7ff28bd256b4346fd546fe46fbae22092e57db2f0fae",
    );
  });
});
