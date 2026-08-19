export type TestPaymentObject = Record<string, any>;

function objectValue(value: unknown): TestPaymentObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as TestPaymentObject
    : {};
}

export function mergeTestPaymentOrder(
  current: TestPaymentObject | null,
  refreshed: TestPaymentObject,
): TestPaymentObject {
  return {
    ...(current ?? {}),
    ...refreshed,
    checkout: {
      ...objectValue(current?.checkout),
      ...objectValue(refreshed.checkout),
    },
  };
}

export function testPaymentTerminal(order: TestPaymentObject | null): boolean {
  return Boolean(
    order && (
      ["CONFIRMED", "DISPUTED"].includes(order.payment?.status)
      || ["EXPIRED", "CLOSED"].includes(order.checkout?.status)
    ),
  );
}
