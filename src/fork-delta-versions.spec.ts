/**
 * Fork contract test: saving a game must never delete its versions.
 *
 * GamevaultGame's @AfterLoad turns an unloaded `versions` relation into [].
 * The fork loads games with loadEagerRelations:false on its narrowed paths
 * (merge/map/unmap), so those entities carry an empty `versions` array that
 * says nothing about the database. TypeORM diffs it against the stored rows
 * on save, finds every version "removed", and - because game_version.game_id
 * is NOT NULL - turns its default nullify orphan action into a hard DELETE.
 *
 * Live, every metadata refresh wiped the game's version rows and the next
 * index re-inserted them: 109k deletes against ~7.5k rows on main. A file
 * renamed between those two steps left its game with no version and a stale
 * file_path, and the integrity check soft-deleted it (#1619 In Her Service).
 *
 * Uses a real DataSource on purpose: the bug lives in TypeORM's persistence
 * diff, which a mocked repository cannot exhibit.
 */
import "reflect-metadata";

import type { SchedulerRegistry } from "@nestjs/schedule";
import type { Response } from "express";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DataSource } from "typeorm";

import configuration from "./configuration.js";
import { FilesService } from "./modules/games/files.service.js";
import { GameVersion } from "./modules/games/game-version.entity.js";
import { GamesService } from "./modules/games/games.service.js";
import { GamevaultGame } from "./modules/games/gamevault-game.entity.js";
import { GameMetadata } from "./modules/metadata/games/game.metadata.entity.js";
import type { GameMetadataService } from "./modules/metadata/games/game.metadata.service.js";
import type { MetadataService } from "./modules/metadata/metadata.service.js";

/** Every entity class under src/modules, so the relation graph is complete. */
async function loadEntities(): Promise<Function[]> {
  const files = readdirSync(join(import.meta.dirname, "modules"), {
    recursive: true,
    encoding: "utf8",
  }).filter((file) => file.endsWith(".entity.ts"));
  const modules: Record<string, unknown>[] = await Promise.all(
    files.map(
      (file) =>
        import(pathToFileURL(join(import.meta.dirname, "modules", file)).href),
    ),
  );
  return modules.flatMap((module) =>
    Object.values(module).filter(
      (exported): exported is Function => typeof exported === "function",
    ),
  );
}

describe("Fork delta: saving a game keeps its versions", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const entities = await loadEntities();
    dataSource = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities,
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function createGameWithVersion(title: string) {
    const games = dataSource.getRepository(GamevaultGame);
    const versions = dataSource.getRepository(GameVersion);
    const game = await games.save(
      Object.assign(new GamevaultGame(), {
        title,
        file_path: `/files/${title} (W_P) (2020).zip`,
      }),
    );
    await versions.save(
      Object.assign(new GameVersion(), {
        game: { id: game.id } as GamevaultGame,
        file_path: `/files/${title} (W_P) (2020).zip`,
      }),
    );
    return game.id;
  }

  const versionCount = (gameId: number) =>
    dataSource
      .getRepository(GameVersion)
      .count({ where: { game: { id: gameId } }, withDeleted: true });

  it("does not delete versions when the game was loaded without them", async () => {
    const gameId = await createGameWithVersion("Narrow Load");
    const games = dataSource.getRepository(GamevaultGame);

    // The shape merge()/map()/unmap() load: metadata relations only.
    const game = await games.findOneOrFail({
      where: { id: gameId },
      relations: { provider_metadata: true },
      loadEagerRelations: false,
    });
    expect(game.versions).toEqual([]); // @AfterLoad, not the database

    await games.save(game);

    expect(await versionCount(gameId)).toBe(1);
  });

  it("does not delete a version added after the game was loaded", async () => {
    const gameId = await createGameWithVersion("Stale Entity");
    const games = dataSource.getRepository(GamevaultGame);
    const game = await games.findOneOrFail({ where: { id: gameId } });
    expect(game.versions).toHaveLength(1);

    // The indexer inserts a version while a merge holds the old entity.
    await dataSource.getRepository(GameVersion).save(
      Object.assign(new GameVersion(), {
        game: { id: gameId } as GamevaultGame,
        file_path: "/files/Stale Entity (v2) (W_P) (2020).zip",
      }),
    );

    await games.save(game);

    expect(await versionCount(gameId)).toBe(2);
  });

  // Same root, different relation: the fork's download() loads the game with
  // no relations, so @AfterLoad hands it provider_metadata = []. Saving that
  // entity to bump download_count unlinked every provider mapping. The queue
  // re-links a plain mapping on its next lap, but not a disabled-<gameId>
  // sentinel quarantine, which no search can ever find again.
  it("download() keeps the game's provider mappings", async () => {
    const gameId = await createGameWithVersion("Downloaded");
    const providerMetadata = await dataSource.getRepository(GameMetadata).save(
      Object.assign(new GameMetadata(), {
        provider_slug: "igdb",
        provider_data_id: `disabled-${gameId}`,
        provider_priority: -1,
      }),
    );
    await dataSource
      .getRepository(GamevaultGame)
      .save({ id: gameId, provider_metadata: [providerMetadata] });

    const directory = mkdtempSync(join(tmpdir(), "gv-download-"));
    const filePath = join(directory, "Downloaded (W_P) (2020).zip");
    writeFileSync(filePath, "zip");
    await dataSource
      .getRepository(GameVersion)
      .update({ game: { id: gameId } }, { file_path: filePath });

    const gamesService = new GamesService(
      dataSource.getRepository(GamevaultGame),
      dataSource.getRepository(GameVersion),
      undefined,
      undefined as unknown as GameMetadataService,
    );
    const filesService = new FilesService(
      gamesService,
      undefined as unknown as MetadataService,
      undefined as unknown as SchedulerRegistry,
      dataSource.getRepository(GameVersion),
    );
    // TESTING_MOCK_FILES returns before the save under test.
    const testing = configuration.TESTING as { MOCK_FILES: boolean };
    const mockFiles = testing.MOCK_FILES;
    testing.MOCK_FILES = false;
    try {
      const file = await filesService.download(
        { setHeader: () => undefined } as unknown as Response,
        gameId,
      );
      await new Promise<void>((resolve) => {
        const stream = file.getStream();
        stream.on("close", resolve);
        stream.resume();
      });
    } finally {
      testing.MOCK_FILES = mockFiles;
      rmSync(directory, { recursive: true, force: true });
    }

    const game = await dataSource.getRepository(GamevaultGame).findOneOrFail({
      where: { id: gameId },
      relations: { provider_metadata: true },
      loadEagerRelations: false,
    });
    expect(game.download_count).toBe(1);
    expect(game.provider_metadata?.map((m) => m.id)).toEqual([
      providerMetadata.id,
    ]);
  });
});
