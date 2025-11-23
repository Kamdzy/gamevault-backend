import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";
import configuration from "../../../configuration";
import { UsersService } from "../../users/users.service";
import { AuthenticationService } from "../authentication.service";
import { GamevaultJwtPayload } from "../models/gamevault-jwt-payload.interface";

@Injectable()
export class RefreshTokenStrategy extends PassportStrategy(
  Strategy,
  "refresh-token",
) {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthenticationService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configuration.AUTH.REFRESH_TOKEN.SECRET,
      ignoreExpiration: false,
      passReqToCallback: true,
    });
  }

  async validate(request: Request, dto: { payload: GamevaultJwtPayload }) {
    // Check if token is revoked
    const token = request.headers.authorization.split(" ")[1];
    const isRevoked = await this.authService.isTokenRevoked(token);
    if (isRevoked) {
      const ex = new UnauthorizedException(
        "Authentication Failed: token has been revoked",
      );
      // Mark this exception so the global exception filter can suppress logging
      // for expected revoked-token attempts (to avoid log spam).
      (ex as any).suppressLogging = true;
      throw ex;
    }

    return await this.usersService.findOneByUsernameOrFail(
      (
        await this.usersService.findUserForAuthOrFail({
          id: Number(dto.payload?.sub),
          username: dto.payload?.preferred_username,
          email: dto.payload?.email,
        })
      ).username,
    );
  }
}
