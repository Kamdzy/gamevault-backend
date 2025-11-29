import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class CustomThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): string {
    // Priority: user ID (if set) > API key > Bearer token user ID > Basic auth username > IP address
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader) {
      if (authHeader.startsWith('Bearer ')) {
        // Decode JWT payload to get user ID
        const token = authHeader.slice(7);
        try {
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
          return `user:${payload.sub || payload.userId || payload.id}` || `bearer:${token.slice(-10)}`;
        } catch {
          return `bearer:${token.slice(-10)}`;
        }
      } else if (authHeader.startsWith('Basic ')) {
        // Decode Basic auth to get username
        const credentials = Buffer.from(authHeader.slice(6), 'base64').toString().split(':');
        return `basic:${credentials[0]}` || `basic:${authHeader.slice(-10)}`;
      }
    }
    return req.headers['x-api-key'] || `ip:${req.ip}`;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Just call parent throttler - no additional tracking needed
    // The exception filter will handle memory-safe logging
    return await super.canActivate(context);
  }
}