/**
 * Fork contract tests — Kamdzy's fork of Phalcode/gamevault-backend.
 *
 * Every test here guards a behavior that exists ONLY in this fork. Upstream
 * does it differently, so a `git merge upstream/master` can silently revert any
 * of them: the merge stays clean, the build passes, and the behavior is gone.
 *
 * If a test in this file fails after an upstream merge, the merge reverted a
 * fork change — fix the merge, not the test. Only change a test here when the
 * fork deliberately changes its own behavior.
 *
 * See CLAUDE.md → "Preserving the Fork Across Upstream Merges".
 */

import type { Mock } from "vitest";
import configuration from "./configuration.js";
import { GamesService } from "./modules/games/games.service.js";
import { MetadataService } from "./modules/metadata/metadata.service.js";
import { MetadataProvider } from "./modules/metadata/providers/abstract.metadata-provider.service.js";

vi.mock("./configuration.js", () => ({
  __esModule: true,
  default: {
    METADATA: { TTL_IN_DAYS: 30 },
    GAMES: { WINDOWS_SETUP_DEFAULT_INSTALL_PARAMETERS: "" },
    TESTING: { MOCK_FILES: true },
    VOLUMES: { MEDIA: "/media" },
  },
}));

vi.mock("./logging.js", () => ({
  __esModule: true,
  default: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  logGamevaultGame: vi.fn((g) => ({ id: g?.id })),
  logGamevaultUser: vi.fn(),
  logMedia: vi.fn(),
  logMetadata: vi.fn(),
  logMetadataProvider: vi.fn((p) => ({ slug: p?.slug })),
  logProgress: vi.fn(),
}));

vi.mock("class-validator", async () => ({
  ...(await vi.importActual("class-validator")),
  validateOrReject: vi.fn().mockResolvedValue(undefined),
}));

/**
 * addUpdateMetadataJob() starts processQueue() fire-and-forget, so assertions
 * made immediately after it would pass vacuously. This waits for the queue to
 * actually drain.
 */
async function drainMetadataQueue(service: MetadataService): Promise<void> {
  const internals = service as unknown as {
    metadataJobs: Set<number>;
    isProcessingQueue: boolean;
  };
  for (let i = 0; i < 100; i++) {
    if (internals.metadataJobs.size === 0 && !internals.isProcessingQueue) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Metadata queue did not drain");
}

/**
 * Relations are expressed as a string array in older trees and as a nested
 * object tree since upstream v17 (toFindOptionsRelations). Normalize both to a
 * sorted path list so these tests assert on WHICH relations are loaded rather
 * than on how they happen to be encoded.
 */
function relationPaths(relations: unknown): string[] {
  if (!relations) return [];
  if (Array.isArray(relations)) return [...relations].sort();

  const walk = (node: any, prefix: string): string[] =>
    Object.entries(node).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return value === true ? [path] : walk(value, path);
    });
  return walk(relations, "").sort();
}

function createMockProvider(
  overrides: Partial<MetadataProvider> = {},
): MetadataProvider {
  return {
    slug: "test-provider",
    name: "Test Provider",
    priority: 10,
    enabled: true,
    request_interval_ms: 0,
    search: vi.fn(),
    getByProviderDataIdOrFail: vi.fn(),
    getBestMatch: vi.fn(),
    register: vi.fn(),
    ...overrides,
  } as unknown as MetadataProvider;
}

describe("Fork delta: metadata queue holds IDs, not entities", () => {
  let service: MetadataService;
  let gamesService: any;
  let gameMetadataService: any;

  beforeEach(() => {
    gamesService = {
      findOneByGameIdOrFail: vi.fn(),
      save: vi.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: vi.fn().mockReturnValue("sort-title"),
    };
    gameMetadataService = {
      save: vi.fn().mockImplementation((m) => Promise.resolve({ ...m, id: 1 })),
      deleteByGameMetadataIdOrFail: vi.fn().mockResolvedValue(undefined),
    };
    service = new MetadataService(
      gamesService,
      gameMetadataService,
      configuration as any,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * Upstream: addUpdateMetadataJob(game: GamevaultGame) and the queue is a
   * Map<number, GamevaultGame>, pinning every hydrated game in heap until
   * processed. The fork takes an ID and re-loads the game inside processQueue.
   */
  it("accepts a numeric game id and loads the game inside the queue", async () => {
    gamesService.findOneByGameIdOrFail.mockResolvedValue({
      id: 5,
      provider_metadata: [],
      versions: [],
      file_path: "/games/Test Game.zip",
    });

    await service.addUpdateMetadataJob(5);
    await drainMetadataQueue(service);

    expect(gamesService.findOneByGameIdOrFail).toHaveBeenCalledWith(5, {
      loadDeletedEntities: false,
      // "versions" is eager on the entity and updateMetadata() reads it for
      // the (NC) skip check, so it must be named explicitly now that relation
      // loading is opt-in.
      loadRelations: ["provider_metadata", "versions"],
    });
  });

  /**
   * The queue is keyed by id, so enqueuing the same game again while it is
   * still queued is a no-op rather than a second load.
   */
  it("deduplicates jobs by id", async () => {
    gamesService.findOneByGameIdOrFail.mockResolvedValue({
      id: 7,
      provider_metadata: [],
      versions: [],
      file_path: "/games/Test Game.zip",
    });

    await service.addUpdateMetadataJob(7);
    await service.addUpdateMetadataJob(7);
    await drainMetadataQueue(service);

    // Count only the queue's own load signature, so an unrelated load (e.g.
    // from merge()) can't mask a genuine duplicate.
    const queueLoads = gamesService.findOneByGameIdOrFail.mock.calls.filter(
      ([id, options]: [number, any]) =>
        id === 7 &&
        Array.isArray(options?.loadRelations) &&
        options.loadRelations.includes("provider_metadata"),
    );
    expect(queueLoads).toHaveLength(1);
  });
});

describe("Fork delta: merge is skipped when no provider changed", () => {
  let service: MetadataService;
  let gamesService: any;

  beforeEach(() => {
    gamesService = {
      findOneByGameIdOrFail: vi.fn(),
      save: vi.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: vi.fn().mockReturnValue("sort-title"),
    };
    service = new MetadataService(
      gamesService,
      { save: vi.fn(), deleteByGameMetadataIdOrFail: vi.fn() } as any,
      configuration as any,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * Upstream calls this.merge(game.id) unconditionally at the end of
   * updateMetadata. On a full re-index where every provider is within TTL that
   * fires thousands of un-awaited merges and exhausts the heap. The fork only
   * merges when a provider actually changed.
   */
  it("does not merge when every provider is within its TTL", async () => {
    service.registerProvider(
      createMockProvider({ slug: "igdb", priority: 10 }),
    );
    const mergeSpy = vi.spyOn(service, "merge").mockResolvedValue({} as any);

    gamesService.findOneByGameIdOrFail.mockResolvedValue({
      id: 1,
      versions: [],
      file_path: "/games/Test Game.zip",
      provider_metadata: [
        {
          provider_slug: "igdb",
          provider_data_id: "abc",
          updated_at: new Date(), // fresh -> within TTL
        },
      ],
    });

    await service.addUpdateMetadataJob(1);
    await drainMetadataQueue(service);

    expect(mergeSpy).not.toHaveBeenCalled();
  });

  /** Sanity counterpart: a stale provider must still trigger a merge. */
  it("merges when a provider is stale", async () => {
    service.registerProvider(
      createMockProvider({ slug: "igdb", priority: 10 }),
    );
    const mergeSpy = vi.spyOn(service, "merge").mockResolvedValue({} as any);
    vi.spyOn(service as any, "map").mockResolvedValue(undefined);

    gamesService.findOneByGameIdOrFail.mockResolvedValue({
      id: 2,
      versions: [],
      file_path: "/games/Test Game.zip",
      provider_metadata: [
        {
          provider_slug: "igdb",
          provider_data_id: "abc",
          updated_at: new Date("2000-01-01"), // far outside TTL
        },
      ],
    });

    await service.addUpdateMetadataJob(2);
    await drainMetadataQueue(service);

    expect(mergeSpy).toHaveBeenCalledWith(2);
  });
});

describe("Fork delta: negative-priority providers are disabled", () => {
  let service: MetadataService;
  let gamesService: any;

  beforeEach(() => {
    gamesService = {
      findOneByGameIdOrFail: vi.fn(),
      save: vi.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: vi.fn().mockReturnValue("sort-title"),
    };
    service = new MetadataService(
      gamesService,
      { save: vi.fn(), deleteByGameMetadataIdOrFail: vi.fn() } as any,
      configuration as any,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * Fork-only concept: a provider whose effective priority is negative is
   * treated as disabled for that game and is never fetched.
   */
  it("never fetches metadata from a globally negative-priority provider", async () => {
    service.registerProvider(
      createMockProvider({ slug: "vndb", priority: -1 }),
    );
    const findMetadataSpy = vi
      .spyOn(service as any, "findMetadata")
      .mockResolvedValue(undefined);
    const mergeSpy = vi.spyOn(service, "merge").mockResolvedValue({} as any);

    gamesService.findOneByGameIdOrFail.mockResolvedValue({
      id: 3,
      versions: [],
      file_path: "/games/Test Game.zip",
      provider_metadata: [],
    });

    await service.addUpdateMetadataJob(3);
    await drainMetadataQueue(service);

    expect(findMetadataSpy).not.toHaveBeenCalled();
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  /**
   * A per-game provider_priority override of -1 disables an otherwise
   * positive-priority provider for that game only.
   */
  it("respects a per-game negative provider_priority override", async () => {
    service.registerProvider(
      createMockProvider({ slug: "igdb", priority: 10 }),
    );
    const mapSpy = vi.spyOn(service as any, "map").mockResolvedValue(undefined);
    const mergeSpy = vi.spyOn(service, "merge").mockResolvedValue({} as any);

    gamesService.findOneByGameIdOrFail.mockResolvedValue({
      id: 4,
      versions: [],
      file_path: "/games/Test Game.zip",
      provider_metadata: [
        {
          provider_slug: "igdb",
          provider_data_id: "abc",
          provider_priority: -1,
          updated_at: new Date("2000-01-01"), // stale, but disabled
        },
      ],
    });

    await service.addUpdateMetadataJob(4);
    await drainMetadataQueue(service);

    expect(mapSpy).not.toHaveBeenCalled();
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  /**
   * The filter must also apply at merge time, so metadata rows already in the
   * DB for a negative-priority provider contribute nothing to the merged
   * result. Guards getMergeableProviderMetadata().
   *
   * NOTE — this is the one test that does not pass on the pre-v17 baseline,
   * by design. Before the v17 merge the filter lived downstream in
   * mergeProviderMetadata(), so a negative-priority provider was excluded from
   * the merged *content* but merge() still ran to completion and saved. The
   * v17 resolution moved the filter into getMergeableProviderMetadata(), which
   * runs before merge()'s "nothing to merge" guard — so merge() now bails out
   * and skips the pointless write. Same end state, one fewer save.
   */
  it("excludes negative-priority metadata from the merged result", async () => {
    service.registerProvider(
      createMockProvider({ slug: "vndb", priority: -1 }),
    );
    const game = {
      id: 9,
      provider_metadata: [
        { provider_slug: "vndb", provider_data_id: "x", name: "From VNDB" },
      ],
      user_metadata: null,
      metadata: null,
    };
    gamesService.findOneByGameIdOrFail.mockResolvedValue(game);

    const result = await service.merge(9);

    // Nothing mergeable -> merge bails out and returns the game untouched.
    expect(gamesService.save).not.toHaveBeenCalled();
    expect(result).toBe(game);
  });
});

describe("Fork delta: cascade-sensitive relations are loaded before saving", () => {
  let service: MetadataService;
  let gamesService: any;

  beforeEach(() => {
    gamesService = {
      findOneByGameIdOrFail: vi.fn().mockResolvedValue({
        id: 1,
        provider_metadata: [],
        user_metadata: null,
        metadata: null,
      }),
      save: vi.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: vi.fn().mockReturnValue("sort-title"),
    };
    service = new MetadataService(
      gamesService,
      {
        save: vi.fn().mockImplementation((m) => Promise.resolve(m)),
        deleteByGameMetadataIdOrFail: vi.fn().mockResolvedValue(undefined),
      } as any,
      configuration as any,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * Because relation loading is opt-in in this fork, any relation NOT loaded
   * before a save() is absent from the entity — and TypeORM cascades then
   * delete the corresponding rows. This caused real data loss (716e36f).
   *
   * merge() already named all three upstream; it is asserted here because the
   * fork's opt-in loading is what makes it load-bearing rather than redundant.
   */
  it("merge() loads metadata, provider_metadata and user_metadata", async () => {
    await service.merge(1);

    expect(gamesService.findOneByGameIdOrFail).toHaveBeenCalledWith(1, {
      loadDeletedEntities: false,
      loadRelations: expect.arrayContaining([
        "metadata",
        "provider_metadata",
        "user_metadata",
      ]),
    });
  });

  /** Fork-only: upstream's unmap() passes no loadRelations at all. */
  it("unmap() loads metadata, provider_metadata and user_metadata", async () => {
    await service.unmap(1, "igdb");

    expect(gamesService.findOneByGameIdOrFail).toHaveBeenCalledWith(1, {
      loadDeletedEntities: false,
      loadRelations: expect.arrayContaining([
        "metadata",
        "provider_metadata",
        "user_metadata",
      ]),
    });
  });

  /**
   * Fork-only: upstream's map() loads only ["provider_metadata"], so saving the
   * game afterwards cascaded away its metadata and user_metadata rows.
   */
  it("map() loads metadata and user_metadata alongside provider_metadata", async () => {
    service.registerProvider(
      createMockProvider({
        slug: "igdb",
        priority: 10,
        getByProviderDataIdOrFail: vi
          .fn()
          .mockResolvedValue({ provider_slug: "igdb", provider_data_id: "x" }),
      }),
    );
    gamesService.findOneByGameIdOrFail.mockResolvedValue({
      id: 1,
      provider_metadata: [],
      user_metadata: null,
      metadata: null,
    });

    await service.map(1, "igdb", "x");

    // map() calls unmap() first, so there are two loads here. Both must carry
    // all three relations — asserting on only the first would silently pass
    // while map()'s own load regressed to ["provider_metadata"].
    const loads = gamesService.findOneByGameIdOrFail.mock.calls.filter(
      ([, options]: [number, any]) =>
        Array.isArray(options?.loadRelations) &&
        options.loadRelations.includes("provider_metadata"),
    );
    expect(loads.length).toBeGreaterThanOrEqual(2);
    for (const [, options] of loads) {
      expect(options.loadRelations).toEqual(
        expect.arrayContaining([
          "provider_metadata",
          "metadata",
          "user_metadata",
        ]),
      );
    }
  });
});

/**
 * `GameMetadata` declares cover / background / publishers / developers /
 * tags / genres as `eager: true`. Pre-v17 the fork relied on TypeORM 0.3.x
 * lazily honoring `loadEagerRelations: false` and still loading those child
 * eagers when the parent load named `metadata` / `provider_metadata` /
 * `user_metadata`. The v17 upstream merge (21da181) bumped TypeORM to 1.0,
 * which strictly propagates the flag. Recache builds the merged row by
 * spreading provider/user metadata and running `stripEmptyFields` — undefined
 * cover/background get stripped, the INSERT writes cover_id/background_id
 * NULL, and box art disappears.
 *
 * The fix explicitly names the child paths in the recache loads. These tests
 * fail if any of `map`/`unmap`/`merge` regresses to a bare parent list.
 * Mutation-verified: replacing CASCADE_SAFE_METADATA_RELATIONS with the
 * pre-fix `["metadata","provider_metadata","user_metadata"]` array in
 * metadata.service.ts makes all three tests fail.
 */
describe("Fork delta: recache loads nested eager children explicitly (TypeORM 1.0)", () => {
  let service: MetadataService;
  let gamesService: any;

  beforeEach(() => {
    gamesService = {
      findOneByGameIdOrFail: vi.fn().mockResolvedValue({
        id: 1,
        provider_metadata: [],
        user_metadata: null,
        metadata: null,
      }),
      save: vi.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: vi.fn().mockReturnValue("sort-title"),
    };
    service = new MetadataService(
      gamesService,
      {
        save: vi.fn().mockImplementation((m) => Promise.resolve(m)),
        deleteByGameMetadataIdOrFail: vi.fn().mockResolvedValue(undefined),
      } as any,
      configuration as any,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  const EAGER_CHILDREN = [
    "cover",
    "background",
    "publishers",
    "developers",
    "tags",
    "genres",
  ] as const;
  const EAGER_PARENTS = [
    "metadata",
    "provider_metadata",
    "user_metadata",
  ] as const;
  const REQUIRED_SUB_RELATIONS = EAGER_PARENTS.flatMap((parent) =>
    EAGER_CHILDREN.map((child) => `${parent}.${child}`),
  );

  it("merge() loads every eager child of metadata/provider_metadata/user_metadata", async () => {
    await service.merge(1);

    const call = gamesService.findOneByGameIdOrFail.mock.calls[0];
    expect(call[1].loadRelations).toEqual(
      expect.arrayContaining(REQUIRED_SUB_RELATIONS),
    );
  });

  it("unmap() loads every eager child of metadata/provider_metadata/user_metadata", async () => {
    await service.unmap(1, "igdb");

    const call = gamesService.findOneByGameIdOrFail.mock.calls[0];
    expect(call[1].loadRelations).toEqual(
      expect.arrayContaining(REQUIRED_SUB_RELATIONS),
    );
  });

  it("map() loads every eager child on both its own load and the unmap() reload", async () => {
    service.registerProvider(
      createMockProvider({
        slug: "igdb",
        priority: 10,
        getByProviderDataIdOrFail: vi
          .fn()
          .mockResolvedValue({ provider_slug: "igdb", provider_data_id: "x" }),
      }),
    );

    await service.map(1, "igdb", "x");

    const loads = gamesService.findOneByGameIdOrFail.mock.calls.filter(
      ([, options]: [number, any]) =>
        Array.isArray(options?.loadRelations) &&
        options.loadRelations.includes("provider_metadata"),
    );
    expect(loads.length).toBeGreaterThanOrEqual(2);
    for (const [, options] of loads) {
      expect(options.loadRelations).toEqual(
        expect.arrayContaining(REQUIRED_SUB_RELATIONS),
      );
    }
  });
});

/**
 * Fork: `provider_priority < 0` is the quarantine convention (disabled for
 * this game — filtered by `hasNegativePriority`). Historically `map()` always
 * fetched from the provider first and then applied the override, which meant
 * setting priority to -1 on a stale mapping crashed with HTTP 500: the
 * provider fetch failed on the dead id, and the "disable" write never
 * happened. These tests guard the fix that lets disable-intent PUTs succeed
 * even when the provider can no longer resolve the stored id.
 *
 * Mutation-verified: removing the `isDisableIntent` branch in `map()` makes
 * "map() with priority=-1 succeeds even when provider fetch throws" and
 * "existing metadata row is preserved..." fail.
 */
describe("Fork delta: map() with negative priority quarantines even when the provider fetch fails", () => {
  let service: MetadataService;
  let gamesService: any;
  let gameMetadataService: any;
  const EXISTING_META = {
    id: 999,
    provider_slug: "igdb",
    provider_data_id: "dead-id",
    title: "Preserved Title",
    description: "Preserved description",
    provider_priority: 5,
  };

  beforeEach(() => {
    gamesService = {
      findOneByGameIdOrFail: vi.fn().mockResolvedValue({
        id: 1,
        provider_metadata: [],
        user_metadata: null,
        metadata: null,
      }),
      save: vi.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: vi.fn().mockReturnValue("sort"),
    };
    gameMetadataService = {
      save: vi
        .fn()
        .mockImplementation((m) => Promise.resolve({ id: 42, ...m })),
      deleteByGameMetadataIdOrFail: vi.fn().mockResolvedValue(undefined),
      findOrCreateMinimalStub: vi.fn().mockResolvedValue({ ...EXISTING_META }),
      setProviderPriority: vi.fn().mockResolvedValue(undefined),
    };
    service = new MetadataService(
      gamesService,
      gameMetadataService,
      configuration as any,
    );
    service.registerProvider(
      createMockProvider({
        slug: "igdb",
        priority: 10,
        getByProviderDataIdOrFail: vi
          .fn()
          .mockRejectedValue(new Error("No game found with ID: dead-id")),
      }),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("succeeds when the provider fetch throws and priority is negative", async () => {
    await expect(service.map(1, "igdb", "dead-id", -1)).resolves.toBeDefined();
    expect(gameMetadataService.findOrCreateMinimalStub).toHaveBeenCalledWith(
      "igdb",
      "dead-id",
    );
    expect(gameMetadataService.setProviderPriority).toHaveBeenCalledWith(
      EXISTING_META.id,
      -1,
    );
    // save() is the destructive upsert flow — must NOT be called on the
    // fallback path or title/cover/description would be wiped.
    expect(gameMetadataService.save).not.toHaveBeenCalled();
  });

  it("still throws when the fetch fails on a NON-disable map (positive priority)", async () => {
    await expect(service.map(1, "igdb", "dead-id", 5)).rejects.toThrow();
    expect(gameMetadataService.findOrCreateMinimalStub).not.toHaveBeenCalled();
    expect(gameMetadataService.setProviderPriority).not.toHaveBeenCalled();
  });

  it("still throws when the fetch fails and no priority override is given", async () => {
    // No override -> not a disable intent, fetch failure is fatal.
    await expect(service.map(1, "igdb", "dead-id")).rejects.toThrow();
    expect(gameMetadataService.findOrCreateMinimalStub).not.toHaveBeenCalled();
    expect(gameMetadataService.setProviderPriority).not.toHaveBeenCalled();
  });

  it("on the disable-intent fallback, applies the negative priority column-only (not via save())", async () => {
    await service.map(1, "igdb", "dead-id", -1);
    // setProviderPriority is a targeted UPDATE — it does not touch
    // publishers/developers/tags/genres/title/cover/etc.
    expect(gameMetadataService.setProviderPriority).toHaveBeenCalledTimes(1);
    expect(gameMetadataService.setProviderPriority).toHaveBeenCalledWith(
      EXISTING_META.id,
      -1,
    );
  });

  it("takes the normal save() path when the fetch succeeds (no regression on the healthy id case)", async () => {
    // Replace the provider so its fetch succeeds this time.
    (service as any).providers = [];
    service.registerProvider(
      createMockProvider({
        slug: "igdb",
        priority: 10,
        getByProviderDataIdOrFail: vi.fn().mockResolvedValue({
          provider_slug: "igdb",
          provider_data_id: "healthy",
          title: "Fresh",
        }),
      }),
    );
    await service.map(1, "igdb", "healthy", -1);
    expect(gameMetadataService.save).toHaveBeenCalledTimes(1);
    // Priority override still applied on the fetched payload.
    expect(gameMetadataService.save).toHaveBeenCalledWith(
      expect.objectContaining({ provider_priority: -1 }),
    );
    // Fallback helpers stay untouched on the success path.
    expect(gameMetadataService.findOrCreateMinimalStub).not.toHaveBeenCalled();
    expect(gameMetadataService.setProviderPriority).not.toHaveBeenCalled();
  });
});

/**
 * Fork: upstream's merge is a plain spread, so for every field the
 * highest-priority provider with a non-empty value wins outright. For arrays
 * that silently discards data — a game matched to two providers holding 3 and
 * 2 screenshots displayed 2, not 5. The fork unions the array-valued fields
 * (4 url_* string arrays + tags/genres/developers/publishers) across every
 * mergeable provider, in DESCENDING priority order so the best provider leads.
 *
 * Relation entries dedupe on kebabCase(name) — the same key
 * finalizeMetadata()'s normalizeRelations stamps downstream — so "Action" from
 * two providers collapses to one row.
 *
 * Mutation-verified: deleting the two union loops from applyProviderMetadata
 * makes every test in this block fail.
 */
describe("Fork delta: array metadata converges across providers", () => {
  let service: MetadataService;

  const apply = (providerMetadata: any[]): any =>
    (service as any).applyProviderMetadata({}, providerMetadata);

  beforeEach(() => {
    service = new MetadataService(
      { findOneByGameIdOrFail: vi.fn(), save: vi.fn() } as any,
      { save: vi.fn(), deleteByGameMetadataIdOrFail: vi.fn() } as any,
      configuration as any,
    );
    service.registerProvider(createMockProvider({ slug: "low", priority: 5 }));
    service.registerProvider(
      createMockProvider({ slug: "high", priority: 10 }),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("unions url_screenshots instead of letting the top provider replace them", () => {
    const merged = apply([
      { provider_slug: "low", url_screenshots: ["a.jpg", "b.jpg", "c.jpg"] },
      { provider_slug: "high", url_screenshots: ["x.jpg", "y.jpg"] },
    ]);

    expect(merged.url_screenshots).toHaveLength(5);
    // Highest priority first.
    expect(merged.url_screenshots).toEqual([
      "x.jpg",
      "y.jpg",
      "a.jpg",
      "b.jpg",
      "c.jpg",
    ]);
  });

  it("dedupes identical urls contributed by more than one provider", () => {
    const merged = apply([
      { provider_slug: "low", url_screenshots: ["shared.jpg", "only-low.jpg"] },
      { provider_slug: "high", url_screenshots: ["shared.jpg"] },
    ]);

    expect(merged.url_screenshots).toEqual(["shared.jpg", "only-low.jpg"]);
  });

  /**
   * Providers disagree about trailing slashes on the same page — steam's
   * url_websites carries ".../app/3449040/" while its provider_data_url
   * carries ".../app/3449040". Dedupe on a normalised key so they collapse.
   */
  it("treats urls differing only by a trailing slash as one", () => {
    const merged = apply([
      {
        provider_slug: "low",
        url_websites: ["https://store.example/app/1/", "https://other.example"],
      },
      { provider_slug: "high", url_websites: ["https://store.example/app/1"] },
    ]);

    expect(merged.url_websites).toEqual([
      // high supplied it first, so its slash-less form is the one stored.
      "https://store.example/app/1",
      "https://other.example",
    ]);
  });

  it("unions every url_* field, not just screenshots", () => {
    const merged = apply([
      {
        provider_slug: "low",
        url_trailers: ["t1"],
        url_gameplays: ["g1"],
        url_websites: ["w1"],
      },
      {
        provider_slug: "high",
        url_trailers: ["t2"],
        url_gameplays: ["g2"],
        url_websites: ["w2"],
      },
    ]);

    expect(merged.url_trailers).toEqual(["t2", "t1"]);
    expect(merged.url_gameplays).toEqual(["g2", "g1"]);
    expect(merged.url_websites).toEqual(["w2", "w1"]);
  });

  it("unions tags/genres/developers/publishers, deduping on kebabCase(name)", () => {
    const merged = apply([
      {
        provider_slug: "low",
        tags: [{ name: "Action" }, { name: "Only Low" }],
        genres: [{ name: "RPG" }],
        developers: [{ name: "Studio A" }],
        publishers: [{ name: "Pub A" }],
      },
      {
        provider_slug: "high",
        // "ACTION!" kebabs to "action", same as low's "Action".
        tags: [{ name: "ACTION!" }, { name: "Only High" }],
        genres: [{ name: "Adventure" }],
        developers: [{ name: "Studio B" }],
        publishers: [{ name: "Pub B" }],
      },
    ]);

    expect(merged.tags.map((t: any) => t.name)).toEqual([
      "ACTION!",
      "Only High",
      "Only Low",
    ]);
    expect(merged.genres.map((g: any) => g.name)).toEqual(["Adventure", "RPG"]);
    expect(merged.developers.map((d: any) => d.name)).toEqual([
      "Studio B",
      "Studio A",
    ]);
    expect(merged.publishers.map((p: any) => p.name)).toEqual([
      "Pub B",
      "Pub A",
    ]);
  });

  it("copies relation entries so normalizeRelations cannot mutate provider rows", () => {
    const providerTag = { id: 7, provider_slug: "low", name: "Action" };
    const merged = apply([{ provider_slug: "low", tags: [providerTag] }]);

    expect(merged.tags[0]).not.toBe(providerTag);
    merged.tags[0].id = undefined;
    merged.tags[0].provider_slug = "gamevault";
    // The provider's own loaded entity is untouched.
    expect(providerTag.id).toBe(7);
    expect(providerTag.provider_slug).toBe("low");
  });

  it("leaves scalar fields on last-writer-wins", () => {
    const merged = apply([
      { provider_slug: "low", title: "Low Title", rating: 50 },
      { provider_slug: "high", title: "High Title" },
    ]);

    // Highest priority wins the title; rating survives because high left it empty.
    expect(merged.title).toBe("High Title");
    expect(merged.rating).toBe(50);
  });

  it("ignores providers that contribute an empty array", () => {
    const merged = apply([
      { provider_slug: "low", url_screenshots: ["a.jpg"] },
      { provider_slug: "high", url_screenshots: [] },
    ]);

    expect(merged.url_screenshots).toEqual(["a.jpg"]);
  });

  /**
   * A non-winning provider's cover/background is artwork that was already
   * downloaded and would otherwise be thrown away, so it is folded into the
   * screenshot union. The cover/background that DID win the scalar merge are
   * excluded — they are already displayed as cover/background.
   */
  it("folds losing providers' cover and background into url_screenshots", () => {
    const merged = apply([
      {
        provider_slug: "low",
        url_screenshots: ["low-shot.jpg"],
        cover: { source_url: "low-cover.jpg" },
        background: { source_url: "low-bg.jpg" },
      },
      {
        provider_slug: "high",
        url_screenshots: ["high-shot.jpg"],
        cover: { source_url: "high-cover.jpg" },
        background: { source_url: "high-bg.jpg" },
      },
    ]);

    // high won cover/background on the scalar merge, so they are NOT screenshots.
    expect(merged.cover.source_url).toBe("high-cover.jpg");
    expect(merged.background.source_url).toBe("high-bg.jpg");
    expect(merged.url_screenshots).not.toContain("high-cover.jpg");
    expect(merged.url_screenshots).not.toContain("high-bg.jpg");
    // Grouped by kind: all screenshots, then all backgrounds, then all covers.
    expect(merged.url_screenshots).toEqual([
      "high-shot.jpg",
      "low-shot.jpg",
      "low-bg.jpg",
      "low-cover.jpg",
    ]);
  });

  /**
   * Ordering contract across three providers. Output is grouped by KIND, not
   * by provider — every provider's screenshots first (descending priority),
   * then every background, then every cover. The winner's cover/background
   * are excluded throughout: they are already displayed as cover/background.
   */
  it("groups screenshots by kind: all shots, then all backgrounds, then all covers", () => {
    service.registerProvider(createMockProvider({ slug: "mid", priority: 7 }));

    const merged = apply([
      {
        provider_slug: "low",
        url_screenshots: ["low-1.jpg"],
        cover: { source_url: "low-cover.jpg" },
        background: { source_url: "low-bg.jpg" },
      },
      {
        provider_slug: "mid",
        url_screenshots: ["mid-1.jpg"],
        cover: { source_url: "mid-cover.jpg" },
        background: { source_url: "mid-bg.jpg" },
      },
      {
        provider_slug: "high",
        url_screenshots: ["high-1.jpg", "high-2.jpg"],
        cover: { source_url: "high-cover.jpg" },
        background: { source_url: "high-bg.jpg" },
      },
    ]);

    expect(merged.url_screenshots).toEqual([
      // pass 1 — every provider's screenshots, descending priority
      "high-1.jpg",
      "high-2.jpg",
      "mid-1.jpg",
      "low-1.jpg",
      // pass 2 — every provider's background (high's won, so excluded)
      "mid-bg.jpg",
      "low-bg.jpg",
      // pass 3 — every provider's cover (high's won, so excluded)
      "mid-cover.jpg",
      "low-cover.jpg",
    ]);
  });

  /**
   * Videos live in their own columns and never interleave with screenshots —
   * each array field is unioned independently, highest provider first.
   */
  it("unions trailers and gameplays independently of screenshots", () => {
    const merged = apply([
      {
        provider_slug: "low",
        url_trailers: ["low-trailer"],
        url_gameplays: ["low-gameplay"],
        url_screenshots: ["low-shot"],
      },
      {
        provider_slug: "high",
        url_trailers: ["high-trailer"],
        url_gameplays: ["high-gameplay"],
        url_screenshots: ["high-shot"],
      },
    ]);

    expect(merged.url_trailers).toEqual(["high-trailer", "low-trailer"]);
    expect(merged.url_gameplays).toEqual(["high-gameplay", "low-gameplay"]);
    expect(merged.url_screenshots).toEqual(["high-shot", "low-shot"]);
  });

  /**
   * provider_data_url is the one scalar where losing providers hold uniquely
   * useful data — steam's row cannot supply igdb's page link — so every
   * provider's own URL is folded into the websites union.
   */
  it("folds every provider's provider_data_url into url_websites", () => {
    const merged = apply([
      {
        provider_slug: "low",
        provider_data_url: "https://low.example/game",
        url_websites: ["https://low-site.example"],
      },
      {
        provider_slug: "high",
        provider_data_url: "https://high.example/game",
        url_websites: ["https://high-site.example"],
      },
    ]);

    // Grouped by kind, same as screenshots: every provider's url_websites
    // first, then every provider's own page link.
    expect(merged.url_websites).toEqual([
      "https://high-site.example",
      "https://low-site.example",
      "https://high.example/game",
      "https://low.example/game",
    ]);
  });
});

describe("Fork delta: relation loading is opt-in", () => {
  let service: GamesService;
  let gamesRepository: any;

  beforeEach(() => {
    gamesRepository = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(null),
      findOneOrFail: vi.fn().mockResolvedValue({ id: 1 }),
    };
    // Constructed through `any` so this file also compiles against pre-v17
    // trees, where GamesService took one fewer constructor argument (the
    // GameVersion repository). Only the first argument is exercised here; the
    // rest are inert stubs in either arity.
    service = new (GamesService as any)(
      gamesRepository,
      { find: vi.fn(), findOne: vi.fn() } as any,
      {} as any,
      {} as any,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * Upstream's find() leaves loadEagerRelations at its default (true), so every
   * call hydrates the full eager graph. The fork disables it unless relations
   * were explicitly requested. Regressing this reintroduced an OOM (19cda31).
   */
  it("disables eager relations in find() when none are requested", async () => {
    await service.find({ loadDeletedEntities: false, loadRelations: false });

    expect(gamesRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ loadEagerRelations: false }),
    );
  });

  /**
   * Upstream's findOneByGameIdOrFail always sets loadEagerRelations:true and
   * relations:defaultRelations. The fork makes both opt-in.
   */
  it("disables eager relations in findOneByGameIdOrFail when none are requested", async () => {
    await service.findOneByGameIdOrFail(1, { loadDeletedEntities: false });

    expect(gamesRepository.findOneOrFail).toHaveBeenCalledWith(
      expect.objectContaining({ loadEagerRelations: false }),
    );
  });

  /**
   * loadRelations:true must still give callers the full graph — several fork
   * call sites depend on it (games.controller, progress.service, users.service).
   */
  it("loads the full relation graph when loadRelations is true", async () => {
    await service.findOneByGameIdOrFail(1, {
      loadDeletedEntities: false,
      loadRelations: true,
    });

    const args = gamesRepository.findOneOrFail.mock.calls[0][0];
    expect(args.loadEagerRelations).toBe(true);
    expect(relationPaths(args.relations)).toEqual(
      expect.arrayContaining([
        "metadata",
        "provider_metadata",
        "user_metadata",
      ]),
    );
  });

  /**
   * An explicit relation list must be honored verbatim and must NOT re-enable
   * eager loading — that combination is what the OOM work relies on.
   */
  it("honors an explicit relation list without re-enabling eager loading", async () => {
    await service.findOneByGameIdOrFail(1, {
      loadDeletedEntities: false,
      loadRelations: ["provider_metadata"],
    });

    const args = gamesRepository.findOneOrFail.mock.calls[0][0];
    expect(args.loadEagerRelations).toBe(false);
    expect(relationPaths(args.relations)).toEqual(["provider_metadata"]);
  });
});

/**
 * `AuthenticationStrategy.validate()` runs on every JWT-authenticated
 * request. Upstream does two sequential DB user lookups per call, so a
 * Postgres blip (checkpoint stall, dropped pool connection) that lasts a
 * few hundred ms produces a burst of 401s and clients flip to offline mode.
 * The fork caches the resolved user for a short TTL so bursts share one
 * lookup and transient DB unavailability doesn't shred auth.
 *
 * Mutation-verified: reverting validate() to always hit UsersService makes
 * the coalesce-within-TTL test fail.
 */
describe("Fork delta: AuthenticationStrategy caches the user briefly", () => {
  let usersService: {
    findUserForAuthOrFail: Mock;
    findOneByUsernameOrFail: Mock;
  };
  let strategy: any;
  const payload = {
    sub: "1",
    preferred_username: "u",
    email: "u@example.com",
  };

  beforeEach(async () => {
    usersService = {
      findUserForAuthOrFail: vi.fn().mockResolvedValue({ username: "u" }),
      findOneByUsernameOrFail: vi
        .fn()
        .mockResolvedValue({ id: 1, username: "u" }),
    };
    const { AuthenticationStrategy } = (await vi.importActual(
      "./modules/auth/strategies/authentication.strategy.js",
    )) as {
      AuthenticationStrategy: new (svc: unknown, cfg: unknown) => unknown;
    };
    strategy = new AuthenticationStrategy(usersService as unknown, {
      AUTH: { ACCESS_TOKEN: { SECRET: "test-secret" } },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("coalesces repeated validate() calls with the same payload into one DB round-trip", async () => {
    await strategy.validate({ payload });
    await strategy.validate({ payload });
    await strategy.validate({ payload });

    expect(usersService.findUserForAuthOrFail).toHaveBeenCalledTimes(1);
    expect(usersService.findOneByUsernameOrFail).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the cache TTL expires", async () => {
    vi.useFakeTimers({ now: Date.now() });

    try {
      await strategy.validate({ payload });
      vi.setSystemTime(Date.now() + 61_000); // > 60s TTL
      await strategy.validate({ payload });

      expect(usersService.findUserForAuthOrFail).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not share cache slots across distinct payloads (impersonation-safe)", async () => {
    await strategy.validate({ payload });
    await strategy.validate({
      payload: { ...payload, email: "other@example.com" },
    });

    expect(usersService.findUserForAuthOrFail).toHaveBeenCalledTimes(2);
  });
});
