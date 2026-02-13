import { Repository } from "typeorm";
import { GamevaultUser } from "../users/gamevault-user.entity";
import { Role } from "../users/models/role.enum";
import { UsersService } from "../users/users.service";
import { State } from "./models/state.enum";
import { ProgressController } from "./progress.controller";
import { Progress } from "./progress.entity";
import { ProgressService } from "./progress.service";

describe("ProgressController", () => {
  let controller: ProgressController;
  let progressService: jest.Mocked<ProgressService>;
  let usersService: jest.Mocked<UsersService>;
  let progressRepository: jest.Mocked<Repository<Progress>>;

  const createMockUser = (
    overrides: Partial<GamevaultUser> = {},
  ): GamevaultUser => {
    const user = new GamevaultUser();
    user.id = 1;
    user.username = "testuser";
    user.role = Role.USER;
    Object.assign(user, overrides);
    return user;
  };

  const createMockProgress = (overrides: Partial<Progress> = {}): Progress => {
    const progress = new Progress();
    progress.id = 1;
    progress.minutes_played = 60;
    progress.state = State.PLAYING;
    Object.assign(progress, overrides);
    return progress;
  };

  beforeEach(() => {
    progressService = {
      ignoreList: ["file1.exe", "file2.exe"],
      findOneByUserIdAndGameIdOrReturnEmptyProgress: jest.fn(),
      set: jest.fn(),
      increment: jest.fn(),
      deleteByUserIdAndGameId: jest.fn(),
    } as any;

    usersService = {
      findUserAgeByUsername: jest.fn().mockResolvedValue(undefined),
    } as any;

    progressRepository = {} as any;

    controller = new ProgressController(
      progressService,
      usersService,
      progressRepository,
    );
  });

  describe("getIgnoreFile", () => {
    it("should return the ignore list", () => {
      const result = controller.getIgnoreFile();
      expect(result).toEqual(["file1.exe", "file2.exe"]);
    });
  });

  describe("getProgressByUserIdAndGameId", () => {
    it("should return progress for a user and game", async () => {
      const mockProgress = createMockProgress();
      progressService.findOneByUserIdAndGameIdOrReturnEmptyProgress.mockResolvedValue(
        mockProgress,
      );

      const result = await controller.getProgressByUserIdAndGameId(
        { user_id: 1, game_id: 42 },
        { user: createMockUser() },
      );
      expect(result).toEqual(mockProgress);
      expect(
        progressService.findOneByUserIdAndGameIdOrReturnEmptyProgress,
      ).toHaveBeenCalledWith(1, 42, expect.any(Object));
    });
  });

  describe("putProgressByUserIdAndGameId", () => {
    it("should set progress for a user and game", async () => {
      const mockProgress = createMockProgress({ state: State.COMPLETED });
      progressService.set.mockResolvedValue(mockProgress);

      const result = await controller.putProgressByUserIdAndGameId(
        { user_id: 1, game_id: 42 },
        { state: State.COMPLETED, minutes_played: 100 },
        { user: createMockUser() },
      );
      expect(result.state).toBe(State.COMPLETED);
      expect(progressService.set).toHaveBeenCalledWith(
        1,
        42,
        { state: State.COMPLETED, minutes_played: 100 },
        "testuser",
      );
    });
  });

  describe("putProgressByUserIdAndGameIdIncrementByOne", () => {
    it("should increment progress by 1 minute", async () => {
      const mockProgress = createMockProgress({ minutes_played: 61 });
      progressService.increment.mockResolvedValue(mockProgress);

      const result =
        await controller.putProgressByUserIdAndGameIdIncrementByOne(
          { user_id: 1, game_id: 42 },
          { user: createMockUser() },
        );
      expect(result.minutes_played).toBe(61);
      expect(progressService.increment).toHaveBeenCalledWith(1, 42, "testuser");
    });
  });

  describe("putProgressByUserIdAndGameIdIncrementByMinutes", () => {
    it("should increment progress by specified minutes", async () => {
      const mockProgress = createMockProgress({ minutes_played: 70 });
      progressService.increment.mockResolvedValue(mockProgress);

      const result =
        await controller.putProgressByUserIdAndGameIdIncrementByMinutes(
          { user_id: 1, game_id: 42, minutes: "10" },
          { user: createMockUser() },
        );
      expect(result.minutes_played).toBe(70);
      expect(progressService.increment).toHaveBeenCalledWith(
        1,
        42,
        "testuser",
        10,
      );
    });
  });

  describe("deleteProgressByUserIdAndGameId", () => {
    it("should delete progress for a user and game", async () => {
      const mockProgress = createMockProgress();
      progressService.deleteByUserIdAndGameId.mockResolvedValue(mockProgress);

      const result = await controller.deleteProgressByUserIdAndGameId(
        { user_id: 1, game_id: 42 },
        { user: createMockUser() },
      );
      expect(result).toEqual(mockProgress);
      expect(progressService.deleteByUserIdAndGameId).toHaveBeenCalledWith(
        1,
        42,
        "testuser",
      );
    });
  });
});
