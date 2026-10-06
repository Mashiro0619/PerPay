import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
export async function selectTestWebsite() {
  const trigger = await screen.findByRole("combobox", { name: "业务网站" });
  if (trigger.textContent?.includes("测试网站")) return;
  const user = userEvent.setup();
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: "测试网站" }));
}
