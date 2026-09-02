import * as dotenv from "dotenv";
import "reflect-metadata";
dotenv.config();

import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import logger from "../logging.js";
import { FilesService } from "../modules/games/files.service.js";
import loadPlugins from "../plugin.js";

async function run(): Promise<void> {
  try {
    // Load plugins into AppModule before creating the context — mirrors main.ts.
    // Without this, plugin-registered providers (e.g. dlsite, vndb) are absent
    // in the worker's DI container and cause ProviderNotFoundException at runtime.
    const builtinModules = Reflect.getOwnMetadata("imports", AppModule);
    const pluginModules = await loadPlugins();
    Reflect.defineMetadata(
      "imports",
      [...builtinModules, ...pluginModules],
      AppModule,
    );

    // Create a minimal application context (no HTTP server)
    const appContext = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    const filesService = appContext.get(FilesService, { strict: false });
    if (!filesService) {
      logger.error({
        context: "Indexer",
        message: "FilesService not found in indexer context.",
      });
      await appContext.close();
      process.exit(1);
    }

    logger.log({ context: "Indexer", message: "Indexer (worker) started." });

    try {
      // Must be startIndexing(), NOT indexAllFiles(). indexAllFiles() is gated
      // on _initialIndexComplete, which is only ever set in the main process —
      // calling it here made the worker silently no-op and pushed every index
      // onto the main thread's cron instead.
      await filesService.startIndexing();
      logger.log({ context: "Indexer", message: "Indexer (worker) finished." });
    } catch (err) {
      logger.error({
        context: "Indexer",
        message: "Indexer run failed.",
        error: err,
      });
    }

    await appContext.close();
    process.exit(0);
  } catch (error) {
    logger.error({
      context: "Indexer",
      message: "Fatal error in indexer.",
      error,
    });
    process.exit(1);
  }
}

run();
