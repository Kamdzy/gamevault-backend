import { Reflector } from "@nestjs/core";

import { AuthenticationGuard } from "./authentication.guard";

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

// Mock AuthGuard so we don't need Passport infrastructure
jest.mock("@nestjs/passport", () => ({
  AuthGuard: () => {
    class MockAuthGuard {
      canActivate = jest.fn().mockReturnValue(true);
    }
    return MockAuthGuard;
  },
}));

describe("AuthenticationGuard", () => {
  let guard: AuthenticationGuard;
  let reflector: jest.Mocked<Reflector>;

  function createContext(user?: any) {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as any;
  }

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    guard = new AuthenticationGuard(reflector);
  });

  it("should skip when guard name is in skip-guards metadata", () => {
    reflector.getAllAndOverride.mockReturnValue(["AuthenticationGuard"]);

    const result = guard.canActivate(createContext());
    expect(result).toBe(true);
  });

  it("should skip when user is already set on request", () => {
    reflector.getAllAndOverride.mockReturnValue(null);

    const result = guard.canActivate(
      createContext({ id: 1, username: "test" }),
    );
    expect(result).toBe(true);
  });

  it("should delegate to super.canActivate when no user and not skipped", () => {
    reflector.getAllAndOverride.mockReturnValue(null);

    const result = guard.canActivate(createContext(undefined));
    // super.canActivate is mocked to return true
    expect(result).toBe(true);
  });
});

describe("AuthenticationGuard (auth disabled)", () => {
  let guard: AuthenticationGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../../../configuration").default;
    config.TESTING.AUTHENTICATION_DISABLED = true;

    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(null),
    } as any;

    guard = new AuthenticationGuard(reflector);
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../../../configuration").default;
    config.TESTING.AUTHENTICATION_DISABLED = false;
  });

  it("should skip authentication when disabled", () => {
    const result = guard.canActivate({
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as any);
    expect(result).toBe(true);
  });
});
