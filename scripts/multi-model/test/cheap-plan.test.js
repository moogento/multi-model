import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { cheapPlan } from '../cheap-plan.js';

process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';

test('cheapPlan resolves the planning-role provider and returns markdown', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-plan-'));
  const filePath = path.join(dir, 'a.php');
  writeFileSync(filePath, '<?php\n');
  const config = loadConfig();

  let calledProvider;
  const fakeCall = async (cfg, providerName) => {
    calledProvider = providerName;
    return { provider: providerName, model: 'fake-model', content: '# Plan\n- step 1' };
  };

  const result = await cheapPlan({ task: 'add a widget', files: [filePath] }, { config, callChatCompletion: fakeCall });
  assert.equal(calledProvider, config.roles.planning);
  assert.equal(result.provider, config.roles.planning);
  assert.match(result.markdown, /Plan/);
});

test('cheapPlan honors an explicit provider override', async () => {
  const config = loadConfig();
  let calledProvider;
  const fakeCall = async (cfg, providerName) => {
    calledProvider = providerName;
    return { provider: providerName, model: 'fake-model', content: 'plan' };
  };
  await cheapPlan({ task: 't', files: [], provider: 'glm' }, { config, callChatCompletion: fakeCall });
  assert.equal(calledProvider, 'glm');
});
