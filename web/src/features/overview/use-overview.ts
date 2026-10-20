import { useWorkspace } from "@/workspace";
import { useQuery } from '@/lib/workspace-query';
import { useSearchParams } from "react-router";
import { overviewQueries, overviewRange } from "@/api/workspace-queries";
import { useSystemStatus } from "@/features/system-status";
export function useOverview() {
  const [search, setSearch] = useSearchParams();
  const { clientId } = useWorkspace();
  const range = overviewRange(search);
  const { status, unavailable, checking } = useSystemStatus();
  const options = overviewQueries(clientId, range);
  const analytics = useQuery(options.analytics);
  const settings = useQuery(options.settings);
  const orders = useQuery(options.orders);
  const work = useQuery(options.work);
  const workSummary = useQuery(options.workSummary);
  return {
    clientId,
    range,
    analytics,
    settings,
    status,
    orders,
    work,
    workSummary,
    unavailable,
    checking,
    changeRange: (value: string) => {
      if (["7", "30", "90"].includes(value)) {
        const next = new URLSearchParams(search);
        next.set("range", value);
        setSearch(next, { replace: true });
      }
    },
  };
}
