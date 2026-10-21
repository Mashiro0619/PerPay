import { Navigate, useLocation, useParams } from "react-router";

/** Keep saved links and return state while consolidating the two entry points. */
export function LedgerListRedirect() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  query.set("tab", "transactions");
  return <Navigate replace to={{ pathname: "/reconciliation", search: "?" + query.toString(), hash: location.hash }} state={location.state} />;
}

export function LedgerDetailRedirect() {
  const location = useLocation();
  const { ledgerEntryId = "", resourceId = "" } = useParams();
  const id = ledgerEntryId || resourceId;
  return <Navigate replace to={{ pathname: "/reconciliation/transactions/" + id, search: location.search, hash: location.hash || (resourceId ? "#source-" + id : "") }} state={location.state} />;
}
