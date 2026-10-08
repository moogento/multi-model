import { loadConfig, parseArgs, resolveProviderForRole, savePatch, diffStats } from './config.js';
import { callChatCompletion, isProviderConfigured } from './providers.js';
import {
  buildImplementMessages,
  buildImplementNotesMessages,
  buildReviewMessages,
  buildReviseMessages,
  extractDiff,
  extractJson,
} from './prompt-builder.js';
import { applyGuardedDiff } from './apply-guarded-diff.js';
import { scanDiffForLeaks } from './diff-guard.js';

function isDiffLeaky(diffText) {
  const leaks = scanDiffForLeaks(diffText);
  return leaks.sensitivePaths.length > 0 || leaks.hasSecretValue;
}

async function critique(config, critiqueProvider, call, task, diffText) {
  if (isDiffLeaky(diffText)) return null;
  let response;
  try {
    response = await call(config, critiqueProvider, buildReviewMessages(task, diffText));
  } catch (err) {
    console.error(`multi-model: ${critiqueProvider} critique call failed: ${err.message}`);
    return null;
  }
  const parsed = extractJson(response.content);
  if (!parsed.ok) {
    console.error(`multi-model: ${critiqueProvider} returned unparseable critique content: ${parsed.error}`);
    return null;
  }
  return parsed.value;
}

export async function cheapImplement({ task, files, provider, selfCorrect = true, mode = 'diff' }, deps = {}) {
  const config = deps.config || loadConfig();
  const providerName = resolveProviderForRole(config, 'implementation', provider);
  const call = deps.callChatCompletion || callChatCompletion;
  const save = deps.savePatch || savePatch;

  if (mode === 'notes') {
    const notesResponse = await call(config, providerName, buildImplementNotesMessages(task, files));
    if (!notesResponse.content.trim()) {
      throw new Error(`${providerName} returned empty implementation notes - nothing saved`);
    }
    const finishReason = notesResponse.finishReason ?? null;
    const truncated = Boolean(finishReason && !['stop', 'tool_calls'].includes(finishReason));
    if (truncated) {
      console.error(`multi-model: ${providerName} notes ended with finish_reason=${finishReason} - treat them as cut off`);
    }
    return {
      provider: notesResponse.provider,
      model: notesResponse.model,
      mode: 'notes',
      notes: notesResponse.content,
      notesPath: save(providerName, notesResponse.content, { subdir: 'drafts', extension: 'md' }),
      truncated,
      finishReason,
    };
  }

  const draftResponse = await call(config, providerName, buildImplementMessages(task, files));
  const draftDiff = extractDiff(draftResponse.content);

  const critiqueProvider = resolveProviderForRole(config, 'critique');
  if (!selfCorrect || !isProviderConfigured(config, critiqueProvider)) {
    return {
      provider: draftResponse.provider, model: draftResponse.model, diff: draftDiff, patchPath: save(providerName, draftDiff),
      critique: null, revised: false, revisionCritique: null,
    };
  }

  const critique1 = await critique(config, critiqueProvider, call, task, draftDiff);
  if (!critique1 || !critique1.issues || critique1.issues.length === 0) {
    return {
      provider: draftResponse.provider, model: draftResponse.model, diff: draftDiff, patchPath: save(providerName, draftDiff),
      critique: critique1, revised: false, revisionCritique: null,
    };
  }

  let revisedResponse;
  try {
    revisedResponse = await call(config, providerName, buildReviseMessages(task, files, draftDiff, critique1));
  } catch (err) {
    console.error(`multi-model: ${providerName} revision call failed: ${err.message}`);
    return {
      provider: draftResponse.provider, model: draftResponse.model, diff: draftDiff, patchPath: save(providerName, draftDiff),
      critique: critique1, revised: false, revisionCritique: null,
    };
  }
  const revisedDiff = extractDiff(revisedResponse.content);
  if (isDiffLeaky(revisedDiff)) {
    console.error('multi-model: revision touches a sensitive path or secret-looking value - falling back to the original draft');
    return {
      provider: draftResponse.provider, model: draftResponse.model, diff: draftDiff, patchPath: save(providerName, draftDiff),
      critique: critique1, revised: false, revisionCritique: null,
    };
  }
  const critique2 = await critique(config, critiqueProvider, call, task, revisedDiff);

  return {
    provider: revisedResponse.provider, model: revisedResponse.model, diff: revisedDiff, patchPath: save(providerName, revisedDiff),
    critique: critique1, revised: true, revisionCritique: critique2,
  };
}

/**
 * Applies a saved patch through the diff-guard only when explicitly requested via --apply.
 *
 * @param {string} patchPath
 * @param {object} args
 * @param {object} [deps]
 * @returns {{applied: boolean, violations: string[]}}
 */
export function applyIfRequested(patchPath, args, deps = {}) {
  if (!args.apply) return { applied: false, violations: [] };
  const apply = deps.applyGuardedDiff || applyGuardedDiff;
  return apply(patchPath, {
    allowVendor: Boolean(args['allow-vendor']),
    allowSensitivePaths: Boolean(args['allow-sensitive-paths']),
    allowNetwork: Boolean(args['allow-network']),
    allowLargeDeletion: Boolean(args['allow-large-deletion']),
  });
}

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function selfCorrectSummary(result) {
  if (!result.critique) return '';
  const issueCount = result.critique.issues ? result.critique.issues.length : 0;
  if (!result.revised) return ` [glm critique: ${pluralize(issueCount, 'issue')}, no revision needed]`;
  const revisionIssueCount = result.revisionCritique && result.revisionCritique.issues ? result.revisionCritique.issues.length : 0;
  const revisionNote = result.revisionCritique
    ? (revisionIssueCount > 0 ? `${pluralize(revisionIssueCount, 'issue')} remain` : 'clean')
    : 'unavailable';
  return ` [glm critique: ${pluralize(issueCount, 'issue')} -> revised; revision critique: ${revisionNote}]`;
}

/**
 * Validates --mode and --apply CLI arguments
 * @param {{mode?: string, apply?: boolean}} args
 * @returns {{mode: 'diff'|'notes', error?: string}}
 */
export function validateModeArgs(args) {
  if (args.mode !== undefined && !['diff', 'notes'].includes(args.mode)) {
    return { mode: 'diff', error: `Unknown --mode "${args.mode}" - use "diff" or "notes".` };
  }
  const mode = args.mode === 'notes' ? 'notes' : 'diff';
  if (mode === 'notes' && args.apply) {
    return { mode, error: '--apply is not valid with --mode notes: notes are advisory Markdown, not a patch.' };
  }
  return { mode };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'allow-vendor', 'allow-sensitive-paths', 'allow-network', 'allow-large-deletion', 'no-self-correct'],
  });
  if (!args.task || !args.files) {
    console.error('Usage: cheap-implement.js --provider deepseek --task "..." --files "path1,path2" [--mode diff|notes] [--apply] [--no-self-correct]');
    process.exit(2);
  }
  const { mode, error } = validateModeArgs(args);
  if (error) {
    console.error(error);
    process.exit(2);
  }
  const files = args.files.split(',').map((f) => f.trim()).filter(Boolean);
  try {
    const result = await cheapImplement({
      task: args.task, files, provider: args.provider, selfCorrect: !args['no-self-correct'], mode,
    });
    if (result.mode === 'notes') {
      const truncationNote = result.truncated ? ` (WARNING: finish_reason=${result.finishReason} - notes are cut off)` : '';
      console.log(`Saved implementation notes from ${result.provider} (${result.model}) to ${result.notesPath}${truncationNote}`);
      return;
    }
    const stats = diffStats(result.diff);
    console.log(`Saved draft diff from ${result.provider} (${result.model}) to ${result.patchPath} - files=${stats.files} +${stats.added}/-${stats.removed}${selfCorrectSummary(result)}`);
    if (args.apply) {
      const applied = applyIfRequested(result.patchPath, args);
      if (!applied.applied) {
        console.error('REJECTED by diff-guard:');
        for (const v of applied.violations) console.error(`  - ${v}`);
        process.exit(1);
      }
      console.log('Applied.');
    }
  } catch (err) {
    console.error(`multi-model implement failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
