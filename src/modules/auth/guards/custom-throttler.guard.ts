import { ExecutionContext, Inject, Injectable, Logger } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import Redis from "ioredis";
import { REDIS_CLIENT } from "../../cache/redis.module";

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  @Inject(REDIS_CLIENT) private readonly redisClient?: Redis;
  private readonly logger = new Logger(this.constructor.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = context.switchToHttp().getRequest() as any;
    const clientKey = this.getTracker(req);
    const count = await this.getAuthFailureCount(clientKey);
    if (count < 3) {
      return true;
    }
    // else apply throttling
    this.logger.warn(
      `Throttling client ${clientKey} due to ${count} consecutive auth failures`,
    );
    return super.canActivate(context);
  }

  private async getAuthFailureCount(clientKey: string): Promise<number> {
    if (this.redisClient) {
      const count = await this.redisClient.get(`auth_failures:${clientKey}`);
      return count ? parseInt(count) : 0;
    }
    return 0;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected getTracker(req: Record<string, any>): string {
    // Priority: user ID (if set) > API key > Bearer token user ID > Basic auth username > IP address
    if (req.user?.id) {
      return req.user.id;
    }

    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader) {
      if (authHeader.startsWith("Bearer ")) {
        // Decode JWT payload to get user ID
        const token = authHeader.slice(7);
        try {
          const payload = JSON.parse(
            Buffer.from(token.split(".")[1], "base64").toString(),
          );
          return (
            payload.sub ||
            payload.userId ||
            payload.id ||
            `bearer:${token.slice(-10)}`
          );
        } catch {
          return `bearer:${token.slice(-10)}`;
        }
      } else if (authHeader.startsWith("Basic ")) {
        // Decode Basic auth to get username
        const credentials = Buffer.from(authHeader.slice(6), "base64")
          .toString()
          .split(":");
        return credentials[0] || `basic:${authHeader.slice(-10)}`;
      }
    }

    return req.headers["x-api-key"] || req.ip;
  }
}
