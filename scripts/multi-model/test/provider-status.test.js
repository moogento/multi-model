import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerStatus } from '../provider-status.js';

process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';
process.env.MULTI_MODEL_CALL_LOG = 'off';
delete process.env.OPENROUTER_API_KEY;

// moo.md's Stage 0 auto-detect greps the CLI output for this exact substring; a wording
// change (e.g. a verbatim re-sync from replyrabbit, which prints "rr auto-assist") must fail here.
test('provider-status CLI prints the auto-assist line moo.md auto-detect greps for', () => {
  const script = fileURLToPath(new URL('../provider-status.js', import.meta.url));
  const out = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, MULTI_MODEL_MOO_AUTO: '1', MULTI_MODEL_USAGE_LOG: 'off', MULTI_MODEL_CALL_LOG: 'off' },
  });
  assert.match(out, /^moo auto-assist: enabled$/m);
});

test('providerStatus reports configured booleans and never exposes the key value', () => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GLM_API_KEY;
  const status = providerStatus();
  const deepseek = status.providers.find((p) => p.name === 'deepseek');
  const glm = status.providers.find((p) => p.name === 'glm');
  assert.equal(deepseek.configured, false);
  assert.equal(deepseek.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(glm.maxInputChars, 600000);
  assert.equal('apiKey' in deepseek, false);
  assert.ok(status.roles.implementation);
});

test('providerStatus aggregates usage.jsonl into per-provider totals and estimated cost', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-status-usage-'));
  const logFile = path.join(dir, 'usage.jsonl');
  writeFileSync(logFile, [
    JSON.stringify({ ts: '2026-07-02T00:00:00Z', provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 1000, completionTokens: 500, estCostUsd: 0.00028 }),
    JSON.stringify({ ts: '2026-07-02T00:01:00Z', provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 2000, completionTokens: 1000, estCostUsd: 0.00056 }),
    JSON.stringify({ ts: '2026-07-02T00:02:00Z', provider: 'glm', model: 'glm-5.2', promptTokens: 100, completionTokens: 50, cachedPromptTokens: 20, totalTokens: 150, estCostUsd: null, apiEquivalentCostUsd: 0.00036 }),
    'not json - must be skipped, not fatal',
  ].join('\n') + '\n', 'utf8');

  try {
    const status = providerStatus({ usageLogFile: logFile });
    assert.equal(status.usage.byProvider.deepseek.calls, 2);
    assert.equal(status.usage.byProvider.deepseek.promptTokens, 3000);
    assert.equal(status.usage.byProvider.deepseek.completionTokens, 1500);
    assert.ok(Math.abs(status.usage.byProvider.deepseek.estCostUsd - 0.00084) < 1e-9);
    assert.equal(status.usage.byProvider.glm.calls, 1);
    assert.equal(status.usage.byProvider.glm.cachedPromptTokens, 20);
    assert.equal(status.usage.byProvider.glm.totalTokens, 150);
    assert.ok(Math.abs(status.usage.byProvider.glm.apiEquivalentCostUsd - 0.00036) < 1e-9);
    assert.equal(status.usage.totals.calls, 3);
    assert.ok(Math.abs(status.usage.totals.estCostUsd - 0.00084) < 1e-9);
    assert.ok(Math.abs(status.usage.totals.apiEquivalentCostUsd - 0.00036) < 1e-9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('providerStatus reports usage as null when no log exists', () => {
  const status = providerStatus({ usageLogFile: '/nonexistent/mm-usage/usage.jsonl' });
  assert.equal(status.usage, null);
});

test('providerStatus reads the log path from MULTI_MODEL_USAGE_LOG when no argument is given', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-status-env-'));
  const logFile = path.join(dir, 'usage.jsonl');
  writeFileSync(logFile, JSON.stringify({ ts: 't', provider: 'deepseek', model: 'm', promptTokens: 10, completionTokens: 5, estCostUsd: 0.001 }) + '\n', 'utf8');
  const savedEnv = process.env.MULTI_MODEL_USAGE_LOG;
  process.env.MULTI_MODEL_USAGE_LOG = logFile;
  try {
    const status = providerStatus();
    assert.equal(status.usage.byProvider.deepseek.calls, 1);
  } finally {
    process.env.MULTI_MODEL_USAGE_LOG = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('providerStatus counts unknown-cost calls separately instead of folding them into $0', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-status-unknown-'));
  const logFile = path.join(dir, 'usage.jsonl');
  writeFileSync(logFile, [
    JSON.stringify({ ts: 't1', provider: 'openai', model: 'gpt-test', promptTokens: null, completionTokens: null, estCostUsd: null }),
    JSON.stringify({ ts: 't2', provider: 'openai', model: 'gpt-test', promptTokens: 100, completionTokens: 50, estCostUsd: 0.002 }),
    JSON.stringify({}),
  ].join('\n') + '\n', 'utf8');
  try {
    const status = providerStatus({ usageLogFile: logFile });
    assert.equal(status.usage.byProvider.openai.calls, 2);
    assert.equal(status.usage.byProvider.openai.unknownCostCalls, 1);
    assert.ok(Math.abs(status.usage.byProvider.openai.estCostUsd - 0.002) < 1e-9);
    assert.equal(status.usage.totals.calls, 2);
    assert.equal(status.usage.totals.unknownCostCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('providerStatus reports usage as null for an empty log file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-status-empty-'));
  const logFile = path.join(dir, 'usage.jsonl');
  writeFileSync(logFile, '', 'utf8');
  try {
    const status = providerStatus({ usageLogFile: logFile });
    assert.equal(status.usage, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('providerStatus aggregates calls.jsonl into reliability totals', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-status-calls-'));
  const callLogFile = path.join(dir, 'calls.jsonl');
  writeFileSync(callLogFile, [
    JSON.stringify({ ts: '2026-07-02T00:00:00Z', provider: 'glm', model: 'glm-5.2', ok: true, outcome: 'success', finishReason: 'length', attempts: 1, latencyMs: 21000 }),
    JSON.stringify({ ts: '2026-07-02T00:01:00Z', provider: 'glm', model: 'glm-5.2', ok: false, outcome: 'failed', failureCategory: 'timeout', attempts: 1, latencyMs: 120000 }),
    JSON.stringify({ ts: '2026-07-02T00:02:00Z', provider: 'deepseek', model: 'deepseek-v4-flash', ok: false, outcome: 'failed', failureCategory: 'server-error', attempts: 2, latencyMs: 2500 }),
    JSON.stringify({ ts: '2026-07-02T00:03:00Z', provider: 'glm', model: 'glm-5.2', ok: false, outcome: 'failed', failureCategory: 'quota-exhausted', providerErrorCode: '1316', attempts: 1, latencyMs: 500 }),
    JSON.stringify({ ts: '2026-07-02T00:04:00Z', provider: 'glm', model: 'glm-5.2', ok: false, outcome: 'failed', failureCategory: 'prompt-too-long', providerErrorCode: '1261', attempts: 1, latencyMs: 400 }),
    'not json - must be skipped, not fatal',
  ].join('\n') + '\n', 'utf8');

  try {
    const status = providerStatus({ callLogFile });
    assert.equal(status.calls.byProvider.glm.calls, 4);
    assert.equal(status.calls.byProvider.glm.successes, 1);
    assert.equal(status.calls.byProvider.glm.failures, 3);
    assert.equal(status.calls.byProvider.glm.timeoutFailures, 1);
    assert.equal(status.calls.byProvider.glm.quotaFailures, 1);
    assert.equal(status.calls.byProvider.glm.promptTooLongFailures, 1);
    assert.equal(status.calls.byProvider.glm.nonStopFinishes, 1);
    assert.equal(status.calls.byProvider.glm.attempts, 4);
    assert.equal(status.calls.byProvider.glm.maxLatencyMs, 120000);
    assert.equal(status.calls.byProvider.deepseek.failures, 1);
    assert.equal(status.calls.totals.calls, 5);
    assert.equal(status.calls.totals.failures, 4);
    assert.equal(status.calls.totals.timeoutFailures, 1);
    assert.equal(status.calls.totals.quotaFailures, 1);
    assert.equal(status.calls.totals.promptTooLongFailures, 1);
    assert.equal(status.calls.totals.nonStopFinishes, 1);
    assert.equal(status.calls.totals.attempts, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('providerStatus reports calls as null when no call log exists', () => {
  const status = providerStatus({ callLogFile: '/nonexistent/mm-calls/calls.jsonl' });
  assert.equal(status.calls, null);
});

test('providerStatus reports moo auto-assist consent from MULTI_MODEL_MOO_AUTO', () => {
  const savedEnv = process.env.MULTI_MODEL_MOO_AUTO;
  try {
    delete process.env.MULTI_MODEL_MOO_AUTO;
    assert.equal(providerStatus().mooAutoAssist, false);
    process.env.MULTI_MODEL_MOO_AUTO = '1';
    assert.equal(providerStatus().mooAutoAssist, true);
    process.env.MULTI_MODEL_MOO_AUTO = 'true';
    assert.equal(providerStatus().mooAutoAssist, true);
    process.env.MULTI_MODEL_MOO_AUTO = '0';
    assert.equal(providerStatus().mooAutoAssist, false);
  } finally {
    if (savedEnv === undefined) delete process.env.MULTI_MODEL_MOO_AUTO;
    else process.env.MULTI_MODEL_MOO_AUTO = savedEnv;
  }
});

test('providerStatus degrades to usage null when the log path is unreadable', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-status-unreadable-'));
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const status = providerStatus({ usageLogFile: dir });
    assert.equal(status.usage, null);
  } finally {
    console.error = originalConsoleError;
    rmSync(dir, { recursive: true, force: true });
  }
});
