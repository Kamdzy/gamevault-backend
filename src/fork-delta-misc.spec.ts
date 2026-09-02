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

  function buildService() {
    const emptyRepo = { find: vi.fn().mockResolvedValue([]) } as any;
    return new MediaGarbageCollectionService(
      emptyRepo, // mediaRepository
      emptyRepo, // gameMetadataRepository
      emptyRepo, // userRepository
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
