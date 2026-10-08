import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadConfig, parseArgs, defaultFanoutProviders, providersForRole } from './config.js';
import { callChatCompletion, isProviderConfigured, providerMaxInputChars } from './providers.js';
import { buildReviewMessages, buildSelfVerifyMessages, extractJson, readFilesForPrompt } from './prompt-builder.js';
import { scanDiffForLeaks } from './diff-guard.js';

const REVIEW_CHUNK_HEADROOM_CHARS = 4000;
const FILE_CONTEXT_RESERVE_SHARE = 0.4;
const KNOWN_NON_ISSUES_PATH = '.guidelines/workflow/multi-model-review-known-false-positives.md';
const KNOWN_NON_ISSUES_MAX_CHARS = 6000;
const SELF_VERIFY_MAX_FILES = 12;
const SELF_VERIFY_CONTEXT_SHARE = 0.6;

export function loadKnownNonIssues(cwd = process.cwd()) {
  const filePath = path.join(cwd, KNOWN_NON_ISSUES_PATH);
  if (!existsSync(filePath)) return '';
  const content = readFileSync(filePath, 'utf8').trim();
  if (content.length <= KNOWN_NON_ISSUES_MAX_CHARS) return content;
  console.error(`multi-model: known-false-positives brief truncated from ${content.length} to ${KNOWN_NON_ISSUES_MAX_CHARS} chars`);
  return content.slice(0, KNOWN_NON_ISSUES_MAX_CHARS);
}

function unquoteGitPath(quoted) {
  const inner = quoted.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') {
      bytes.push(inner.charCodeAt(i));
      continue;
    }
    const next = inner[i + 1];
    if (next === '"' || next === '\\') {
      bytes.push(next.charCodeAt(0));
      i++;
    } else if (next === 't') {
      bytes.push(9);
      i++;
    } else if (next === 'n') {
      bytes.push(10);
      i++;
    } else if (next >= '0' && next <= '7') {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(next.charCodeAt(0));
      i++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const DIFF_GIT_LINE = /^diff --git (?:"((?:\\.|[^"\\])*)"|(\S+)) (?:"((?:\\.|[^"\\])*)"|(\S+))$/;
const PLUS_PLUS_PLUS_LINE = /^\+\+\+ (?:"((?:\\.|[^"\\])*)"|(.+?))(?:\t.*)?$/m;

function unquoteOrRaw(quoted, raw) {
  return quoted !== undefined ? unquoteGitPath(`"${quoted}"`) : raw;
}

/**
 * Resolves a section's post-image path, falling back to the unambiguous
 * `+++ b/...` header when the `diff --git` line has unquoted paths
 * containing spaces (git only quotes non-ASCII/control characters).
 */
function sectionPostImagePath(section) {
  const headerLine = section.slice(0, section.indexOf('\n') === -1 ? undefined : section.indexOf('\n'));
  const headerMatch = headerLine.match(DIFF_GIT_LINE);
  if (headerMatch) return unquoteOrRaw(headerMatch[3], headerMatch[4]);
  const plusMatch = section.match(PLUS_PLUS_PLUS_LINE);
  if (plusMatch) return unquoteOrRaw(plusMatch[1], plusMatch[2]);
  return null;
}

function normalizePostImagePath(rawB) {
  const filePath = rawB.startsWith('b/') ? rawB.slice(2) : rawB;
  return filePath === 'dev/null' || filePath === '/dev/null' ? null : filePath;
}

export function chunkFilePaths(chunkDiffText) {
  const paths = new Set();
  for (const section of diffSections(chunkDiffText)) {
    const rawB = sectionPostImagePath(section);
    if (!rawB) continue;
    const filePath = normalizePostImagePath(rawB);
    if (filePath) paths.add(filePath);
  }
  return [...paths];
}

function contextFilePaths(chunkDiffText) {
  const paths = [];
  for (const section of diffSections(chunkDiffText)) {
    if (isCompleteNewFileSection(section)) continue;
    const rawB = sectionPostImagePath(section);
    if (!rawB) continue;
    const filePath = normalizePostImagePath(rawB);
    if (filePath && !paths.includes(filePath)) paths.push(filePath);
  }
  return paths;
}

function isCompleteNewFileSection(section) {
  return /^--- \/dev\/null$/m.test(section) && /^new file mode /m.test(section);
}

const CONTEXT_NOTE_BUDGET = "[content omitted: exceeds this provider's input budget - review the diff hunks only]";
const CONTEXT_NOTE_UNAVAILABLE = '[content unavailable at review time - review the diff hunks only]';

function contextNoteEntry(filePath, note) {
  return `--- FILE: ${filePath} ---\n${note}`;
}

function readableContextEntry(filePath) {
  if (!existsSync(filePath)) return null;
  const entry = readFilesForPrompt([filePath]);
  const body = entry.slice(entry.indexOf('\n') + 1);
  if (body.startsWith('[unreadable:') || body.startsWith('[skipped:')) return null;
  if (scanDiffForLeaks(body).hasSecretValue) return null;
  return entry;
}

export function fileContextForChunk(chunkDiffText, budget, fallbackPaths = []) {
  const parts = [];
  const omittedPaths = [];
  let remaining = Math.max(0, budget);
  const paths = contextFilePaths(chunkDiffText);
  for (const filePath of paths.length > 0 ? paths : fallbackPaths) {
    let entry = readableContextEntry(filePath);
    if (entry === null) {
      omittedPaths.push(filePath);
      entry = contextNoteEntry(filePath, CONTEXT_NOTE_UNAVAILABLE);
    } else if (entry.length + 2 > remaining) {
      omittedPaths.push(filePath);
      entry = contextNoteEntry(filePath, CONTEXT_NOTE_BUDGET);
    }
    if (entry.length + 2 > remaining) continue;
    parts.push(entry);
    remaining -= entry.length + 2;
  }
  return { text: parts.join('\n\n'), omittedPaths };
}

function degradedInput(input) {
  return input?.inputTruncated ? {
    inputTruncated: true,
    inputChars: input.inputChars,
    truncatedInputChars: input.truncatedInputChars,
    maxInputChars: input.maxInputChars,
  } : null;
}

function reviewDiffBudget(maxInputChars, task, fileContextShare = 0) {
  const messages = buildReviewMessages(task, '');
  const userPromptChars = messages[1]?.content?.length || 0;
  const headroom = Math.min(REVIEW_CHUNK_HEADROOM_CHARS, Math.floor(maxInputChars * 0.1));
  return Math.max(1, Math.floor((maxInputChars - userPromptChars - headroom) * (1 - fileContextShare)));
}

function diffSections(diffText) {
  const sections = diffText.split(/(?=^diff --git )/m).filter((section) => section.length > 0);
  return sections.length > 0 ? sections : [diffText];
}

function oversizedFileLabel(section) {
  const match = section.match(/^diff --git a\/(.+?) b\//m);
  return match ? match[1] : 'unknown file';
}

function oversizedFilePath(section) {
  const rawB = sectionPostImagePath(section);
  return rawB ? normalizePostImagePath(rawB) : null;
}

function splitOversizedSection(section, budget) {
  const fileLabel = oversizedFileLabel(section);
  const filePath = oversizedFilePath(section);
  const completeNewFile = isCompleteNewFileSection(section);
  const noteFor = (index, total) =>
    `[multi-model note: oversized diff slice ${index}/${total} for ${fileLabel}; review only this slice.]\n`;
  const worstCaseNote = noteFor(9999, 9999);
  const sliceBudget = Math.max(1, budget - worstCaseNote.length);
  const total = Math.max(1, Math.ceil(section.length / sliceBudget));
  const chunks = [];
  for (let index = 0; index < total; index++) {
    const note = noteFor(index + 1, total);
    const start = index * sliceBudget;
    chunks.push({
      diffText: `${note}${section.slice(start, start + sliceBudget)}`,
      oversized: true,
      ...(filePath ? { filePath } : {}),
      ...(completeNewFile ? { completeNewFile: true } : {}),
    });
  }
  return chunks;
}

export function splitDiffForReview(diffText, maxInputChars, task = '', { fileContextShare = 0 } = {}) {
  const budget = reviewDiffBudget(maxInputChars, task, fileContextShare);
  const chunks = [];
  let current = '';

  for (const section of diffSections(diffText)) {
    if (section.length > budget) {
      if (current) {
        chunks.push({ diffText: current, oversized: false });
        current = '';
      }
      chunks.push(...splitOversizedSection(section, budget));
      continue;
    }
    const separator = current && !current.endsWith('\n') ? '\n' : '';
    if (current && current.length + separator.length + section.length > budget) {
      chunks.push({ diffText: current, oversized: false });
      current = section;
    } else {
      current = `${current}${separator}${section}`;
    }
  }

  if (current) {
    chunks.push({ diffText: current, oversized: false });
  }

  const finalChunks = chunks.length > 0 ? chunks : [{ diffText, oversized: false }];
  return finalChunks.map((chunk, index) => ({
    ...chunk,
    index: index + 1,
    total: finalChunks.length,
    diffChars: chunk.diffText.length,
  }));
}

function mergeReview(aggregate, review) {
  for (const key of ['issues', 'risks', 'missing']) {
    if (Array.isArray(review?.[key])) {
      aggregate[key].push(...review[key]);
    }
  }
}

function combineInputMetadata(left, right) {
  const input = degradedInput(right);
  if (!input) return left;
  if (!left) return { ...input };
  return {
    inputTruncated: true,
    inputChars: left.inputChars + input.inputChars,
    truncatedInputChars: left.truncatedInputChars + input.truncatedInputChars,
    maxInputChars: input.maxInputChars,
  };
}

function chunkSummary(chunk, fields = {}) {
  return {
    index: chunk.index,
    total: chunk.total,
    diffChars: chunk.diffChars,
    ...(chunk.oversized ? { oversized: true } : {}),
    ...fields,
  };
}

function reviewProviderMaxInputChars(config, providerName) {
  const provider = config.providers[providerName];
  const primaryMax = providerMaxInputChars(config, provider, { profile: 'review' });
  const fallback = provider?.fallbackProvider ? config.providers[provider.fallbackProvider] : null;
  if (!fallback?.apiKey) return primaryMax;
  return Math.min(primaryMax, providerMaxInputChars(config, fallback, { profile: 'review' }));
}

async function reviewProvider({
  config,
  providerName,
  task,
  chunks,
  call,
  maxInputChars,
  includeFileContext,
  runId,
  knownNonIssues = '',
}) {
  const fullDiffBudget = maxInputChars ? reviewDiffBudget(maxInputChars, task) : 0;
  const aggregate = { issues: [], risks: [], missing: [] };
  const chunkResults = [];
  const chunkErrors = [];
  const contextOmitted = [];
  let model;
  let servedBy = null;
  let inputMetadata = null;
  let successes = 0;

  for (const chunk of chunks) {
    const fileContext = includeFileContext
      ? fileContextForChunk(
        chunk.diffText,
        fullDiffBudget - chunk.diffChars,
        chunk.filePath && !chunk.completeNewFile ? [chunk.filePath] : [],
      )
      : { text: '', omittedPaths: [] };
    if (fileContext.omittedPaths.length > 0) {
      contextOmitted.push(...fileContext.omittedPaths.filter((p) => !contextOmitted.includes(p)));
    }
    const messages = buildReviewMessages(task, chunk.diffText, fileContext.text, knownNonIssues);
    const phase = chunks.length > 1 ? `review-chunk-${chunk.index}` : 'review';
    let response;
    try {
      response = await call(config, providerName, messages, {
        profile: 'review',
        command: 'consensus-review',
        runId,
        phase,
      });
    } catch (err) {
      console.error(`multi-model: ${providerName} review call failed: ${err.message}`);
      inputMetadata = combineInputMetadata(inputMetadata, err.input);
      const input = degradedInput(err.input);
      if (input) {
        console.error(`multi-model: ${providerName} review input was truncated by ${input.truncatedInputChars} chars; failure only covers partial context`);
      }
      const error = chunkSummary(chunk, { type: 'failed', error: err.message, ...(input ? { input } : {}) });
      if (chunks.length === 1) {
        return {
          provider: providerName,
          error: err.message,
          ...(input ? { input } : {}),
        };
      }
      chunkErrors.push(error);
      chunkResults.push(error);
      continue;
    }

    model = response.model;
    if (response.provider && response.provider !== providerName) servedBy = response.provider;
    inputMetadata = combineInputMetadata(inputMetadata, response.input);
    const parsed = extractJson(response.content);
    const input = degradedInput(response.input);
    if (!parsed.ok) {
      console.error(`multi-model: ${providerName} returned unparseable review content: ${parsed.error}`);
      const error = chunkSummary(chunk, { type: 'unparseable', error: parsed.error });
      if (chunks.length === 1) {
        return {
          provider: providerName,
          model: response.model,
          review: { raw: parsed.raw, parseError: parsed.error },
          ...(servedBy ? { servedBy } : {}),
          ...(contextOmitted.length > 0 ? { contextOmitted } : {}),
          ...(input ? { input } : {}),
        };
      }
      chunkErrors.push(error);
      chunkResults.push(error);
      continue;
    }
    if (input) {
      console.error(`multi-model: ${providerName} review input was truncated by ${input.truncatedInputChars} chars; treat review as incomplete`);
    }
    const finishReason = response.finishReason || null;
    const degradedFinish = finishReason && !['stop', 'tool_calls'].includes(finishReason);
    if (degradedFinish) {
      const error = chunkSummary(chunk, { type: 'finish_reason', error: `finish_reason=${finishReason}` });
      chunkErrors.push(error);
    }
    mergeReview(aggregate, parsed.value);
    successes++;
    chunkResults.push(chunkSummary(chunk, {
      ok: true,
      ...(finishReason ? { finishReason } : {}),
      ...(response.requestId ? { requestId: response.requestId } : {}),
      issueCount: Array.isArray(parsed.value?.issues) ? parsed.value.issues.length : 0,
      riskCount: Array.isArray(parsed.value?.risks) ? parsed.value.risks.length : 0,
      missingCount: Array.isArray(parsed.value?.missing) ? parsed.value.missing.length : 0,
      ...(input ? { input } : {}),
    }));
  }

  if (successes > 0) {
    return {
      provider: providerName,
      model,
      review: aggregate,
      ...(servedBy ? { servedBy } : {}),
      ...(contextOmitted.length > 0 ? { contextOmitted } : {}),
      ...(chunks.length > 1 ? { chunked: true, chunks: chunkResults } : {}),
      ...(chunkErrors.length > 0 ? { partial: true, chunkErrors } : {}),
      ...(inputMetadata ? { input: inputMetadata } : {}),
    };
  }

  const unparseableOnly = chunkErrors.length > 0 && chunkErrors.every((error) => error.type === 'unparseable');
  if (unparseableOnly) {
    return {
      provider: providerName,
      model,
      review: {
        raw: '',
        parseError: chunkErrors.length === 1
          ? chunkErrors[0].error
          : `${chunkErrors.length} review chunks returned unparseable JSON`,
      },
      ...(servedBy ? { servedBy } : {}),
      ...(contextOmitted.length > 0 ? { contextOmitted } : {}),
      ...(chunks.length > 1 ? { chunked: true, chunks: chunkResults, partial: true, chunkErrors } : {}),
      ...(inputMetadata ? { input: inputMetadata } : {}),
    };
  }

  const firstFailure = chunkErrors.find((error) => error.type === 'failed') || chunkErrors[0];
  return {
    provider: providerName,
    error: firstFailure?.error || 'all review chunks failed',
    ...(chunks.length > 1 ? { chunked: true, chunks: chunkResults, chunkErrors } : {}),
    ...(inputMetadata ? { input: inputMetadata } : {}),
  };
}

const PATHISH_TOKEN = /[\w@][\w@./-]*\/[\w@./-]*\.\w{1,10}/g;

function referencedPaths(review) {
  const paths = new Set();
  for (const issue of review.issues || []) {
    if (typeof issue?.file === 'string' && issue.file.trim()) paths.add(issue.file.trim());
  }
  for (const key of ['risks', 'missing']) {
    for (const entry of review[key] || []) {
      if (typeof entry !== 'string') continue;
      for (const token of entry.match(PATHISH_TOKEN) || []) paths.add(token);
    }
  }
  return [...paths];
}

async function selfVerifyReview({ config, providerName, task, result, diffPaths, includeFileContext, call, runId }) {
  const review = result.review;
  if (!review || review.parseError) return result;
  const findingsCount = (review.issues?.length || 0) + (review.risks?.length || 0) + (review.missing?.length || 0);
  if (findingsCount === 0) return result;
  const omitted = new Set(result.contextOmitted || []);
  const provided = new Set(includeFileContext ? diffPaths.filter((p) => !omitted.has(p)) : []);
  const candidates = referencedPaths(review)
    .filter((p) => !provided.has(p))
    .filter((p) => existsSync(p))
    .slice(0, SELF_VERIFY_MAX_FILES);
  if (candidates.length === 0) return result;
  console.error(`multi-model: ${providerName} self-verifying its findings against ${candidates.length} referenced file(s) it had not seen`);
  const maxInputChars = reviewProviderMaxInputChars(config, providerName);
  const budget = Math.floor(maxInputChars * SELF_VERIFY_CONTEXT_SHARE);
  let context = readFilesForPrompt(candidates);
  if (context.length > budget) {
    context = `${context.slice(0, budget)}\n\n[...additional context truncated at the provider input budget...]`;
  }
  try {
    const response = await call(config, providerName, buildSelfVerifyMessages(task, review, context), {
      profile: 'review',
      command: 'consensus-review',
      runId,
      phase: 'self-verify',
    });
    const parsed = extractJson(response.content);
    if (!parsed.ok) {
      console.error(`multi-model: ${providerName} self-verify returned unparseable JSON; keeping unverified findings`);
      return { ...result, selfVerifyError: `unparseable self-verify response: ${parsed.error}` };
    }
    const verified = {
      issues: Array.isArray(parsed.value.issues) ? parsed.value.issues : [],
      risks: Array.isArray(parsed.value.risks) ? parsed.value.risks : [],
      missing: Array.isArray(parsed.value.missing) ? parsed.value.missing : [],
    };
    return {
      ...result,
      review: verified,
      selfVerified: true,
      selfVerifyFiles: candidates,
      retracted: {
        issues: Math.max(0, (review.issues?.length || 0) - verified.issues.length),
        risks: Math.max(0, (review.risks?.length || 0) - verified.risks.length),
        missing: Math.max(0, (review.missing?.length || 0) - verified.missing.length),
      },
    };
  } catch (err) {
    console.error(`multi-model: ${providerName} self-verify call failed: ${err.message}; keeping unverified findings`);
    return { ...result, selfVerifyError: err.message };
  }
}

export async function consensusReview({
  task,
  diffText,
  providers,
  includeFileContext = true,
  selfVerify = true,
  runId = null,
}, deps = {}) {
  const config = deps.config || loadConfig();
  const call = deps.callChatCompletion || callChatCompletion;
  const knownNonIssues = deps.knownNonIssues ?? loadKnownNonIssues();
  const diffPaths = chunkFilePaths(diffText);
  const candidateProviders = providers || defaultFanoutProviders(config);
  const reviewRunId = runId || `review-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

  const leaks = scanDiffForLeaks(diffText);
  if (leaks.sensitivePaths.length > 0 || leaks.hasSecretValue) {
    const reasons = [
      ...leaks.sensitivePaths.map((p) => `touches a sensitive path: ${p}`),
      ...(leaks.hasSecretValue ? ['contains a line that looks like it holds a secret (value redacted; review the diff directly)'] : []),
    ];
    console.error(`multi-model: refusing to send diff to external review providers - ${reasons.join('; ')}`);
    return { runId: reviewRunId, results: [], rejected: reasons };
  }

  const configuredProviders = candidateProviders.filter(
    (providerName) => isProviderConfigured(config, providerName)
  );

  const results = await Promise.all(configuredProviders.map(async (providerName) => {
    const maxInputChars = reviewProviderMaxInputChars(config, providerName);
    const chunks = splitDiffForReview(diffText, maxInputChars, task, {
      fileContextShare: includeFileContext ? FILE_CONTEXT_RESERVE_SHARE : 0,
    });
    if (chunks.length > 1) {
      console.error(`multi-model: split review diff into ${chunks.length} chunks for ${providerName} to avoid provider input truncation`);
    }
    let result = await reviewProvider({
      config,
      providerName,
      task,
      chunks,
      call,
      maxInputChars,
      includeFileContext,
      runId: reviewRunId,
      knownNonIssues,
    });
    if (selfVerify && result.review && !result.review.parseError) {
      result = await selfVerifyReview({
        config,
        providerName,
        task,
        result,
        diffPaths,
        includeFileContext,
        call,
        runId: reviewRunId,
      });
    }
    return result;
  }));
  return { runId: reviewRunId, results };
}

/**
 * Summarizes provider review results into a one-line valid/unparseable/failed count.
 *
 * @param {Array<{provider: string, review?: {parseError?: string}, error?: string}>} results
 * @returns {string}
 */
export function summarizeReviewResults(results) {
  const total = results.length;
  const failed = results.filter((r) => r.error).length;
  const unparseable = results.filter((r) => r.review && r.review.parseError).length;
  const valid = total - failed - unparseable;
  const partial = results.filter((r) => r.partial).length;
  const truncated = results.filter((r) => r.input?.inputTruncated).length;
  const partialNote = partial > 0 ? `, ${partial} partial` : '';
  const truncatedNote = truncated > 0
    ? `, ${truncated} truncated input${truncated === 1 ? '' : 's'}; treat valid reviews as incomplete`
    : '';
  const singleProviderNote = total < 2 ? ' - only 1 provider configured, this is a second opinion, not consensus' : '';
  return `multi-model: ${valid}/${total} providers returned a valid review (${unparseable} unparseable, ${failed} failed${partialNote}${truncatedNote})${singleProviderNote}`;
}

const GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;

export function currentGitDiff(cwd = process.cwd()) {
  const tracked = execFileSync('git', ['diff'], { cwd, encoding: 'utf8', maxBuffer: GIT_DIFF_MAX_BUFFER });
  const untrackedFiles = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const untrackedDiffs = untrackedFiles.map((f) => {
    try {
      return execFileSync('git', ['diff', '--no-index', '--', '/dev/null', f], {
        cwd,
        encoding: 'utf8',
        maxBuffer: GIT_DIFF_MAX_BUFFER,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // --no-index exits 1 on the expected "files differ" case; diff text is in err.stdout
      if (err.status === 1) return err.stdout || '';
      console.error(`multi-model: could not diff untracked file ${f}: ${(err.stderr || err.message).trim()}`);
      return '';
    }
  }).join('');
  return tracked + untrackedDiffs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['no-file-context', 'file-context', 'no-self-verify'] });
  try {
    const diffText = args.diff ? readFileSync(args.diff, 'utf8') : currentGitDiff();
    if (!diffText.trim()) {
      console.error('No diff to review (working tree clean and no --diff given).');
      process.exit(2);
    }
    const isStandalonePatch = Boolean(args.diff);
    const includeFileContext = args['file-context']
      ? true
      : !args['no-file-context'] && !isStandalonePatch;
    if (isStandalonePatch && !includeFileContext && !args['no-file-context']) {
      console.error('multi-model: --diff reviews a standalone patch file - disabling file context since '
        + 'on-disk files may not match the patched result (pass --file-context once the patch is applied '
        + 'to review against it).');
    }
    const { runId, results, rejected } = await consensusReview({
      task: args.task || '',
      diffText,
      providers: args.providers
        ? args.providers.split(',')
        : (args.role ? providersForRole(loadConfig(), args.role) : undefined),
      includeFileContext,
      selfVerify: !args['no-self-verify'],
    });
    if (rejected) {
      process.exit(1);
    }
    if (results.length === 0) {
      console.error('No providers configured. Run mm-provider to check.');
      process.exit(1);
    }
    console.error(`multi-model: review run ${runId}`);
    console.error(summarizeReviewResults(results));
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    console.error(`multi-model consensus-review failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
