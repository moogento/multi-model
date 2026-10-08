import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from './config.js';
import { guardDiff } from './diff-guard.js';
import { appendOutcome } from './log-outcome.js';

function parseProviderFromPatchPath(diffPath) {
  const base = path.basename(diffPath).replace(/\.[^.]+$/, '');
  const parts = base.split('-');
  let suffixIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    if (/^[0-9a-f]{6}$/.test(parts[i])) suffixIndex = i;
  }
  if (suffixIndex === -1 || suffixIndex === parts.length - 1) return 'unknown';
  return parts.slice(suffixIndex + 1).join('-');
}

export function applyGuardedDiff(diffPath, options = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  const command = options.command || 'unknown';
  const provider = parseProviderFromPatchPath(diffPath);
  const diffText = readFileSync(diffPath, 'utf8');
  const guardResult = guardDiff(diffText, repoRoot, options);
  if (!guardResult.ok) {
    appendOutcome({
      command,
      provider,
      outcome: 'dropped',
      reasonCategory: 'rejected-by-diff-guard',
      reason: guardResult.violations.join('; ').slice(0, 300),
    }, options);
    return { applied: false, violations: guardResult.violations };
  }
  try {
    const applyArgs = guardResult.needsRecount ? ['apply', '--recount'] : ['apply'];
    execFileSync('git', applyArgs, { cwd: repoRoot, input: diffText, stdio: ['pipe', 'inherit', 'inherit'] });
  } catch (err) {
    appendOutcome({
      command,
      provider,
      outcome: 'dropped',
      reasonCategory: 'diff-inapplicable',
      reason: err.message.slice(0, 300),
    }, options);
    throw err;
  }
  appendOutcome({ command, provider, outcome: 'kept', reasonCategory: 'applied-clean' }, options);
  return { applied: true, violations: [] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['allow-vendor', 'allow-sensitive-paths', 'allow-network', 'allow-large-deletion'],
  });
  if (!args.diff) {
    console.error('Usage: apply-guarded-diff.js --diff <path> [--command <name>] [--allow-vendor] [--allow-sensitive-paths] [--allow-network] [--allow-large-deletion]');
    process.exit(2);
  }
  try {
    const result = applyGuardedDiff(path.resolve(args.diff), {
      allowVendor: Boolean(args['allow-vendor']),
      allowSensitivePaths: Boolean(args['allow-sensitive-paths']),
      allowNetwork: Boolean(args['allow-network']),
      allowLargeDeletion: Boolean(args['allow-large-deletion']),
      command: args.command || 'unknown',
    });
    if (!result.applied) {
      console.error('REJECTED by diff-guard:');
      for (const v of result.violations) console.error(`  - ${v}`);
      process.exit(1);
    }
    console.log(`Applied ${args.diff}`);
  } catch (err) {
    console.error(`multi-model apply-guarded-diff failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
