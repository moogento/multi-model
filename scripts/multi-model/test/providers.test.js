import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isProviderConfigured,
  callChatCompletion,
  providerMaxInputChars,
  resolveCallLogFile,
  resolveUsageLogFile,
} from '../providers.js';

process.env.MULTI_MODEL_USAGE_LOG = 'off';
process.env.MULTI_MODEL_CALL_LOG = 'off';
process.env.MULTI_MODEL_CLIENT = 'claude';

function fakeConfig(overrides = {}) {
  return {
    providers: {
      deepseek: {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        defaultModel: 'deepseek-v4-flash',
        apiKey: 'fake-key',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        ...overrides,
      },
    },
    limits: { maxInputChars: 100, maxOutputTokens: 4096 },
  };
}

test('isProviderConfigured is false without an apiKey', () => {
  const config = fakeConfig({ apiKey: '' });
  assert.equal(isProviderConfigured(config, 'deepseek'), false);
});

test('isProviderConfigured is true with an apiKey', () => {
  const config = fakeConfig();
  assert.equal(isProviderConfigured(config, 'deepseek'), true);
});

test('isProviderConfigured is true when only the fallback provider has a key', () => {
  const config = fakeConfig({ apiKey: '', fallbackProvider: 'deepseek-openrouter' });
  config.providers['deepseek-openrouter'] = {
    name: 'deepseek-openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4-flash',
    apiKey: 'or-key',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  };
  assert.equal(isProviderConfigured(config, 'deepseek'), true);
});

test('isProviderConfigured is false when neither the provider nor its fallback has a key', () => {
  const config = fakeConfig({ apiKey: '', fallbackProvider: 'deepseek-openrouter' });
  config.providers['deepseek-openrouter'] = {
    name: 'deepseek-openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4-flash',
    apiKey: '',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  };
  assert.equal(isProviderConfigured(config, 'deepseek'), false);
});

test('callChatCompletion posts to {baseUrl}/chat/completions with Bearer auth and never logs the key', async (t) => {
  const config = fakeConfig();
  let capturedUrl, capturedHeaders, capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello' } }],
        usage: { total_tokens: 5 },
      }),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]);

  assert.equal(capturedUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(capturedHeaders.Authorization, 'Bearer fake-key');
  assert.equal(capturedBody.model, 'deepseek-v4-flash');
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.content, 'hello');
  assert.deepEqual(result.usage, { total_tokens: 5 });
  assert.equal(typeof result.latencyMs, 'number');
});

test('callChatCompletion sends provider headers and extra request body fields from config', async (t) => {
  const savedReferer = process.env.OPENROUTER_HTTP_REFERER;
  const savedTitle = process.env.OPENROUTER_APP_TITLE;
  const savedEmpty = process.env.OPENROUTER_EMPTY_TEST;
  const savedEffort = process.env.GLM_REASONING_EFFORT;
  process.env.OPENROUTER_HTTP_REFERER = 'https://example.test/multi-model';
  process.env.GLM_REASONING_EFFORT = 'high';
  delete process.env.OPENROUTER_APP_TITLE;
  delete process.env.OPENROUTER_EMPTY_TEST;
  const config = fakeConfig({
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'z-ai/glm-5.2',
    defaultModel: 'z-ai/glm-5.2',
    apiKey: 'openrouter-key',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    headers: {
      'HTTP-Referer': { env: 'OPENROUTER_HTTP_REFERER', default: 'https://fallback.example' },
      'X-OpenRouter-Title': { env: 'OPENROUTER_APP_TITLE', default: 'Test multi-model' },
      'X-Empty-Header': { env: 'OPENROUTER_EMPTY_TEST' },
    },
    extraBody: {
      temperature: 0.7,
      reasoning_effort: { env: 'GLM_REASONING_EFFORT', default: 'max' },
      provider: {
        order: ['z-ai'],
        only: ['z-ai'],
        allow_fallbacks: false,
        require_parameters: true,
      },
    },
  });
  let capturedHeaders, capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (savedReferer === undefined) {
      delete process.env.OPENROUTER_HTTP_REFERER;
    } else {
      process.env.OPENROUTER_HTTP_REFERER = savedReferer;
    }
    if (savedTitle === undefined) {
      delete process.env.OPENROUTER_APP_TITLE;
    } else {
      process.env.OPENROUTER_APP_TITLE = savedTitle;
    }
    if (savedEmpty === undefined) {
      delete process.env.OPENROUTER_EMPTY_TEST;
    } else {
      process.env.OPENROUTER_EMPTY_TEST = savedEmpty;
    }
    if (savedEffort === undefined) {
      delete process.env.GLM_REASONING_EFFORT;
    } else {
      process.env.GLM_REASONING_EFFORT = savedEffort;
    }
  });

  await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], {
    extraBody: { top_p: 0.9 },
  });

  assert.equal(capturedHeaders.Authorization, 'Bearer openrouter-key');
  assert.equal(capturedHeaders['HTTP-Referer'], 'https://example.test/multi-model');
  assert.equal(capturedHeaders['X-OpenRouter-Title'], 'Test multi-model');
  assert.equal(capturedHeaders['X-Empty-Header'], undefined);
  assert.equal(capturedBody.model, 'z-ai/glm-5.2');
  assert.equal(capturedBody.temperature, 0.7);
  assert.equal(capturedBody.reasoning_effort, 'high');
  assert.equal(capturedBody.top_p, 0.9);
  assert.deepEqual(capturedBody.provider, {
    order: ['z-ai'],
    only: ['z-ai'],
    allow_fallbacks: false,
    require_parameters: true,
  });
  assert.equal(capturedBody.messages[0].content, 'hi');
});

test('callChatCompletion honors provider-specific maxInputChars and attaches request ids', async (t) => {
  const config = fakeConfig({
    maxInputChars: 200,
    requestIdPrefix: 'mm-test',
  });
  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        request_id: 'provider-request-1',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      }),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'x'.repeat(150) }]);

  assert.equal(capturedBody.messages[0].content.length, 150);
  assert.match(capturedBody.request_id, /^mm-test-/);
  assert.equal(result.requestId, 'provider-request-1');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.input, {
    inputChars: 150,
    truncatedInputChars: 0,
    maxInputChars: 200,
    inputTruncated: false,
  });
});

test('callChatCompletion truncates message content beyond maxInputChars', async (t) => {
  const config = fakeConfig();
  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const longContent = 'x'.repeat(500);
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(' '));
  let result;
  try {
    result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: longContent }]);
  } finally {
    console.error = originalConsoleError;
  }
  assert.ok(capturedBody.messages[0].content.length < 500);
  assert.match(capturedBody.messages[0].content, /truncated/);
  assert.ok(errors.some((e) => e.includes('truncated') && e.includes('deepseek')));
  assert.deepEqual(result.input, {
    inputChars: 500,
    truncatedInputChars: 400,
    maxInputChars: 100,
    inputTruncated: true,
  });
});

test('callChatCompletion applies maxInputChars across the complete message list', async (t) => {
  const config = fakeConfig();
  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const result = await callChatCompletion(config, 'deepseek', [
    { role: 'system', content: 's'.repeat(60) },
    { role: 'user', content: 'u'.repeat(80) },
  ]);

  assert.equal(capturedBody.messages.reduce((sum, message) => sum + message.content.length, 0), 100);
  assert.deepEqual(result.input, {
    inputChars: 140,
    truncatedInputChars: 40,
    maxInputChars: 100,
    inputTruncated: true,
  });
});

test('review profile reserves output context and applies review request overrides', async (t) => {
  const config = fakeConfig({
    maxInputChars: 900,
    reviewMaxInputChars: 500,
    maxOutputTokens: 80,
    reviewMaxOutputTokens: 20,
    contextWindowTokens: 100,
    estimatedCharsPerToken: 3,
    extraBody: { reasoning_effort: 'max', thinking: { type: 'enabled' } },
    reviewExtraBody: { reasoning_effort: 'low', response_format: { type: 'json_object' } },
  });
  config.limits.reviewMaxInputChars = 700;
  config.limits.reviewMaxOutputTokens = 30;
  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  assert.equal(providerMaxInputChars(config, config.providers.deepseek, { profile: 'review' }), 240);
  assert.equal(providerMaxInputChars(config, config.providers.deepseek), 900);
  const result = await callChatCompletion(config, 'deepseek', [
    { role: 'system', content: 's'.repeat(100) },
    { role: 'user', content: 'u'.repeat(200) },
  ], { profile: 'review' });

  assert.equal(capturedBody.max_tokens, 20);
  assert.equal(capturedBody.reasoning_effort, 'low');
  assert.deepEqual(capturedBody.thinking, { type: 'enabled' });
  assert.deepEqual(capturedBody.response_format, { type: 'json_object' });
  assert.equal(capturedBody.messages.reduce((sum, message) => sum + message.content.length, 0), 240);
  assert.equal(result.input.maxInputChars, 240);
});

test('review input limits never exceed the provider ordinary input ceiling', () => {
  const config = fakeConfig({ maxInputChars: 100 });
  config.limits.reviewMaxInputChars = 700;
  assert.equal(providerMaxInputChars(config, config.providers.deepseek, { profile: 'review' }), 100);
});

test('callChatCompletion honors an explicit output override in review profile', async (t) => {
  const config = fakeConfig({ reviewMaxOutputTokens: 20 });
  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], {
    profile: 'review',
    maxTokens: 7,
  });
  assert.equal(capturedBody.max_tokens, 7);
});

test('callChatCompletion keeps a tiny input budget even when the truncation note cannot fit', async (t) => {
  const config = fakeConfig({ maxInputChars: 5 });
  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'abcdefghij' }]);
  assert.equal(capturedBody.messages[0].content.length, 5);
  assert.equal(result.input.truncatedInputChars, 5);
});

test('callChatCompletion throws without leaking the key on a non-OK response', async (t) => {
  const config = fakeConfig();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'Invalid authentication' } }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]),
    (err) => {
      assert.match(err.message, /401/);
      assert.match(err.message, /Invalid authentication/);
      assert.doesNotMatch(err.message, /fake-key/);
      return true;
    }
  );
});

test('callChatCompletion throws a clear error for an unconfigured provider', async () => {
  const config = fakeConfig({ apiKey: '' });
  await assert.rejects(
    () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]),
    /not configured/
  );
});

function withSilencedConsoleError(t) {
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
}

test('callChatCompletion retries once on 429 and succeeds', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'recovered' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(result.content, 'recovered');
});

test('callChatCompletion retries once on a network error and succeeds', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'recovered' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(result.content, 'recovered');
});

test('callChatCompletion does not retry a non-429 4xx response', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 400, json: async () => ({ error: { message: 'bad request' } }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { retryDelayMs: 0 }),
    /400/
  );
  assert.equal(calls, 1);
});

test('callChatCompletion gives up after one retry on persistent 5xx', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 503, json: async () => ({ error: { message: 'overloaded' } }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  await assert.rejects(
    () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { retryDelayMs: 0 }),
    /503/
  );
  assert.equal(calls, 2);
});

test('callChatCompletion retries a non-JSON 5xx response body', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        json: async () => { throw new SyntaxError('Unexpected token <'); },
      };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'recovered' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], {
    retryDelayMs: 0,
  });
  assert.equal(result.content, 'recovered');
  assert.equal(calls, 2);
});

test('callChatCompletion does not retry Z.ai quota exhaustion and logs the business code', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: false,
      status: 429,
      headers: { get: () => '3' },
      json: async () => ({ error: { code: '1316', message: 'Usage limit reached for the past 5 hours. Resets at 2026-07-05T12:00:00Z' } }),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-zai-quota-'));
  const callLogFile = path.join(dir, 'calls.jsonl');
  try {
    await assert.rejects(
      () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { callLogFile, retryDelayMs: 0 }),
      /Usage limit reached/
    );
    assert.equal(calls, 1);
    const record = JSON.parse(readFileSync(callLogFile, 'utf8').trim());
    assert.equal(record.failureCategory, 'quota-exhausted');
    assert.equal(record.providerErrorCode, '1316');
    assert.equal(record.retryAfterMs, 3000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion retries transient Z.ai overload codes', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        json: async () => ({ error: { code: '1305', message: 'temporarily overloaded' } }),
      };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(result.content, 'recovered');
});

test('callChatCompletion honors a Retry-After above the exponential backoff cap', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => '300' },
        json: async () => ({ error: { message: 'rate limited' } }),
      };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'recovered' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    return originalSetTimeout(fn, 0);
  };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(result.content, 'recovered');
  assert.ok(delays.includes(300000), 'the Retry-After delay should not be clamped to the backoff cap');
});

test('callChatCompletion bounds a hostile Retry-After to the outer ceiling', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => '86400' },
        json: async () => ({ error: { message: 'rate limited' } }),
      };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'recovered' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    return originalSetTimeout(fn, 0);
  };
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(result.content, 'recovered');
  assert.ok(!delays.includes(86400000), 'a hostile Retry-After should not stall retries for a full day');
  assert.ok(delays.includes(600000), 'a hostile Retry-After should be bounded to the outer ceiling');
});

test('callChatCompletion appends a usage record with estimated cost when a log file is given', async (t) => {
  const config = fakeConfig({ pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28 } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 },
    }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-usage-log-'));
  const logFile = path.join(dir, 'usage.jsonl');
  try {
    await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { usageLogFile: logFile });
    const lines = readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.provider, 'deepseek');
    assert.equal(record.promptTokens, 1000);
    assert.equal(record.completionTokens, 2000);
    assert.ok(Math.abs(record.estCostUsd - 0.0007) < 1e-9);
    assert.equal(typeof record.ts, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion appends a successful call record with reliability metadata', async (t) => {
  const config = fakeConfig({ pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28 } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-call-log-'));
  const callLogFile = path.join(dir, 'calls.jsonl');
  try {
    await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hello' }], {
      callLogFile,
      command: 'consensus-review',
      runId: 'review-test-1',
      phase: 'review-chunk-2',
    });
    const record = JSON.parse(readFileSync(callLogFile, 'utf8').trim());
    assert.equal(record.provider, 'deepseek');
    assert.equal(record.requestedProvider, 'deepseek');
    assert.equal(record.command, 'consensus-review');
    assert.equal(record.runId, 'review-test-1');
    assert.equal(record.phase, 'review-chunk-2');
    assert.equal(record.ok, true);
    assert.equal(record.outcome, 'success');
    assert.equal(record.attempts, 1);
    assert.equal(record.timeoutMs, 60000);
    assert.equal(record.retries, 1);
    assert.equal(record.inputChars, 5);
    assert.equal(record.truncatedInputChars, 0);
    assert.equal(record.inputTruncated, false);
    assert.equal(record.outputChars, 2);
    assert.equal(record.promptTokens, 100);
    assert.equal(record.completionTokens, 20);
    assert.ok(Math.abs(record.estCostUsd - 0.0000196) < 1e-12);
    assert.equal(typeof record.latencyMs, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion retries once when the request times out', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    const abortErr = new Error('This operation was aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  await assert.rejects(
    () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { retryDelayMs: 0 }),
    /timed out/
  );
  assert.equal(calls, 2);
});

test('callChatCompletion keeps the timeout active while reading the response body', async (t) => {
  const config = fakeConfig({ retries: 1, retryDelayMs: 0 });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: () => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  await assert.rejects(
    () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { timeoutMs: 5 }),
    /timed out/,
  );
  assert.equal(calls, 2);
});

test('callChatCompletion retries a terminated response body stream', async (t) => {
  const config = fakeConfig({ retries: 1, retryDelayMs: 0 });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'recovered' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.content, 'recovered');
  assert.equal(calls, 2);
});

test('callChatCompletion appends a failed call record when the request times out', async (t) => {
  const config = fakeConfig();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    const abortErr = new Error('This operation was aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-call-timeout-'));
  const callLogFile = path.join(dir, 'calls.jsonl');
  try {
    await assert.rejects(
      () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'x'.repeat(500) }], { callLogFile, retryDelayMs: 0 }),
      (err) => {
        assert.match(err.message, /timed out/);
        assert.deepEqual(err.input, {
          inputChars: 500,
          truncatedInputChars: 400,
          maxInputChars: 100,
          inputTruncated: true,
        });
        return true;
      }
    );
    assert.equal(calls, 2);
    const record = JSON.parse(readFileSync(callLogFile, 'utf8').trim());
    assert.equal(record.provider, 'deepseek');
    assert.equal(record.ok, false);
    assert.equal(record.outcome, 'failed');
    assert.equal(record.failureCategory, 'timeout');
    assert.match(record.error, /timed out/);
    assert.equal(record.attempts, 2);
    assert.equal(record.timeoutMs, 60000);
    assert.equal(record.retries, 1);
    assert.equal(record.inputChars, 500);
    assert.equal(record.truncatedInputChars, 400);
    assert.equal(record.inputTruncated, true);
    assert.equal(record.promptTokens, null);
    assert.equal(record.estCostUsd, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion honors provider-specific timeout and retry settings', async (t) => {
  const config = fakeConfig({ timeoutMs: 120000, retries: 0, retryDelayMs: 0 });
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    const abortErr = new Error('This operation was aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-provider-timeout-'));
  const callLogFile = path.join(dir, 'calls.jsonl');
  try {
    await assert.rejects(
      () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { callLogFile }),
      /timed out/
    );
    assert.equal(calls, 1);
    const record = JSON.parse(readFileSync(callLogFile, 'utf8').trim());
    assert.equal(record.timeoutMs, 120000);
    assert.equal(record.retries, 0);
    assert.equal(record.attempts, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveUsageLogFile: disable values, env path, explicit override, and default', () => {
  const savedEnv = process.env.MULTI_MODEL_USAGE_LOG;
  try {
    for (const disable of ['off', '0', 'false']) {
      process.env.MULTI_MODEL_USAGE_LOG = disable;
      assert.equal(resolveUsageLogFile({}), null, `env ${disable} must disable logging`);
    }
    process.env.MULTI_MODEL_USAGE_LOG = '/custom/usage.jsonl';
    assert.equal(resolveUsageLogFile({}), '/custom/usage.jsonl');
    assert.equal(resolveUsageLogFile({ usageLogFile: '/explicit.jsonl' }), '/explicit.jsonl');
    assert.equal(resolveUsageLogFile({ usageLogFile: false }), null);
    delete process.env.MULTI_MODEL_USAGE_LOG;
    assert.match(resolveUsageLogFile({}), /\.claude\/multi-model\/usage\.jsonl$/);
  } finally {
    process.env.MULTI_MODEL_USAGE_LOG = savedEnv;
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
    assert.match(resolveCallLogFile({}), /\.claude\/multi-model\/calls\.jsonl$/);
  } finally {
    process.env.MULTI_MODEL_CALL_LOG = savedEnv;
  }
});

test('callChatCompletion logs estCostUsd as null when the provider has no pricing', async (t) => {
  const config = fakeConfig();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-usage-nopricing-'));
  const logFile = path.join(dir, 'usage.jsonl');
  try {
    await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { usageLogFile: logFile });
    const record = JSON.parse(readFileSync(logFile, 'utf8').trim());
    assert.equal(record.estCostUsd, null);
    assert.equal(record.promptTokens, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion prices cache-hit prompt tokens at the cached rate when the split is reported', async (t) => {
  const config = fakeConfig({
    pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28, cachedInputPerMTok: 0.0028 },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: {
        prompt_tokens: 3000,
        prompt_cache_hit_tokens: 2000,
        prompt_cache_miss_tokens: 1000,
        completion_tokens: 1000,
      },
    }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-usage-cache-'));
  const logFile = path.join(dir, 'usage.jsonl');
  try {
    await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { usageLogFile: logFile });
    const record = JSON.parse(readFileSync(logFile, 'utf8').trim());
    assert.ok(Math.abs(record.estCostUsd - 0.0004256) < 1e-12,
      `expected cache-aware cost 0.0004256, got ${record.estCostUsd}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion reads Z.ai cached token usage details and logs subscription value separately from spend', async (t) => {
  const config = fakeConfig({
    billing: 'subscription',
    pricing: { inputPerMTok: 1.4, outputPerMTok: 4.4 },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 3000,
        prompt_tokens_details: { cached_tokens: 2000 },
        completion_tokens: 1000,
        total_tokens: 4000,
      },
    }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-usage-zai-cache-'));
  const logFile = path.join(dir, 'usage.jsonl');
  try {
    await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { usageLogFile: logFile });
    const record = JSON.parse(readFileSync(logFile, 'utf8').trim());
    assert.equal(record.billing, 'subscription');
    assert.equal(record.cachedPromptTokens, 2000);
    assert.equal(record.totalTokens, 4000);
    assert.equal(record.estCostUsd, null);
    assert.ok(Math.abs(record.apiEquivalentCostUsd - 0.0086) < 1e-12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion logs estCostUsd as null when a non-default model is used', async (t) => {
  const config = fakeConfig({ pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28 } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 1000 },
    }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-usage-override-'));
  const logFile = path.join(dir, 'usage.jsonl');
  try {
    await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], {
      usageLogFile: logFile,
      model: 'deepseek-v4-pro',
    });
    const record = JSON.parse(readFileSync(logFile, 'utf8').trim());
    assert.equal(record.model, 'deepseek-v4-pro');
    assert.equal(record.estCostUsd, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion logs billed usage even when the response content is malformed', async (t) => {
  const config = fakeConfig({ pricing: { inputPerMTok: 0.14, outputPerMTok: 0.28 } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 0 } }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-usage-malformed-'));
  const logFile = path.join(dir, 'usage.jsonl');
  try {
    await assert.rejects(
      () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { usageLogFile: logFile }),
      /Malformed response/
    );
    const record = JSON.parse(readFileSync(logFile, 'utf8').trim());
    assert.equal(record.promptTokens, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion classifies reasoning-only length responses as output-limit failures', async (t) => {
  const config = fakeConfig({ maxOutputTokens: 8192 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: { content: '', reasoning_content: 'r'.repeat(40) },
        finish_reason: 'length',
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 8192,
        completion_tokens_details: { reasoning_tokens: 8192 },
      },
    }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-output-limit-'));
  const callLogFile = path.join(dir, 'calls.jsonl');
  try {
    await assert.rejects(
      () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], {
        callLogFile,
        noFallback: true,
      }),
      (error) => {
        assert.equal(error.failureCategory, 'output-limit');
        assert.match(error.message, /exhausted 8192 completion tokens/);
        return true;
      },
    );
    const record = JSON.parse(readFileSync(callLogFile, 'utf8').trim());
    assert.equal(record.ok, false);
    assert.equal(record.outcome, 'failed');
    assert.equal(record.failureCategory, 'output-limit');
    assert.equal(record.finishReason, 'length');
    assert.equal(record.completionTokens, 8192);
    assert.equal(record.reasoningTokens, 8192);
    assert.equal(record.reasoningChars, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion still resolves when usage logging fails', async (t) => {
  const config = fakeConfig();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  withSilencedConsoleError(t);

  const dir = mkdtempSync(path.join(tmpdir(), 'mm-usage-dir-'));
  try {
    const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { usageLogFile: dir });
    assert.equal(result.content, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('callChatCompletion sends provider maxOutputTokens as max_tokens', async (t) => {
  const config = fakeConfig({ maxOutputTokens: 32768 });
  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]);

  assert.equal(capturedBody.max_tokens, 32768);
});

function fallbackConfig({ primaryOverrides = {}, fallbackApiKey = 'or-key' } = {}) {
  const config = fakeConfig({
    fallbackProvider: 'glm-openrouter',
    retries: 0,
    retryDelayMs: 0,
    ...primaryOverrides,
  });
  config.providers['glm-openrouter'] = {
    name: 'glm-openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'z-ai/glm-5.2',
    defaultModel: 'z-ai/glm-5.2',
    apiKey: fallbackApiKey,
    apiKeyEnv: 'OPENROUTER_API_KEY',
  };
  return config;
}

test('callChatCompletion falls back to the configured fallback provider after a retryable failure', async (t) => {
  const config = fallbackConfig();
  const urls = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {};
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (String(url).includes('openrouter.ai')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'rescued' } }] }) };
    }
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]);

  assert.equal(result.provider, 'glm-openrouter');
  assert.equal(result.content, 'rescued');
  assert.equal(urls.length, 2);
});

test('callChatCompletion does not repeat a reasoning-only output-limit response through fallback', async (t) => {
  const config = fallbackConfig();
  const urls = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {};
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (String(url).includes('openrouter.ai')) {
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'rescued' } }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '', reasoning_content: 'thinking' }, finish_reason: 'length' }],
      }),
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  await assert.rejects(
    () => callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]),
    (error) => {
      assert.equal(error.failureCategory, 'output-limit');
      return true;
    },
  );
  assert.equal(urls.length, 1);
});

test('callChatCompletion falls back when the primary provider has no key', async (t) => {
  const config = fallbackConfig({ primaryOverrides: { apiKey: '' } });
  const urls = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {};
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'rescued' } }] }) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]);

  assert.equal(result.provider, 'glm-openrouter');
  assert.equal(result.content, 'rescued');
  assert.equal(urls.length, 1);
  assert.ok(String(urls[0]).includes('openrouter.ai'));
});

test('callChatCompletion does not fall back on a non-retryable client error', async (t) => {
  const config = fallbackConfig();
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({}) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]),
    /deepseek returned 400/,
  );
  assert.equal(urls.length, 1);
});

test('callChatCompletion does not fall back when the fallback provider has no key', async (t) => {
  const config = fallbackConfig({ fallbackApiKey: '' });
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {};
  globalThis.fetch = async () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) });
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  await assert.rejects(
    callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]),
    /deepseek returned 429/,
  );
});

test('callChatCompletion throws the fallback provider error when the fallback also fails', async (t) => {
  const config = fallbackConfig();
  config.providers['glm-openrouter'].retries = 0;
  config.providers['glm-openrouter'].retryDelayMs = 0;
  const urls = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {};
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  await assert.rejects(
    callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]),
    /glm-openrouter returned 429/,
  );
  assert.equal(urls.length, 2);
});

test('callChatCompletion honors options.noFallback and rethrows the primary error', async (t) => {
  const config = fallbackConfig();
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(url);
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }], { noFallback: true }),
    /deepseek returned 429/,
  );
  assert.equal(urls.length, 1);
});

test('callChatCompletion falls back on a 5xx server error', async (t) => {
  const config = fallbackConfig();
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {};
  globalThis.fetch = async (url) => {
    if (String(url).includes('openrouter.ai')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'rescued' } }] }) };
    }
    return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  const result = await callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]);
  assert.equal(result.provider, 'glm-openrouter');
});

test('callChatCompletion doubles the retry delay on each attempt', async (t) => {
  const config = fakeConfig({ retries: 2, retryDelayMs: 100 });
  const delays = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = (msg) => {
    const match = String(msg).match(/retrying in (\d+)ms/);
    if (match) delays.push(Number(match[1]));
  };
  globalThis.fetch = async () => (
    { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) }
  );
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  await assert.rejects(callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]));
  assert.deepEqual(delays, [100, 200]);
});

test('callChatCompletion classifies a DNS lookup failure as offline, not a provider failure', async (t) => {
  const config = fakeConfig({ retries: 0, timeoutMs: 1000 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(
    callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]),
    (err) => err.failureCategory === 'offline',
  );
});

test('callChatCompletion keeps a connection reset as a network error', async (t) => {
  const config = fakeConfig({ retries: 0, timeoutMs: 1000 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(
    callChatCompletion(config, 'deepseek', [{ role: 'user', content: 'hi' }]),
    (err) => err.failureCategory === 'network-error',
  );
});
