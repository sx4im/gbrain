/**
 * #2185 — known-flags registry generator for CLI_ONLY commands.
 *
 * gbrain's CLI_ONLY commands read flags ad hoc (`args.includes('--force')`,
 * per-command parseFlags helpers), so there is no parser to make strict. The
 * pre-dispatch validator in src/cli/main.ts needs to know each command's legal
 * flags; this script derives them from the source instead of a hand-typed
 * list that would rot.
 *
 * How: per CLI_ONLY command (one record in src/cli/command-table.ts), gather
 * its dispatch text: the record's module under src/cli/commands/ (the former
 * `case 'X':` / plain `if (command === 'X')` body, moved verbatim in refactor
 * wave 1) plus every block of the explicit handleCliOnly pipeline in
 * src/cli/main.ts (handleCliOnly and its @cliPipelineStage functions, see
 * scripts/lib/cli-pipeline.ts) segmented on its dispatch markers — every
 * `if (command === 'X' …)` head, plain or compound, and `case 'X':` labels (see
 * segmentDispatchBlocks). Collect every `import('…/commands/Y.ts')` in that
 * text, then scan the text plus each imported module (plus one level of that
 * module's ./relative same-directory imports) for `--flag` string literals. `//` and
 * `/* *\/` comments are stripped at EVERY depth before the scan (prose is not
 * consumption; see stripComments) — a helper's doc comment must not legalise a
 * flag for a command that merely imports one function from it. String
 * literals include help text, which deliberately over-includes: accepting a flag the handler
 * ignores is the pre-#2185 status quo for that flag, while missing a real
 * flag would break working invocations on upgrade.
 *
 * Two more phantom sources are removed before the scan (#8867): the
 * BEHAVIOR_CHANGES disclosure table in src/core/behavior-change-notice.ts
 * (its rows are prose naming git commands — `git merge --squash` — not
 * flags any command parses; the module is in EXCLUDED_MODULES), and the
 * argv of git child-process calls (see stripGitSpawnArgs): a `--flag`
 * literal passed to git is git's flag, not the importing command's.
 *
 * Output: src/core/cli-flag-registry.generated.ts (committed; freshness is
 * pinned by test/cli-flag-validation.test.ts the same way build:llms pins the
 * llms bundles). Regenerate: bun run build:flag-registry
 *
 * Hand-tuning lane: EXTRA_FLAGS below, for flags that live deeper than the
 * one-level scan (add with a comment naming the deep module).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, resolve as resolvePath, join, sep } from 'path';
import { fileURLToPath } from 'url';
import { flattenCliPipeline, parseSource, readCommandModule, readTableRecords } from './lib/cli-pipeline.ts';

/** Read source with CRLF normalized to LF: the parser's block-boundary and
 *  comment-strip regexes are LF-anchored (`\n}\n`, `//[^\n]*`), so Windows
 *  checkouts (autocrlf=true) would otherwise widen scan windows and inflate
 *  the last command's flag list. Deterministic on every platform. */
function readSrc(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** Flags that live deeper than the one-level module scan. Keep commented. */
const EXTRA_FLAGS: Record<string, string[]> = {
  // embed's pace knobs resolve inside src/core/pace-mode.ts (two levels deep).
  embed: ['--pace', '--pace-max-concurrency'],
  // sync shares the same pace surface via env/config plus CLI passthrough.
  sync: ['--pace', '--pace-max-concurrency'],
  // Deferred persistence routing reaches runForget in recall.ts two levels deep;
  // `forget --purge` hands off from there to src/commands/forget-purge.ts.
  forget: ['--reason', '--request-id', '--purge', '--dry-run', '--yes', '--match', '--status', '--vacuum', '--all-subjects'],
  // sources add reads the meetings and slack options as bare names in src/commands/sources-lifecycle-args.ts (its valued set).
  sources: ['--provider', '--transcript', '--lookback-days', '--sync-interval-min', '--record', '--visibility', '--channels', '--timezone', '--max-requests', '--skip'],
};

/**
 * Command modules a command hands its argv to through a nested handler import,
 * scanned at module depth so their safety-flag reads count as consumption
 * evidence. Their own imports are not walked. Keep commented.
 */
const DELEGATED_MODULES: Record<string, string[]> = {
  // `auth local-writer list|register|revoke` passes its argv to
  // runPersistenceAdminCli (#5595), and `auth rescope-client|rescope-token` to
  // parseRescopeGrantArgs; both parse --dry-run themselves.
  auth: ['src/commands/persistence-admin.ts', 'src/core/grants/cli.ts'],
  // `forget --purge` (and forget --help) hand the argv to runForgetPurge, which
  // parses --dry-run itself; a plain forget refuses --dry-run (recall.ts).
  forget: ['src/commands/forget-purge.ts'],
  // `upgrade --restart-only --dry-run` is parsed by restartDryRun in
  // upgrade-restart.ts, which refuses --dry-run without --restart-only;
  // post-upgrade shares upgrade.ts and never takes it. A plain `upgrade --dry-run`
  // is the channel preview, parsed by runUpgradeDryRun in upgrade-channel.ts.
  upgrade: ['src/commands/upgrade-restart.ts', 'src/commands/upgrade-channel.ts'],
};

/**
 * Modules the import scan must SKIP. thin-client-routing.ts is a pure router —
 * its flag literals belong to the commands it routes (takes/search/jobs/cache/
 * quarantine), and each of those declares its own flags in its own case block;
 * scanning the router bleeds takes/quarantine flags into jobs (whose case
 * block imports it for the `jobs stats` thin-client route). job-isolation.ts
 * builds the INTERNAL `jobs run-child` argv (`--job-id`, `--allow-shell-jobs`):
 * those literals are what a worker passes to its child, not flags an importer
 * parses — autopilot imports it only to resolve the child CLI, and `jobs`
 * declares both flags in its own source. strict-args.ts is the strict-argument
 * table for several commands' destructive subcommands (#6114): its literals
 * belong to pages, cache, schema, integrity and search, each of which reads
 * its own flags in its own source. flag-equals.ts (#7619) names flags as
 * arity data for the `=` split; each handler reads its own flags.
 * direct-pool-profile.ts reads other commands'
 * argv to pick the process's pool profile (`sync --watch`, `serve --access`):
 * serve imports it for the read-only check, and its `--watch` made
 * `gbrain serve --watch` pass validation. behavior-change-notice.ts is a
 * disclosure data table (#8867): its ~1000 BEHAVIOR_CHANGES rows are prose
 * naming ~246 distinct `--flag` literals (an uncommitted `git merge
 * --squash` among them), not flags any command parses — doctor and init
 * both import it, so the table legalised 217 phantoms for init and 68 for
 * doctor, `--squash` included.
 */
const EXCLUDED_MODULES = ['thin-client-routing.ts', 'persistence-delegate.ts', 'job-isolation.ts', 'strict-args.ts', 'direct-pool-profile.ts', 'flag-equals.ts', 'behavior-change-notice.ts'];

function isExcludedModule(p: string): boolean {
  // Basename comparison is path-separator agnostic: on Windows p ends in
  // '\\thin-client-routing.ts' so endsWith('/thin-client-routing.ts') is
  // false and the skip silently no-ops, inflating every command that
  // imports the router with its flags.
  return EXCLUDED_MODULES.some(m => p.split(/[\\/]/).pop() === m);
}

/** Universal helper flags every command may see (parsed or short-circuited upstream). */
const UNIVERSAL_FLAGS = ['--help', '--json', '--brain', '--source'];

const FLAG_RE = /--[a-z0-9][a-z0-9-]*/g;

function flagsInText(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(FLAG_RE)) {
    // Template-literal prefixes (`--bound-${key}` scans as `--bound-`) are
    // not real flags — a trailing hyphen would make the validator accept
    // every typo sharing the prefix.
    if (!m[0].endsWith('-')) out.add(m[0]);
  }
  return out;
}

/** One level of ./relative imports (static or dynamic) from a module's source.
 *  TYPE-ONLY imports are skipped: they carry no runtime behavior the command
 *  can consume, so their doc-comment prose must not register flags (observed:
 *  `import type { BrainEngine } from engine.ts` handed skillpack 10 phantom
 *  flags from engine.ts's comments — the 4th prose-bleed incident). */
function relativeImports(src: string, fromDir: string): string[] {
  const scanSrc = src.replace(/import\s+type\s+[^;]+;/g, '');
  const paths = new Set<string>();
  for (const m of scanSrc.matchAll(/from\s+'(\.\.?\/[^']+\.ts)'/g)) paths.add(m[1]);
  for (const m of scanSrc.matchAll(/import\('(\.\.?\/[^']+\.ts)'\)/g)) paths.add(m[1]);
  return [...paths]
    .map(p => resolvePath(fromDir, p))
    .filter(p => existsSync(p) && !isExcludedModule(p))
    .flatMap(p => [p, ...facadeExpansion(p)]);
}

/**
 * Peeled façade files (containment sprint) whose flag-bearing text moved into
 * sibling module dirs. Before the peels, that text lived inside the façade
 * itself and rode the one-level walk; scanning the façade now pulls its
 * modules back in so a peel can never silently shrink a command's flag set.
 */
function facadeExpansion(p: string): string[] {
  // Compare in forward-slash space: on Windows p uses '\\' separators and
  // would never match the relative-path constants below, silently skipping
  // the peeled-module expansion. Same cross-platform drift class as the
  // isExcludedModule separator check above.
  const rel = (p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p).replace(/\\/g, '/');
  const collect = (dir: string): string[] => {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...collect(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  };
  if (rel === 'src/core/operations.ts') return collect(join(ROOT, 'src/core/ops'));
  if (rel === 'src/commands/migrate-embeddings.ts') return [join(ROOT, 'src/core/embedding-migration-cli.ts')];
  if (rel === 'src/commands/mcp.ts') return [
    join(ROOT, 'src/commands/mcp-admin.ts'),
    join(ROOT, 'src/commands/mcp-admin-http.ts'),
  ];
  if (rel === 'src/commands/doctor.ts') return collect(join(ROOT, 'src/commands/doctor'));
  if (rel === 'src/commands/decide.ts') return collect(join(ROOT, 'src/commands/decide'));
  // Refactor wave 1 (W4 serve-http) peeled runServeHttp into flat
  // serve-http-<area>.ts modules; their text (e.g. the expired-magic-link
  // page's `--url` / `--oauth-request` hint) used to live in serve-http.ts.
  if (rel === 'src/commands/serve-http.ts') {
    return ['oauth', 'metrics', 'admin-api', 'spa', 'mcp', 'webhooks']
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
      .map(m => join(ROOT, `src/commands/serve-http-${m}.ts`))
      .filter(p => existsSync(p));
  }
  // Refactor wave 1 (W3): the MIGRATIONS array moved to one file per migration.
  if (rel === 'src/core/migrate.ts') return collect(join(ROOT, 'src/core/schema-migrations'));
  if (rel === 'src/commands/skillpack.ts') return collect(join(ROOT, 'src/commands/skillpack'));
  // connectors is a peeled command dir (index.ts dispatches to auth/sync/status);
  // scan the whole dir at module depth so a safety flag consumed in a subcommand
  // module (sync.ts: `=== '--dry-run'`) carries its evidence into depth-zero.
  if (rel === 'src/commands/connectors/index.ts') return collect(join(ROOT, 'src/commands/connectors'));
  if (rel === 'src/commands/sync.ts') {
    // Only the modules PEELED OUT of sync.ts (their text used to live inside
    // it). Pre-existing sync-* siblings were always ordinary deps — sweeping
    // them in here would widen surfaces that never saw their text.
    const peeled = [
      'sync-cost-gate.ts',
      'sync-git.ts',
      'sync-anchor.ts',
      'sync-lock.ts',
      'sync-reconcile.ts',
      'sync-status-report.ts',
    ];
    // Refactor wave 1 moves sync's phases into src/commands/sync/; that dir's
    // text is sync.ts's own text, so it joins the surface from its first file.
    return [
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
      ...peeled.map(f => join(ROOT, 'src/core', f)).filter(p => existsSync(p)),
      ...collect(join(ROOT, 'src/commands/sync')),
    ];
  }
  // Refactor wave 1 subcommand tables for jobs/autopilot (cut-line) land in
  // same-named command dirs; empty until those peels happen.
  if (rel === 'src/commands/jobs.ts') {
    // The built-in handler bodies registerBuiltinHandlers used to hold inline
    // moved to src/core/minions/handlers/ (W4 jobs). Only those modules: the
    // directory's pre-existing handlers (shell, subagent, ...) were always
    // ordinary deps, so globbing it would widen jobs' surface.
    const peeledHandlers = [
      'autopilot-cycle.ts', 'autopilot-global-maintenance.ts', 'backlinks.ts', 'chronicle-extract.ts',
      'cycle-phase.ts', 'embed-catch-up.ts', 'embed.ts', 'enrich.ts', 'extract-atoms-drain.ts',
      'extract-conversation-facts.ts', 'extract-ner.ts', 'extract-takes-from-pages.ts',
      'extract-timeline-from-meetings.ts', 'extract.ts', 'facts-absorb.ts', 'import.ts',
      'integrity-auto.ts', 'integrity.ts', 'job-pull.ts', 'lint-fix.ts', 'lint.ts', 'loops-extract.ts',
      'orphans.ts', 'purge.ts', 'reindex.ts', 'repair-jsonb.ts', 'sync-retry-failed.ts', 'sync.ts',
      'unify-types.ts',
    ];
    return [
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
      ...peeledHandlers.map(f => join(ROOT, 'src/core/minions/handlers', f)).filter(p => existsSync(p)),
      ...collect(join(ROOT, 'src/commands/jobs')),
    ];
  }
  if (rel === 'src/commands/autopilot.ts') {
    // W4 autopilot split runAutopilot's daemon into flat autopilot-*.ts
    // siblings (the existing autopilot-fanout/-pause convention). Only the
    // modules peeled out of autopilot.ts: pre-existing siblings were always
    // ordinary deps, so a glob would widen the surface.
    const peeled = ['autopilot-daemon.ts', 'autopilot-dispatch.ts', 'autopilot-probes.ts'];
    return [
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
      ...peeled.map(f => join(ROOT, 'src/commands', f)).filter(p => existsSync(p)),
      ...collect(join(ROOT, 'src/commands/autopilot')),
    ];
  }
  return [];
}

/**
 * A block-level `import('./commands/X.ts')` whose destructured bindings are
 * ALL SCREAMING_CASE constants borrows a value (a message string), not a
 * handler — `const { THIN_CLIENT_REGISTER_MESSAGE } = await import(
 * './commands/agent-register.ts')` in the agent-register pre-connect guard.
 * Promoting such a module to depth zero scans its one-level deps
 * (sources-ops / config / auth / oauth-provider …) as if the command owned
 * them: that handed the agent row 38 phantom flags (--confirm-destructive,
 * --force, --remove, …). The handler proper (`const { runX } = …`) still
 * reaches the module through its own import walk, so no real flag is lost.
 */
export function isValueOnlyImport(block: string, importIndex: number): boolean {
  const lineStart = block.lastIndexOf('\n', importIndex) + 1;
  const head = block.slice(lineStart, importIndex);
  const m = head.match(/const\s*\{([^}]*)\}\s*=\s*await\s*$/);
  if (!m) return false;
  const bindings = m[1].split(',').map(b => b.trim()).filter(b => b.length > 0);
  return bindings.length > 0 && bindings.every(b => /^[A-Z][A-Z0-9_]*$/.test(b));
}

/**
 * Segment handleCliOnly's body into per-command text blocks.
 *
 * handleCliOnly dispatches through TWO styles: an `if (command === 'X')`
 * chain (DB-free commands like init/auth/schema) and a switch with
 * `case 'X':` labels. Segment on BOTH marker kinds; the text between a
 * marker and the next marker belongs to that label. Repeated labels
 * (fall-through cases, a command with several `if` branches) union their
 * blocks.
 *
 * The `if` chain has THREE shapes, and every one is a marker for X:
 *   if (command === 'X') {                        plain
 *   if (command === 'X' && args[0] === 'sub') {   compound — the sub-owned
 *                                                 no-DB bypasses (eval
 *                                                 longmemeval / brainbench /
 *                                                 …), the `<cmd> --help`
 *                                                 pre-engine branches, agent
 *                                                 register
 *   if (\n    command === 'X' &&\n    (...)       multi-line compound
 * Invariant: ownership follows the `command === 'X'` head, never the
 * condition's tail. Pre-fix only the plain shape matched, so a compound
 * block's text was attributed to the PRECEDING marker: every `eval <sub>`
 * bypass landed on `dream`, every `<cmd> --help` bypass on `status`, and the
 * eval row lacked --retrieval-only/--by-type/--no-trajectory/--keyword-only —
 * the documented `gbrain eval longmemeval` invocation exited 1 as an unknown
 * flag. `[ \t]*` (not `\s*`) keeps the marker anchored to its own line; `\(\s*`
 * lets the multi-line shape's newline through. A bare `command === 'X'` inside
 * a non-`if` expression (the serve `degradable` const) is deliberately NOT a
 * marker.
 */
/**
 * Strip `//` line comments and `/* … *\/` block comments from a block's
 * text, preserving newlines (so line-anchored scans such as isValueOnlyImport
 * still see the same line structure) and leaving string / template literals
 * intact (a `'https://…'` literal is not a comment). Prose in a comment is not
 * evidence a command reads a flag: cli.ts's `reindex --help` comment ("…the
 * --multimodal flags the dispatcher parses") handed the PRECEDING marker
 * (storage) a phantom --multimodal because the comment sat between the two
 * markers. Regex literals are not modelled — `//` inside one would truncate
 * that line — which is acceptable for dispatch-block text (none there today).
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      // Keep the newlines the comment spanned so line structure survives.
      out += src.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j++;
        else if (quote !== '`' && src[j] === '\n') break; // unterminated: stop at EOL
        j++;
      }
      out += src.slice(i, Math.min(n, j + 1));
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * #8867 — blank git argv before the flag regex runs.
 *
 * A `--flag` literal inside a git child-process call is git's flag, not a
 * flag the importing command parses: doctor's checks pass
 * `['status', '--porcelain']` / `['rev-parse', '--show-toplevel']` to their
 * local git runners, and `execFileSync('git', ['log', '--date=unix', ...])`
 * the same. The generator used to collect all of them, so
 * `gbrain doctor --squash` ran as plain `gbrain doctor` instead of refusing
 * an unknown flag (that one leaked from BEHAVIOR_CHANGES prose instead).
 *
 * Shapes, all blanked to spaces (same length, newlines kept, so
 * line-anchored scans still see the same structure):
 *   - a call to a local git runner — `git(`, `gitRun(`, `gitAsync(`,
 *     `gitRawOutput(`, bootstrap-checks' local `g(`, and the repo's git
 *     helpers (`gitLine`, `hardenedGitSync`, `syncGit`, `tryGit`,
 *     `gitShort`, `runGit`, `gitOut`, `gitRead`, …) — whose argument list
 *     IS git argv (bare strings and array elements alike);
 *   - a spawn-family call — execFileSync/execFile/execFileAsync/
 *     execFileBounded/tryExecAsync/spawnSync/spawn — whose first argument
 *     is the string literal 'git';
 *   - a string literal that IS a git shell command (`execSync('git
 *     rev-parse --show-toplevel')`): only the `--flag` tokens inside it
 *     are blanked;
 *   - an array literal that IS git argv — first string element 'git' or
 *     a git subcommand (`run(['rev-parse', '--show-toplevel'])`,
 *     `syncGit(root, ['status', '--porcelain'])`, `argv: ['git', ...]`) —
 *     whatever wrapper carries it. An array that is an ELEMENT of another
 *     array literal is never blanked: autopilot.ts's
 *     AUTOPILOT_POSITIONAL_ALIASES maps ['status', '--status'] as DATA
 *     (a real CLI flag), and 'status' is also a git subcommand;
 *   - a variable-bound argv — `const args = ['-C', root, 'status',
 *     '--porcelain']; execFileSync('git', args, …)` (git-head.ts) — the
 *     literal and its `.push('…')` additions are blanked once the
 *     variable is seen passed to a git spawn/helper. A variable argv
 *     whose binding is not visible here is left alone.
 * A flag a command genuinely parses is never spelled as git argv, so
 * blanking can only remove phantoms. Apply this to the flagsInText input
 * only — depthZeroText stays intact for the consumes() SAFETY/SCOPING
 * checks. Regex literals are not modelled (same limitation as
 * stripComments); comments are copied through untouched (callers strip
 * them first). One known gap, left alone: stripComments does not strip a
 * block comment holding backticks (skill-fix-gates.ts's `git status
 * --porcelain` doc line survives it) — a pre-existing stripComments
 * limitation, not git argv.
 */
const GIT_RUNNER_NAMES = new Set(['git', 'gitRun', 'gitAsync', 'gitRawOutput', 'g']);
const GIT_HELPER_NAMES = new Set(['gitLine', 'hardenedGitSync', 'hardenedGit', 'syncGit', 'syncGitAsync', 'tryGit', 'gitShort', 'runGit', 'gitOut', 'gitRead']);
const GIT_ARGV_BUILDERS = new Set(['buildGitInvocation', 'gitArgs']);
/** First words of a git argv array: the binary itself, or a subcommand. */
const GIT_SUBCOMMANDS = new Set(['rev-parse', 'status', 'log', 'diff', 'show', 'merge', 'rebase', 'add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'branch', 'tag', 'stash', 'reset', 'config', 'remote', 'ls-files', 'ls-tree', 'cat-file', 'rev-list', 'describe', 'blame', 'grep', 'clean', 'clone', 'worktree', 'submodule', 'cherry-pick', 'revert', 'notes', 'gc', 'fsck', 'hash-object', 'update-index', 'read-tree', 'write-tree', 'symbolic-ref', 'check-ignore', 'for-each-ref', 'ls-remote', 'archive', 'shortlog', 'var', 'bisect', 'mv', 'rm']);
const GIT_SPAWN_FNS = new Set(['execFileSync', 'execFile', 'execFileAsync', 'execFileBounded', 'tryExecAsync', 'spawnSync', 'spawn']);
const FLAG_TOKEN_RE = /--[a-z0-9][a-z0-9-]*/g;

function blankFlagTokens(text: string): string {
  return text.replace(FLAG_TOKEN_RE, (m) => ' '.repeat(m.length));
}

function isGitCommand(content: string): boolean {
  return /^\s*git\s+/.test(content);
}

const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'delete', 'void', 'in', 'of', 'new', 'throw', 'instanceof', 'yield', 'await', 'else', 'do']);

/**
 * Could the `/` at `i` start a regex literal? After a value (identifier,
 * number, string, `)`, `]`, template end) it is division; after an operator,
 * opener, keyword or statement start it can be a regex. A regex that
 * contains a quote (`/"/`) or brackets (`/[\s()+-]/`) would otherwise be
 * misread as a string or as code brackets, and the walker would lose sync
 * (observed: an extra `}` emitted after a template holding replace(/"/g)).
 */
function regexStartsAt(src: string, i: number): boolean {
  if (src[i + 1] === '=') return false; // /= is divide-assign
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const prev = src[j];
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    if (REGEX_KEYWORDS.has(src.slice(k + 1, j + 1))) return true;
    return false; // identifier/number: division
  }
  if (prev === ')' || prev === ']' || prev === '`') return false;
  if ((prev === '+' || prev === '-') && src[j - 1] === prev) return false; // x++ / 2
  return true;
}

/** End index (exclusive) of the regex literal starting at `i` (`/`). */
function skipRegex(src: string, i: number): number {
  const n = src.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return j; // unterminated: stop at EOL
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      return j;
    }
    j++;
  }
  return n;
}

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

/** End index (exclusive) of the quoted literal starting at `i` (`'` or `"`). */
function skipQuoted(src: string, i: number): number {
  const quote = src[i];
  const n = src.length;
  let j = i + 1;
  while (j < n && src[j] !== quote) {
    if (src[j] === '\\') j++;
    else if (src[j] === '\n') break; // unterminated: stop at EOL
    j++;
  }
  return Math.min(n, j + 1);
}

/**
 * Template literal starting at `i`: its text chunks and `${...}` expression
 * spans (excluding the delimiters), plus the end index (exclusive).
 */
function parseTemplate(src: string, i: number): { end: number; parts: Array<{ kind: 'text'; text: string } | { kind: 'expr'; start: number; end: number }> } {
  const n = src.length;
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'expr'; start: number; end: number }> = [];
  let j = i + 1;
  let chunkStart = j;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') {
      parts.push({ kind: 'text', text: src.slice(chunkStart, j) });
      return { end: j + 1, parts };
    }
    if (c === '$' && src[j + 1] === '{') {
      parts.push({ kind: 'text', text: src.slice(chunkStart, j) });
      // Find the matching `}` honouring nesting, strings and templates.
      let depth = 1;
      let k = j + 2;
      while (k < n && depth > 0) {
        const d = src[k];
        if (d === "'" || d === '"') { k = skipQuoted(src, k); continue; }
        if (d === '`') { k = parseTemplate(src, k).end; continue; }
        if (d === '/' && src[k + 1] !== '/' && src[k + 1] !== '*' && regexStartsAt(src, k)) { k = skipRegex(src, k); continue; }
        if (d === '{') depth++;
        else if (d === '}') depth--;
        k++;
      }
      parts.push({ kind: 'expr', start: j + 2, end: depth === 0 ? k - 1 : n });
      j = k;
      chunkStart = j;
      continue;
    }
    j++;
  }
  parts.push({ kind: 'text', text: src.slice(chunkStart, n) });
  return { end: n, parts };
}

/** Index of the `)` matching the `(` at `open`, honouring strings, templates and comments; -1 when unmatched. */
function matchingParen(src: string, open: number): number {
  let depth = 0;
  let i = open;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && regexStartsAt(src, i)) { i = skipRegex(src, i); continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i); continue; }
    if (c === '`') { i = parseTemplate(src, i).end; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Top-level comma-separated arguments of the call list src[start, end). */
function topLevelArgs(src: string, start: number, end: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let a = start;
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 || e > end ? end : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 || e + 2 > end ? end : e + 2; continue; }
    if (c === '/' && regexStartsAt(src, i)) { i = Math.min(skipRegex(src, i), end); continue; }
    if (c === "'" || c === '"') { i = Math.min(skipQuoted(src, i), end); continue; }
    if (c === '`') { i = Math.min(parseTemplate(src, i).end, end); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { args.push(src.slice(a, i)); a = i + 1; }
    i++;
  }
  args.push(src.slice(a, end));
  return args;
}

/** Blank --flag tokens inside the given [start, end) spans (length-preserving). */
function applyBlankSpans(src: string, spans: Array<[number, number]>): string {
  if (spans.length === 0) return src;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [s, e] of sorted) {
    if (e <= pos) continue; // overlapped by an earlier span
    out += src.slice(pos, s) + blankFlagTokens(src.slice(s, e));
    pos = e;
  }
  out += src.slice(pos);
  return out;
}

/**
 * Blank git-argv array literals: an array whose first string element is
 * 'git' or a git subcommand. The array's own first element declares it git
 * argv, whatever wrapper carries it — `run([...])`, `list([...])`,
 * `text([...])`, `syncGit(root, [...])`, `argv: ['git', ...]`. Guard: an
 * array that is an ELEMENT of another array literal is data, not argv —
 * autopilot.ts's AUTOPILOT_POSITIONAL_ALIASES maps ['status', '--status']
 * (a real CLI flag) and 'status' is also a git subcommand. Index access
 * (`a[0]`, `m['status']`) is not an array literal: the `[` follows an
 * identifier, `)`, `]` or a quote.
 */
function blankGitArgvArrays(src: string): string {
  const spans: Array<[number, number]> = [];
  // Openers: '(' | '{' | '[' array literal | 'i' index bracket.
  const stack: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && regexStartsAt(src, i)) { i = skipRegex(src, i); continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i); continue; }
    if (c === '`') { i = parseTemplate(src, i).end; continue; }
    if (c === '(' || c === '{') { stack.push(c); i++; continue; }
    if (c === '[') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      const prev = j >= 0 ? src[j] : '';
      let isLiteral = true;
      if (/[A-Za-z0-9_$]/.test(prev) || prev === ')' || prev === ']' || prev === "'" || prev === '"' || prev === '`') {
        if (/[A-Za-z0-9_$]/.test(prev)) {
          // `return [` / `typeof [` open a literal; `name[` is an index.
          let k = j;
          while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
          isLiteral = REGEX_KEYWORDS.has(src.slice(k + 1, j + 1));
        } else {
          isLiteral = false;
        }
      }
      if (!isLiteral) { stack.push('i'); i++; continue; }
      const close = matchingParen(src, i);
      if (close === -1) { stack.push('['); i++; continue; }
      let k = i + 1;
      while (k < close && /\s/.test(src[k])) k++;
      let first = '';
      if (src[k] === "'" || src[k] === '"') {
        const qEnd = skipQuoted(src, k);
        first = src.slice(k + 1, qEnd - 1);
      }
      const parent = stack.length > 0 ? stack[stack.length - 1] : '';
      if ((first === 'git' || GIT_SUBCOMMANDS.has(first)) && parent !== '[') {
        spans.push([i, close + 1]);
      }
      stack.push('[');
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      if (stack.length > 0) stack.pop();
      i++;
      continue;
    }
    i++;
  }
  return applyBlankSpans(src, spans);
}

/**
 * Blank variable-bound git argv: `const args = ['-C', root, 'status',
 * '--porcelain']; execFileSync('git', args, …)` (git-head.ts). The literal
 * and its `.push('…')` additions are blanked once the variable is seen
 * passed to a git spawn, a git runner/helper, or an argv builder
 * (`buildGitInvocation`, `gitArgs`). Only the first binding per name is
 * used; a variable whose binding is not visible here is left alone.
 * Scans are delimiter-aware (strings/templates/regexes/comments skipped)
 * so a doc string quoting code cannot mark a variable.
 */
function blankVariableGitArgv(src: string): string {
  const bindings = new Map<string, [number, number]>();
  const pushes = new Map<string, Array<[number, number]>>();
  const marked = new Set<string>();
  const n = src.length;
  // Pass 1: bindings + pushes.
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && regexStartsAt(src, i)) { i = skipRegex(src, i); continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i); continue; }
    if (c === '`') { i = parseTemplate(src, i).end; continue; }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 'const' || word === 'let' || word === 'var') {
        let k = j;
        while (k < n && /\s/.test(src[k])) k++;
        const nameStart = k;
        while (k < n && isIdentChar(src[k])) k++;
        const name = src.slice(nameStart, k);
        while (k < n && /\s/.test(src[k])) k++;
        if (name && src[k] === '=' && !bindings.has(name)) {
          let m = k + 1;
          while (m < n && /\s/.test(src[m])) m++;
          if (src[m] === '[') {
            const close = matchingParen(src, m);
            if (close !== -1) bindings.set(name, [m, close + 1]);
          }
        }
        i = j;
        continue;
      }
      // NAME.push('...' | "..." | `...`)
      if (src[j] === '.') {
        let k = j + 1;
        if (src.slice(k, k + 4) === 'push') {
          k += 4;
          while (k < n && /\s/.test(src[k])) k++;
          if (src[k] === '(' && bindings.has(word)) {
            let m = k + 1;
            while (m < n && /\s/.test(src[m])) m++;
            if (src[m] === "'" || src[m] === '"') {
              const e = skipQuoted(src, m);
              (pushes.get(word) ?? pushes.set(word, []).get(word)!).push([m, e]);
            } else if (src[m] === '`') {
              const e = parseTemplate(src, m).end;
              (pushes.get(word) ?? pushes.set(word, []).get(word)!).push([m, e]);
            }
          }
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  if (bindings.size === 0) return src;
  // Pass 2: trigger calls passing a bound variable as git argv.
  i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '/' && regexStartsAt(src, i)) { i = skipRegex(src, i); continue; }
    if (c === "'" || c === '"') { i = skipQuoted(src, i); continue; }
    if (c === '`') { i = parseTemplate(src, i).end; continue; }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(src[j])) j++;
      const word = src.slice(i, j);
      const isSpawn = GIT_SPAWN_FNS.has(word);
      const isRunner = GIT_RUNNER_NAMES.has(word) || GIT_HELPER_NAMES.has(word);
      const isBuilder = GIT_ARGV_BUILDERS.has(word);
      if (isSpawn || isRunner || isBuilder) {
        const prev = i > 0 ? src[i - 1] : '';
        if (!/[A-Za-z0-9_$.]/.test(prev)) {
          let k = j;
          while (k < n && /\s/.test(src[k])) k++;
          if (src[k] === '(') {
            const close = matchingParen(src, k);
            if (close !== -1) {
              const args = topLevelArgs(src, k + 1, close);
              if (!isSpawn || (args[0]?.trim() === "'git'" || args[0]?.trim() === '"git"')) {
                for (const a of args) {
                  const t = a.trim();
                  if (/^[A-Za-z_$][\w$]*$/.test(t) && bindings.has(t)) marked.add(t);
                }
              }
            }
          }
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  if (marked.size === 0) return src;
  const spans: Array<[number, number]> = [];
  for (const name of marked) {
    spans.push(bindings.get(name)!);
    for (const s of pushes.get(name) ?? []) spans.push(s);
  }
  return applyBlankSpans(src, spans);
}

type ScanMode = 'scan' | 'git-args';

/** Walk src[start, end), blanking git argv flag literals per `mode`. */
function walkGitArgs(src: string, start: number, end: number, mode: ScanMode): string {
  let out = '';
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const stop = src.indexOf('\n', i);
      const e = stop < 0 || stop > end ? end : stop;
      out += src.slice(i, e);
      i = e;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const stop = src.indexOf('*/', i + 2);
      const e = stop < 0 || stop + 2 > end ? end : stop + 2;
      out += src.slice(i, e);
      i = e;
      continue;
    }
    if (c === '/' && regexStartsAt(src, i)) {
      const stop = Math.min(skipRegex(src, i), end);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      const stop = skipQuoted(src, i);
      const closed = stop - 1 < end && stop - 1 > i && src[stop - 1] === c;
      const contentEnd = closed ? stop - 1 : Math.min(stop, end);
      const content = src.slice(i + 1, contentEnd);
      const blanked = mode === 'git-args' || isGitCommand(content) ? blankFlagTokens(content) : content;
      out += src[i] + blanked + (closed ? c : '');
      i = contentEnd + (closed ? 1 : 0);
      continue;
    }
    if (c === '`') {
      const { end: stop, parts } = parseTemplate(src, i);
      const firstText = parts.find(p => p.kind === 'text');
      const isGit = firstText !== undefined && isGitCommand(firstText.text);
      out += '`';
      for (const p of parts) {
        if (p.kind === 'text') out += mode === 'git-args' || isGit ? blankFlagTokens(p.text) : p.text;
        else out += '${' + walkGitArgs(src, p.start, Math.min(p.end, end), mode) + '}';
      }
      out += stop <= end && src[stop - 1] === '`' ? '`' : '';
      i = stop;
      continue;
    }
    if (mode === 'scan' && isIdentStart(c)) {
      let j = i + 1;
      while (j < end && isIdentChar(src[j])) j++;
      const ident = src.slice(i, j);
      const prev = i > 0 ? src[i - 1] : '';
      const isRunner = (GIT_RUNNER_NAMES.has(ident) || GIT_HELPER_NAMES.has(ident)) && !/[A-Za-z0-9_$.]/.test(prev);
      const isSpawn = GIT_SPAWN_FNS.has(ident) && !/[A-Za-z0-9_$]/.test(prev);
      if (isRunner || isSpawn) {
        let k = j;
        while (k < end && /\s/.test(src[k])) k++;
        if (src[k] === '(') {
          if (isRunner) {
            const close = matchingParen(src, k);
            if (close !== -1 && close < end) {
              out += ident + walkGitArgs(src, k, close + 1, 'git-args');
              i = close + 1;
              continue;
            }
          } else {
            // Spawn call: only a 'git' first argument makes it a git spawn.
            let m = k + 1;
            while (m < end && /\s/.test(src[m])) m++;
            if (src[m] === "'" || src[m] === '"') {
              const litEnd = skipQuoted(src, m);
              if (src.slice(m + 1, litEnd - 1).trim() === 'git') {
                const close = matchingParen(src, k);
                if (close !== -1 && close < end) {
                  out += ident + walkGitArgs(src, k, close + 1, 'git-args');
                  i = close + 1;
                  continue;
                }
              }
            }
          }
        }
      }
      out += ident;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Fast path: a file with no git-argv signal at all — no git-command string,
 * no runner/spawn/helper call, no git-argv array literal — cannot lose a
 * flag to any pass below, so return it untouched instead of scanning it
 * three times. Pure optimisation: the passes return their input unchanged
 * on such text. (The guard is a superset of every shape the passes look
 * for; a false positive only costs a full scan, never a wrong blank.)
 */
const GIT_ARGV_SIGNAL_RE = /['"`]\s*git\s|\b(?:execFileSync|execFile|execFileAsync|execFileBounded|tryExecAsync|spawnSync|spawn|git|gitRun|gitAsync|gitRawOutput|g|gitLine|hardenedGitSync|hardenedGit|syncGit|syncGitAsync|tryGit|gitShort|runGit|gitOut|gitRead|buildGitInvocation|gitArgs)\s*\(|\[\s*['"](?:git|rev-parse|status|log|diff|show|merge|rebase|add|commit|push|pull|fetch|checkout|branch|tag|stash|reset|config|remote|ls-files|ls-tree|cat-file|rev-list|describe|blame|grep|clean|clone|worktree|submodule|cherry-pick|revert|notes|gc|fsck|hash-object|update-index|read-tree|write-tree|symbolic-ref|check-ignore|for-each-ref|ls-remote|archive|shortlog|var|bisect|mv|rm)['"]/;
/** The array-literal arm of the gate above, and the variable-binding arm. */
const GIT_ARGV_ARRAY_RE = /\[\s*['"](?:git|rev-parse|status|log|diff|show|merge|rebase|add|commit|push|pull|fetch|checkout|branch|tag|stash|reset|config|remote|ls-files|ls-tree|cat-file|rev-list|describe|blame|grep|clean|clone|worktree|submodule|cherry-pick|revert|notes|gc|fsck|hash-object|update-index|read-tree|write-tree|symbolic-ref|check-ignore|for-each-ref|ls-remote|archive|shortlog|var|bisect|mv|rm)['"]/;
const GIT_VAR_ARGV_RE = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\[/;

export function stripGitSpawnArgs(src: string): string {
  if (!GIT_ARGV_SIGNAL_RE.test(src)) return src;
  // Each pre-pass runs only when its own shape is present (each is
  // length-preserving, so spans stay valid); the call-shape walker last.
  let out = src;
  if (GIT_ARGV_ARRAY_RE.test(out)) out = blankGitArgvArrays(out);
  if (GIT_VAR_ARGV_RE.test(out)) out = blankVariableGitArgv(out);
  return walkGitArgs(out, 0, out.length, 'scan');
}

export function segmentDispatchBlocks(fnSrc: string): Map<string, string> {
  const markRe = /(?:^[ \t]*if \(\s*command === '([a-z0-9-]+)'|^      case '([a-z0-9-]+)':)/gm;
  const marks: Array<{ label: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = markRe.exec(fnSrc)) !== null) {
    marks.push({ label: (m[1] ?? m[2])!, start: m.index });
  }

  const blocks = new Map<string, string>();
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : fnSrc.length;
    // Comments are prose, not consumption: strip them before any flag scan.
    const body = stripComments(fnSrc.slice(marks[i].start, end));
    // Fall-through labels share the following block.
    blocks.set(marks[i].label, (blocks.get(marks[i].label) ?? '') + body);
  }
  return blocks;
}

/** @param root repository root; a fixture tree in tests (test/cli-synthetic-command.test.ts). */
export function buildFlagRegistry(root: string = ROOT): Record<string, string[]> {
  return buildFlagArtifacts(root).registry;
}

/**
 * A1 render-time routing pin (src/core/fix-routing.ts): the routing flags a
 * fix naming each CLI-only command carries. Acceptance alone is not evidence
 * (every command accepts `--brain`/`--source` through UNIVERSAL_FLAGS), so:
 * - `--brain` when the command opens its brain through the connect terminator
 *   (phase other than `pre-connect`), or its own code reads the global brain
 *   option;
 * - `--source` when the record declares `routes_source: true` (its source resolves
 *   through the ambient chain), or the flag it declares instead (`'--source-id'`
 *   for extract, whose `--source` selects fs|db). The declaration needs consumption
 *   evidence (the tight-quoted flag literal in the command's own code, the
 *   SAFETY_FLAGS rule); a declaration without it fails the generator.
 */
export function buildRoutingFlags(root: string = ROOT): Record<string, string[]> {
  return buildFlagArtifacts(root).routing;
}

function buildFlagArtifacts(root: string): { registry: Record<string, string[]>; routing: Record<string, string[]> } {
  // CLI_ONLY membership: one record per command in the command table
  // (src/cli/command-table.ts), read by AST so the generator never executes
  // the table.
  const records = readTableRecords(root);
  const commands = records.map(r => r.name);

  // Dispatch text per command, from two sources (refactor wave 1, W4 cli):
  //  1. the explicit handleCliOnly pipeline in src/cli/main.ts: handleCliOnly and
  //     every @cliPipelineStage function it calls, each segmented on its own
  //     (bounded at the function, so no function's tail bleeds into the next;
  //     unbounded, the LAST block once absorbed every --flag literal in the
  //     rest of cli.ts, printHelp included, a ~100-flag junk allowlist);
  //  2. each record's module under src/cli/commands/ (the former plain
  //     `if (command === 'x')` branch or switch case, moved verbatim).
  // Import specifiers resolve relative to the file the text came from.
  const blocks = new Map<string, Array<{ text: string; dir: string }>>();
  const addBlock = (label: string, text: string, dir: string) => blocks.set(label, [...(blocks.get(label) ?? []), { text, dir }]);
  const pipeline = flattenCliPipeline(parseSource(root, 'src/cli/main.ts'));
  for (const fn of [pipeline.entry, ...pipeline.stages]) {
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
    for (const [label, text] of segmentDispatchBlocks(fn.getText())) addBlock(label, text, join(root, 'src', 'cli'));
  }
  for (const record of records) {
    const mod = record.loadSpecifier ? readCommandModule(root, record.loadSpecifier) : null;
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- mod.path comes from the repo's own command table literal import specifiers; build-time only
    if (mod) addBlock(record.name, stripComments(readSrc(join(root, mod.path))), dirname(join(root, mod.path)));
  }

  // Safety flags carry destructive-bypass semantics: allowlisting one that
  // the handler never reads recreates the #2185 repro (`post-upgrade
  // --dry-run` accepted, ignored, migrations run for real). Presence isn't
  // enough — upgrade.ts prints a HINT naming another command's --dry-run,
  // which is depth-0 text for post-upgrade. These flags are only legal with
  // CONSUMPTION evidence in the command's own code: the flag as a TIGHT-QUOTED
  // standalone literal (`includes('--dry-run')`, `has('--dry-run')`,
  // `=== '--dry-run'`). Prose bleed embeds the flag inside a longer string, so
  // it never has quotes on both sides of the bare flag.
  const SAFETY_FLAGS = new Set(['--dry-run', '--allow-noncanonical-root']);
  // Reindex scope/mode flags can bleed through upgrade's imported modules even
  // though upgrade does not forward them. Require direct consumption on the
  // affected dispatch surfaces so callers never get silently ignored selectors.
  const SCOPING_FLAGS_BY_COMMAND: Record<string, string[]> = {
    reindex: ['--type'],
    upgrade: ['--type', '--aliases'],
    'post-upgrade': ['--type', '--aliases'],
    // bundled-skill's skill_not_found hint names setup's refresh command; it parses its own flags strictly.
    'bundled-skill': ['--skill-loading', '--skills-index-only', '--install'],
  };
  const consumes = (text: string, flag: string): boolean =>
    new RegExp(`['"\`]${flag}['"\`]`).test(text);

  const registry: Record<string, string[]> = {};
  const routing: Record<string, string[]> = {};
  for (const command of commands) {
    const parts = blocks.get(command) ?? [];
    const flags = new Set<string>(UNIVERSAL_FLAGS);
    const depthZero = new Set<string>();
    let depthZeroText = parts.map(p => p.text).join('');
    for (const f of flagsInText(stripGitSpawnArgs(depthZeroText))) { flags.add(f); depthZero.add(f); }

    // COMMAND modules imported inside the case block (`./commands/*.ts`
    // only), plus one level of each module's own ./relative imports. Core
    // helpers a dispatch block reaches for directly (`./core/bootstrap/
    // uninstall.ts` in the agent-register pre-connect guard, `./core/
    // doctor-remote.ts`, `./core/ai/gateway.ts`, …) are NOT command modules:
    // scanning them as one handed the agent row ~45 phantom flags from the
    // uninstall command's surface (--delete-brain, --confirm-destructive,
    // --break-lock, --force, --remove) the moment the compound
    // `command === 'agent' && args[0] === 'register'` head became a marker.
    // A flag a block consumes through a core helper is already a literal in
    // the block's own text (depth zero); the helper's prose adds nothing.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module name or a path the generator itself discovered under ROOT
    const commandsDir = join(root, 'src', 'commands');
    const commandModules = parts.flatMap(({ text, dir }) => [...text.matchAll(/import\('(\.\.?\/[^']+\.ts)'\)/g)]
      .filter(mm => !isValueOnlyImport(text, mm.index ?? 0))
// nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- resolves literal relative import specifiers found in this repo's own source; results are filtered to src/commands below
      .map(mm => resolvePath(dir, mm[1])))
      .filter(p => p.startsWith(commandsDir + sep) && existsSync(p) && !isExcludedModule(p));
    for (const modPath of commandModules) {
      // A command module that IS a peeled façade counts its module files as
      // part of itself: their text scans at module depth and THEIR relative
      // imports scan at dep depth — exactly the pre-peel walk.
      const surface = [modPath, ...facadeExpansion(modPath)];
      for (const sfPath of surface) {
        const sfSrc = readSrc(sfPath);
        // Comments are prose at every depth, not just in the dispatch block:
        // a helper's doc comment ("Used by --fresh + after manual reset" in
        // backfill-base.ts) handed reindex-search-vector a --fresh it never
        // parses the moment the command imported one function from it.
        // Consumed flags are always string literals, so stripping can only
        // remove phantoms.
        const sfCode = stripComments(sfSrc);
        depthZeroText += sfCode;
        for (const f of flagsInText(stripGitSpawnArgs(sfCode))) { flags.add(f); depthZero.add(f); }
        for (const dep of relativeImports(sfSrc, dirname(sfPath))) {
          for (const f of flagsInText(stripGitSpawnArgs(stripComments(readSrc(dep))))) flags.add(f);
        }
      }
    }

    for (const rel of DELEGATED_MODULES[command] ?? []) {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module path from DELEGATED_MODULES
      const path = join(root, rel);
      if (!existsSync(path)) continue;
      const code = stripComments(readSrc(path));
      depthZeroText += code;
      for (const f of flagsInText(stripGitSpawnArgs(code))) { flags.add(f); depthZero.add(f); }
    }
    for (const f of EXTRA_FLAGS[command] ?? []) { flags.add(f); depthZero.add(f); }
    for (const f of SAFETY_FLAGS) {
      if (flags.has(f) && !consumes(depthZeroText, f)) flags.delete(f);
    }
    for (const f of SCOPING_FLAGS_BY_COMMAND[command] ?? []) {
      if (flags.has(f) && !consumes(depthZeroText, f)) flags.delete(f);
    }
    registry[command] = [...flags].sort();
    const record = records.find(r => r.name === command);
    if (record?.routesSource && !consumes(depthZeroText, record.routesSource)) {
      throw new Error(`generate-flag-registry: ${command} declares routes_source but its code never reads '${record.routesSource}'`);
    }
    const routed = [
      ...(record?.phase !== 'pre-connect' || /getCliOptions\(\)\.brain|cliOpts\.brain/.test(depthZeroText) ? ['--brain'] : []),
      ...(record?.routesSource ? [record.routesSource] : []),
    ];
    if (routed.length) routing[command] = routed;
  }
  return { registry, routing };
}

export function renderRegistryModule(registry: Record<string, string[]>, routing: Record<string, string[]> = {}): string {
  const render = (map: Record<string, string[]>) => Object.keys(map)
    .sort()
    .map(cmd => `  '${cmd}': [${map[cmd].map(f => `'${f}'`).join(', ')}],`)
    .join('\n');
  const entries = render(registry);
  return `// AUTO-GENERATED by scripts/generate-flag-registry.ts — do not edit by hand.
// Regenerate: bun run build:flag-registry
// Freshness + drift pinned by test/cli-flag-validation.test.ts (#2185).
//
// Merge conflict here? Do not hand-merge it. This file is regenerated on most
// upstream waves, so a branch that also regenerates it conflicts on the whole
// body. Take the base branch's copy wholesale, then re-run the command above —
// the freshness test named above fails loudly if that regeneration was done
// against the wrong base.
//
// Per-command legal flags for CLI_ONLY commands, derived from each command's
// source (case block + imported modules + one level of relative imports +
// scripts/generate-flag-registry.ts EXTRA_FLAGS). Deliberately over-inclusive
// (help-text mentions count): accepting an ignored flag is the pre-#2185
// status quo; missing a real one breaks working invocations.
export const CLI_FLAG_REGISTRY: Record<string, readonly string[]> = {
${entries}
};

// Routing flags a fix naming each CLI-only command carries (A1 render-time pin,
// src/core/fix-routing.ts): '--brain' when the command opens its brain (not a
// pre-connect command, or its code reads the global brain option); '--source'
// (or the declared '--source-id') when the command-table record declares
// routes_source (consumption-checked).
export const CLI_ROUTING_FLAGS: Record<string, readonly string[]> = {
${render(routing)}
};
`;
}

if (import.meta.main) {
  const { registry, routing } = buildFlagArtifacts(ROOT);
  const outPath = join(ROOT, 'src/core/cli-flag-registry.generated.ts');
  writeFileSync(outPath, renderRegistryModule(registry, routing));
  const n = Object.keys(registry).length;
  const total = Object.values(registry).reduce((a, v) => a + v.length, 0);
  console.log(`wrote ${outPath} (${n} commands, ${total} flag entries)`);
}
