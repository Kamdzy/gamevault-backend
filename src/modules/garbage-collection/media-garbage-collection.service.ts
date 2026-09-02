import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { isUUID } from "class-validator";
import fsExtra from "fs-extra";
import lodash from "lodash";
import { join } from "path";
import { Repository } from "typeorm";
import configuration from "../../configuration.js";
import { Media } from "../media/media.entity.js";
import { MediaService } from "../media/media.service.js";
import { GameMetadata } from "../metadata/games/game.metadata.entity.js";
import { GamevaultUser } from "../users/gamevault-user.entity.js";
const { readdir, remove } = fsExtra;

const { uniq } = lodash;

@Injectable()
export class MediaGarbageCollectionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    @InjectRepository(Media)
    private readonly mediaRepository: Repository<Media>,
    @InjectRepository(GameMetadata)
    private readonly gameMetadataRepository: Repository<GameMetadata>,
    @InjectRepository(GamevaultUser)
    private readonly userRepository: Repository<GamevaultUser>,
    private readonly mediaService: MediaService,
  ) {}

  onApplicationBootstrap() {
    this.garbageCollectUnusedMedia();
  }

  /**
   * Garbage collects unused medias.
   *
   * This function checks if media garbage collection is disabled before
   * proceeding. It retrieves all media from the media repository and collects
   * the paths of used media dynamically. Then, it removes unused media from
   * the database and cleans up the file system. Finally, it logs the number of
   * deleted media from the database and file system.
   */
  @Cron(`*/${configuration.MEDIA.GC_INTERVAL_IN_MINUTES} * * * *`)
  async garbageCollectUnusedMedia() {
    // Check if media garbage collection is disabled
    if (configuration.MEDIA.GC_DISABLED) {
      // Log warning and skip garbage collection
      this.logger.warn({
        message: "Skipping media garbage collection.",
        reason: "MEDIA_GC_DISABLED is set to true.",
      });
      return;
    }

    try {
      // Retrieve all media from the media repository
      const allMedia = await this.mediaRepository.find();

      // Collect paths of used media dynamically
      const usedMediaPaths = await this.collectUsedMediaPaths();

      // Remove unused media from the database
      const dbRemovedCount = await this.removeUnusedMediaFromDB(
        allMedia,
        usedMediaPaths,
      );
      if (dbRemovedCount) {
        this.logger.log(
          `Deleted ${dbRemovedCount} unused media entities from the database.`,
        );
      }

      // Clean up the file system
      const fsRemovedCount =
        await this.removeUnusedMediaFromFileSystem(usedMediaPaths);
      if (fsRemovedCount) {
        this.logger.log(
          `Deleted ${fsRemovedCount} unused media files from ${configuration.VOLUMES.MEDIA}.`,
        );
      }
    } catch (error) {
      this.logger.error({
        message: "Error garbage collecting unused media.",
        error,
      });
    }
  }

  /**
   * Collects paths of used media dynamically.
   *
   * @returns An array of media paths that are currently being used.
   */
  private async collectUsedMediaPaths(): Promise<string[]> {
    /**
     * The entities and properties that are checked for media usage.
     * Each element in the array is an object with a `repository` property and a
     * `properties` property. The `repository` property is the TypeORM repository
     * instance for the entity. The `relations` property is an array of strings
     * representing the relations of the entity that may contain media.
     */
    const entityMediaProperties = [
      {
        repository: this.userRepository,
        relations: ["background", "avatar"],
      },
      {
        repository: this.gameMetadataRepository,
        relations: ["background", "cover"],
      },
    ];

    const mediaPaths: string[] = [];

    /**
     * Fork: project the file paths directly instead of hydrating entities.
     *
     * Upstream calls repository.find({ relations, relationLoadStrategy:"query" })
     * and then walks the resulting entity graph. The GC only ever reads
     * media.file_path off those relations, but that call materialises every
     * column of every row into a class instance and resolves each relation with
     * an in-memory join.
     *
     * Measured on the live server: `SELECT * FROM game_metadata` (18,943 rows,
     * 54 MB) returns in 275ms, yet the find() call took ~488 SECONDS. The cost
     * is entirely TypeORM hydration on the main event loop, and it stalled all
     * HTTP traffic for ~8-11 minutes every hour, on the hour. The equivalent
     * projection below returns the same paths in ~76ms.
     *
     * leftJoin + addSelect + getRawMany keeps TypeORM's relation metadata (no
     * hardcoded join columns) while skipping entity construction entirely.
     */
    for (const { repository, relations } of entityMediaProperties) {
      const alias = "entity";
      const query = repository
        .createQueryBuilder(alias)
        .withDeleted()
        .select([]);

      for (const relation of relations) {
        query
          .leftJoin(`${alias}.${relation}`, relation)
          .addSelect(`${relation}.file_path`, `${relation}_file_path`);
      }

      const rows = await query.getRawMany<Record<string, string | null>>();

      let found = 0;
      for (const row of rows) {
        for (const relation of relations) {
          const filePath = row[`${relation}_file_path`];
          if (filePath) {
            mediaPaths.push(filePath);
            found++;
          }
        }
      }

      this.logger.debug({
        message: "Collected media references from entities.",
        entity: repository.metadata.name,
        row_count: rows.length,
        media_paths_found: found,
      });
    }
    return mediaPaths;
  }

  /**
   * Removes unused media from the database.
   *
   * @param allMedia - An array of all media in the database.
   * @param usedMediaPaths - A set of media paths that are currently being used.
   * @returns The number of media deleted.
   */
  private async removeUnusedMediaFromDB(
    allMedia: Media[],
    usedMediaPaths: string[],
  ): Promise<number> {
    const uniqueAllMedia = uniq(allMedia);
    const uniqueUsedMediaPaths = uniq(usedMediaPaths);
    this.logger.log({
      message: "Calculated difference of all media paths and used media paths.",
      all_count: uniqueAllMedia.length,
      used_count: uniqueUsedMediaPaths.length,
      delta: uniqueAllMedia.length - uniqueUsedMediaPaths.length,
    });

    // Fork: Set lookup, not Array.includes. This filter runs once per media
    // row against the whole used-path list, so `includes` makes it O(n*m) —
    // at ~24k rows that is ~580 million string comparisons on the event loop,
    // which blocked all HTTP traffic for ~13 minutes on the first run after
    // the isUUID fix made this sweep functional. A Set makes it O(n).
    const usedMediaPathSet = new Set(uniqueUsedMediaPaths);
    const uniqueUnusedMedia = uniq(
      uniqueAllMedia.filter(
        (media) => !usedMediaPathSet.has(media.file_path ?? ""),
      ),
    );

    // Create an array of promises to delete the unused media
    const deletePromises = uniqueUnusedMedia.map((media) =>
      this.mediaService.delete(media),
    );

    // Wait for all the delete promises to resolve
    await Promise.all(deletePromises);

    // Return the number of media deleted
    return deletePromises.length;
  }

  /**
   * Cleans up the file system by removing unused files.
   *
   * @param usedMediaPaths - A Set of paths to used media files.
   * @returns The number of files removed.
   */
  private async removeUnusedMediaFromFileSystem(
    usedMediaPaths: string[],
  ): Promise<number> {
    // Skip garbage collection if TESTING_MOCK_FILES is true
    if (configuration.TESTING.MOCK_FILES) {
      this.logger.warn({
        message: "Skipping media garbage collection.",
        reason: "TESTING_MOCK_FILES is true.",
      });
      return 0;
    }

    // Get a list of all media files in the directory
    const allMediaFilePaths = (
      await readdir(configuration.VOLUMES.MEDIA, {
        encoding: "utf8",
        withFileTypes: true,
        recursive: false,
      })
    )
      // Fork: two changes to the line below.
      //
      // 1. substring(0, 36), not 35. A v4 UUID is 36 characters (8-4-4-4-12
      //    plus four hyphens). Upstream's 35 truncates the final hex digit, so
      //    isUUID() rejected EVERY file and this sweep silently deleted nothing
      //    since it was introduced. Verified against the live media volume:
      //    0/24097 files passed the old filter, 24096/24097 pass this one.
      //
      // 2. join against configuration.VOLUMES.MEDIA rather than file.parentPath.
      //    readdir above is non-recursive, so parentPath is by construction the
      //    directory we just passed in — reconstructing from the constant is the
      //    direct expression and keeps this delete path off the Dirent path API,
      //    which already broke once when Node replaced `.path` with `.parentPath`.
      .filter((file) => file.isFile() && isUUID(file.name.substring(0, 36), 4))
      .map((file) => join(configuration.VOLUMES.MEDIA, file.name));

    let removedCount = 0;

    // Fork: same O(n*m) -> O(n) fix as in removeUnusedMediaFromDB. The comment
    // below already called usedMediaPaths a "set"; it was an Array, and the
    // per-file `includes` scan is what stalled the event loop.
    const usedMediaPathSet = new Set(usedMediaPaths);

    // Create an array of unlink promises for each file
    const unlinkPromises = allMediaFilePaths.map((path) => {
      // If the file path is not in the usedMediaPaths set, delete the file
      if (!usedMediaPathSet.has(path)) {
        return remove(path)
          .then(() => {
            this.logger.debug({
              message: "Garbage collected unused media.",
              path,
            });
            removedCount++;
          })
          .catch((error) => {
            this.logger.error({
              message: "Error garbage collecting unused media.",
              path,
              error,
            });
          });
      }

      return Promise.resolve();
    });

    // Wait for all unlink promises to resolve
    await Promise.all(unlinkPromises);

    return removedCount;
  }
}
