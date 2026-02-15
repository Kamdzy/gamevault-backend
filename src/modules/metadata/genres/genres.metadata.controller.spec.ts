import { PaginateQuery, PaginationType, paginate } from "nestjs-paginate";
import { Repository } from "typeorm";

import { GamevaultGame } from "../../games/gamevault-game.entity";
import { GenreMetadata } from "./genre.metadata.entity";
import { GenreController } from "./genres.metadata.controller";

jest.mock("nestjs-paginate", () => {
  const actual = jest.requireActual("nestjs-paginate");

  return {
    ...actual,
    paginate: jest.fn(),
  };
});

describe("GenreController", () => {
  let controller: GenreController;
  let genreRepository: jest.Mocked<Partial<Repository<GenreMetadata>>>;
  let queryBuilder: any;

  beforeEach(() => {
    queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
    };

    genreRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };

    controller = new GenreController(genreRepository as any);
    (paginate as jest.Mock).mockReset();
  });

  it("should only query genres linked to non-deleted games", async () => {
    (paginate as jest.Mock).mockResolvedValue({
      data: [],
      meta: {},
      links: {},
    });

    await controller.getGenres({} as PaginateQuery);

    expect(queryBuilder.innerJoin).toHaveBeenNthCalledWith(
      1,
      "genre.games",
      "games",
    );
    expect(queryBuilder.innerJoin).toHaveBeenNthCalledWith(
      2,
      GamevaultGame,
      "game",
      "game.metadata_id = games.id AND game.deleted_at IS NULL",
    );
    expect(queryBuilder.groupBy).toHaveBeenCalledWith("genre.id");
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

    await controller.getGenres({ sortBy: [] } as unknown as PaginateQuery);

    expect(queryBuilder.addSelect).toHaveBeenCalledWith(
      "COUNT(DISTINCT game.id)",
      "games_count",
    );
    expect(queryBuilder.orderBy).toHaveBeenCalledWith("games_count", "DESC");
  });
});
