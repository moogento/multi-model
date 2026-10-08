import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { altImplement } from '../alt-implement.js';

process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';
delete process.env.OPENROUTER_API_KEY;

test('altImplement calls every configured provider and reports diff stats', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const fakeCall = async (cfg, providerName) => ({
    provider: providerName,
    model: 'fake-model',
    content: `diff --git a/${providerName}.js b/${providerName}.js\n+line one\n+line two\n`,
  });

  const { results } = await altImplement({ task: 'add feature', files: [] }, { config, callChatCompletion: fakeCall });
  assert.equal(results.length, 2);
  const names = results.map((r) => r.provider).sort();
  assert.deepEqual(names, ['deepseek', 'glm']);
  for (const r of results) {
    assert.equal(r.stats.files, 1);
    assert.equal(r.stats.added, 2);
    unlinkSync(r.patchPath);
  }
});

test('altImplement excludes a fully-configured deepseek-pro from the default fan-out', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = 'k1';
  config.providers['deepseek-pro'].apiKey = 'k-pro';
  config.providers.glm.apiKey = 'k2';
  const fakeCall = async (cfg, providerName) => ({
    provider: providerName,
    model: 'fake-model',
    content: `diff --git a/${providerName}.js b/${providerName}.js\n+line\n`,
  });

  const { results } = await altImplement({ task: 'add feature', files: [] }, { config, callChatCompletion: fakeCall });
  const names = results.map((r) => r.provider).sort();
  assert.deepEqual(names, ['deepseek', 'glm'],
    'deepseek-pro has a real key but is role-bound to implementation, not the alt-implement fan-out');
  for (const r of results) unlinkSync(r.patchPath);
});

test('altImplement keeps the successful result and its saved patch when a sibling provider call fails', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  const fakeCall = async (cfg, providerName) => {
    if (providerName === 'glm') throw new Error('network timeout');
    return {
      provider: providerName,
      model: 'fake-model',
      content: `diff --git a/${providerName}.js b/${providerName}.js\n+line one\n`,
    };
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  let results;
  try {
    ({ results } = await altImplement({ task: 'add feature', files: [] }, { config, callChatCompletion: fakeCall }));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(results.length, 2);
  const deepseekResult = results.find((r) => r.provider === 'deepseek');
  const glmResult = results.find((r) => r.provider === 'glm');
  assert.ok(existsSync(deepseekResult.patchPath), 'expected the successful provider patch to still be saved to disk');
  assert.equal(glmResult.error, 'network timeout');
  assert.equal(glmResult.patchPath, undefined);
  unlinkSync(deepseekResult.patchPath);
});

test('altImplement picks up extra providers from config rather than a hardcoded list', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  config.providers.openai = {
    name: 'openai',
    baseUrl: 'https://example.test/v1',
    model: 'gpt-test',
    apiKey: 'k3',
    apiKeyEnv: 'OPENAI_API_KEY',
  };
  const fakeCall = async (cfg, providerName) => ({
    provider: providerName,
    model: 'fake-model',
    content: `diff --git a/${providerName}.js b/${providerName}.js\n+line\n`,
  });

  const { results } = await altImplement({ task: 't', files: [] }, { config, callChatCompletion: fakeCall });
  const names = results.map((r) => r.provider).sort();
  assert.deepEqual(names, ['deepseek', 'glm', 'openai']);
  for (const r of results) unlinkSync(r.patchPath);
});

test('altImplement skips providers without an apiKey', async () => {
  const config = loadConfig();
  config.providers['deepseek-pro'].apiKey = '';
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = '';
  const fakeCall = async (cfg, providerName) => ({ provider: providerName, model: 'm', content: 'diff --git a/x b/x\n+y\n' });

  const { results } = await altImplement({ task: 't', files: [] }, { config, callChatCompletion: fakeCall });
  assert.equal(results.length, 1);
  assert.equal(results[0].provider, 'deepseek');
  unlinkSync(results[0].patchPath);
});
