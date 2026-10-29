import type { AlipayAccountSnapshot } from "../alipay-accounts/model.ts";
import type { SiteConfiguration } from "../sites/model.ts";

/** Each draw removes its winner, so failed candidates are never retried in the same order. */
export function collectionCandidates(
  collection: SiteConfiguration["collection"],
  accounts: readonly AlipayAccountSnapshot[],
  available: (accountId: string) => boolean,
  random: () => number = Math.random,
): AlipayAccountSnapshot[] {
  if (!collection) return [];
  const candidates = collection.accounts.flatMap(candidate => {
    const account = accounts.find(account => account.id === candidate.account_id);
    return account?.enabled && account.configured && available(account.id)
      ? [{ account, weight: collection.mode === "WEIGHTED" ? candidate.weight : 1 }]
      : [];
  });
  if (collection.mode === "FIXED") return candidates.slice(0, 1).map(candidate => candidate.account);
  const result: AlipayAccountSnapshot[] = [];
  while (candidates.length) {
    const total = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
    let position = random() * total;
    let index = 0;
    while (index < candidates.length - 1 && position >= candidates[index]!.weight) {
      position -= candidates[index]!.weight;
      index++;
    }
    result.push(candidates.splice(index, 1)[0]!.account);
  }
  return result;
}
