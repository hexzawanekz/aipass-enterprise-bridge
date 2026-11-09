import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'autostart.mjs');
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('autostart --help exits 0', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage:/);
  assert.match(result.stdout, /8787/);
});

test('dry-run install describes a sign-in start and does not register one', () => {
  const result = run(['install', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dry run/);
  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.match(result.stdout, /at sign-in/);
    assert.match(result.stdout, /server\.mjs/);
    assert.match(result.stdout, /127\.0\.0\.1:8787/);
  } else {
    assert.match(result.stdout, /Windows and macOS/);
  }
});
