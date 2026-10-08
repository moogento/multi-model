import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { chunkFilePaths, consensusReview, currentGitDiff, fileContextForChunk, splitDiffForReview, summarizeReviewResults } from '../consensus-review.js';
import { buildReviewMessages } from '../prompt-builder.js';

process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';
delete process.env.OPENROUTER_API_KEY;

test('consensusReview queries every configured provider and parses JSON reviews', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const fakeCall = async (cfg, providerName) => ({
    provider: providerName,
    model: 'fake-model',
    content: JSON.stringify({ issues: [{ file: 'x.js', line: 3, summary: 'off by one', severity: 'MEDIUM' }], risks: [], missing: [] }),
  });

  const { results } = await consensusReview({ task: 'review this', diffText: 'diff --git a/x b/x\n' }, { config, callChatCompletion: fakeCall });
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.review.issues[0].summary, 'off by one');
  }
});

test('consensusReview carries one run ID and phase through every provider call', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const optionsSeen = [];
  const fakeCall = async (cfg, providerName, messages, options) => {
    optionsSeen.push({ providerName, options });
    return {
      provider: providerName,
      model: 'fake-model',
      content: JSON.stringify({ issues: [], risks: [], missing: [] }),
    };
  };

  const { runId, results } = await consensusReview(
    { task: 't', diffText: 'diff --git a/x b/x\n', runId: 'review-explicit-1' },
    { config, callChatCompletion: fakeCall },
  );

  assert.equal(runId, 'review-explicit-1');
  assert.equal(results.length, 2);
  assert.equal(optionsSeen.length, 2);
  for (const { options } of optionsSeen) {
    assert.equal(options.profile, 'review');
    assert.equal(options.command, 'consensus-review');
    assert.equal(options.runId, 'review-explicit-1');
    assert.equal(options.phase, 'review');
  }
});

test('consensusReview fans out to providers concurrently, not one after another', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  let inFlight = 0;
  let maxInFlight = 0;
  const fakeCall = async (cfg, providerName) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return {
      provider: providerName,
      model: 'fake-model',
      content: JSON.stringify({ issues: [], risks: [], missing: [] }),
    };
  };

  const { results } = await consensusReview(
    { task: 't', diffText: 'diff --git a/x b/x\n', selfVerify: false },
    { config, callChatCompletion: fakeCall }
  );
  assert.equal(results.length, 2);
  assert.equal(maxInFlight, 2, 'expected both providers in flight at once (parallel fan-out)');
});

test('consensusReview excludes a fully-configured deepseek-pro from the default fan-out', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = 'k1';
  config.providers['deepseek-pro'].apiKey = 'k-pro';
  config.providers.glm.apiKey = 'k2';
  const fakeCall = async (cfg, providerName) => ({
    provider: providerName,
    model: 'fake-model',
    content: JSON.stringify({ issues: [], risks: [], missing: [] }),
  });

  const { results } = await consensusReview({ task: 't', diffText: 'diff --git a/x b/x\n' }, { config, callChatCompletion: fakeCall });
  const names = results.map((r) => r.provider).sort();
  assert.deepEqual(names, ['deepseek', 'glm'],
    'deepseek-pro has a real key but is role-bound to implementation, not the review fan-out');
});

test('consensusReview still queries deepseek-pro when explicitly requested via --providers', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = 'k-pro';
  const fakeCall = async (cfg, providerName) => ({
    provider: providerName,
    model: 'fake-model',
    content: JSON.stringify({ issues: [], risks: [], missing: [] }),
  });

  const { results } = await consensusReview(
    { task: 't', diffText: 'diff --git a/x b/x\n', providers: ['deepseek-pro'] },
    { config, callChatCompletion: fakeCall },
  );
  assert.deepEqual(results.map((r) => r.provider), ['deepseek-pro']);
});

test('consensusReview falls back to raw text when a provider returns non-JSON', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = '';
  const fakeCall = async (cfg, providerName) => ({ provider: providerName, model: 'm', content: 'looks fine to me' });

  const { results } = await consensusReview({ task: 't', diffText: 'diff --git a/x b/x\n' }, { config, callChatCompletion: fakeCall });
  assert.equal(results.length, 1);
  assert.equal(results[0].review.raw, 'looks fine to me');
});

test('consensusReview keeps the successful result when a sibling provider call fails', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const fakeCall = async (cfg, providerName) => {
    if (providerName === 'glm') throw new Error('network timeout');
    return {
      provider: providerName,
      model: 'fake-model',
      content: JSON.stringify({ issues: [], risks: [], missing: [] }),
    };
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  let results;
  try {
    ({ results } = await consensusReview({ task: 't', diffText: 'diff --git a/x b/x\n' }, { config, callChatCompletion: fakeCall }));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(results.length, 2);
  const deepseekResult = results.find((r) => r.provider === 'deepseek');
  const glmResult = results.find((r) => r.provider === 'glm');
  assert.ok(deepseekResult.review, 'expected the successful provider result to still be present');
  assert.equal(glmResult.error, 'network timeout');
  assert.equal(glmResult.review, undefined);
});

test('consensusReview marks successful and failed reviews whose provider input was truncated', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const input = {
    inputChars: 175665,
    truncatedInputChars: 25665,
    maxInputChars: 150000,
    inputTruncated: true,
  };
  const fakeCall = async (cfg, providerName) => {
    if (providerName === 'glm') {
      const err = new Error('glm request failed: timed out');
      err.input = input;
      throw err;
    }
    return {
      provider: providerName,
      model: 'fake-model',
      input,
      content: JSON.stringify({ issues: [], risks: [], missing: [] }),
    };
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  let results;
  try {
    ({ results } = await consensusReview({ task: 't', diffText: 'diff --git a/x b/x\n' }, { config, callChatCompletion: fakeCall }));
  } finally {
    console.error = originalConsoleError;
  }

  const deepseekResult = results.find((r) => r.provider === 'deepseek');
  const glmResult = results.find((r) => r.provider === 'glm');
  assert.deepEqual(deepseekResult.input, input);
  assert.deepEqual(glmResult.input, input);
  assert.equal(glmResult.error, 'glm request failed: timed out');
});

function sampleDiff(file, bodyChars = 100) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    `-${'a'.repeat(bodyChars)}`,
    `+${'b'.repeat(bodyChars)}`,
    '',
  ].join('\n');
}

test('splitDiffForReview keeps small diffs in one review chunk', () => {
  const diffText = sampleDiff('small.js', 20);
  const chunks = splitDiffForReview(diffText, 1000, 'small review');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].diffText, diffText);
  assert.equal(chunks[0].index, 1);
  assert.equal(chunks[0].total, 1);
});

test('splitDiffForReview splits large diffs at file boundaries before provider truncation', () => {
  const task = 'review this change';
  const chunks = splitDiffForReview(`${sampleDiff('one.js')}${sampleDiff('two.js')}`, 420, task);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].diffText, /one\.js/);
  assert.match(chunks[1].diffText, /two\.js/);
  for (const chunk of chunks) {
    const userContent = buildReviewMessages(task, chunk.diffText)[1].content;
    assert.ok(userContent.length <= 420, `chunk ${chunk.index} is too large: ${userContent.length}`);
  }
});

test('splitDiffForReview slices a single oversized file diff instead of sending it for blind truncation', () => {
  const task = 'review one oversized file';
  const chunks = splitDiffForReview(sampleDiff('huge.js', 900), 420, task);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.oversized));
  assert.ok(chunks.every((chunk) => chunk.diffText.includes('oversized diff slice')));
  assert.ok(chunks.every((chunk) => chunk.filePath === 'huge.js'), 'every oversized slice should carry the file path, even slices past the first that lack a diff --git header');
  for (const chunk of chunks) {
    const userContent = buildReviewMessages(task, chunk.diffText)[1].content;
    assert.ok(userContent.length <= 420, `chunk ${chunk.index} is too large: ${userContent.length}`);
  }
});

test('consensusReview merges parsed review JSON across split chunks', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = '';
  config.providers.deepseek.maxInputChars = 420;
  config.providers.deepseek.reviewMaxInputChars = 420;
  config.limits.maxInputChars = 420;
  let calls = 0;
  const fakeCall = async (cfg, providerName, messages) => {
    calls++;
    assert.equal(providerName, 'deepseek');
    assert.ok(messages[1].content.length <= cfg.providers.deepseek.reviewMaxInputChars);
    return {
      provider: providerName,
      model: 'fake-model',
      content: JSON.stringify({
        issues: [{ file: `chunk-${calls}.js`, line: null, summary: `chunk ${calls}`, severity: 'LOW' }],
        risks: [`risk ${calls}`],
        missing: [],
      }),
    };
  };

  const { results } = await consensusReview(
    { task: 'review chunks', diffText: `${sampleDiff('one.js')}${sampleDiff('two.js')}`, includeFileContext: false },
    { config, callChatCompletion: fakeCall },
  );

  assert.equal(calls, 2);
  assert.equal(results.length, 1);
  assert.equal(results[0].chunked, true);
  assert.equal(results[0].chunks.length, 2);
  assert.deepEqual(results[0].review.issues.map((issue) => issue.summary), ['chunk 1', 'chunk 2']);
  assert.deepEqual(results[0].review.risks, ['risk 1', 'risk 2']);
});

test('consensusReview marks a chunked provider result partial when one review chunk fails', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = '';
  config.providers.deepseek.maxInputChars = 420;
  config.providers.deepseek.reviewMaxInputChars = 420;
  config.limits.maxInputChars = 420;
  let calls = 0;
  const fakeCall = async (cfg, providerName) => {
    calls++;
    if (calls === 2) throw new Error('chunk timeout');
    return {
      provider: providerName,
      model: 'fake-model',
      content: JSON.stringify({
        issues: [{ file: 'one.js', line: null, summary: 'first chunk only', severity: 'LOW' }],
        risks: [],
        missing: [],
      }),
    };
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  let results;
  try {
    ({ results } = await consensusReview(
      { task: 'review chunks', diffText: `${sampleDiff('one.js')}${sampleDiff('two.js')}`, includeFileContext: false },
      { config, callChatCompletion: fakeCall },
    ));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(results.length, 1);
  assert.equal(results[0].partial, true);
  assert.equal(results[0].review.issues.length, 1);
  assert.equal(results[0].chunkErrors.length, 1);
  assert.equal(results[0].chunkErrors[0].error, 'chunk timeout');
  assert.equal(
    summarizeReviewResults(results),
    'multi-model: 1/1 providers returned a valid review (0 unparseable, 0 failed, 1 partial) - only 1 provider configured, this is a second opinion, not consensus',
  );
});

test('consensusReview selects the review profile and marks non-stop finish reasons partial', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = '';
  config.providers.glm.apiKey = 'k2';
  const fakeCall = async (cfg, providerName, messages, options) => {
    assert.equal(providerName, 'glm');
    assert.equal(options.profile, 'review');
    assert.equal(options.command, 'consensus-review');
    assert.match(options.runId, /^review-/);
    assert.equal(options.phase, 'review');
    return {
      provider: providerName,
      model: 'glm-5.2',
      requestId: 'request-1',
      finishReason: 'length',
      content: JSON.stringify({ issues: [], risks: [], missing: [] }),
    };
  };

  const { results } = await consensusReview(
    { task: 't', diffText: 'diff --git a/x b/x\n' },
    { config, callChatCompletion: fakeCall },
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].provider, 'glm');
  assert.equal(results[0].partial, true);
  assert.equal(results[0].chunkErrors[0].type, 'finish_reason');
  assert.equal(results[0].chunks, undefined, 'single-chunk reviews keep the old compact shape');
  assert.equal(
    summarizeReviewResults(results),
    'multi-model: 1/1 providers returned a valid review (0 unparseable, 0 failed, 1 partial) - only 1 provider configured, this is a second opinion, not consensus',
  );
});

test('consensusReview logs a warning naming the provider when its response is not valid JSON', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = '';
  const fakeCall = async (cfg, providerName) => ({ provider: providerName, model: 'm', content: 'not json' });

  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...msgArgs) => errors.push(msgArgs.join(' '));
  try {
    await consensusReview({ task: 't', diffText: 'diff --git a/x b/x\n' }, { config, callChatCompletion: fakeCall });
    assert.ok(errors.some((e) => e.includes('deepseek')), `expected a warning naming deepseek, got: ${JSON.stringify(errors)}`);
  } finally {
    console.error = originalConsoleError;
  }
});

test('consensusReview refuses to call any provider when the diff touches a sensitive path', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const calls = [];
  const fakeCall = async (cfg, providerName) => {
    calls.push(providerName);
    return { provider: providerName, model: 'm', content: '{}' };
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  let outcome;
  try {
    outcome = await consensusReview(
      { task: 't', diffText: 'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-OLD=1\n+NEW=2\n' },
      { config, callChatCompletion: fakeCall },
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(calls.length, 0, 'expected no provider to be called for a diff touching a sensitive path');
  assert.equal(outcome.results.length, 0);
  assert.ok(outcome.rejected.some((r) => r.includes('.env')), JSON.stringify(outcome.rejected));
});

test('consensusReview refuses to call any provider when the diff contains a secret-looking value', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  const calls = [];
  const fakeCall = async (cfg, providerName) => {
    calls.push(providerName);
    return { provider: providerName, model: 'm', content: '{}' };
  };

  const diffText = 'diff --git a/config.js b/config.js\n--- a/config.js\n+++ b/config.js\n@@ -1 +1 @@\n' +
    '-const key = "old"\n+const key = "AKIAABCDEFGHIJKLMNOP"\n';

  const originalConsoleError = console.error;
  console.error = () => {};
  let outcome;
  try {
    outcome = await consensusReview({ task: 't', diffText }, { config, callChatCompletion: fakeCall });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(calls.length, 0, 'expected no provider to be called for a diff containing a secret-looking value');
  assert.equal(outcome.results.length, 0);
  assert.ok(outcome.rejected.some((r) => r.includes('secret')), JSON.stringify(outcome.rejected));
});

test('consensusReview still calls providers for an ordinary diff with no sensitive paths or secrets', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = '';
  const calls = [];
  const fakeCall = async (cfg, providerName) => {
    calls.push(providerName);
    return { provider: providerName, model: 'm', content: JSON.stringify({ issues: [], risks: [], missing: [] }) };
  };

  const { results, rejected } = await consensusReview(
    { task: 't', diffText: 'diff --git a/x b/x\n' },
    { config, callChatCompletion: fakeCall },
  );

  assert.equal(rejected, undefined);
  assert.deepEqual(calls, ['deepseek']);
  assert.equal(results.length, 1);
});

test('summarizeReviewResults reports valid/unparseable/failed counts when a provider returns unparseable JSON', () => {
  const results = [
    { provider: 'deepseek', model: 'm', review: { issues: [], risks: [], missing: [] } },
    { provider: 'glm', model: 'm', review: { raw: 'not json', parseError: 'Unexpected token' } },
  ];
  assert.equal(
    summarizeReviewResults(results),
    'multi-model: 1/2 providers returned a valid review (1 unparseable, 0 failed)',
  );
});

test('summarizeReviewResults counts a call failure separately from an unparseable response', () => {
  const results = [
    { provider: 'deepseek', model: 'm', review: { issues: [], risks: [], missing: [] } },
    { provider: 'glm', error: 'network timeout' },
  ];
  assert.equal(
    summarizeReviewResults(results),
    'multi-model: 1/2 providers returned a valid review (0 unparseable, 1 failed)',
  );
});

test('summarizeReviewResults reports truncated inputs as degraded context', () => {
  const input = { inputTruncated: true, inputChars: 175665, truncatedInputChars: 25665, maxInputChars: 150000 };
  const results = [
    { provider: 'deepseek', model: 'm', input, review: { issues: [], risks: [], missing: [] } },
    { provider: 'glm', input, error: 'network timeout' },
  ];
  assert.equal(
    summarizeReviewResults(results),
    'multi-model: 1/2 providers returned a valid review (0 unparseable, 1 failed, 2 truncated inputs; treat valid reviews as incomplete)',
  );
});

test('summarizeReviewResults notes when only one provider was configured', () => {
  const results = [
    { provider: 'deepseek', model: 'm', review: { issues: [], risks: [], missing: [] } },
  ];
  assert.equal(
    summarizeReviewResults(results),
    'multi-model: 1/1 providers returned a valid review (0 unparseable, 0 failed) - only 1 provider configured, this is a second opinion, not consensus',
  );
});

test('currentGitDiff captures brand-new untracked files, not just changes to tracked ones', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'mm-currentdiff-'));
  const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);

    writeFileSync(path.join(repoRoot, 'NewModule.php'), '<?php\n// brand new untracked file\necho "hello from a new file";\n');

    const diffText = currentGitDiff(repoRoot);
    assert.match(diffText, /NewModule\.php/, `expected the untracked file's path in the diff, got: ${diffText}`);
    assert.match(diffText, /hello from a new file/, `expected the untracked file's content in the diff, got: ${diffText}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('currentGitDiff leaves the git index exactly as it found it', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'mm-currentdiff-index-'));
  const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(path.join(repoRoot, 'tracked.js'), 'console.log("start");\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);

    writeFileSync(path.join(repoRoot, 'tracked.js'), 'console.log("changed");\n');
    git(['add', 'tracked.js']);

    writeFileSync(path.join(repoRoot, 'scratch.tmp'), 'stray untracked scratch file, never meant to be committed\n');

    const indexBefore = git(['ls-files', '--stage']);
    currentGitDiff(repoRoot);
    const indexAfter = git(['ls-files', '--stage']);

    assert.equal(indexAfter, indexBefore, `expected the index to be byte-for-byte unchanged, before:\n${indexBefore}\nafter:\n${indexAfter}`);

    const staged = git(['diff', '--cached', '--name-only']).trim();
    assert.equal(staged, 'tracked.js', `expected only the genuinely-staged file to remain staged, got: ${staged}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('currentGitDiff reports a real diff error instead of silently swallowing it, without losing other files', () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'mm-currentdiff-unreadable-'));
  const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  const badPath = path.join(repoRoot, 'bad.txt');
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...msgArgs) => errors.push(msgArgs.join(' '));
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(path.join(repoRoot, 'app.js'), 'console.log("start");\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);

    writeFileSync(path.join(repoRoot, 'good.txt'), 'readable and diffable content\n');
    writeFileSync(badPath, 'unreadable content that must never reach the diff\n');
    chmodSync(badPath, 0o000);

    let diffText;
    assert.doesNotThrow(() => {
      diffText = currentGitDiff(repoRoot);
    }, 'currentGitDiff must not throw when one untracked file cannot be diffed');

    assert.match(diffText, /good\.txt/, `expected the readable file's path in the diff, got: ${diffText}`);
    assert.match(diffText, /readable and diffable content/, `expected the readable file's content in the diff, got: ${diffText}`);
    assert.doesNotMatch(
      diffText,
      /unreadable content that must never reach the diff/,
      `expected the unreadable file's content to be omitted, got: ${diffText}`,
    );

    assert.equal(errors.length, 1, `expected exactly one console.error warning, got: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /bad\.txt/, `expected the warning to name the unreadable file, got: ${errors[0]}`);
  } finally {
    console.error = originalConsoleError;
    chmodSync(badPath, 0o644);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('chunkFilePaths extracts unique post-image paths and ignores dev/null', () => {
  const diff = 'diff --git a/one.js b/one.js\n+x\ndiff --git a/gone.js b/dev/null\n-y\ndiff --git a/one.js b/one.js\n+z\n';
  assert.deepEqual(chunkFilePaths(diff), ['one.js']);
});

test('chunkFilePaths unquotes git-quoted paths', () => {
  const diff = 'diff --git "a/na\\303\\257ve.js" "b/na\\303\\257ve.js"\n+x\n';
  assert.deepEqual(chunkFilePaths(diff), ['naïve.js']);
});

test('chunkFilePaths resolves unquoted paths containing spaces via the +++ header', () => {
  const diff = 'diff --git a/a dir/file one.txt b/a dir/file one.txt\n'
    + 'index 111..222 100644\n'
    + '--- a/a dir/file one.txt\t\n'
    + '+++ b/a dir/file one.txt\t\n'
    + '@@ -1 +1,2 @@\n hello\n+world\n';
  assert.deepEqual(chunkFilePaths(diff), ['a dir/file one.txt']);
});

test('fileContextForChunk falls back to a supplied path when a slice has no diff --git header', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-ctx-fallback-'));
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(path.join(dir, 'huge.js'), 'x'.repeat(50));
    const headerlessSlice = '[multi-model note: oversized diff slice 2/2 for huge.js; review only this slice.]\n'
      + '-old line continuing...\n+new line continuing...\n';
    assert.deepEqual(chunkFilePaths(headerlessSlice), []);
    const context = fileContextForChunk(headerlessSlice, 5000, ['huge.js']);
    assert.match(context.text, /FILE: huge\.js/);
    assert.deepEqual(context.omittedPaths, []);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileContextForChunk inlines existing changed files within budget and notes omitted ones', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-ctx-'));
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(path.join(dir, 'small.php'), '<?php class Small {}');
    writeFileSync(path.join(dir, 'big.php'), 'x'.repeat(5000));
    const diff = 'diff --git a/small.php b/small.php\n+x\n'
      + 'diff --git a/big.php b/big.php\n+y\n'
      + 'diff --git a/missing.php b/missing.php\n+z\n';
    const context = fileContextForChunk(diff, 600);
    assert.match(context.text, /FILE: small\.php/);
    assert.match(context.text, /class Small/);
    assert.match(context.text, /FILE: big\.php ---\n\[content omitted: exceeds this provider's input budget/);
    assert.match(context.text, /FILE: missing\.php ---\n\[content unavailable at review time/);
    assert.deepEqual(context.omittedPaths, ['big.php', 'missing.php']);
    const empty = fileContextForChunk(diff, 0);
    assert.equal(empty.text, '');
    assert.deepEqual(empty.omittedPaths, ['small.php', 'big.php', 'missing.php']);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileContextForChunk does not duplicate complete new-file content already present in the diff', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-ctx-new-file-'));
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(path.join(dir, 'new.js'), 'export const answer = 42;\n');
    const diff = 'diff --git a/new.js b/new.js\n'
      + 'new file mode 100644\n'
      + '--- /dev/null\n'
      + '+++ b/new.js\n'
      + '@@ -0,0 +1 @@\n'
      + '+export const answer = 42;\n';
    const context = fileContextForChunk(diff, 5000);
    assert.equal(context.text, '');
    assert.deepEqual(context.omittedPaths, []);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized new-file slices retain the marker that prevents full-file context duplication', () => {
  const diff = 'diff --git a/new.js b/new.js\n'
    + 'new file mode 100644\n'
    + '--- /dev/null\n'
    + '+++ b/new.js\n'
    + '@@ -0,0 +1 @@\n'
    + `+${'x'.repeat(1000)}\n`;
  const chunks = splitDiffForReview(diff, 420, 'review');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.completeNewFile === true));
  for (const chunk of chunks) {
    assert.equal(fileContextForChunk(chunk.diffText, 5000, []).text, '');
  }
});

test('consensusReview sends full changed-file content alongside the diff when it exists on disk', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-ctx-review-'));
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(path.join(dir, 'real.php'), '<?php class RealThing {}');
    const config = loadConfig();
    config.providers['deepseek-pro'].apiKey = '';
    config.providers.deepseek.apiKey = 'k1';
    config.providers.glm.apiKey = '';
    let capturedUserContent = '';
    const fakeCall = async (cfg, providerName, messages) => {
      capturedUserContent = messages[1].content;
      return {
        provider: providerName,
        model: 'fake-model',
        content: '{"issues":[],"risks":[],"missing":[]}',
      };
    };

    const { results } = await consensusReview(
      { task: 'review', diffText: 'diff --git a/real.php b/real.php\n+something\n' },
      { config, callChatCompletion: fakeCall },
    );

    assert.equal(results.length, 1);
    assert.match(capturedUserContent, /Current full content of changed files:/);
    assert.match(capturedUserContent, /class RealThing/);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fileContextForChunk replaces a secret-bearing file with an unavailability note', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-ctx-secret-'));
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(path.join(dir, 'config-sample.php'), '<?php\n$apiKey = "abcdefghijklmnop1234";\n');
    const diff = 'diff --git a/config-sample.php b/config-sample.php\n+x\n';
    const context = fileContextForChunk(diff, 5000);
    assert.match(context.text, /FILE: config-sample\.php ---\n\[content unavailable at review time/);
    assert.ok(!context.text.includes('abcdefghijklmnop1234'));
    assert.deepEqual(context.omittedPaths, ['config-sample.php']);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('splitDiffForReview reserves diff budget for file context when fileContextShare is set', () => {
  const diffText = `${sampleDiff('one.js')}${sampleDiff('two.js')}${sampleDiff('three.js')}`;
  const plain = splitDiffForReview(diffText, 800, 'task');
  const reserved = splitDiffForReview(diffText, 800, 'task', { fileContextShare: 0.4 });
  assert.ok(reserved.length > plain.length,
    `expected more chunks with reserve (got ${reserved.length} vs ${plain.length})`);
});

test('consensusReview reports contextOmitted for changed files it could not inline', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-ctx-omit-'));
  const previousCwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(path.join(dir, 'present.php'), '<?php class Present {}');
    const config = loadConfig();
    config.providers['deepseek-pro'].apiKey = '';
    config.providers.deepseek.apiKey = 'k1';
    config.providers.glm.apiKey = '';
    let capturedUserContent = '';
    const fakeCall = async (cfg, providerName, messages) => {
      capturedUserContent = messages[1].content;
      return { provider: providerName, model: 'fake-model', content: '{"issues":[],"risks":[],"missing":[]}' };
    };

    const { results } = await consensusReview(
      {
        task: 'review',
        diffText: 'diff --git a/present.php b/present.php\n+a\ndiff --git a/ghost.php b/ghost.php\n+b\n',
      },
      { config, callChatCompletion: fakeCall },
    );

    assert.match(capturedUserContent, /class Present/);
    assert.match(capturedUserContent, /FILE: ghost\.php ---\n\[content unavailable at review time/);
    assert.deepEqual(results[0].contextOmitted, ['ghost.php']);
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consensusReview self-verifies findings that reference an existing file it was not shown', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-selfverify-'));
  const referenced = path.join(dir, 'Helper.php');
  writeFileSync(referenced, "<?php\nclass Helper { public const GATE = true; }\n");
  try {
    const config = loadConfig();
    config.providers.deepseek.apiKey = 'k1';
    config.providers.glm.apiKey = '';
    config.providers['deepseek-openrouter'].apiKey = '';
    config.providers['glm-53-openrouter'].apiKey = '';
    const calls = [];
    const fakeCall = async (cfg, providerName, messages) => {
      calls.push(messages);
      if (messages[0].content.includes('re-verifying your own')) {
        assert.match(messages[1].content, /class Helper/);
        return {
          provider: providerName,
          model: 'fake-model',
          content: JSON.stringify({
            issues: [],
            risks: ['kept: unrelated concern'],
            missing: [],
          }),
        };
      }
      return {
        provider: providerName,
        model: 'fake-model',
        content: JSON.stringify({
          issues: [{ file: referenced, line: 2, summary: 'GATE constant missing', severity: 'HIGH', evidence: '' }],
          risks: ['kept: unrelated concern', `speculation about ${referenced}`],
          missing: [],
        }),
      };
    };

    const { results } = await consensusReview(
      { task: 'review', diffText: 'diff --git a/x.js b/x.js\n+a\n' },
      { config, callChatCompletion: fakeCall, knownNonIssues: '' },
    );

    assert.equal(calls.length, 2, 'one review call plus one self-verify call');
    assert.equal(results[0].selfVerified, true);
    assert.deepEqual(results[0].selfVerifyFiles, [referenced]);
    assert.equal(results[0].review.issues.length, 0, 'refuted issue retracted');
    assert.deepEqual(results[0].retracted, { issues: 1, risks: 1, missing: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consensusReview skips self-verify when disabled or when referenced files do not exist', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = '';
  config.providers['deepseek-openrouter'].apiKey = '';
  config.providers['glm-53-openrouter'].apiKey = '';
  let callCount = 0;
  const fakeCall = async (cfg, providerName) => {
    callCount++;
    return {
      provider: providerName,
      model: 'fake-model',
      content: JSON.stringify({
        issues: [{ file: 'no/such/file.php', line: 1, summary: 's', severity: 'LOW', evidence: '' }],
        risks: [],
        missing: [],
      }),
    };
  };

  const first = await consensusReview(
    { task: 'review', diffText: 'diff --git a/x.js b/x.js\n+a\n' },
    { config, callChatCompletion: fakeCall, knownNonIssues: '' },
  );
  assert.equal(callCount, 1, 'nonexistent referenced path never triggers a self-verify call');
  assert.equal(first.results[0].selfVerified, undefined);

  callCount = 0;
  await consensusReview(
    { task: 'review', diffText: 'diff --git a/x.js b/x.js\n+a\n', selfVerify: false },
    { config, callChatCompletion: fakeCall, knownNonIssues: '' },
  );
  assert.equal(callCount, 1, 'selfVerify: false makes exactly one call per provider');
});

test('consensusReview keeps original findings when the self-verify call fails', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-selfverify-err-'));
  const referenced = path.join(dir, 'Thing.php');
  writeFileSync(referenced, '<?php\n');
  try {
    const config = loadConfig();
    config.providers.deepseek.apiKey = 'k1';
    config.providers.glm.apiKey = '';
    config.providers['deepseek-openrouter'].apiKey = '';
    config.providers['glm-53-openrouter'].apiKey = '';
    const fakeCall = async (cfg, providerName, messages) => {
      if (messages[0].content.includes('re-verifying your own')) throw new Error('boom');
      return {
        provider: providerName,
        model: 'fake-model',
        content: JSON.stringify({
          issues: [{ file: referenced, line: 1, summary: 's', severity: 'HIGH', evidence: 'x' }],
          risks: [],
          missing: [],
        }),
      };
    };
    const originalError = console.error;
    console.error = () => {};
    let results;
    try {
      ({ results } = await consensusReview(
        { task: 'review', diffText: 'diff --git a/x.js b/x.js\n+a\n' },
        { config, callChatCompletion: fakeCall, knownNonIssues: '' },
      ));
    } finally {
      console.error = originalError;
    }
    assert.equal(results[0].selfVerified, undefined);
    assert.equal(results[0].selfVerifyError, 'boom');
    assert.equal(results[0].review.issues.length, 1, 'unverified findings are kept, flagged by selfVerifyError');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('consensusReview injects the known-non-issues brief into the review system prompt', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = '';
  config.providers['deepseek-openrouter'].apiKey = '';
  config.providers['glm-53-openrouter'].apiKey = '';
  let systemContent = '';
  const fakeCall = async (cfg, providerName, messages) => {
    systemContent = messages[0].content;
    return { provider: providerName, model: 'fake-model', content: '{"issues":[],"risks":[],"missing":[]}' };
  };

  await consensusReview(
    { task: 'review', diffText: 'diff --git a/x.js b/x.js\n+a\n' },
    { config, callChatCompletion: fakeCall, knownNonIssues: '- never flag frobnication' },
  );
  assert.match(systemContent, /Known non-issues in this codebase/);
  assert.match(systemContent, /never flag frobnication/);
});
