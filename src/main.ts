import * as dotenv from "dotenv";
dotenv.config();

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import compression from "compression";
import cookieparser from "cookie-parser";
import helmet from "helmet";
import morgan from "morgan";
//import { AsyncApiDocumentBuilder, AsyncApiModule } from "nestjs-asyncapi";

import { Response } from "express";
import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import { AppModule } from "./app.module";
import configuration, {
  getCensoredConfiguration,
  getMaxBodySizeInBytes,
} from "./configuration";
import { LoggingExceptionFilter } from "./filters/http-exception.filter";
import { default as logger, stream, default as winston } from "./logging";
import { LegacyRoutesMiddleware } from "./middleware/legacy-routes.middleware";
import loadPlugins from "./plugin";

async function bootstrap(): Promise<void> {
  // Load Modules & Plugins
  const builtinModules = Reflect.getOwnMetadata("imports", AppModule);
  const pluginModules = await loadPlugins();
  const modules = [...builtinModules, ...pluginModules];

  Reflect.defineMetadata("imports", modules, AppModule);
  // Create App
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: winston,
  });

  // To Support Reverse Proxies
  app.set("trust proxy", 1);
  // Fancy JSON Responses
  app.set("json spaces", 2);
  // CORS Configuration
  app.enableCors({
    origin: configuration.SERVER.CORS_ALLOWED_ORIGINS.length
      ? configuration.SERVER.CORS_ALLOWED_ORIGINS
      : true,
    credentials: true,
    methods: "*",
    allowedHeaders: "*",
    exposedHeaders: "*",
  });
  // GZIP
  app.use(compression());

  // Set Max Body Size

  const maxBodySettings = {
    limit: `${getMaxBodySizeInBytes()}b`,
    extended: true,
  };
  app.useBodyParser("json", maxBodySettings);
  app.useBodyParser("urlencoded", maxBodySettings);
  app.useBodyParser("text", maxBodySettings);
  app.useBodyParser("raw", maxBodySettings);

  // Security Measurements
  app.use(helmet({ contentSecurityPolicy: false }));

  // Cookies
  app.use(cookieparser());

  // Support Legacy Routes
  app.use(new LegacyRoutesMiddleware().use);

  // Skips logs for /status and /health calls
  app.use(
    morgan(configuration.SERVER.REQUEST_LOG_FORMAT, {
      stream,
      skip: (req) => req.url.includes("/status") || req.url.includes("/health"),
    }),
  );

  // Validates incoming data
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
    }),
  );
  // Logs HTTP 4XX and 5XX as warns and errors
  app.useGlobalFilters(new LoggingExceptionFilter());

  // Basepath
  app.setGlobalPrefix("api");

  // Enable automatic HTTP Error Response Logging
  app.useGlobalFilters(new LoggingExceptionFilter());

  // Provide API Specification
  if (configuration.WEB_UI.ENABLED) {
    SwaggerModule.setup(
      "api/docs",
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle("GameVault Backend Server")
          .setContact("Phalcode", "https://phalco.de", "contact@phalco.de")
          .setExternalDoc("Documentation", "https://gamevau.lt")
          .setDescription(
            "Backend for GameVault, the self-hosted gaming platform for drm-free games",
          )
          .setVersion(configuration.SERVER.VERSION)
          .addBearerAuth(
            {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
              description:
                "Access token obtained from /api/auth/*/login endpoint.",
            },
            "bearer",
          )
          .addBasicAuth(
            {
              type: "http",
              scheme: "basic",
              description: "Basic Authentication",
            },
            "basic",
          )
          .addApiKey(
            {
              type: "apiKey",
              name: "X-Api-Key",
              in: "header",
              description: "API-Key Authentication",
            },
            "apikey",
          )
          .addServer(
            `http://localhost:${configuration.SERVER.PORT}`,
            "Local GameVault Server",
          )
          .addServer(`https://demo.gamevau.lt`, "Demo GameVault Server")
          .setLicense(
            "Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)",
            "https://github.com/Phalcode/gamevault-backend/LICENSE",
          )
          .build(),
      ),
    );
    // TODO: Leads to EACCES: permission denied, mkdir '/root/.npm/_cacache/tmp' running in docker for some reason
    //await AsyncApiModule.setup(
    //  "api/docs/async",
    //  app,
    //  AsyncApiModule.createDocument(
    //    app,
    //    new AsyncApiDocumentBuilder()
    //      .setTitle("GameVault Backend Server")
    //      .setDescription(
    //        "Asynchronous Socket.IO Backend for GameVault, the self-hosted gaming platform for drm-free games. To make a request, you need to authenticate with the X-Api-Key Header during the handshake. You can get this secret by using the /users/me REST API.",
    //      )
    //      .setContact("Phalcode", "https://phalco.de", "contact@phalco.de")
    //      .setExternalDoc("Documentation", "https://gamevau.lt")
    //      .setDefaultContentType("application/json")
    //      .setVersion(configuration.SERVER.VERSION)
    //      .addServer("Local GameVault Server", {
    //        url: "localhost:8080",
    //        protocol: "ws",
    //      })
    //      .addServer("Demo GameVault Server", {
    //        url: "demo.gamevau.lt",
    //        protocol: "wss",
    //      })
    //      .setLicense(
    //        "Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)",
    //        "https://github.com/Phalcode/gamevault-backend/LICENSE",
    //      )
    //      .build(),
    //  ),
    //);
  }

  // Redirect /health to /status
  app.use("/api/health", (_req, res: Response) => {
    res.redirect(308, "/api/status");
  });

  await app.listen(configuration.SERVER.PORT);

  logger.log({
    context: "Initialization",
    message: `Started GameVault Server.`,
    version: configuration.SERVER.VERSION,
    port: configuration.SERVER.PORT,
    config: getCensoredConfiguration(),
  });

  // Fire-and-forget: start initial file indexing in a worker thread so it
  // cannot block the main event loop. Prefer compiled JS in dist, fallback
  // to loading ts via ts-node in dev using an eval worker.
  if (!configuration.TESTING.MOCK_FILES) {
    try {
      const compiledWorker = path.join(
        process.cwd(),
        "dist",
        "src",
        "scripts",
        "indexer-worker.js",
      );
      let worker: Worker | undefined;

      if (fs.existsSync(compiledWorker)) {
        worker = new Worker(compiledWorker);
      } else {
        // Dev fallback: require ts-node/register then run the TS worker file
        const tsWorkerFile = path.join(
          process.cwd(),
          "src",
          "scripts",
          "indexer-worker.ts",
        );
        const code = `require('ts-node/register'); require(${JSON.stringify(tsWorkerFile)});`;
        worker = new Worker(code, { eval: true });
      }

      if (worker) {
        worker.unref();
        worker.on("error", (err) => {
          logger.error({
            context: "Initialization",
            message: "Indexer worker error.",
            error: err,
          });
        });
        worker.on("exit", (code) => {
          logger.log({
            context: "Initialization",
            message: `Indexer worker exited with code ${code}`,
          });
        });
        logger.log({
          context: "Initialization",
          message: "Triggered indexer worker thread.",
        });
      }
    } catch (error) {
      logger.error({
        context: "Initialization",
        message: "Failed to spawn indexer worker.",
        error,
      });
    }
  }
}

Error.stackTraceLimit = configuration.SERVER.STACK_TRACE_LIMIT;
bootstrap().catch((error) => {
  logger.error({ message: "A fatal error occured", error });
  throw error;
});
