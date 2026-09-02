import configuration from "../../configuration.js";
import { MediaGarbageCollectionService } from "./media-garbage-collection.service.js";

vi.mock("../../configuration.js", () => ({
  __esModule: true,
  default: {
    MEDIA: {
      GC_DISABLED: false,
      GC_INTERVAL_IN_MINUTES: 60,
    },
    TESTING: { MOCK_FILES: true },
    VOLUMES: { MEDIA: "/media" },
  },
}));

vi.mock("../../logging.js", () => ({
  __esModule: true,
  default: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  logGamevaultGame: vi.fn(),
  logGamevaultUser: vi.fn(),
  logMedia: vi.fn(),
  logMetadata: vi.fn(),
  logMetadataProvider: vi.fn(),
  logProgress: vi.fn(),
}));

describe("MediaGarbageCollectionService", () => {
  let service: MediaGarbageCollectionService;
  let mockMediaRepo: any;
  let mockGameMetadataRepo: any;
  let mockUserRepo: any;
  let mockMediaService: any;

  beforeEach(() => {
    // Fork: collectUsedMediaPaths() projects file paths with a QueryBuilder
    // rather than hydrating entities via find() -- upstream's find() call took
    // ~488s on 18,943 rows and stalled all HTTP for ~8-11 minutes hourly. The
    // repos it reads therefore need a chainable builder stub. Returning no rows
    // means "nothing is in use", which matches the previous find() -> [] stubs.
    const queryBuilderStub = () => {
      const qb: Record<string, unknown> = {};
      for (const method of ["withDeleted", "select", "leftJoin", "addSelect"]) {
        qb[method] = vi.fn(() => qb);
      }
      qb.getRawMany = vi.fn().mockResolvedValue([]);
      return qb;
    };

    mockMediaRepo = {
      find: vi.fn().mockResolvedValue([]),
    };
    mockGameMetadataRepo = {
      find: vi.fn().mockResolvedValue([]),
      createQueryBuilder: vi.fn(queryBuilderStub),
      metadata: { name: "GameMetadata" },
    };
    mockUserRepo = {
      find: vi.fn().mockResolvedValue([]),
      createQueryBuilder: vi.fn(queryBuilderStub),
      metadata: { name: "GamevaultUser" },
    };
    mockMediaService = {
      delete: vi.fn().mockResolvedValue(undefined),
    };

    // Point a repo's QueryBuilder at a specific set of projected rows. The
    // projection aliases each relation's column as `<relation>_file_path`.
    (globalThis as any).__setRawRows = (repo: any, rows: unknown[]) => {
      repo.createQueryBuilder = vi.fn(() => {
        const qb: Record<string, unknown> = {};
        for (const m of ["withDeleted", "select", "leftJoin", "addSelect"]) {
          qb[m] = vi.fn(() => qb);
        }
        qb.getRawMany = vi.fn().mockResolvedValue(rows);
        return qb;
      });
    };

    service = new MediaGarbageCollectionService(
      mockMediaRepo,
      mockGameMetadataRepo,
      mockUserRepo,
      mockMediaService,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  // ─── garbageCollectUnusedMedia ─────────────────────────────────────

  describe("garbageCollectUnusedMedia", () => {
    it("should skip when GC is disabled", async () => {
      const config = configuration as any;
      config.MEDIA.GC_DISABLED = true;

      await service.garbageCollectUnusedMedia();

      expect(mockMediaRepo.find).not.toHaveBeenCalled();

      config.MEDIA.GC_DISABLED = false;
    });

    it("should delete unused media from database", async () => {
      const usedMedia = { id: 1, file_path: "/media/used.jpg" };
      const unusedMedia = { id: 2, file_path: "/media/unused.jpg" };

      mockMediaRepo.find.mockResolvedValue([usedMedia, unusedMedia]);

      // Game metadata uses usedMedia as cover
      (globalThis as any).__setRawRows(mockGameMetadataRepo, [
        { background_file_path: null, cover_file_path: usedMedia.file_path },
      ]);
      (globalThis as any).__setRawRows(mockUserRepo, []);

      await service.garbageCollectUnusedMedia();

      expect(mockMediaService.delete).toHaveBeenCalledTimes(1);
      expect(mockMediaService.delete).toHaveBeenCalledWith(unusedMedia);
    });

    it("should not delete any media when all are used", async () => {
      const media1 = { id: 1, file_path: "/media/a.jpg" };
      const media2 = { id: 2, file_path: "/media/b.jpg" };

      mockMediaRepo.find.mockResolvedValue([media1, media2]);

      (globalThis as any).__setRawRows(mockUserRepo, [
        {
          avatar_file_path: media1.file_path,
          background_file_path: media2.file_path,
        },
      ]);
      (globalThis as any).__setRawRows(mockGameMetadataRepo, []);

      await service.garbageCollectUnusedMedia();

      expect(mockMediaService.delete).not.toHaveBeenCalled();
    });

    it("should handle empty media repository", async () => {
      mockMediaRepo.find.mockResolvedValue([]);
      mockUserRepo.find.mockResolvedValue([]);
      mockGameMetadataRepo.find.mockResolvedValue([]);

      await service.garbageCollectUnusedMedia();

      expect(mockMediaService.delete).not.toHaveBeenCalled();
    });

    it("should handle errors gracefully", async () => {
      mockMediaRepo.find.mockRejectedValue(new Error("DB error"));

      // Should not throw
      await expect(service.garbageCollectUnusedMedia()).resolves.not.toThrow();
    });
  });

  // ─── collectUsedMediaPaths ─────────────────────────────────────────

  describe("collectUsedMediaPaths (via garbageCollect)", () => {
    it("should collect paths from both users and game metadata", async () => {
      const userMedia = { id: 1, file_path: "/media/avatar.jpg" };
      const gameMedia = { id: 2, file_path: "/media/cover.jpg" };

      mockMediaRepo.find.mockResolvedValue([userMedia, gameMedia]);
      (globalThis as any).__setRawRows(mockUserRepo, [
        { avatar_file_path: userMedia.file_path, background_file_path: null },
      ]);
      (globalThis as any).__setRawRows(mockGameMetadataRepo, [
        { cover_file_path: gameMedia.file_path, background_file_path: null },
      ]);

      await service.garbageCollectUnusedMedia();

      // Both are used, so no deletions
      expect(mockMediaService.delete).not.toHaveBeenCalled();
    });
  });

  // ─── removeUnusedMediaFromFileSystem (skipped with MOCK_FILES) ─────

  describe("removeUnusedMediaFromFileSystem", () => {
    it("should skip when TESTING_MOCK_FILES is true", async () => {
      const unusedMedia = { id: 1, file_path: "/media/unused.jpg" };
      mockMediaRepo.find.mockResolvedValue([unusedMedia]);
      mockUserRepo.find.mockResolvedValue([]);
      mockGameMetadataRepo.find.mockResolvedValue([]);

      await service.garbageCollectUnusedMedia();

      // DB delete should still happen
      expect(mockMediaService.delete).toHaveBeenCalledWith(unusedMedia);
      // But filesystem cleanup is skipped (MOCK_FILES=true)
    });
  });
});
