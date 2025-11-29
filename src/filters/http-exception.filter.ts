import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { Request, Response } from "express";

@Catch()
export class LoggingExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(this.constructor.name);
  
  // Track recent auth errors to avoid logging spam during retry storms
  private recentAuthErrors = new Map<string, number>();
  private readonly AUTH_ERROR_LOG_THROTTLE_MS = 5000; // Only log same error once per 5 seconds
  private readonly MAX_TRACKED_ERRORS = 100; // Prevent memory leak
  
  /** Handles exceptions that occur during request processing. */
  catch(error: Error, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const httpStatusCode =
      error instanceof HttpException ? error.getStatus() : 500;
    
    if (error instanceof HttpException) {
      // If an exception has been marked to suppress logging, just return
      // the response without emitting a warn/error log. This is used for
      // expected client-side conditions (e.g. revoked refresh tokens)
      // that would otherwise spam logs.
      if ((error as any).suppressLogging) {
        response.status(httpStatusCode).json(error.getResponse());
        return;
      }
      
      // Special handling for auth errors during retry storms
      if (this.isAuthError(error)) {
        // Use throttled logging to prevent memory exhaustion
        this.logAuthErrorThrottled(request, error, httpStatusCode);
        response.status(httpStatusCode).json(error.getResponse());
        return;
      }
      
      // Special handling for throttler exceptions - these are working as intended
      if (error instanceof ThrottlerException) {
        // Only log throttler exceptions at debug level, not warn
        this.logger.debug({
          message: "Rate limit enforced",
          path: request.url,
          ip: request.ip,
        });
        response.status(httpStatusCode).json(error.getResponse());
        return;
      }
      
      // Normal logging for other HTTP exceptions
      if (httpStatusCode >= 400 && httpStatusCode < 500) {
        this.logger.warn({
          message: `${error.name} occurred.`,
          path: request.url,
          response: error.getResponse(),
          error,
        });
      } else {
        this.logger.error({
          message: `${error.name} occurred.`,
          path: request.url,
          response: error.getResponse(),
          error,
        });
      }
      response.status(httpStatusCode).json(error.getResponse());
    } else {
      // All other unhandled Exceptions
      this.logger.error({
        message: `Unhandled ${error.name} occurred.`,
        path: request.url,
        error,
      });
      response.status(httpStatusCode).json({
        message:
          "Unhandled Server Error. Please check the server logs for more details.",
        error: "Unhandled Server Error",
        statusCode: httpStatusCode,
      });
    }
  }
  
  /**
   * Determines if an error is an authentication-related error that could
   * cause logging spam during retry storms.
   */
  private isAuthError(error: HttpException): boolean {
    if (error instanceof UnauthorizedException || error instanceof BadRequestException) {
      const message = error.message?.toLowerCase() || '';
      const response = typeof error.getResponse() === 'object' 
        ? JSON.stringify(error.getResponse()).toLowerCase() 
        : '';
      
      return (
        message.includes('token') ||
        message.includes('auth') ||
        response.includes('token') ||
        response.includes('auth')
      );
    }
    return false;
  }
  
  /**
   * Logs auth errors with throttling to prevent memory exhaustion during
   * retry storms. Only logs the same error type once per AUTH_ERROR_LOG_THROTTLE_MS.
   */
  private logAuthErrorThrottled(
    request: Request,
    error: HttpException,
    statusCode: number,
  ): void {
    // Create a key based on IP, path, status, and error message to group similar errors
    const errorKey = `${request.ip}:${request.path}:${statusCode}:${error.message}`;
    const now = Date.now();
    const lastLog = this.recentAuthErrors.get(errorKey);
    
    // Only log if we haven't logged this exact error recently
    if (!lastLog || now - lastLog > this.AUTH_ERROR_LOG_THROTTLE_MS) {
      // Use minimal logging - no full error object with stack traces
      this.logger.warn({
        message: "Auth error (throttled logging)",
        error: error.message,
        path: request.path,
        ip: request.ip,
        statusCode,
        timestamp: new Date().toISOString(),
      });
      
      this.recentAuthErrors.set(errorKey, now);
      
      // Cleanup old entries to prevent memory leak
      if (this.recentAuthErrors.size > this.MAX_TRACKED_ERRORS) {
        // Remove oldest 50% of entries
        const entries = Array.from(this.recentAuthErrors.entries());
        entries.sort((a, b) => a[1] - b[1]); // Sort by timestamp
        entries.slice(0, Math.floor(this.MAX_TRACKED_ERRORS / 2)).forEach(([key]) => {
          this.recentAuthErrors.delete(key);
        });
      }
    }
    // If we've logged this recently, silently skip logging to save memory
  }
}