import { MethodNotAllowedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { of } from "rxjs";
import { DisableApiIfInterceptor } from "./disable-api-if.interceptor";

describe("DisableApiIfInterceptor", () => {
  let interceptor: DisableApiIfInterceptor;
  let reflector: jest.Mocked<Reflector>;
  let mockExecutionContext: any;
  let mockCallHandler: any;

  beforeEach(() => {
    reflector = { get: jest.fn() } as any;
    interceptor = new DisableApiIfInterceptor(reflector);
    mockExecutionContext = {
      getHandler: jest.fn(),
    };
    mockCallHandler = {
      handle: jest.fn().mockReturnValue(of("result")),
    };
  });

  it("should throw MethodNotAllowedException when API is disabled", () => {
    reflector.get.mockReturnValue(true);
    expect(() =>
      interceptor.intercept(mockExecutionContext, mockCallHandler),
    ).toThrow(MethodNotAllowedException);
  });

  it("should call next.handle() when API is not disabled", (done) => {
    reflector.get.mockReturnValue(false);
    const result$ = interceptor.intercept(
      mockExecutionContext,
      mockCallHandler,
    );
    result$.subscribe({
      next: (value) => {
        expect(value).toBe("result");
        expect(mockCallHandler.handle).toHaveBeenCalled();
        done();
      },
    });
  });

  it("should call next.handle() when no metadata is set", (done) => {
    reflector.get.mockReturnValue(undefined);
    const result$ = interceptor.intercept(
      mockExecutionContext,
      mockCallHandler,
    );
    result$.subscribe({
      next: () => {
        expect(mockCallHandler.handle).toHaveBeenCalled();
        done();
      },
    });
  });

  it("should include correct error message when disabled", () => {
    reflector.get.mockReturnValue(true);
    try {
      interceptor.intercept(mockExecutionContext, mockCallHandler);
      fail("Expected MethodNotAllowedException");
    } catch (e) {
      expect(e).toBeInstanceOf(MethodNotAllowedException);
      expect((e as MethodNotAllowedException).message).toBe(
        "This API endpoint is disabled.",
      );
    }
  });
});
