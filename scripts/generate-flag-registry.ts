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
 * flag would break working invocations on upgrade. `--flag` literals that are
 * git argv or data-table prose are blanked first (stripNonFlagSpans, #8867):
 * a git argument is not a flag the command parses.
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
import ts from 'typescript';
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
 * `gbrain serve --watch` pass validation.
 */
const EXCLUDED_MODULES = ['thin-client-routing.ts', 'persistence-delegate.ts', 'job-isolation.ts', 'strict-args.ts', 'direct-pool-profile.ts', 'flag-equals.ts'];

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
 * #8867 — blank git-argument and data-table literals before the flag scan.
 *
 * The flag scan is textual: every `--flag` literal in a command's modules
 * becomes legal for that command. Two shapes are not gbrain flags at all:
 *
 *  1. Data tables — BEHAVIOR_CHANGES rows (changelog prose naming git
 *     invocations, e.g. an uncommitted `git merge --squash`) and the
 *     hardened-git allow-list tables (git's own per-subcommand options).
 *     Their literals are data, never parsed by the command.
 *  2. Git-spawn arguments — literals passed as argv to a git child process:
 *     a direct spawn (`execFileSync('git', ['-C', root, 'status',
 *     '--porcelain'])`), a same-file wrapper (bootstrap-checks' `g('status',
 *     '--porcelain')`), an imported runner (hardenedGitSync), or a bare
 *     `git([...])` call (every `git(...)` call in this repo is a git
 *     invocation: sync-git.ts's `git`, effect-git.ts's `git`, withGit
 *     callback params, frontmatter.ts's local wrapper). A `--porcelain`
 *     there is git's flag, not the command's.
 *
 * The strip is AST-based (typescript is already a dependency): string
 * contents are blanked with spaces, newlines preserved, so the flag scan
 * sees nothing to collect and no other scan shifts lines. It runs on the
 * raw source BEFORE stripComments — the comment stripper is a hand scanner
 * that can desync on a regex literal containing backticks, and the AST
 * parse of the true source is exact where the scanner is not.
 *
 * Known limits: argv held in a variable is only followed one hop within the
 * same function (`const args = [...]; execFileSync('git', args, ...)` plus
 * `args.push('--x')`, including conditional initializers); a variable built
 * across functions, and a git runner reached through two or more import hops,
 * still leak. A `--flag` inside a shell-script string (commit-guard.ts's hook
 * script naming `git rev-parse --absolute-git-dir`) is prose, not a TS git
 * call, so it also still leaks. And a flag another command genuinely consumes
 * (orphans' `--count`, read by a module doctor imports) stays in the row:
 * that is the generator's deliberate over-inclusion, not a git argument.
 * None of these changes what the command itself parses.
 */
const DATA_TABLE_VARIABLES = new Set([
  // Changelog prose: BEHAVIOR_CHANGES rows name git invocations in text.
  'BEHAVIOR_CHANGES',
  // hardened-git.ts: git's own per-subcommand option allow-lists.
  'ALLOWED_OPTIONS',
  'REQUIRED_OPTIONS',
  'HISTORY_LOG_OPTIONS',
  'REASON_LOG_OPTIONS',
  'LOG_SHAPES',
]);

/** Child-process spawns that take the program as their first argument. */
const SPAWN_CALLEES = new Set([
  'execFileSync',
  'execFile',
  'spawnSync',
  'spawn',
  // Bounded-spawn helpers with the same (program, argv, options) shape.
  'execFileBounded',
  'tryExecAsync',
  // promisify(execFile): sync-discovery.ts's syncGitAsync.
  'execFileAsync',
]);

/** Cache of a module's same-file git-runner names, keyed by absolute path
 * and validated against the file's current content (fixture trees are
 * re-created per test run, so a bare path key would go stale). */
const runnerCache = new Map<string, { content: string; runners: Set<string> }>();

function blankSpans(src: string, spans: Array<[number, number]>): string {
  if (!spans.length) return src;
  const chars = src.split('');
  for (const [start, end] of spans) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

/** Blank every string literal's contents under `node` (quotes kept). */
function blankStringsIn(spans: Array<[number, number]>, node: ts.Node): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const start = node.getStart() + 1;
    const end = node.getEnd() - 1;
    if (end > start) spans.push([start, end]);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    const head = node.head;
    const hs = head.getStart() + 1;
    const he = head.getEnd() - 2;
    if (he > hs) spans.push([hs, he]);
    for (const span of node.templateSpans) {
      const lit = span.literal;
      const ls = lit.getStart() + 1;
      const le = lit.getEnd() - (ts.isTemplateTail(lit) ? 1 : 2);
      if (le > ls) spans.push([ls, le]);
      blankStringsIn(spans, span.expression);
    }
    return;
  }
  ts.forEachChild(node, child => blankStringsIn(spans, child));
}

/** Functions defined in one file, by name: named declarations plus
 * variable-initialized function/arrow expressions. */
function collectFnLikes(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      out.set(node.name.text, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      out.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function isGitSpawnCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (!ts.isIdentifier(callee) || !SPAWN_CALLEES.has(callee.text)) return false;
  const first = node.arguments[0];
  return !!first && ts.isStringLiteral(first) && first.text === 'git';
}

/** True when `fn`'s body runs git directly or calls a known runner. */
function fnEvidence(fn: ts.Node): { spawnsGit: boolean; callees: Set<string> } {
  const callees = new Set<string>();
  let spawnsGit = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isGitSpawnCall(node)) spawnsGit = true;
      const callee = node.expression;
      if (ts.isIdentifier(callee)) callees.add(callee.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return { spawnsGit, callees };
}

/**
 * Same-file git runners, fixpointed from `seed`: a function that spawns git
 * (`execFileSync('git', …)`) or calls a runner. `git` is always seeded — a
 * bare `git(...)` call is a git invocation wherever it is bound. Each
 * function's call evidence is computed once; the fixpoint is set
 * intersection, not a re-walk (re-walking every body per iteration made the
 * full registry build 3x slower).
 */
function collectRunnerNames(sf: ts.SourceFile, seed: Set<string>): Set<string> {
  const runners = new Set(seed);
  const fnLikes = collectFnLikes(sf);
  const evidence = new Map<string, { spawnsGit: boolean; callees: Set<string> }>();
  for (const [name, fn] of fnLikes) evidence.set(name, fnEvidence(fn));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, ev] of evidence) {
      if (runners.has(name)) continue;
      if (ev.spawnsGit || [...ev.callees].some(c => runners.has(c))) {
        runners.add(name);
        changed = true;
      }
    }
  }
  return runners;
}

/**
 * Imported bindings that are git runners in their home module (one hop:
 * `import { hardenedGitSync } from '../hardened-git.ts'`). The home module
 * is analysed same-file only — a runner reached through two import hops is
 * not followed (see the known limit above).
 */
function importedRunnerNames(sf: ts.SourceFile, filePath: string): Set<string> {
  const out = new Set<string>();
  const dir = dirname(filePath);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith('.')) continue;
    const target = resolvePath(dir, spec);
    if (!existsSync(target)) continue;
    let content: string;
    try {
      content = readFileSync(target, 'utf-8');
    } catch {
      continue;
    }
    const cached = runnerCache.get(target);
    let runners: Set<string>;
    if (cached && cached.content === content) {
      runners = cached.runners;
    } else {
      let targetSf: ts.SourceFile;
      try {
        targetSf = ts.createSourceFile(target, content, ts.ScriptTarget.Latest, true);
      } catch {
        continue;
      }
      runners = collectRunnerNames(targetSf, new Set(['git']));
      runnerCache.set(target, { content, runners });
    }
    const bindings = stmt.importClause;
    if (!bindings || !bindings.namedBindings || !ts.isNamedImports(bindings.namedBindings)) continue;
    for (const el of bindings.namedBindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (runners.has(imported)) out.add(el.name.text);
    }
  }
  return out;
}

/** True when `node` is a git call (direct spawn, bare `git(...)`, or a
 * wrapper runner). Spawn calls additionally require the program to be the
 * literal 'git' — `execFileBounded(cli.cmd, …)` is not one. */
function isGitCall(node: ts.CallExpression, runners: Set<string>): boolean {
  const callee = node.expression;
  if (!ts.isIdentifier(callee)) return false;
  if (SPAWN_CALLEES.has(callee.text)) return isGitSpawnCall(node);
  return callee.text === 'git' || runners.has(callee.text);
}

export function stripNonFlagSpans(src: string, filePath?: string): string {
  // Fast path: no `--` anywhere means no flag literal to blank (and no
  // git-arg or table literal can carry one).
  if (!src.includes('--')) return src;
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(filePath ?? 'module.ts', src, ts.ScriptTarget.Latest, true);
  } catch {
    return src;
  }
  const spans: Array<[number, number]> = [];
  // Runners: bare `git`, imported runners, then same-file wrappers over them.
  const seed = new Set<string>(['git']);
  if (filePath) for (const name of importedRunnerNames(sf, filePath)) seed.add(name);
  const runners = collectRunnerNames(sf, seed);

  // Pass 1 — argv variables: identifiers handed to a git call as argv, and
  // array-literal declarations, each tagged with its enclosing function so a
  // same-named variable in another function is never blanked by mistake.
  type FnTag = ts.Node | null;
  const argvUses: Array<{ name: string; fn: FnTag }> = [];
  // Array literals an argv variable is built from: a plain `const args =
  // [...]` or a conditional (`const args = c ? [...] : [...]`, drift-watch).
  const argvArraysIn = (node: ts.Node): ts.ArrayLiteralExpression[] => {
    if (ts.isArrayLiteralExpression(node)) return [node];
    if (ts.isConditionalExpression(node)) return [...argvArraysIn(node.whenTrue), ...argvArraysIn(node.whenFalse)];
    if (ts.isParenthesizedExpression(node)) return argvArraysIn(node.expression);
    return [];
  };
  const arrayDecls: Array<{ name: string; init: ts.ArrayLiteralExpression; fn: FnTag }> = [];
  const fnStack: FnTag[] = [];
  const pass1 = (node: ts.Node): void => {
    const isFn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
    if (isFn) fnStack.push(node);
    if (ts.isCallExpression(node) && isGitCall(node, runners)) {
      for (const arg of node.arguments) {
        if (ts.isIdentifier(arg)) argvUses.push({ name: arg.text, fn: fnStack[fnStack.length - 1] ?? null });
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      for (const init of argvArraysIn(node.initializer)) {
        arrayDecls.push({ name: node.name.text, init, fn: fnStack[fnStack.length - 1] ?? null });
      }
    }
    ts.forEachChild(node, pass1);
    if (isFn) fnStack.pop();
  };
  pass1(sf);
  // Blank an argv variable's initializer when the git call that used it can
  // see the declaration (same function, or a top-level declaration).
  for (const use of argvUses) {
    for (const decl of arrayDecls) {
      if (decl.name === use.name && (decl.fn === null || decl.fn === use.fn)) {
        blankStringsIn(spans, decl.init);
      }
    }
  }

  // Pass 2 — blank git argv and data tables.
  const pass2 = (node: ts.Node): void => {
    const isFn = ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
    if (isFn) fnStack.push(node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && DATA_TABLE_VARIABLES.has(node.name.text) && node.initializer) {
      // The whole initializer is data (prose / git options), never a flag
      // this command parses. Do not recurse into it.
      spans.push([node.initializer.getStart(), node.initializer.getEnd()]);
    } else if (ts.isArrayLiteralExpression(node) && node.elements.length > 0
      && ts.isStringLiteral(node.elements[0]) && node.elements[0].text === 'git') {
      // A generic runner's argv: `runner(['git', '-C', root, 'status', …])`.
      blankStringsIn(spans, node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (isGitCall(node, runners)) {
        for (const arg of node.arguments) {
          if (ts.isArrayLiteralExpression(arg) || ts.isStringLiteral(arg)
            || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg)) {
            blankStringsIn(spans, arg);
          }
        }
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'push'
        && ts.isIdentifier(callee.expression)
        && argvUses.some(u => u.name === callee.expression.text
          && (u.fn === (fnStack[fnStack.length - 1] ?? null)))) {
        // `args.push('--untracked-files=no')` builds the argv of a git call
        // in the same function.
        for (const arg of node.arguments) {
          if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg)) {
            blankStringsIn(spans, arg);
          }
        }
      }
    }
    if (!(ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && DATA_TABLE_VARIABLES.has(node.name.text) && node.initializer)) {
      ts.forEachChild(node, pass2);
    }
    if (isFn) fnStack.pop();
  };
  // Reuse the stack (empty after pass 1).
  pass2(sf);
  return blankSpans(src, spans);
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
    if (mod) {
      const modPath = join(root, mod.path);
      addBlock(record.name, stripComments(stripNonFlagSpans(readSrc(modPath), modPath)), dirname(modPath));
    }
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
    for (const f of flagsInText(depthZeroText)) { flags.add(f); depthZero.add(f); }

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
        const sfCode = stripComments(stripNonFlagSpans(sfSrc, sfPath));
        depthZeroText += sfCode;
        for (const f of flagsInText(sfCode)) { flags.add(f); depthZero.add(f); }
        for (const dep of relativeImports(sfSrc, dirname(sfPath))) {
          for (const f of flagsInText(stripComments(stripNonFlagSpans(readSrc(dep), dep)))) flags.add(f);
        }
      }
    }

    for (const rel of DELEGATED_MODULES[command] ?? []) {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- build-time generator over this repository's own source tree; every joined segment is a constant module path from DELEGATED_MODULES
      const path = join(root, rel);
      if (!existsSync(path)) continue;
      const code = stripComments(stripNonFlagSpans(readSrc(path), path));
      depthZeroText += code;
      for (const f of flagsInText(code)) { flags.add(f); depthZero.add(f); }
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
