/**
 * Very small in-memory TTL map used as a degraded fallback when Redis is unavailable.
 * Not suitable for multi-instance deployments; kept intentionally simple.
 */
export class InMemoryTtlCache {
  private map = new Map<string, number>();

  set(key: string, ttlSeconds: number) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.map.set(key, expiresAt);
  }

  has(key: string): boolean {
    const expiresAt = this.map.get(key);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  // Periodic cleanup to avoid unbounded growth (optional)
  cleanup() {
    const now = Date.now();
    for (const [k, v] of this.map.entries()) {
      if (v <= now) this.map.delete(k);
    }
  }
}
