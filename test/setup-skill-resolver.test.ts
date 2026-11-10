/**
 * GBRA-377 PR B: `gbrain setup <claude-code|codex> --skill-loading resolve`
 * (src/core/setup/skill-resolver-setup.ts) and the skills.resolver.* config
 * keys (src/core/setup/skill-resolver-config.ts).
 *
 * Protects: setup builds the user catalog and writes the keys and the hook
 * only after a build with at least one skill (else
 * skill_resolver_setup_incomplete and nothing written); it is idempotent;
 * --dry-run lists every write and writes nothing; --skill-loading off and
 * setup --remove undo every write; nothing new lands in the hook-launcher
 * directory; a plain setup writes no catalog and no key; an unreadable config
 * refuses with skill_resolver_config_unreadable; a brainless install stays
 * brainless (no engine inferred from the file) and a later init, a thin client
 * and removal keep the keys' engine boundary; doctor stays silent until the
 * resolver is configured.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { loadConfig } from '../src/core/config.ts';
import { SKILL_RESOLVER_MARKER } from '../src/core/setup/skill-resolver-lane.ts';

setDefaultTimeout(60_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Box { root: string; home: string; project: string; bin: string; env: Record<string, string | undefined> }
function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-skill-resolver-setup-'));
  roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, 'bin'));
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { root, home, project, bin, env: {
    HOME: home, GBRAIN_HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    GBRAIN_SKILL_LOADING: undefined, GBRAIN_HOOK_LANE: undefined, GBRAIN_AGENT_INSTRUCTIONS: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
    // Bun's transpile cache is ~20 MB per fresh HOME and would fill the 512 MB /tmp; share one cache instead.
    BUN_INSTALL_CACHE_DIR: '/opt/bun-cache',
  } };
}
function skill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`);
}
const HARNESS = {
  'claude-code': { skills: (b: Box) => join(b.home, '.claude', 'skills'), hookFile: (b: Box) => join(b.home, '.claude', 'settings.json') },
  'codex': { skills: (b: Box) => join(b.home, '.agents', 'skills'), hookFile: (b: Box) => join(b.home, '.codex', 'hooks.json') },
} as const;
type H = keyof typeof HARNESS;

async function setup(b: Box, harness: string, extra: string[]) {
  const r = await runCli(['setup', harness, '--instructions-only', '--gbrain-bin', b.bin, ...extra], { env: b.env, cwd: b.project });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
const gb = (b: Box) => join(b.home, '.gbrain');
const configPath = (b: Box) => join(gb(b), 'config.json');
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const catalogs = (b: Box) => (existsSync(join(gb(b), 'skill-index')) ? readdirSync(join(gb(b), 'skill-index')).filter((n) => !n.startsWith('.') && n !== 'logs' && n !== 'sessions') : []);
/** Every file under the box (relative path -> content), for before/after comparisons. */
function tree(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tree(p, base, out); else out[p.slice(base.length + 1)] = readFileSync(p, 'utf8');
  }
  return out;
}

for (const harness of ['claude-code', 'codex'] as H[]) {
  describe(`setup ${harness} --skill-loading resolve`, () => {
    test('no skill directory: refuses with skill_resolver_setup_incomplete, names the scanned dirs, writes nothing of the resolver', async () => {
      const b = box();
      const r = await setup(b, harness, ['--skill-loading', 'resolve', '--json']);
      expect(r.exitCode).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('skill_resolver_setup_incomplete');
      expect(`${r.stdout}${r.stderr}`).toContain(HARNESS[harness].skills(b));
      expect(read(configPath(b))).toBeNull();
      expect(catalogs(b)).toEqual([]);
      expect(read(HARNESS[harness].hookFile(b)) ?? '').not.toContain('GBRAIN_HOOK_LANE=skill-resolver');
    });

    test('an empty skill directory: refuses and leaves no catalog behind', async () => {
      const b = box();
      mkdirSync(HARNESS[harness].skills(b), { recursive: true });
      const r = await setup(b, harness, ['--skill-loading', 'resolve', '--json']);
      expect(`${r.stdout}${r.stderr}`).toContain('skill_resolver_setup_incomplete');
      expect(read(configPath(b))).toBeNull();
      expect(catalogs(b)).toEqual([]);
    });

    test('on, idempotent, dry-run lists every write, then off and --remove undo all of it', async () => {
      const b = box();
      skill(HARNESS[harness].skills(b), 'deploy-widget', 'Deploy the widget service.');
      const plain = await setup(b, harness, []);
      expect(plain.exitCode).toBe(0);
      const before = { ...tree(b.home) };
      expect(catalogs(b)).toEqual([]);
      expect(read(configPath(b))).toBeNull();

      const dry = await setup(b, harness, ['--skill-loading', 'resolve', '--dry-run']);
      expect(dry.exitCode).toBe(0);
      for (const step of ['resolver catalog:', 'resolver config:', 'resolver hook:']) expect(dry.stdout).toContain(`would write resolver ${step.split(' ')[1]}`);
      expect(tree(b.home)).toEqual(before);

      const on = await setup(b, harness, ['--skill-loading', 'resolve']);
      expect(on.exitCode, on.stderr).toBe(0);
      expect(on.stdout).toContain('<relevant_skills>');
      expect(on.stdout).toMatch(/skill resolver: on; 1 skills; fresh/);
      expect(JSON.parse(read(configPath(b))!)).toEqual({ skills: { resolver: { enabled: true, harnesses: [harness] } } });
      expect(catalogs(b)).toEqual([`${harness}-user`]);
      const hooks = read(HARNESS[harness].hookFile(b))!;
      expect(hooks.split('GBRAIN_HOOK_LANE=skill-resolver').length - 1).toBe(2);
      if (harness === 'claude-code') expect(hooks).toContain(SKILL_RESOLVER_MARKER);
      else expect(read(join(b.home, '.codex', 'config.toml'))).toContain('skill-resolver');
      const launcherDir = join(gb(b), 'hook-launcher');
      const launcherFiles = readdirSync(launcherDir).sort();

      const resolverFiles = () => Object.fromEntries([configPath(b), HARNESS[harness].hookFile(b), join(b.home, '.codex', 'config.toml'), join(gb(b), 'skill-index', `${harness}-user`, 'receipt.json')].map((p) => [p, read(p)]));
      const onFiles = resolverFiles();
      const again = await setup(b, harness, ['--skill-loading', 'resolve', '--json']);
      expect(again.exitCode).toBe(0);
      expect(again.doc.skill_resolver.steps.map((s: any) => s.action)).toEqual(['keep', 'keep', 'keep']);
      const refresh = await setup(b, harness, ['--json']);
      expect(refresh.exitCode).toBe(0);
      expect(refresh.doc.skill_resolver.steps.every((s: any) => s.action === 'keep')).toBe(true);
      expect(resolverFiles()).toEqual(onFiles);
      expect(readdirSync(launcherDir).sort()).toEqual(launcherFiles);

      const off = await setup(b, harness, ['--skill-loading', 'off']);
      expect(off.exitCode).toBe(0);
      expect(read(configPath(b))).toBeNull();
      expect(catalogs(b)).toEqual([]);
      const rel = (p: string) => p.slice(b.home.length + 1);
      expect(read(HARNESS[harness].hookFile(b))).toBe(before[rel(HARNESS[harness].hookFile(b))]!);
      if (harness === 'codex') expect(read(join(b.home, '.codex', 'config.toml'))).toBe(before[rel(join(b.home, '.codex', 'config.toml'))]!);
      expect(existsSync(join(gb(b), 'skill-index', 'sessions'))).toBe(false);

      expect((await setup(b, harness, ['--skill-loading', 'resolve'])).exitCode).toBe(0);
      const removed = await runCli(['setup', harness, '--remove', '--gbrain-bin', b.bin], { env: b.env, cwd: b.project });
      expect(removed.exitCode, removed.stderr).toBe(0);
      expect(read(configPath(b))).toBeNull();
      expect(catalogs(b)).toEqual([]);
      expect(read(HARNESS[harness].hookFile(b))).toBe(before[rel(HARNESS[harness].hookFile(b))]!);
    });
  });
}

describe('setup --skill-loading resolve: refusals and other keys', () => {
  test('another harness refuses resolve', async () => {
    const b = box();
    const r = await setup(b, 'opencode', ['--skill-loading', 'resolve']);
    expect(r.exitCode).not.toBe(0);
    expect(read(configPath(b))).toBeNull();
  });

  test('an unreadable config: refuses with skill_resolver_config_unreadable and leaves the file as it was', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    mkdirSync(gb(b), { recursive: true });
    writeFileSync(configPath(b), '{ broken');
    const r = await setup(b, 'claude-code', ['--skill-loading', 'resolve', '--json']);
    expect(r.exitCode).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('skill_resolver_config_unreadable');
    expect(read(configPath(b))).toBe('{ broken');
    expect(catalogs(b)).toEqual([]);
  });

  test('other config keys survive on and off', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    mkdirSync(gb(b), { recursive: true });
    writeFileSync(configPath(b), JSON.stringify({ self_upgrade: { channel: 'alpha' } }));
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect(JSON.parse(read(configPath(b))!)).toEqual({ self_upgrade: { channel: 'alpha' }, skills: { resolver: { enabled: true, harnesses: ['claude-code'] } } });
    expect((await setup(b, 'claude-code', ['--skill-loading', 'off'])).exitCode).toBe(0);
    expect(JSON.parse(read(configPath(b))!)).toEqual({ self_upgrade: { channel: 'alpha' } });
  });

  test('config set|get|unset skills.resolver.* run without a brain; harnesses belongs to setup', async () => {
    const b = box();
    const run = (...args: string[]) => runCli(['config', ...args], { env: b.env, cwd: b.project });
    expect((await run('set', 'skills.resolver.lane_payload_chars', '600')).exitCode).toBe(0);
    expect((await run('get', 'skills.resolver.lane_payload_chars')).stdout.trim()).toBe('600');
    expect((await run('set', 'skills.resolver.lane_payload_chars', '20')).exitCode).not.toBe(0);
    expect((await run('set', 'skills.resolver.harnesses', 'codex')).exitCode).not.toBe(0);
    expect((await run('unset', 'skills.resolver.lane_payload_chars')).exitCode).toBe(0);
    expect(read(configPath(b))).toBeNull();
  });
});

describe('the engine boundary with resolver-only settings', () => {
  test('resolver keys alone configure no brain; an engine, a database or a remote endpoint does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-resolver-boundary-'));
    roots.push(dir);
    const write = (doc: unknown) => { mkdirSync(join(dir, '.gbrain'), { recursive: true }); writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(doc)); };
    const load = () => withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => loadConfig());
    write({ skills: { resolver: { enabled: true, harnesses: ['claude-code'] } } });
    expect(await load()).toBeNull();
    write({ autopilot: { incremental_extract_include_frontmatter: true }, skills: { resolver: { enabled: true } } });
    expect((await load())?.autopilot?.incremental_extract_include_frontmatter).toBe(true);
    write({ engine: 'pglite', database_path: join(dir, '.gbrain', 'brain.pglite'), skills: { resolver: { enabled: true, harnesses: ['claude-code'] } } });
    expect((await load())?.engine).toBe('pglite');
    write({ remote_mcp: { issuer_url: 'https://brain.example.invalid', mcp_url: 'https://brain.example.invalid/mcp', oauth_client_id: 'client-a' }, skills: { resolver: { enabled: true } } });
    expect((await load())?.remote_mcp).toBeTruthy();
  });

  test('after a brainless resolver setup, init creates the brain and keeps the keys; removal leaves the brain', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { env: b.env, cwd: b.project, timeoutMs: 120_000 });
    expect(init.exitCode, init.stderr).toBe(0);
    const cfg = JSON.parse(read(configPath(b))!);
    expect(cfg.engine).toBe('pglite');
    expect(cfg.skills).toEqual({ resolver: { enabled: true, harnesses: ['claude-code'] } });
    const stats = await runCli(['stats', '--json'], { env: b.env, cwd: b.project, timeoutMs: 120_000 });
    expect(stats.exitCode, stats.stderr).toBe(0);
    expect((await setup(b, 'claude-code', ['--skill-loading', 'off'])).exitCode).toBe(0);
    const left = JSON.parse(read(configPath(b))!);
    expect(left.engine).toBe('pglite');
    expect(left.skills).toBeUndefined();
  }, 240_000);
});

describe('doctor', () => {
  test('silent when the resolver is not configured; reports the lane once it is on', async () => {
    const b = box();
    const doctor = async (only = ['--only', 'skill_resolver']) => JSON.parse((await runCli(['doctor', ...only, '--json'], { env: b.env, cwd: b.project })).stdout);
    const unconfigured = await doctor(['--only', 'harness_wiring']);
    expect(unconfigured.checks.some((c: any) => c.name === 'harness_wiring')).toBe(true);
    expect(unconfigured.checks.find((c: any) => c.name === 'skill_resolver')).toBeUndefined();
    expect(JSON.stringify(unconfigured.checks.find((c: any) => c.name === 'harness_wiring'))).not.toContain('skill_resolver');
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    const on = (await doctor()).checks.find((c: any) => c.name === 'skill_resolver');
    expect(on).toMatchObject({ status: 'ok', details: { config: 'ok', harnesses: [{ harness: 'claude-code', on: true, hook: 'wired', catalogs: [{ name: 'claude-code-user', fresh: true, skills: 1 }] }] } });
    skill(HARNESS['claude-code'].skills(b), 'write-changelog', 'Write a changelog entry.');
    const stale = (await doctor()).checks.find((c: any) => c.name === 'skill_resolver');
    expect(stale.details.harnesses[0].catalogs[0]).toMatchObject({ fresh: false, stale_reason: 'source_changed' });
    const settings = JSON.parse(read(HARNESS['claude-code'].hookFile(b))!);
    for (const ev of Object.keys(settings.hooks)) settings.hooks[ev] = settings.hooks[ev].filter((g: any) => !JSON.stringify(g).includes('skill-resolver'));
    writeFileSync(HARNESS['claude-code'].hookFile(b), JSON.stringify(settings));
    const broken = (await doctor()).checks.find((c: any) => c.name === 'skill_resolver');
    expect(broken.status).toBe('warn');
    expect(broken.fix.argv).toEqual(['gbrain', 'setup', 'claude-code', '--skill-loading', 'resolve']);
    writeFileSync(configPath(b), '{ broken');
    const unreadable = (await doctor()).checks.find((c: any) => c.name === 'skill_resolver');
    expect(unreadable).toMatchObject({ status: 'warn', details: { code: 'skill_resolver_config_unreadable' } });
  });
});

describe('setup claude-code --skill-loading resolve: followed shared catalog', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  /** A fabricated shared-skills follow: harness receipt + adapter cache. */
  function followFixture(b: Box, viewToken = 'vt-1', extraSkills: { name: string; description: string; triggers?: string[] }[] = []) {
    const root = join(b.root, 'shared-root');
    const entries: Record<string, unknown> = {};
    const add = (name: string, description: string, triggers: string[] = []) => {
      const key = ['brain-1', 'src-1', '1', 'pack-1', name].map(encodeURIComponent).join('/');
      const rev = '01900000-0000-7000-8000-000000000001';
      const rel = `revisions/${sha(key)}/${sha(rev)}/skills/${name}/SKILL.md`;
      const p = join(root, 'shared-skills', rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, `---\nname: ${name}\ndescription: ${description}\n${triggers.length ? `triggers: [${triggers.map((t) => JSON.stringify(t)).join(', ')}]\n` : ''}---\nSteps.\n`);
      entries[key] = { revision: rev, files: { [`skills/${name}/SKILL.md`]: rel } };
    };
    add('citation-fixer', 'Fix citations; fix broken citations; citation audit', ['citation audit']);
    for (const s of extraSkills) add(s.name, s.description, s.triggers ?? []);
    mkdirSync(join(root, 'shared-skills'), { recursive: true });
    writeFileSync(join(root, 'shared-skills', 'receipt.json'), JSON.stringify({ installation_id: 'inst-1', enrollment_epoch: 3, status: 'joined' }));
    writeFileSync(join(root, 'shared-skills', 'active.json'), JSON.stringify({ brain_id: 'brain-1', installation_id: 'inst-1', enrollment_epoch: 3, view_token: viewToken, skills: entries }));
    mkdirSync(join(gb(b), 'bootstrap'), { recursive: true });
    writeFileSync(join(gb(b), 'bootstrap', 'harness.json'), JSON.stringify({
      harness_receipt_version: 1, created_at: new Date().toISOString(), created_by: 'gbrain', url: 'http://x', source_id: 's',
      token: { name: 't', minted: true }, targets: [],
      shared_skills: [{ host: 'claude-code', root, name: 'x', url: 'http://x', status: 'joined' }],
    }));
    return { root, setStatus: (status: string) => {
      const receipt = JSON.parse(readFileSync(join(gb(b), 'bootstrap', 'harness.json'), 'utf8')) as { shared_skills: { status: string }[] };
      receipt.shared_skills[0]!.status = status;
      writeFileSync(join(gb(b), 'bootstrap', 'harness.json'), JSON.stringify(receipt));
    } };
  }
  const resolve = (b: Box, text: string) => runCli(['skills', 'resolve', '--catalog', 'claude-code-user', '--catalog', 'claude-code-shared', '--text', text, '--json'], { env: b.env, cwd: b.project });
  const sharedSource = (b: Box) => JSON.parse(read(join(gb(b), 'skill-index', 'claude-code-shared', 'source.json'))!);
  const sharedReceipt = (b: Box) => JSON.parse(read(join(gb(b), 'skill-index', 'claude-code-shared', 'receipt.json'))!);
  /** The resolver's own files only: Bun's module cache under ~/.bun also moves on a re-run and is not gbrain's writing. */
  const resolverState = (b: Box) => ({
    config: read(configPath(b)),
    hook: read(HARNESS['claude-code'].hookFile(b)),
    catalogs: catalogs(b).sort(),
    userReceipt: read(join(gb(b), 'skill-index', 'claude-code-user', 'receipt.json')),
    sharedReceipt: read(join(gb(b), 'skill-index', 'claude-code-shared', 'receipt.json')),
    sharedSource: read(join(gb(b), 'skill-index', 'claude-code-shared', 'source.json')),
  });

  test('a followed shared catalog is snapshotted alongside the user catalog and ranks per turn', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    followFixture(b);
    const on = await setup(b, 'claude-code', ['--skill-loading', 'resolve']);
    expect(on.exitCode, on.stderr).toBe(0);
    expect(on.stdout).toContain('shared skills');
    expect(catalogs(b).sort()).toEqual(['claude-code-shared', 'claude-code-user']);
    expect(sharedSource(b).view_token).toBe('vt-1');
    expect(sharedSource(b).skills[0].load).toContain('get_skill');
    expect(sharedReceipt(b).catalog.source).toMatchObject({ kind: 'json', stdin: true });
    const r = await resolve(b, 'fix the broken citations across my brain pages');
    expect(r.exitCode, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.suggestions[0].id).toBe('citation-fixer');
    expect(out.suggestions[0].load).toContain('get_skill qualified_id="skill:brain-1:src-1:1:pack-1:citation-fixer"');
    expect(out.block).toContain('load: "get_skill');
  });

  test('idempotent: a re-run keeps both catalogs and writes nothing', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    followFixture(b);
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    const before = resolverState(b);
    const again = await setup(b, 'claude-code', ['--skill-loading', 'resolve', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.doc.skill_resolver.steps.map((s: { action: string }) => s.action)).toEqual(['keep', 'keep', 'keep', 'keep']);
    expect(resolverState(b)).toEqual(before);
  });

  test('a new view_token rebuilds the shared catalog with the new entries', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    followFixture(b);
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    followFixture(b, 'vt-2', [{ name: 'meeting-ingestion', description: 'Ingest a meeting transcript into decisions and action items', triggers: ['meeting transcript'] }]);
    const again = await setup(b, 'claude-code', ['--skill-loading', 'resolve']);
    expect(again.exitCode, again.stderr).toBe(0);
    expect(sharedSource(b).view_token).toBe('vt-2');
    expect(sharedSource(b).skills.map((s: { id: string }) => s.id).sort()).toEqual(['citation-fixer', 'meeting-ingestion']);
    const r = await resolve(b, 'ingest the meeting transcript');
    expect(JSON.parse(r.stdout).suggestions[0].id).toBe('meeting-ingestion');
  });

  test('when the follow is gone the orphaned snapshot is removed', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    const f = followFixture(b);
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect(catalogs(b).sort()).toEqual(['claude-code-shared', 'claude-code-user']);
    f.setStatus('left');
    const again = await setup(b, 'claude-code', ['--skill-loading', 'resolve']);
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stdout).toContain('no shared-skills follow');
    expect(catalogs(b)).toEqual(['claude-code-user']);
  });

  test('off removes the shared catalog too', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    followFixture(b);
    expect((await setup(b, 'claude-code', ['--skill-loading', 'resolve'])).exitCode).toBe(0);
    expect((await setup(b, 'claude-code', ['--skill-loading', 'off'])).exitCode).toBe(0);
    expect(catalogs(b)).toEqual([]);
  });

  test('dry-run lists the shared write and writes nothing', async () => {
    const b = box();
    skill(HARNESS['claude-code'].skills(b), 'deploy-widget', 'Deploy the widget service.');
    followFixture(b);
    const before = resolverState(b);
    const dry = await setup(b, 'claude-code', ['--skill-loading', 'resolve', '--dry-run']);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain('would write resolver catalog: 1 shared skills from brain-1 into');
    expect(resolverState(b)).toEqual(before);
  });
});
