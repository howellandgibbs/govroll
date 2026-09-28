/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the result. A plain `Promise.all(items.map(fn))` fires every
 * request at once, which is how upstream APIs (GovTrack, Congress.gov) end up
 * timing out or hanging up on us.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
