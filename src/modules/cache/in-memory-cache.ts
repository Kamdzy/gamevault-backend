/**
 * Very small in-memory TTL map used as a degraded fallback when Redis is unavailable.
 * Not suitable for multi-instance deployments; kept intentionally simple.
 */
export class InMemoryTtlCache {
  private readonly cache = new Map<string, { value: any; expiresAt: number }>();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly MAX_CACHE_SIZE = 1000; // Maximum 1000 entries
  private readonly CLEANUP_INTERVAL_MS = 60000; // Cleanup every minute

  constructor() {
    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.CLEANUP_INTERVAL_MS);
  }

  set(key: string, ttlSeconds: number, value: any = true): void {
    // Check size limit before adding
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      // Remove oldest entries (LRU-style)
      this.evictOldest();
    }
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.cache.set(key, { value, expiresAt });
  }

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  // Remove expired entries
  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
    if (keysToDelete.length > 0) {
      console.log(`Cleaned up ${keysToDelete.length} expired cache entries`);
    }
  }

  // Evict oldest 25% of entries when cache is full
  private evictOldest(): void {
    const entries = Array.from(this.cache.entries());
    // Sort by expiration time (oldest first)
    entries.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    // Remove oldest 25%
    const toRemove = Math.floor(this.cache.size * 0.25);
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
    console.log(`Evicted ${toRemove} oldest cache entries (cache was full)`);
  }

  // Get cache statistics
  getStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.MAX_CACHE_SIZE,
    };
  }

  // Cleanup on destroy
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.cache.clear();
  }
}
