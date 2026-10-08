import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { explain } from '../explain.js';

process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';

test('explain resolves the explanation-role provider', async () => {
  const config = loadConfig();
  let calledProvider;
  const fakeCall = async (cfg, providerName) => {
    calledProvider = providerName;
    return { provider: providerName, model: 'm', content: 'This function does X.' };
  };
  const result = await explain({ files: [], symbol: 'Foo::bar' }, { config, callChatCompletion: fakeCall });
  assert.equal(calledProvider, config.roles.explanation);
  assert.match(result.markdown, /does X/);
});
