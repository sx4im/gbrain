/**
 * GBRA-399 (issue #9077, option 1): the Claude Code skill resolver ranks
 * the followed shared catalog. Setup snapshots it into <harness>-shared
 * from the authorized view (list_skills), the lane ranks it next to the
 * user catalog, each line names the get_skill load key (the qualified id),
 * and a sync_brain_skills refresh re-snapshots it when the view changes.
 *
 * Protects: the snapshot only indexes usable, complete skills; entries
 * without a loadable id are skipped, never guessed; the catalog name is
 * per harness; a setup with no local skills still turns the lane on when
 * the shared catalog has skills; a lister failure never breaks the user
 * catalog; --skill-loading off removes the shared catalog; the lane
 * delivers a shared skill with its qualified id in the block.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { buildSharedSnapshot, readSharedSnapshotSource, refreshSharedSnapshot, sharedCatalogName, sharedSnapshotRecords } from '../src/core/skills/resolver/shared-snapshot.ts';
import { catalogStatus } from '../src/core/skills/resolver/build.ts';
import { resolveSkills } from '../src/core/skills/resolver/resolve.ts';
import { fetchSharedCatalogView, removeSkillResolverSetup, syncSkillResolverSetup } from '../src/core/setup/skill-resolver-setup.ts';

setDefaultTimeout(60_000);
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const tempRoot = () => { const r = mkdtempSync(join(tmpdir(), 'gbrain-shared-snapshot-')); roots.push(r); return r; };

const BRAIN = '11111111-1111-4111-8111-111111111111';
const SRC = '22222222-2222-4222-8222-222222222222';
const INC = '33333333-3333-4333-8333-333333333333';
const qid = (pack: string, name: string) => `skill:${BRAIN}:${SRC}:${INC}:${pack}:${name}`;
const entry = (over: Record<string, unknown> = {}) => ({
  qualified_id: qid('example', 'fixture'), name: 'fixture',
  description: 'Use the fixture when deploying the widget to staging.',
  triggers: ['fixture', 'deploy widget'], usable: true, delivery: 'complete' as const,
  revision: 'r1', pack_id: 'example', source_id: SRC, source_incarnation: INC, brain_id: BRAIN, ...over,
});
const view = (skills: ReturnType<typeof entry>[], view_token = 'v1') => ({ brain_id: BRAIN, view_token, skills });

describe('sharedCatalogName', () => {
  test('names the snapshot catalog per harness', () => {
    expect(sharedCatalogName('claude-code')).toBe('claude-code-shared');
    expect(sharedCatalogName('codex')).toBe('codex-shared');
  });
});

describe('sharedSnapshotRecords', () => {
  test('maps a usable complete entry to a JSON-source record whose id is the get_skill key', () => {
    const { records, skipped } = sharedSnapshotRecords([entry()], { router: 'gbrain-shared-abcdef0123456789abcdef01' });
    expect(skipped).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: qid('example', 'fixture'), name: 'fixture',
      description: 'Use the fixture when deploying the widget to staging.',
      triggers: ['fixture', 'deploy widget'],
      path: 'gbrain-shared-abcdef0123456789abcdef01',
    });
  });

  test('skips unusable, prose-only and id-less entries instead of indexing a skill the agent cannot fetch', () => {
    const { records, skipped } = sharedSnapshotRecords([
      entry(),
      entry({ qualified_id: qid('example', 'broken'), name: 'broken', usable: false }),
      entry({ qualified_id: qid('example', 'prose'), name: 'prose', delivery: 'prose_only' }),
      entry({ qualified_id: '', name: 'noid' }),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(qid('example', 'fixture'));
    expect(skipped.map(s => s.id).sort()).toEqual([qid('example', 'broken'), qid('example', 'prose'), 'noid'].sort());
  });

  test('skips an entry whose qualified id would overflow the index id cap', () => {
    const long = entry({ qualified_id: `skill:${'x'.repeat(300)}`, name: 'toolong' });
    const { records, skipped } = sharedSnapshotRecords([long]);
    expect(records).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe('id_too_long');
  });

  test('keeps the first entry when two share one qualified id', () => {
    const { records, skipped } = sharedSnapshotRecords([entry(), entry({ description: 'A second copy.' })]);
    expect(records).toHaveLength(1);
    expect(records[0]!.description).toContain('deploying the widget');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe('duplicate_id');
  });
});

describe('buildSharedSnapshot + refreshSharedSnapshot', () => {
  test('builds a rankable catalog from the view and records the view token', async () => {
    const root = tempRoot();
    const home = join(root, '.gbrain');
    const r = await buildSharedSnapshot(home, 'claude-code', view([entry()]));
    expect(r.action).toBe('write');
    expect(r.skills).toBe(1);
    const status = await catalogStatus(sharedCatalogName('claude-code'), { home });
    expect(status.present).toBe(true);
    expect(status.fresh).toBe(true);
    expect(status.receipt?.skill_count).toBe(1);
    expect(readSharedSnapshotSource(home, sharedCatalogName('claude-code'))).toMatchObject({ brain_id: BRAIN, view_token: 'v1', skill_count: 1 });
    const out = await resolveSkills({ message: 'deploy the widget to staging', harness: 'claude-code' }, { home, catalogs: [sharedCatalogName('claude-code')] });
    expect(out.output.suggestions.map(s => s.id)).toContain(qid('example', 'fixture'));
    expect(out.output.block).toContain(`id: ${JSON.stringify(qid('example', 'fixture'))}`);
    expect(out.output.block).toContain('To use one, load it with the Skill tool (by its id) before acting.');
  });

  test('refresh keeps an unchanged view, rebuilds a changed one, and removes an empty one', async () => {
    const root = tempRoot();
    const home = join(root, '.gbrain');
    await buildSharedSnapshot(home, 'claude-code', view([entry()]));
    const before = readFileSync(join(home, 'skill-index', sharedCatalogName('claude-code'), 'receipt.json'), 'utf8');
    const kept = await refreshSharedSnapshot(home, 'claude-code', view([entry()]));
    expect(kept.action).toBe('keep');
    expect(readFileSync(join(home, 'skill-index', sharedCatalogName('claude-code'), 'receipt.json'), 'utf8')).toBe(before);
    const rebuilt = await refreshSharedSnapshot(home, 'claude-code', view([entry({ description: 'Use the fixture for the release checklist.' })], 'v2'));
    expect(rebuilt.action).toBe('write');
    expect(readSharedSnapshotSource(home, sharedCatalogName('claude-code'))!.view_token).toBe('v2');
    const removed = await refreshSharedSnapshot(home, 'claude-code', view([], 'v3'));
    expect(removed.action).toBe('remove');
    expect(existsSync(join(home, 'skill-index', sharedCatalogName('claude-code')))).toBe(false);
  });

  test('dry run counts without writing anything', async () => {
    const root = tempRoot();
    const home = join(root, '.gbrain');
    const r = await buildSharedSnapshot(home, 'claude-code', view([entry()]), { dryRun: true });
    expect(r.action).toBe('write');
    expect(r.skills).toBe(1);
    expect(existsSync(join(home, 'skill-index'))).toBe(false);
  });

  test('dry run reports keep for an unchanged view', async () => {
    const root = tempRoot();
    const home = join(root, '.gbrain');
    await buildSharedSnapshot(home, 'claude-code', view([entry()]));
    const r = await refreshSharedSnapshot(home, 'claude-code', view([entry()]), { dryRun: true });
    expect(r.action).toBe('keep');
    expect(r.skills).toBe(1);
  });
});

describe('setup with a shared catalog', () => {
  function box(): { root: string; home: string; gb: string } {
    const root = tempRoot();
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude', 'skills', 'deploy-widget'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'deploy-widget', 'SKILL.md'),
      '---\nname: deploy-widget\ndescription: Deploy the widget service to staging or production.\n---\nSteps.\n');
    return { root, home, gb: join(home, '.gbrain') };
  }

  test('turns the lane on with both catalogs and reports the shared step', async () => {
    const b = box();
    await withEnv({ HOME: b.home }, async () => {
      const r = await syncSkillResolverSetup({
        harness: 'claude-code', gbrainBin: '/bin/true', home: b.gb, dryRun: false,
        sharedSkills: async () => view([entry()]),
      });
      expect(r.error).toBeUndefined();
      expect(r.steps.some(s => s.step === 'catalog' && s.detail.includes(sharedCatalogName('claude-code')))).toBe(true);
      expect(r.status?.skills).toBe(2);
      expect(existsSync(join(b.gb, 'skill-index', sharedCatalogName('claude-code'), 'receipt.json'))).toBe(true);
      const out = await resolveSkills({ message: 'deploy the widget to staging', harness: 'claude-code' },
        { home: b.gb, catalogs: ['claude-code-user', sharedCatalogName('claude-code')] });
      expect(out.output.suggestions.map(s => s.id)).toEqual(expect.arrayContaining(['deploy-widget', qid('example', 'fixture')]));
    });
  });

  test('a null view means no follow: setup still succeeds on the user catalog alone', async () => {
    const b = box();
    await withEnv({ HOME: b.home }, async () => {
      const r = await syncSkillResolverSetup({
        harness: 'claude-code', gbrainBin: '/bin/true', home: b.gb, dryRun: false,
        sharedSkills: async () => null,
      });
      expect(r.error).toBeUndefined();
      expect(existsSync(join(b.gb, 'skill-index', sharedCatalogName('claude-code')))).toBe(false);
    });
  });

  test('a failing lister never breaks the user catalog', async () => {
    const b = box();
    await withEnv({ HOME: b.home }, async () => {
      const r = await syncSkillResolverSetup({
        harness: 'claude-code', gbrainBin: '/bin/true', home: b.gb, dryRun: false,
        sharedSkills: async () => { throw new Error('brain unreachable'); },
      });
      expect(r.error).toBeUndefined();
      expect(r.steps.some(s => s.action === 'skip' && s.detail.includes('shared'))).toBe(true);
      expect(existsSync(join(b.gb, 'skill-index', 'claude-code-user', 'receipt.json'))).toBe(true);
    });
  });

  test('shared skills alone satisfy the gate when there is no local skill directory', async () => {
    const root = tempRoot();
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const gb = join(home, '.gbrain');
    await withEnv({ HOME: home }, async () => {
      const r = await syncSkillResolverSetup({
        harness: 'claude-code', gbrainBin: '/bin/true', home: gb, dryRun: false,
        sharedSkills: async () => view([entry()]),
      });
      expect(r.error).toBeUndefined();
      expect(r.status?.skills).toBe(1);
      expect(existsSync(join(gb, 'skill-index', sharedCatalogName('claude-code'), 'receipt.json'))).toBe(true);
    });
  });

  test('--skill-loading off removes the shared catalog with the rest', async () => {
    const b = box();
    await withEnv({ HOME: b.home }, async () => {
      await syncSkillResolverSetup({
        harness: 'claude-code', gbrainBin: '/bin/true', home: b.gb, dryRun: false,
        sharedSkills: async () => view([entry()]),
      });
      expect(existsSync(join(b.gb, 'skill-index', sharedCatalogName('claude-code')))).toBe(true);
      await removeSkillResolverSetup({ harness: 'claude-code', home: b.gb, dryRun: false });
      expect(existsSync(join(b.gb, 'skill-index', sharedCatalogName('claude-code')))).toBe(false);
      expect(existsSync(join(b.gb, 'skill-index', 'claude-code-user'))).toBe(false);
    });
  });

  test('a dry run never calls the lister: it previews the user catalog only and notes the shared catalog as skipped', async () => {
    const b = box();
    await withEnv({ HOME: b.home }, async () => {
      let calls = 0;
      const r = await syncSkillResolverSetup({
        harness: 'claude-code', gbrainBin: '/bin/true', home: b.gb, dryRun: true,
        sharedSkills: async () => { calls++; return view([entry()]); },
      });
      expect(calls).toBe(0);
      expect(r.error).toBeUndefined();
      expect(r.steps.some(s => s.action === 'skip' && s.detail.includes('not previewed in dry-run'))).toBe(true);
      expect(existsSync(join(b.gb, 'skill-index', sharedCatalogName('claude-code')))).toBe(false);
    });
  });

  test('a re-run with no follow keeps exactly the three user steps', async () => {
    const b = box();
    await withEnv({ HOME: b.home }, async () => {
      const first = await syncSkillResolverSetup({
        harness: 'claude-code', gbrainBin: '/bin/true', home: b.gb, dryRun: false,
        sharedSkills: async () => null,
      });
      expect(first.error).toBeUndefined();
      const again = await syncSkillResolverSetup({
        harness: 'claude-code', gbrainBin: '/bin/true', home: b.gb, dryRun: false,
        sharedSkills: async () => null,
      });
      expect(again.error).toBeUndefined();
      expect(again.steps.map(s => s.action)).toEqual(['keep', 'keep', 'keep']);
    });
  });
});

describe('lane ranks the shared catalog', () => {
  const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
  function laneBox(): { root: string; home: string; project: string; bin: string; env: Record<string, string | undefined> } {
    const root = tempRoot();
    const home = join(root, 'home'), project = join(root, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    mkdirSync(join(root, 'bin'));
    const bin = join(root, 'bin', 'gbrain');
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
    chmodSync(bin, 0o755);
    return { root, home, project, bin, env: {
      HOME: home, GBRAIN_HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined,
      XDG_CONFIG_HOME: undefined, GBRAIN_SKILL_LOADING: undefined, GBRAIN_HOOK_LANE: undefined,
      GBRAIN_AGENT_INSTRUCTIONS: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
    } };
  }
  test('claude-code: a turn surfaces the shared skill by its qualified id next to the user skill', async () => {
    const b = laneBox();
    const skillsDir = join(b.home, '.claude', 'skills', 'deploy-widget');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'SKILL.md'),
      '---\nname: deploy-widget\ndescription: Deploy the widget service to staging or production.\n---\nSteps.\n');
    const setupRun = await runCli(['setup', 'claude-code', '--instructions-only', '--skill-loading', 'resolve', '--gbrain-bin', b.bin], { env: b.env, cwd: b.project });
    expect(setupRun.exitCode, setupRun.stderr + setupRun.stdout).toBe(0);
    const gb = join(b.home, '.gbrain');
    const built = await buildSharedSnapshot(gb, 'claude-code', view([entry()]));
    expect(built.action).toBe('write');
    const doc = JSON.parse(readFileSync(join(b.home, '.claude', 'settings.json'), 'utf8'));
    const cmd = (doc.hooks?.UserPromptSubmit ?? []).flatMap((g: any) => g.hooks).map((h: any) => h.command as string)
      .find((c: string) => c.includes('GBRAIN_HOOK_LANE=skill-resolver'));
    expect(cmd).toBeTruthy();
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...b.env, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_TEST_SKILL_LANE_DEADLINE_MS: '10000' })) if (v !== undefined) merged[k] = v;
    const proc = Bun.spawn(['sh', '-c', cmd!], { env: merged, cwd: b.project,
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: b.project, prompt: 'deploy the widget to staging with the fixture', session_id: 'sess-shared' })),
      stdout: 'pipe', stderr: 'pipe' });
    const [stdout, , exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(0);
    const block = (JSON.parse(stdout).hookSpecificOutput.additionalContext as string);
    expect(block).toContain('id: "deploy-widget"');
    expect(block).toContain(`id: ${JSON.stringify(qid('example', 'fixture'))}`);
    const logPath = join(b.home, '.gbrain', 'skill-index', 'logs', 'lane.jsonl');
    if (existsSync(logPath)) expect(readFileSync(logPath, 'utf8')).toContain(sharedCatalogName('claude-code'));
  });
});
