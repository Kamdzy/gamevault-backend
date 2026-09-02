/**
 * Fork contract tests — smaller standalone fork changes.
 *
 * Each of these is a one-or-two-line divergence from upstream that a merge can
 * quietly undo. See CLAUDE.md → "Preserving the Fork Across Upstream Merges".
 */

import { join } from "path";
import { Response } from "express";
import type { Mocked } from "vitest";
import globals from "./globals.js";
import { AuthenticationService } from "./modules/auth/authentication.service.js";
import { BasicAuthController } from "./modules/auth/controllers/basic-auth.controller.js";
import { OAuth2Controller } from "./modules/auth/controllers/oauth2.controller.js";
import { MediaGarbageCollectionService } from "./modules/garbage-collection/media-garbage-collection.service.js";



// These controllers pull in the guard/DTO/logging chain, which reads many
// config namespaces at import time. Start from the real configuration and
// override only what these tests care about.
vi.mock("./configuration.js", async () => {
  const actual = ((await vi.importActual("./configuration.js")) as any).default;
  return {
    __esModule: true,
    default: {
      ...actual,
      // MOCK_FILES must be false: removeUnusedMediaFromFileSystem
      // short-circuits when it is true, which would make the GC tests pass
      // vacuously.
      TESTING: { ...actual.TESTING, MOCK_FILES: false },
      VOLUMES: { ...actual.VOLUMES, MEDIA: "/media" },
      SERVER: { ...actual.SERVER, LOG_LEVEL: "off" },
    },
  };
});

// fs-extra is CommonJS. Since the ESM migration the source does
// `import fsExtra from "fs-extra"` and destructures off the default, so the
// mock must expose BOTH the named exports and a matching `default`.
// readFileSync is needed because configuration.ts is pulled in transitively.
vi.mock("fs-extra", () => {
  const mock = {
    readdir: vi.fn(),
    readFileSync: vi.fn(() => ""),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return { ...mock, default: mock };
});

describe("Fork delta: WEBP and AVIF are accepted media formats", () => {
  it("accepts image/webp", () => {
    expect(globals.SUPPORTED_MEDIA_FORMATS).toContain("image/webp");
  });

  it("accepts image/avif", () => {
    expect(globals.SUPPORTED_MEDIA_FORMATS).toContain("image/avif");
  });
});

describe("Fork delta: login IP falls back to x-forwarded-for", () => {
  let authenticationService: Mocked<Pick<AuthenticationService, "login">>;

  beforeEach(() => {
    authenticationService = {
      login: vi.fn().mockResolvedValue({ access_token: "t" }),
    };
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * Behind a reverse proxy Express leaves request.ip undefined unless
   * "trust proxy" resolves it, which logged every session from "undefined".
   * Upstream passes request.ip straight through.
   */
  it("uses x-forwarded-for on basic auth login when request.ip is undefined", async () => {
    const controller = new BasicAuthController(
      authenticationService as unknown as AuthenticationService,
    );

    await controller.getAuthBasicLogin({
      user: { username: "u" } as any,
      ip: undefined as unknown as string,
      headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "ua" },
    });

    expect(authenticationService.login).toHaveBeenCalledWith(
      expect.anything(),
      "203.0.113.7",
      "ua",
    );
  });

  it("prefers request.ip when it is present", async () => {
    const controller = new BasicAuthController(
      authenticationService as unknown as AuthenticationService,
    );

    await controller.getAuthBasicLogin({
      user: { username: "u" } as any,
      ip: "198.51.100.1",
      headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "ua" },
    });

    expect(authenticationService.login).toHaveBeenCalledWith(
      expect.anything(),
      "198.51.100.1",
      "ua",
    );
  });

  it("uses x-forwarded-for on oauth2 login when request.ip is undefined", async () => {
    const controller = new OAuth2Controller(
      authenticationService as unknown as AuthenticationService,
    );
    const res = {
      status: vi.fn().mockReturnThis(),
      contentType: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as unknown as Response;

    await controller.getAuthOauth2Login(
      {
        user: { username: "u" } as any,
        ip: undefined as unknown as string,
        headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "ua" },
      },
      res,
    );

    expect(authenticationService.login).toHaveBeenCalledWith(
      expect.anything(),
      "203.0.113.9",
      "ua",
    );
  });
});

describe("Fork delta: media GC filesystem sweep actually sweeps", () => {
  const UUID_NAME = "00013857-b5ca-4bb9-867b-74c4b371c190.webp";

  /**
   * collectUsedMediaPaths() projects file paths with a QueryBuilder instead of
   * hydrating entities (see the service for why), so the repository stubs need
   * a chainable builder rather than find(). Returning no rows means "nothing is
   * in use", which is what these tests want.
   */
  function repoStub(rawRows: Record<string, string | null>[] = []) {
    const qb: Record<string, unknown> = {};
    for (const m of ["withDeleted", "select", "leftJoin", "addSelect"]) {
      qb[m] = vi.fn(() => qb);
    }
    qb.getRawMany = vi.fn().mockResolvedValue(rawRows);
    return {
      find: vi.fn().mockResolvedValue([]),
      createQueryBuilder: vi.fn(() => qb),
      metadata: { name: "StubEntity" },
    } as any;
  }

  function buildService() {
    return new MediaGarbageCollectionService(
      repoStub(), // mediaRepository
      repoStub(), // gameMetadataRepository
      repoStub(), // userRepository
      { delete: vi.fn().mockResolvedValue(undefined) } as any,
    );
  }

  beforeEach(async () => {
    // vi.fn()s created inside a hoisted vi.mock factory are NOT reset by
    // restoreAllMocks, so call history would leak between these tests.
    const fsExtra = (await import("fs-extra")).default as any;
    fsExtra.readdir.mockReset();
    fsExtra.remove.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * Upstream filters with isUUID(name.substring(0, 35), 4). A canonical v4
   * UUID is 36 characters, so the substring is always truncated and invalid —
   * the filter matched NOTHING and this sweep silently deleted nothing since it
   * was introduced. Verified against the live media volume: 0/24097 files
   * passed the old filter, 24096/24097 pass with substring(0, 36).
   *
   * Mutation-verified: changing 36 back to 35 makes this fail.
   */
  it("matches real UUID-named media files (substring must be 36, not 35)", async () => {
    const fsExtra = (await import("fs-extra")).default as any;
    fsExtra.readdir.mockResolvedValue([
      {
        name: UUID_NAME,
        isFile: () => true,
        // Deliberately NOT the media root, so this also proves the fork joins
        // against configuration.VOLUMES.MEDIA rather than file.parentPath.
        parentPath: "/some/other/path",
      },
    ]);

    const service = buildService();
    await service.garbageCollectUnusedMedia();

    // join() so the assertion matches on Windows (\media\x) as well as
    // POSIX (/media/x) — the service builds the path with path.join too.
    expect(fsExtra.remove).toHaveBeenCalledWith(join("/media", UUID_NAME));
  });

  /**
   * The sweep matches every file on disk against the in-use path list. Upstream
   * uses Array.includes, making it O(n*m): at ~24k files that is ~580 million
   * string comparisons on the event loop, and it ran twice per cycle (once here,
   * once in removeUnusedMediaFromDB). On 2026-09-02 that blocked all HTTP
   * traffic for ~13 minutes on the first cycle after the isUUID fix made this
   * sweep functional — logins returned 200 only after the GC finished.
   *
   * A Set makes it O(n). This test is a scale guard, not a microbenchmark: the
   * budget is deliberately loose so it cannot flake, but 20k x 20k via
   * Array.includes is ~400M comparisons and blows past it by a wide margin.
   *
   * Mutation-verified: reverting either lookup to Array.includes fails this.
   */
  it("matches paths in linear time, not quadratic (Set, not Array.includes)", async () => {
    const N = 20000;
    const fsExtra = (await import("fs-extra")).default as any;
    // Every file is in use, so nothing is deleted and the full N*N comparison
    // space is exercised rather than short-circuiting on an early match.
    const names = Array.from(
      { length: N },
      (_, i) =>
        `${i.toString(16).padStart(8, "0")}-b5ca-4bb9-867b-74c4b371c190.webp`,
    );
    fsExtra.readdir.mockResolvedValue(
      names.map((name) => ({ name, isFile: () => true, parentPath: "/media" })),
    );

    const used = names.map((n) => join("/media", n));
    const service = new MediaGarbageCollectionService(
      repoStub(),
      repoStub(),
      repoStub(),
      { delete: vi.fn().mockResolvedValue(undefined) } as any,
    );
    vi.spyOn(service as any, "collectUsedMediaPaths").mockResolvedValue(used);

    const started = Date.now();
    await service.garbageCollectUnusedMedia();
    const elapsed = Date.now() - started;

    expect(fsExtra.remove).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(5000);
  });

  /**
   * collectUsedMediaPaths() must PROJECT file paths, never hydrate entities.
   *
   * Upstream calls repository.find({ relations, relationLoadStrategy:"query" })
   * and walks the entity graph. It only ever reads media.file_path, but that
   * materialises every column of every row into a class instance and resolves
   * each relation with an in-memory join.
   *
   * Measured live: `SELECT * FROM game_metadata` (18,943 rows / 54 MB) takes
   * 275ms, while the find() call took ~488 SECONDS -- all TypeORM hydration on
   * the main event loop. That stalled every HTTP request for ~8-11 minutes,
   * hourly, on the hour. The projection returns the same paths in ~76ms.
   *
   * Mutation-verified: restoring repository.find() fails this test.
   */
  it("projects media paths via QueryBuilder instead of hydrating entities", async () => {
    const fsExtra = (await import("fs-extra")).default as any;
    fsExtra.readdir.mockResolvedValue([]);

    const userRepo = repoStub([{ background_file_path: "/media/a.png", avatar_file_path: null }]);
    const metaRepo = repoStub([{ background_file_path: null, cover_file_path: "/media/b.png" }]);
    const service = new MediaGarbageCollectionService(
      repoStub(),
      metaRepo,
      userRepo,
      { delete: vi.fn().mockResolvedValue(undefined) } as any,
    );

    await service.garbageCollectUnusedMedia();

    // The projection path must be used...
    expect(userRepo.createQueryBuilder).toHaveBeenCalled();
    expect(metaRepo.createQueryBuilder).toHaveBeenCalled();
    // ...and entity hydration must NOT be.
    expect(userRepo.find).not.toHaveBeenCalled();
    expect(metaRepo.find).not.toHaveBeenCalled();
  });

  /** Non-UUID files (e.g. FUSE tombstones) must still be ignored. */
  it("ignores files whose name is not a UUID", async () => {
    const fsExtra = (await import("fs-extra")).default as any;
    fsExtra.readdir.mockResolvedValue([
      {
        name: ".fuse_hidden00ed8a160000bc93",
        isFile: () => true,
        parentPath: "/media",
      },
    ]);

    const service = buildService();
    await service.garbageCollectUnusedMedia();

    expect(fsExtra.remove).not.toHaveBeenCalled();
  });
});
