/**
 * Refactor wave 1 W4 (cli, EO5b): a command registered through the table gets
 * flag validation and engine-free help with no dispatcher edit.
 *
 * Protects: the "add a record + a module" contributor path. The flag registry
 * generator reads the command table and the per-command module (plus the
 * explicit pipeline stages), so a synthetic command's consumed flag is legal,
 * an unknown flag is rejected by the same validator the CLI runs before
 * dispatch, and the module answers --help without touching the engine.
 * Fails when: the generator stops reading the table or src/cli/commands/, a
 * pipeline stage's branch text is no longer attributed to its command, or the
 * pre-connect module contract needs an engine for help.
 * Why new: on master a command was a switch case the generator parsed by
 * regex; the table is a new registration path. Seam: buildFlagRegistry(root)
 * over a temp fixture tree (never the real repo).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { buildFlagRegistry } from '../scripts/generate-flag-registry.ts';
import { findUnknownFlag } from '../src/cli/main.ts';

const FILES: Record<string, string> = {
  'src/cli/main.ts': [
    'async function handleCliOnly(command: string, args: string[]) {',
    '  if (await routeSyntheticBeforeTable(command, args)) return;',
    '  if (await dispatchPreConnectCommand(command, args)) return;',
    '}',
    '',
    '/** @cliPipelineStage */',
    'async function routeSyntheticBeforeTable(command: string, args: string[]): Promise<boolean> {',
    "  if (command === 'synthetic-example' && args[0] === 'legacy') {",
    "    return args.includes('--legacy-mode');",
    '  }',
    '  return false;',
    '}',
    '',
  ].join('\n'),
  'src/cli/command-table.ts': [
    'export const CLI_COMMANDS = [',
    "  { name: 'synthetic-example', phase: 'pre-connect', thinClient: 'none', load: () => import('./commands/synthetic-example.ts') },",
    '];',
    '',
  ].join('\n'),
  'src/cli/commands/synthetic-example.ts': [
    'export async function run(args: string[], ctx: { connectEngine(): Promise<never> }): Promise<void> {',
    "  const { runSyntheticExample } = await import('../../commands/synthetic-example.ts');",
    '  await runSyntheticExample(args, () => ctx.connectEngine());',
    '}',
    '',
  ].join('\n'),
  'src/commands/synthetic-example.ts': [
    'export async function runSyntheticExample(args: string[], connect: () => Promise<never>): Promise<void> {',
    "  if (args.includes('--help')) {",
    "    console.log('Usage: gbrain synthetic-example [--frobnicate]');",
    '    return;',
    '  }',
    "  if (args.includes('--frobnicate')) {",
    "    await import('./synthetic-dep.ts');",
    "    await import('./behavior-change-notice.ts');",
    '    await connect();',
    '  }',
    '}',
    '',
  ].join('\n'),
  // #8867: a dep module whose git argv arrays and git() helper calls carry
  // git's own flags, plus help text naming a flag the command never parses.
  'src/commands/synthetic-dep.ts': [
    "import { execFileSync } from 'child_process';",
    'function git(root: string, args: string[]): string | null {',
    "  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' }).toString(); } catch { return null; }",
    '}',
    'function syncGit(root: string, args: string[]): string { return root + args.join(" "); }',
    "// A data table mapping positionals to real flags — ['status', '--status']",
    '// is an array ELEMENT, not git argv, so --status/--install stay legal.',
    "export const ALIASES = new Map([['status', '--status'], ['install', '--install']]);",
    'export function checkDep(root: string): void {',
    "  execFileSync('git', ['log', '--date=unix', '--porcelain'], { encoding: 'utf-8' });",
    "  git(root, ['status', '--short']);",
    "  syncGit(root, ['rev-parse', '--show-toplevel']);",
    "  const statusArgs = ['status', '--porcelain'];",
    "  execFileSync('git', statusArgs, { encoding: 'utf-8' });",
    "  statusArgs.push('--untracked-files=no');",
    "  console.log('Usage: gbrain synthetic-example [--dep-flag]');",
    '}',
    '',
  ].join('\n'),
  // #8867: a behavior-change notice module whose BEHAVIOR_CHANGES prose names
  // an uncommitted `git merge --squash` — disclosure text, not a parsed flag.
  'src/commands/behavior-change-notice.ts': [
    'export const BEHAVIOR_CHANGES = [',
    "  { since: '0.60.616.0', id: 'synthetic_notice_8867', text: 'Adoption keeps the file_database_drift refusal while an uncommitted `git merge --squash` is in progress.' },",
    '];',
    '',
  ].join('\n'),
};

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-synthetic-command-'));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('synthetic command registered through the table', () => {
  test('its consumed flag is legal and an unknown flag is rejected', () => {
    const legal = new Set(buildFlagRegistry(root)['synthetic-example']);
    expect(legal.has('--frobnicate')).toBe(true);
    expect(legal.has('--legacy-mode')).toBe(true);
    expect(findUnknownFlag(['--frobnicate'], legal)).toBeNull();
    expect(findUnknownFlag(['legacy', '--legacy-mode'], legal)).toBeNull();
    expect(findUnknownFlag(['--frobnicate', '--definitely-not-a-flag'], legal)).toBe('--definitely-not-a-flag');
    expect(findUnknownFlag(['--help'], legal)).toBeNull();
  });

  test('#8867: git argv and behavior-change prose do not legalise flags', () => {
    const legal = new Set(buildFlagRegistry(root)['synthetic-example']);
    // Help-text over-inclusion is deliberate: --dep-flag stays legal.
    expect(legal.has('--dep-flag')).toBe(true);
    // Git argv: --date=unix / --porcelain from the spawn array, --short from
    // the local git() helper call — git's flags, never parsed by the command.
    expect(legal.has('--date')).toBe(false);
    expect(legal.has('--porcelain')).toBe(false);
    expect(legal.has('--short')).toBe(false);
    // --show-toplevel from a git-helper call's array, --untracked-files
    // from a variable argv's .push — both git argv, not command flags.
    expect(legal.has('--show-toplevel')).toBe(false);
    expect(legal.has('--untracked-files')).toBe(false);
    // The ALIASES data table maps positionals to REAL flags: its array
    // elements are not git argv, so --status/--install stay legal.
    expect(legal.has('--status')).toBe(true);
    expect(legal.has('--install')).toBe(true);
    // BEHAVIOR_CHANGES prose naming `git merge --squash` is not a flag.
    expect(legal.has('--squash')).toBe(false);
  });

  test('its module answers --help without connecting an engine', async () => {
    const mod = await import(join(root, 'src/cli/commands/synthetic-example.ts'));
    let connects = 0;
    const ctx = { connectEngine: async (): Promise<never> => { connects++; throw new Error('engine must not be touched for --help'); } };
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      await mod.run(['--help'], ctx);
    } finally {
      console.log = log;
    }
    expect(lines).toEqual(['Usage: gbrain synthetic-example [--frobnicate]']);
    expect(connects).toBe(0);
    await expect(mod.run(['--frobnicate'], ctx)).rejects.toThrow('engine must not be touched');
    expect(connects).toBe(1);
  });
});
