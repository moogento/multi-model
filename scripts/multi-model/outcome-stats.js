import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseArgs,
  defaultCallLogPath,
  defaultOutcomeLogPath,
  defaultUsageLogPath,
  resolveCallLogFile,
  resolveOutcomeLogFile,
} from './config.js';
import { resolveUsageLogFile } from './providers.js';

function readJsonlRecords(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  let lines;
  try {
    lines = readFileSync(filePath, 'utf8').split('\n');
  } catch {
    return [];
  }
  const records = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return records;
}

function parseSinceMs(value) {
  if (!value) return null;
  const m = /^(\d+)(d|h)$/.exec(String(value).trim());
  if (!m) throw new Error(`--since must look like "30d" or "12h", got "${value}"`);
  const amount = Number(m[1]);
  const unitMs = m[2] === 'd' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return amount * unitMs;
}

function withinSince(ts, sinceMs, now) {
  if (!sinceMs) return true;
  const t = Date.parse(ts);
  return Number.isFinite(t) && t >= now - sinceMs;
}

function isOfflineFailure(r) {
  if (r.failureCategory === 'offline') return true;
  return r.failureCategory === 'network-error' && /\((ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\)/.test(r.error || '');
}

function collectCallStats(records) {
  const byProvider = {};
  for (const r of records) {
    const bucket = byProvider[r.provider] ||= {
      providerCalls: 0,
      providerFailures: 0,
      timeoutFailures: 0,
      offlineFailures: 0,
      quotaFailures: 0,
      promptTooLongFailures: 0,
      nonStopFinishes: 0,
      providerAttempts: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
    };
    const failed = r.ok === false || r.outcome === 'failed';
    const attempts = Number.isFinite(Number(r.attempts)) ? Number(r.attempts) : 1;
    const latencyMs = Number.isFinite(Number(r.latencyMs)) ? Number(r.latencyMs) : 0;
    bucket.providerCalls++;
    bucket.providerAttempts += attempts;
    bucket.totalLatencyMs += latencyMs;
    bucket.maxLatencyMs = Math.max(bucket.maxLatencyMs, latencyMs);
    if (failed) {
      bucket.providerFailures++;
      if (r.failureCategory === 'timeout') bucket.timeoutFailures++;
      if (isOfflineFailure(r)) bucket.offlineFailures++;
      if (r.failureCategory === 'quota-exhausted') bucket.quotaFailures++;
      if (r.failureCategory === 'prompt-too-long') bucket.promptTooLongFailures++;
    } else if (r.finishReason && !['stop', 'tool_calls'].includes(r.finishReason)) {
      bucket.nonStopFinishes++;
    }
  }
  return byProvider;
}

function emptyOutcomeBucket(provider, command = null) {
  return {
    provider,
    command,
    runs: 0,
    kept: 0,
    keptEdited: 0,
    partial: 0,
    dropped: 0,
    reasonCounts: {},
  };
}

export function aggregateOutcomes({ outcomeFiles, usageFiles, callFiles = [], since = null, byCommand = false, now = Date.now() } = {}) {
  const sinceMs = parseSinceMs(since);
  const outcomeRecords = outcomeFiles
    .flatMap(readJsonlRecords)
    .filter((r) => r && r.provider && r.outcome && withinSince(r.ts, sinceMs, now));
  const usageRecords = usageFiles
    .flatMap(readJsonlRecords)
    .filter((r) => r && r.provider && withinSince(r.ts, sinceMs, now));
  const callRecords = callFiles
    .flatMap(readJsonlRecords)
    .filter((r) => r && r.provider && withinSince(r.ts, sinceMs, now));

  const usageByProvider = {};
  for (const r of usageRecords) {
    const bucket = usageByProvider[r.provider] ||= { calls: 0, totalCostUsd: 0, unknownCostCalls: 0 };
    bucket.calls++;
    if (r.estCostUsd == null) {
      bucket.unknownCostCalls++;
    } else {
      bucket.totalCostUsd += r.estCostUsd;
    }
  }

  const byGroup = {};
  for (const r of outcomeRecords) {
    const key = byCommand ? `${r.provider}::${r.command}` : r.provider;
    const bucket = byGroup[key] ||= emptyOutcomeBucket(r.provider, byCommand ? r.command : null);
    bucket.runs++;
    if (r.outcome === 'kept') bucket.kept++;
    else if (r.outcome === 'kept-edited') bucket.keptEdited++;
    else if (r.outcome === 'partial') bucket.partial++;
    else if (r.outcome === 'dropped') bucket.dropped++;
    if ((r.outcome === 'dropped' || r.outcome === 'partial') && r.reasonCategory) {
      bucket.reasonCounts[r.reasonCategory] = (bucket.reasonCounts[r.reasonCategory] || 0) + 1;
    }
  }

  const callsByProvider = collectCallStats(callRecords);
  const rowKeys = new Set(Object.keys(byGroup));
  if (!byCommand) {
    for (const provider of Object.keys(callsByProvider)) rowKeys.add(provider);
  }

  const rows = [...rowKeys].map((key) => {
    const bucket = byGroup[key] || emptyOutcomeBucket(key, null);
    const keepCount = bucket.kept + bucket.keptEdited;
    const usage = usageByProvider[bucket.provider] || { calls: 0, totalCostUsd: 0, unknownCostCalls: 0 };
    const pricedCalls = usage.calls - usage.unknownCostCalls;
    const calls = byCommand ? null : callsByProvider[bucket.provider] || null;
    const providerCalls = calls?.providerCalls ?? null;
    const providerFailures = calls?.providerFailures ?? null;
    const timeoutFailures = calls?.timeoutFailures ?? null;
    const offlineFailures = calls?.offlineFailures ?? null;
    const quotaFailures = calls?.quotaFailures ?? null;
    const promptTooLongFailures = calls?.promptTooLongFailures ?? null;
    const nonStopFinishes = calls?.nonStopFinishes ?? null;
    const providerAttempts = calls?.providerAttempts ?? null;
    const avgLatencyMs = calls && calls.providerCalls > 0 ? calls.totalLatencyMs / calls.providerCalls : null;
    return {
      ...bucket,
      keepRate: bucket.runs > 0 ? keepCount / bucket.runs : null,
      providerCalls,
      providerFailures,
      timeoutFailures,
      offlineFailures,
      quotaFailures,
      promptTooLongFailures,
      nonStopFinishes,
      providerAttempts,
      callFailureRate: providerCalls - offlineFailures > 0
        ? (providerFailures - offlineFailures) / (providerCalls - offlineFailures)
        : null,
      avgLatencyMs,
      maxLatencyMs: calls?.maxLatencyMs ?? null,
      totalCostUsd: byCommand ? null : usage.totalCostUsd,
      unknownCostCalls: byCommand ? null : usage.unknownCostCalls,
      avgCostPerCallUsd: byCommand ? null : (pricedCalls > 0 ? usage.totalCostUsd / pricedCalls : null),
      effCostPerKeptUsd: byCommand ? null : (keepCount > 0 ? usage.totalCostUsd / keepCount : null),
    };
  });
  rows.sort((a, b) => b.runs - a.runs);
  return rows;
}

function formatUsd(n) {
  return n == null ? 'n/a' : `$${n.toFixed(4)}`;
}

function formatPct(n) {
  return n == null ? 'n/a' : `${Math.round(n * 100)}%`;
}

function formatMs(n) {
  return n == null ? 'n/a' : `${Math.round(n)}`;
}

function printTable(rows, byCommand) {
  if (rows.length === 0) {
    console.log('No outcome records found - nothing has been logged to outcomes.jsonl yet.');
    return;
  }
  const header = byCommand
    ? ['Provider', 'Command', 'Runs', 'Kept', 'K-Edit', 'Partial', 'Dropped', 'Keep%', 'Total$', 'Avg$/call', 'Eff.$/kept']
    : ['Provider', 'Runs', 'Kept', 'K-Edit', 'Partial', 'Dropped', 'Keep%', 'Calls', 'Failed', 'Offline', 'Timeout', 'Quota', 'PromptLong', 'NonStop', 'Fail%', 'AvgMs', 'Total$', 'Avg$/call', 'Eff.$/kept'];
  console.log(header.join('\t'));
  for (const r of rows) {
    const row = byCommand
      ? [r.provider, r.command, r.runs, r.kept, r.keptEdited, r.partial, r.dropped, formatPct(r.keepRate), formatUsd(r.totalCostUsd), formatUsd(r.avgCostPerCallUsd), formatUsd(r.effCostPerKeptUsd)]
      : [r.provider, r.runs, r.kept, r.keptEdited, r.partial, r.dropped, formatPct(r.keepRate), r.providerCalls ?? 'n/a', r.providerFailures ?? 'n/a', r.offlineFailures ?? 'n/a', r.timeoutFailures ?? 'n/a', r.quotaFailures ?? 'n/a', r.promptTooLongFailures ?? 'n/a', r.nonStopFinishes ?? 'n/a', formatPct(r.callFailureRate), formatMs(r.avgLatencyMs), formatUsd(r.totalCostUsd), formatUsd(r.avgCostPerCallUsd), formatUsd(r.effCostPerKeptUsd)];
    const unknownNote = r.unknownCostCalls ? ` (+${r.unknownCostCalls} calls of unknown cost)` : '';
    console.log(row.join('\t') + unknownNote);
  }
}

function printReasons(rows) {
  for (const r of rows) {
    const entries = Object.entries(r.reasonCounts).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) continue;
    console.log(`\n${r.provider}${r.command ? ` / ${r.command}` : ''} - top drop reasons:`);
    for (const [reason, count] of entries) {
      console.log(`  ${reason}: ${count}`);
    }
  }
}

function repoPaths(args) {
  if (args['all-repos']) {
    return args['all-repos'].split(',').map((p) => path.resolve(p.trim())).filter(Boolean);
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['by-command', 'reasons', 'json'] });
  try {
    const repos = repoPaths(args);
    const outcomeFiles = repos ? repos.map((r) => defaultOutcomeLogPath(r)) : [resolveOutcomeLogFile()];
    const usageFiles = repos ? repos.map((r) => defaultUsageLogPath(r)) : [resolveUsageLogFile()];
    const callFiles = repos ? repos.map((r) => defaultCallLogPath(r)) : [resolveCallLogFile()];
    const byCommand = Boolean(args['by-command']);
    const rows = aggregateOutcomes({
      outcomeFiles,
      usageFiles,
      callFiles,
      since: args.since || null,
      byCommand,
    });
    if (args.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    printTable(rows, byCommand);
    if (args.reasons) printReasons(rows);
  } catch (err) {
    console.error(`multi-model outcome-stats failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
