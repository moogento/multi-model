import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregateOutcomes } from '../outcome-stats.js';

function writeJsonl(filePath, records) {
  writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

test('aggregateOutcomes computes keep rate and effective cost per kept output, grouped by provider', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-stats-'));
  const outcomeFile = path.join(dir, 'outcomes.jsonl');
  const usageFile = path.join(dir, 'usage.jsonl');
  try {
    writeJsonl(outcomeFile, [
      { ts: '2026-07-01T00:00:00Z', repo: 'm2-moo', command: 'mm-implement', provider: 'deepseek', model: 'deepseek-v4-flash', outcome: 'kept', reasonCategory: 'applied-clean' },
      { ts: '2026-07-01T00:01:00Z', repo: 'm2-moo', command: 'mm-implement', provider: 'deepseek', model: 'deepseek-v4-flash', outcome: 'kept', reasonCategory: 'applied-clean' },
      { ts: '2026-07-01T00:02:00Z', repo: 'm2-moo', command: 'mm-consensus', provider: 'glm', model: 'glm-5.2', outcome: 'dropped', reasonCategory: 'not-selected' },
      { ts: '2026-07-01T00:03:00Z', repo: 'm2-moo', command: 'mm-consensus', provider: 'glm', model: 'glm-5.2', outcome: 'dropped', reasonCategory: 'not-selected' },
      { ts: '2026-07-01T00:04:00Z', repo: 'm2-moo', command: 'mm-review', provider: 'glm', model: 'glm-5.2', outcome: 'kept' },
    ]);
    writeJsonl(usageFile, [
      { ts: '2026-07-01T00:00:00Z', provider: 'deepseek', model: 'deepseek-v4-flash', estCostUsd: 0.001 },
      { ts: '2026-07-01T00:01:00Z', provider: 'deepseek', model: 'deepseek-v4-flash', estCostUsd: 0.002 },
      { ts: '2026-07-01T00:02:00Z', provider: 'glm', model: 'glm-5.2', estCostUsd: 0.01 },
      { ts: '2026-07-01T00:03:00Z', provider: 'glm', model: 'glm-5.2', estCostUsd: 0.01 },
      { ts: '2026-07-01T00:04:00Z', provider: 'glm', model: 'glm-5.2', estCostUsd: 0.01 },
    ]);

    const rows = aggregateOutcomes({ outcomeFiles: [outcomeFile], usageFiles: [usageFile] });
    const deepseek = rows.find((r) => r.provider === 'deepseek');
    const glm = rows.find((r) => r.provider === 'glm');

    assert.equal(deepseek.runs, 2);
    assert.equal(deepseek.kept, 2);
    assert.equal(deepseek.keepRate, 1);
    assert.ok(Math.abs(deepseek.totalCostUsd - 0.003) < 1e-9);
    assert.ok(Math.abs(deepseek.effCostPerKeptUsd - 0.0015) < 1e-9);

    assert.equal(glm.runs, 3);
    assert.equal(glm.kept, 1);
    assert.equal(glm.dropped, 2);
    assert.ok(Math.abs(glm.keepRate - (1 / 3)) < 1e-9);
    assert.ok(Math.abs(glm.totalCostUsd - 0.03) < 1e-9);
    assert.ok(Math.abs(glm.effCostPerKeptUsd - 0.03) < 1e-9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateOutcomes groups by provider+command when byCommand is set', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-stats-cmd-'));
  const outcomeFile = path.join(dir, 'outcomes.jsonl');
  try {
    writeJsonl(outcomeFile, [
      { ts: '2026-07-01T00:00:00Z', repo: 'm2-moo', command: 'mm-implement', provider: 'deepseek', outcome: 'kept' },
      { ts: '2026-07-01T00:01:00Z', repo: 'm2-moo', command: 'moo-stage3-implement', provider: 'deepseek', outcome: 'dropped', reasonCategory: 'wrong-approach' },
    ]);
    const rows = aggregateOutcomes({ outcomeFiles: [outcomeFile], usageFiles: [], byCommand: true });
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.command === 'mm-implement' && r.runs === 1));
    assert.ok(rows.some((r) => r.command === 'moo-stage3-implement' && r.runs === 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateOutcomes nulls out cost columns under byCommand since usage.jsonl cannot attribute cost to a command', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-stats-cmd-cost-'));
  const outcomeFile = path.join(dir, 'outcomes.jsonl');
  const usageFile = path.join(dir, 'usage.jsonl');
  try {
    writeJsonl(outcomeFile, [
      { ts: '2026-07-01T00:00:00Z', repo: 'm2-moo', command: 'mm-implement', provider: 'deepseek', outcome: 'kept' },
      { ts: '2026-07-01T00:01:00Z', repo: 'm2-moo', command: 'mm-implement', provider: 'deepseek', outcome: 'kept' },
      { ts: '2026-07-01T00:02:00Z', repo: 'm2-moo', command: 'mm-review', provider: 'deepseek', outcome: 'dropped', reasonCategory: 'not-selected' },
    ]);
    writeJsonl(usageFile, [
      { ts: '2026-07-01T00:00:00Z', provider: 'deepseek', model: 'deepseek-v4-flash', estCostUsd: 0.001 },
      { ts: '2026-07-01T00:01:00Z', provider: 'deepseek', model: 'deepseek-v4-flash', estCostUsd: 0.002 },
      { ts: '2026-07-01T00:02:00Z', provider: 'deepseek', model: 'deepseek-v4-flash', estCostUsd: 0.003 },
    ]);

    const byCommandRows = aggregateOutcomes({ outcomeFiles: [outcomeFile], usageFiles: [usageFile], byCommand: true });
    assert.equal(byCommandRows.length, 2);
    const implementRow = byCommandRows.find((r) => r.command === 'mm-implement');
    const reviewRow = byCommandRows.find((r) => r.command === 'mm-review');

    assert.equal(implementRow.runs, 2);
    assert.equal(implementRow.kept, 2);
    assert.equal(implementRow.keepRate, 1);
    assert.equal(implementRow.totalCostUsd, null);
    assert.equal(implementRow.avgCostPerCallUsd, null);
    assert.equal(implementRow.effCostPerKeptUsd, null);

    assert.equal(reviewRow.runs, 1);
    assert.equal(reviewRow.dropped, 1);
    assert.equal(reviewRow.keepRate, 0);
    assert.equal(reviewRow.totalCostUsd, null);
    assert.equal(reviewRow.avgCostPerCallUsd, null);
    assert.equal(reviewRow.effCostPerKeptUsd, null);

    const plainRows = aggregateOutcomes({ outcomeFiles: [outcomeFile], usageFiles: [usageFile] });
    const deepseek = plainRows.find((r) => r.provider === 'deepseek');
    assert.equal(deepseek.runs, 3);
    assert.ok(Math.abs(deepseek.totalCostUsd - 0.006) < 1e-9);
    assert.ok(deepseek.avgCostPerCallUsd != null && Math.abs(deepseek.avgCostPerCallUsd - 0.002) < 1e-9);
    assert.ok(deepseek.effCostPerKeptUsd != null && Math.abs(deepseek.effCostPerKeptUsd - 0.003) < 1e-9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateOutcomes filters by a --since window', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-stats-since-'));
  const outcomeFile = path.join(dir, 'outcomes.jsonl');
  try {
    const now = Date.parse('2026-07-03T12:00:00Z');
    writeJsonl(outcomeFile, [
      { ts: '2026-07-03T11:00:00Z', repo: 'm2-moo', command: 'mm-implement', provider: 'deepseek', outcome: 'kept' },
      { ts: '2026-06-01T00:00:00Z', repo: 'm2-moo', command: 'mm-implement', provider: 'deepseek', outcome: 'kept' },
    ]);
    const rows = aggregateOutcomes({ outcomeFiles: [outcomeFile], usageFiles: [], since: '1d', now });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runs, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateOutcomes tallies reasonCounts for dropped/partial records only', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-stats-reasons-'));
  const outcomeFile = path.join(dir, 'outcomes.jsonl');
  try {
    writeJsonl(outcomeFile, [
      { ts: '2026-07-01T00:00:00Z', repo: 'm2-moo', command: 'mm-review', provider: 'glm', outcome: 'dropped', reasonCategory: 'not-selected' },
      { ts: '2026-07-01T00:01:00Z', repo: 'm2-moo', command: 'mm-review', provider: 'glm', outcome: 'dropped', reasonCategory: 'not-selected' },
      { ts: '2026-07-01T00:02:00Z', repo: 'm2-moo', command: 'mm-review', provider: 'glm', outcome: 'dropped', reasonCategory: 'wrong-approach' },
      { ts: '2026-07-01T00:03:00Z', repo: 'm2-moo', command: 'mm-review', provider: 'glm', outcome: 'kept' },
    ]);
    const rows = aggregateOutcomes({ outcomeFiles: [outcomeFile], usageFiles: [] });
    const glm = rows.find((r) => r.provider === 'glm');
    assert.equal(glm.reasonCounts['not-selected'], 2);
    assert.equal(glm.reasonCounts['wrong-approach'], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateOutcomes returns an empty array when no outcome files exist', () => {
  const rows = aggregateOutcomes({ outcomeFiles: ['/nonexistent/outcomes.jsonl'], usageFiles: [] });
  assert.deepEqual(rows, []);
});

test('aggregateOutcomes rejects a malformed --since value', () => {
  assert.throws(
    () => aggregateOutcomes({ outcomeFiles: [], usageFiles: [], since: '3weeks' }),
    /--since must look like/
  );
});

test('aggregateOutcomes counts a null estCostUsd as unknown cost, never folding it into $0', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-stats-unknown-'));
  const outcomeFile = path.join(dir, 'outcomes.jsonl');
  const usageFile = path.join(dir, 'usage.jsonl');
  try {
    writeJsonl(outcomeFile, [
      { ts: '2026-07-01T00:00:00Z', repo: 'm2-moo', command: 'mm-implement', provider: 'deepseek', outcome: 'kept' },
      { ts: '2026-07-01T00:01:00Z', repo: 'm2-moo', command: 'mm-implement', provider: 'deepseek', outcome: 'kept' },
    ]);
    writeJsonl(usageFile, [
      { ts: '2026-07-01T00:00:00Z', provider: 'deepseek', model: 'deepseek-v4-flash', estCostUsd: 0.01 },
      { ts: '2026-07-01T00:01:00Z', provider: 'deepseek', model: 'custom-override', estCostUsd: null },
    ]);
    const rows = aggregateOutcomes({ outcomeFiles: [outcomeFile], usageFiles: [usageFile] });
    const deepseek = rows.find((r) => r.provider === 'deepseek');
    assert.equal(deepseek.unknownCostCalls, 1);
    assert.ok(Math.abs(deepseek.totalCostUsd - 0.01) < 1e-9, 'total must not fold the null call in as $0');
    assert.ok(Math.abs(deepseek.avgCostPerCallUsd - 0.01) < 1e-9, 'average must divide by priced calls only, not all calls');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateOutcomes includes provider call failure and latency telemetry', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-stats-calls-'));
  const outcomeFile = path.join(dir, 'outcomes.jsonl');
  const usageFile = path.join(dir, 'usage.jsonl');
  const callFile = path.join(dir, 'calls.jsonl');
  try {
    writeJsonl(outcomeFile, [
      { ts: '2026-07-01T00:00:00Z', repo: 'm2-moo', command: 'mm-review', provider: 'glm', outcome: 'kept' },
    ]);
    writeJsonl(usageFile, [
      { ts: '2026-07-01T00:00:00Z', provider: 'glm', model: 'glm-5.2', estCostUsd: 0.01 },
    ]);
    writeJsonl(callFile, [
      { ts: '2026-07-01T00:00:00Z', provider: 'glm', model: 'glm-5.2', ok: true, outcome: 'success', finishReason: 'length', attempts: 1, latencyMs: 21000 },
      { ts: '2026-07-01T00:01:00Z', provider: 'glm', model: 'glm-5.2', ok: false, outcome: 'failed', failureCategory: 'timeout', attempts: 1, latencyMs: 120000 },
      { ts: '2026-07-01T00:02:00Z', provider: 'glm', model: 'glm-5.2', ok: false, outcome: 'failed', failureCategory: 'server-error', attempts: 2, latencyMs: 1000 },
      { ts: '2026-07-01T00:03:00Z', provider: 'glm', model: 'glm-5.2', ok: false, outcome: 'failed', failureCategory: 'quota-exhausted', providerErrorCode: '1316', attempts: 1, latencyMs: 500 },
      { ts: '2026-07-01T00:04:00Z', provider: 'glm', model: 'glm-5.2', ok: false, outcome: 'failed', failureCategory: 'prompt-too-long', providerErrorCode: '1261', attempts: 1, latencyMs: 250 },
    ]);

    const rows = aggregateOutcomes({ outcomeFiles: [outcomeFile], usageFiles: [usageFile], callFiles: [callFile] });
    const glm = rows.find((r) => r.provider === 'glm');
    assert.equal(glm.providerCalls, 5);
    assert.equal(glm.providerFailures, 4);
    assert.equal(glm.timeoutFailures, 1);
    assert.equal(glm.quotaFailures, 1);
    assert.equal(glm.promptTooLongFailures, 1);
    assert.equal(glm.nonStopFinishes, 1);
    assert.equal(glm.providerAttempts, 6);
    assert.ok(Math.abs(glm.callFailureRate - (4 / 5)) < 1e-9);
    assert.ok(Math.abs(glm.avgLatencyMs - (142750 / 5)) < 1e-9);
    assert.equal(glm.maxLatencyMs, 120000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateOutcomes returns provider rows for call telemetry even before outcomes exist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-stats-calls-only-'));
  const callFile = path.join(dir, 'calls.jsonl');
  try {
    writeJsonl(callFile, [
      { ts: '2026-07-01T00:00:00Z', provider: 'glm', model: 'glm-5.2', ok: false, outcome: 'failed', failureCategory: 'timeout', attempts: 1, latencyMs: 120000 },
    ]);

    const rows = aggregateOutcomes({ outcomeFiles: [], usageFiles: [], callFiles: [callFile] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, 'glm');
    assert.equal(rows[0].runs, 0);
    assert.equal(rows[0].keepRate, null);
    assert.equal(rows[0].providerCalls, 1);
    assert.equal(rows[0].providerFailures, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregateOutcomes counts offline calls separately and leaves them out of the failure rate', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-stats-offline-'));
  const callFile = path.join(dir, 'calls.jsonl');
  try {
    writeJsonl(callFile, [
      { ts: '2026-09-01T00:00:00Z', provider: 'deepseek-openrouter', ok: true, outcome: 'success', latencyMs: 100 },
      { ts: '2026-09-01T00:01:00Z', provider: 'deepseek-openrouter', ok: false, outcome: 'failed', failureCategory: 'offline', latencyMs: 5 },
      { ts: '2026-09-01T00:02:00Z', provider: 'deepseek-openrouter', ok: false, outcome: 'failed', failureCategory: 'network-error', error: 'deepseek-openrouter request failed: fetch failed (ENOTFOUND)', latencyMs: 5 },
      { ts: '2026-09-01T00:03:00Z', provider: 'deepseek-openrouter', ok: false, outcome: 'failed', failureCategory: 'network-error', error: 'deepseek-openrouter request failed: fetch failed (ECONNRESET)', latencyMs: 5 },
    ]);
    const rows = aggregateOutcomes({ outcomeFiles: [], usageFiles: [], callFiles: [callFile] });
    const row = rows.find((r) => r.provider === 'deepseek-openrouter');
    assert.equal(row.providerCalls, 4);
    assert.equal(row.providerFailures, 3);
    assert.equal(row.offlineFailures, 2);
    assert.ok(Math.abs(row.callFailureRate - 0.5) < 1e-9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
