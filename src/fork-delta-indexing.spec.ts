/**
 * Fork contract tests — worker-thread indexing gates.
 *
 * Upstream runs the initial index from FilesService.onApplicationBootstrap() on
 * the main event loop. The fork moved it into a worker thread (indexer-worker)
 * and added two guards so the @Cron re-index can never run concurrently with
 * it — running two full indexes at once was a reliable OOM.
 *
 * See CLAUDE.md → "Preserving the Fork Across Upstream Merges".
 */

import { SchedulerRegistry } from "@nestjs/schedule";
import { FilesService } from "./modules/games/files.service";
import { GamesService } from "./modules/games/games.service";
import { MetadataService } from "./modules/metadata/metadata.service";

jest.mock("./configuration", () => ({
  __esModule: true,
  default: {
    TESTING: { MOCK_FILES: true },
    VOLUMES: { FILES: "/tmp/test-files" },
    GAMES: {
      SUPPORTED_FILE_FORMATS: [".zip", ".7z"],
      SEARCH_RECURSIVE: false,
      INDEX_INTERVAL_IN_MINUTES: 0,
      INDEX_USE_POLLING: false,
      INDEX_CONCURRENCY: 1,
      DEFAULT_ARCHIVE_PASSWORD: "",
      MAX_UPLOAD_SIZE: 1073741824,
    },
    SERVER: { MAX_DOWNLOAD_BANDWIDTH_IN_KBPS: 0 },
  },
}));

jest.mock("./logging", () => ({
  logGamevaultGame: jest.fn((g) => ({ id: g?.id, path: g?.file_path })),
}));

jest.mock("fs-extra", () => ({
  access: jest.fn(),
  constants: { W_OK: 2 },
  createReadStream: jest.fn(),
  pathExists: jest.fn(),
  rm: jest.fn(),
  stat: jest.fn(),
  writeFile: jest.fn(),
}));

describe("Fork delta: initial-index gate", () => {
  let service: FilesService;
  let gamesService: any;
  let readAllFilesSpy: jest.SpyInstance;

  beforeEach(() => {
    gamesService = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    // Constructed through `any` so this file also compiles against pre-v17
    // trees, where FilesService took no GameVersion repository. The first three
    // arguments are identical in both arities.
    service = new (FilesService as any)(
      gamesService as unknown as GamesService,
      { addUpdateMetadataJob: jest.fn() } as unknown as MetadataService,
      { getCronJob: jest.fn() } as unknown as SchedulerRegistry,
      { find: jest.fn().mockResolvedValue([]), softDelete: jest.fn() } as any,
    );
    readAllFilesSpy = jest
      .spyOn(service as any, "readAllFiles")
      .mockResolvedValue([]);
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * The @Cron re-index must be inert until the worker thread reports it has
   * finished the initial pass. Without this gate the cron fires while the
   * worker is still indexing and both run a full index at once.
   */
  it("skips the cron re-index before the worker has finished", async () => {
    await service.indexAllFiles();

    expect(readAllFilesSpy).not.toHaveBeenCalled();
  });

  /** markInitialIndexComplete() is what main.ts calls on the worker's exit. */
  it("runs the re-index once the worker has reported completion", async () => {
    service.markInitialIndexComplete();

    await service.indexAllFiles();

    expect(readAllFilesSpy).toHaveBeenCalled();
  });

  it("exposes initialIndexComplete so main.ts can gate on it", () => {
    expect(service.initialIndexComplete).toBe(false);
    service.markInitialIndexComplete();
    expect(service.initialIndexComplete).toBe(true);
  });

  /**
   * Re-entrancy guard: a slow index must not stack with the next cron tick.
   */
  it("skips a re-index while one is already running", async () => {
    service.markInitialIndexComplete();

    let releaseFirstRun: () => void = () => {};
    readAllFilesSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirstRun = () => resolve([]);
        }),
    );

    const firstRun = service.indexAllFiles();
    await new Promise((resolve) => setImmediate(resolve));

    // Second tick arrives while the first is still awaiting readAllFiles.
    await service.indexAllFiles();
    expect(readAllFilesSpy).toHaveBeenCalledTimes(1);

    releaseFirstRun();
    await firstRun;
  });
});
