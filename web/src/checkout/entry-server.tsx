import { renderToString } from "react-dom/server";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { CheckoutApp } from "./CheckoutApp";
import type { CheckoutInitial } from "../../../src/shared/checkout-view";
export function renderCheckout(initial: CheckoutInitial) {
  return renderToString(
    <CSPProvider disableStyleElements>
      <CheckoutApp initial={initial} />
    </CSPProvider>,
    { identifierPrefix: "checkout-" },
  );
}
