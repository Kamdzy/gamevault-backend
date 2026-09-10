import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

import logger from "../../logging.js";

/**
 * Fork: operator-editable tag rules, loaded from a mounted directory rather
 * than the repo.
 *
 * Two line-oriented files, both optional:
 *
 *   tag-block.txt     one entry per line. A line starting with "re:" is a
 *                     regular expression; anything else is an exact
 *                     (case-insensitive) tag name. Blocked tags never reach
 *                     the merged row.
 *
 *   tag-aliases.tsv   "variant<TAB>canonical". The variant is rewritten to
 *                     the canonical name BEFORE the merge dedupes on
 *                     kebabCase(name), so "ADV" and "Adventure" collapse into
 *                     one row instead of two.
 *
 * `#` starts a comment; blank lines are ignored.
 *
 * Format choice is deliberate. These lists are expected to reach tens of
 * thousands of entries, where YAML costs seconds to parse and holds a full
 * AST in memory; line-oriented text parses the same data in milliseconds and
 * diffs cleanly line by line. It also keeps the cost model visible while
 * editing: exact blocks and aliases are O(1) hash lookups per tag no matter
 * how many there are, while every regex is tested in sequence — so regexes
 * are the one kind that degrades, and they get their own syntax to say so.
 *
 * Nothing here mutates provider rows. Rules apply while building the merged
 * row, so editing a file and re-merging re-derives everything, and deleting
 * the files is a complete rollback.
 */
export interface TagRules {
  /** lowercased exact names */
  blockExact: Set<string>;
  blockPatterns: RegExp[];
  /** lowercased variant -> canonical name, stored verbatim for display */
  aliases: Map<string, string>;
  /** true when neither file exists — callers can skip the work entirely */
  empty: boolean;
}

const BLOCK_FILE = "tag-block.txt";
const ALIAS_FILE = "tag-aliases.tsv";

const EMPTY_RULES: TagRules = {
  blockExact: new Set(),
  blockPatterns: [],
  aliases: new Map(),
  empty: true,
};

let cache: { signature: string; rules: TagRules } | undefined;

/**
 * mtime+size of both files. Cheap enough to stat on every merge, which is
 * what makes edits take effect without a restart.
 */
function signatureOf(directory: string): string {
  return [BLOCK_FILE, ALIAS_FILE]
    .map((file) => {
      const path = join(directory, file);
      if (!existsSync(path)) return `${file}:-`;
      const stat = statSync(path);
      return `${file}:${stat.mtimeMs}:${stat.size}`;
    })
    .join("|");
}

/**
 * Yields content lines VERBATIM — blank/comment detection trims a copy, but
 * the line itself is not trimmed. A regex like `re:^steam ` depends on its
 * trailing space; trimming it turns the pattern into `^steam`, which then
 * also matches "steamy romance".
 */
function* readLines(path: string): Generator<string> {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const probe = raw.trim();
    if (!probe || probe.startsWith("#")) continue;
    yield raw.replace(/\r$/, "");
  }
}

function load(directory: string): TagRules {
  const blockExact = new Set<string>();
  const blockPatterns: RegExp[] = [];
  const aliases = new Map<string, string>();

  for (const rawLine of readLines(join(directory, BLOCK_FILE))) {
    // Only the "re:" marker is positional; the pattern after it is verbatim.
    const line = rawLine.startsWith("re:") ? rawLine : rawLine.trim();
    if (line.startsWith("re:")) {
      const source = line.slice(3);
      if (!source) continue;
      try {
        blockPatterns.push(new RegExp(source, "i"));
      } catch (error) {
        logger.warn({
          message: "Ignoring invalid tag-block regex.",
          pattern: source,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    blockExact.add(line.toLowerCase());
  }

  for (const line of readLines(join(directory, ALIAS_FILE))) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const variant = line.slice(0, tab).trim();
    const canonical = line.slice(tab + 1).trim();
    if (!variant || !canonical) continue;
    aliases.set(variant.toLowerCase(), canonical);
  }

  // Single-hop resolution: warn rather than silently half-applying a chain.
  for (const canonical of new Set(aliases.values())) {
    if (aliases.has(canonical.toLowerCase())) {
      logger.warn({
        message:
          "Tag alias target is itself an alias. Resolution is single-hop, so this chain will not fully collapse.",
        canonical,
        resolves_to: aliases.get(canonical.toLowerCase()),
      });
    }
  }

  const empty =
    blockExact.size === 0 && blockPatterns.length === 0 && aliases.size === 0;

  logger.log({
    message: empty
      ? "No tag rules found. Tag blocking and aliasing are disabled."
      : "Loaded tag rules.",
    directory,
    block_exact: blockExact.size,
    block_patterns: blockPatterns.length,
    aliases: aliases.size,
  });

  return { blockExact, blockPatterns, aliases, empty };
}

/** Cached loader; re-reads only when a file's mtime or size changed. */
export function getTagRules(directory: string | undefined): TagRules {
  if (!directory) return EMPTY_RULES;
  let signature: string;
  try {
    signature = signatureOf(directory);
  } catch {
    return EMPTY_RULES;
  }
  if (cache?.signature === signature) return cache.rules;
  const rules = load(directory);
  cache = { signature, rules };
  return rules;
}

/** Test seam — drops the cache so the next call re-reads from disk. */
export function resetTagRulesCache(): void {
  cache = undefined;
}

/**
 * Resolve one tag name against the rules.
 *
 * Order is block(original) -> alias -> block(canonical), so you can drop a
 * single variant without dropping its canonical, and blocking a canonical
 * also drops everything aliased into it.
 *
 * @returns the name to use, or `null` when the tag should be dropped.
 */
export function resolveTagName(
  name: string | undefined,
  rules: TagRules,
): string | null {
  if (!name) return null;
  if (rules.empty) return name;

  if (isBlocked(name, rules)) return null;

  const canonical = rules.aliases.get(name.toLowerCase());
  if (!canonical) return name;

  return isBlocked(canonical, rules) ? null : canonical;
}

function isBlocked(name: string, rules: TagRules): boolean {
  if (rules.blockExact.has(name.toLowerCase())) return true;
  return rules.blockPatterns.some((pattern) => pattern.test(name));
}
