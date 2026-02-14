import { PaginateQuery, PaginationType, paginate } from "nestjs-paginate";
import { Repository } from "typeorm";

import { PublisherMetadata } from "./publisher.metadata.entity";
import { PublisherController } from "./publishers.metadata.controller";

jest.mock("nestjs-paginate", () => {
  const actual = jest.requireActual("nestjs-paginate");

  return {
    ...actual,
    paginate: jest.fn(),
  };
});

describe("PublisherController", () => {
  let controller: PublisherController;
  let publisherRepository: jest.Mocked<Partial<Repository<PublisherMetadata>>>;
  let queryBuilder: any;

  beforeEach(() => {
    queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
    };

    publisherRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    controller = new PublisherController(publisherRepository as any);
    (paginate as jest.Mock).mockReset();
  });

  it("should only query publishers linked to non-deleted games", async () => {
    (paginate as jest.Mock).mockResolvedValue({
      data: [],
      meta: {},
      links: {},
    });

    await controller.getPublishers({} as PaginateQuery);

    expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
      "publisher.games",
      "games",
      "games.deleted_at IS NULL",
    );
    expect(queryBuilder.groupBy).toHaveBeenCalledWith("publisher.id");
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

    await controller.getPublishers({ sortBy: [] } as unknown as PaginateQuery);

    expect(queryBuilder.addSelect).toHaveBeenCalledWith(
      "COUNT(games.id)",
      "games_count",
    );
    expect(queryBuilder.orderBy).toHaveBeenCalledWith("games_count", "DESC");
  });
});
