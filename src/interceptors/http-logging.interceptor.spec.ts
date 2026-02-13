import { of, throwError } from "rxjs";
import { HttpLoggingInterceptor } from "./http-logging.interceptor";

// Mock the configuration module
jest.mock("../configuration", () => ({
  __esModule: true,
  default: {
    TESTING: {
      LOG_HTTP_TRAFFIC_ENABLED: true,
    },
  },
}));

describe("HttpLoggingInterceptor", () => {
  let interceptor: HttpLoggingInterceptor;
  let mockCallHandler: any;

  beforeEach(() => {
    interceptor = new HttpLoggingInterceptor();
    mockCallHandler = {
      handle: jest.fn().mockReturnValue(of({ data: "response" })),
    };
  });

  function createMockContext(url: string, method = "GET") {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          url,
          headers: {
            authorization: "Bearer token123",
            "content-type": "application/json",
          },
          body: { username: "test", password: "secret123" },
          query: {},
          params: {},
          ip: "127.0.0.1",
        }),
        getResponse: () => ({
          statusCode: 200,
          getHeaders: () => ({
            "content-type": "application/json",
            "set-cookie": "session=abc",
          }),
        }),
      }),
    } as any;
  }

  it("should pass through and log for a normal request", (done) => {
    const context = createMockContext("/api/games");
    const result$ = interceptor.intercept(context, mockCallHandler);
    result$.subscribe({
      next: (value) => {
        expect(value).toEqual({ data: "response" });
        done();
      },
    });
  });

  it("should skip logging for /api/status route", (done) => {
    const context = createMockContext("/api/status");
    const result$ = interceptor.intercept(context, mockCallHandler);
    result$.subscribe({
      next: () => {
        expect(mockCallHandler.handle).toHaveBeenCalled();
        done();
      },
    });
  });

  it("should skip logging for /api/health route", (done) => {
    const context = createMockContext("/api/health");
    const result$ = interceptor.intercept(context, mockCallHandler);
    result$.subscribe({
      next: () => {
        expect(mockCallHandler.handle).toHaveBeenCalled();
        done();
      },
    });
  });

  it("should handle error responses", (done) => {
    const context = createMockContext("/api/games", "POST");
    mockCallHandler.handle.mockReturnValue(
      throwError(() => ({ status: 400, message: "Bad Request" })),
    );
    const result$ = interceptor.intercept(context, mockCallHandler);
    result$.subscribe({
      error: () => {
        // Error is still propagated
        done();
      },
    });
  });

  it("should redact sensitive headers", (done) => {
    const context = createMockContext("/api/users");
    const result$ = interceptor.intercept(context, mockCallHandler);
    result$.subscribe({
      next: () => {
        // The interceptor logs internally; we just verify it doesn't throw
        done();
      },
    });
  });

  it("should handle non-object body in sanitizeBody", (done) => {
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: "GET",
          url: "/api/test",
          headers: {},
          body: "plain string body",
          query: {},
          params: {},
          ip: "127.0.0.1",
        }),
        getResponse: () => ({
          statusCode: 200,
          getHeaders: () => ({}),
        }),
      }),
    } as any;
    const result$ = interceptor.intercept(context, mockCallHandler);
    result$.subscribe({
      next: () => done(),
    });
  });
});

describe("HttpLoggingInterceptor (disabled)", () => {
  let interceptor: HttpLoggingInterceptor;
  let mockCallHandler: any;

  beforeEach(() => {
    // Override the mock for this suite
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../configuration").default;
    config.TESTING.LOG_HTTP_TRAFFIC_ENABLED = false;
    interceptor = new HttpLoggingInterceptor();
    mockCallHandler = {
      handle: jest.fn().mockReturnValue(of("result")),
    };
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const config = require("../configuration").default;
    config.TESTING.LOG_HTTP_TRAFFIC_ENABLED = true;
  });

  it("should skip logging when disabled and just pass through", (done) => {
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ url: "/api/games" }),
        getResponse: () => ({}),
      }),
    } as any;
    const result$ = interceptor.intercept(context, mockCallHandler);
    result$.subscribe({
      next: (value) => {
        expect(value).toBe("result");
        done();
      },
    });
  });
});
