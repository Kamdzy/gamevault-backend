import { Role } from "../modules/users/models/role.enum";
import { DISABLE_API_IF_KEY, DisableApiIf } from "./disable-api-if.decorator";
import { MINIMUM_ROLE_KEY, MinimumRole } from "./minimum-role.decorator";
import { SKIP_GUARDS_KEY, SkipGuards } from "./skip-guards.decorator";

describe("DisableApiIf", () => {
  it("should export the metadata key", () => {
    expect(DISABLE_API_IF_KEY).toBe("disableApiIf");
  });

  it("should return a decorator function", () => {
    const decorator = DisableApiIf(true);
    expect(typeof decorator).toBe("function");
  });
});

describe("MinimumRole", () => {
  it("should export the metadata key", () => {
    expect(MINIMUM_ROLE_KEY).toBe("minimumRole");
  });

  it("should return a decorator function", () => {
    const decorator = MinimumRole(Role.ADMIN);
    expect(typeof decorator).toBe("function");
  });
});

describe("SkipGuards", () => {
  it("should export the metadata key", () => {
    expect(SKIP_GUARDS_KEY).toBe("skip-guards");
  });

  it("should return a decorator function with default guards", () => {
    const decorator = SkipGuards();
    expect(typeof decorator).toBe("function");
  });

  it("should accept custom guard names", () => {
    const decorator = SkipGuards(["CustomGuard"]);
    expect(typeof decorator).toBe("function");
  });
});
