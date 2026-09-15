import { ApiProperty } from "@nestjs/swagger";
import { Column, Entity, Index } from "typeorm";

import { DatabaseEntity } from "../../database/database.entity.js";

/**
 * Fork-only. One row per (game, provider) pair whose search found nothing.
 *
 * A search that SUCCEEDS writes a game_metadata row, and the TTL check in
 * MetadataService.updateMetadata() then skips that pair until the row goes
 * stale. A search that FAILS wrote nothing, so it could never be skipped — the
 * identical doomed search re-ran every lap, paying the provider's
 * request_interval_ms each time. Measured live: 935 searches an hour, 935 of
 * them misses, and a full lap taking ~18 h against an index that refilled the
 * queue every 60 minutes, so no lap ever finished.
 *
 * This table is that missing timestamp. It is a cache, not a fact about the
 * world: deleting every row is safe and simply costs one expensive lap.
 *
 * IMPORTANT — what may and may not be recorded here.
 * Only a NotFoundException from a completed search belongs in this table. A
 * provider that could not be reached (expired cookie, Cloudflare block,
 * timeout, rate limit) must throw, so the caller skips it and writes nothing.
 * Four of the five plugins used to convert those failures into an empty result
 * set, which getBestMatch() turns into the very same NotFoundException; that
 * was fixed plugin-side before this table existed, and it is the invariant
 * this whole mechanism rests on. Get it wrong and one expired F95Zone cookie
 * writes thousands of durable false negatives in a single lap.
 *
 * There is deliberately no foreign key to gamevault_game. Rows for deleted
 * games are inert (nothing looks them up) and a cascade would be one more way
 * for a cache to interfere with real data.
 */
@Entity()
@Index("UQ_METADATA_SEARCH_MISS", ["game_id", "provider_slug"], {
  unique: true,
})
export class MetadataSearchMiss extends DatabaseEntity {
  @Column()
  @Index()
  @ApiProperty({
    description: "id of the game whose search found nothing",
    example: 7406,
  })
  game_id!: number;

  @Column()
  @Index()
  @ApiProperty({
    description: "slug of the provider that had no match",
    example: "dlsite",
  })
  provider_slug!: string;

  /**
   * The game's identity as the matcher sees it: `title|version`.
   *
   * Title and version are the only inputs a search has — getBestMatch()
   * matches on the title and resolveByHint() reads ids out of the version tag
   * — so if neither changed, re-running the search cannot produce a different
   * answer. If either DID change, this miss answered a different question and
   * is discarded. That is what makes renaming a file to add an id hint take
   * effect on the next lap, instead of being suppressed by the very cache that
   * exists to stop wasted work.
   */
  @Column()
  @ApiProperty({
    description: "title|version of the game when the search came back empty",
    example: "Example Game ~subtitle~|1.0-RJ01000003",
  })
  signature!: string;
}
