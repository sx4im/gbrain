/**
 * skill-resolver-shared-snapshot.ts — the setup-time snapshot of a followed
 * shared catalog for the skill resolver (issue #9077, option 1).
 *
 * The Claude Code hook lane ranks only `~/.claude/skills` (the user
 * catalog) plus a project's `.claude/skills`: the entries of a followed
 * shared catalog never rank, because the followed catalog lives only in
 * the brain database (`shared_skill_revisions`, read via `listSharedSkills`
 * with a live engine) and the lane is brainless by design. The shared-skills
 * follow instead installs one router skill (`gbrain-shared-<hash>`) whose
 * description the lane ranks; the individual entries (`citation-fixer`,
 * `meeting-ingestion`, ...) are never matched per turn, and `list_skills`
 * refuses to rank a shared catalog (#6471, deliberate).
 *
 * Setup bridges that gap at setup time, while the brain is reachable: it
 * snapshots the followed catalog's entries out of the shared-skills sync
 * cache (the adapter's `revisions/<sha256(key)>/<sha256(revision)>/`
 * SKILL.md files, keyed by the harness receipt's `shared_skills` entry)
 * into a JSON catalog `<harness>-shared`, and the lane ranks that catalog
 * alongside the user catalog. Each line names the router's load path — a
 * `get_skill` call with the entry's `qualified_id` and exact `revision` —
 * so the agent fetches that skill straight from the brain. The snapshot
 * carries the cache's `view_token`; setup rebuilds it whenever the token
 * differs (after `sync_brain_skills` refreshes the view), and removes it
 * when the follow is gone.
 *
 * Engine-free: the harness receipt, the adapter receipt and the cached
 * SKILL.md files are all plain files under the config directory, so a
 * brainless install stays brainless — a snapshot is built only when a
 * follow exists, and the lane never reads the brain. Nothing here lifts
 * the #6471 refusal in `list_skills`, and the plugin half of #9077 lives
 * in draft #9081 (option 2), not here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readHarnessReceiptState } from '../bootstrap/format.ts';
import { parseSkillDoc, SKILL_FILE_CAP_BYTES } from '../skills/resolver/frontmatter.ts';
import { readHead } from '../skills/resolver/fsutil.ts';
import { catalogFile } from '../skills/resolver/paths.ts';
import { MAX_SKILLS } from '../skills/resolver/sources.ts';
import type { ResolverHarness } from './skill-resolver-hook.ts';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The follow statuses that still have installed skills in the sync cache. */
const ACTIVE_FOLLOW_STATUSES = new Set(['joined', 'restart_required', 'advisory_refresh', 'requirements_changed']);

export const sharedCatalogName = (harness: ResolverHarness): string => `${harness}-shared`;

export interface SharedFollow {
  root: string;
  brain_id: string;
  installation_id: string;
  enrollment_epoch: number;
  view_token: string;
  skills: Record<string, { revision: string; files: Record<string, string> }>;
}

export interface SharedSnapshotSkipped { id: string; reason: string }
export interface SharedSnapshotBuild {
  text: string;
  view_token: string;
  brain_id: string;
  skills: number;
  skipped: SharedSnapshotSkipped[];
}

/** The harness receipt's shared-skills entry, when it names a live follow. */
export function findSharedFollow(home: string, harness: ResolverHarness): SharedFollow | null {
  const receipt = readHarnessReceiptState(home);
  if (receipt.state !== 'ok' || !receipt.receipt.shared_skills) return null;
  for (const entry of receipt.receipt.shared_skills) {
    if (entry.host !== harness || !ACTIVE_FOLLOW_STATUSES.has(entry.status)) continue;
    const root = entry.root;
    const adapterReceipt = readJsonObject(join(root, 'shared-skills', 'receipt.json'));
    if (!adapterReceipt || typeof adapterReceipt.installation_id !== 'string' || !adapterReceipt.installation_id
      || typeof adapterReceipt.enrollment_epoch !== 'number' || !Number.isSafeInteger(adapterReceipt.enrollment_epoch)) continue;
    const active = readJsonObject(join(root, 'shared-skills', 'active.json'));
    if (!active || typeof active.view_token !== 'string' || !active.view_token
      || typeof active.brain_id !== 'string' || !active.brain_id
      || !active.skills || typeof active.skills !== 'object' || Array.isArray(active.skills)) continue;
    const skills: SharedFollow['skills'] = {};
    for (const [key, ref] of Object.entries(active.skills as Record<string, unknown>)) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
      const r = ref as { revision?: unknown; files?: unknown };
      if (typeof r.revision !== 'string' || !r.revision || !r.files || typeof r.files !== 'object' || Array.isArray(r.files)) continue;
      skills[key] = { revision: r.revision, files: r.files as Record<string, string> };
    }
    return { root, brain_id: active.brain_id as string, installation_id: adapterReceipt.installation_id as string,
      enrollment_epoch: adapterReceipt.enrollment_epoch as number, view_token: active.view_token as string, skills };
  }
  return null;
}

/** The `view_token` a built shared catalog was snapshotted from, or null. */
export function readSharedSnapshotView(home: string, catalog: string): string | null {
  try {
    const v = JSON.parse(readFileSync(catalogFile(home, catalog, 'source.json'), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { view_token?: unknown }).view_token === 'string'
      ? (v as { view_token: string }).view_token : null;
  } catch { return null; }
}

/** `skill:<brain_id>:<source_id>:<source_incarnation>:<pack_id>:<name>` from a cache key (the adapter's `qualifiedSkillId`). */
export function qualifiedSkillIdFromKey(key: string): string {
  return `skill:${key.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join(':')}`;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * Snapshot the followed catalog's entries out of the sync cache: one JSON
 * catalog entry per usable cached SKILL.md, each naming its `get_skill`
 * fetch (`qualified_id` + exact `revision`). Unreadable, missing or
 * non-invocable entries are skipped, never fatal. Sorted by cache key, so
 * the same view builds the same snapshot text.
 */
export function buildSharedSnapshot(follow: SharedFollow): SharedSnapshotBuild {
  const entries: Record<string, unknown>[] = [];
  const skipped: SharedSnapshotSkipped[] = [];
  for (const key of Object.keys(follow.skills).sort()) {
    const ref = follow.skills[key]!;
    const name = decodeURIComponent(key.split('/').pop() ?? '');
    if (!name) { skipped.push({ id: key, reason: 'unparseable key' }); continue; }
    const manifestPath = `skills/${name}/SKILL.md`;
    const cacheRel = typeof ref.files[manifestPath] === 'string' && ref.files[manifestPath]
      ? ref.files[manifestPath]!
      : `revisions/${sha256(key)}/${sha256(ref.revision)}/${manifestPath}`;
    const cachePath = join(follow.root, 'shared-skills', cacheRel);
    let text: string;
    try {
      if (!existsSync(cachePath)) { skipped.push({ id: name, reason: 'cached SKILL.md is missing' }); continue; }
      text = readHead(cachePath, SKILL_FILE_CAP_BYTES).bytes.toString('utf8');
    } catch { skipped.push({ id: name, reason: 'cached SKILL.md cannot be read' }); continue; }
    const doc = parseSkillDoc(text);
    if (!doc.modelInvocable) { skipped.push({ id: name, reason: 'disable-model-invocation is set' }); continue; }
    if (!doc.eligible) { skipped.push({ id: name, reason: 'eligible is false' }); continue; }
    const qid = qualifiedSkillIdFromKey(key);
    entries.push({ id: doc.name ?? name, name: doc.name ?? name, description: doc.description,
      ...(doc.whenToUse ? { whenToUse: doc.whenToUse } : {}), triggers: doc.triggers, body: doc.body,
      load: `get_skill qualified_id="${qid}" revision="${ref.revision}" schema_version=2` });
    if (entries.length >= MAX_SKILLS) break;
  }
  if (Object.keys(follow.skills).length > entries.length + skipped.length) {
    skipped.push({ id: '', reason: `over the ${MAX_SKILLS.toLocaleString('en-US')}-skill catalog bound` });
  }
  return { text: JSON.stringify({ view_token: follow.view_token, brain_id: follow.brain_id, skills: entries }),
    view_token: follow.view_token, brain_id: follow.brain_id, skills: entries.length, skipped };
}
