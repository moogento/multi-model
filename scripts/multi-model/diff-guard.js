import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Exported for reuse by prompt-builder.js's readFilesForPrompt() send-side filter; keep both call sites in sync.
export const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.secrets\//i,
  /credentials/i,
  /secret/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)composer\.lock$/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)\.git\//i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.composer\/auth\.json$/i,
];

const VENDOR_PATTERNS = [/(^|\/)vendor\//i, /(^|\/)node_modules\//i];

const DELETION_THRESHOLD = 40;

const SECRET_VALUE_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /sk_(live|test)_[A-Za-z0-9]{16,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /npm_[A-Za-z0-9]{36,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key|secret|password|passwd|credential)\s*[:=]\s*["'][A-Za-z0-9_\-.]{12,}["']/i,
  /Bearer\s+[A-Za-z0-9_\-.]{20,}/i,
];

const NETWORK_CALL_PATTERNS = [
  /\bfetch\s*\(/i, /\bcurl\s+/i, /\baxios\./i, /new\s+WebSocket\s*\(/i, /\bhttp\.request\s*\(/i,
];

// git C-quotes any path with a quote/backslash/tab/newline/non-ASCII byte; applies to every header and numstat path column alike.
function unquoteGitPath(raw) {
  if (typeof raw !== 'string' || raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
    return raw;
  }
  const inner = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '\\') { bytes.push(0x5c); i += 1; continue; }
      if (next === '"') { bytes.push(0x22); i += 1; continue; }
      if (next === 't') { bytes.push(0x09); i += 1; continue; }
      if (next === 'n') { bytes.push(0x0a); i += 1; continue; }
      const octal = inner.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8));
        i += 3;
        continue;
      }
      bytes.push(0x5c);
      continue;
    }
    bytes.push(...Buffer.from(ch, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

// Pairs adjacent copy/rename from-to header lines, including the legacy "rename old"/"rename new" alias; no "copy old"/"copy new" exists.
const FROM_LINE_RE = /^(copy from|rename from|rename old) (.+?)\r?$/;
const TO_LINE_RE = /^(copy to|rename to|rename new) (.+?)\r?$/;
const VERB_FOR_FROM = { 'copy from': 'copy', 'rename from': 'rename', 'rename old': 'rename' };
const VERB_FOR_TO = { 'copy to': 'copy', 'rename to': 'rename', 'rename new': 'rename' };

function extractRenameOrCopySources(diffText) {
  const sourcePathFor = new Map();
  let pendingVerb = null;
  let pendingFrom = null;
  for (const line of diffText.split('\n')) {
    const fromMatch = line.match(FROM_LINE_RE);
    if (fromMatch) {
      pendingVerb = VERB_FOR_FROM[fromMatch[1]];
      pendingFrom = unquoteGitPath(fromMatch[2]);
      continue;
    }
    const toMatch = line.match(TO_LINE_RE);
    if (toMatch && pendingFrom !== null && VERB_FOR_TO[toMatch[1]] === pendingVerb) {
      sourcePathFor.set(unquoteGitPath(toMatch[2]), pendingFrom);
    }
    pendingVerb = null;
    pendingFrom = null;
  }
  return sourcePathFor;
}

// git apply rejects a bare "to"/"new" line with no prior "from"/"old", so every from-line path is a real source.
function extractAllFromLinePaths(diffText) {
  return diffText
    .split('\n')
    .map((line) => line.match(FROM_LINE_RE))
    .filter(Boolean)
    .map((match) => unquoteGitPath(match[2]));
}

// A pure rename/copy with no content change (100% similarity) emits no "---"/"+++" hunk
// headers at all, so the destination is only visible on its own "to"/"new" line.
function extractAllToLinePaths(diffText) {
  return diffText
    .split('\n')
    .map((line) => line.match(TO_LINE_RE))
    .filter(Boolean)
    .map((match) => unquoteGitPath(match[2]));
}

const MINUS_HEADER_RE = /^--- (.+?)\r?$/;
const PLUS_HEADER_RE = /^\+\+\+ (.+?)\r?$/;

function normalizeHeaderPath(value) {
  const withoutTimestamp = value.split('\t')[0];
  if (withoutTimestamp === '/dev/null') return null;
  const unquoted = unquoteGitPath(withoutTimestamp);
  return /^[ab]\//.test(unquoted) ? unquoted.slice(2) : unquoted;
}

// "diff --git a/X b/Y" with mismatched X/Y and no rename/copy header still passes `git apply`,
// which silently deletes X and writes Y's new content there: numstat only reports Y, so both the
// "---" (preimage) and "+++" (postimage) header paths need vetting independently of numstat targets.
// Hunk body lines always carry a leading ' '/'+'/'-'/'\' marker, so a bare "diff --git "/"@@" line
// can never appear inside hunk content, making this state machine safe from body-content collisions.
function extractHeaderPaths(diffText) {
  const paths = [];
  let inHeader = true;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      continue;
    }
    if (line.startsWith('@@')) {
      inHeader = false;
      continue;
    }
    if (!inHeader) continue;
    const minusMatch = line.match(MINUS_HEADER_RE);
    const plusMatch = line.match(PLUS_HEADER_RE);
    const match = minusMatch || plusMatch;
    if (!match) continue;
    const normalized = normalizeHeaderPath(match[1]);
    if (normalized) paths.push(normalized);
  }
  return paths;
}

// Text-only (no git apply, so it also works on diffs that don't apply cleanly against the
// current tree) scan for sensitive-path touches and secret-looking values in diff text.
// Reused by consensus-review.js to gate diff payloads sent to external review providers -
// keep in sync with SENSITIVE_PATH_PATTERNS/SECRET_VALUE_PATTERNS usage in guardDiff() below.
export function scanDiffForLeaks(diffText) {
  const paths = new Set([
    ...extractHeaderPaths(diffText),
    ...extractAllFromLinePaths(diffText),
    ...extractAllToLinePaths(diffText),
  ]);
  const sensitivePaths = [...paths].filter((p) => SENSITIVE_PATH_PATTERNS.some((re) => re.test(p)));
  const hasSecretValue = diffText.split('\n').some((line) => SECRET_VALUE_PATTERNS.some((re) => re.test(line)));
  return { sensitivePaths, hasSecretValue };
}

// Authoritative list of files git apply will actually write, derived from
// git itself rather than hand-parsed "diff --git" headers, so this can never
// diverge from what apply-guarded-diff.js's real `git apply` resolves.
export function getTouchedFiles(diffText, repoRoot, { recount = false } = {}) {
  let output;
  try {
    output = execFileSync('git', ['apply', '--numstat', ...(recount ? ['--recount'] : []), '-'], {
      cwd: repoRoot,
      input: diffText,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch {
    return [];
  }

  // git strips a trailing \r from --numstat's own path column before emitting it
  // (verified against copy, rename, new-file, and modify CRLF diffs), so targetPath needs no CR-strip here.
  const sourcePathFor = extractRenameOrCopySources(diffText);
  const numstatRows = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const numstatMatch = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (numstatMatch) numstatRows.push(numstatMatch);
  }

  return numstatRows.map(([, addedRaw, removedRaw, targetPathRaw]) => {
    const targetPath = unquoteGitPath(targetPathRaw);
    return {
      path: targetPath,
      oldPath: sourcePathFor.get(targetPath) || null,
      added: addedRaw === '-' ? 0 : Number(addedRaw),
      removed: removedRaw === '-' ? 0 : Number(removedRaw),
    };
  });
}

export function guardDiff(diffText, repoRoot, options = {}) {
  const violations = [];

  if (!diffText || !diffText.trim()) {
    return { ok: false, violations: ['empty diff'], needsRecount: false };
  }

  let validSyntax = true;
  let needsRecount = false;
  try {
    execFileSync('git', ['apply', '--check', '-'], {
      cwd: repoRoot,
      input: diffText,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (err) {
    try {
      execFileSync('git', ['apply', '--check', '--recount', '-'], {
        cwd: repoRoot,
        input: diffText,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      needsRecount = true;
    } catch {
      validSyntax = false;
      violations.push(`not a valid unified diff for this tree: ${(err.stderr?.toString() || err.message).trim()}`);
    }
  }

  const touchedFiles = getTouchedFiles(diffText, repoRoot, { recount: needsRecount });
  if (touchedFiles.length === 0 && validSyntax) {
    violations.push('diff contains no recognizable file headers');
  }

  const repoRootResolved = path.resolve(repoRoot);
  const pathsToVet = new Set();
  for (const { path: targetPath, oldPath } of touchedFiles) {
    pathsToVet.add(targetPath);
    if (oldPath) pathsToVet.add(oldPath);
  }
  // Every "copy from"/"rename from" line is vetted unconditionally, with no adjacency or pairing required.
  for (const oldPath of extractAllFromLinePaths(diffText)) {
    pathsToVet.add(oldPath);
  }
  // Every "---"/"+++" hunk header path is vetted independently of numstat targets (see extractHeaderPaths).
  for (const headerPath of extractHeaderPaths(diffText)) {
    pathsToVet.add(headerPath);
  }

  for (const p of pathsToVet) {
    const resolved = path.resolve(repoRoot, p);
    if (!resolved.startsWith(`${repoRootResolved}${path.sep}`)) {
      violations.push(`path escapes repository root: ${p}`);
    }
    if (!options.allowSensitivePaths && SENSITIVE_PATH_PATTERNS.some((re) => re.test(p))) {
      violations.push(`touches a sensitive path: ${p}`);
    }
    if (!options.allowVendor && VENDOR_PATTERNS.some((re) => re.test(p))) {
      violations.push(`touches a vendor/dependency path: ${p}`);
    }
  }

  const addedLines = diffText.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++ '));

  for (const line of addedLines) {
    if (SECRET_VALUE_PATTERNS.some((re) => re.test(line))) {
      violations.push('added line looks like it contains a secret (value redacted; review the diff directly)');
      break;
    }
  }

  if (!options.allowNetwork) {
    for (const line of addedLines) {
      if (NETWORK_CALL_PATTERNS.some((re) => re.test(line))) {
        const detail = SECRET_VALUE_PATTERNS.some((re) => re.test(line))
          ? '(value redacted; review the diff directly)'
          : line.slice(0, 80);
        violations.push(`added line introduces a network call (pass --allow-network if intentional): ${detail}`);
        break;
      }
    }
  }

  if (!options.allowLargeDeletion) {
    for (const { path: targetPath, added, removed } of touchedFiles) {
      if (removed - added > DELETION_THRESHOLD) {
        violations.push(`${targetPath}: removes ${removed - added} more lines than it adds (pass --allow-large-deletion if intentional)`);
      }
    }
  }

  return { ok: violations.length === 0, violations, needsRecount };
}
