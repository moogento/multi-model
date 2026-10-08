import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, resolveCallLogFile } from './config.js';
import { isProviderConfigured, resolveUsageLogFile } from './providers.js';

function readUsage(usageLogFile) {
  const logFile = usageLogFile || resolveUsageLogFile();
  if (!logFile || !existsSync(logFile)) return null;
  let lines;
  try {
    lines = readFileSync(logFile, 'utf8').split('\n');
  } catch (err) {
    console.error(`multi-model: usage log unreadable, skipping totals: ${err.message}`);
    return null;
  }
  const byProvider = {};
  const totals = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    estCostUsd: 0,
    apiEquivalentCostUsd: 0,
    unknownCostCalls: 0,
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record?.provider) continue;
    const bucket = byProvider[record.provider] ||= {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedPromptTokens: 0,
      estCostUsd: 0,
      apiEquivalentCostUsd: 0,
      unknownCostCalls: 0,
    };
    bucket.calls++;
    totals.calls++;
    bucket.promptTokens += record.promptTokens || 0;
    totals.promptTokens += record.promptTokens || 0;
    bucket.completionTokens += record.completionTokens || 0;
    totals.completionTokens += record.completionTokens || 0;
    bucket.totalTokens += record.totalTokens || 0;
    totals.totalTokens += record.totalTokens || 0;
    bucket.cachedPromptTokens += record.cachedPromptTokens || 0;
    totals.cachedPromptTokens += record.cachedPromptTokens || 0;
    bucket.apiEquivalentCostUsd += record.apiEquivalentCostUsd || 0;
    totals.apiEquivalentCostUsd += record.apiEquivalentCostUsd || 0;
    if (record.estCostUsd == null) {
      bucket.unknownCostCalls++;
      totals.unknownCostCalls++;
    } else {
      bucket.estCostUsd += record.estCostUsd;
      totals.estCostUsd += record.estCostUsd;
    }
  }
  return totals.calls > 0 ? { byProvider, totals, logFile } : null;
}

function readCalls(callLogFile) {
  const logFile = callLogFile || resolveCallLogFile();
  if (!logFile || !existsSync(logFile)) return null;
  let lines;
  try {
    lines = readFileSync(logFile, 'utf8').split('\n');
  } catch (err) {
    console.error(`multi-model: call log unreadable, skipping reliability totals: ${err.message}`);
    return null;
  }
  const byProvider = {};
  const totals = {
    calls: 0,
    successes: 0,
    failures: 0,
    timeoutFailures: 0,
    quotaFailures: 0,
    promptTooLongFailures: 0,
    nonStopFinishes: 0,
    attempts: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record?.provider) continue;
    const bucket = byProvider[record.provider] ||= {
      calls: 0,
      successes: 0,
      failures: 0,
      timeoutFailures: 0,
      quotaFailures: 0,
      promptTooLongFailures: 0,
      nonStopFinishes: 0,
      attempts: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
    };
    const attempts = Number.isFinite(Number(record.attempts)) ? Number(record.attempts) : 1;
    const latencyMs = Number.isFinite(Number(record.latencyMs)) ? Number(record.latencyMs) : 0;
    const failed = record.ok === false || record.outcome === 'failed';
    bucket.calls++;
    totals.calls++;
    bucket.attempts += attempts;
    totals.attempts += attempts;
    bucket.totalLatencyMs += latencyMs;
    totals.totalLatencyMs += latencyMs;
    bucket.maxLatencyMs = Math.max(bucket.maxLatencyMs, latencyMs);
    totals.maxLatencyMs = Math.max(totals.maxLatencyMs, latencyMs);
    if (failed) {
      bucket.failures++;
      totals.failures++;
      if (record.failureCategory === 'timeout') {
        bucket.timeoutFailures++;
        totals.timeoutFailures++;
      }
      if (record.failureCategory === 'quota-exhausted') {
        bucket.quotaFailures++;
        totals.quotaFailures++;
      }
      if (record.failureCategory === 'prompt-too-long') {
        bucket.promptTooLongFailures++;
        totals.promptTooLongFailures++;
      }
    } else {
      bucket.successes++;
      totals.successes++;
      if (record.finishReason && !['stop', 'tool_calls'].includes(record.finishReason)) {
        bucket.nonStopFinishes++;
        totals.nonStopFinishes++;
      }
    }
  }
  return totals.calls > 0 ? { byProvider, totals, logFile } : null;
}

export function providerStatus({ usageLogFile, callLogFile } = {}) {
  const config = loadConfig();
  const providers = Object.entries(config.providers).map(([name, p]) => ({
    name,
    configured: isProviderConfigured(config, name),
    keyPresent: Boolean(p.apiKey),
    fallbackProvider: p.fallbackProvider || null,
    apiKeyEnv: p.apiKeyEnv,
    baseUrl: p.baseUrl,
    model: p.model,
    maxInputChars: p.maxInputChars ?? config.limits.maxInputChars,
    timeoutMs: p.timeoutMs,
    retries: p.retries,
    retryDelayMs: p.retryDelayMs,
    reviewFanout: p.reviewFanout !== false,
    configCheck: p.configCheck !== false,
  }));
  return {
    providers,
    roles: config.roles,
    benchmarkPresets: config.benchmarkPresets || {},
    usage: readUsage(usageLogFile),
    calls: readCalls(callLogFile),
    mooAutoAssist: ['1', 'true'].includes(process.env.MULTI_MODEL_MOO_AUTO),
  };
}

function formatMs(ms) {
  return `${Math.round(ms)}ms`;
}

function main() {
  try {
    const status = providerStatus();
    console.log('Configured providers:');
    for (const p of status.providers) {
      const flags = [
        p.reviewFanout ? '' : 'reviewFanout=manual',
        p.configCheck ? '' : 'configCheck=manual',
      ].filter(Boolean);
      const flagText = flags.length > 0 ? ` ${flags.join(' ')}` : '';
      const state = p.keyPresent ? 'OK' : (p.configured ? `OK (via fallback ${p.fallbackProvider})` : 'MISSING');
      console.log(`  ${p.name}: ${state} (key env: ${p.apiKeyEnv}) model=${p.model} baseUrl=${p.baseUrl} maxInput=${p.maxInputChars} chars timeout=${p.timeoutMs}ms retries=${p.retries}${flagText}`);
    }
    console.log('\nRoles:');
    for (const [role, provider] of Object.entries(status.roles)) {
      console.log(`  ${role}: ${Array.isArray(provider) ? provider.join(', ') : provider}`);
    }
    if (Object.keys(status.benchmarkPresets).length > 0) {
      console.log('\nBenchmark presets:');
      for (const [preset, providers] of Object.entries(status.benchmarkPresets)) {
        console.log(`  ${preset}: ${providers.join(', ')}`);
      }
    }
    console.log(`\nmoo auto-assist: ${status.mooAutoAssist
      ? 'enabled'
      : 'disabled (set MULTI_MODEL_MOO_AUTO=1 in .secrets/multi-model.env to let /moo use assists by default)'}`);
    if (status.usage) {
      console.log(`\nUsage so far (${status.usage.logFile}):`);
      for (const [name, u] of Object.entries(status.usage.byProvider)) {
        const unknown = u.unknownCostCalls ? ` (+${u.unknownCostCalls} calls of unknown cost)` : '';
        const cached = u.cachedPromptTokens ? `, ${u.cachedPromptTokens} cached in` : '';
        const apiEquivalent = u.apiEquivalentCostUsd ? `, API-equiv ~$${u.apiEquivalentCostUsd.toFixed(4)}` : '';
        console.log(`  ${name}: ${u.calls} calls, ${u.promptTokens} in / ${u.completionTokens} out tokens${cached}, ~$${u.estCostUsd.toFixed(4)} spent${apiEquivalent}${unknown}`);
      }
      const t = status.usage.totals;
      const unknownTotal = t.unknownCostCalls ? ` (+${t.unknownCostCalls} calls of unknown cost)` : '';
      const apiEquivalent = t.apiEquivalentCostUsd ? `, API-equiv ~$${t.apiEquivalentCostUsd.toFixed(4)}` : '';
      console.log(`  total: ${t.calls} calls, ~$${t.estCostUsd.toFixed(4)} spent on multi-model providers${apiEquivalent}${unknownTotal}`);
    }
    if (status.calls) {
      console.log(`\nProvider call reliability (${status.calls.logFile}):`);
      for (const [name, c] of Object.entries(status.calls.byProvider)) {
        const avgLatencyMs = c.calls > 0 ? c.totalLatencyMs / c.calls : 0;
        const notes = [
          c.timeoutFailures ? `${c.timeoutFailures} timeout` : '',
          c.quotaFailures ? `${c.quotaFailures} quota` : '',
          c.promptTooLongFailures ? `${c.promptTooLongFailures} prompt-too-long` : '',
          c.nonStopFinishes ? `${c.nonStopFinishes} non-stop finish` : '',
        ].filter(Boolean);
        const note = notes.length > 0 ? ` (${notes.join(', ')})` : '';
        console.log(`  ${name}: ${c.calls} calls, ${c.successes} ok / ${c.failures} failed${note}, ${c.attempts} attempts, avg ${formatMs(avgLatencyMs)}, max ${formatMs(c.maxLatencyMs)}`);
      }
      const t = status.calls.totals;
      const avgLatencyMs = t.calls > 0 ? t.totalLatencyMs / t.calls : 0;
      const notes = [
        t.timeoutFailures ? `${t.timeoutFailures} timeout` : '',
        t.quotaFailures ? `${t.quotaFailures} quota` : '',
        t.promptTooLongFailures ? `${t.promptTooLongFailures} prompt-too-long` : '',
        t.nonStopFinishes ? `${t.nonStopFinishes} non-stop finish` : '',
      ].filter(Boolean);
      const note = notes.length > 0 ? ` (${notes.join(', ')})` : '';
      console.log(`  total: ${t.calls} calls, ${t.successes} ok / ${t.failures} failed${note}, ${t.attempts} attempts, avg ${formatMs(avgLatencyMs)}, max ${formatMs(t.maxLatencyMs)}`);
    }
  } catch (err) {
    console.error(`multi-model provider-status failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
