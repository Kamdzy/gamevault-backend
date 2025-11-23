import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import { StringValue } from "ms";
import configuration from "../../configuration";
import { RedisModule } from "../cache/redis.module";
import { UsersModule } from "../users/users.module";
import { AuthenticationService } from "./authentication.service";
import { GamevaultJwtController } from "./controllers/authentication.controller";
import { BasicAuthController } from "./controllers/basic-auth.controller";
import { OAuth2Controller } from "./controllers/oauth2.controller";
import { ApiKeyGuard } from "./guards/api-key.guard";
import { AuthenticationGuard } from "./guards/authentication.guard";
import { AuthorizationGuard } from "./guards/authorization.guard";
import { Session } from "./session.entity";
import { AuthenticationStrategy } from "./strategies/authentication.strategy";
import { BasicAuthenticationStrategy as BasicAuthStrategy } from "./strategies/basic-auth.strategy";
import { OAuth2Strategy } from "./strategies/oauth2.strategy";
import { RefreshTokenStrategy } from "./strategies/refresh-token.strategy";

@Module({
  imports: [
    UsersModule,
    RedisModule,
    ThrottlerModule.forRoot({ ttl: 60, limit: 5 }),
    TypeOrmModule.forFeature([Session]),
    JwtModule.register({
      global: true,
      secret: configuration.AUTH.ACCESS_TOKEN.SECRET,
      signOptions: {
        expiresIn: configuration.AUTH.ACCESS_TOKEN.EXPIRES_IN as StringValue,
      },
    }),
  ],
  controllers: [
    BasicAuthController,
    GamevaultJwtController,
    ...(configuration.AUTH.BASIC_AUTH.ENABLED ? [BasicAuthController] : []),
    ...(configuration.AUTH.OAUTH2.ENABLED ? [OAuth2Controller] : []),
  ],
  providers: [
    AuthenticationStrategy,
    RefreshTokenStrategy,
    AuthenticationService,

    ...(configuration.AUTH.API_KEY.ENABLED
      ? [
          {
            provide: APP_GUARD,
            useClass: ApiKeyGuard,
          },
        ]
      : []),

    // Apply throttling guard for auth module
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },

    {
      provide: APP_GUARD,
      useClass: AuthenticationGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AuthorizationGuard,
    },
    ...(configuration.AUTH.BASIC_AUTH.ENABLED ? [BasicAuthStrategy] : []),
    ...(configuration.AUTH.OAUTH2.ENABLED ? [OAuth2Strategy] : []),
  ],
  exports: [AuthenticationService],
})
export class AuthModule {}
