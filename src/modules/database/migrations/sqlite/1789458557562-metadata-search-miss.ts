import { MigrationInterface, type QueryRunner } from "typeorm";

/**
 * SQLite half of the fork-only search-miss cache. See the Postgres migration of
 * the same name for what the table is for and, more importantly, for the
 * reasoning behind the backfill - every schema change in this project needs a
 * hand-written pair.
 *
 * Purely additive, so none of the table-rebuild dance SQLite normally forces is
 * needed here.
 */
export class MetadataSearchMiss1789458557562 implements MigrationInterface {
  name = "MetadataSearchMiss1789458557562";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "metadata_search_miss" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "created_at" datetime NOT NULL DEFAULT (datetime('now')),
        "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
        "deleted_at" datetime,
        "entity_version" integer NOT NULL DEFAULT (1),
        "game_id" integer NOT NULL,
        "provider_slug" varchar NOT NULL,
        "signature" varchar NOT NULL,
        CONSTRAINT "UQ_METADATA_SEARCH_MISS" UNIQUE ("game_id", "provider_slug")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_metadata_search_miss_game_id"
        ON "metadata_search_miss" ("game_id");
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_metadata_search_miss_provider_slug"
        ON "metadata_search_miss" ("provider_slug");
    `);

    // Same backfill as the Postgres half, in SQLite dialect: INSERT OR IGNORE
    // rather than ON CONFLICT, and datetime() rather than interval arithmetic.
    await queryRunner.query(`
      INSERT OR IGNORE INTO "metadata_search_miss" ("game_id", "provider_slug", "signature")
      SELECT g."id",
             p."provider_slug",
             COALESCE(g."title", '') || '|' || COALESCE(g."version", '')
      FROM "gamevault_game" g
      CROSS JOIN (
        SELECT pm."provider_slug"
        FROM "game_metadata" pm
        JOIN "gamevault_game_provider_metadata_game_metadata" j
             ON j."game_metadata_id" = pm."id"
        JOIN "gamevault_game" lg
             ON lg."id" = j."gamevault_game_id" AND lg."deleted_at" IS NULL
        WHERE pm."provider_slug" IS NOT NULL
        GROUP BY pm."provider_slug"
        HAVING COUNT(DISTINCT j."gamevault_game_id") >=
               0.05 * (SELECT COUNT(*) FROM "gamevault_game" WHERE "deleted_at" IS NULL)
      ) p
      WHERE g."deleted_at" IS NULL
        AND g."created_at" < datetime('now', '-7 days')
        AND NOT EXISTS (
          SELECT 1
          FROM "gamevault_game_provider_metadata_game_metadata" j2
          JOIN "game_metadata" pm2 ON pm2."id" = j2."game_metadata_id"
          WHERE j2."gamevault_game_id" = g."id"
            AND pm2."provider_slug" = p."provider_slug"
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_metadata_search_miss_provider_slug";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_metadata_search_miss_game_id";
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS "metadata_search_miss";
    `);
  }
}
