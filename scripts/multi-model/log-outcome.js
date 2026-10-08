import { appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadConfig, parseArgs, resolveOutcomeLogFile } from './config.js';

export const OUTCOMES = ['kept', 'kept-edited', 'partial', 'dropped'];

export const REASON_CATEGORIES = [
  'applied-clean',
  'applied-with-edits',
  'wrong-approach',
  'hallucinated-api',
  'style-mismatch',
  'diff-inapplicable',
  'rejected-by-diff-guard',
  'not-selected',
  'truncated-output',
  'out-of-scope',
  'user-declined',
  'other',
];

function detectRepo(cwd = process.cwd()) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return path.basename(root);
  } catch {
    return path.basename(cwd);
  }
}

export function appendOutcome(record, options = {}) {
  const { command, provider, model = null, outcome, reasonCategory = null, reason = null } = record;
  if (!command) throw new Error('command is required');
  if (!provider) throw new Error('provider is required');
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`outcome must be one of: ${OUTCOMES.join(', ')}`);
  }
  if ((outcome === 'dropped' || outcome === 'partial') && !reasonCategory) {
    throw new Error(`reasonCategory is required when outcome is "${outcome}"`);
  }
  if (reasonCategory && !REASON_CATEGORIES.includes(reasonCategory)) {
    throw new Error(`reasonCategory must be one of: ${REASON_CATEGORIES.join(', ')}`);
  }
  const logFile = resolveOutcomeLogFile(options);
  if (!logFile) return null;
  const line = {
    ts: new Date().toISOString(),
    repo: options.repo || detectRepo(options.cwd),
    command,
    provider,
    model,
    outcome,
    reasonCategory,
    reason,
  };
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(line)}\n`, 'utf8');
  } catch (err) {
    console.error(`multi-model: outcome logging skipped: ${err.message}`);
    return null;
  }
  return line;
}

/**
 * Returns the model the named provider is configured to call, or null when it cannot be resolved
 */
export function configuredModel(provider, load = loadConfig) {
  try {
    return load().providers[provider]?.model || null;
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const record = appendOutcome({
      command: args.command,
      provider: args.provider,
      model: args.model || configuredModel(args.provider),
      outcome: args.outcome,
      reasonCategory: args['reason-category'] || null,
      reason: args.reason || null,
    });
    if (!record) {
      console.log('Outcome logging disabled (MULTI_MODEL_OUTCOME_LOG=off) - nothing written.');
      return;
    }
    console.log(`Logged outcome: ${record.command} / ${record.provider} -> ${record.outcome}`);
  } catch (err) {
    console.error(`multi-model log-outcome failed: ${err.message}`);
    console.error(`Valid --outcome values: ${OUTCOMES.join(', ')}`);
    console.error(`Valid --reason-category values: ${REASON_CATEGORIES.join(', ')}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
