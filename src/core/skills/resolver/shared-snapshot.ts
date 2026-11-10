/**
 * The followed shared catalog, snapshotted for the skill resolver
 * (GBRA-399, issue #9077 option 1).
 *
 * The lane is brainless by design: it ranks only what is on disk, so the
 * followed catalog lives only in the brain DB (shared_skill_revisions, read
 * via listSharedSkills with a live engine) and never reaches a turn. Setup
 * (and a sync_brain_skills refresh, via the shared-skills adapter) snapshot
 * it into a local catalog, `<harness>-shared`, from the authorized view:
 *
 *   - each entry keeps the catalog's description and triggers for ranking;
 *     the body is not snapshotted (the SKILL.md bytes stay with the brain
 *     and are fetched per skill, at their pinned revision);
 *   - the record id IS the qualified id list_skills returned: it is the
 *     exact key get_skill takes, so the block line names the load path and
 *     the agent fetches the skill with get_skill (qualified_id), never by
 *     guessing one;
 *   - `path` names the router skill (gbrain-shared-<hash>) when one is
 *     installed in the harness's user skills dir, so a harness that loads
 *     by path (codex) shows it and the JSON turn output carries it;
 *   - only usable, complete skills are indexed: the lane must never suggest
 *     a skill the agent cannot fetch (unusable, prose-only, or without a
 *     loadable id). Entries that fail those checks are reported as skipped,
 *     never silently dropped;
 *   - freshness is the view token: the snapshot records the view_token of
 *     the view it was built from, and a refresh rebuilds it only when the
 *     token (or brain) changed. The lane itself never judges freshness --
 *     it ranks the snapshot as-is, exactly like the user catalog, whose
 *     staleness setup also owns. A sync_brain_skills refresh re-snapshots
 *     (the adapter calls refreshSharedSnapshot after a successful sync);
 *     a setup re-run does the same when its lister returns a new token.
 *
 * Engine-free: this module is a resolver leaf (build + paths only), so the
 * turn path stays brainless. The caller supplies the already-fetched view
 * (a lister in setup, the sync snapshot in the adapter); nothing here opens
 * a brain, a database or the network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSkillIndex, readReceipt, removeSkillIndex } from './build.ts';
import { writeFileDurable } from './fsutil.ts';
import { catalogDir } from './paths.ts';

/** One followed skill, as the authorized view (list_skills) returns it. Structural: the resolver stays a leaf and never imports the shared-skills model. */
export interface SharedCatalogEntry {
  qualified_id: string;
  name: string;
  description: string;
  triggers?: string[];
  /** False when the catalog says the skill is not usable by this connection. Undefined (older views) is treated as usable. */
  usable?: boolean;
  /** 'prose_only' skills have no approved SKILL.md to fetch; only 'complete' ones are indexed. Undefined is treated as complete. */
  delivery?: 'complete' | 'prose_only';
}

export interface SharedSkillsView { brain_id: string; view_token: string; skills: SharedCatalogEntry[] }

/** The snapshot catalog for a harness: the name setup builds and the lane ranks. */
export const sharedCatalogName = (harness: string): string => `${harness}-shared`;

/** readJsonSource (sources.ts) rejects ids over this length; the qualified id is the record id, so over-long ones are skipped, not truncated. */
export const SHARED_SNAPSHOT_MAX_ID_CHARS = 256;

export type SharedSkipReason = 'not_usable' | 'prose_only' | 'missing_id' | 'id_too_long' | 'duplicate_id';
export interface SkippedSharedEntry { reason: SharedSkipReason; id: string; name: string }

export interface SharedSnapshotRecord { id: string; name: string; description: string; triggers: string[]; path?: string }

/** Map an authorized view to JSON-source records, skipping what the lane must not suggest. */
export function sharedSnapshotRecords(entries: readonly SharedCatalogEntry[], opts: { router?: string } = {}): { records: SharedSnapshotRecord[]; skipped: SkippedSharedEntry[] } {
  const records: SharedSnapshotRecord[] = [];
  const skipped: SkippedSharedEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const id = e.qualified_id?.trim() ?? '';
    const name = e.name?.trim() ?? '';
    if (!id) { skipped.push({ reason: 'missing_id', id: name, name }); continue; }
    if (e.usable === false) { skipped.push({ reason: 'not_usable', id, name }); continue; }
    if (e.delivery === 'prose_only') { skipped.push({ reason: 'prose_only', id, name }); continue; }
    if (id.length > SHARED_SNAPSHOT_MAX_ID_CHARS) { skipped.push({ reason: 'id_too_long', id, name }); continue; }
    if (seen.has(id)) { skipped.push({ reason: 'duplicate_id', id, name }); continue; }
    seen.add(id);
    records.push({ id, name, description: e.description ?? '', triggers: [...(e.triggers ?? [])], ...(opts.router ? { path: opts.router } : {}) });
  }
  return { records, skipped };
}

export interface SharedSnapshotSource { schema_version: 1; brain_id: string; view_token: string; built_at: string; skill_count: number; skipped: SkippedSharedEntry[] }
const SIDECAR = 'shared-source.json';
const sidecarPath = (home: string, catalog: string) => join(catalogDir(home, catalog), SIDECAR);

/** The view a snapshot was built from, or null when no snapshot was ever built (or its sidecar is unreadable). */
export function readSharedSnapshotSource(home: string, catalog: string): SharedSnapshotSource | null {
  try {
    const raw = readFileSync(sidecarPath(home, catalog), 'utf8');
    const parsed = JSON.parse(raw) as SharedSnapshotSource;
    return parsed && parsed.schema_version === 1 && typeof parsed.view_token === 'string' ? parsed : null;
  } catch { return null; }
}

export type SharedSnapshotAction = 'write' | 'keep' | 'remove' | null;
export interface SharedSnapshotResult { action: SharedSnapshotAction; catalog: string; skills: number; skipped: SkippedSharedEntry[] }

/**
 * Build (or rebuild) the snapshot catalog from a view. An empty record list
 * removes a catalog that exists and reports 'remove'; with no catalog and
 * no records there is nothing to do ('null'). A dry run counts only.
 */
export async function buildSharedSnapshot(home: string, harness: string, view: SharedSkillsView, opts: { dryRun?: boolean; router?: string } = {}): Promise<SharedSnapshotResult> {
  const catalog = sharedCatalogName(harness);
  const { records, skipped } = sharedSnapshotRecords(view.skills, { router: opts.router });
  if (records.length === 0) {
    if (existsSync(join(catalogDir(home, catalog), 'receipt.json'))) {
      if (!opts.dryRun) await removeSkillIndex(catalog, { home });
      return { action: 'remove', catalog, skills: 0, skipped };
    }
    return { action: null, catalog, skills: 0, skipped };
  }
  if (opts.dryRun) return { action: 'write', catalog, skills: records.length, skipped };
  await buildSkillIndex({ catalog, fromJson: JSON.stringify(records), fromJsonStdin: true, harness }, { home });
  const sidecar: SharedSnapshotSource = { schema_version: 1, brain_id: view.brain_id, view_token: view.view_token,
    built_at: new Date().toISOString(), skill_count: records.length, skipped };
  writeFileDurable(sidecarPath(home, catalog), `${JSON.stringify(sidecar, null, 2)}\n`);
  return { action: 'write', catalog, skills: records.length, skipped };
}

/**
 * Refresh the snapshot from a fresh view: keep it untouched when the view
 * token (and brain) are unchanged and the catalog is still built, rebuild
 * it when the view moved, remove it when the view is empty. This is the
 * freshness story: sync_brain_skills calls this after a successful sync,
 * and setup calls it on every re-run with its lister.
 */
export async function refreshSharedSnapshot(home: string, harness: string, view: SharedSkillsView, opts: { dryRun?: boolean; router?: string } = {}): Promise<SharedSnapshotResult> {
  const catalog = sharedCatalogName(harness);
  const current = readSharedSnapshotSource(home, catalog);
  if (current && current.brain_id === view.brain_id && current.view_token === view.view_token
    && readReceipt(home, catalog) !== null) {
    return { action: 'keep', catalog, skills: current.skill_count, skipped: [] };
  }
  return buildSharedSnapshot(home, harness, view, opts);
}
