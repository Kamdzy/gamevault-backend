import { SchedulerRegistry } from "@nestjs/schedule";
import { MetadataService } from "../metadata/metadata.service";
import { FilesService } from "./files.service";
import { GamesService } from "./games.service";

// We need to mock configuration before importing the service
jest.mock("../../configuration", () => ({
  __esModule: true,
  default: {
    TESTING: { MOCK_FILES: true },
    VOLUMES: { FILES: "/tmp/test-files" },
    GAMES: {
      SUPPORTED_FILE_FORMATS: [".zip", ".7z", ".rar", ".tar", ".gz", ".exe"],
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

jest.mock("../../globals", () => ({
  __esModule: true,
  default: {
    ARCHIVE_FORMATS: [".zip", ".7z", ".rar", ".tar", ".gz"],
  },
}));

jest.mock("../../logging", () => ({
  logGamevaultGame: jest.fn((g) => ({ id: g?.id, path: g?.file_path })),
}));

describe("FilesService", () => {
  let service: FilesService;
  let gamesService: jest.Mocked<GamesService>;
  let metadataService: jest.Mocked<MetadataService>;
  let schedulerRegistry: jest.Mocked<SchedulerRegistry>;

  beforeEach(() => {
    gamesService = {
      findOneByGameIdOrFail: jest.fn(),
      generateSortTitle: jest.fn((t) => t.toLowerCase()),
      checkIfExistsInDatabase: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
      restore: jest.fn(),
    } as any;

    metadataService = {
      addUpdateMetadataJob: jest.fn(),
    } as any;

    schedulerRegistry = {
      getTimeouts: jest.fn().mockReturnValue([]),
      addTimeout: jest.fn(),
      deleteTimeout: jest.fn(),
    } as any;

    service = new FilesService(
      gamesService,
      metadataService,
      schedulerRegistry,
    );
  });

  describe("extractTitle (via private method access)", () => {
    // Access private method for testing
    const extractTitle = (filename: string): string => {
      return (service as any).extractTitle(filename);
    };

    it("should extract title from filename without extension", () => {
      expect(extractTitle("My Game.zip")).toBe("My Game");
    });

    it("should remove parenthetical content", () => {
      expect(extractTitle("My Game (v1.0).zip")).toBe("My Game");
    });

    it("should remove multiple parenthetical sections", () => {
      expect(extractTitle("My Game (2023) (v1.0) (EA).zip")).toBe("My Game");
    });

    it("should handle extra spaces after removing parentheticals", () => {
      expect(extractTitle("My  Game  (v1.0)  .zip")).toBe("My Game");
    });

    it("should handle filenames with only parenthetical content", () => {
      expect(extractTitle("(v1.0).zip")).toBe("");
    });

    it("should handle complex filenames", () => {
      expect(
        extractTitle("The Elder Scrolls V - Skyrim (2011) (v1.6) (EA).zip"),
      ).toBe("The Elder Scrolls V - Skyrim");
    });

    it("should handle filenames with no parentheses", () => {
      expect(extractTitle("SimpleGame.zip")).toBe("SimpleGame");
    });
  });

  describe("extractVersion (via private method access)", () => {
    const extractVersion = (filename: string): string | undefined => {
      return (service as any).extractVersion(filename);
    };

    it("should extract version from parenthetical notation", () => {
      expect(extractVersion("Game (v1.0).zip")).toBe("v1.0");
    });

    it("should extract complex version strings", () => {
      expect(extractVersion("Game (v1.2.3-beta).zip")).toBe("v1.2.3-beta");
    });

    it("should return undefined when no version is present", () => {
      expect(extractVersion("Game.zip")).toBeUndefined();
    });

    it("should not treat year as version", () => {
      expect(extractVersion("Game (2023).zip")).toBeUndefined();
    });

    it("should extract version when multiple parentheticals exist", () => {
      expect(extractVersion("Game (2023) (v2.1).zip")).toBe("v2.1");
    });
  });

  describe("extractReleaseYear (via private method access)", () => {
    const extractReleaseYear = (filename: string): Date | undefined => {
      return (service as any).extractReleaseYear(filename);
    };

    it("should extract year from parenthetical notation", () => {
      const date = extractReleaseYear("Game (2023).zip");
      expect(date).toBeInstanceOf(Date);
      expect(date.getFullYear()).toBe(2023);
    });

    it("should return undefined when no year is present", () => {
      expect(extractReleaseYear("Game.zip")).toBeUndefined();
    });

    it("should extract the first 4-digit year", () => {
      const date = extractReleaseYear("Game (2020) (v1.0).zip");
      expect(date.getFullYear()).toBe(2020);
    });
  });

  describe("extractEarlyAccessFlag (via private method access)", () => {
    const extractEarlyAccessFlag = (filename: string): boolean => {
      return (service as any).extractEarlyAccessFlag(filename);
    };

    it("should return true when (EA) is present", () => {
      expect(extractEarlyAccessFlag("Game (EA).zip")).toBe(true);
    });

    it("should return false when (EA) is not present", () => {
      expect(extractEarlyAccessFlag("Game.zip")).toBe(false);
    });

    it("should be case-sensitive (ea should not match)", () => {
      expect(extractEarlyAccessFlag("Game (ea).zip")).toBe(false);
    });

    it("should handle EA alongside other parentheticals", () => {
      expect(extractEarlyAccessFlag("Game (2023) (EA) (v1.0).zip")).toBe(true);
    });
  });

  describe("isValidFilePath (via private method access)", () => {
    const isValidFilePath = (filename: string): boolean => {
      return (service as any).isValidFilePath(filename);
    };

    it("should accept valid zip filename", () => {
      expect(isValidFilePath("My Game.zip")).toBe(true);
    });

    it("should accept valid 7z filename", () => {
      expect(isValidFilePath("game.7z")).toBe(true);
    });

    it("should reject unsupported file extension", () => {
      expect(isValidFilePath("game.txt")).toBe(false);
    });

    it("should reject filename with invalid characters", () => {
      expect(isValidFilePath("ga<me>.zip")).toBe(false);
    });

    it("should accept path with forward slash in directory", () => {
      expect(isValidFilePath("/games/my-game.zip")).toBe(true);
    });

    it("should accept exe files", () => {
      expect(isValidFilePath("setup.exe")).toBe(true);
    });
  });

  describe("calculateRange (via private method access)", () => {
    const calculateRange = (
      rangeHeader: string | undefined,
      fileSize: number,
    ) => {
      return (service as any).calculateRange(rangeHeader, fileSize);
    };

    it("should return full file range when no range header provided", () => {
      const result = calculateRange(undefined, 1000);
      expect(result).toEqual({ start: 0, end: 999, size: 1000 });
    });

    it("should parse start and end range", () => {
      const result = calculateRange("bytes=0-499", 1000);
      expect(result).toEqual({ start: 0, end: 499, size: 500 });
    });

    it("should handle open-ended range (bytes=500-)", () => {
      const result = calculateRange("bytes=500-", 1000);
      expect(result).toEqual({ start: 500, end: 999, size: 500 });
    });

    it("should handle suffix range (bytes=-500)", () => {
      const result = calculateRange("bytes=-499", 1000);
      expect(result).toEqual({ start: 0, end: 499, size: 500 });
    });

    it("should handle range beyond file size gracefully", () => {
      const result = calculateRange("bytes=0-9999", 1000);
      // End beyond file size - should use fileSize - 1
      expect(result.start).toBe(0);
      expect(result.end).toBe(999);
    });

    it("should handle start beyond file size", () => {
      const result = calculateRange("bytes=9999-", 1000);
      // Start beyond file size - parseInt returns 9999 which is >= fileSize, so rangeStart stays 0
      expect(result.start).toBe(0);
      expect(result.end).toBe(999);
    });

    it("should return full range for invalid range header", () => {
      const result = calculateRange("invalid", 1000);
      expect(result).toEqual({ start: 0, end: 999, size: 1000 });
    });

    it("should return full range for empty range header", () => {
      const result = calculateRange("", 1000);
      expect(result).toEqual({ start: 0, end: 999, size: 1000 });
    });
  });
});
