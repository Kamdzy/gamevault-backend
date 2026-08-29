/**
 * Fork contract tests — smaller standalone fork changes.
 *
 * Each of these is a one-or-two-line divergence from upstream that a merge can
 * quietly undo. See CLAUDE.md → "Preserving the Fork Across Upstream Merges".
 */

import { Response } from "express";
import globals from "./globals";
import { AuthenticationService } from "./modules/auth/authentication.service";
import { BasicAuthController } from "./modules/auth/controllers/basic-auth.controller";
import { OAuth2Controller } from "./modules/auth/controllers/oauth2.controller";

/*
 * NOT COVERED HERE — the fork's media-GC path fix
 * (media-garbage-collection.service.ts: join(VOLUMES.MEDIA, name) instead of
 * join(file.parentPath, name)).
 *
 * removeUnusedMediaFromFileSystem() filters candidates with
 * `isUUID(file.name.substring(0, 35), 4)`, but media files are written as
 * `${randomUUID()}.${ext}` and a canonical UUID is 36 chars — so the substring
 * is always a truncated, invalid UUID and the filter matches nothing. The code
 * path is unreachable in both upstream and this fork, so any test of it would
 * be asserting on mocks rather than behavior. If the off-by-one is ever fixed
 * (35 -> 36), add the test then.
 */

// These controllers pull in the guard/DTO/logging chain, which reads many
// config namespaces at import time. Start from the real configuration and
// override only what these tests care about.
jest.mock("./configuration", () => {
  const actual = jest.requireActual("./configuration").default;
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

jest.mock("fs-extra", () => ({
  readdir: jest.fn(),
  remove: jest.fn().mockResolvedValue(undefined),
}));

describe("Fork delta: WEBP and AVIF are accepted media formats", () => {
  it("accepts image/webp", () => {
    expect(globals.SUPPORTED_MEDIA_FORMATS).toContain("image/webp");
  });

  it("accepts image/avif", () => {
    expect(globals.SUPPORTED_MEDIA_FORMATS).toContain("image/avif");
  });
});

describe("Fork delta: login IP falls back to x-forwarded-for", () => {
  let authenticationService: jest.Mocked<Pick<AuthenticationService, "login">>;

  beforeEach(() => {
    authenticationService = {
      login: jest.fn().mockResolvedValue({ access_token: "t" }),
    };
  });

  afterEach(() => jest.restoreAllMocks());

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
      status: jest.fn().mockReturnThis(),
      contentType: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
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
