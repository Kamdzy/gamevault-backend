import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash } from "crypto";
import Redis from "ioredis";
import ms, { StringValue } from "ms";
import { LessThan, MoreThan, Repository } from "typeorm";
import configuration from "../../configuration";
import { InMemoryTtlCache } from "../cache/in-memory-cache";
import { REDIS_CLIENT } from "../cache/redis.module";
import { GamevaultUser } from "../users/gamevault-user.entity";
import { RegisterUserDto } from "../users/models/register-user.dto";
import { UsersService } from "../users/users.service";
import { GamevaultJwtPayload } from "./models/gamevault-jwt-payload.interface";
import { RefreshTokenDto } from "./models/refresh-token.dto";
import { TokenPairDto } from "./models/token-pair.dto";
import { Session } from "./session.entity";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PQueue = require("p-queue").default;

@Injectable()
export class AuthenticationService implements OnModuleInit, OnModuleDestroy {
  private readonly authQueue = new PQueue({ concurrency: 2, timeout: 10000 });
  private readonly logger = new Logger(this.constructor.name);
  private readonly fallbackCache = new InMemoryTtlCache();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    @InjectRepository(Session)
    private readonly sessionRepository: Repository<Session>,
    @Inject(REDIS_CLIENT)
    private readonly redisClient?: Redis,
  ) {}

  async onModuleInit() {
    // Run initial cleanup
    await this.cleanupOldSessions();
    // Schedule regular cleanup every 5 minutes
    this.cleanupInterval = setInterval(
      async () => {
        await this.cleanupOldSessions();
      },
      5 * 60 * 1000,
    ); // 5 minutes
    // Log cache stats every 5 minutes
    setInterval(
      () => {
        const stats = this.fallbackCache.getStats();
        this.logger.warn({
          message: "Cache statistics",
          ...stats,
        });
      },
      5 * 60 * 1000,
    );
  }

  async onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    // Clean up the cache when service is destroyed
    this.fallbackCache.destroy();
    this.fallbackCache.clear();
    this.logger.log("Cleaning up authentication service resources");
  }

  private async cleanupOldSessions() {
    try {
      const expiryTime = ms(
        configuration.AUTH.REFRESH_TOKEN.EXPIRES_IN as StringValue,
      );
      // More aggressive: delete sessions older than 1x expiry (not 3x)
      const cutoffDate = new Date(Date.now() - expiryTime);
      // Delete in batches to avoid memory spikes
      const batchSize = 100;
      let deletedTotal = 0;
      while (true) {
        const sessionsToDelete = await this.sessionRepository.find({
          where: {
            expires_at: LessThan(cutoffDate),
          },
          take: batchSize,
        });
        if (sessionsToDelete.length === 0) {
          break;
        }
        await this.sessionRepository.remove(sessionsToDelete);
        deletedTotal += sessionsToDelete.length;
        // Give DB a breather between batches
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // Also cleanup revoked sessions older than 24 hours
      const revokedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const revokedDeleted = await this.sessionRepository.delete({
        revoked: true,
        updated_at: LessThan(revokedCutoff),
      });
      this.logger.debug({
        message: "Cleaned up expired sessions",
        expiredDeleted: deletedTotal,
        revokedDeleted: revokedDeleted.affected || 0,
        cutoffDate,
      });
      // Force GC after cleanup
      if (global.gc) {
        setImmediate(() => global.gc());
      }
    } catch (error) {
      this.logger.error({
        message: "Failed to cleanup sessions",
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  async login(
    requestUser: GamevaultUser,
    ipAddress: string,
    userAgent: string,
  ): Promise<TokenPairDto> {
    return this.authQueue.add(async () => {
      try {
        const user = await this.usersService.findOneByUsernameOrFail(
          requestUser.username,
        );

        // Limit sessions per user to prevent unbounded growth
        const MAX_SESSIONS_PER_USER = 10;
        const userSessions = await this.sessionRepository.count({
          where: {
            user: { id: user.id },
            revoked: false,
          },
        });
        if (userSessions >= MAX_SESSIONS_PER_USER) {
          const oldestSessions = await this.sessionRepository.find({
            where: {
              user: { id: user.id },
              revoked: false,
            },
            order: {
              created_at: "ASC",
            },
            take: userSessions - MAX_SESSIONS_PER_USER + 1,
          });
          await this.sessionRepository.update(
            oldestSessions.map((s) => s.id),
            { revoked: true },
          );
          this.logger.debug({
            message: "Revoked old sessions for user",
            user_id: user.id,
            revoked_count: oldestSessions.length,
          });
        }

        const payload: GamevaultJwtPayload = {
          sub: user.id.toString(),
          name:
            [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
          given_name: user.first_name,
          family_name: user.last_name,
          preferred_username: user.username,
          email: user.email,
          role: user.role.toString(),
          birthdate: user.birth_date?.toISOString(),
        };

        const refreshToken = this.jwtService.sign(
          { payload },
          {
            secret: configuration.AUTH.REFRESH_TOKEN.SECRET,
            expiresIn: configuration.AUTH.REFRESH_TOKEN
              .EXPIRES_IN as StringValue,
          },
        );

        // Create a new session
        const session = new Session();
        session.user = user;
        session.refresh_token_hash = createHash("sha256")
          .update(refreshToken)
          .digest("hex");
        session.expires_at = new Date(
          Date.now() +
            ms(configuration.AUTH.REFRESH_TOKEN.EXPIRES_IN as StringValue),
        );
        session.ip_address = ipAddress;
        session.user_agent = userAgent;
        await this.sessionRepository.save(session);

        const loginDto: TokenPairDto = {
          access_token: this.jwtService.sign({ payload }),
          refresh_token: refreshToken,
        };

        this.logger.debug({
          message: "Created new session",
          session,
        });
        return loginDto;
      } finally {
        if (global.gc) {
          setImmediate(() => global.gc());
        }
      }
    });
  }

  async refresh(
    user: GamevaultUser,
    ipAddress: string,
    userAgent: string,
    currentRefreshToken: string,
  ): Promise<TokenPairDto> {
    return this.authQueue.add(async () => {
      let session: Session | null = null;
      try {
        this.logger.debug(`Refreshing token for user ${user.username}`);
        // Find and update existing session
        const refreshTokenHash = createHash("sha256")
          .update(currentRefreshToken)
          .digest("hex");
        session = await this.sessionRepository.findOne({
          where: {
            user: { id: user.id },
            refresh_token_hash: refreshTokenHash,
            revoked: false,
            expires_at: MoreThan(new Date()),
          },
        });
        if (!session) {
          throw new UnauthorizedException("Invalid or expired refresh token");
        }
        // Generate new tokens
        const payload: GamevaultJwtPayload = {
          sub: user.id.toString(),
          name:
            [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
          given_name: user.first_name,
          family_name: user.last_name,
          preferred_username: user.username,
          email: user.email,
          role: user.role.toString(),
          birthdate: user.birth_date?.toISOString(),
        };
        const newRefreshToken = this.jwtService.sign(
          { payload },
          {
            secret: configuration.AUTH.REFRESH_TOKEN.SECRET,
            expiresIn: configuration.AUTH.REFRESH_TOKEN
              .EXPIRES_IN as StringValue,
          },
        );
        // Store old token in Redis (grace period) to avoid schema changes.
        if (configuration.AUTH.USE_REDIS_GRACE_PERIOD) {
          try {
            const ttlSeconds = Math.ceil(
              (ms(
                configuration.AUTH.REFRESH_TOKEN.GRACE_PERIOD as StringValue,
              ) || 0) / 1000,
            );
            if (this.redisClient && ttlSeconds > 0) {
              await this.redisClient.set(
                `prev:${session.refresh_token_hash}`,
                "1",
                "EX",
                ttlSeconds,
              );
            } else if (ttlSeconds > 0) {
              this.fallbackCache.set(
                `prev:${session.refresh_token_hash}`,
                ttlSeconds,
              );
            }
          } catch (err) {
            const ttlSeconds = Math.ceil(
              (ms(
                configuration.AUTH.REFRESH_TOKEN.GRACE_PERIOD as StringValue,
              ) || 0) / 1000,
            );
            this.fallbackCache.set(
              `prev:${session.refresh_token_hash}`,
              ttlSeconds,
            );
            this.logger.warn({
              message: "Redis unavailable, using in-memory grace-period store",
              err,
            });
          }
        }
        // Update session with new refresh token
        session.refresh_token_hash = createHash("sha256")
          .update(newRefreshToken)
          .digest("hex");
        session.expires_at = new Date(
          Date.now() +
            ms(configuration.AUTH.REFRESH_TOKEN.EXPIRES_IN as StringValue),
        );
        await this.sessionRepository.save(session);
        return {
          access_token: this.jwtService.sign({ payload }),
          refresh_token: newRefreshToken,
        };
      } catch (error) {
        throw error;
      } finally {
        session = null;
        if (global.gc) {
          setImmediate(() => global.gc());
        }
      }
    });
  }

  async register(dto: RegisterUserDto): Promise<GamevaultUser> {
    return this.usersService.register(dto);
  }

  async revoke(dto: RefreshTokenDto) {
    if (!dto.refresh_token) {
      throw new BadRequestException("No refresh token provided");
    }

    const refreshTokenHash = createHash("sha256")
      .update(dto.refresh_token)
      .digest("hex");

    // Find and mark the session as revoked
    const session = await this.sessionRepository.findOne({
      where: {
        refresh_token_hash: refreshTokenHash,
        revoked: false,
      },
    });

    if (session) {
      session.revoked = true;
      await this.sessionRepository.save(session);
      this.logger.debug({
        message: "Session revoked successfully",
        session_id: session.id,
      });
      return;
    }
    this.logger.warn({
      message: "Attempted to revoke non-existent or already revoked session",
    });
  }

  async isTokenRevoked(refreshToken: string): Promise<boolean> {
    const refreshTokenHash = createHash("sha256")
      .update(refreshToken)
      .digest("hex");

    // Check if token matches current refresh token
    const currentSession = await this.sessionRepository.findOne({
      where: {
        refresh_token_hash: refreshTokenHash,
        revoked: false,
        expires_at: MoreThan(new Date()),
      },
    });

    if (currentSession) {
      return false;
    }
    // If DB lookup failed, check Redis/in-memory fallback for previous token (grace period)
    try {
      if (configuration.AUTH.USE_REDIS_GRACE_PERIOD) {
        if (this.redisClient) {
          const exists = await this.redisClient.exists(
            `prev:${refreshTokenHash}`,
          );
          if (exists) return false;
        }
        // Check in-memory fallback
        if (this.fallbackCache.has(`prev:${refreshTokenHash}`)) return false;
      }
    } catch (err) {
      this.logger.warn({
        message: "Redis check failed in isTokenRevoked",
        err,
      });
    }

    // No matching current or previous token found
    return true;
  }

  async getUserSessions(user: GamevaultUser): Promise<Session[]> {
    // Use streaming/limit to avoid loading too many sessions
    const sessions = await this.sessionRepository
      .createQueryBuilder("session")
      .where("session.user_id = :userId", { userId: user.id })
      .andWhere("session.revoked = :revoked", { revoked: false })
      .andWhere("session.expires_at > :now", { now: new Date() })
      .orderBy("session.created_at", "DESC")
      .take(100) // Limit results to prevent massive memory usage
      .getMany();
    return sessions;
  }

  async revokeAllUserSessions(user: GamevaultUser): Promise<void> {
    await this.sessionRepository.update(
      {
        user: { id: user.id },
        revoked: false,
        expires_at: MoreThan(new Date()),
      },
      {
        revoked: true,
      },
    );
    this.logger.debug({
      message: "All active sessions revoked for user",
      user_id: user.id,
    });
  }
}
