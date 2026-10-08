import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { benchmark } from '../benchmark.js';

process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';

test('benchmark runs the same prompt against every roles.benchmark provider', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = 'k1';
  config.providers.glm.apiKey = 'k2';
  let promptsSeen = [];
  const optionsSeen = [];
  const fakeCall = async (cfg, providerName, messages, options) => {
    promptsSeen.push(messages[0].content);
    optionsSeen.push(options);
    return { provider: providerName, model: 'm', content: 'response text', latencyMs: 10, usage: { total_tokens: 3 } };
  };
  const { results } = await benchmark({ task: 'say hi' }, { config, callChatCompletion: fakeCall });
  assert.equal(results.length, 2);
  assert.ok(promptsSeen.every((p) => p === 'say hi'));
  assert.ok(results.every((r) => r.status === 'ok' && r.responseLength === 'response text'.length));
  assert.ok(optionsSeen.every((o) => o.noFallback === true));
});

test('benchmark can run a named provider preset', async () => {
  const config = loadConfig();
  config.providers['minimax-openrouter'].apiKey = 'k1';
  config.providers['kimi-openrouter'].apiKey = 'k2';
  config.providers['qwen-coder-openrouter'].apiKey = 'k3';
  const seen = [];
  const fakeCall = async (cfg, providerName) => {
    seen.push(providerName);
    return { provider: providerName, model: 'm', content: 'response text', latencyMs: 10, usage: { total_tokens: 3 } };
  };
  const { results } = await benchmark({ task: 'say hi', preset: 'openrouter-cheap' }, { config, callChatCompletion: fakeCall });
  assert.deepEqual(seen, ['minimax-openrouter', 'kimi-openrouter', 'qwen-coder-openrouter']);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.status === 'ok'));
});

test('benchmark reports not-configured for missing providers without throwing', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers.glm.apiKey = '';
  config.providers['deepseek-openrouter'].apiKey = '';
  config.providers['glm-53-openrouter'].apiKey = '';
  const { results } = await benchmark({ task: 'say hi' }, { config, callChatCompletion: async () => { throw new Error('should not be called'); } });
  assert.ok(results.every((r) => r.status === 'not-configured'));
});

test('benchmark treats a provider as configured when only its fallback has a key', async () => {
  const config = loadConfig();
  config.providers.deepseek.apiKey = '';
  config.providers.glm.apiKey = '';
  config.providers['deepseek-openrouter'].apiKey = 'or-key';
  config.providers['glm-53-openrouter'].apiKey = 'or-key';
  const seen = [];
  const fakeCall = async (cfg, providerName) => {
    seen.push(providerName);
    return { provider: providerName, model: 'm', content: 'response text', latencyMs: 10, usage: { total_tokens: 3 } };
  };
  const { results } = await benchmark({ task: 'say hi' }, { config, callChatCompletion: fakeCall });
  assert.deepEqual(seen, ['deepseek', 'glm']);
  assert.ok(results.every((r) => r.status === 'ok'));
});
