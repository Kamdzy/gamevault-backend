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
import type { MockInstance } from "vitest";
import { FilesService } from "./modules/games/files.service.js";
import { GamesService } from "./modules/games/games.service.js";
import { MetadataService } from "./modules/metadata/metadata.service.js";

vi.mock("./configuration.js", () => ({
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

vi.mock("./logging.js", () => ({
  logGamevaultGame: vi.fn((g) => ({ id: g?.id, path: g?.file_path })),
}));

// fs-extra is CommonJS. Since the ESM migration the source does
// `import fsExtra from "fs-extra"` and destructures off the default, so the
// mock must expose BOTH the named exports and a matching `default`.
vi.mock("fs-extra", () => {
  const mock = {
    access: vi.fn(),
    constants: { W_OK: 2 },
    createReadStream: vi.fn(),
    pathExists: vi.fn(),
    readFileSync: vi.fn(() => ""),
    rm: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
  };
  return { ...mock, default: mock };
});

describe("Fork delta: initial-index gate", () => {
  let service: FilesService;
  let gamesService: any;
  let readAllFilesSpy: MockInstance;

  beforeEach(() => {
    gamesService = {
      find: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    // Constructed through `any` so this file also compiles against pre-v17
    // trees, where FilesService took no GameVersion repository. The first three
    // arguments are identical in both arities.
    service = new (FilesService as any)(
      gamesService as unknown as GamesService,
      { addUpdateMetadataJob: vi.fn() } as unknown as MetadataService,
      { getCronJob: vi.fn() } as unknown as SchedulerRegistry,
      { find: vi.fn().mockResolvedValue([]), softDelete: vi.fn() } as any,
    );
    readAllFilesSpy = vi
      .spyOn(service as any, "readAllFiles")
      .mockResolvedValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

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
  /**
   * The worker thread runs in its own process with its own FilesService
   * instance, so _initialIndexComplete is never set there — only main.ts, in
   * the main process, calls markInitialIndexComplete(). Routing the worker
   * through indexAllFiles() therefore made it a silent no-op and pushed every
   * index onto the main thread's cron instead. startIndexing() must bypass the
   * gate: it IS the initial index the gate exists to wait for.
   *
   * Mutation-verified: pointing startIndexing() back at indexAllFiles() makes
   * this fail.
   */
  it("startIndexing bypasses the gate so the worker can actually index", async () => {
    // Gate deliberately left closed, exactly as it is inside the worker.
    expect(service.initialIndexComplete).toBe(false);

    await service.startIndexing();

    expect(readAllFilesSpy).toHaveBeenCalled();
  });

  /** The re-entrancy guard must still apply to the worker entry point. */
  it("startIndexing still refuses to stack concurrent runs", async () => {
    (service as any).isIndexingRunning = true;

    await service.startIndexing();

    expect(readAllFilesSpy).not.toHaveBeenCalled();
  });

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
