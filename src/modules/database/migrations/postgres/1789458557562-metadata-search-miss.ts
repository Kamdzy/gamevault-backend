import { MigrationInterface, type QueryRunner } from "typeorm";

/**
 * Fork-only. Durable memory of "this provider searched for this game and found
 * nothing", so the metadata TTL skip can finally cover a pair that has never
 * matched.
 *
 * A search that SUCCEEDS writes a game_metadata row and is then skipped for
 * METADATA_TTL_IN_DAYS. A search that FAILS wrote nothing, so it could never be
 * skipped and re-ran every lap forever, paying the provider's
 * request_interval_ms each time. Measured live 2026-09-14: 935 searches in an
 * hour, 935 of them misses, 46% of the queue's wall clock asleep, and a lap
 * taking ~18 h against an index that refills the queue every 60 minutes - so no
 * lap ever finished and a newly indexed game waited most of a day.
 *
 * The table is a cache, not a fact about the world. Deleting every row is safe
 * and costs exactly one slow lap.
 *
 * -------------------------------------------------------------------------
 * The backfill below is the reason this migration is worth reviewing.
 * -------------------------------------------------------------------------
 *
 * Without it the cache starts empty and has to re-derive ~17,000 misses at
 * ~935/hour - one more full-price lap, and another after every restart until
 * the table fills. But that knowledge is already in the database: the metadata
 * queue is FIFO with constant refill, so it has been round-robining every game
 * past every provider for months. A pair with no game_metadata row has been
 * searched many times and failed every time.
 *
 * Two guards keep that inference honest:
 *
 *   1. Only games older than 7 days. A game added yesterday may simply not
 *      have reached the front of the queue yet, and seeding it would suppress
 *      its FIRST genuine search for the full TTL.
 *   2. Only providers that demonstrably work, defined as holding rows for at
 *      least 5% of live games. Measured live, the six real providers sit
 *      between 11% and 80% while the retired rawg-legacy sits at 0.6%, so this
 *      admits the former and excludes the latter. A provider that is broken or
 *      newly added never reaches 5% and is left to search normally.
 *
 * A wrong seed costs one pair one TTL of not searching - for a pair that has
 * been failing for months anyway. Drop the second query if you would rather
 * pay the slow lap; the table works identically either way.
 */
export class MetadataSearchMiss1789458557562 implements MigrationInterface {
  name = "MetadataSearchMiss1789458557562";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS metadata_search_miss (
        id SERIAL NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now(),
        deleted_at TIMESTAMP,
        entity_version integer NOT NULL DEFAULT 1,
        game_id integer NOT NULL,
        provider_slug character varying NOT NULL,
        signature character varying NOT NULL,
        CONSTRAINT PK_metadata_search_miss_id PRIMARY KEY (id),
        CONSTRAINT UQ_METADATA_SEARCH_MISS UNIQUE (game_id, provider_slug)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_metadata_search_miss_game_id
        ON metadata_search_miss (game_id);
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_metadata_search_miss_provider_slug
        ON metadata_search_miss (provider_slug);
    `);

    // Backfill. The signature is built from the same two columns the runtime
    // uses (title|version), so a later rename invalidates a seeded row exactly
    // as it invalidates a recorded one.
    await queryRunner.query(`
      INSERT INTO metadata_search_miss (game_id, provider_slug, signature)
      SELECT g.id,
             p.provider_slug,
             COALESCE(g.title, '') || '|' || COALESCE(g.version, '')
      FROM gamevault_game g
      CROSS JOIN (
        SELECT pm.provider_slug
        FROM game_metadata pm
        JOIN gamevault_game_provider_metadata_game_metadata j
             ON j.game_metadata_id = pm.id
        JOIN gamevault_game lg
             ON lg.id = j.gamevault_game_id AND lg.deleted_at IS NULL
        WHERE pm.provider_slug IS NOT NULL
        GROUP BY pm.provider_slug
        HAVING COUNT(DISTINCT j.gamevault_game_id) >=
               0.05 * (SELECT COUNT(*) FROM gamevault_game WHERE deleted_at IS NULL)
      ) p
      WHERE g.deleted_at IS NULL
        AND g.created_at < now() - interval '7 days'
        AND NOT EXISTS (
          SELECT 1
          FROM gamevault_game_provider_metadata_game_metadata j2
          JOIN game_metadata pm2 ON pm2.id = j2.game_metadata_id
          WHERE j2.gamevault_game_id = g.id
            AND pm2.provider_slug = p.provider_slug
        )
      ON CONFLICT (game_id, provider_slug) DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS IDX_metadata_search_miss_provider_slug;
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS IDX_metadata_search_miss_game_id;
    `);

    await queryRunner.query(`
      DROP TABLE IF EXISTS metadata_search_miss;
    `);
  }
}
