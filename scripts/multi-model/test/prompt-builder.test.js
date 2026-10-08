import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readFilesForPrompt, buildPlanMessages, buildImplementMessages, buildImplementNotesMessages,
  buildReviewMessages, buildSelfVerifyMessages, buildReviseMessages, buildExplainMessages, buildDocsMessages,
  extractDiff, extractJson,
} from '../prompt-builder.js';

test('readFilesForPrompt inlines file contents with headers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-test-'));
  const filePath = path.join(dir, 'a.txt');
  writeFileSync(filePath, 'hello world');
  const result = readFilesForPrompt([filePath]);
  assert.match(result, /FILE: .*a\.txt/);
  assert.match(result, /hello world/);
});

test('readFilesForPrompt allows a capture file under /tmp, which macOS keeps distinct from os.tmpdir()', () => {
  const dir = mkdtempSync('/tmp/mm-allow-');
  const filePath = path.join(dir, 'capture.txt');
  writeFileSync(filePath, 'plain capture content');
  try {
    const result = readFilesForPrompt([filePath]);
    assert.match(result, /plain capture content/);
    assert.ok(!result.includes('[skipped:'), `expected no skip placeholder, got: ${result}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readFilesForPrompt rejects a temp-dir symlink that resolves outside the allowed roots', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-symlink-'));
  const linkPath = path.join(dir, 'sneaky.txt');
  symlinkSync('/etc/hosts', linkPath);
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = readFilesForPrompt([linkPath]);
    assert.match(result, /skipped: .*resolves outside the repository/);
  } finally {
    console.error = originalConsoleError;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readFilesForPrompt reports unreadable files without throwing', () => {
  const missingPath = path.join(process.cwd(), 'scripts', 'multi-model', 'test', '__does-not-exist__.txt');
  const result = readFilesForPrompt([missingPath]);
  assert.match(result, /unreadable/);
});

test('readFilesForPrompt never reads a path outside the repository or the system temp dir', () => {
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...msgArgs) => errors.push(msgArgs.join(' '));
  try {
    const result = readFilesForPrompt(['/etc/passwd']);
    assert.match(result, /skipped: \/etc\/passwd resolves outside the repository/);
    assert.doesNotMatch(result, /root:.*:0:0:/);
    assert.ok(errors.some((e) => e.includes('/etc/passwd')), `expected a warning naming /etc/passwd, got: ${JSON.stringify(errors)}`);
  } finally {
    console.error = originalConsoleError;
  }
});

test('readFilesForPrompt never sends the contents of a sensitive-pattern path to a provider', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-test-'));
  const envPath = path.join(dir, '.env');
  writeFileSync(envPath, 'DEEPSEEK_API_KEY=super-secret-value');
  const secretsPath = path.join(dir, '.secrets', 'foo');
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...msgArgs) => errors.push(msgArgs.join(' '));
  try {
    const result = readFilesForPrompt([envPath, secretsPath]);
    assert.match(result, /skipped:.*matches sensitive-file pattern/);
    assert.doesNotMatch(result, /super-secret-value/);
    assert.equal(errors.length, 2, `expected one console.error warning per skipped path, got: ${JSON.stringify(errors)}`);
    assert.ok(errors.some((e) => e.includes(envPath)), `expected a warning naming ${envPath}, got: ${JSON.stringify(errors)}`);
    assert.ok(errors.some((e) => e.includes(secretsPath)), `expected a warning naming ${secretsPath}, got: ${JSON.stringify(errors)}`);
  } finally {
    console.error = originalConsoleError;
  }
});

// real bypass: moo.md's Stage 8/9 commit-message/PR-draft steps dump a captured diff to a
// /tmp file and pass it via --files, so it never carries a sensitive filename itself. Without
// scanning diff-shaped content, a diff touching .env or carrying a secret value would reach
// docs.js's external provider call with no gate at all.
test('readFilesForPrompt never sends a captured diff that touches a sensitive path', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-test-'));
  const diffPath = path.join(dir, 'mm-commit-diff-123.txt');
  writeFileSync(diffPath, [
    'diff --git a/.env b/.env',
    '--- a/.env',
    '+++ b/.env',
    '@@ -1 +1 @@',
    '-OLD=1',
    '+NEW=2',
    '',
  ].join('\n'));
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...msgArgs) => errors.push(msgArgs.join(' '));
  try {
    const result = readFilesForPrompt([diffPath]);
    assert.match(result, /skipped: diff content rejected/);
    assert.doesNotMatch(result, /NEW=2/);
    assert.ok(errors.some((e) => e.includes('sensitive path')), JSON.stringify(errors));
  } finally {
    console.error = originalConsoleError;
  }
});

test('readFilesForPrompt never sends a captured diff containing a secret-looking value', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-test-'));
  const diffPath = path.join(dir, 'mm-pr-diff-456.txt');
  writeFileSync(diffPath, [
    'diff --git a/config.js b/config.js',
    '--- a/config.js',
    '+++ b/config.js',
    '@@ -1 +1 @@',
    '-const key = "old"',
    '+const key = "AKIAABCDEFGHIJKLMNOP"',
    '',
  ].join('\n'));
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = readFilesForPrompt([diffPath]);
    assert.match(result, /skipped: diff content rejected/);
    assert.doesNotMatch(result, /AKIAABCDEFGHIJKLMNOP/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('readFilesForPrompt still sends an ordinary captured diff with no sensitive paths or secrets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-test-'));
  const diffPath = path.join(dir, 'mm-commit-diff-789.txt');
  writeFileSync(diffPath, [
    'diff --git a/app.js b/app.js',
    '--- a/app.js',
    '+++ b/app.js',
    '@@ -1 +1 @@',
    '-console.log("old")',
    '+console.log("new")',
    '',
  ].join('\n'));
  const result = readFilesForPrompt([diffPath]);
  assert.match(result, /console\.log\("new"\)/);
  assert.doesNotMatch(result, /skipped/);
});

test('buildPlanMessages returns system+user messages containing the task and files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-test-'));
  const filePath = path.join(dir, 'a.txt');
  writeFileSync(filePath, 'content');
  const messages = buildPlanMessages('add a widget', [filePath]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /add a widget/);
});

test('buildImplementMessages instructs diff-only output', () => {
  const messages = buildImplementMessages('fix the thing', []);
  assert.match(messages[0].content, /unified diff/i);
});

test('buildImplementMessages and buildReviseMessages carry repo coding standards and exact-content rules', () => {
  for (const messages of [
    buildImplementMessages('fix the thing', []),
    buildReviseMessages('fix the thing', [], 'diff --git a/x b/x\n', { issues: [] }),
  ]) {
    assert.match(messages[0].content, /Repo coding standards/);
    assert.match(messages[0].content, /@var/);
    assert.match(messages[0].content, /EXACTLY/);
    assert.match(messages[0].content, /follow its interfaces/);
    assert.match(messages[0].content, /\/dev\/null/);
  }
});

test('buildReviewMessages instructs strict JSON output', () => {
  const messages = buildReviewMessages('review this', 'diff --git a/x b/x\n');
  assert.match(messages[0].content, /JSON/);
  assert.match(messages[0].content, /at most five issues/);
  assert.match(messages[0].content, /Never put confirmations/);
  assert.match(messages[1].content, /diff --git/);
});

test('buildReviseMessages includes the task, files, previous diff, and critique, and instructs diff-only output', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-test-'));
  const filePath = path.join(dir, 'a.txt');
  writeFileSync(filePath, 'content');
  const critique = { issues: [{ file: 'a.txt', line: 1, summary: 'wrong approach', severity: 'HIGH' }], risks: [], missing: [] };
  const messages = buildReviseMessages('fix the thing', [filePath], 'diff --git a/a.txt b/a.txt\n+old\n', critique);
  assert.match(messages[0].content, /unified diff/i);
  assert.match(messages[1].content, /fix the thing/);
  assert.match(messages[1].content, /content/);
  assert.match(messages[1].content, /diff --git a\/a\.txt b\/a\.txt/);
  assert.match(messages[1].content, /wrong approach/);
});

test('buildReviseMessages puts reviewer feedback and the previous diff before the file dump so truncation cannot drop them', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-test-'));
  const filePath = path.join(dir, 'a.txt');
  writeFileSync(filePath, 'content');
  const critique = { issues: [{ file: 'a.txt', line: 1, summary: 'wrong approach', severity: 'HIGH' }], risks: [], missing: [] };
  const messages = buildReviseMessages('fix the thing', [filePath], 'diff --git a/a.txt b/a.txt\n+old\n', critique);
  const feedbackIndex = messages[1].content.indexOf('wrong approach');
  const filesIndex = messages[1].content.indexOf('Files:');
  assert.ok(feedbackIndex >= 0 && filesIndex >= 0 && feedbackIndex < filesIndex,
    'callChatCompletion truncates from the tail, so feedback must come before the (potentially large) file dump');
});

test('buildExplainMessages includes the symbol when given', () => {
  const messages = buildExplainMessages([], 'MyClass::method');
  assert.match(messages[1].content, /MyClass::method/);
});

test('buildDocsMessages switches instruction based on mode', () => {
  const diffMode = buildDocsMessages('doc it', [], 'diff');
  const mdMode = buildDocsMessages('doc it', [], 'markdown');
  assert.match(diffMode[0].content, /unified diff/i);
  assert.match(mdMode[0].content, /Markdown/);
});

test('extractDiff strips markdown fences', () => {
  const raw = '```diff\ndiff --git a/x b/x\n+hello\n```';
  assert.equal(extractDiff(raw), 'diff --git a/x b/x\n+hello\n');
});

test('extractDiff preserves a trailing blank context line instead of corrupting the hunk', () => {
  const raw = '```diff\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n \n```';
  assert.equal(extractDiff(raw), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n \n');
});

test('extractDiff keeps a diff that itself adds markdown fence lines intact', () => {
  const raw = '```diff\ndiff --git a/doc.md b/doc.md\n--- a/doc.md\n+++ b/doc.md\n@@ -1,1 +1,3 @@\n line1\n+```php\n+echo 1;\n+```\n```';
  const out = extractDiff(raw);
  assert.ok(out.includes('+echo 1;'), 'content after an added inner fence must survive');
  assert.ok(out.endsWith('+```\n'), `expected the added closing fence to survive, got: ${JSON.stringify(out.slice(-20))}`);
});

test('extractDiff passes through unfenced content', () => {
  assert.equal(extractDiff('diff --git a/x b/x\n'), 'diff --git a/x b/x\n');
});

test('extractJson parses fenced JSON', () => {
  const raw = '```json\n{"issues":[],"risks":[],"missing":[]}\n```';
  const result = extractJson(raw);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { issues: [], risks: [], missing: [] });
});

test('extractJson reports parse failure without throwing', () => {
  const result = extractJson('not json at all');
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
});

test('buildImplementNotesMessages demands grounded Markdown notes, never a diff', () => {
  const messages = buildImplementNotesMessages('do the task', []);
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /never a diff or patch/);
  assert.match(messages[0].content, /never reference a file, class, method, or constant that does not appear/);
  assert.match(messages[0].content, /## Missing context/);
  assert.match(messages[0].content, /Repo coding standards/);
  assert.match(messages[1].content, /Task:\ndo the task/);
});

test('buildReviewMessages without file context tells the reviewer to downgrade unseen-code concerns to risks', () => {
  const messages = buildReviewMessages('task', 'diff body');
  assert.match(messages[0].content, /list it under "risks" as a question/);
  assert.ok(!messages[1].content.includes('Current full content of changed files'));
});

test('buildReviewMessages with file context appends it and requires verification against it', () => {
  const messages = buildReviewMessages('task', 'diff body', '--- FILE: a.php ---\n<?php class A {}');
  assert.match(messages[0].content, /check it before/);
  assert.match(messages[1].content, /Current full content of changed files:\n--- FILE: a\.php ---/);
});

test('buildReviewMessages requires evidence on issues and routes evidence-free concerns to risks', () => {
  const messages = buildReviewMessages('t', 'diff body');
  assert.match(messages[0].content, /"evidence":string/);
  assert.match(messages[0].content, /quote, verbatim/);
  assert.match(messages[0].content, /cannot\s+quote evidence.*"risks"/s);
});

test('buildReviewMessages appends the known-non-issues brief only when provided', () => {
  const withBrief = buildReviewMessages('t', 'diff', '', '- never flag frobnication');
  assert.match(withBrief[0].content, /Known non-issues in this codebase/);
  assert.match(withBrief[0].content, /never flag frobnication/);
  const withoutBrief = buildReviewMessages('t', 'diff');
  assert.doesNotMatch(withoutBrief[0].content, /Known non-issues/);
});

test('buildSelfVerifyMessages carries the earlier findings and forbids new ones', () => {
  const review = { issues: [{ file: 'a.php', line: 1, summary: 's', severity: 'HIGH', evidence: '' }], risks: [], missing: [] };
  const messages = buildSelfVerifyMessages('task ctx', review, 'FILE: a.php\ncontent');
  assert.match(messages[0].content, /re-verifying your own/);
  assert.match(messages[0].content, /Do not add new findings/);
  assert.match(messages[1].content, /Your earlier findings/);
  assert.match(messages[1].content, /"a\.php"/);
  assert.match(messages[1].content, /Additional file content/);
});
