import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
/** Wait for the official floating menu to finish positioning before interaction. */
export async function recordAction(action: string, menu = "订单操作") {
  const trigger = screen.getByRole("button", { name: menu });
  if (trigger.getAttribute("aria-expanded") !== "true")
    fireEvent.click(trigger);
  const item = await screen.findByRole("menuitem", { name: action });
  await waitFor(() => expect(item).toBeVisible());
  return item;
}
