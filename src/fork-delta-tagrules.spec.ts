/**
 * Fork contract tests — operator-editable tag block/alias rules.
 *
 * These guard a fork-only feature that does not exist upstream at all, so an
 * upstream merge cannot "revert" it the way it can revert a changed line. What
 * it CAN do is move the merge code these hooks live in — the rules are applied
 * inside applyProviderMetadata()'s relation union, which upstream has already
 * refactored once (f8f4467). If that method is rewritten, the resolveTagName()
 * call is the thing to re-apply.
 *
 * See CLAUDE.md → "Preserving the Fork Across Upstream Merges".
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import configuration from "./configuration.js";
import { MetadataService } from "./modules/metadata/metadata.service.js";
import { MetadataProvider } from "./modules/metadata/providers/abstract.metadata-provider.service.js";
import {
  getTagRules,
  resetTagRulesCache,
  resolveTagName,
} from "./modules/metadata/tag-rules.js";

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

let dir: string;

function writeBlock(...lines: string[]) {
  writeFileSync(join(dir, "tag-block.txt"), lines.join("\n"), "utf-8");
}
function writeAliases(...lines: string[]) {
  writeFileSync(join(dir, "tag-aliases.tsv"), lines.join("\n"), "utf-8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gv-tagrules-"));
  resetTagRulesCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetTagRulesCache();
  vi.restoreAllMocks();
});

describe("Fork delta: tag rules loader", () => {
  it("is a no-op when the directory has no rule files", () => {
    const rules = getTagRules(dir);
    expect(rules.empty).toBe(true);
    expect(resolveTagName("Anything", rules)).toBe("Anything");
  });

  it("is a no-op when no directory is configured at all", () => {
    const rules = getTagRules(undefined);
    expect(rules.empty).toBe(true);
    expect(resolveTagName("Anything", rules)).toBe("Anything");
  });

  it("blocks exact names case-insensitively", () => {
    writeBlock("Steam Cloud", "旧作");
    const rules = getTagRules(dir);
    expect(resolveTagName("Steam Cloud", rules)).toBeNull();
    expect(resolveTagName("steam cloud", rules)).toBeNull();
    expect(resolveTagName("旧作", rules)).toBeNull();
    expect(resolveTagName("Action", rules)).toBe("Action");
  });

  it("blocks by regex only on lines prefixed with re:", () => {
    writeBlock("re:^steam ", "re: controller support$");
    const rules = getTagRules(dir);
    expect(resolveTagName("Steam Achievements", rules)).toBeNull();
    expect(resolveTagName("Full controller support", rules)).toBeNull();
    // A literal line is NOT treated as a pattern.
    expect(resolveTagName("steamy romance", rules)).toBe("steamy romance");
  });

  it("ignores comments and blank lines", () => {
    writeBlock("# a comment", "", "   ", "Steam Cloud");
    const rules = getTagRules(dir);
    expect(rules.blockExact.size).toBe(1);
    expect(resolveTagName("Steam Cloud", rules)).toBeNull();
  });

  it("ignores an invalid regex instead of throwing", () => {
    writeBlock("re:[unclosed", "Steam Cloud");
    const rules = getTagRules(dir);
    expect(rules.blockPatterns).toHaveLength(0);
    expect(resolveTagName("Steam Cloud", rules)).toBeNull();
  });

  it("rewrites aliased variants to the canonical name", () => {
    writeAliases("ADV\tAdventure", "巨乳\tbig tits");
    const rules = getTagRules(dir);
    expect(resolveTagName("ADV", rules)).toBe("Adventure");
    expect(resolveTagName("adv", rules)).toBe("Adventure");
    expect(resolveTagName("巨乳", rules)).toBe("big tits");
    expect(resolveTagName("Adventure", rules)).toBe("Adventure");
  });

  /**
   * Order is block(original) -> alias -> block(canonical): blocking a
   * canonical must also drop everything aliased into it, otherwise a blocked
   * tag sneaks back in through its variants.
   */
  it("drops a variant whose canonical is blocked", () => {
    writeBlock("Adventure");
    writeAliases("ADV\tAdventure");
    const rules = getTagRules(dir);
    expect(resolveTagName("ADV", rules)).toBeNull();
    expect(resolveTagName("Adventure", rules)).toBeNull();
  });

  it("can drop a single variant without dropping its canonical", () => {
    writeBlock("ADV");
    writeAliases("ADV\tAdventure");
    const rules = getTagRules(dir);
    expect(resolveTagName("ADV", rules)).toBeNull();
    expect(resolveTagName("Adventure", rules)).toBe("Adventure");
  });

  it("re-reads when a file changes, without a restart", () => {
    writeBlock("Action");
    expect(resolveTagName("Action", getTagRules(dir))).toBeNull();

    // mtimeMs can be coarse; change the size so the signature definitely moves.
    writeBlock("# Action no longer blocked", "Steam Cloud");
    expect(resolveTagName("Action", getTagRules(dir))).toBe("Action");
    expect(resolveTagName("Steam Cloud", getTagRules(dir))).toBeNull();
  });

  it("skips malformed alias lines rather than failing the load", () => {
    writeAliases("no-tab-here", "\tmissing variant", "ADV\t", "VN\tVisual Novel");
    const rules = getTagRules(dir);
    expect(rules.aliases.size).toBe(1);
    expect(resolveTagName("VN", rules)).toBe("Visual Novel");
  });
});

describe("Fork delta: tag rules applied during merge", () => {
  let service: MetadataService;

  const createProvider = (slug: string, priority: number): MetadataProvider =>
    ({
      slug,
      name: slug,
      priority,
      enabled: true,
      request_interval_ms: 0,
      search: vi.fn(),
      getByProviderDataIdOrFail: vi.fn(),
      getBestMatch: vi.fn(),
      register: vi.fn(),
    }) as unknown as MetadataProvider;

  const apply = (providerMetadata: any[]): any =>
    (service as any).applyProviderMetadata({}, providerMetadata);

  beforeEach(() => {
    service = new MetadataService(
      { findOneByGameIdOrFail: vi.fn(), save: vi.fn() } as any,
      { save: vi.fn(), deleteByGameMetadataIdOrFail: vi.fn() } as any,
      { ...(configuration as any), VOLUMES: { TAGRULES: dir } } as any,
    );
    service.registerProvider(createProvider("low", 5));
    service.registerProvider(createProvider("high", 10));
  });

  it("drops blocked tags from the merged row", () => {
    writeBlock("Steam Cloud", "re:^remote play");
    const merged = apply([
      {
        provider_slug: "high",
        tags: [
          { name: "Action" },
          { name: "Steam Cloud" },
          { name: "Remote Play on TV" },
        ],
      },
    ]);
    expect(merged.tags.map((t: any) => t.name)).toEqual(["Action"]);
  });

  /**
   * The point of resolving BEFORE the kebabCase dedupe key is computed: two
   * providers contributing "ADV" and "Adventure" must collapse to one row,
   * not two.
   */
  it("collapses aliased variants into a single merged tag", () => {
    writeAliases("ADV\tAdventure");
    const merged = apply([
      { provider_slug: "low", tags: [{ name: "ADV" }] },
      { provider_slug: "high", tags: [{ name: "Adventure" }] },
    ]);
    expect(merged.tags.map((t: any) => t.name)).toEqual(["Adventure"]);
  });

  it("leaves genres, developers and publishers untouched", () => {
    writeBlock("Action");
    writeAliases("ADV\tAdventure");
    const merged = apply([
      {
        provider_slug: "high",
        tags: [{ name: "Action" }],
        genres: [{ name: "Action" }],
        developers: [{ name: "ADV" }],
        publishers: [{ name: "Action" }],
      },
    ]);
    // Every tag was blocked, so the field is written as an empty array. It
    // must NOT be left undefined: the scalar spread earlier in the merge
    // already copied the provider's raw tags in, and leaving the key alone
    // would let them survive the block.
    expect(merged.tags).toEqual([]);
    expect(merged.genres.map((g: any) => g.name)).toEqual(["Action"]);
    expect(merged.developers.map((d: any) => d.name)).toEqual(["ADV"]);
    expect(merged.publishers.map((p: any) => p.name)).toEqual(["Action"]);
  });

  it("is inert when no rule files exist", () => {
    const merged = apply([
      { provider_slug: "high", tags: [{ name: "Steam Cloud" }, { name: "ADV" }] },
    ]);
    expect(merged.tags.map((t: any) => t.name)).toEqual(["Steam Cloud", "ADV"]);
  });
});
