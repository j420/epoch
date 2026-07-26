/**
 * Tiny in-memory LRU with optional TTL and byte accounting.
 * During a demo the same lines replay constantly; we never pay Sarvam twice for them.
 */
export class LRU<V> {
  private map = new Map<string, { v: V; bytes: number; expires: number }>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 500,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly ttlMs = 1000 * 60 * 60 * 6,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      this.bytes -= hit.bytes;
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.v;
  }

  set(key: string, v: V, bytes = 0): void {
    const existing = this.map.get(key);
    if (existing) this.bytes -= existing.bytes;
    this.map.set(key, { v, bytes, expires: Date.now() + this.ttlMs });
    this.bytes += bytes;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const victim = this.map.get(oldest.value)!;
      this.map.delete(oldest.value);
      this.bytes -= victim.bytes;
    }
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  get stats() {
    return { entries: this.map.size, bytes: this.bytes };
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}
