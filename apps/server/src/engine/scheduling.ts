/** Tasks per owner that may run at once when TASK_MAX_CONCURRENT_PER_USER is unset. */
export const defaultMaxConcurrentPerUser = 3;

/** Tasks one tick may claim across every owner. */
const maxClaimsPerTick = 3;

/** A durable record paired with the tenant that owns it — the shape `Store.scan` returns. */
export interface OwnedTask<T> {
  owner: string;
  value: T;
}

/** Least loaded owner first; equally loaded owners keep arrival order. */
function precedes<T extends { id: string; createdAt: string }>(
  left: OwnedTask<T>,
  right: OwnedTask<T>,
  load: Map<string, number>,
): boolean {
  const delta = (load.get(left.owner) ?? 0) - (load.get(right.owner) ?? 0);
  if (delta !== 0) return delta < 0;
  const arrival = left.value.createdAt.localeCompare(right.value.createdAt);
  return arrival !== 0 ? arrival < 0 : left.value.id.localeCompare(right.value.id) < 0;
}

/**
 * Picks the tasks a tick should claim.
 *
 * Each pick goes to the owner holding the fewest tasks and the load is re-read before the next
 * one, so a tenant with a deep backlog cannot take a whole tick while another tenant waits behind
 * it. An owner already at the limit is skipped per task rather than skipped entirely, so its
 * backlog never holds up anyone else's queue.
 *
 * `runningByOwner` must count only tasks whose lease is still live: an expired lease belongs to a
 * task that is about to be reclaimed, and counting it would pin that owner at the limit forever.
 */
export function selectEligible<T extends { id: string; createdAt: string }>(
  candidates: OwnedTask<T>[],
  runningByOwner: Map<string, number>,
  maxConcurrentPerUser: number,
  batchSize = maxClaimsPerTick,
): OwnedTask<T>[] {
  const load = new Map(runningByOwner);
  const waiting = [...candidates];
  const selected: OwnedTask<T>[] = [];
  while (selected.length < batchSize) {
    let pick = -1;
    for (const [index, candidate] of waiting.entries()) {
      if ((load.get(candidate.owner) ?? 0) >= maxConcurrentPerUser) continue;
      if (pick === -1 || precedes(candidate, waiting[pick], load)) pick = index;
    }
    if (pick === -1) break;
    const [chosen] = waiting.splice(pick, 1);
    // Claimed here, started by the caller: count it so the next pick sees the slot gone.
    load.set(chosen.owner, (load.get(chosen.owner) ?? 0) + 1);
    selected.push(chosen);
  }
  return selected;
}
