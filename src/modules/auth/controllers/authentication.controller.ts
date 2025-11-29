import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Request,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Response } from "express";
import { SkipGuards } from "../../../decorators/skip-guards.decorator";
import { GamevaultUser } from "../../users/gamevault-user.entity";
import { AuthenticationService } from "../authentication.service";
import { CustomThrottlerGuard } from "../guards/custom-throttler.guard";
import { RefreshTokenGuard } from "../guards/refresh-token.guard";
import { RefreshTokenDto } from "../models/refresh-token.dto";
import { TokenPairDto } from "../models/token-pair.dto";
import { Session } from "../session.entity";

@Controller("auth")
@ApiTags("auth")
@ApiBearerAuth()
@ApiSecurity("apikey")
export class GamevaultJwtController {
  private readonly logger = new Logger(this.constructor.name);
  constructor(private readonly authService: AuthenticationService) {}

  @Post("refresh")
  @Throttle(3, 60) // Reduced from 5 to 3
  @UseGuards(CustomThrottlerGuard, RefreshTokenGuard)
  @SkipGuards()
  @ApiOperation({
    summary: "Refreshes the access token and extends the refresh token",
    description:
      "This endpoint takes a valid refresh token and issues new access and refresh tokens. The existing session is updated with the new refresh token hash and extended expiration time. The refresh token must be sent in the Authorization header.",
    operationId: "postAuthRefresh",
  })
  @ApiOkResponse({ type: () => TokenPairDto })
  async postAuthRefresh(
    @Request()
    req: {
      user: GamevaultUser;
      ip: string;
      headers: { [key: string]: string };
    },
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenPairDto> {
    const refreshToken = req.headers.authorization?.replace("Bearer ", "");
    
    if (!refreshToken) {
      res.setHeader('X-Auth-Action', 'relogin');
      throw new UnauthorizedException("No refresh token provided");
    }

    try {
      return await this.authService.refresh(
        refreshToken,
      );
    } catch (error) {
      // Signal to client that they should stop retrying and re-login
      res.setHeader('X-Auth-Action', 'relogin');
      
      // Convert BadRequest to Unauthorized for auth errors
      if (error instanceof BadRequestException) {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }
  }

  @Post("revoke")
  @ApiBody({ type: () => RefreshTokenDto })
  @SkipGuards()
  @ApiOperation({
    summary: "Revokes a specific refresh token",
    description:
      "This endpoint takes a refresh token and marks its associated session as revoked. The refresh token must be sent in the request body. Once revoked, the token cannot be used to refresh access tokens.",
    operationId: "postAuthRevoke",
  })
  async postAuthRevoke(
    @Body() refreshTokenDto: RefreshTokenDto,
  ): Promise<void> {
    return this.authService.revoke(refreshTokenDto);
  }

  @Get("sessions")
  @ApiOperation({
    summary: "Get all active sessions for the current user",
    description:
      "Returns a list of all active sessions for the authenticated user. A session is considered active if it is not revoked and not expired. Each session includes information about the device (IP address and user agent) where it was created.",
    operationId: "getAuthSessions",
  })
  @ApiOkResponse({ type: () => Session, isArray: true })
  async getAuthSessions(
    @Request() req: { user: GamevaultUser },
  ): Promise<Session[]> {
    return this.authService.getUserSessions(req.user);
  }

  @Post("revoke/all")
  @ApiOperation({
    summary: "Revoke all active sessions for the current user",
    description:
      "Revokes all active sessions for the authenticated user. This effectively logs the user out from all devices. A session is considered active if it is not revoked and not expired. The user will need to log in again to create new sessions.",
    operationId: "postAuthRevokeAll",
  })
  async postAuthRevokeAll(
    @Request() req: { user: GamevaultUser },
  ): Promise<void> {
    return this.authService.revokeAllUserSessions(req.user);
  }
}