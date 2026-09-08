/**
 * Fork contract tests — version-tag id hints.
 *
 * Guards the fork-only ability for a metadata provider to resolve a game by an
 * identifier embedded in its version tag instead of a fuzzy title search.
 * Upstream has no equivalent: `findMetadata()` there goes straight to
 * `getBestMatch()`. A `git merge upstream/master` that touches
 * `findMetadata()`, `resolveByHint()`, `extractHintSegments()` or the
 * `hintPatterns` / `decodeHint` members on the provider base class can revert
 * this silently — clean merge, passing build, feature gone.
 *
 * If a test here fails after an upstream merge, the merge reverted a fork
 * change — fix the merge, not the test.
 *
 * See CLAUDE.md → "Filename version-tag conventions".
 */

import type { Mock } from "vitest";
import configuration from "./configuration.js";
import { GamesService } from "./modules/games/games.service.js";
import { MetadataService } from "./modules/metadata/metadata.service.js";
import { MetadataProvider } from "./modules/metadata/providers/abstract.metadata-provider.service.js";

vi.mock("./configuration.js", () => ({
  __esModule: true,
  default: {
    METADATA: { TTL_IN_DAYS: 30 },
    GAMES: { WINDOWS_SETUP_DEFAULT_INSTALL_PARAMETERS: "" },
    TESTING: { MOCK_FILES: true },
    VOLUMES: { MEDIA: "/media" },
  },
}));

vi.mock("./logging.js", () => ({
  __esModule: true,
  default: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logGamevaultGame: vi.fn((g) => ({ id: g?.id })),
  logGamevaultUser: vi.fn(),
  logMedia: vi.fn(),
  logMetadata: vi.fn(),
  logMetadataProvider: vi.fn((p) => ({ slug: p?.slug })),
  logProgress: vi.fn(),
}));

vi.mock("class-validator", async () => ({
  ...(await vi.importActual("class-validator")),
  validateOrReject: vi.fn().mockResolvedValue(undefined),
}));

/**
 * A provider that resolves ids of the shape `ID<digits>`, encoded in version
 * tags as `xID<digits>` (a leading marker the convention adds and the decoder
 * must strip). Deliberately generic — the real prefixes live in the plugins.
 */
function makeHintProvider(overrides: Partial<MetadataProvider> = {}) {
  const provider = {
    slug: "test-provider",
    name: "Test Provider",
    priority: 10,
    enabled: true,
    request_interval_ms: 0,
    hintPatterns: [/x(ID\d{4,})/i],
    decodeHint: (raw: string) => raw.toUpperCase(),
    getBestMatch: vi.fn(),
    getByProviderDataIdOrFail: vi.fn(),
    search: vi.fn(),
    ...overrides,
  } as unknown as MetadataProvider;
  return provider;
}

function makeService(gamesService: Partial<GamesService>) {
  return new MetadataService(
    gamesService as GamesService,
    {
      save: vi.fn().mockImplementation((m) => Promise.resolve(m)),
      deleteByGameMetadataIdOrFail: vi.fn().mockResolvedValue(undefined),
    } as never,
    configuration as never,
  );
}

/** Invokes the private findMetadata() the way updateMetadata() does. */
async function callFindMetadata(
  service: MetadataService,
  game: unknown,
  provider: MetadataProvider,
) {
  await (
    service as unknown as {
      findMetadata: (g: unknown, p: MetadataProvider) => Promise<void>;
    }
  ).findMetadata(game, provider);
}

describe("fork: version-tag id hints", () => {
  let service: MetadataService;
  let mapSpy: Mock;

  beforeEach(() => {
    vi.restoreAllMocks();
    service = makeService({});
    // map() persists the resolved mapping; stub it so tests assert on the id
    // that was chosen rather than on database side effects.
    mapSpy = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { map: Mock }).map = mapSpy;
  });

  it("resolves by id from the version tag instead of a title search", async () => {
    const provider = makeHintProvider();
    (provider.getByProviderDataIdOrFail as Mock).mockResolvedValue({
      provider_data_id: "ID12345",
      title: "Some Game",
    });

    await callFindMetadata(
      service,
      { id: 1, title: "Some Game", version: "v1.2.0-xID12345" },
      provider,
    );

    expect(provider.getByProviderDataIdOrFail).toHaveBeenCalledWith("ID12345");
    expect(provider.getBestMatch).not.toHaveBeenCalled();
    expect(mapSpy).toHaveBeenCalledWith(1, "test-provider", "ID12345");
  });

  it("finds an id embedded in a decorated segment, not just a whole segment", async () => {
    // Real tags glue edition/DLC text onto the id — anchoring would miss these.
    const provider = makeHintProvider();
    (provider.getByProviderDataIdOrFail as Mock).mockResolvedValue({
      provider_data_id: "ID99887",
      title: "Some Game",
    });

    await callFindMetadata(
      service,
      { id: 2, title: "Some Game", version: "v1.0+BonusContentDLCxID99887" },
      provider,
    );

    expect(provider.getByProviderDataIdOrFail).toHaveBeenCalledWith("ID99887");
    expect(mapSpy).toHaveBeenCalledWith(2, "test-provider", "ID99887");
  });

  it("splits version segments on '+' as well as '-'", async () => {
    const provider = makeHintProvider();
    (provider.getByProviderDataIdOrFail as Mock).mockResolvedValue({
      provider_data_id: "ID5555",
      title: "Some Game",
    });

    await callFindMetadata(
      service,
      { id: 3, title: "Some Game", version: "v2.0+xID5555" },
      provider,
    );

    expect(provider.getByProviderDataIdOrFail).toHaveBeenCalledWith("ID5555");
  });

  it("applies decodeHint before looking the id up", async () => {
    const provider = makeHintProvider({
      hintPatterns: [/x(id\d{4,})/i],
      decodeHint: (raw: string) => `CANON-${raw.toUpperCase()}`,
    });
    (provider.getByProviderDataIdOrFail as Mock).mockResolvedValue({
      provider_data_id: "CANON-ID4242",
      title: "Some Game",
    });

    await callFindMetadata(
      service,
      { id: 4, title: "Some Game", version: "v1-xid4242" },
      provider,
    );

    expect(provider.getByProviderDataIdOrFail).toHaveBeenCalledWith(
      "CANON-ID4242",
    );
  });

  it("trusts a resolved hint even when its title looks unrelated", async () => {
    // The post-lookup similarity check was removed after live measurement:
    // in 48 real firings it caught 0 true poisons and made 1 false rejection
    // of a translated title. Character-bigram similarity cannot separate a
    // legitimate translation/transliteration pair (0.10-0.20) from a random
    // unrelated pair (0.15-0.25) — the distributions overlap.
    //
    // A wrong id in the filename still costs the user one manual re-map in
    // the client. The pipeline design keeps that correction sticky forever
    // (updateMetadata refreshes an existing mapping by its stored id and
    // never re-runs matching — see the branch guarded by the test in
    // "fork: hint fast-path never overrides an existing mapping").
    const provider = makeHintProvider();
    (provider.getByProviderDataIdOrFail as Mock).mockResolvedValue({
      provider_data_id: "ID00001",
      title: "Entirely Different Looking Title",
    });

    await callFindMetadata(
      service,
      { id: 5, title: "Some Game", version: "v1.0-xID00001" },
      provider,
    );

    expect(provider.getBestMatch).not.toHaveBeenCalled();
    expect(mapSpy).toHaveBeenCalledWith(5, "test-provider", "ID00001");
  });

  it("accepts a hint whose resolved title is in a different script", async () => {
    // The measured case that motivated dropping the guard: a transliterated
    // filename and an original-script catalogue title share almost no
    // characters. Trivially accepted now that there is no similarity check
    // to fail; kept as a regression guard against re-introducing one.
    const provider = makeHintProvider();
    (provider.getByProviderDataIdOrFail as Mock).mockResolvedValue({
      provider_data_id: "ID54321",
      title: "星のかけら 〜遠い記憶〜",
    });

    await callFindMetadata(
      service,
      {
        id: 20,
        title: "Hoshi no Kakera ~Tooi Kioku~",
        version: "v1.0-xID54321",
      },
      provider,
    );

    expect(provider.getByProviderDataIdOrFail).toHaveBeenCalledWith("ID54321");
    expect(provider.getBestMatch).not.toHaveBeenCalled();
    expect(mapSpy).toHaveBeenCalledWith(20, "test-provider", "ID54321");
  });

  it("falls back to title search when the id lookup throws", async () => {
    const provider = makeHintProvider();
    (provider.getByProviderDataIdOrFail as Mock).mockRejectedValue(
      new Error("404 not found"),
    );
    (provider.getBestMatch as Mock).mockResolvedValue({
      provider_data_id: "ID31337",
    });

    await callFindMetadata(
      service,
      { id: 6, title: "Some Game", version: "v1.0-xID12345" },
      provider,
    );

    expect(provider.getBestMatch).toHaveBeenCalled();
    expect(mapSpy).toHaveBeenCalledWith(6, "test-provider", "ID31337");
  });

  it("ignores version-tag noise that is not an id", async () => {
    // Version tags are full of non-identifier tokens. A provider whose pattern
    // claims those would produce confidently wrong matches.
    const provider = makeHintProvider();
    (provider.getBestMatch as Mock).mockResolvedValue({
      provider_data_id: "ID11111",
    });

    await callFindMetadata(
      service,
      {
        id: 7,
        title: "Some Game",
        version: "v1.2.3-vFinal-b998877-Repack-GOG",
      },
      provider,
    );

    expect(provider.getByProviderDataIdOrFail).not.toHaveBeenCalled();
    expect(provider.getBestMatch).toHaveBeenCalled();
  });

  it("uses title search for providers that declare no hintPatterns", async () => {
    const provider = makeHintProvider({ hintPatterns: undefined });
    (provider.getBestMatch as Mock).mockResolvedValue({
      provider_data_id: "ID22222",
    });

    await callFindMetadata(
      service,
      { id: 8, title: "Some Game", version: "v1.0-xID12345" },
      provider,
    );

    expect(provider.getByProviderDataIdOrFail).not.toHaveBeenCalled();
    expect(provider.getBestMatch).toHaveBeenCalled();
  });

  it("uses title search when the game has no version tag at all", async () => {
    const provider = makeHintProvider();
    (provider.getBestMatch as Mock).mockResolvedValue({
      provider_data_id: "ID33333",
    });

    await callFindMetadata(
      service,
      { id: 9, title: "Some Game", version: undefined },
      provider,
    );

    expect(provider.getByProviderDataIdOrFail).not.toHaveBeenCalled();
    expect(provider.getBestMatch).toHaveBeenCalled();
  });

  it("does not leak regex lastIndex between segments when a pattern is global", async () => {
    // A /g/ pattern reused across segments would skip matches via lastIndex.
    const provider = makeHintProvider({ hintPatterns: [/x(ID\d{4,})/gi] });
    (provider.getByProviderDataIdOrFail as Mock).mockResolvedValue({
      provider_data_id: "ID65432",
      title: "Some Game",
    });

    await callFindMetadata(
      service,
      { id: 10, title: "Some Game", version: "v1-noise-more-xID65432" },
      provider,
    );

    expect(provider.getByProviderDataIdOrFail).toHaveBeenCalledWith("ID65432");
  });
});

describe("fork: hint fast-path never overrides an existing mapping", () => {
  /**
   * The user-correction guarantee. A wrong first match is fixed in the client,
   * which writes a provider_metadata row. From then on updateMetadata() must
   * refresh by that stored id and never re-run matching — otherwise the next
   * TTL expiry would silently restore the wrong id from the filename, forever.
   *
   * This asserts the branch in updateMetadata(), not findMetadata(): an
   * existing mapping goes to map(existing.provider_data_id) and never reaches
   * findMetadata() at all.
   */
  it("refreshes by the stored id rather than re-matching when a mapping exists", async () => {
    // updateMetadata() ends in merge() once anything changed; merge reloads the
    // game with cascade-safe relations, so gamesService needs stubbing for the
    // call to complete. Irrelevant to the assertions below.
    const service = makeService({
      findOneByGameIdOrFail: vi
        .fn()
        .mockResolvedValue({ id: 11, provider_metadata: [], metadata: null }),
      save: vi.fn().mockImplementation((g) => Promise.resolve(g)),
    } as never);
    const mapSpy = vi.fn().mockResolvedValue(undefined);
    const findMetadataSpy = vi.fn().mockResolvedValue(undefined);
    (service as unknown as { map: Mock }).map = mapSpy;
    (service as unknown as { findMetadata: Mock }).findMetadata =
      findMetadataSpy;

    const provider = makeHintProvider();
    (service as unknown as { providers: MetadataProvider[] }).providers = [
      provider,
    ];

    // Mapping exists, but is older than the TTL so a refresh is due.
    const staleTimestamp = new Date(Date.now() - 999 * 24 * 60 * 60 * 1000);
    const game = {
      id: 11,
      title: "Some Game",
      // The version tag disagrees with the stored mapping — this is exactly
      // the case where a user corrected a bad hint-derived match.
      version: "v1.0-xID00001",
      versions: [],
      file_path: "/files/Some Game (v1.0-xID00001) (W_P) (2025).7z",
      provider_metadata: [
        {
          provider_slug: "test-provider",
          provider_data_id: "ID-USER-CORRECTED",
          updated_at: staleTimestamp,
          created_at: staleTimestamp,
        },
      ],
    };

    await (
      service as unknown as {
        updateMetadata: (g: unknown) => Promise<void>;
      }
    ).updateMetadata(game);

    // Refreshed by the user's id, and matching never ran.
    expect(mapSpy).toHaveBeenCalledWith(
      11,
      "test-provider",
      "ID-USER-CORRECTED",
    );
    expect(findMetadataSpy).not.toHaveBeenCalled();
    expect(provider.getByProviderDataIdOrFail).not.toHaveBeenCalled();
    expect(provider.getBestMatch).not.toHaveBeenCalled();
  });
});
