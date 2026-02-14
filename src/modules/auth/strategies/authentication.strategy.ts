import { Inject, Injectable, Logger } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { AppConfiguration } from "../../../configuration";
import { GAMEVAULT_CONFIG } from "../../../gamevault-config";
import { UsersService } from "../../users/users.service";
import { GamevaultJwtPayload } from "../models/gamevault-jwt-payload.interface";
@Injectable()
export class AuthenticationStrategy extends PassportStrategy(Strategy, "auth") {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly usersService: UsersService,
    @Inject(GAMEVAULT_CONFIG) config: AppConfiguration,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.AUTH.ACCESS_TOKEN.SECRET,
      ignoreExpiration: false,
    });
  }

  async validate(dto: { payload: GamevaultJwtPayload }) {
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
