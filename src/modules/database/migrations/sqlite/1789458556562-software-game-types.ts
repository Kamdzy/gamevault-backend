import { MigrationInterface, type QueryRunner } from "typeorm";

/**
 * SQLite half of the SOFTWARE game types. See the Postgres migration of the
 * same name for why this gap existed.
 *
 * SQLite has no enum type — the column is a `varchar` with a CHECK constraint,
 * and a CHECK cannot be altered in place. So the table is rebuilt: drop
 * indices, copy into a temporary table carrying the widened CHECK, drop the
 * original, rename, recreate indices. This mirrors the recipe the v13-final
 * migration already uses for this exact table.
 *
 * The column list below is the table's current shape, taken from the LAST
 * `gamevault_game` rebuild in 1728421385000-v13-final.ts — the one that
 * introduced AUTOINCREMENT and the two game_metadata foreign keys. The newer
 * SQLite migrations (installer-param, game-versions) touch the junction table
 * and game_version, never gamevault_game itself, so that definition is still
 * authoritative.
 *
 * Unlike v13-final's own copy step, `sort_title` is included here. It was
 * omitted there — harmless at the time because the column was new and empty —
 * but it carries data now, and leaving it out would silently null every
 * game's sort title.
 */
export class SoftwareGameTypes1789458556562 implements MigrationInterface {
  name = "SoftwareGameTypes1789458556562";

  private static readonly COLUMNS = `
                    "id",
                    "created_at",
                    "updated_at",
                    "deleted_at",
                    "entity_version",
                    "file_path",
                    "size",
                    "title",
                    "sort_title",
                    "version",
                    "release_date",
                    "early_access",
                    "download_count",
                    "type",
                    "user_metadata_id",
                    "metadata_id"`;

  private static table(check: string): string {
    return `
            CREATE TABLE "temporary_gamevault_game" (
                "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
                "created_at" datetime NOT NULL DEFAULT (datetime('now')),
                "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
                "deleted_at" datetime,
                "entity_version" integer NOT NULL,
                "file_path" varchar NOT NULL,
                "size" bigint NOT NULL DEFAULT (0),
                "title" varchar,
                "sort_title" varchar,
                "version" varchar,
                "release_date" datetime,
                "early_access" boolean NOT NULL DEFAULT (0),
                "download_count" integer NOT NULL DEFAULT (0),
                "type" varchar CHECK("type" IN (${check})) NOT NULL DEFAULT ('UNDETECTABLE'),
                "user_metadata_id" integer,
                "metadata_id" integer,
                CONSTRAINT "UQ_91d454956bd20f46b646b05b91f" UNIQUE ("file_path"),
                CONSTRAINT "REL_edc9b16a9e16d394b2ca3b49b1" UNIQUE ("user_metadata_id"),
                CONSTRAINT "REL_aab0797ae3873a5ef2817d0989" UNIQUE ("metadata_id"),
                CONSTRAINT "FK_edc9b16a9e16d394b2ca3b49b12" FOREIGN KEY ("user_metadata_id") REFERENCES "game_metadata" ("id") ON DELETE
                SET NULL ON UPDATE NO ACTION,
                    CONSTRAINT "FK_aab0797ae3873a5ef2817d09891" FOREIGN KEY ("metadata_id") REFERENCES "game_metadata" ("id") ON DELETE
                SET NULL ON UPDATE NO ACTION
            )
        `;
  }

  private static async rebuild(
    queryRunner: QueryRunner,
    check: string,
  ): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_dc16bc448f2591a832533f25d9"`);
    await queryRunner.query(`DROP INDEX "IDX_91d454956bd20f46b646b05b91"`);
    await queryRunner.query(`DROP INDEX "IDX_73e99cf1379987ed7c5983d74f"`);

    await queryRunner.query(SoftwareGameTypes1789458556562.table(check));

    await queryRunner.query(`
            INSERT INTO "temporary_gamevault_game"(${SoftwareGameTypes1789458556562.COLUMNS}
                )
            SELECT ${SoftwareGameTypes1789458556562.COLUMNS}
            FROM "gamevault_game"
        `);

    await queryRunner.query(`DROP TABLE "gamevault_game"`);
    await queryRunner.query(`
            ALTER TABLE "temporary_gamevault_game"
                RENAME TO "gamevault_game"
        `);

    await queryRunner.query(
      `CREATE INDEX "IDX_dc16bc448f2591a832533f25d9" ON "gamevault_game" ("id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_91d454956bd20f46b646b05b91" ON "gamevault_game" ("file_path")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_73e99cf1379987ed7c5983d74f" ON "gamevault_game" ("release_date")`,
    );
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await SoftwareGameTypes1789458556562.rebuild(
      queryRunner,
      `'UNDETECTABLE', 'WINDOWS_SETUP', 'WINDOWS_PORTABLE', 'WINDOWS_SOFTWARE', 'LINUX_PORTABLE', 'LINUX_SOFTWARE'`,
    );
  }

  /**
   * Lossy in the same way as the Postgres half: rows written with either new
   * type would violate the narrowed CHECK, so they are reset to UNDETECTABLE
   * before the rebuild rather than failing it.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            UPDATE "gamevault_game"
            SET "type" = 'UNDETECTABLE'
            WHERE "type" IN ('WINDOWS_SOFTWARE', 'LINUX_SOFTWARE')
        `);
    await SoftwareGameTypes1789458556562.rebuild(
      queryRunner,
      `'UNDETECTABLE', 'WINDOWS_SETUP', 'WINDOWS_PORTABLE', 'LINUX_PORTABLE'`,
    );
  }
}
