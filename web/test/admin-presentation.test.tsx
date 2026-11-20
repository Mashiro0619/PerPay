import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FieldList } from "../src/components/record/FieldList";
import { Empty, EmptyHeader, EmptyTitle, InlineEmpty } from "../src/components/admin-empty";
describe("administrator content presentation", () => {
  it("uses its own container and preserves zero values while normalizing blanks", () => {
    const {container} = render(<FieldList items={[{ label: "空值", value: null }, { label: "空文本", value: "" }, { label: "零", value: 0 }, { label: "长值", value: "x".repeat(300) }]} />);
    expect(container.firstChild).toHaveClass("@container/fields");
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("0")).toBeVisible();
    expect(screen.getByText("x".repeat(300))).toHaveClass("wrap-anywhere");
  });
  it("distinguishes filtered empty surfaces from compact inline absence", () => {
    const {container} = render(<><Empty kind="filtered"><EmptyHeader><EmptyTitle>无匹配记录</EmptyTitle></EmptyHeader></Empty><InlineEmpty>暂无明细</InlineEmpty></>);
    expect(container.querySelector('[data-empty-kind="filtered"]')).toHaveClass("p-4");
    expect(screen.getByText("暂无明细").tagName).toBe("P");
    expect(screen.getByText("暂无明细")).not.toHaveClass("border", "p-6");
  });
});
