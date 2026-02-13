import { IsOptionalIf } from "./is-optional-if.validator";

describe("IsOptionalIf", () => {
  it("should return a no-op function when condition is false", () => {
    const decorator = IsOptionalIf(false);
    expect(typeof decorator).toBe("function");
    // Should not throw when called
    expect(() => decorator({}, "prop")).not.toThrow();
  });

  it("should return an IsOptional decorator function when condition is true", () => {
    const decorator = IsOptionalIf(true);
    expect(typeof decorator).toBe("function");
  });
});
