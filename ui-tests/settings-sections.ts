import { expect, type Locator, type Page } from "@playwright/test";

type Scope = Locator | Page;

export async function settingsSectionNavigation(scope: Scope, group: string) {
  const select = scope.getByRole("combobox", { name: group, exact: true });
  const tabs = scope.getByRole("tablist", { name: group, exact: true });
  await expect(select.or(tabs)).toBeVisible();
  // The component switches by its container width, including enlarged text.
  return await select.isVisible()
    ? { kind: "select" as const, control: select }
    : { kind: "tabs" as const, control: tabs };
}

export async function expectSettingsSection(scope: Scope, group: string, section: string) {
  const navigation = await settingsSectionNavigation(scope, group);
  if (navigation.kind === "select") await expect(navigation.control).toHaveText(section);
  else await expect(navigation.control.getByRole("tab", { name: section, exact: true })).toHaveAttribute("aria-selected", "true");
}

export async function selectSettingsSection(page: Page, scope: Scope, group: string, section: string, pointer: "click" | "tap" = "click") {
  const navigation = await settingsSectionNavigation(scope, group);
  if (navigation.kind === "select") {
    await navigation.control[pointer]();
    await page.getByRole("option", { name: section, exact: true })[pointer]();
    await expect(navigation.control).toHaveAttribute("aria-expanded", "false");
  } else {
    await navigation.control.getByRole("tab", { name: section, exact: true })[pointer]();
  }
  await expectSettingsSection(scope, group, section);
}

export async function expectSettingsSections(page: Page, scope: Scope, group: string, sections: readonly string[]) {
  const navigation = await settingsSectionNavigation(scope, group);
  if (navigation.kind === "select") {
    await navigation.control.click();
    await expect(page.getByRole("option")).toHaveText([...sections]);
    await page.keyboard.press("Escape");
    await expect(navigation.control).toHaveAttribute("aria-expanded", "false");
  } else {
    await expect(navigation.control.getByRole("tab")).toHaveText([...sections]);
  }
}
