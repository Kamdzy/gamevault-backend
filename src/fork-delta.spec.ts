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

import { GamesService } from "./modules/games/games.service";
import { MetadataService } from "./modules/metadata/metadata.service";
import { MetadataProvider } from "./modules/metadata/providers/abstract.metadata-provider.service";

jest.mock("./configuration", () => ({
  __esModule: true,
  default: {
    METADATA: { TTL_IN_DAYS: 30 },
    GAMES: { WINDOWS_SETUP_DEFAULT_INSTALL_PARAMETERS: "" },
    TESTING: { MOCK_FILES: true },
    VOLUMES: { MEDIA: "/media" },
  },
}));

jest.mock("./logging", () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  logGamevaultGame: jest.fn((g) => ({ id: g?.id })),
  logGamevaultUser: jest.fn(),
  logMedia: jest.fn(),
  logMetadata: jest.fn(),
  logMetadataProvider: jest.fn((p) => ({ slug: p?.slug })),
  logProgress: jest.fn(),
}));

jest.mock("class-validator", () => ({
  ...jest.requireActual("class-validator"),
  validateOrReject: jest.fn().mockResolvedValue(undefined),
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
    search: jest.fn(),
    getByProviderDataIdOrFail: jest.fn(),
    getBestMatch: jest.fn(),
    register: jest.fn(),
    ...overrides,
  } as unknown as MetadataProvider;
}

describe("Fork delta: metadata queue holds IDs, not entities", () => {
  let service: MetadataService;
  let gamesService: any;
  let gameMetadataService: any;

  beforeEach(() => {
    gamesService = {
      findOneByGameIdOrFail: jest.fn(),
      save: jest.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: jest.fn().mockReturnValue("sort-title"),
    };
    gameMetadataService = {
      save: jest
        .fn()
        .mockImplementation((m) => Promise.resolve({ ...m, id: 1 })),
      deleteByGameMetadataIdOrFail: jest.fn().mockResolvedValue(undefined),
    };
    service = new MetadataService(
      gamesService,
      gameMetadataService,
      jest.requireMock("./configuration").default,
    );
  });

  afterEach(() => jest.restoreAllMocks());

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
      loadRelations: ["provider_metadata"],
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
      findOneByGameIdOrFail: jest.fn(),
      save: jest.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: jest.fn().mockReturnValue("sort-title"),
    };
    service = new MetadataService(
      gamesService,
      { save: jest.fn(), deleteByGameMetadataIdOrFail: jest.fn() } as any,
      jest.requireMock("./configuration").default,
    );
  });

  afterEach(() => jest.restoreAllMocks());

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
    const mergeSpy = jest.spyOn(service, "merge").mockResolvedValue({} as any);

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
    const mergeSpy = jest.spyOn(service, "merge").mockResolvedValue({} as any);
    jest.spyOn(service as any, "map").mockResolvedValue(undefined);

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
      findOneByGameIdOrFail: jest.fn(),
      save: jest.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: jest.fn().mockReturnValue("sort-title"),
    };
    service = new MetadataService(
      gamesService,
      { save: jest.fn(), deleteByGameMetadataIdOrFail: jest.fn() } as any,
      jest.requireMock("./configuration").default,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * Fork-only concept: a provider whose effective priority is negative is
   * treated as disabled for that game and is never fetched.
   */
  it("never fetches metadata from a globally negative-priority provider", async () => {
    service.registerProvider(
      createMockProvider({ slug: "vndb", priority: -1 }),
    );
    const findMetadataSpy = jest
      .spyOn(service as any, "findMetadata")
      .mockResolvedValue(undefined);
    const mergeSpy = jest.spyOn(service, "merge").mockResolvedValue({} as any);

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
    const mapSpy = jest
      .spyOn(service as any, "map")
      .mockResolvedValue(undefined);
    const mergeSpy = jest.spyOn(service, "merge").mockResolvedValue({} as any);

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
      findOneByGameIdOrFail: jest.fn().mockResolvedValue({
        id: 1,
        provider_metadata: [],
        user_metadata: null,
        metadata: null,
      }),
      save: jest.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: jest.fn().mockReturnValue("sort-title"),
    };
    service = new MetadataService(
      gamesService,
      {
        save: jest.fn().mockImplementation((m) => Promise.resolve(m)),
        deleteByGameMetadataIdOrFail: jest.fn().mockResolvedValue(undefined),
      } as any,
      jest.requireMock("./configuration").default,
    );
  });

  afterEach(() => jest.restoreAllMocks());

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
        getByProviderDataIdOrFail: jest
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
      findOneByGameIdOrFail: jest.fn().mockResolvedValue({
        id: 1,
        provider_metadata: [],
        user_metadata: null,
        metadata: null,
      }),
      save: jest.fn().mockImplementation((g) => Promise.resolve(g)),
      generateSortTitle: jest.fn().mockReturnValue("sort-title"),
    };
    service = new MetadataService(
      gamesService,
      {
        save: jest.fn().mockImplementation((m) => Promise.resolve(m)),
        deleteByGameMetadataIdOrFail: jest.fn().mockResolvedValue(undefined),
      } as any,
      jest.requireMock("./configuration").default,
    );
  });

  afterEach(() => jest.restoreAllMocks());

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
        getByProviderDataIdOrFail: jest
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

describe("Fork delta: relation loading is opt-in", () => {
  let service: GamesService;
  let gamesRepository: any;

  beforeEach(() => {
    gamesRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      findOneOrFail: jest.fn().mockResolvedValue({ id: 1 }),
    };
    // Constructed through `any` so this file also compiles against pre-v17
    // trees, where GamesService took one fewer constructor argument (the
    // GameVersion repository). Only the first argument is exercised here; the
    // rest are inert stubs in either arity.
    service = new (GamesService as any)(
      gamesRepository,
      { find: jest.fn(), findOne: jest.fn() } as any,
      {} as any,
      {} as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

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
    findUserForAuthOrFail: jest.Mock;
    findOneByUsernameOrFail: jest.Mock;
  };
  let strategy: any;
  const payload = {
    sub: "1",
    preferred_username: "u",
    email: "u@example.com",
  };

  beforeEach(() => {
    usersService = {
      findUserForAuthOrFail: jest.fn().mockResolvedValue({ username: "u" }),
      findOneByUsernameOrFail: jest
        .fn()
        .mockResolvedValue({ id: 1, username: "u" }),
    };
    const { AuthenticationStrategy } = jest.requireActual<{
      AuthenticationStrategy: new (svc: unknown, cfg: unknown) => unknown;
    }>("./modules/auth/strategies/authentication.strategy");
    strategy = new AuthenticationStrategy(usersService as unknown, {
      AUTH: { ACCESS_TOKEN: { SECRET: "test-secret" } },
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it("coalesces repeated validate() calls with the same payload into one DB round-trip", async () => {
    await strategy.validate({ payload });
    await strategy.validate({ payload });
    await strategy.validate({ payload });

    expect(usersService.findUserForAuthOrFail).toHaveBeenCalledTimes(1);
    expect(usersService.findOneByUsernameOrFail).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the cache TTL expires", async () => {
    jest.useFakeTimers({ now: Date.now() });

    try {
      await strategy.validate({ payload });
      jest.setSystemTime(Date.now() + 61_000); // > 60s TTL
      await strategy.validate({ payload });

      expect(usersService.findUserForAuthOrFail).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
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
