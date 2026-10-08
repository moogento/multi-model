import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  providersForRole,
  loadConfig,
  resolveProviderForRole,
  parseArgs,
  savePatch,
  envFilePath,
  defaultCallLogPath,
  defaultUsageLogPath,
  defaultOutcomeLogPath,
  resolveCallLogFile,
  resolveOutcomeLogFile,
  diffStats,
  multiModelClient,
  defaultFanoutProviders,
  benchmarkProviders,
} from '../config.js';

process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';
process.env.MULTI_MODEL_CLIENT = 'claude';
process.env.MULTI_MODEL_CALL_LOG = 'off';
delete process.env.OPENROUTER_API_KEY;

test('diffStats counts added/removed lines whose content starts with ++ or -- while excluding headers', () => {
  const diff = [
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1,2 +1,2 @@',
    '-old;',
    '---$j;',
    '+++$i;',
    '+new;',
  ].join('\n') + '\n';
  const stats = diffStats(diff);
  assert.equal(stats.added, 2);
  assert.equal(stats.removed, 2);
});

test('loadConfig applies defaults when no env overrides set', () => {
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_API_KEY;
  const config = loadConfig();
  assert.equal(config.providers.deepseek.model, 'deepseek-v4-flash');
  assert.equal(config.providers.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.providers.deepseek.apiKey, '');
});

test('loadConfig defaults: current model generation, pricing, and diff-sized limits', () => {
  delete process.env.GLM_MODEL;
  delete process.env.MULTI_MODEL_MAX_INPUT_CHARS;
  delete process.env.MULTI_MODEL_MAX_OUTPUT_TOKENS;
  const config = loadConfig();
  assert.equal(config.providers.glm.model, 'glm-5.3-flash');
  assert.equal(config.providers.glm.baseUrl, 'https://api.z.ai/api/coding/paas/v4');
  assert.equal(config.providers.glm.maxInputChars, 600000);
  assert.equal(config.providers.glm.requestIdPrefix, 'mm-glm');
  assert.deepEqual(config.providers.glm.headers, {
    'Accept-Language': { env: 'GLM_ACCEPT_LANGUAGE', default: 'en-US,en' },
  });
  assert.deepEqual(config.providers.glm.extraBody, {
    reasoning_effort: { env: 'GLM_REASONING_EFFORT', default: 'max' },
    thinking: { type: 'enabled', clear_thinking: true },
  });
  assert.deepEqual(config.providers.glm.reviewExtraBody, {
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
  });
  assert.equal(config.limits.reviewMaxInputChars, 180000);
  assert.equal(config.limits.reviewMaxOutputTokens, 8192);
  assert.equal(config.providers.deepseek.reviewMaxInputChars, 180000);
  assert.equal(config.providers.deepseek.reviewMaxOutputTokens, 8192);
  assert.equal(config.providers.deepseek.contextWindowTokens, 1000000);
  assert.deepEqual(config.providers.deepseek.reviewExtraBody, {
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
  });
  assert.equal(config.providers.glm.reviewMaxInputChars, 240000);
  assert.equal(config.providers['deepseek-pro'].reviewMaxInputChars, 240000);
  assert.equal(config.providers.glm.reviewMaxOutputTokens, 8192);
  assert.equal(config.providers.deepseek.timeoutMs, 60000);
  assert.equal(config.providers.deepseek.retries, 1);
  assert.equal(config.providers.deepseek.maxInputChars, 300000);
  assert.equal(config.providers['deepseek-pro'].maxInputChars, 400000);
  assert.equal(config.providers['deepseek-pro'].maxOutputTokens, 32768);
  assert.equal(config.providers['deepseek-pro'].model, 'deepseek-v4-pro');
  assert.equal(config.providers['deepseek-flash'].model, 'deepseek-flash');
  assert.equal(config.providers['deepseek-flash'].fallbackProvider, 'deepseek-openrouter');
  assert.equal(config.providers['deepseek-flash'].reviewFanout, false);
  assert.equal(config.providers.deepseek.maxOutputTokens, 32768);
  assert.equal(config.providers['deepseek-openrouter'].maxOutputTokens, 32768);
  assert.equal(config.providers.glm.timeoutMs, 300000);
  assert.equal(config.providers.glm.retries, 2);
  assert.equal(config.providers.deepseek.fallbackProvider, 'deepseek-openrouter');
  assert.equal(config.providers['deepseek-pro'].fallbackProvider, 'deepseek-pro-openrouter');
  assert.equal(config.providers.glm.fallbackProvider, 'glm-53-openrouter');
  assert.equal(config.providers['deepseek-openrouter'].model, 'deepseek/deepseek-v4.1-flash');
  assert.deepEqual(config.providers['deepseek-openrouter'].reviewExtraBody, {
    reasoning: { enabled: false },
    response_format: { type: 'json_object' },
  });
  assert.equal(config.providers['deepseek-openrouter'].reviewFanout, false);
  assert.equal(config.providers['deepseek-pro-openrouter'].model, 'deepseek/deepseek-v4-pro-0813');
  assert.equal(config.providers['deepseek-pro-openrouter'].maxOutputTokens, 32768);
  assert.equal(config.providers['glm-53-openrouter'].model, 'z-ai/glm-5.3-flash');
  assert.equal(config.providers['glm-free-openrouter'].model, 'z-ai/glm-5.2:free');
  assert.deepEqual(config.benchmarkPresets.guardrailed, [
    'deepseek-openrouter',
    'deepseek-pro-openrouter',
    'glm-53-openrouter',
    'glm-free-openrouter',
  ]);
  assert.equal(config.providers['glm-openrouter'].baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(config.providers['glm-openrouter'].model, 'z-ai/glm-5.3-flash');
  assert.equal(config.providers['glm-openrouter'].apiKey, '');
  assert.equal(config.providers['glm-openrouter'].timeoutMs, 180000);
  assert.equal(config.providers['glm-openrouter'].retries, 1);
  assert.equal(config.providers['glm-openrouter'].retryDelayMs, 3000);
  assert.deepEqual(config.providers['glm-openrouter'].extraBody.provider, {
    order: ['z-ai'],
    only: ['z-ai'],
    allow_fallbacks: false,
    require_parameters: true,
  });
  assert.equal(config.providers['minimax-openrouter'].model, 'minimax/minimax-m3');
  assert.equal(config.providers['minimax-openrouter'].maxInputChars, 220000);
  assert.equal(config.providers['minimax-openrouter'].reviewFanout, false);
  assert.equal(config.providers['minimax-openrouter'].configCheck, false);
  assert.equal(config.providers['kimi-openrouter'].model, 'moonshotai/kimi-k2.7-code');
  assert.equal(config.providers['qwen-coder-openrouter'].model, 'qwen/qwen3-coder');
  assert.equal(config.providers['nemotron-free-openrouter'].model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.equal(config.providers['poolside-free-openrouter'].model, 'poolside/laguna-m.1:free');
  assert.equal(config.providers['north-code-free-openrouter'].model, 'cohere/north-mini-code:free');
  assert.deepEqual(
    config.providers.deepseek.pricing,
    { inputPerMTok: 0.3, outputPerMTok: 1.2, cachedInputPerMTok: 0.006 }
  );
  assert.deepEqual(
    config.providers['deepseek-flash'].pricing,
    { inputPerMTok: 0.3, outputPerMTok: 1.2, cachedInputPerMTok: 0.006 }
  );
  assert.deepEqual(
    config.providers['deepseek-pro'].pricing,
    { inputPerMTok: 1.32, outputPerMTok: 3.96, cachedInputPerMTok: 0.044 }
  );
  assert.deepEqual(config.providers.glm.pricing, { inputPerMTok: 0.075, outputPerMTok: 0.25 });
  assert.equal(config.limits.maxInputChars, 150000);
  assert.equal(config.limits.maxOutputTokens, 16384);
});

test('loadConfig honors env var overrides', () => {
  process.env.DEEPSEEK_MODEL = 'deepseek-custom';
  process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
  process.env.GLM_TIMEOUT_MS = '90000';
  process.env.GLM_RETRIES = '2';
  process.env.GLM_RETRY_DELAY_MS = '250';
  process.env.GLM_MAX_INPUT_CHARS = '700000';
  process.env.OPENROUTER_GLM_TIMEOUT_MS = '210000';
  process.env.OPENROUTER_GLM_RETRIES = '3';
  process.env.OPENROUTER_GLM_RETRY_DELAY_MS = '500';
  process.env.OPENROUTER_MINIMAX_MODEL = 'minimax/custom';
  process.env.OPENROUTER_MINIMAX_MAX_INPUT_CHARS = '333000';
  process.env.DEEPSEEK_PRO_MAX_OUTPUT_TOKENS = '12345';
  const config = loadConfig();
  assert.equal(config.providers['deepseek-pro'].maxOutputTokens, 12345);
  delete process.env.DEEPSEEK_PRO_MAX_OUTPUT_TOKENS;
  assert.equal(config.providers.deepseek.model, 'deepseek-custom');
  assert.equal(config.providers.deepseek.apiKey, 'test-key-not-real');
  assert.equal(config.providers.glm.timeoutMs, 90000);
  assert.equal(config.providers.glm.retries, 2);
  assert.equal(config.providers.glm.retryDelayMs, 250);
  assert.equal(config.providers.glm.maxInputChars, 700000);
  assert.equal(config.providers['glm-openrouter'].timeoutMs, 210000);
  assert.equal(config.providers['glm-openrouter'].retries, 3);
  assert.equal(config.providers['glm-openrouter'].retryDelayMs, 500);
  assert.equal(config.providers['minimax-openrouter'].model, 'minimax/custom');
  assert.equal(config.providers['minimax-openrouter'].maxInputChars, 333000);
  delete process.env.DEEPSEEK_MODEL;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GLM_TIMEOUT_MS;
  delete process.env.GLM_RETRIES;
  delete process.env.GLM_RETRY_DELAY_MS;
  delete process.env.GLM_MAX_INPUT_CHARS;
  delete process.env.OPENROUTER_GLM_TIMEOUT_MS;
  delete process.env.OPENROUTER_GLM_RETRIES;
  delete process.env.OPENROUTER_GLM_RETRY_DELAY_MS;
  delete process.env.OPENROUTER_MINIMAX_MODEL;
  delete process.env.OPENROUTER_MINIMAX_MAX_INPUT_CHARS;
});

test('resolveProviderForRole: explicit provider wins over config', () => {
  const config = loadConfig();
  assert.equal(resolveProviderForRole(config, 'implementation', 'glm'), 'glm');
});

test('resolveProviderForRole: falls back to role default', () => {
  const config = loadConfig();
  assert.equal(resolveProviderForRole(config, 'implementation'), 'deepseek-pro');
});

test('resolveProviderForRole: array role returns first element', () => {
  const config = loadConfig();
  assert.equal(resolveProviderForRole(config, 'benchmark'), 'deepseek');
});

test('resolveProviderForRole: critique role defaults to glm', () => {
  const config = loadConfig();
  assert.equal(resolveProviderForRole(config, 'critique'), 'glm');
});

test('defaultFanoutProviders excludes a provider marked reviewFanout: false', () => {
  const config = loadConfig();
  assert.deepEqual(defaultFanoutProviders(config), ['deepseek', 'glm'],
    'opt-in provider tiers and OpenRouter experiments must not join the default review fan-out');
});

test('defaultFanoutProviders includes any provider without an explicit reviewFanout: false', () => {
  const config = loadConfig();
  config.providers.openai = { name: 'openai', baseUrl: 'https://example.test/v1', model: 'gpt-test', apiKey: 'k' };
  assert.deepEqual(defaultFanoutProviders(config), ['deepseek', 'glm', 'openai']);
});

test('benchmarkProviders returns explicit lists, named presets, and the default role list', () => {
  const config = loadConfig();
  assert.deepEqual(benchmarkProviders(config, { providers: 'deepseek, glm-openrouter ' }), ['deepseek', 'glm-openrouter']);
  assert.deepEqual(
    benchmarkProviders(config, { preset: 'openrouter-cheap' }),
    ['minimax-openrouter', 'kimi-openrouter', 'qwen-coder-openrouter']
  );
  assert.deepEqual(benchmarkProviders(config), ['deepseek', 'glm']);
});

test('benchmarkProviders rejects unknown presets', () => {
  const config = loadConfig();
  assert.throws(() => benchmarkProviders(config, { preset: 'does-not-exist' }), /Unknown benchmark preset/);
});

test('parseArgs: handles --key value, --key=value, and boolean flags', () => {
  const args = parseArgs(['--task', 'do the thing', '--files=a.js,b.js', '--apply'], { flags: ['apply'] });
  assert.equal(args.task, 'do the thing');
  assert.equal(args.files, 'a.js,b.js');
  assert.equal(args.apply, true);
});

test('savePatch keeps the backward-compatible Claude path by default', () => {
  const filePath = savePatch('deepseek', 'diff --git a/x b/x\n');
  assert.ok(existsSync(filePath));
  assert.match(filePath, /\.claude\/multi-model\/patches\/.+-deepseek\.diff$/);
  unlinkSync(filePath);
});

test('savePatch isolates Codex output when MULTI_MODEL_CLIENT=codex', () => {
  const savedClient = process.env.MULTI_MODEL_CLIENT;
  process.env.MULTI_MODEL_CLIENT = 'codex';
  try {
    const filePath = savePatch('deepseek', 'diff --git a/x b/x\n');
    assert.match(filePath, /\.codex\/multi-model\/patches\/.+-deepseek\.diff$/);
    unlinkSync(filePath);
  } finally {
    if (savedClient === undefined) {
      delete process.env.MULTI_MODEL_CLIENT;
    } else {
      process.env.MULTI_MODEL_CLIENT = savedClient;
    }
  }
});

test('multiModelClient rejects unsupported state namespaces', () => {
  const savedClient = process.env.MULTI_MODEL_CLIENT;
  process.env.MULTI_MODEL_CLIENT = 'unknown-client';
  try {
    assert.throws(() => multiModelClient(), /Unsupported MULTI_MODEL_CLIENT/);
  } finally {
    if (savedClient === undefined) {
      delete process.env.MULTI_MODEL_CLIENT;
    } else {
      process.env.MULTI_MODEL_CLIENT = savedClient;
    }
  }
});

test('savePatch never collides across two calls for the same provider in the same millisecond', () => {
  const [pathA, pathB] = [
    savePatch('deepseek', 'diff --git a/x b/x\n+a\n'),
    savePatch('deepseek', 'diff --git a/x b/x\n+b\n'),
  ];
  assert.notEqual(pathA, pathB);
  assert.ok(existsSync(pathA));
  assert.ok(existsSync(pathB));
  unlinkSync(pathA);
  unlinkSync(pathB);
});

test('envFilePath falls back to the main checkout\'s .secrets when a worktree has none of its own', () => {
  const mainRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'mm-config-main-')));
  const git = (args, cwd = mainRoot) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  let worktreeRoot;
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(path.join(mainRoot, 'README.md'), 'base\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);

    mkdirSync(path.join(mainRoot, '.secrets'), { recursive: true });
    writeFileSync(path.join(mainRoot, '.secrets', 'multi-model.env'), 'DEEPSEEK_API_KEY=from-main\n');

    worktreeRoot = path.join(tmpdir(), `mm-config-worktree-${Date.now()}`);
    git(['worktree', 'add', '-q', '-b', 'feature/worktree-secrets', worktreeRoot]);

    assert.equal(envFilePath(worktreeRoot), path.join(mainRoot, '.secrets', 'multi-model.env'));
  } finally {
    if (worktreeRoot) {
      try { git(['worktree', 'remove', '--force', worktreeRoot]); } catch { /* best effort */ }
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
    rmSync(mainRoot, { recursive: true, force: true });
  }
});

test('envFilePath prefers a worktree-local .secrets file over the main checkout\'s', () => {
  const mainRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'mm-config-main-')));
  const git = (args, cwd = mainRoot) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  let worktreeRoot;
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(path.join(mainRoot, 'README.md'), 'base\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);

    mkdirSync(path.join(mainRoot, '.secrets'), { recursive: true });
    writeFileSync(path.join(mainRoot, '.secrets', 'multi-model.env'), 'DEEPSEEK_API_KEY=from-main\n');

    worktreeRoot = path.join(tmpdir(), `mm-config-worktree-local-${Date.now()}`);
    git(['worktree', 'add', '-q', '-b', 'feature/worktree-secrets-local', worktreeRoot]);
    mkdirSync(path.join(worktreeRoot, '.secrets'), { recursive: true });
    writeFileSync(path.join(worktreeRoot, '.secrets', 'multi-model.env'), 'DEEPSEEK_API_KEY=from-worktree\n');

    assert.equal(envFilePath(worktreeRoot), path.join(worktreeRoot, '.secrets', 'multi-model.env'));
  } finally {
    if (worktreeRoot) {
      try { git(['worktree', 'remove', '--force', worktreeRoot]); } catch { /* best effort */ }
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
    rmSync(mainRoot, { recursive: true, force: true });
  }
});

test('defaultUsageLogPath resolves to the main checkout so worktree spend lands in one ledger', () => {
  const mainRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'mm-usage-main-')));
  const git = (args, cwd = mainRoot) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  let worktreeRoot;
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(path.join(mainRoot, 'README.md'), 'base\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);

    worktreeRoot = path.join(tmpdir(), `mm-usage-worktree-${Date.now()}`);
    git(['worktree', 'add', '-q', '-b', 'feature/usage-ledger', worktreeRoot]);

    assert.equal(
      defaultUsageLogPath(worktreeRoot),
      path.join(mainRoot, '.claude', 'multi-model', 'usage.jsonl')
    );
    assert.equal(
      defaultUsageLogPath(mainRoot),
      path.join(mainRoot, '.claude', 'multi-model', 'usage.jsonl')
    );
  } finally {
    if (worktreeRoot) {
      try { git(['worktree', 'remove', '--force', worktreeRoot]); } catch { /* best effort */ }
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
    rmSync(mainRoot, { recursive: true, force: true });
  }
});

test('defaultUsageLogPath isolates Codex usage from Claude usage', () => {
  process.env.MULTI_MODEL_CLIENT = 'codex';
  try {
    assert.equal(
      defaultUsageLogPath('/tmp/example-repo'),
      path.join('/tmp/example-repo', '.codex', 'multi-model', 'usage.jsonl')
    );
  } finally {
    process.env.MULTI_MODEL_CLIENT = 'claude';
  }
});

test('defaultCallLogPath resolves to the main checkout so worktree failures land in one ledger', () => {
  const mainRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'mm-call-main-')));
  const git = (args, cwd = mainRoot) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  let worktreeRoot;
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(path.join(mainRoot, 'README.md'), 'base\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);

    worktreeRoot = path.join(tmpdir(), `mm-call-worktree-${Date.now()}`);
    git(['worktree', 'add', '-q', '-b', 'feature/call-ledger', worktreeRoot]);

    assert.equal(
      defaultCallLogPath(worktreeRoot),
      path.join(mainRoot, '.claude', 'multi-model', 'calls.jsonl')
    );
    assert.equal(
      defaultCallLogPath(mainRoot),
      path.join(mainRoot, '.claude', 'multi-model', 'calls.jsonl')
    );
  } finally {
    if (worktreeRoot) {
      try { git(['worktree', 'remove', '--force', worktreeRoot]); } catch { /* best effort */ }
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
    rmSync(mainRoot, { recursive: true, force: true });
  }
});

test('defaultCallLogPath isolates Codex calls from Claude calls', () => {
  process.env.MULTI_MODEL_CLIENT = 'codex';
  try {
    assert.equal(
      defaultCallLogPath('/tmp/example-repo'),
      path.join('/tmp/example-repo', '.codex', 'multi-model', 'calls.jsonl')
    );
  } finally {
    process.env.MULTI_MODEL_CLIENT = 'claude';
  }
});

test('envFilePath honors MULTI_MODEL_ENV_FILE regardless of worktree fallback', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'mm-config-override-'));
  process.env.MULTI_MODEL_ENV_FILE = '/custom/path/.env';
  try {
    assert.equal(envFilePath(cwd), '/custom/path/.env');
  } finally {
    delete process.env.MULTI_MODEL_ENV_FILE;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('envFilePath returns the worktree-local default path when neither location has a secrets file', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'mm-config-none-'));
  try {
    assert.equal(envFilePath(cwd), path.join(cwd, '.secrets', 'multi-model.env'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('loadConfig honors MULTI_MODEL_LOCAL_CONFIG as a custom overlay path and off as a disable switch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-localcfg-'));
  const overlayPath = path.join(dir, 'overlay.json');
  writeFileSync(overlayPath, JSON.stringify({
    providers: {
      extra: {
        baseUrlEnv: 'EXTRA_BASE_URL',
        defaultBaseUrl: 'https://extra.example/v1',
        apiKeyEnv: 'EXTRA_API_KEY',
        modelEnv: 'EXTRA_MODEL',
        defaultModel: 'extra-model',
      },
    },
    roles: { planning: 'extra' },
  }));
  const savedEnv = process.env.MULTI_MODEL_LOCAL_CONFIG;
  try {
    process.env.MULTI_MODEL_LOCAL_CONFIG = overlayPath;
    const merged = loadConfig();
    assert.ok(merged.providers.extra, 'custom overlay path must be merged');
    assert.equal(merged.providers.extra.model, 'extra-model');
    assert.equal(merged.roles.planning, 'extra');

    process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';
    const isolated = loadConfig();
    assert.equal(isolated.providers.extra, undefined,
      'off must ignore every machine-local overlay so tests stay hermetic');
    assert.equal(isolated.roles.planning, 'deepseek');
  } finally {
    process.env.MULTI_MODEL_LOCAL_CONFIG = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultOutcomeLogPath resolves to the main checkout so worktree outcomes land in one ledger', () => {
  const mainRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'mm-outcome-main-')));
  const git = (args, cwd = mainRoot) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  let worktreeRoot;
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    writeFileSync(path.join(mainRoot, 'README.md'), 'base\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);

    worktreeRoot = path.join(tmpdir(), `mm-outcome-worktree-${Date.now()}`);
    git(['worktree', 'add', '-q', '-b', 'feature/outcome-ledger', worktreeRoot]);

    assert.equal(
      defaultOutcomeLogPath(worktreeRoot),
      path.join(mainRoot, '.claude', 'multi-model', 'outcomes.jsonl')
    );
    assert.equal(
      defaultOutcomeLogPath(mainRoot),
      path.join(mainRoot, '.claude', 'multi-model', 'outcomes.jsonl')
    );
  } finally {
    if (worktreeRoot) {
      try { git(['worktree', 'remove', '--force', worktreeRoot]); } catch { /* best effort */ }
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
    rmSync(mainRoot, { recursive: true, force: true });
  }
});

test('defaultOutcomeLogPath isolates Codex outcomes from Claude outcomes', () => {
  process.env.MULTI_MODEL_CLIENT = 'codex';
  try {
    assert.equal(
      defaultOutcomeLogPath('/tmp/example-repo'),
      path.join('/tmp/example-repo', '.codex', 'multi-model', 'outcomes.jsonl')
    );
  } finally {
    process.env.MULTI_MODEL_CLIENT = 'claude';
  }
});

test('resolveOutcomeLogFile: explicit false disables logging', () => {
  assert.equal(resolveOutcomeLogFile({ outcomeLogFile: false }), null);
});

test('resolveOutcomeLogFile: explicit string path wins over the default', () => {
  assert.equal(resolveOutcomeLogFile({ outcomeLogFile: '/tmp/custom-outcomes.jsonl' }), '/tmp/custom-outcomes.jsonl');
});

test('resolveOutcomeLogFile: MULTI_MODEL_OUTCOME_LOG=off disables logging', () => {
  const saved = process.env.MULTI_MODEL_OUTCOME_LOG;
  process.env.MULTI_MODEL_OUTCOME_LOG = 'off';
  try {
    assert.equal(resolveOutcomeLogFile(), null);
  } finally {
    if (saved === undefined) delete process.env.MULTI_MODEL_OUTCOME_LOG;
    else process.env.MULTI_MODEL_OUTCOME_LOG = saved;
  }
});

test('resolveOutcomeLogFile: falls back to defaultOutcomeLogPath with no options or env', () => {
  const saved = process.env.MULTI_MODEL_OUTCOME_LOG;
  delete process.env.MULTI_MODEL_OUTCOME_LOG;
  try {
    assert.equal(resolveOutcomeLogFile(), defaultOutcomeLogPath());
  } finally {
    if (saved !== undefined) process.env.MULTI_MODEL_OUTCOME_LOG = saved;
  }
});

test('resolveCallLogFile: disable values, env path, explicit override, and default', () => {
  const savedEnv = process.env.MULTI_MODEL_CALL_LOG;
  try {
    for (const disable of ['off', '0', 'false']) {
      process.env.MULTI_MODEL_CALL_LOG = disable;
      assert.equal(resolveCallLogFile({}), null, `env ${disable} must disable call logging`);
    }
    process.env.MULTI_MODEL_CALL_LOG = '/custom/calls.jsonl';
    assert.equal(resolveCallLogFile({}), '/custom/calls.jsonl');
    assert.equal(resolveCallLogFile({ callLogFile: '/explicit-calls.jsonl' }), '/explicit-calls.jsonl');
    assert.equal(resolveCallLogFile({ callLogFile: false }), null);
    delete process.env.MULTI_MODEL_CALL_LOG;
    assert.equal(resolveCallLogFile({}), defaultCallLogPath());
  } finally {
    process.env.MULTI_MODEL_CALL_LOG = savedEnv;
  }
});

test('providersForRole returns every provider for a role and rejects unknown roles', () => {
  const config = loadConfig();
  assert.deepEqual(providersForRole(config, 'reviewSubstitute'), ['deepseek-flash', 'deepseek-pro']);
  assert.deepEqual(providersForRole(config, 'implementation'), ['deepseek-pro']);
  assert.throws(() => providersForRole(config, 'nope'), /unknown role "nope"/);
});
