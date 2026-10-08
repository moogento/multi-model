import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendOutcome, configuredModel, OUTCOMES, REASON_CATEGORIES } from '../log-outcome.js';

function readLines(filePath) {
  return readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('appendOutcome rejects an unknown outcome value', () => {
  assert.throws(
    () => appendOutcome({ command: 'mm-implement', provider: 'deepseek', outcome: 'maybe' }),
    /outcome must be one of/
  );
});

test('appendOutcome requires reasonCategory when outcome is dropped', () => {
  assert.throws(
    () => appendOutcome({ command: 'mm-implement', provider: 'deepseek', outcome: 'dropped' }),
    /reasonCategory is required/
  );
});

test('appendOutcome requires reasonCategory when outcome is partial', () => {
  assert.throws(
    () => appendOutcome({ command: 'mm-review', provider: 'glm', outcome: 'partial' }),
    /reasonCategory is required/
  );
});

test('appendOutcome does not require reasonCategory when outcome is kept or kept-edited', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-outcome-'));
  const logFile = path.join(dir, 'outcomes.jsonl');
  try {
    assert.doesNotThrow(() => appendOutcome(
      { command: 'mm-plan', provider: 'deepseek', outcome: 'kept' },
      { outcomeLogFile: logFile, repo: 'm2-moo' }
    ));
    assert.doesNotThrow(() => appendOutcome(
      { command: 'mm-plan', provider: 'deepseek', outcome: 'kept-edited' },
      { outcomeLogFile: logFile, repo: 'm2-moo' }
    ));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendOutcome rejects an unknown reasonCategory', () => {
  assert.throws(
    () => appendOutcome({ command: 'mm-review', provider: 'glm', outcome: 'dropped', reasonCategory: 'because' }),
    /reasonCategory must be one of/
  );
});

test('appendOutcome requires command and provider', () => {
  assert.throws(() => appendOutcome({ provider: 'deepseek', outcome: 'kept' }), /command is required/);
  assert.throws(() => appendOutcome({ command: 'mm-plan', outcome: 'kept' }), /provider is required/);
});

test('appendOutcome writes a complete JSONL record with an explicit repo and log file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-outcome-'));
  const logFile = path.join(dir, 'outcomes.jsonl');
  try {
    const record = appendOutcome(
      { command: 'mm-consensus', provider: 'glm', model: 'glm-5.2', outcome: 'dropped', reasonCategory: 'not-selected', reason: 'too broad' },
      { outcomeLogFile: logFile, repo: 'm2-moo' }
    );
    assert.ok(record);
    const lines = readLines(logFile);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].repo, 'm2-moo');
    assert.equal(lines[0].command, 'mm-consensus');
    assert.equal(lines[0].provider, 'glm');
    assert.equal(lines[0].model, 'glm-5.2');
    assert.equal(lines[0].outcome, 'dropped');
    assert.equal(lines[0].reasonCategory, 'not-selected');
    assert.equal(lines[0].reason, 'too broad');
    assert.ok(lines[0].ts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendOutcome defaults model, reasonCategory, and reason to null when omitted', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-outcome-'));
  const logFile = path.join(dir, 'outcomes.jsonl');
  try {
    appendOutcome({ command: 'mm-plan', provider: 'deepseek', outcome: 'kept' }, { outcomeLogFile: logFile, repo: 'm2-moo' });
    const lines = readLines(logFile);
    assert.equal(lines[0].model, null);
    assert.equal(lines[0].reasonCategory, null);
    assert.equal(lines[0].reason, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendOutcome returns null and writes nothing when logging is disabled', () => {
  const record = appendOutcome(
    { command: 'mm-plan', provider: 'deepseek', outcome: 'kept' },
    { outcomeLogFile: false }
  );
  assert.equal(record, null);
});

test('OUTCOMES and REASON_CATEGORIES are non-empty exported enums', () => {
  assert.ok(OUTCOMES.includes('kept'));
  assert.ok(OUTCOMES.includes('kept-edited'));
  assert.ok(OUTCOMES.includes('partial'));
  assert.ok(OUTCOMES.includes('dropped'));
  assert.ok(REASON_CATEGORIES.includes('user-declined'));
  assert.ok(REASON_CATEGORIES.includes('not-selected'));
});

test('CLI exits non-zero and lists valid outcomes on an invalid --outcome', () => {
  const script = fileURLToPath(new URL('../log-outcome.js', import.meta.url));
  assert.throws(() => {
    execFileSync(process.execPath, [script, '--command', 'mm-plan', '--provider', 'deepseek', '--outcome', 'nope'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }, (err) => {
    assert.match(err.stderr, /outcome must be one of/);
    return true;
  });
});

test('CLI writes an outcome record end to end via MULTI_MODEL_OUTCOME_LOG', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-outcome-cli-'));
  const logFile = path.join(dir, 'outcomes.jsonl');
  const script = fileURLToPath(new URL('../log-outcome.js', import.meta.url));
  try {
    const out = execFileSync(process.execPath, [
      script, '--command', 'mm-implement', '--provider', 'deepseek', '--outcome', 'kept',
    ], {
      encoding: 'utf8',
      env: { ...process.env, MULTI_MODEL_OUTCOME_LOG: logFile },
    });
    assert.match(out, /Logged outcome: mm-implement \/ deepseek -> kept/);
    const lines = readLines(logFile);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].provider, 'deepseek');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('configuredModel returns the model the provider is configured to call', () => {
  const load = () => ({ providers: { 'deepseek-flash': { model: 'deepseek-flash' } } });
  assert.equal(configuredModel('deepseek-flash', load), 'deepseek-flash');
  assert.equal(configuredModel('unknown', load), null);
  assert.equal(configuredModel('deepseek-flash', () => { throw new Error('bad config'); }), null);
});
