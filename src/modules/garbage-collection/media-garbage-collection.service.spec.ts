import { MediaGarbageCollectionService } from "./media-garbage-collection.service";

jest.mock("../../configuration", () => ({
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

jest.mock("../../logging", () => ({
  __esModule: true,
  default: {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  logGamevaultGame: jest.fn(),
  logGamevaultUser: jest.fn(),
  logMedia: jest.fn(),
  logMetadata: jest.fn(),
  logMetadataProvider: jest.fn(),
  logProgress: jest.fn(),
}));

describe("MediaGarbageCollectionService", () => {
  let service: MediaGarbageCollectionService;
  let mockMediaRepo: any;
  let mockGameMetadataRepo: any;
  let mockUserRepo: any;
  let mockMediaService: any;

  beforeEach(() => {
    mockMediaRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    mockGameMetadataRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    mockUserRepo = {
      find: jest.fn().mockResolvedValue([]),
    };
    mockMediaService = {
      delete: jest.fn().mockResolvedValue(undefined),
    };

    service = new MediaGarbageCollectionService(
      mockMediaRepo,
      mockGameMetadataRepo,
      mockUserRepo,
      mockMediaService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  // ─── garbageCollectUnusedMedia ─────────────────────────────────────

  describe("garbageCollectUnusedMedia", () => {
    it("should skip when GC is disabled", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const config = require("../../configuration").default;
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
      mockGameMetadataRepo.find.mockResolvedValue([
        { id: 1, background: null, cover: usedMedia },
      ]);
      mockUserRepo.find.mockResolvedValue([]);

      await service.garbageCollectUnusedMedia();

      expect(mockMediaService.delete).toHaveBeenCalledTimes(1);
      expect(mockMediaService.delete).toHaveBeenCalledWith(unusedMedia);
    });

    it("should not delete any media when all are used", async () => {
      const media1 = { id: 1, file_path: "/media/a.jpg" };
      const media2 = { id: 2, file_path: "/media/b.jpg" };

      mockMediaRepo.find.mockResolvedValue([media1, media2]);

      mockUserRepo.find.mockResolvedValue([
        { id: 1, avatar: media1, background: media2 },
      ]);
      mockGameMetadataRepo.find.mockResolvedValue([]);

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
      mockUserRepo.find.mockResolvedValue([
        { id: 1, avatar: userMedia, background: null },
      ]);
      mockGameMetadataRepo.find.mockResolvedValue([
        { id: 1, cover: gameMedia, background: null },
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
