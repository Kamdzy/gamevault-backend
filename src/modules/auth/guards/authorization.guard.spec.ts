import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { Role } from "../../users/models/role.enum";
import { AuthorizationGuard } from "./authorization.guard";

// Mock configuration
jest.mock("../../../configuration", () => ({
  __esModule: true,
  default: {
    TESTING: { AUTHENTICATION_DISABLED: false },
  },
}));

jest.mock("../../../logging", () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  logGamevaultGame: jest.fn(),
  logGamevaultUser: jest.fn(),
  logMedia: jest.fn(),
  logMetadata: jest.fn(),
  logMetadataProvider: jest.fn(),
  logProgress: jest.fn(),
}));

describe("AuthorizationGuard", () => {
  let guard: AuthorizationGuard;
  let reflector: jest.Mocked<Reflector>;
  let mockUsersService: any;

  function createMockContext(user?: any, overrides?: any) {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user, ...overrides }),
      }),
    } as any;
  }

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
      get: jest.fn(),
    } as any;

    mockUsersService = {
      find: jest.fn(),
    };

    guard = new AuthorizationGuard(reflector, mockUsersService);
  });

  it("should allow access when skip-guards includes AuthorizationGuard", async () => {
    reflector.getAllAndOverride.mockReturnValue(["AuthorizationGuard"]);

    const result = await guard.canActivate(createMockContext());
    expect(result).toBe(true);
  });

  it("should allow access when no minimum role is required", async () => {
    reflector.getAllAndOverride.mockReturnValue(null);
    reflector.get.mockReturnValue(undefined);

    const result = await guard.canActivate(
      createMockContext({ role: Role.USER }),
    );
    expect(result).toBe(true);
  });

  it("should allow access when user role meets minimum", async () => {
    reflector.getAllAndOverride.mockReturnValue(null);
    reflector.get.mockReturnValue(Role.USER);

    const result = await guard.canActivate(
      createMockContext({ role: Role.ADMIN }),
    );
    expect(result).toBe(true);
  });

  it("should throw ForbiddenException when user role is too low", async () => {
    reflector.getAllAndOverride.mockReturnValue(null);
    reflector.get.mockReturnValue(Role.ADMIN);

    await expect(
      guard.canActivate(createMockContext({ role: Role.USER })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("should allow equal role", async () => {
    reflector.getAllAndOverride.mockReturnValue(null);
    reflector.get.mockReturnValue(Role.EDITOR);

    const result = await guard.canActivate(
      createMockContext({ role: Role.EDITOR }),
    );
    expect(result).toBe(true);
  });

  it("should throw GUEST trying to access USER-only endpoint", async () => {
    reflector.getAllAndOverride.mockReturnValue(null);
    reflector.get.mockReturnValue(Role.USER);

    await expect(
      guard.canActivate(createMockContext({ role: Role.GUEST })),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe("AuthorizationGuard (auth disabled)", () => {
  let guard: AuthorizationGuard;
  let reflector: jest.Mocked<Reflector>;
  let mockUsersService: any;

  beforeEach(() => {
    // Dynamically set AUTHENTICATION_DISABLED
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../../../configuration").default;
    config.TESTING.AUTHENTICATION_DISABLED = true;

    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(null),
      get: jest.fn().mockReturnValue(Role.ADMIN),
    } as any;

    mockUsersService = {
      find: jest
        .fn()
        .mockResolvedValue([{ username: "admin", role: Role.ADMIN }]),
    };

    guard = new AuthorizationGuard(reflector, mockUsersService);
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../../../configuration").default;
    config.TESTING.AUTHENTICATION_DISABLED = false;
  });

  it("should bypass authorization and use first user", async () => {
    const req = {} as any;
    const ctx = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    } as any;

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.user).toEqual({ username: "admin", role: Role.ADMIN });
  });
});
