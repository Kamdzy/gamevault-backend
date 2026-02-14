import { PaginateQuery, PaginationType, paginate } from "nestjs-paginate";
import { Repository } from "typeorm";

import { DeveloperMetadata } from "./developer.metadata.entity";
import { DeveloperController } from "./developers.metadata.controller";

jest.mock("nestjs-paginate", () => {
  const actual = jest.requireActual("nestjs-paginate");

  return {
    ...actual,
    paginate: jest.fn(),
  };
});

describe("DeveloperController", () => {
  let controller: DeveloperController;
  let developerRepository: jest.Mocked<Partial<Repository<DeveloperMetadata>>>;
  let queryBuilder: any;

  beforeEach(() => {
    queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
    };

    developerRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    controller = new DeveloperController(developerRepository as any);
    (paginate as jest.Mock).mockReset();
  });

  it("should only query developers linked to non-deleted games", async () => {
    (paginate as jest.Mock).mockResolvedValue({
      data: [],
      meta: {},
      links: {},
    });

    await controller.getDevelopers({} as PaginateQuery);

    expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
      "developer.games",
      "games",
      "games.deleted_at IS NULL",
    );
    expect(queryBuilder.groupBy).toHaveBeenCalledWith("developer.id");
    expect(paginate).toHaveBeenCalledWith(
      expect.any(Object),
      queryBuilder,
      expect.objectContaining({
        paginationType: PaginationType.TAKE_AND_SKIP,
      }),
    );
  });

  it("should apply default sorting by game count when sortBy is empty", async () => {
    (paginate as jest.Mock).mockResolvedValue({
      data: [],
      meta: {},
      links: {},
    });

    await controller.getDevelopers({ sortBy: [] } as unknown as PaginateQuery);

    expect(queryBuilder.addSelect).toHaveBeenCalledWith(
      "COUNT(games.id)",
      "games_count",
    );
    expect(queryBuilder.orderBy).toHaveBeenCalledWith("games_count", "DESC");
  });
});
