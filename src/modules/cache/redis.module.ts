import { Global, Module } from "@nestjs/common";
import Redis from "ioredis";

export const REDIS_CLIENT = "REDIS_CLIENT";

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const url =
          process.env.REDIS_URL || (process.env.REDIS_HOST ? `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT || 6379}` : undefined) ||
          "redis://localhost:6379";
        const client = new Redis(url);
        client.on("error", (err) => {
          // Defer logging to the app logger; avoid throwing here so app can start in degraded mode
          // eslint-disable-next-line no-console
          console.error("Redis client error:", err?.message || err);
        });
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
