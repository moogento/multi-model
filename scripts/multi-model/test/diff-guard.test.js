import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guardDiff, scanDiffForLeaks } from '../diff-guard.js';
import { applyGuardedDiff } from '../apply-guarded-diff.js';

let repoRoot;
let diffDir;

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...opts });
}

function diffForChange(mutate) {
  mutate();
  const diffText = git(['diff']);
  git(['checkout', '--', '.']);
  return diffText;
}

// git mv stages immediately and untracked paths never show in unstaged diff, so rename/new-file fixtures need staged diff + hard reset.
function diffForStagedChange(mutate) {
  mutate();
  git(['add', '-A']);
  const diffText = git(['diff', '--cached']);
  git(['reset', '--hard', 'HEAD']);
  return diffText;
}

before(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'mm-diffguard-'));
  diffDir = mkdtempSync(path.join(tmpdir(), 'mm-diffguard-diffs-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\n'.repeat(1));
  writeFileSync(path.join(repoRoot, '.env'), 'SECRET=1\n');
  writeFileSync(path.join(repoRoot, 'safe.txt'), 'nothing sensitive here\n');
  mkdirSync(path.join(repoRoot, 'vendor'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'vendor', 'lib.php'), '<?php\n// vendor code\n');
  writeFileSync(path.join(repoRoot, 'big.js'), Array.from({ length: 60 }, (_, i) => `line${i}\n`).join(''));
  writeFileSync(path.join(repoRoot, 'important.js'), Array.from({ length: 200 }, (_, i) => `line${i}\n`).join(''));
  writeFileSync(path.join(repoRoot, 'adecoy.js'), '// nothing interesting\n');
  mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'config', 'credentials.txt'), 'API_KEY=placeholder\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

after(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(diffDir, { recursive: true, force: true });
});

test('accepts a clean diff to a normal tracked file', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\nconsole.log("more");\n');
  });
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('rejects a diff touching .env', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, '.env'), 'SECRET=2\n');
  });
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('sensitive path')));
});

test('rejects a diff touching vendor/ by default, accepts with --allow-vendor', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'vendor', 'lib.php'), '<?php\n// vendor code changed\n');
  });
  const blocked = guardDiff(diffText, repoRoot);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.violations.some((v) => v.includes('vendor')));

  const allowed = guardDiff(diffText, repoRoot, { allowVendor: true });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.violations));
});

test('rejects an added line that looks like a secret, with no override', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\nconst apiKey = "sk-abcdefghijklmnopqrstuvwx";\n');
  });
  const result = guardDiff(diffText, repoRoot, {
    allowVendor: true, allowSensitivePaths: true, allowNetwork: true, allowLargeDeletion: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('secret')));
  assert.ok(
    !result.violations.some((v) => v.includes('sk-abcdefghijklmnopqrstuvwx')),
    'violation message must not echo the detected secret value',
  );
});

test('scans an added line whose content starts with ++ (rendered as +++) instead of mistaking it for a header', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\n++retries; fetch("https://example.com");\n');
  });
  const blocked = guardDiff(diffText, repoRoot);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.violations.some((v) => v.includes('network')));
});

test('rejects a new network call by default, accepts with --allow-network', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\nfetch("https://example.com");\n');
  });
  const blocked = guardDiff(diffText, repoRoot);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.violations.some((v) => v.includes('network')));

  const allowed = guardDiff(diffText, repoRoot, { allowNetwork: true });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.violations));
});

test('redacts a secret embedded in a network-call line instead of echoing it via the network violation', () => {
  const diffText = diffForChange(() => {
    writeFileSync(
      path.join(repoRoot, 'app.js'),
      'console.log("start");\nfetch("https://example.com?token=ghp_abcdefghijklmnopqrstuvwxyz0123456789");\n',
    );
  });
  const result = guardDiff(diffText, repoRoot, { allowVendor: true, allowSensitivePaths: true, allowLargeDeletion: true });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('network')));
  assert.ok(
    !result.violations.some((v) => v.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789')),
    'no violation message may echo the detected secret value',
  );
});

test('rejects an oversized deletion by default, accepts with --allow-large-deletion', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'big.js'), 'line0\n');
  });
  const blocked = guardDiff(diffText, repoRoot);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.violations.some((v) => v.includes('removes')));

  const allowed = guardDiff(diffText, repoRoot, { allowLargeDeletion: true });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.violations));
});

test('rejects a syntactically invalid diff', () => {
  const result = guardDiff('this is not a diff\nat all\n', repoRoot);
  assert.equal(result.ok, false);
  assert.ok(result.violations.length > 0);
});

test('rejects an empty diff', () => {
  const result = guardDiff('   \n', repoRoot);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, ['empty diff']);
});

test('rejects an oversized deletion across a git rename, not just a plain modify', () => {
  const diffText = diffForStagedChange(() => {
    git(['mv', 'important.js', 'renamed.js']);
    writeFileSync(path.join(repoRoot, 'renamed.js'), Array.from({ length: 130 }, (_, i) => `line${i}\n`).join(''));
  });
  assert.ok(diffText.includes('rename from important.js'), `expected git to detect a rename: ${diffText.slice(0, 200)}`);
  const blocked = guardDiff(diffText, repoRoot);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.violations.some((v) => v.includes('removes')));

  const allowed = guardDiff(diffText, repoRoot, { allowLargeDeletion: true });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.violations));
});

test('attributes an oversized deletion to the right file despite decoy diff-header-shaped text earlier in the diff', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'adecoy.js'), '// nothing interesting\n// diff --git a/big.js b/big.js\n');
    writeFileSync(path.join(repoRoot, 'big.js'), 'line0\n');
  });
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('big.js') && v.includes('removes 59')));
});

// Nests under config/ (not top-level .ENV) since macOS APFS is case-insensitive and would resolve to the already-tracked .env inode.
test('rejects .ENV (uppercase) the same as .env', () => {
  const diffText = diffForStagedChange(() => {
    mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'config', '.ENV'), 'X=1\n');
  });
  assert.ok(diffText.includes('config/.ENV'), `expected a real new-file diff: ${diffText.slice(0, 200)}`);
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('sensitive path')));
});

// Same case-insensitive-filesystem reasoning as above: nests under modules/ so it can't fold onto the top-level vendor/ directory.
test('rejects Vendor/ (capitalized) the same as vendor/', () => {
  const diffText = diffForStagedChange(() => {
    mkdirSync(path.join(repoRoot, 'modules', 'Vendor'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'modules', 'Vendor', 'lib.php'), '<?php\n// x\n');
  });
  assert.ok(diffText.includes('modules/Vendor/lib.php'), `expected a real new-file diff: ${diffText.slice(0, 200)}`);
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('vendor')));
});

test('rejects Fetch(...) (capitalized) the same as fetch(...)', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\nFetch("https://example.com");\n');
  });
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('network')));
});

test('rejects a GitHub-token-shaped secret, with no override possible', () => {
  const diffText = diffForChange(() => {
    writeFileSync(
      path.join(repoRoot, 'app.js'),
      'console.log("start");\nconst token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n',
    );
  });
  const result = guardDiff(diffText, repoRoot, {
    allowVendor: true, allowSensitivePaths: true, allowNetwork: true, allowLargeDeletion: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('secret')));
  assert.ok(
    !result.violations.some((v) => v.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789')),
    'violation message must not echo the detected secret value',
  );
});

test('has no way to override the large-deletion threshold via options', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'big.js'), 'line0\n');
  });
  const result = guardDiff(diffText, repoRoot, { deletionThreshold: 1000000 });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('removes')));
});

// real bypass: git apply resolves the file to patch from the hunk header, not "diff --git"; hand-crafted since real git diff never mismatches them.
test('rejects a diff whose hunk header targets .env even though the diff --git header names a safe file', () => {
  const diffText = [
    'diff --git a/safe.txt b/safe.txt',
    'index 0000001..0000002 100644',
    '--- a/.env',
    '+++ b/.env',
    '@@ -1,1 +1,1 @@',
    '-SECRET=1',
    '+SECRET=owned',
    '',
  ].join('\n');
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(result.violations.some((v) => v.includes('sensitive path') && v.includes('.env')), JSON.stringify(result.violations));
});

// real bypass: unlike the test above, the "diff --git"/"+++" (post-image) paths agree with each
// other here (both name safe.txt), so numstat's target column already reads "safe.txt" and the
// mismatch is invisible there; only the "---" (pre-image) line names the real, deleted file (.env).
test('rejects a diff whose pre-image header names .env even though numstat and the diff --git header agree on a safe target', () => {
  const diffText = [
    'diff --git a/.env b/safe.txt',
    '--- a/.env',
    '+++ b/safe.txt',
    '@@ -1,1 +1,1 @@',
    '-SECRET=1',
    '+owned',
    '',
  ].join('\n');
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(result.violations.some((v) => v.includes('sensitive path') && v.includes('.env')), JSON.stringify(result.violations));
});

// real bypass: classic startsWith(root) traversal trap; a sibling dir sharing a string prefix (repoRoot-evil) must not read as inside repoRoot.
test('rejects a diff whose target resolves to a sibling directory sharing a path prefix', () => {
  const siblingFile = `${repoRoot}-evil/x.txt`;
  const escapePath = path.relative(repoRoot, siblingFile);
  const diffText = [
    `diff --git a/${escapePath} b/${escapePath}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${escapePath}`,
    '@@ -0,0 +1 @@',
    '+owned',
    '',
  ].join('\n');
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(result.violations.some((v) => v.includes('escapes repository root')), JSON.stringify(result.violations));
});

// --numstat only reports the post-rename path, so a sensitive-source rename is only visible via oldPath; exercises the plain "old => new" form.
test('rejects a rename that moves a sensitive file to a safe-looking name', () => {
  const diffText = diffForStagedChange(() => {
    git(['mv', '.env', 'renamed-config.txt']);
  });
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(result.violations.some((v) => v.includes('sensitive path')), JSON.stringify(result.violations));
});

// Same as above but exercises the brace "prefix/{old => new}" summary form used when old/new paths share a directory prefix.
test('rejects a rename that moves a sensitive file to a safe-looking name under a shared directory', () => {
  const diffText = diffForStagedChange(() => {
    git(['mv', 'config/credentials.txt', 'config/safe.txt']);
  });
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(result.violations.some((v) => v.includes('sensitive path')), JSON.stringify(result.violations));
});

// real bypass: --numstat only reports a copy's destination row, so a rename-only parser never sees the ".env" copy source at all.
test('rejects a copy that duplicates a sensitive file into a safe-looking name', () => {
  const diffText = [
    'diff --git a/.env b/exfil.txt',
    'similarity index 100%',
    'copy from .env',
    'copy to exfil.txt',
    '',
  ].join('\n');
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(
    result.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(result.violations),
  );
});

// Companion case: destination (not source) is sensitive; already caught by the numstat row itself, independent of the source-path fix above.
test('rejects a copy whose destination is a sensitive file', () => {
  const diffText = [
    'diff --git a/safe.txt b/.env',
    'similarity index 100%',
    'copy from safe.txt',
    'copy to .env',
    '',
  ].join('\n');
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(
    result.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(result.violations),
  );
});

// Same as the copy-source PoC but exercises the brace "prefix/{old => new}" summary form; hand-crafted since git's own copy detection is flaky.
test('rejects a copy that duplicates a sensitive file to a safe-looking name under a shared directory', () => {
  const diffText = [
    'diff --git a/config/credentials.txt b/config/x.txt',
    'similarity index 100%',
    'copy from config/credentials.txt',
    'copy to config/x.txt',
    '',
  ].join('\n');
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(result.violations.some((v) => v.includes('sensitive path')), JSON.stringify(result.violations));
});

// real bypass: git's --summary display can't distinguish its own " => " separator from a destination path literally containing " => "; verified against real git output.
test('rejects a copy whose destination path itself is "a => b", hiding the real source in the summary display', () => {
  const diffText = [
    'diff --git a/.env b/a => b',
    'similarity index 100%',
    'copy from .env',
    'copy to a => b',
    '',
  ].join('\n');

  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(
    result.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(result.violations),
  );

  const diffPath = path.join(diffDir, 'poc-summary-split.diff');
  writeFileSync(diffPath, diffText);
  const applied = applyGuardedDiff(diffPath, { repoRoot, outcomeLogFile: false });
  assert.equal(applied.applied, false, JSON.stringify(applied.violations));
  assert.ok(
    applied.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(applied.violations),
  );
  assert.equal(existsSync(path.join(repoRoot, 'a => b')), false, 'destination file must not be written');
  assert.equal(readFileSync(path.join(repoRoot, '.env'), 'utf8'), 'SECRET=1\n');
});

// Same ambiguity via brace characters instead of " => "; a brace-aware splitter can't tell git's shared-prefix braces from path braces either.
test('rejects a copy whose destination path contains { and }, hiding the real source in the summary display', () => {
  const diffText = [
    'diff --git a/.env b/{fake => safe}.txt',
    'similarity index 100%',
    'copy from .env',
    'copy to {fake => safe}.txt',
    '',
  ].join('\n');

  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(
    result.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(result.violations),
  );

  const diffPath = path.join(diffDir, 'poc-summary-braces.diff');
  writeFileSync(diffPath, diffText);
  const applied = applyGuardedDiff(diffPath, { repoRoot, outcomeLogFile: false });
  assert.equal(applied.applied, false, JSON.stringify(applied.violations));
  assert.ok(
    applied.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(applied.violations),
  );
  assert.equal(existsSync(path.join(repoRoot, '{fake => safe}.txt')), false, 'destination file must not be written');
  assert.equal(readFileSync(path.join(repoRoot, '.env'), 'utf8'), 'SECRET=1\n');
});

// real bypass: git apply tolerates other header lines between "copy from"/"copy to"; a strict-adjacency parser loses the source there.
test('rejects a copy whose from/to headers are split by an intervening index line', () => {
  const diffText = [
    'diff --git a/.env b/copy_dst.txt',
    'similarity index 100%',
    'copy from .env',
    'index 0000000..1111111 100644',
    'copy to copy_dst.txt',
    '',
  ].join('\n');

  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(
    result.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(result.violations),
  );

  const diffPath = path.join(diffDir, 'poc-copy-split-headers.diff');
  writeFileSync(diffPath, diffText);
  const applied = applyGuardedDiff(diffPath, { repoRoot, outcomeLogFile: false });
  assert.equal(applied.applied, false, JSON.stringify(applied.violations));
  assert.ok(
    applied.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(applied.violations),
  );
  assert.equal(existsSync(path.join(repoRoot, 'copy_dst.txt')), false, 'destination file must not be written');
  assert.equal(readFileSync(path.join(repoRoot, '.env'), 'utf8'), 'SECRET=1\n');
});

// Same class of bypass via "rename"; a rename source never gets its own --numstat row, so scanning "from" lines directly is the only signal.
test('rejects a rename whose from/to headers are split by an intervening index line', () => {
  const diffText = [
    'diff --git a/.env b/renamed.txt',
    'similarity index 100%',
    'rename from .env',
    'index 0000000..1111111 100644',
    'rename to renamed.txt',
    '',
  ].join('\n');

  const numstatOutput = execFileSync('git', ['apply', '--numstat', '-'], {
    cwd: repoRoot,
    input: diffText,
    encoding: 'utf8',
  });
  assert.ok(
    !numstatOutput.includes('.env'),
    `expected numstat to have no row naming the rename source: ${numstatOutput}`,
  );

  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(
    result.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(result.violations),
  );

  const diffPath = path.join(diffDir, 'poc-rename-split-headers.diff');
  writeFileSync(diffPath, diffText);
  const applied = applyGuardedDiff(diffPath, { repoRoot, outcomeLogFile: false });
  assert.equal(applied.applied, false, JSON.stringify(applied.violations));
  assert.ok(
    applied.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(applied.violations),
  );
  assert.equal(existsSync(path.join(repoRoot, 'renamed.txt')), false, 'destination file must not be written');
  assert.equal(readFileSync(path.join(repoRoot, '.env'), 'utf8'), 'SECRET=1\n');
});

// real bypass: git apply also accepts the legacy "rename old"/"rename new" alias; a from-scan recognizing only "rename from" misses this source.
test('rejects a rename that uses the legacy "rename old"/"rename new" header alias', () => {
  const diffText = [
    'diff --git a/.env b/x.txt',
    'similarity index 100%',
    'rename old .env',
    'rename new x.txt',
    '',
  ].join('\n');

  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(
    result.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(result.violations),
  );

  const diffPath = path.join(diffDir, 'poc-rename-old-new-alias.diff');
  writeFileSync(diffPath, diffText);
  const applied = applyGuardedDiff(diffPath, { repoRoot, outcomeLogFile: false });
  assert.equal(applied.applied, false, JSON.stringify(applied.violations));
  assert.ok(
    applied.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(applied.violations),
  );
  assert.equal(existsSync(path.join(repoRoot, 'x.txt')), false, 'destination file must not be written');
  assert.equal(readFileSync(path.join(repoRoot, '.env'), 'utf8'), 'SECRET=1\n');
});

// real bypass: git strips a trailing \r from extended-header paths before resolving; a scan that doesn't also strip it can't match .env's pattern.
test('rejects a CRLF-formatted copy that names a sensitive source', () => {
  const diffText = 'diff --git a/.env b/x.txt\r\n'
    + 'similarity index 100%\r\n'
    + 'copy from .env\r\n'
    + 'copy to x.txt\r\n';

  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false, JSON.stringify(result.violations));
  assert.ok(
    result.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(result.violations),
  );

  const diffPath = path.join(diffDir, 'poc-crlf-copy.diff');
  writeFileSync(diffPath, diffText);
  const applied = applyGuardedDiff(diffPath, { repoRoot, outcomeLogFile: false });
  assert.equal(applied.applied, false, JSON.stringify(applied.violations));
  assert.ok(
    applied.violations.some((v) => v.includes('sensitive path') && v.includes('.env')),
    JSON.stringify(applied.violations),
  );
  assert.equal(existsSync(path.join(repoRoot, 'x.txt')), false, 'destination file must not be written');
  assert.equal(readFileSync(path.join(repoRoot, '.env'), 'utf8'), 'SECRET=1\n');
});

// real bypass: a pure (100% similarity) rename/copy has no content hunks, so no "---"/"+++" header ever
// names the destination; scanDiffForLeaks is the text-only, no-git-apply gate consensus-review.js sends
// diffs through before an external provider ever sees them, so it must catch this from the "to" line alone.
test('scanDiffForLeaks flags a pure rename whose destination is a sensitive path', () => {
  const diffText = diffForStagedChange(() => {
    git(['mv', 'app.js', '.env.local']);
  });
  assert.doesNotMatch(diffText, /^--- /m, `expected a pure rename to carry no hunk headers: ${diffText}`);
  const result = scanDiffForLeaks(diffText);
  assert.ok(result.sensitivePaths.includes('.env.local'), JSON.stringify(result));
});

test('scanDiffForLeaks flags a pure copy whose destination is a sensitive path', () => {
  const diffText = [
    'diff --git a/app.js b/credentials.txt',
    'similarity index 100%',
    'copy from app.js',
    'copy to credentials.txt',
    '',
  ].join('\n');
  const result = scanDiffForLeaks(diffText);
  assert.ok(result.sensitivePaths.includes('credentials.txt'), JSON.stringify(result));
});

test('scanDiffForLeaks leaves an ordinary diff with no sensitive paths or secrets unflagged', () => {
  const diffText = diffForStagedChange(() => {
    writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("changed");\n');
  });
  const result = scanDiffForLeaks(diffText);
  assert.deepEqual(result.sensitivePaths, []);
  assert.equal(result.hasSecretValue, false);
});

function mangleHunkCounts(diffText) {
  return diffText.replace(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/m, '@@ -$1,99 +$2,99 @@');
}

test('accepts a diff with miscounted hunk headers via --recount and reports needsRecount', () => {
  const diffText = mangleHunkCounts(diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\nconsole.log("more");\n');
  }));
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.needsRecount, true);
});

test('reports needsRecount false for a diff with correct hunk headers', () => {
  const diffText = diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\nconsole.log("more");\n');
  });
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.needsRecount, false);
});

test('still rejects a diff whose hunk content does not match the tree even with --recount', () => {
  const diffText = [
    'diff --git a/app.js b/app.js',
    'index 0000000..1111111 100644',
    '--- a/app.js',
    '+++ b/app.js',
    '@@ -1,2 +1,2 @@',
    '-this line does not exist in app.js',
    '+replacement',
    '',
  ].join('\n');
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('not a valid unified diff')));
});

test('still enforces guard rules (large deletion) on a miscounted diff accepted via --recount', () => {
  const diffText = mangleHunkCounts(diffForChange(() => {
    writeFileSync(path.join(repoRoot, 'important.js'), 'line0\n');
  }));
  const result = guardDiff(diffText, repoRoot);
  assert.equal(result.ok, false);
  assert.equal(result.needsRecount, true);
  assert.ok(result.violations.some((v) => v.includes('more lines than it adds')), JSON.stringify(result.violations));
});

test('reports needsRecount false for an empty diff', () => {
  const result = guardDiff('', repoRoot);
  assert.equal(result.ok, false);
  assert.equal(result.needsRecount, false);
});
