/**
 * #8870: a failed ledger location lookup is cached for the life of the process.
 *
 * `ledgerLocation` stores its result in a module-level cache even when the git
 * call threw, so one transient failure makes every later lookup in the process
 * report the ledger as missing. The test below fails the first git call and
 * expects the next lookup to retry and succeed.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerLocation, resetLedgerCacheForTests } from '../src/core/git/commit-ledger.ts';

function initRepo(root: string): void {
  childProcess.execFileSync('git', ['init', '-q', root]);
  childProcess.execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  childProcess.execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  childProcess.execFileSync('git', ['-C', root, 'commit', '-q', '--allow-empty', '-m', 'init']);
}

describe('ledgerLocation', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-ledger-location-'));
    initRepo(root);
    resetLedgerCacheForTests();
  });

  afterEach(() => {
    mock.restore();
    resetLedgerCacheForTests();
    rmSync(root, { recursive: true, force: true });
  });

  test('a transient git failure is not cached: the next lookup retries and succeeds', () => {
    const spy = spyOn(childProcess, 'execFileSync');
    // Only the first git call throws (a transient failure); the rest run for real.
    spy.mockImplementationOnce(() => {
      throw new Error('simulated transient git failure');
    });

    expect(ledgerLocation(root)).toBeNull();

    const found = ledgerLocation(root);
    expect(found).not.toBeNull();
    expect(found!.worktree).toBe(realpathSync(root));

    // The successful lookup stays cached: no further git calls.
    const calls = spy.mock.calls.length;
    expect(ledgerLocation(root)).toBe(found);
    expect(spy.mock.calls.length).toBe(calls);
  });
});
