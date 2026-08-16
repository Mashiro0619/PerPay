import { Resolver } from "node:dns/promises";

export interface HostnameResolutionAddress {
  readonly address: string;
  readonly family: number;
}

export interface HostnameResolution {
  readonly result: Promise<readonly HostnameResolutionAddress[]>;
  /** Stops the underlying DNS work. Implementations must be idempotent and non-throwing. */
  cancel(): void;
}

export type StartHostnameResolution = (hostname: string) => HostnameResolution;

/** Starts one independently cancellable DNS resolution for a hostname. */
export const startHostnameResolution: StartHostnameResolution = startResolverQuery;

function startResolverQuery(hostname: string): HostnameResolution {
  const resolver = new Resolver();
  let cancelled = false;
  const result = resolveAddresses(resolver, hostname);
  return Object.freeze({
    result,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      resolver.cancel();
    },
  });
}

async function resolveAddresses(
  resolver: Resolver,
  hostname: string,
): Promise<readonly HostnameResolutionAddress[]> {
  const results = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);
  const addresses: HostnameResolutionAddress[] = [];
  let firstFailure: unknown;
  let hasFailure = false;
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      if (!hasFailure) firstFailure = result.reason;
      hasFailure = true;
      continue;
    }
    const family = index === 0 ? 4 : 6;
    for (const address of result.value) addresses.push(Object.freeze({ address, family }));
  }
  if (addresses.length === 0 && hasFailure) throw firstFailure;
  return Object.freeze(addresses);
}
