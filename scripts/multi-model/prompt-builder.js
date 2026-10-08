import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SENSITIVE_PATH_PATTERNS, scanDiffForLeaks } from './diff-guard.js';

// A captured diff dumped to a temp file (e.g. moo.md's commit-message/PR-draft steps) arrives
// here as an ordinary --files path, so its own filename never matches SENSITIVE_PATH_PATTERNS.
// Content starting with git's own "diff --git " section marker is run through the same
// leak scan that gates consensusReview() before any of it reaches an external provider.
function looksLikeDiff(content) {
  return /^diff --git /m.test(content);
}

function isWithinRoot(resolvedPath, root) {
  const rootResolved = path.resolve(root);
  return resolvedPath === rootResolved || resolvedPath.startsWith(`${rootResolved}${path.sep}`);
}

// moo.md's commit-message/PR-draft steps (see prompt-builder.test.js) legitimately pass a
// captured diff from an OS temp file via --files, so the repo root isn't the only allowed
// root - only paths outside the repo and the temp dirs (os.tmpdir() and /tmp, which macOS
// treats as distinct trees) are rejected here. Containment is checked on the symlink-resolved
// path so a temp-dir symlink cannot smuggle in an outside file.
function realResolve(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isOutsideAllowedRoots(filePath) {
  const target = realResolve(path.resolve(process.cwd(), filePath));
  return ![process.cwd(), tmpdir(), '/tmp'].some((root) => isWithinRoot(target, realResolve(root)));
}

export function readFilesForPrompt(filePaths) {
  return filePaths.map((filePath) => {
    if (isOutsideAllowedRoots(filePath)) {
      console.error(`multi-model: skipping ${filePath} - resolves outside the repository, contents are never sent to external providers`);
      return `--- FILE: ${filePath} ---\n[skipped: ${filePath} resolves outside the repository - contents are never sent to external providers]`;
    }
    if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath))) {
      console.error(`multi-model: skipping ${filePath} - matches sensitive-file pattern, contents are never sent to external providers`);
      return `--- FILE: ${filePath} ---\n[skipped: ${filePath} matches sensitive-file pattern - contents are never sent to external providers]`;
    }
    let content;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`multi-model: could not read ${filePath}: ${err.message}`);
      content = `[unreadable: ${err.message}]`;
    }
    if (looksLikeDiff(content)) {
      const leaks = scanDiffForLeaks(content);
      if (leaks.sensitivePaths.length > 0 || leaks.hasSecretValue) {
        const reasons = [
          ...leaks.sensitivePaths.map((p) => `touches a sensitive path: ${p}`),
          ...(leaks.hasSecretValue ? ['contains a line that looks like it holds a secret (value redacted; review the diff directly)'] : []),
        ];
        console.error(`multi-model: skipping ${filePath} - diff content rejected - ${reasons.join('; ')}`);
        return `--- FILE: ${filePath} ---\n[skipped: diff content rejected - ${reasons.join('; ')} - contents are never sent to external providers]`;
      }
    }
    return `--- FILE: ${filePath} ---\n${content}`;
  }).join('\n\n');
}

const DIFF_ONLY_INSTRUCTION = 'Return ONLY a single unified diff (git apply compatible), no prose, ' +
  'no markdown fences, no explanation before or after. If no change is needed, return an empty diff. ' +
  'Context lines and removed lines must reproduce the provided file content EXACTLY - never use ' +
  'pseudo-code, placeholders, or "..." inside a diff. Only modify files whose full content was ' +
  'provided; to add a brand-new file, use a proper new-file header (--- /dev/null).';

const REPO_STANDARDS_INSTRUCTION = 'Repo coding standards (violations get the whole draft discarded): ' +
  'PSR-12; max 120-char lines; every class property and constant carries a docblock with @var; ' +
  'constants always declare visibility and never narrow the visibility of interface constants; ' +
  'short array syntax [] only; no @ error suppression; constructor injection only, never ' +
  'ObjectManager; new PHP files start with the Moogento copyright header. If a plan/task document ' +
  'is among the provided files, follow its interfaces, enum values, schema constraints, and scope ' +
  'exactly - do not add features, config, or fallbacks the plan does not specify.';

export function buildPlanMessages(task, filePaths) {
  return [
    {
      role: 'system',
      content: 'You are a fast, cheap first-pass planning assistant for a Magento 2 codebase. ' +
        'Produce a concrete, concise implementation plan in Markdown. You are not the final ' +
        'authority - a stronger model will critique and may override this plan.',
    },
    { role: 'user', content: `Task:\n${task}\n\nRelevant files:\n${readFilesForPrompt(filePaths)}` },
  ];
}

export function buildImplementMessages(task, filePaths) {
  return [
    {
      role: 'system',
      content: `You are a first-pass implementation assistant. ${DIFF_ONLY_INSTRUCTION} ` +
        'Only touch the files provided or clearly implied by the task. Do not invent new ' +
        `dependencies, do not touch build/lock files, do not include secrets. ${REPO_STANDARDS_INSTRUCTION}`,
    },
    { role: 'user', content: `Task:\n${task}\n\nFiles:\n${readFilesForPrompt(filePaths)}` },
  ];
}

const NOTES_ONLY_INSTRUCTION = 'Return ONLY Markdown implementation notes - never a diff or patch. ' +
  'Structure: "## Approach" (a few sentences), "## Changes" (one subsection per file with the exact ' +
  'code blocks to add or replace, each anchored to a quoted existing line or method name from the ' +
  'provided content), "## Risks" (edge cases, ordering constraints, things the implementer must verify). ' +
  'Ground every statement in the provided file contents: never reference a file, class, method, or ' +
  'constant that does not appear in them. If the provided content looks cut off or a file you need ' +
  'is absent, say so explicitly under "## Missing context" instead of guessing.';

export function buildImplementNotesMessages(task, filePaths) {
  return [
    {
      role: 'system',
      content: `You are a first-pass implementation adviser. A stronger model implements the change ` +
        `and treats your notes as advisory input, so precision beats completeness. ${NOTES_ONLY_INSTRUCTION} ` +
        `${REPO_STANDARDS_INSTRUCTION}`,
    },
    { role: 'user', content: `Task:\n${task}\n\nFiles:\n${readFilesForPrompt(filePaths)}` },
  ];
}

export function buildReviseMessages(task, filePaths, previousDiff, critique) {
  return [
    {
      role: 'system',
      content: `You already produced a draft diff for this task and a reviewer found issues. ${DIFF_ONLY_INSTRUCTION} ` +
        'Revise your previous diff to address the reviewer feedback. Only touch the files ' +
        'provided or clearly implied by the task. Do not invent new dependencies, do not ' +
        `touch build/lock files, do not include secrets. ${REPO_STANDARDS_INSTRUCTION}`,
    },
    {
      role: 'user',
      content: `Task:\n${task}\n\nReviewer feedback on your previous diff:\n${JSON.stringify(critique)}\n\n` +
        `Your previous diff:\n${previousDiff}\n\nFiles:\n${readFilesForPrompt(filePaths)}`,
    },
  ];
}

export function buildReviewMessages(task, diffText, fileContext = '', knownNonIssues = '') {
  const contextRule = fileContext
    ? ' Full post-change content of the changed files follows the diff; check it before ' +
      'flagging anything as missing or broken - only report an issue you can verify in ' +
      'that content, never one based on code you cannot see. A file whose entry is an ' +
      'omission/unavailability note has no content here: judge that file from its diff ' +
      'hunks alone and raise unverifiable concerns for it under "risks", not "issues".'
    : ' You only see the diff, not the surrounding files; if a concern depends on code ' +
      'outside the diff, list it under "risks" as a question, not under "issues".';
  const knownNonIssuesRule = knownNonIssues
    ? '\n\nKnown non-issues in this codebase - never report any of these patterns as an ' +
      `issue or risk:\n${knownNonIssues}`
    : '';
  const contextSection = fileContext
    ? `\n\nCurrent full content of changed files:\n${fileContext}`
    : '';
  return [
    {
      role: 'system',
      content: 'You are a code reviewer giving a second opinion. Respond with ONLY a JSON ' +
        'object matching {"issues":[{"file":string,"line":number|null,"summary":string,' +
        '"severity":"CRITICAL"|"HIGH"|"MEDIUM"|"LOW","evidence":string}],"risks":[string],' +
        '"missing":[string]}. ' +
        'The "evidence" field must quote, verbatim, the exact line(s) from the diff or ' +
        'provided file content that prove the claim; a claim that something is missing must ' +
        'quote the surrounding provided code where it would need to appear. If you cannot ' +
        'quote evidence from what you were given, the concern belongs under "risks", not ' +
        '"issues". Return at most five issues, prioritised by severity and confidence. Keep ' +
        'the risks and missing arrays concise. Never put confirmations, acceptable behaviour, ' +
        'or statements that something is not an issue in the issues array. ' +
        `No prose outside the JSON, no markdown fences.${contextRule}${knownNonIssuesRule}`,
    },
    {
      role: 'user',
      content: `Task context:\n${task || '(not provided)'}\n\nDiff to review:\n${diffText}${contextSection}`,
    },
  ];
}

export function buildSelfVerifyMessages(task, review, additionalContext) {
  return [
    {
      role: 'system',
      content: 'You are re-verifying your own earlier code-review findings against file ' +
        'content you did not see the first time. Respond with ONLY a JSON object matching ' +
        '{"issues":[{"file":string,"line":number|null,"summary":string,' +
        '"severity":"CRITICAL"|"HIGH"|"MEDIUM"|"LOW","evidence":string}],"risks":[string],' +
        '"missing":[string]}. ' +
        'Keep a finding only if the provided content still supports it, and attach ' +
        '"evidence" quoting the exact line(s) that prove it; retract every finding the ' +
        'content refutes or that you still cannot verify. Do not add new findings. ' +
        'No prose outside the JSON, no markdown fences.',
    },
    {
      role: 'user',
      content: `Task context:\n${task || '(not provided)'}\n\nYour earlier findings:\n` +
        `${JSON.stringify(review)}\n\nAdditional file content:\n${additionalContext}`,
    },
  ];
}

export function buildExplainMessages(filePaths, symbol) {
  return [
    {
      role: 'system',
      content: 'Explain the given code concisely and technically for an engineer already ' +
        'familiar with the codebase. Markdown output. Do not suggest changes, just explain.',
    },
    { role: 'user', content: `${symbol ? `Focus on: ${symbol}\n\n` : ''}Files:\n${readFilesForPrompt(filePaths)}` },
  ];
}

export function buildDocsMessages(task, filePaths, mode) {
  const modeInstruction = mode === 'diff'
    ? DIFF_ONLY_INSTRUCTION
    : 'Return ONLY Markdown documentation content, no surrounding commentary.';
  return [
    { role: 'system', content: `You are a documentation drafting assistant. ${modeInstruction}` },
    { role: 'user', content: `Task:\n${task}\n\nRelevant files:\n${readFilesForPrompt(filePaths)}` },
  ];
}

export function extractDiff(rawContent) {
  const fenced = rawContent.match(/```(?:diff|patch)?\n([\s\S]*)\n```/);
  const body = fenced ? fenced[1] : rawContent;
  return `${body.replace(/^\s+/, '').replace(/[\r\n]+$/, '')}\n`;
}

export function extractJson(rawContent) {
  const fenced = rawContent.match(/```(?:json)?\n([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : rawContent).trim();
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (err) {
    return { ok: false, error: err.message, raw: rawContent };
  }
}
