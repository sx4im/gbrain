/**
 * skill-resolver-setup.ts — `gbrain setup <claude-code|codex> --skill-loading
 * resolve` (and its undo, `--skill-loading off|spring` and `setup --remove`).
 *
 * On: build the harness's user-level catalog (<harness>-user, from
 * ~/.claude/skills; Codex: ~/.agents/skills and CODEX_HOME/skills), and only
 * when that build indexed at least one skill, write the file-plane keys
 * (skill-resolver-config.ts) and the lane's hook (skill-resolver-hook.ts).
 * When the harness follows a shared brain it also snapshots the followed
 * catalog into <harness>-shared (skill-resolver-shared-snapshot.ts), rebuilt
 * when its view_token moves and removed when the follow is gone.
 * Otherwise nothing is written and the result carries
 * skill_resolver_setup_incomplete with the scanned directories. A re-run with
 * a fresh catalog, the keys and the hook in place changes nothing. It ends
 * with a sample block and an "on; N skills; fresh" status line.
 *
 * Off: remove the hook, the keys, this harness's catalogs (user, shared and
 * project) and, when no harness is left on, the session state and the lane log.
 * Returns null when there is nothing of the resolver's for this harness, so
 * an install that never turned it on gets no new output.
 *
 * Default setup (no --skill-loading resolve) never writes a catalog, and
 * nothing here writes into the hook launcher's directory beyond the launcher
 * setup already writes.
 */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claudeUserSkillsDir, codexConfigPath } from '../bootstrap/host-specs.ts';
import { buildSkillIndex, catalogStatus, listCatalogs, readReceipt, removeSkillIndex } from '../skills/resolver/build.ts';
import { ResolverError } from '../skills/resolver/errors.ts';
import { catalogFile, logsDir, sessionsDir, skillIndexRoot } from '../skills/resolver/paths.ts';
import { resolveSkills } from '../skills/resolver/resolve.ts';
import { readDirSources } from '../skills/resolver/sources.ts';
import { readResolverConfig, resolverHarnesses, setResolverHarness } from './skill-resolver-config.ts';
import { inspectSkillResolverHook, removeSkillResolverHook, syncSkillResolverHook, type ResolverHarness, type ResolverHookPaths } from './skill-resolver-hook.ts';
import { buildSharedSnapshot, findSharedFollow, readSharedSnapshotView, sharedCatalogName } from './skill-resolver-shared-snapshot.ts';

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
export async function syncSkillResolverSetup(opts: { harness: ResolverHarness; gbrainBin: string; gbrainHome?: string; home: string; dryRun: boolean; paths?: ResolverHookPaths }): Promise<ResolverSetupResult> {
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
  if (dirs.length === 0) return { ...out, error: incomplete(harnessSkillDirs(harness), 'no user-level skill directory exists', 'Nothing was written.') };

  let skills = status?.receipt?.skill_count ?? 0;
  if (dryRun) {
    if (!fresh) skills = readDirSources(dirs).skills.length;
    if (skills < 1) return { ...out, error: incomplete(dirs, 'the scan found no model-invocable skill', 'Nothing would be written.') };
    out.steps.push({ step: 'catalog', action: fresh ? 'keep' : 'write', detail: `${skills} skills from ${dirs.join(', ')} into ${where}` });
  } else if (!fresh) {
    try {
      skills = (await buildSkillIndex({ catalog, dirs, harness }, { home })).catalog.skill_count;
    } catch (e) {
      return { ...out, error: incomplete(dirs, `the catalog build failed (${e instanceof ResolverError ? e.code : (e as Error).message})`, 'Nothing else was written.') };
    }
    if (skills < 1) {
      await removeSkillIndex(catalog, { home });
      return { ...out, error: incomplete(dirs, 'the scan found no model-invocable skill', `The empty catalog at ${where} was removed; nothing else was written.`) };
    }
    out.steps.push({ step: 'catalog', action: 'write', detail: `${skills} skills from ${dirs.join(', ')} into ${where}` });
  } else out.steps.push({ step: 'catalog', action: 'keep', detail: `${skills} skills from ${dirs.join(', ')} in ${where}` });

  // A followed shared catalog: snapshot its entries out of the sync cache
  // into `<harness>-shared`, so the lane ranks them per turn (#9077 option 1).
  // The snapshot is keyed on the cache's view_token: a re-run rebuilds it
  // only when the view moved (after a `sync_brain_skills` refresh), and a
  // follow that is gone takes its orphaned snapshot with it.
  const shared = sharedCatalogName(harness);
  const sharedWhere = join(skillIndexRoot(home), shared);
  const follow = findSharedFollow(home, harness);
  if (follow) {
    const snap = buildSharedSnapshot(follow);
    const status = existsSync(catalogFile(home, shared, 'receipt.json')) ? await catalogStatus(shared, { home }) : null;
    const viewMatches = readSharedSnapshotView(home, shared) === follow.view_token;
    const sharedFresh = !!status?.fresh && viewMatches && (status.receipt?.skill_count ?? 0) > 0;
    const sharedExists = (await readReceipt(home, shared)) !== null;
    if (dryRun) {
      if (snap.skills < 1) {
        out.steps.push({ step: 'catalog', action: sharedExists ? 'remove' : 'skip',
          detail: `the followed shared catalog has no usable skill; ${sharedWhere} would ${sharedExists ? 'be removed' : 'stay as it is'}` });
      } else {
        out.steps.push({ step: 'catalog', action: sharedFresh ? 'keep' : 'write', detail: `${snap.skills} shared skills from ${follow.brain_id} into ${sharedWhere}` });
      }
    } else if (!sharedFresh) {
      if (snap.skills < 1) {
        if (sharedExists) await removeSkillIndex(shared, { home });
        out.steps.push({ step: 'catalog', action: 'skip',
          detail: `the followed shared catalog has no usable skill; ${shared} was ${sharedExists ? 'removed' : 'not built'}` });
      } else {
        try {
          await buildSkillIndex({ catalog: shared, fromJson: snap.text, fromJsonStdin: true, harness }, { home });
          out.steps.push({ step: 'catalog', action: 'write', detail: `${snap.skills} shared skills from ${follow.brain_id} into ${sharedWhere}` });
        } catch (e) {
          out.steps.push({ step: 'catalog', action: 'skip',
            detail: `the shared catalog build failed (${e instanceof ResolverError ? e.code : (e as Error).message}); the user catalog and the lane are unaffected` });
        }
      }
    } else out.steps.push({ step: 'catalog', action: 'keep', detail: `${snap.skills} shared skills from ${follow.brain_id} in ${sharedWhere}` });
  } else if (readSharedSnapshotView(home, shared) !== null) {
    if (!dryRun) await removeSkillIndex(shared, { home });
    out.steps.push({ step: 'catalog', action: 'remove', detail: `${sharedWhere} (no shared-skills follow; the snapshot is stale)` });
  }

  const keys = setResolverHarness(cfg, harness, true, dryRun);
  out.steps.push({ step: 'config', action: keys.changed ? 'write' : 'keep', detail: `skills.resolver.enabled = true, skills.resolver.harnesses includes ${harness} in ${cfg.path}` });
  const hook = syncSkillResolverHook({ harness, gbrainBin: opts.gbrainBin, gbrainHome: opts.gbrainHome, paths: opts.paths, dryRun });
  if (hook.action === 'refuse') return { ...out, error: incomplete(dirs, hook.detail, 'The catalog and the config keys were written; re-run after fixing that.') };
  out.steps.push({ step: 'hook', action: hook.action === 'keep' ? 'keep' : 'write', detail: hook.detail });
  if (dryRun) return out;

  const after = await catalogStatus(catalog, { home });
  const sampleText = readDirSources(dirs).skills[0]?.description ?? '';
  const sample = sampleText ? (await resolveSkills({ message: sampleText, harness }, { home, catalogs: [catalog], failOpen: true })).output.block : '';
  const n = after.receipt?.skill_count ?? skills;
  return { ...out, sample, status: { catalog, skills: n, fresh: after.fresh === true, line: `skill resolver: on; ${n} skills; ${after.fresh ? 'fresh' : 'stale'}` } };
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
