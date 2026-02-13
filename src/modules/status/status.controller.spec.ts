import { GamevaultUser } from "../users/gamevault-user.entity";
import { Role } from "../users/models/role.enum";
import { StatusEnum } from "./models/status.enum";
import { StatusController } from "./status.controller";
import { StatusService } from "./status.service";

describe("StatusController", () => {
  let controller: StatusController;
  let service: StatusService;

  beforeEach(() => {
    service = new StatusService();
    controller = new StatusController(service);
  });

  describe("getStatus", () => {
    it("should return basic status for non-admin users", async () => {
      const user = new GamevaultUser();
      user.role = Role.USER;
      const result = await controller.getStatus({ user });
      expect(result).toHaveProperty("status", StatusEnum.HEALTHY);
      expect(result.protocol).toBeUndefined();
      expect(result.uptime).toBeUndefined();
    });

    it("should return extensive status for admin users", async () => {
      const user = new GamevaultUser();
      user.role = Role.ADMIN;
      const result = await controller.getStatus({ user });
      expect(result).toHaveProperty("status", StatusEnum.HEALTHY);
      expect(result).toHaveProperty("protocol");
      expect(result).toHaveProperty("uptime");
    });

    it("should return basic status for guest users", async () => {
      const user = new GamevaultUser();
      user.role = Role.GUEST;
      const result = await controller.getStatus({ user });
      expect(result.protocol).toBeUndefined();
      expect(result.uptime).toBeUndefined();
    });

    it("should return basic status when request is null", async () => {
      const result = await controller.getStatus(null);
      expect(result).toHaveProperty("status", StatusEnum.HEALTHY);
      expect(result.protocol).toBeUndefined();
      expect(result.uptime).toBeUndefined();
    });

    it("should return basic status when user is undefined", async () => {
      const result = await controller.getStatus({ user: undefined } as any);
      expect(result).toHaveProperty("status", StatusEnum.HEALTHY);
      expect(result.protocol).toBeUndefined();
    });

    it("should return extensive status for editor users (role < ADMIN)", async () => {
      const user = new GamevaultUser();
      user.role = Role.EDITOR;
      const result = await controller.getStatus({ user });
      // EDITOR (2) < ADMIN (3), so basic status
      expect(result.protocol).toBeUndefined();
      expect(result.uptime).toBeUndefined();
    });
  });
});
