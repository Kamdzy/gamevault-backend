import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import type { AppConfiguration } from "../../../configuration.js";
import { InjectGamevaultConfig } from "../../../decorators/inject-gamevault-config.decorator.js";
import type { GamevaultUser } from "../../users/gamevault-user.entity.js";
import { UsersService } from "../../users/users.service.js";
import { AuthenticationService } from "../authentication.service.js";
import { type GamevaultJwtPayload } from "../models/gamevault-jwt-payload.interface.js";

/**
 * Fork: short-TTL user cache for JWT auth.
 *
 * JWT verification is stateless, but validate() performs TWO sequential DB
 * user lookups on every authenticated request (findUserForAuthOrFail then
 * findOneByUsernameOrFail). Under a Postgres blip (checkpoint stall, dropped
 * pool connection, host disk pressure) both queries fail, Passport returns
 * 401, and clients interpret the burst as "server down" and flip to offline
 * mode. Access tokens live for 5 minutes and the user record almost never
 * changes within that window, so caching the resolved user for a small TTL
 * absorbs transient DB unavailability and removes a wasteful hot-path double
 * query at the same time.
 *
 * TTL is deliberately shorter than the access-token lifetime so role/email
 * changes propagate quickly, and much shorter than a session, so a deleted
 * user cannot keep authenticating for meaningful time (they already retain
 * their token until exp anyway).
 */
const USER_CACHE_TTL_MS = 60_000;
const USER_CACHE_MAX_ENTRIES = 256;

interface CachedUser {
  user: GamevaultUser;
  expiresAt: number;
}

@Injectable()
export class AuthenticationStrategy extends PassportStrategy(Strategy, "auth") {
  private readonly logger = new Logger(this.constructor.name);
  private readonly userCache = new Map<string, CachedUser>();

  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthenticationService,
    @InjectGamevaultConfig() private readonly config: AppConfiguration,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.AUTH.ACCESS_TOKEN.SECRET,
      algorithms: ["HS256"],
      ignoreExpiration: false,
    });
  }

  async validate(dto: {
    payload: GamevaultJwtPayload;
  }): Promise<GamevaultUser> {
    // Fork: this check runs before the user cache below, so a revoked
    // session is rejected immediately instead of riding a cached user.
    // Optional session binding: tokens issued for a session stop working as
    // soon as that session is revoked. Tokens without a `sid` (issued before
    // the feature was enabled) stay valid until they expire.
    if (
      this.config.AUTH.ACCESS_TOKEN.SESSION_BINDING_ENABLED &&
      dto.payload?.sid
    ) {
      const sessionId = Number(dto.payload.sid);
      if (
        !Number.isFinite(sessionId) ||
        !(await this.authService.isSessionActive(sessionId))
      ) {
        throw new UnauthorizedException(
          "Authentication Failed: Session has been revoked",
        );
      }
    }

    const cacheKey = this.buildCacheKey(dto.payload);
    const now = Date.now();

    const cached = this.userCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.user;
    }
    if (cached) {
      // Expired — drop so the fresh entry inserts at the tail below.
      this.userCache.delete(cacheKey);
    }

    const user = await this.usersService.findOneByUsernameOrFail(
      (
        await this.usersService.findUserForAuthOrFail({
          id: Number(dto.payload?.sub),
          username: dto.payload?.preferred_username,
          email: dto.payload?.email,
        })
      ).username,
    );

    this.userCache.set(cacheKey, {
      user,
      expiresAt: now + USER_CACHE_TTL_MS,
    });
    this.evictIfOversized();

    return user;
  }

  /**
   * All fields validate() dispatches on. If a token whose payload shape
   * drifts (impersonation, changed email/username) arrives, it hits a
   * different cache slot and takes the fresh DB path.
   */
  private buildCacheKey(payload: GamevaultJwtPayload | undefined): string {
    return [
      payload?.sub ?? "",
      payload?.preferred_username ?? "",
      payload?.email ?? "",
    ].join("|");
  }

  /**
   * Map iterates in insertion order — dropping from the front approximates
   * FIFO eviction. Good enough given real cardinality is a handful of users
   * with a 60s TTL; the cap is a bounded-memory safety net, not a hot path.
   */
  private evictIfOversized(): void {
    if (this.userCache.size <= USER_CACHE_MAX_ENTRIES) return;
    const excess = this.userCache.size - USER_CACHE_MAX_ENTRIES;
    let dropped = 0;
    for (const key of this.userCache.keys()) {
      if (dropped >= excess) break;
      this.userCache.delete(key);
      dropped++;
    }
  }
}
