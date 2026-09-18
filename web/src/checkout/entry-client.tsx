import { hydrateRoot } from "react-dom/client";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { CheckoutApp } from "./CheckoutApp";
import type { CheckoutInitial } from "../../../src/shared/checkout-view";
import "../styles.css";
const root = document.getElementById("checkout-root");
if (root) {
  const initial = JSON.parse(
    root.dataset.initial ?? "null",
  ) as CheckoutInitial | null;
  if (initial)
    hydrateRoot(
      root,
      <CSPProvider disableStyleElements>
        <CheckoutApp initial={initial} />
      </CSPProvider>,
      { identifierPrefix: "checkout-" },
    );
}
