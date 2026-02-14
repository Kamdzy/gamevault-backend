import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AppConfiguration, CONFIG_NAMESPACE } from "../../configuration";
import { DatabaseService } from "./database.service";
import { getDatabaseConfiguration } from "./db_configuration";

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const configuration =
          configService.getOrThrow<AppConfiguration>(CONFIG_NAMESPACE);
        return getDatabaseConfiguration(configuration);
      },
    }),
  ],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
