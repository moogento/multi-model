import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callDeepSeek } from '../deepseek.js';
import { callGlm } from '../glm.js';

function fakeConfig() {
  return {
    providers: {
      deepseek: { name: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'k', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      glm: { name: 'glm', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.2', apiKey: 'k', apiKeyEnv: 'GLM_API_KEY' },
    },
    limits: { maxInputChars: 1000, maxOutputTokens: 4096 },
  };
}

test('callDeepSeek routes to the deepseek provider', async () => {
  const config = fakeConfig();
  let calledWith;
  const fakeCall = async (cfg, providerName, messages) => {
    calledWith = providerName;
    return { provider: providerName, model: cfg.providers[providerName].model, content: 'ok' };
  };
  const result = await callDeepSeek([{ role: 'user', content: 'hi' }], { config, callChatCompletion: fakeCall });
  assert.equal(calledWith, 'deepseek');
  assert.equal(result.provider, 'deepseek');
});

test('callGlm routes to the glm provider', async () => {
  const config = fakeConfig();
  let calledWith;
  const fakeCall = async (cfg, providerName) => {
    calledWith = providerName;
    return { provider: providerName, model: cfg.providers[providerName].model, content: 'ok' };
  };
  const result = await callGlm([{ role: 'user', content: 'hi' }], { config, callChatCompletion: fakeCall });
  assert.equal(calledWith, 'glm');
  assert.equal(result.provider, 'glm');
});
