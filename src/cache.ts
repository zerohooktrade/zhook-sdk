/** Small in-memory TTL cache with in-flight de-duplication. */
export class TtlCache {
  private readonly entries = new Map<string, { until: number; value: Promise<unknown> }>();

  constructor(private readonly maxEntries = 2000) {}

  get<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.until > now) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { until: now + ttlSeconds * 1000, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    return value;
  }

  clear() {
    this.entries.clear();
  }
}
