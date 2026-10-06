import { api } from "./client";
/** Bind once when rendering/creating an operation. No mutable current-site interceptor. */
export function workspaceApi(clientId: string | null): typeof api {
  if (!clientId) return api;
  return new Proxy(api, {
    get(target, name: keyof typeof api) {
      const scoped = ("site" +
        String(name)[0]!.toUpperCase() +
        String(name).slice(1)) as keyof typeof api;
      if (!(scoped in target)) {
        if (
          [
            "getLedgerConflict",
            "resolveLedgerConflict",
            "listManualSettlementOrders",
          ].includes(String(name))
        )
          return () => {
            throw new Error("该共享账本操作只能在一级后台执行。");
          };
        return target[name];
      }
      return (options: Record<string, unknown> = {}) => {
        const copy = {
          ...options,
          path: { ...(options.path as object), clientId },
        };
        for (const key of ["query", "body"] as const) {
          const value = options[key] as Record<string, unknown> | undefined;
          if (!value) continue;
          if (
            value.api_client_id !== undefined &&
            value.api_client_id !== clientId
          )
            throw new Error("网站范围不一致，操作未发送。");
          const { api_client_id: _identity, ...fields } = value;
          Object.assign(copy, { [key]: fields });
        }
        return (target[scoped] as (options: unknown) => unknown)(copy);
      };
    },
  });
}
