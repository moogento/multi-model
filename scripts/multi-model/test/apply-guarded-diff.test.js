import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyGuardedDiff } from '../apply-guarded-diff.js';

let repoRoot;
let diffDir;
let outcomeDir;
let outcomeLogFile;

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

function readOutcomes() {
  if (!existsSync(outcomeLogFile)) return [];
  return readFileSync(outcomeLogFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

before(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'mm-apply-'));
  diffDir = mkdtempSync(path.join(tmpdir(), 'mm-apply-diffs-'));
  outcomeDir = mkdtempSync(path.join(tmpdir(), 'mm-apply-outcomes-'));
  outcomeLogFile = path.join(outcomeDir, 'outcomes.jsonl');
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\n');
  writeFileSync(path.join(repoRoot, '.env'), 'SECRET=1\n');
  mkdirSync(path.join(repoRoot, 'locked-dir'));
  writeFileSync(path.join(repoRoot, 'locked-dir', 'locked.js'), 'console.log("start");\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

after(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(diffDir, { recursive: true, force: true });
  rmSync(outcomeDir, { recursive: true, force: true });
});

test('applies a clean diff, updates the working tree, and logs a kept/applied-clean outcome', () => {
  writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\nconsole.log("changed");\n');
  const diffText = git(['diff']);
  git(['checkout', '--', '.']);
  const diffPath = path.join(diffDir, '2026-07-01T00-00-00-000Z-a1b2c3-deepseek.diff');
  writeFileSync(diffPath, diffText);

  const result = applyGuardedDiff(diffPath, { repoRoot, command: 'mm-implement', outcomeLogFile });
  assert.equal(result.applied, true);
  assert.match(readFileSync(path.join(repoRoot, 'app.js'), 'utf8'), /changed/);

  const record = readOutcomes().at(-1);
  assert.equal(record.command, 'mm-implement');
  assert.equal(record.provider, 'deepseek');
  assert.equal(record.outcome, 'kept');
  assert.equal(record.reasonCategory, 'applied-clean');
});

test('rejects a diff touching .env without applying anything, and logs a dropped/rejected-by-diff-guard outcome', () => {
  writeFileSync(path.join(repoRoot, '.env'), 'SECRET=2\n');
  const diffText = git(['diff']);
  git(['checkout', '--', '.']);
  const diffPath = path.join(diffDir, '2026-07-01T00-01-00-000Z-d4e5f6-glm.diff');
  writeFileSync(diffPath, diffText);

  const result = applyGuardedDiff(diffPath, { repoRoot, command: 'mm-implement', outcomeLogFile });
  assert.equal(result.applied, false);
  assert.ok(result.violations.length > 0);
  assert.equal(readFileSync(path.join(repoRoot, '.env'), 'utf8'), 'SECRET=1\n');

  const record = readOutcomes().at(-1);
  assert.equal(record.command, 'mm-implement');
  assert.equal(record.provider, 'glm');
  assert.equal(record.outcome, 'dropped');
  assert.equal(record.reasonCategory, 'rejected-by-diff-guard');
});

test(
  'logs a dropped/diff-inapplicable outcome and rethrows when git apply fails to write a guard-passed diff',
  { skip: process.getuid && process.getuid() === 0 ? 'root bypasses file permission checks' : false },
  () => {
    writeFileSync(path.join(repoRoot, 'locked-dir', 'locked.js'), 'console.log("start");\nconsole.log("changed");\n');
    const diffText = git(['diff']);
    git(['checkout', '--', '.']);
    chmodSync(path.join(repoRoot, 'locked-dir'), 0o555);
    const diffPath = path.join(diffDir, '2026-07-01T00-02-00-000Z-112233-deepseek-pro.diff');
    writeFileSync(diffPath, diffText);
    try {
      assert.throws(() => applyGuardedDiff(diffPath, { repoRoot, command: 'mm-alt', outcomeLogFile }));
      const record = readOutcomes().at(-1);
      assert.equal(record.command, 'mm-alt');
      assert.equal(record.provider, 'deepseek-pro');
      assert.equal(record.outcome, 'dropped');
      assert.equal(record.reasonCategory, 'diff-inapplicable');
    } finally {
      chmodSync(path.join(repoRoot, 'locked-dir'), 0o755);
    }
  }
);

test('parses "unknown" as the provider from a patch filename with no recognizable suffix', () => {
  writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\nconsole.log("changed-again");\n');
  const diffText = git(['diff']);
  git(['checkout', '--', '.']);
  const diffPath = path.join(diffDir, 'manually-named.diff');
  writeFileSync(diffPath, diffText);

  const result = applyGuardedDiff(diffPath, { repoRoot, command: 'mm-implement', outcomeLogFile });
  assert.equal(result.applied, true);
  const record = readOutcomes().at(-1);
  assert.equal(record.provider, 'unknown');
});

test('defaults command to "unknown" when not passed', () => {
  writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\nconsole.log("changed-once-more");\n');
  const diffText = git(['diff']);
  git(['checkout', '--', '.']);
  const diffPath = path.join(diffDir, '2026-07-01T00-03-00-000Z-998877-deepseek.diff');
  writeFileSync(diffPath, diffText);

  applyGuardedDiff(diffPath, { repoRoot, outcomeLogFile });
  const record = readOutcomes().at(-1);
  assert.equal(record.command, 'unknown');
});

test('applies a diff with miscounted hunk headers through --recount and logs kept/applied-clean', () => {
  writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\nconsole.log("recounted");\n');
  const diffText = git(['diff']).replace(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/m, '@@ -$1,99 +$2,99 @@');
  git(['checkout', '--', '.']);
  const diffPath = path.join(diffDir, '2026-07-01T00-02-00-000Z-abc123-deepseek-pro.diff');
  writeFileSync(diffPath, diffText);

  const result = applyGuardedDiff(diffPath, { repoRoot, command: 'mm-implement', outcomeLogFile });
  assert.equal(result.applied, true);
  assert.match(readFileSync(path.join(repoRoot, 'app.js'), 'utf8'), /recounted/);

  const record = readOutcomes().at(-1);
  assert.equal(record.provider, 'deepseek-pro');
  assert.equal(record.outcome, 'kept');
});

test('rejects a miscounted diff that violates the guard without applying anything', () => {
  writeFileSync(path.join(repoRoot, '.env'), 'SECRET=3\n');
  const diffText = git(['diff']).replace(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/m, '@@ -$1,99 +$2,99 @@');
  git(['checkout', '--', '.']);
  const diffPath = path.join(diffDir, '2026-07-01T00-03-00-000Z-def456-glm.diff');
  writeFileSync(diffPath, diffText);

  const result = applyGuardedDiff(diffPath, { repoRoot, command: 'mm-implement', outcomeLogFile });
  assert.equal(result.applied, false);
  assert.equal(readFileSync(path.join(repoRoot, '.env'), 'utf8'), 'SECRET=1\n');

  const record = readOutcomes().at(-1);
  assert.equal(record.outcome, 'dropped');
  assert.equal(record.reasonCategory, 'rejected-by-diff-guard');
});
