import { createHash } from 'node:crypto';

/**
 * Result of a successful CLAIR compression, stored in the cache.
 * Token counts are kept so a cache hit reports exactly the same
 * numbers the original CLAIR call would have reported.
 */
export interface CacheEntry {
  text: string;
  originalTokens: number;
  compressedTokens: number;
}

interface StoredEntry extends CacheEntry {
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
}

/**
 * In-memory LRU + TTL cache that sits in front of CLAIR Base.
 *
 * Repeated texts (system prompts in agent loops are the classic case) are
 * answered from memory: the gateway skips the CLAIR call entirely, which
 * removes its latency from the request path and reduces load on the
 * immutable service.
 *
 * Design notes:
 * - Keys are SHA-256 digests of the exact text sent to CLAIR, so entries are
 *   content-addressed and bounded in size regardless of prompt length.
 * - Only successful compressions with real gain are stored (enforced by the
 *   caller) — the cache never stores a no-gain or failed outcome, so a
 *   transient CLAIR failure cannot poison it.
 * - The cache lives in the process memory: a restart or a config change
 *   (e.g. COMPRESSION_MODE) naturally starts from a clean slate.
 */
export class PromptCache {
  private readonly map = new Map<string, StoredEntry>();

  /** Counters are monotonic process-lifetime metrics (also handy in tests). */
  readonly stats: CacheStats = { hits: 0, misses: 0, evictions: 0 };

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  /** Content-addressed cache key: SHA-256 of the exact text sent to CLAIR. */
  static keyFor(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  get(key: string): CacheEntry | null {
    const stored = this.map.get(key);
    if (!stored) {
      this.stats.misses++;
      return null;
    }
    if (Date.now() > stored.expiresAt) {
      this.map.delete(key);
      this.stats.misses++;
      return null;
    }
    // LRU refresh: re-inserting moves the key to the eviction tail.
    this.map.delete(key);
    this.map.set(key, stored);
    this.stats.hits++;
    return { text: stored.text, originalTokens: stored.originalTokens, compressedTokens: stored.compressedTokens };
  }

  set(key: string, entry: CacheEntry): void {
    if (this.maxEntries <= 0 || this.ttlMs <= 0) return;
    if (this.map.has(key)) this.map.delete(key);
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.stats.evictions++;
    }
    this.map.set(key, { ...entry, expiresAt: Date.now() + this.ttlMs });
  }

  /** Number of live entries (including not-yet-expired ones). */
  get size(): number {
    return this.map.size;
  }
}
