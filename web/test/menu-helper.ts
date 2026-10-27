import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
/** Wait for the official floating menu to finish positioning before interaction. */
export async function recordAction(action: string, menu = "订单操作") {
  const recordMenus = ["订单操作", "异常记录操作", "收款关联记录操作", "通知记录操作", "记录操作"];
  // Account and key menus are icon controls, not RecordTools triggers.
  const name = recordMenus.includes(menu) ? `更多操作，${menu}` : menu;
  const trigger = screen.getByRole("button", { name });
  if (trigger.getAttribute("aria-expanded") !== "true")
    fireEvent.click(trigger);
  const item = await screen.findByRole("menuitem", { name: action });
  await waitFor(() => expect(item).toBeVisible());
  return item;
}
