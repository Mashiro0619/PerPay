import { fireEvent, screen } from "@testing-library/react";

/** Exercise the same explicit record-menu entry point as a user. */
export function recordAction(action: string, menu = "订单操作") {
  fireEvent.click(screen.getByRole("button", { name: menu }));
  return screen.getByRole("menuitem", { name: action });
}
