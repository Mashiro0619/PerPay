import { describe, expect, it } from "vitest";
import {
  readColumnOverrides,
  resolveColumnVisibility,
  resolveSummaryVisibility,
  updateColumnOverrides,
  type ResponsiveColumn,
} from "../src/lib/table-columns";
const columns: ResponsiveColumn[] = [
  { id: "identity", hideable: false },
  { id: "amount" },
  { id: "status", responsive: { minWidthRem: 40 } },
  { id: "date", responsive: { minWidthRem: 32, basis: "container" } },
];
const small = { viewport: 390, container: 358, rem: 16 };
describe("responsive column visibility", () => {
  it("uses the original rem thresholds and distinguishes viewport from container width", () => {
    expect(resolveColumnVisibility(columns, {}, small)).toEqual({
      identity: true,
      amount: true,
      status: false,
      date: false,
    });
    expect(
      resolveColumnVisibility(
        columns,
        {},
        { viewport: 640, container: 511, rem: 16 },
      ),
    ).toEqual({ identity: true, amount: true, status: true, date: false });
    expect(
      resolveColumnVisibility(
        columns,
        {},
        { viewport: 639, container: 512, rem: 16 },
      ),
    ).toEqual({ identity: true, amount: true, status: false, date: true });
    expect(
      resolveColumnVisibility(
        columns,
        {},
        { viewport: 640, container: 512, rem: 20 },
      ),
    ).toEqual({ identity: true, amount: true, status: false, date: false });
  });
  it("honors explicit show/hide at every width while keeping required columns", () => {
    const preferences = { identity: false, amount: false, status: true };
    for (const size of [small, { viewport: 1280, container: 980, rem: 16 }]) {
      const visible = resolveColumnVisibility(columns, preferences, size);
      expect(visible.identity).toBe(true);
      expect(visible.amount).toBe(false);
      expect(visible.status).toBe(true);
    }
  });
  it("migrates only legacy false entries because true was written for defaults", () => {
    expect(
      readColumnOverrides(
        columns,
        null,
        JSON.stringify({
          identity: false,
          amount: false,
          status: true,
          date: true,
          unknown: false,
        }),
      ),
    ).toEqual({ amount: false });
  });
  it("keeps v2 overrides and does not reimport legacy preferences after resetting defaults", () => {
    expect(
      readColumnOverrides(
        columns,
        '{"identity":false,"amount":true,"status":false,"date":"bad"}',
        null,
      ),
    ).toEqual({ amount: true, status: false });
    expect(readColumnOverrides(columns, "{}", '{"amount":false}')).toEqual({});
  });
  it.each(["invalid", "null", "[]", "3"])(
    "tolerates malformed storage %s",
    (value) => {
      expect(readColumnOverrides(columns, value, null)).toEqual({});
    },
  );
  it("records only the changed column rather than freezing responsive defaults", () => {
    const visible = resolveColumnVisibility(columns, {}, small);
    const overrides = updateColumnOverrides(columns, {}, visible, {
      ...visible,
      status: true,
      identity: false,
    });
    expect(overrides).toEqual({ status: true });
    const wide = resolveColumnVisibility(columns, overrides, {
      viewport: 1280,
      container: 900,
      rem: 16,
    });
    expect(wide.date).toBe(true);
  });
});

describe("summary field visibility", () => {
  const fields: ResponsiveColumn[] = [
    { id: "identity", hideable: false },
    { id: "amount", summaryDefault: true },
    {
      id: "status",
      summaryDefault: true,
      responsive: { minWidthRem: 80, basis: "container" },
    },
    { id: "reference", summaryDefault: false },
    { id: "date", responsive: { minWidthRem: 32 } },
    { id: "actions", hideable: false },
  ];

  it("uses each business summary's chosen fields without inheriting desktop breakpoints", () => {
    expect(resolveSummaryVisibility(fields, {})).toEqual({
      identity: true,
      amount: true,
      status: true,
      reference: false,
      date: false,
      actions: true,
    });
  });

  it("honors explicit field choices while keeping identity and actions available", () => {
    expect(
      resolveSummaryVisibility(fields, {
        identity: false,
        amount: false,
        status: false,
        reference: true,
        date: true,
        actions: false,
      }),
    ).toEqual({
      identity: true,
      amount: false,
      status: false,
      reference: true,
      date: true,
      actions: true,
    });
  });

  it("records a hidden summary default even when its desktop column is already collapsed", () => {
    const visible = resolveSummaryVisibility(fields, {});
    const overrides = updateColumnOverrides(fields, {}, visible, {
      ...visible,
      status: false,
      reference: true,
    });
    expect(overrides).toEqual({ status: false, reference: true });
    expect(resolveSummaryVisibility(fields, overrides).status).toBe(false);
    const desktop = resolveColumnVisibility(fields, overrides, {
      viewport: 1600,
      container: 1440,
      rem: 16,
    });
    expect(desktop.status).toBe(false);
    expect(desktop.reference).toBe(true);
  });
});
