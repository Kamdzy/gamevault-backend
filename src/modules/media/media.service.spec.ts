import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Repository } from "typeorm";
import configuration from "../../configuration";
import { GamevaultUser } from "../users/gamevault-user.entity";
import { UsersService } from "../users/users.service";
import { Media } from "./media.entity";
import { MediaService } from "./media.service";

// Mock configuration - must be before any imports that use it
jest.mock("../../configuration", () => ({
  __esModule: true,
  default: {
    VOLUMES: { MEDIA: "/media", LOGS: "/logs" },
    MEDIA: {
      MAX_SIZE: 10 * 1024 * 1024,
      SUPPORTED_FORMATS: [
        "image/jpeg",
        "image/png",
        "image/gif",
        "video/mp4",
        "audio/mpeg",
      ],
    },
    TESTING: { MOCK_FILES: true },
    SERVER: { LOG_LEVEL: "off", LOG_FILES_ENABLED: false },
  },
}));

// Mock logging module to avoid configuration dependency chain
jest.mock("../../logging", () => ({
  __esModule: true,
  default: { log: jest.fn(), error: jest.fn(), warn: jest.fn() },
  logMedia: jest.fn((m) => ({ id: m?.id, file_path: m?.file_path })),
  logGamevaultGame: jest.fn(),
  logGamevaultUser: jest.fn(),
  stream: { write: jest.fn() },
}));

// Mock file-type-checker
jest.mock("file-type-checker", () => ({
  __esModule: true,
  default: {
    detectFile: jest.fn(),
  },
}));

// Mock fs-extra
jest.mock("fs-extra", () => ({
  pathExists: jest.fn().mockResolvedValue(true),
  remove: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

import fileTypeChecker from "file-type-checker";

describe("MediaService", () => {
  let service: MediaService;
  let mediaRepository: jest.Mocked<Repository<Media>>;
  let usersService: jest.Mocked<UsersService>;

  const createMockMedia = (overrides: Partial<Media> = {}): Media => {
    const media = new Media();
    media.id = 1;
    media.type = "image/jpeg";
    media.file_path = "/media/test.jpg";
    Object.assign(media, overrides);
    return media;
  };

  beforeEach(() => {
    mediaRepository = {
      findOneByOrFail: jest.fn(),
      findOneOrFail: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    } as any;

    usersService = {
      findOneByUsernameOrFail: jest.fn(),
    } as any;

    service = new MediaService(
      mediaRepository,
      usersService,
      configuration as any,
    );
  });

  describe("isAvailable", () => {
    it("should return true when media exists", async () => {
      mediaRepository.findOneByOrFail.mockResolvedValue(createMockMedia());
      const result = await service.isAvailable(1);
      expect(result).toBe(true);
    });

    it("should return false when media does not exist", async () => {
      mediaRepository.findOneByOrFail.mockRejectedValue(new Error("Not found"));
      const result = await service.isAvailable(999);
      expect(result).toBe(false);
    });

    it("should return false when id is null", async () => {
      const result = await service.isAvailable(null);
      expect(result).toBe(false);
    });

    it("should return false when id is 0", async () => {
      const result = await service.isAvailable(0);
      expect(result).toBe(false);
    });
  });

  describe("findOneByMediaIdOrFail", () => {
    it("should return media when found", async () => {
      const mockMedia = createMockMedia();
      mediaRepository.findOneByOrFail.mockResolvedValue(mockMedia);
      const result = await service.findOneByMediaIdOrFail(1);
      expect(result).toEqual(mockMedia);
    });

    it("should throw NotFoundException when not found", async () => {
      mediaRepository.findOneByOrFail.mockRejectedValue(new Error("Not found"));
      await expect(service.findOneByMediaIdOrFail(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("upload", () => {
    it("should upload a valid media file", async () => {
      const mockUser = new GamevaultUser();
      mockUser.username = "testuser";
      usersService.findOneByUsernameOrFail.mockResolvedValue(mockUser);

      (fileTypeChecker.detectFile as jest.Mock).mockReturnValue({
        extension: "jpg",
        mimeType: "image/jpeg",
      });

      mediaRepository.save.mockImplementation(
        async (media) =>
          ({
            ...media,
            id: 1,
          }) as any,
      );

      const file = {
        buffer: Buffer.from("fake image content"),
        originalname: "test.jpg",
        mimetype: "image/jpeg",
        size: 1024,
      } as Express.Multer.File;

      const result = await service.upload(file, "testuser");
      expect(result).toBeDefined();
      expect(result.type).toBe("image/jpeg");
    });

    it("should throw BadRequestException for unsupported file type", async () => {
      const mockUser = new GamevaultUser();
      usersService.findOneByUsernameOrFail.mockResolvedValue(mockUser);

      (fileTypeChecker.detectFile as jest.Mock).mockReturnValue({
        extension: "exe",
        mimeType: "application/x-executable",
      });

      const file = {
        buffer: Buffer.from("fake exe content"),
        originalname: "test.exe",
        mimetype: "application/octet-stream",
        size: 1024,
      } as Express.Multer.File;

      await expect(service.upload(file, "testuser")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when file type cannot be detected", async () => {
      const mockUser = new GamevaultUser();
      usersService.findOneByUsernameOrFail.mockResolvedValue(mockUser);

      (fileTypeChecker.detectFile as jest.Mock).mockReturnValue({
        extension: undefined,
        mimeType: undefined,
      });

      const file = {
        buffer: Buffer.from("unknown content"),
        originalname: "unknown",
        mimetype: "application/octet-stream",
        size: 1024,
      } as Express.Multer.File;

      await expect(service.upload(file, "testuser")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("delete", () => {
    it("should delete media (mocked files mode)", async () => {
      const media = createMockMedia();
      // In test mode with TESTING.MOCK_FILES = true, it just logs a warning
      await service.delete(media);
      // Should not throw
    });
  });
});
