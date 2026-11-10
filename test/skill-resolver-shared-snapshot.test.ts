/**
 * The followed-shared-catalog snapshot (issue #9077, option 1):
 * setup snapshots the followed catalog's entries out of the shared-skills
 * sync cache into `<harness>-shared`, each line naming its `get_skill`
 * fetch. Every test runs on scratch directories with no brain, no database
 * and no git repository.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSharedSnapshot, findSharedFollow, qualifiedSkillIdFromKey, readSharedSnapshotView, type SharedFollow } from '../src/core/setup/skill-resolver-shared-snapshot.ts';
import { readJsonSource } from '../src/core/skills/resolver/sources.ts';

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix = 'skshared-'): string { const d = mkdtempSync(join(tmpdir(), prefix)); scratch.push(d); return d; }
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const KEY = ['brain-1', 'src-1', '1', 'pack-1', 'citation-fixer'].map(encodeURIComponent).join('/');
const REV = '01900000-0000-7000-8000-000000000001';

function writeSkill(root: string, key: string, revision: string, name: string, fm: string, body = 'Steps.'): string {
  const rel = `revisions/${sha(key)}/${sha(revision)}/skills/${name}/SKILL.md`;
  const p = join(root, 'shared-skills', rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, `---\n${fm}\n---\n${body}\n`);
  return rel;
}

function followBox(opts: { status?: string; viewToken?: string | null; skills?: Record<string, unknown>; receiptStatus?: string } = {}): { home: string; root: string; follow: SharedFollow | null } {
  const home = tmp();
  const root = tmp('skshared-root-');
  const rel = writeSkill(root, KEY, REV, 'citation-fixer', 'name: citation-fixer\ndescription: Fix citations; fix broken citations; citation audit\ntriggers: ["citation audit"]');
  const activeSkills: Record<string, unknown> = opts.skills ?? { [KEY]: { revision: REV, files: { 'skills/citation-fixer/SKILL.md': rel } } };
  mkdirSync(join(root, 'shared-skills'), { recursive: true });
  writeFileSync(join(root, 'shared-skills', 'receipt.json'), JSON.stringify({ installation_id: 'inst-1', enrollment_epoch: 3, status: opts.receiptStatus ?? 'joined' }));
  writeFileSync(join(root, 'shared-skills', 'active.json'), JSON.stringify({
    brain_id: 'brain-1', installation_id: 'inst-1', enrollment_epoch: 3,
    ...(opts.viewToken === null ? {} : { view_token: opts.viewToken ?? 'vt-1' }), skills: activeSkills,
  }));
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
  writeFileSync(join(home, 'bootstrap', 'harness.json'), JSON.stringify({
    harness_receipt_version: 1, created_at: new Date().toISOString(), created_by: 'gbrain', url: 'http://x', source_id: 's',
    token: { name: 't', minted: true }, targets: [],
    shared_skills: [{ host: 'claude-code', root, name: 'x', url: 'http://x', status: opts.status ?? 'joined' }],
  }));
  return { home, root, follow: findSharedFollow(home, 'claude-code') };
}

describe('findSharedFollow', () => {
  test('a joined follow reads the harness receipt, the adapter receipt and active.json', () => {
    const { follow } = followBox();
    expect(follow).not.toBeNull();
    expect(follow!.brain_id).toBe('brain-1');
    expect(follow!.installation_id).toBe('inst-1');
    expect(follow!.enrollment_epoch).toBe(3);
    expect(follow!.view_token).toBe('vt-1');
    expect(Object.keys(follow!.skills)).toEqual([KEY]);
  });

  test('no receipt, a left follow, a stale follow and a missing view_token are all no follow', () => {
    expect(findSharedFollow(tmp(), 'claude-code')).toBeNull();
    expect(followBox({ status: 'left' }).follow).toBeNull();
    expect(followBox({ status: 'left_with_retained_files' }).follow).toBeNull();
    expect(followBox({ status: 'stale_unavailable' }).follow).toBeNull();
    expect(followBox({ status: 'local_conflict' }).follow).toBeNull();
    expect(followBox({ viewToken: null }).follow).toBeNull();
    expect(followBox({ receiptStatus: 'stale_unavailable' }).follow).not.toBeNull();
  });

  test('an entry for another harness is skipped; a restart_required follow still counts', () => {
    const { home, root } = followBox();
    const receipt = JSON.parse(readFileSync(join(home, 'bootstrap', 'harness.json'), 'utf8')) as { shared_skills: { host: string }[] };
    receipt.shared_skills[0]!.host = 'codex';
    writeFileSync(join(home, 'bootstrap', 'harness.json'), JSON.stringify(receipt));
    expect(findSharedFollow(home, 'claude-code')).toBeNull();
    expect(findSharedFollow(home, 'codex')).not.toBeNull();
    expect(followBox({ status: 'restart_required' }).follow).not.toBeNull();
    expect(followBox({ status: 'requirements_changed' }).follow).not.toBeNull();
    expect(root).toContain('skshared-root-');
  });
});

describe('qualifiedSkillIdFromKey', () => {
  test('the adapter key becomes skill:brain:source:incarnation:pack:name', () => {
    expect(qualifiedSkillIdFromKey(KEY)).toBe('skill:brain-1:src-1:1:pack-1:citation-fixer');
    expect(qualifiedSkillIdFromKey('brain-1/src-1/1/pack-1/my%20skill')).toBe('skill:brain-1:src-1:1:pack-1:my%20skill');
  });
});

describe('buildSharedSnapshot', () => {
  test('one entry per cached SKILL.md, each naming its get_skill fetch; the text is a valid catalog snapshot', () => {
    const { follow } = followBox();
    const snap = buildSharedSnapshot(follow!);
    expect(snap.skills).toBe(1);
    expect(snap.skipped).toEqual([]);
    expect(snap.view_token).toBe('vt-1');
    expect(snap.brain_id).toBe('brain-1');
    const parsed = JSON.parse(snap.text) as { view_token: string; brain_id: string; skills: { id: string; name: string; description: string; triggers: string[]; load: string }[] };
    expect(parsed.view_token).toBe('vt-1');
    expect(parsed.brain_id).toBe('brain-1');
    expect(parsed.skills[0]).toEqual({
      id: 'citation-fixer', name: 'citation-fixer', description: 'Fix citations; fix broken citations; citation audit',
      triggers: ['citation audit'], body: 'Steps.',
      load: 'get_skill qualified_id="skill:brain-1:src-1:1:pack-1:citation-fixer" revision="01900000-0000-7000-8000-000000000001" schema_version=2',
    });
    expect(() => readJsonSource(snap.text)).not.toThrow();
    expect(readJsonSource(snap.text).skills[0]!.load).toContain('get_skill');
  });

  test('missing cache files, non-invocable and ineligible entries are skipped, never fatal', () => {
    const home = tmp();
    const root = tmp('skshared-root-');
    const rel = writeSkill(root, KEY, REV, 'citation-fixer', 'name: citation-fixer\ndescription: Fix citations');
    const key2 = ['brain-1', 'src-1', '1', 'pack-1', 'hidden-skill'].map(encodeURIComponent).join('/');
    const key3 = ['brain-1', 'src-1', '1', 'pack-1', 'gone-skill'].map(encodeURIComponent).join('/');
    writeSkill(root, key2, REV, 'hidden-skill', 'name: hidden-skill\ndescription: Never ranked\ndisable-model-invocation: true');
    mkdirSync(join(root, 'shared-skills'), { recursive: true });
    writeFileSync(join(root, 'shared-skills', 'receipt.json'), JSON.stringify({ installation_id: 'inst-1', enrollment_epoch: 3, status: 'joined' }));
    writeFileSync(join(root, 'shared-skills', 'active.json'), JSON.stringify({
      brain_id: 'brain-1', installation_id: 'inst-1', enrollment_epoch: 3, view_token: 'vt-1',
      skills: {
        [KEY]: { revision: REV, files: { 'skills/citation-fixer/SKILL.md': rel } },
        [key2]: { revision: REV, files: { 'skills/hidden-skill/SKILL.md': writeSkill(root, key2, REV, 'hidden-skill', 'name: hidden-skill\ndescription: Never ranked\ndisable-model-invocation: true') } },
        [key3]: { revision: REV, files: { 'skills/gone-skill/SKILL.md': 'revisions/deadbeef/deadbeef/skills/gone-skill/SKILL.md' } },
      },
    }));
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    writeFileSync(join(home, 'bootstrap', 'harness.json'), JSON.stringify({
      harness_receipt_version: 1, created_at: new Date().toISOString(), created_by: 'gbrain', url: 'http://x', source_id: 's',
      token: { name: 't', minted: true }, targets: [],
      shared_skills: [{ host: 'claude-code', root, name: 'x', url: 'http://x', status: 'joined' }],
    }));
    const follow = findSharedFollow(home, 'claude-code');
    expect(follow).not.toBeNull();
    const snap = buildSharedSnapshot(follow!);
    expect(snap.skills).toBe(1);
    expect(snap.skipped.map(s => s.id).sort()).toEqual(['gone-skill', 'hidden-skill']);
    expect(JSON.parse(snap.text).skills.map((s: { id: string }) => s.id)).toEqual(['citation-fixer']);
  });

  test('a skill with no frontmatter name falls back to its directory name', () => {
    const home = tmp();
    const root = tmp('skshared-root-');
    const key = ['brain-1', 'src-1', '1', 'pack-1', 'unnamed-skill'].map(encodeURIComponent).join('/');
    const rel = writeSkill(root, key, REV, 'unnamed-skill', 'description: No name in frontmatter');
    mkdirSync(join(root, 'shared-skills'), { recursive: true });
    writeFileSync(join(root, 'shared-skills', 'receipt.json'), JSON.stringify({ installation_id: 'inst-1', enrollment_epoch: 3, status: 'joined' }));
    writeFileSync(join(root, 'shared-skills', 'active.json'), JSON.stringify({
      brain_id: 'brain-1', installation_id: 'inst-1', enrollment_epoch: 3, view_token: 'vt-1',
      skills: { [key]: { revision: REV, files: { 'skills/unnamed-skill/SKILL.md': rel } } },
    }));
    mkdirSync(join(home, 'bootstrap'), { recursive: true });
    writeFileSync(join(home, 'bootstrap', 'harness.json'), JSON.stringify({
      harness_receipt_version: 1, created_at: new Date().toISOString(), created_by: 'gbrain', url: 'http://x', source_id: 's',
      token: { name: 't', minted: true }, targets: [],
      shared_skills: [{ host: 'claude-code', root, name: 'x', url: 'http://x', status: 'joined' }],
    }));
    const snap = buildSharedSnapshot(findSharedFollow(home, 'claude-code')!);
    expect(snap.skills).toBe(1);
    expect(JSON.parse(snap.text).skills[0].id).toBe('unnamed-skill');
  });
});

describe('readSharedSnapshotView', () => {
  test('the view_token a built catalog was snapshotted from; null when absent or unreadable', () => {
    const home = tmp();
    const dir = join(home, 'skill-index', 'claude-code-shared');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'source.json'), JSON.stringify({ view_token: 'vt-9', brain_id: 'brain-1', skills: [] }));
    expect(readSharedSnapshotView(home, 'claude-code-shared')).toBe('vt-9');
    expect(readSharedSnapshotView(home, 'claude-code-user')).toBeNull();
    writeFileSync(join(dir, 'source.json'), '{not json');
    expect(readSharedSnapshotView(home, 'claude-code-shared')).toBeNull();
    expect(existsSync(dir)).toBe(true);
  });
});
