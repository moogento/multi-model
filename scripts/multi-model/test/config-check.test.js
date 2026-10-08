import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { configCheck } from '../config-check.js';

process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';
delete process.env.OPENROUTER_API_KEY;

test('configCheck reports not-configured cleanly without throwing', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-pro'].apiKey = '';
  config.providers['deepseek-flash'].apiKey = '';
  config.providers.glm.apiKey = '';
  config.providers['glm-openrouter'].apiKey = '';
  const { results } = await configCheck({ config });
  assert.equal(results.every((r) => r.status === 'not-configured'), true);
  assert.equal(results.some((r) => r.provider === 'minimax-openrouter'), false);
});

test('configCheck exercises the fallback provider when the primary has no key', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers['deepseek-openrouter'].apiKey = 'or-key';
  const called = [];
  const fakeCall = async (cfg, providerName) => {
    called.push(providerName);
    return { provider: providerName, model: 'deepseek/deepseek-v4.1-flash', content: 'pong', latencyMs: 7 };
  };
  const { results } = await configCheck({ config, providers: 'deepseek', callChatCompletion: fakeCall });
  assert.deepEqual(called, ['deepseek-openrouter']);
  assert.equal(results[0].provider, 'deepseek');
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].viaFallback, 'deepseek-openrouter');
});

test('configCheck sends a tiny harmless prompt and reports latency on success', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = 'k';
  config.providers.glm.apiKey = '';
  const fakeCall = async (cfg, providerName, messages, options) => {
    assert.match(messages[0].content, /pong/);
    assert.equal(options.maxTokens, 512);
    assert.equal(options.noFallback, true);
    return { provider: providerName, model: 'm', content: 'pong', latencyMs: 42 };
  };
  const { results } = await configCheck({ config, callChatCompletion: fakeCall });
  const deepseek = results.find((r) => r.provider === 'deepseek');
  assert.equal(deepseek.status, 'ok');
  assert.equal(deepseek.latencyMs, 42);
});

test('configCheck reports errors without leaking the key', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = 'super-secret-key';
  config.providers.glm.apiKey = '';
  const fakeCall = async () => { throw new Error('deepseek returned 401: Invalid authentication'); };
  const { results } = await configCheck({ config, callChatCompletion: fakeCall });
  const deepseek = results.find((r) => r.provider === 'deepseek');
  assert.equal(deepseek.status, 'error');
  assert.doesNotMatch(deepseek.message, /super-secret-key/);
});

test('configCheck can explicitly probe experimental OpenRouter presets', async () => {
  const config = loadConfig();
  config.providers['minimax-openrouter'].apiKey = 'k1';
  config.providers['kimi-openrouter'].apiKey = 'k2';
  config.providers['qwen-coder-openrouter'].apiKey = 'k3';
  const seen = [];
  const fakeCall = async (cfg, providerName) => {
    seen.push(providerName);
    return { provider: providerName, model: cfg.providers[providerName].model, content: 'pong', latencyMs: 5 };
  };
  const { results } = await configCheck({ config, callChatCompletion: fakeCall, preset: 'openrouter-cheap' });
  assert.deepEqual(seen, ['minimax-openrouter', 'kimi-openrouter', 'qwen-coder-openrouter']);
  assert.ok(results.every((r) => r.status === 'ok'));
});

test('configCheck reports unknown explicit providers', async () => {
  const config = loadConfig();
  const { results } = await configCheck({ config, providers: 'missing-provider' });
  assert.deepEqual(results, [{ provider: 'missing-provider', status: 'unknown-provider' }]);
});
