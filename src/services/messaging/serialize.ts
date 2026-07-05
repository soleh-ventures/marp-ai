// Per-athlete inbound serialization (eng amendment 2).
//
// Every athleticHistory state transition is a full-object read-modify-write.
// Buttons make near-simultaneous inbounds routine (tap + typed text in the
// same second), and two concurrent pipelines holding stale history snapshots
// silently erase each other's writes. On a single Railway instance the cheap,
// sufficient fix is an in-memory promise chain per athlete key: all of one
// athlete's inbounds process strictly in arrival order; different athletes
// stay fully concurrent.

const chains = new Map<string, Promise<unknown>>();

export function enqueueForAthlete<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // Run regardless of whether the previous task failed — one bad message
  // must never wedge an athlete's queue.
  const next = prev.then(task, task);
  chains.set(key, next);
  // Drop the map entry once settled IF we're still the tail — keeps the map
  // from growing unboundedly. then(fn, fn) instead of finally() so a rejected
  // task doesn't spawn an unhandled-rejection chain here (the caller still
  // sees the rejection on the returned promise).
  const cleanup = () => {
    if (chains.get(key) === next) chains.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

// Test hook: how many athlete queues are currently live.
export function activeQueueCount(): number {
  return chains.size;
}
