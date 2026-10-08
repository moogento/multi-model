import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { cheapImplement, applyIfRequested, validateModeArgs } from '../cheap-implement.js';

process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';

const DRAFT_DIFF_CONTENT = '```diff\ndiff --git a/x.js b/x.js\n+hello\n```';
const REVISED_DIFF_CONTENT = '```diff\ndiff --git a/x.js b/x.js\n+hello\n+fixed\n```';
const CLEAN_CRITIQUE_CONTENT = '{"issues":[],"risks":[],"missing":[]}';
const ISSUE_CRITIQUE_CONTENT = '{"issues":[{"file":"x.js","line":1,"summary":"wrong approach","severity":"HIGH"}],"risks":[],"missing":[]}';

test('validateModeArgs defaults to diff mode when --mode is omitted', () => {
  assert.deepEqual(validateModeArgs({}), { mode: 'diff' });
});

test('validateModeArgs rejects an unknown --mode value', () => {
  const result = validateModeArgs({ mode: 'bogus' });
  assert.equal(result.mode, 'diff');
  assert.match(result.error, /Unknown --mode "bogus"/);
});

test('validateModeArgs rejects --apply combined with --mode notes', () => {
  const result = validateModeArgs({ mode: 'notes', apply: true });
  assert.equal(result.mode, 'notes');
  assert.match(result.error, /--apply is not valid with --mode notes/);
});

test('validateModeArgs accepts --mode notes without --apply', () => {
  assert.deepEqual(validateModeArgs({ mode: 'notes' }), { mode: 'notes' });
});

test('cheapImplement extracts a fenced diff and saves it as a patch file when the critique provider is not configured', async () => {
  const config = loadConfig();
  config.providers.glm.apiKey = '';
  const fakeCall = async (cfg, providerName) => ({
    provider: providerName,
    model: 'fake-model',
    content: DRAFT_DIFF_CONTENT,
  });

  const result = await cheapImplement({ task: 'add hello', files: [] }, { config, callChatCompletion: fakeCall });
  assert.equal(result.provider, config.roles.implementation);
  assert.match(result.diff, /diff --git a\/x\.js b\/x\.js/);
  assert.ok(existsSync(result.patchPath));
  assert.match(result.patchPath, new RegExp(`-${config.roles.implementation}\\.diff$`));
  assert.equal(result.critique, null);
  assert.equal(result.revised, false);
  assert.equal(result.revisionCritique, null);
  unlinkSync(result.patchPath);
});

test('cheapImplement returns the draft as-is when the critique finds no issues', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-pro'].apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  let deepseekProCalls = 0;
  const fakeCall = async (cfg, providerName) => {
    if (providerName === 'deepseek-pro') {
      deepseekProCalls += 1;
      return { provider: providerName, model: 'fake-model', content: DRAFT_DIFF_CONTENT };
    }
    return { provider: providerName, model: 'fake-model', content: CLEAN_CRITIQUE_CONTENT };
  };

  const result = await cheapImplement({ task: 'add hello', files: [] }, { config, callChatCompletion: fakeCall });
  assert.match(result.diff, /diff --git a\/x\.js b\/x\.js\n\+hello/);
  assert.equal(result.critique.issues.length, 0);
  assert.equal(result.revised, false);
  assert.equal(result.revisionCritique, null);
  assert.equal(deepseekProCalls, 1, 'a clean critique must not trigger a revision call');
  unlinkSync(result.patchPath);
});

test('cheapImplement revises the draft when the critique finds an issue, then reports a clean revision critique', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-pro'].apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  let deepseekProCalls = 0;
  let glmCalls = 0;
  const fakeCall = async (cfg, providerName) => {
    if (providerName === 'deepseek-pro') {
      deepseekProCalls += 1;
      return { provider: providerName, model: 'fake-model', content: deepseekProCalls === 1 ? DRAFT_DIFF_CONTENT : REVISED_DIFF_CONTENT };
    }
    glmCalls += 1;
    return { provider: providerName, model: 'fake-model', content: glmCalls === 1 ? ISSUE_CRITIQUE_CONTENT : CLEAN_CRITIQUE_CONTENT };
  };

  const result = await cheapImplement({ task: 'add hello', files: [] }, { config, callChatCompletion: fakeCall });
  assert.match(result.diff, /\+fixed/, 'expected the revised diff, not the original draft');
  assert.equal(result.critique.issues.length, 1);
  assert.equal(result.revised, true);
  assert.equal(result.revisionCritique.issues.length, 0);
  assert.equal(deepseekProCalls, 2, 'expected exactly one draft call and one revision call');
  assert.equal(glmCalls, 2, 'expected exactly one critique and one revision re-critique');
  unlinkSync(result.patchPath);
});

test('cheapImplement falls back to the draft when the critique call throws', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-pro'].apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    const fakeCall = async (cfg, providerName) => {
      if (providerName === 'deepseek-pro') return { provider: providerName, model: 'fake-model', content: DRAFT_DIFF_CONTENT };
      throw new Error('network timeout');
    };
    result = await cheapImplement({ task: 'add hello', files: [] }, { config, callChatCompletion: fakeCall });
  } finally {
    console.error = originalConsoleError;
  }
  assert.match(result.diff, /diff --git a\/x\.js b\/x\.js\n\+hello/);
  assert.equal(result.critique, null);
  assert.equal(result.revised, false);
  unlinkSync(result.patchPath);
});

test('cheapImplement falls back to the draft when the critique returns unparseable content', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-pro'].apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    const fakeCall = async (cfg, providerName) => {
      if (providerName === 'deepseek-pro') return { provider: providerName, model: 'fake-model', content: DRAFT_DIFF_CONTENT };
      return { provider: providerName, model: 'fake-model', content: 'not valid json at all' };
    };
    result = await cheapImplement({ task: 'add hello', files: [] }, { config, callChatCompletion: fakeCall });
  } finally {
    console.error = originalConsoleError;
  }
  assert.match(result.diff, /diff --git a\/x\.js b\/x\.js\n\+hello/);
  assert.equal(result.critique, null);
  assert.equal(result.revised, false);
  unlinkSync(result.patchPath);
});

test('cheapImplement falls back to the original draft when the revision call throws', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-pro'].apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    let deepseekProCalls = 0;
    const fakeCall = async (cfg, providerName) => {
      if (providerName === 'deepseek-pro') {
        deepseekProCalls += 1;
        if (deepseekProCalls === 1) return { provider: providerName, model: 'fake-model', content: DRAFT_DIFF_CONTENT };
        throw new Error('revision call failed');
      }
      return { provider: providerName, model: 'fake-model', content: ISSUE_CRITIQUE_CONTENT };
    };
    result = await cheapImplement({ task: 'add hello', files: [] }, { config, callChatCompletion: fakeCall });
  } finally {
    console.error = originalConsoleError;
  }
  assert.match(result.diff, /diff --git a\/x\.js b\/x\.js\n\+hello/, 'expected the original draft, not a broken revision');
  assert.equal(result.critique.issues.length, 1, 'the first critique result must still be reported');
  assert.equal(result.revised, false);
  assert.equal(result.revisionCritique, null);
  unlinkSync(result.patchPath);
});

test('cheapImplement still returns the revision when the second critique throws', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-pro'].apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    let deepseekProCalls = 0;
    let glmCalls = 0;
    const fakeCall = async (cfg, providerName) => {
      if (providerName === 'deepseek-pro') {
        deepseekProCalls += 1;
        return { provider: providerName, model: 'fake-model', content: deepseekProCalls === 1 ? DRAFT_DIFF_CONTENT : REVISED_DIFF_CONTENT };
      }
      glmCalls += 1;
      if (glmCalls === 1) return { provider: providerName, model: 'fake-model', content: ISSUE_CRITIQUE_CONTENT };
      throw new Error('revision critique failed');
    };
    result = await cheapImplement({ task: 'add hello', files: [] }, { config, callChatCompletion: fakeCall });
  } finally {
    console.error = originalConsoleError;
  }
  assert.match(result.diff, /\+fixed/);
  assert.equal(result.revised, true);
  assert.equal(result.revisionCritique, null);
  unlinkSync(result.patchPath);
});

test('cheapImplement never sends a draft that touches a sensitive path to the critique provider', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-pro'].apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const leakyDraft = '```diff\ndiff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+SECRET=1\n```';
  const fakeCall = async (cfg, providerName) => {
    if (providerName === 'deepseek-pro') return { provider: providerName, model: 'fake-model', content: leakyDraft };
    throw new Error('critique provider should never be called with a leaky diff');
  };

  const result = await cheapImplement({ task: 'add hello', files: [] }, { config, callChatCompletion: fakeCall });
  assert.match(result.diff, /\.env/);
  assert.equal(result.critique, null);
  assert.equal(result.revised, false);
  unlinkSync(result.patchPath);
});

test('cheapImplement falls back to the original draft when the revision itself touches a sensitive path', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-pro'].apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const leakyRevision = '```diff\ndiff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+SECRET=1\n```';
  let deepseekProCalls = 0;
  let glmCalls = 0;
  const fakeCall = async (cfg, providerName) => {
    if (providerName === 'deepseek-pro') {
      deepseekProCalls += 1;
      return { provider: providerName, model: 'fake-model', content: deepseekProCalls === 1 ? DRAFT_DIFF_CONTENT : leakyRevision };
    }
    glmCalls += 1;
    if (glmCalls === 1) return { provider: providerName, model: 'fake-model', content: ISSUE_CRITIQUE_CONTENT };
    throw new Error('critique provider should never be called on a leaky revision');
  };

  const result = await cheapImplement({ task: 'add hello', files: [] }, { config, callChatCompletion: fakeCall });
  assert.match(result.diff, /diff --git a\/x\.js b\/x\.js\n\+hello/, 'a revision that trips the leak guard must not become the returned diff');
  assert.doesNotMatch(result.diff, /\.env/);
  assert.equal(result.critique.issues.length, 1, 'the first critique result must still be reported');
  assert.equal(result.revised, false);
  assert.equal(result.revisionCritique, null);
  unlinkSync(result.patchPath);
});

test('cheapImplement skips critique and revision entirely when selfCorrect is false', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-pro'].apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const fakeCall = async (cfg, providerName) => {
    if (providerName === 'deepseek-pro') return { provider: providerName, model: 'fake-model', content: DRAFT_DIFF_CONTENT };
    throw new Error('critique provider should never be called when selfCorrect is false');
  };

  const result = await cheapImplement({ task: 'add hello', files: [], selfCorrect: false }, { config, callChatCompletion: fakeCall });
  assert.match(result.diff, /diff --git a\/x\.js b\/x\.js\n\+hello/);
  assert.equal(result.critique, null);
  assert.equal(result.revised, false);
  unlinkSync(result.patchPath);
});

test('applyIfRequested does not call applyGuardedDiff when --apply was not passed', () => {
  const throwingApply = () => {
    throw new Error('applyGuardedDiff should not be called without --apply');
  };
  const result = applyIfRequested('/some/patch.diff', {}, { applyGuardedDiff: throwingApply });
  assert.deepEqual(result, { applied: false, violations: [] });
});

test('applyIfRequested passes all four allow flags through as true when set', () => {
  let receivedOptions;
  const fakeApply = (patchPath, options) => {
    receivedOptions = options;
    return { applied: true, violations: [] };
  };
  const args = {
    apply: true,
    'allow-vendor': true,
    'allow-sensitive-paths': true,
    'allow-network': true,
    'allow-large-deletion': true,
  };
  applyIfRequested('/some/patch.diff', args, { applyGuardedDiff: fakeApply });
  assert.deepEqual(receivedOptions, {
    allowVendor: true,
    allowSensitivePaths: true,
    allowNetwork: true,
    allowLargeDeletion: true,
  });
});

test('applyIfRequested passes all four allow flags through as false when unset', () => {
  let receivedOptions;
  const fakeApply = (patchPath, options) => {
    receivedOptions = options;
    return { applied: true, violations: [] };
  };
  applyIfRequested('/some/patch.diff', { apply: true }, { applyGuardedDiff: fakeApply });
  assert.deepEqual(receivedOptions, {
    allowVendor: false,
    allowSensitivePaths: false,
    allowNetwork: false,
    allowLargeDeletion: false,
  });
});

test('applyIfRequested passes a rejection result through unchanged', () => {
  const fakeApply = () => ({ applied: false, violations: ['x'] });
  const result = applyIfRequested('/some/patch.diff', { apply: true }, { applyGuardedDiff: fakeApply });
  assert.deepEqual(result, { applied: false, violations: ['x'] });
});

test('cheapImplement notes mode saves advisory Markdown to drafts and skips the critique cycle', async () => {
  const config = loadConfig();
  config.providers.glm.apiKey = 'k2';
  let critiqueCalls = 0;
  const fakeCall = async (cfg, providerName, messages) => {
    if (providerName === config.roles.critique) critiqueCalls += 1;
    assert.match(messages[0].content, /implementation adviser/);
    assert.match(messages[0].content, /never a diff or patch/);
    return { provider: providerName, model: 'fake-model', content: '## Approach\nDo the thing.' };
  };

  const result = await cheapImplement(
    { task: 'add hello', files: [], mode: 'notes' },
    { config, callChatCompletion: fakeCall },
  );
  assert.equal(result.mode, 'notes');
  assert.equal(critiqueCalls, 0);
  assert.match(result.notes, /## Approach/);
  assert.ok(existsSync(result.notesPath));
  assert.match(result.notesPath, /drafts[/\\].*\.md$/);
  assert.equal(result.diff, undefined);
  unlinkSync(result.notesPath);
});

test('cheapImplement notes mode rejects empty provider content instead of saving a blank file', async () => {
  const config = loadConfig();
  const fakeCall = async (cfg, providerName) => ({ provider: providerName, model: 'fake-model', content: '   \n' });

  await assert.rejects(
    cheapImplement({ task: 'add hello', files: [], mode: 'notes' }, { config, callChatCompletion: fakeCall }),
    /empty implementation notes/,
  );
});

test('cheapImplement notes mode flags output-cap truncation via finishReason', async () => {
  const config = loadConfig();
  const fakeCall = async (cfg, providerName) => ({
    provider: providerName, model: 'fake-model', content: '## Approach\ncut off mid', finishReason: 'length',
  });

  const warnings = [];
  const originalError = console.error;
  console.error = (msg) => warnings.push(String(msg));
  let result;
  try {
    result = await cheapImplement({ task: 'add hello', files: [], mode: 'notes' }, { config, callChatCompletion: fakeCall });
  } finally {
    console.error = originalError;
  }
  assert.equal(result.truncated, true);
  assert.equal(result.finishReason, 'length');
  assert.ok(warnings.some((w) => w.includes('finish_reason=length')));
  assert.ok(existsSync(result.notesPath));
  unlinkSync(result.notesPath);
});
