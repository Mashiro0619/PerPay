import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailFields } from "../src/components/detail/DetailPrimitives";
import { Empty, EmptyHeader, EmptyTitle, InlineEmpty } from "../src/components/admin-empty";
describe("administrator content presentation", () => {
  it("uses its own container and preserves zero values while normalizing blanks", () => {
    const {container} = render(<DetailFields items={[["空值", null], ["空文本", ""], ["零", 0], ["长值", "x".repeat(300)]]} wide={["长值"]} />);
    expect(container.firstChild).toHaveClass("@container/detail-fields");
    expect(container.querySelector("dl")).toHaveClass("@sm/detail-fields:grid-cols-2");
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
