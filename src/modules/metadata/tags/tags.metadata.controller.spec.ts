import { PaginateQuery, PaginationType, paginate } from "nestjs-paginate";
import { Repository } from "typeorm";

import { GamevaultGame } from "../../games/gamevault-game.entity";
import { TagMetadata } from "./tag.metadata.entity";
import { TagsController } from "./tags.metadata.controller";

jest.mock("nestjs-paginate", () => {
  const actual = jest.requireActual("nestjs-paginate");

  return {
    ...actual,
    paginate: jest.fn(),
  };
});

describe("TagsController", () => {
  let controller: TagsController;
  let tagRepository: jest.Mocked<Partial<Repository<TagMetadata>>>;
  let queryBuilder: any;

  beforeEach(() => {
    queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
    };

    tagRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    controller = new TagsController(tagRepository as any);
    (paginate as jest.Mock).mockReset();
  });

  it("should only query tags linked to non-deleted games", async () => {
    (paginate as jest.Mock).mockResolvedValue({
      data: [],
      meta: {},
      links: {},
    });

    await controller.getTags({} as PaginateQuery);

    expect(queryBuilder.innerJoin).toHaveBeenNthCalledWith(
      1,
      "tag.games",
      "games",
    );
    expect(queryBuilder.innerJoin).toHaveBeenNthCalledWith(
      2,
      GamevaultGame,
      "game",
      "game.metadata_id = games.id AND game.deleted_at IS NULL",
    );
    expect(queryBuilder.groupBy).toHaveBeenCalledWith("tag.id");
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

    await controller.getTags({ sortBy: [] } as unknown as PaginateQuery);

    expect(queryBuilder.addSelect).toHaveBeenCalledWith(
      "COUNT(DISTINCT game.id)",
      "games_count",
    );
    expect(queryBuilder.orderBy).toHaveBeenCalledWith("games_count", "DESC");
  });
});
