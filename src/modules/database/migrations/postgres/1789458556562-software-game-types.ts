import { MigrationInterface, type QueryRunner } from "typeorm";

/**
 * Adds WINDOWS_SOFTWARE and LINUX_SOFTWARE to the game type enum.
 *
 * Both values have existed in src/modules/games/models/game-type.enum.ts and
 * been detected from the `(W_SW)` / `(L_SW)` filename tags in files.service.ts
 * since upstream commit 32f78cb, but no migration ever added them to the
 * Postgres enum or the SQLite CHECK constraint. Indexing a file tagged either
 * way therefore fails at the database layer — the row simply cannot be
 * written. This closes that gap for fresh installs and existing databases
 * alike.
 *
 * Follows the project's established enum-change recipe (rename the old type,
 * create the new one, cast the column across, drop the old) rather than
 * `ALTER TYPE ... ADD VALUE`. The recipe runs inside the transaction TypeORM
 * wraps migrations in; ADD VALUE has historically not, and its newly added
 * label cannot be used until the transaction commits.
 *
 * Reference: 1701391165727-linux_portable_game_type.ts. Note the table and
 * type were named `game` / `game_type_enum` back then; they are now
 * `gamevault_game` / `gamevault_game_type_enum` (verified against the live
 * schema, not assumed).
 */
export class SoftwareGameTypes1789458556562 implements MigrationInterface {
  name = "SoftwareGameTypes1789458556562";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TYPE "public"."gamevault_game_type_enum"
            RENAME TO "gamevault_game_type_enum_old"
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."gamevault_game_type_enum" AS ENUM(
                'UNDETECTABLE',
                'WINDOWS_SETUP',
                'WINDOWS_PORTABLE',
                'WINDOWS_SOFTWARE',
                'LINUX_PORTABLE',
                'LINUX_SOFTWARE'
            )
        `);
    await queryRunner.query(`
            ALTER TABLE "gamevault_game"
            ALTER COLUMN "type" DROP DEFAULT
        `);
    await queryRunner.query(`
            ALTER TABLE "gamevault_game"
            ALTER COLUMN "type" TYPE "public"."gamevault_game_type_enum" USING "type"::"text"::"public"."gamevault_game_type_enum"
        `);
    await queryRunner.query(`
            ALTER TABLE "gamevault_game"
            ALTER COLUMN "type"
            SET DEFAULT 'UNDETECTABLE'
        `);
    await queryRunner.query(`
            DROP TYPE "public"."gamevault_game_type_enum_old"
        `);
  }

  /**
   * Reverting is lossy by nature: any row that has since been written as
   * WINDOWS_SOFTWARE or LINUX_SOFTWARE cannot be cast back into an enum that
   * lacks those labels. Such rows are reset to UNDETECTABLE first so the cast
   * succeeds, rather than letting the migration fail halfway.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            UPDATE "gamevault_game"
            SET "type" = 'UNDETECTABLE'
            WHERE "type" IN ('WINDOWS_SOFTWARE', 'LINUX_SOFTWARE')
        `);
    await queryRunner.query(`
            CREATE TYPE "public"."gamevault_game_type_enum_old" AS ENUM(
                'UNDETECTABLE',
                'WINDOWS_SETUP',
                'WINDOWS_PORTABLE',
                'LINUX_PORTABLE'
            )
        `);
    await queryRunner.query(`
            ALTER TABLE "gamevault_game"
            ALTER COLUMN "type" DROP DEFAULT
        `);
    await queryRunner.query(`
            ALTER TABLE "gamevault_game"
            ALTER COLUMN "type" TYPE "public"."gamevault_game_type_enum_old" USING "type"::"text"::"public"."gamevault_game_type_enum_old"
        `);
    await queryRunner.query(`
            ALTER TABLE "gamevault_game"
            ALTER COLUMN "type"
            SET DEFAULT 'UNDETECTABLE'
        `);
    await queryRunner.query(`
            DROP TYPE "public"."gamevault_game_type_enum"
        `);
    await queryRunner.query(`
            ALTER TYPE "public"."gamevault_game_type_enum_old"
            RENAME TO "gamevault_game_type_enum"
        `);
  }
}
