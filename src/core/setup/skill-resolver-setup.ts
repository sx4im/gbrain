/**
 * skill-resolver-setup.ts — `gbrain setup <claude-code|codex> --skill-loading
 * resolve` (and its undo, `--skill-loading off|spring` and `setup --remove`).
 *
 * On: build the harness's user-level catalog (<harness>-user, from
 * ~/.claude/skills; Codex: ~/.agents/skills and CODEX_HOME/skills), and only
 * when that build indexed at least one skill, write the file-plane keys
 * (skill-resolver-config.ts) and the lane's hook (skill-resolver-hook.ts).
 * Otherwise nothing is written and the result carries
 * skill_resolver_setup_incomplete with the scanned directories. A re-run with
 * a fresh catalog, the keys and the hook in place changes nothing. It ends
 * with a sample block and an "on; N skills; fresh" status line.
 *
 * A followed shared brain (GBRA-399, #9077 option 1) adds a second catalog,
 * <harness>-shared, snapshotted from the authorized view the caller's
 * sharedSkills lister returns (list_skills): the lane ranks it next to the
 * user catalog, each line naming its get_skill key. The shared catalog
 * counts toward the "at least one skill" gate, so a follow with no local
 * skills still turns the lane on; a lister failure never breaks the user
 * catalog (the shared step is skipped and setup proceeds). The snapshot is
 * refreshed on every setup re-run whose view moved, and on
 * sync_brain_skills (the adapter calls refreshSharedSnapshot); the lane
 * itself never judges its freshness. In production the lister is
 * fetchSharedCatalogView: the gbrain binary's read-only
 * `skills --schema-version 2 --json`, so setup still never opens the
 * database itself. A dry run never reads the view: it previews the user
 * catalog only and notes the shared catalog as skipped (so a follow with
 * no local skills previews as incomplete — re-run without --dry-run to
 * snapshot it). --skill-loading off removes it with
 * the rest (isHarnessCatalog).
 *
 * Off: remove the hook, the keys, this harness's catalogs (user and project)
 * and, when no harness is left on, the session state and the lane log.
 * Returns null when there is nothing of the resolver's for this harness, so
 * an install that never turned it on gets no new output.
 *
 * Default setup (no --skill-loading resolve) never writes a catalog, and
 * nothing here writes into the hook launcher's directory beyond the launcher
 * setup already writes.
 */
import { spawnSync } from '../spawn.ts';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeUserSkillsDir, codexConfigPath } from '../bootstrap/host-specs.ts';
import { buildSkillIndex, catalogStatus, listCatalogs, removeSkillIndex } from '../skills/resolver/build.ts';
import { ResolverError } from '../skills/resolver/errors.ts';
import { logsDir, sessionsDir, skillIndexRoot } from '../skills/resolver/paths.ts';
import { resolveSkills } from '../skills/resolver/resolve.ts';
import { readDirSources } from '../skills/resolver/sources.ts';
import { refreshSharedSnapshot, sharedCatalogName, type SharedCatalogEntry, type SharedSkillsView } from '../skills/resolver/shared-snapshot.ts';
import { readResolverConfig, resolverHarnesses, setResolverHarness } from './skill-resolver-config.ts';
import { inspectSkillResolverHook, removeSkillResolverHook, syncSkillResolverHook, type ResolverHarness, type ResolverHookPaths } from './skill-resolver-hook.ts';

export interface ResolverStep { step: 'catalog' | 'config' | 'hook' | 'state'; action: 'write' | 'keep' | 'remove' | 'skip'; detail: string }
export interface ResolverSetupError { code: 'skill_resolver_setup_incomplete' | 'skill_resolver_config_unreadable'; message: string; scanned: string[] }
export interface ResolverSetupResult {
  harness: ResolverHarness;
  mode: 'on' | 'off';
  steps: ResolverStep[];
  status?: { catalog: string; skills: number; fresh: boolean; line: string };
  sample?: string;
  error?: ResolverSetupError;
}

export const userCatalog = (harness: ResolverHarness) => `${harness}-user`;
const isHarnessCatalog = (harness: ResolverHarness, name: string) => name === userCatalog(harness) || name === sharedCatalogName(harness) || name.startsWith(`${harness}-project-`);

/**
 * The followed shared catalog, as the authorized view (list_skills) returns
 * it. The caller owns the brain connection; setup only receives the view.
 * Null means this install follows no shared brain. A throw means the view
 * could not be read: setup skips the shared catalog and still turns the
 * lane on from the user catalog alone.
 */
export type SharedSkillsLister = () => Promise<SharedSkillsView | null>;

/**
 * The followed-catalog view, read through the gbrain binary (read-only).
 * Setup stays engine-free: the child opens the brain, setup never does.
 * Pages the v2 catalog (limit 100) until the cursor runs out; a view token
 * that moves mid-read, non-JSON output, or a refusal other than "no brain"
 * throws, and the caller skips the shared catalog. Null means this install
 * has no brain, so there is no follow to snapshot.
 */
export async function fetchSharedCatalogView(gbrainBin: string, opts: { timeoutMs?: number } = {}): Promise<SharedSkillsView | null> {
  if (!gbrainBin?.trim()) throw new Error('no gbrain binary to read the shared catalog from');
  const skills: SharedCatalogEntry[] = [];
  let cursor: string | undefined;
  let viewToken: string | undefined;
  let brainId: string | undefined;
  for (let page = 0; page < 100; page++) {
    const r = spawnSync(gbrainBin, ['skills', '--schema-version', '2', '--limit', '100', '--json', ...(cursor ? ['--cursor', cursor] : [])],
      { encoding: 'utf8', timeout: opts.timeoutMs ?? 30_000 }) as { status: number | null; stdout?: string; stderr?: string; error?: Error };
    if (r.error) throw new Error(`could not read the shared catalog (${r.error.message})`);
    let parsed: unknown;
    try { parsed = JSON.parse(r.stdout ?? ''); } catch { throw new Error('the shared catalog read returned non-JSON output'); }
    const p = parsed as { error?: unknown; code?: unknown; message?: unknown; schema_version?: unknown; brain_id?: unknown; view_token?: unknown; skills?: unknown; next_cursor?: unknown };
    if (p.code === 'no_brain') return null;
    if (p.error !== undefined || p.code !== undefined) throw new Error(`the shared catalog is unavailable (${typeof p.code === 'string' ? p.code : 'unknown'}${typeof p.message === 'string' && p.message ? `: ${p.message}` : ''})`);
    if (p.schema_version !== 2 || typeof p.brain_id !== 'string' || typeof p.view_token !== 'string' || !Array.isArray(p.skills)) {
      throw new Error('the shared catalog read returned an unexpected shape');
    }
    if (viewToken !== undefined && p.view_token !== viewToken) throw new Error('the shared catalog changed while it was read; retry the setup');
    if (brainId === undefined) brainId = p.brain_id;
    viewToken = p.view_token;
    for (const s of p.skills as Record<string, unknown>[]) {
      skills.push({ qualified_id: typeof s.qualified_id === 'string' ? s.qualified_id : '',
        name: typeof s.name === 'string' ? s.name : '',
        description: typeof s.description === 'string' ? s.description : '',
        triggers: Array.isArray(s.triggers) ? (s.triggers as unknown[]).filter((t): t is string => typeof t === 'string') : [],
        usable: typeof s.usable === 'boolean' ? s.usable : undefined,
        delivery: s.delivery === 'complete' || s.delivery === 'prose_only' ? s.delivery : undefined });
    }
    cursor = typeof p.next_cursor === 'string' ? p.next_cursor : undefined;
    if (!cursor) return { brain_id: brainId, view_token: viewToken, skills };
  }
  throw new Error('the shared catalog exceeds its bounded page count; narrow the authorized source view');
}

/** The installed router skill (gbrain-shared-<hash>) in the harness's user skills dirs, if one is present: the snapshot records its name as each shared skill's load path. */
function findSharedRouter(harness: ResolverHarness): string | undefined {
  for (const dir of harnessSkillDirs(harness)) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const router = names.filter(n => n.startsWith('gbrain-shared-')).sort()[0];
    if (router) return router;
  }
  return undefined;
}

/** The user-level skill directories a harness loads natively, whether or not they exist. */
export function harnessSkillDirs(harness: ResolverHarness): string[] {
  if (harness === 'claude-code') return [claudeUserSkillsDir()];
  return [join(process.env.HOME?.trim() || '', '.agents', 'skills'), join(dirname(codexConfigPath()), 'skills')];
}

function incomplete(scanned: string[] | null, why: string, sideEffects: string): ResolverSetupError {
  return { code: 'skill_resolver_setup_incomplete', scanned: scanned ?? [],
    message: `The skill resolver was not turned on: ${why}${scanned ? ` (scanned ${scanned.join(', ')})` : ''}. ${sideEffects}` };
}

/** Turn the lane on for one harness (or preview it). */
export async function syncSkillResolverSetup(opts: { harness: ResolverHarness; gbrainBin: string; gbrainHome?: string; home: string; dryRun: boolean; paths?: ResolverHookPaths; sharedSkills?: SharedSkillsLister }): Promise<ResolverSetupResult> {
  const { harness, home, dryRun } = opts;
  const out: ResolverSetupResult = { harness, mode: 'on', steps: [] };
  const cfg = readResolverConfig(home);
  if (cfg.state === 'unreadable') return { ...out, error: { code: 'skill_resolver_config_unreadable', scanned: [], message: `${cfg.path} cannot be read (${cfg.why}), so setup did not touch it or anything else for the skill resolver.` } };
  if (!opts.gbrainBin.startsWith('/')) return { ...out, error: incomplete(null, 'no absolute gbrain binary was found for the hook (harnesses inherit no PATH); pass --gbrain-bin', 'Nothing was written.') };
  const catalog = userCatalog(harness);
  const dirs = harnessSkillDirs(harness).filter((d) => existsSync(d));
  const status = existsSync(join(skillIndexRoot(home), catalog, 'receipt.json')) ? await catalogStatus(catalog, { home }) : null;
  const sameDirs = JSON.stringify(status?.receipt?.source.dirs ?? null) === JSON.stringify(dirs);
  const fresh = !!status?.fresh && sameDirs && (status.receipt?.skill_count ?? 0) > 0;
  const where = join(skillIndexRoot(home), catalog);
  // The shared view is fetched up front (read-only): it decides whether a
  // setup with no local skill directory can still turn the lane on. A dry
  // run never reads it: a preview must not spawn a live brain read — the
  // child bun run writes its module cache under the previewed home, so a
  // dry run would no longer write nothing.
  let sharedView: SharedSkillsView | null = null;
  let sharedFetchFailed: string | null = null;
  if (opts.sharedSkills && !dryRun) {
    try { sharedView = await opts.sharedSkills(); } catch (e) { sharedFetchFailed = e instanceof Error ? e.message : String(e); }
  }
  if (dirs.length === 0 && !sharedView?.skills.length) return { ...out, error: incomplete(harnessSkillDirs(harness), 'no user-level skill directory exists', 'Nothing was written.') };

  let skills = status?.receipt?.skill_count ?? 0;
  let removedEmptyUser = false;
  if (dirs.length > 0) {
    if (dryRun) {
      if (!fresh) skills = readDirSources(dirs).skills.length;
      if (skills > 0) out.steps.push({ step: 'catalog', action: fresh ? 'keep' : 'write', detail: `${skills} skills from ${dirs.join(', ')} into ${where}` });
    } else if (!fresh) {
      try {
        skills = (await buildSkillIndex({ catalog, dirs, harness }, { home })).catalog.skill_count;
      } catch (e) {
        return { ...out, error: incomplete(dirs, `the catalog build failed (${e instanceof ResolverError ? e.code : (e as Error).message})`, 'Nothing else was written.') };
      }
      if (skills < 1) { await removeSkillIndex(catalog, { home }); removedEmptyUser = true; }
      else out.steps.push({ step: 'catalog', action: 'write', detail: `${skills} skills from ${dirs.join(', ')} into ${where}` });
    } else out.steps.push({ step: 'catalog', action: 'keep', detail: `${skills} skills from ${dirs.join(', ')} in ${where}` });
  }

  // The shared snapshot, refreshed when the view moved (or removed when the
  // view is empty). A fetch failure skips it and never blocks the lane.
  let sharedSkills = 0;
  let sharedAction: 'write' | 'keep' | 'remove' | null = null;
  if (sharedView) {
    const r = await refreshSharedSnapshot(home, harness, sharedView, { dryRun, router: findSharedRouter(harness) });
    sharedSkills = r.skills;
    sharedAction = r.action;
    if (r.action) out.steps.push({ step: 'catalog', action: r.action, detail: `${r.skills} shared skills from brain ${sharedView.brain_id} in ${join(skillIndexRoot(home), sharedCatalogName(harness))}` });
  } else if (sharedFetchFailed) {
    out.steps.push({ step: 'catalog', action: 'skip', detail: `shared catalog unavailable (${sharedFetchFailed}); the user catalog still applies` });
  } else if (dryRun && opts.sharedSkills) {
    out.steps.push({ step: 'catalog', action: 'skip', detail: 'shared catalog not previewed in dry-run (needs a live read); the user catalog still applies' });
  }
  const total = skills + sharedSkills;
  if (total < 1) {
    return { ...out, error: incomplete(dirs, 'the scan found no model-invocable skill',
      removedEmptyUser ? `The empty catalog at ${where} was removed; nothing else was written.`
        : sharedAction === 'remove' ? 'The shared catalog was removed; nothing else was written.'
          : dryRun ? 'Nothing would be written.' : 'Nothing was written.') };
  }

  const keys = setResolverHarness(cfg, harness, true, dryRun);
  out.steps.push({ step: 'config', action: keys.changed ? 'write' : 'keep', detail: `skills.resolver.enabled = true, skills.resolver.harnesses includes ${harness} in ${cfg.path}` });
  const hook = syncSkillResolverHook({ harness, gbrainBin: opts.gbrainBin, gbrainHome: opts.gbrainHome, paths: opts.paths, dryRun });
  if (hook.action === 'refuse') return { ...out, error: incomplete(dirs, hook.detail, 'The catalog and the config keys were written; re-run after fixing that.') };
  out.steps.push({ step: 'hook', action: hook.action === 'keep' ? 'keep' : 'write', detail: hook.detail });
  if (dryRun) return out;

  const after = await catalogStatus(catalog, { home });
  const sampleText = dirs.length ? readDirSources(dirs).skills[0]?.description ?? '' : '';
  const sample = sampleText ? (await resolveSkills({ message: sampleText, harness }, { home, catalogs: [catalog], failOpen: true })).output.block : '';
  const n = total;
  const isFresh = dirs.length > 0 ? after.fresh === true : sharedAction === 'keep' || sharedAction === 'write';
  return { ...out, sample, status: { catalog, skills: n, fresh: isFresh, line: `skill resolver: on; ${n} skills; ${isFresh ? 'fresh' : 'stale'}` } };
}

/** Whether anything of the resolver's exists for this harness (keys, hook or catalogs). */
export function skillResolverPresent(harness: ResolverHarness, home: string, paths?: ResolverHookPaths): boolean {
  const cfg = readResolverConfig(home);
  if (cfg.state === 'unreadable') return true;
  return resolverHarnesses(cfg.state === 'ok' ? cfg.doc : null).includes(harness) || inspectSkillResolverHook(harness, paths).state !== 'absent'
    || listCatalogs(home).some((n) => isHarnessCatalog(harness, n));
}

/** Turn the lane off for one harness (or preview it); null when nothing of it exists. */
export async function removeSkillResolverSetup(opts: { harness: ResolverHarness; home: string; dryRun: boolean; paths?: ResolverHookPaths }): Promise<ResolverSetupResult | null> {
  const { harness, home, dryRun } = opts;
  if (!skillResolverPresent(harness, home, opts.paths)) return null;
  const out: ResolverSetupResult = { harness, mode: 'off', steps: [] };
  const cfg = readResolverConfig(home);
  if (cfg.state === 'unreadable') return { ...out, error: { code: 'skill_resolver_config_unreadable', scanned: [], message: `${cfg.path} cannot be read (${cfg.why}), so setup did not touch it or anything else for the skill resolver.` } };
  const hook = removeSkillResolverHook({ harness, paths: opts.paths, dryRun });
  if (hook.action === 'remove') out.steps.push({ step: 'hook', action: 'remove', detail: hook.detail });
  const keys = setResolverHarness(cfg, harness, false, dryRun);
  const left = resolverHarnesses(cfg.state === 'ok' ? cfg.doc : null).filter((h) => h !== harness);
  if (keys.changed) out.steps.push({ step: 'config', action: 'remove', detail: `${left.length ? `${harness} from skills.resolver.harnesses` : 'skills.resolver.enabled and skills.resolver.harnesses'} in ${cfg.path}${keys.deletedFile ? ' (the file held nothing else, so it was removed)' : ''}` });
  for (const name of listCatalogs(home).filter((n) => isHarnessCatalog(harness, n))) {
    if (!dryRun) await removeSkillIndex(name, { home });
    out.steps.push({ step: 'catalog', action: 'remove', detail: join(skillIndexRoot(home), name) });
  }
  if (left.length === 0) {
    for (const p of [sessionsDir(home), logsDir(home)]) {
      if (!existsSync(p)) continue;
      if (!dryRun) rmSync(p, { recursive: true, force: true });
      out.steps.push({ step: 'state', action: 'remove', detail: p });
    }
  }
  return out;
}

/** One human line per step, matching setup's step lines. */
export function describeResolverSetup(r: ResolverSetupResult, dryRun: boolean): string[] {
  const lines = r.steps.map((s) => `  ${(dryRun && s.action !== 'keep' && s.action !== 'skip' ? `would ${s.action}` : s.action).padEnd(8)} ${'resolver'.padEnd(7)} ${s.step}: ${s.detail}`);
  if (r.sample) lines.push('Sample skill-resolver block:', ...r.sample.split('\n').map((l) => `    ${l}`));
  if (r.status) lines.push(r.status.line);
  return lines;
}
