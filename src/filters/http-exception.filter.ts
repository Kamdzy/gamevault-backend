import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { Request, Response } from "express";

@Catch()
export class LoggingExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(this.constructor.name);

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
}
