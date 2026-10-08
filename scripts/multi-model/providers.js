import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { defaultUsageLogPath, resolveCallLogFile as resolveConfiguredCallLogFile } from './config.js';

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 2000;

export function isProviderConfigured(config, providerName) {
  const provider = config.providers[providerName];
  if (!provider) return false;
  if (provider.apiKey) return true;
  const fallback = provider.fallbackProvider ? config.providers[provider.fallbackProvider] : null;
  return Boolean(fallback && fallback.apiKey);
}

function truncate(text, maxChars, providerName) {
  if (text.length <= maxChars) return text;
  console.error(`multi-model: truncated a message to ${providerName} from ${text.length} to ${maxChars} chars`);
  const note = `\n\n[...truncated ${text.length - maxChars} chars...]`;
  if (note.length >= maxChars) return note.slice(0, maxChars);
  return `${text.slice(0, maxChars - note.length)}${note}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveUsageLogFile(options = {}) {
  if (options.usageLogFile === false) return null;
  if (typeof options.usageLogFile === 'string') return options.usageLogFile;
  const env = process.env.MULTI_MODEL_USAGE_LOG;
  if (env === 'off' || env === '0' || env === 'false') return null;
  if (env) return env;
  return defaultUsageLogPath();
}

export function resolveCallLogFile(options = {}) {
  return resolveConfiguredCallLogFile(options);
}

function estimateCostUsd(pricing, usage) {
  if (!pricing || !usage) return null;
  const completionTokens = usage.completion_tokens ?? 0;
  const hitTokens = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  const missTokens = usage.prompt_cache_miss_tokens ?? (
    hitTokens != null && usage.prompt_tokens != null ? Math.max(usage.prompt_tokens - hitTokens, 0) : undefined
  );
  const inputCost = hitTokens != null && missTokens != null
    ? hitTokens * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok ?? 0)
      + missTokens * (pricing.inputPerMTok ?? 0)
    : (usage.prompt_tokens ?? 0) * (pricing.inputPerMTok ?? 0);
  return (inputCost + completionTokens * (pricing.outputPerMTok ?? 0)) / 1e6;
}

function logUsage(logFile, provider, model, usage, latencyMs, pricing, billing = 'metered') {
  if (!logFile) return;
  try {
    const estimatedCostUsd = estimateCostUsd(pricing, usage);
    const subscription = billing === 'subscription';
    const record = {
      ts: new Date().toISOString(),
      provider,
      model,
      billing,
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      cachedPromptTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
      latencyMs,
      estCostUsd: subscription ? null : estimatedCostUsd,
      apiEquivalentCostUsd: subscription ? estimatedCostUsd : null,
    };
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    console.error(`multi-model: usage logging skipped: ${err.message}`);
  }
}

function logCall(logFile, record) {
  if (!logFile) return;
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8');
  } catch (err) {
    console.error(`multi-model: call logging skipped: ${err.message}`);
  }
}

function truncateErrorMessage(message) {
  const text = String(message || '');
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function attachInputMetadata(error, input) {
  error.input = input;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEnvValue(value) {
  return isPlainObject(value)
    && typeof value.env === 'string'
    && Object.keys(value).every((key) => ['env', 'default'].includes(key));
}

function resolveConfiguredValue(value) {
  if (isEnvValue(value)) {
    if (process.env[value.env] !== undefined && process.env[value.env] !== '') {
      return process.env[value.env];
    }
    return value.default;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveConfiguredValue(item));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, resolveConfiguredValue(item)])
        .filter(([, item]) => item !== undefined),
    );
  }
  return value;
}

function mergeRequestBody(base, override) {
  if (!isPlainObject(override)) return { ...base };
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const resolved = resolveConfiguredValue(value);
    if (resolved === undefined) continue;
    if (isPlainObject(resolved) && isPlainObject(out[key])) {
      out[key] = mergeRequestBody(out[key], resolved);
    } else {
      out[key] = resolved;
    }
  }
  return out;
}

function resolveHeaderValue(value) {
  if (isPlainObject(value)) {
    if (value.env && process.env[value.env] !== undefined) {
      return process.env[value.env];
    }
    if (value.default !== undefined) return value.default;
    return '';
  }
  return value;
}

function providerHeaders(provider) {
  const headers = {};
  for (const [name, value] of Object.entries(provider.headers || {})) {
    const resolved = resolveHeaderValue(value);
    if (resolved === undefined || resolved === null || resolved === '') continue;
    headers[name] = String(resolved);
  }
  return headers;
}

function providerMaxOutputTokens(config, provider, options) {
  return options.maxTokens
    || (options.profile === 'review'
      ? provider.reviewMaxOutputTokens || config.limits.reviewMaxOutputTokens
      : null)
    || provider.maxOutputTokens
    || config.limits.maxOutputTokens;
}

export function providerMaxInputChars(config, provider, options = {}) {
  const generalMax = provider.maxInputChars ?? config.limits.maxInputChars;
  const reviewMax = provider.reviewMaxInputChars ?? config.limits.reviewMaxInputChars ?? generalMax;
  const configuredMax = options.maxInputChars
    ?? (options.profile === 'review' ? Math.min(reviewMax, generalMax) : generalMax);
  if (options.profile !== 'review') return configuredMax;

  const contextWindowTokens = Number(provider.contextWindowTokens);
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return configuredMax;

  const outputTokens = providerMaxOutputTokens(config, provider, options);
  const charsPerToken = Number(provider.estimatedCharsPerToken) || 3;
  const reservedTokens = Math.max(outputTokens, provider.outputReserveTokens || 0);
  const tokenBoundChars = Math.max(1, Math.floor((contextWindowTokens - reservedTokens) * charsPerToken));
  return Math.min(configuredMax, tokenBoundChars);
}

function requestId(provider, options) {
  if (options.requestId) return options.requestId;
  if (!provider.requestIdPrefix) return null;
  const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  return `${provider.requestIdPrefix}-${suffix}`.slice(0, 64);
}

function retryAfterMs(response) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function classifyStatus(status, providerErrorCode) {
  const code = providerErrorCode == null ? null : String(providerErrorCode);
  if (code === '1261') return 'prompt-too-long';
  if (['1113', '1308', '1309', '1310', '1311', '1315', '1316', '1317', '1318', '1319', '1320', '1321'].includes(code)) {
    return 'quota-exhausted';
  }
  if (code === '1305') return 'overloaded';
  if (code === '1302' || code === '1313') return 'rate-limit';
  if (code === '1234') return 'network-error';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server-error';
  if (status >= 400) return 'client-error';
  return 'provider-error';
}

function retryableStatus(status, providerErrorCode) {
  const code = providerErrorCode == null ? null : String(providerErrorCode);
  if (['1113', '1211', '1220', '1261', '1308', '1309', '1310', '1311', '1315', '1316', '1317', '1318', '1319', '1320', '1321'].includes(code)) {
    return false;
  }
  if (['1234', '1302', '1305'].includes(code)) return true;
  return status === 429 || status >= 500;
}

function responseError(providerName, response, errBody) {
  const providerErrorCode = errBody?.error?.code ?? null;
  const providerResetAt = errBody?.error?.next_flush_time ?? null;
  const detail = errBody?.error?.message || errBody?.message || '';
  const failure = new Error(`${providerName} returned ${response.status}${detail ? `: ${detail}` : ''}`);
  failure.retryable = retryableStatus(response.status, providerErrorCode);
  failure.httpStatus = response.status;
  failure.providerErrorCode = providerErrorCode;
  failure.providerResetAt = providerResetAt;
  failure.retryAfterMs = retryAfterMs(response);
  failure.failureCategory = classifyStatus(response.status, providerErrorCode);
  return failure;
}

const OFFLINE_ERROR_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'];

function wrapTransportError(providerName, err, stage) {
  const causeDetail = err.cause?.code || err.cause?.message;
  const reason = err.name === 'AbortError'
    ? 'timed out'
    : `${stage ? `${stage}: ` : ''}${err.message}${causeDetail ? ` (${causeDetail})` : ''}`;
  const wrapped = new Error(`${providerName} request failed: ${reason}`, { cause: err });
  wrapped.retryable = true;
  wrapped.failureCategory = err.name === 'AbortError'
    ? 'timeout'
    : (OFFLINE_ERROR_CODES.includes(err.cause?.code) ? 'offline' : 'network-error');
  return wrapped;
}

async function fetchOnce(provider, providerName, body, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        ...providerHeaders(provider),
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data;
    try {
      data = await response.json();
    } catch (err) {
      if (!response.ok && err instanceof SyntaxError) {
        return { response, data: null };
      }
      if (err.name === 'AbortError' || !(err instanceof SyntaxError)) {
        const failure = wrapTransportError(providerName, err, 'while reading the response body');
        failure.httpStatus = response.status ?? null;
        throw failure;
      }
      const failure = new Error(`${providerName} returned malformed JSON: ${err.message}`);
      failure.retryable = false;
      failure.failureCategory = 'malformed-response';
      failure.httpStatus = response.status ?? null;
      throw failure;
    }
    return { response, data };
  } catch (err) {
    if (err.failureCategory) throw err;
    throw wrapTransportError(providerName, err, '');
  } finally {
    clearTimeout(timeoutHandle);
  }
}

const FALLBACK_FAILURE_CATEGORIES = [
  'timeout',
  'network-error',
  'offline',
  'rate-limit',
  'overloaded',
  'server-error',
  'not-configured',
];
const MAX_RETRY_DELAY_MS = 120000;
const MAX_RETRY_AFTER_DELAY_MS = 600000;

export async function callChatCompletion(config, providerName, messages, options = {}) {
  const requestedProvider = options.requestedProvider || providerName;
  try {
    return await callProviderChatCompletion(config, providerName, messages, { ...options, requestedProvider });
  } catch (err) {
    const fallbackName = config.providers[providerName]?.fallbackProvider;
    const fallback = fallbackName ? config.providers[fallbackName] : null;
    const recoverable = FALLBACK_FAILURE_CATEGORIES.includes(err?.failureCategory);
    if (options.noFallback || !recoverable || !fallback?.apiKey) throw err;
    console.error(`multi-model: ${providerName} failed (${err.failureCategory}: ${truncateErrorMessage(err.message)}); retrying via fallback provider ${fallbackName}`);
    return callProviderChatCompletion(config, fallbackName, messages, {
      ...options,
      requestedProvider,
      noFallback: true,
    });
  }
}

async function callProviderChatCompletion(config, providerName, messages, options = {}) {
  const provider = config.providers[providerName];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerName}`);
  }
  if (!provider.apiKey) {
    const err = new Error(`${providerName} is not configured (missing ${provider.apiKeyEnv})`);
    err.failureCategory = 'not-configured';
    throw err;
  }

  const maxChars = providerMaxInputChars(config, provider, options);
  let inputChars = 0;
  let truncatedInputChars = 0;
  let remainingChars = maxChars;
  const truncatedMessages = messages.map((m) => {
    const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');
    inputChars += content.length;
    const limited = truncate(content, remainingChars, providerName);
    truncatedInputChars += content.length - limited.length;
    remainingChars = Math.max(0, remainingChars - limited.length);
    return { ...m, content: limited };
  });
  const inputMetadata = {
    inputChars,
    truncatedInputChars,
    maxInputChars: maxChars,
    inputTruncated: truncatedInputChars > 0,
  };

  let body = mergeRequestBody({
    model: options.model || provider.model,
    messages: truncatedMessages,
    max_tokens: providerMaxOutputTokens(config, provider, options),
    temperature: options.temperature ?? 0.2,
  }, provider.extraBody || {});
  if (options.profile === 'review') {
    body = mergeRequestBody(body, provider.reviewExtraBody || {});
  }
  body = mergeRequestBody(body, options.extraBody || {});
  const generatedRequestId = requestId(provider, options);
  if (generatedRequestId && !body.request_id) {
    body.request_id = generatedRequestId;
  }

  const timeoutMs = options.timeoutMs ?? provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? provider.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? provider.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const callLogFile = resolveCallLogFile(options);
  const callContext = {
    command: options.command || null,
    runId: options.runId || null,
    phase: options.phase || null,
    requestedProvider: options.requestedProvider || providerName,
  };
  const started = Date.now();
  let attempts = 0;

  let response;
  let data;
  for (let attempt = 0; ; attempt++) {
    attempts = attempt + 1;
    let failure = null;
    try {
      ({ response, data } = await fetchOnce(provider, providerName, body, timeoutMs));
    } catch (err) {
      failure = err;
    }
    if (!failure && !response.ok) {
      failure = responseError(providerName, response, data);
    }
    if (!failure) break;
    if (!failure.retryable || attempt >= retries) {
      logCall(callLogFile, {
        ...callContext,
        provider: providerName,
        model: body.model,
        ok: false,
        outcome: 'failed',
        failureCategory: failure.failureCategory || 'provider-error',
        error: truncateErrorMessage(failure.message),
        providerErrorCode: failure.providerErrorCode ?? null,
        providerResetAt: failure.providerResetAt ?? null,
        httpStatus: failure.httpStatus ?? null,
        requestId: body.request_id ?? null,
        finishReason: null,
        retryAfterMs: failure.retryAfterMs ?? null,
        attempts,
        timeoutMs,
        retries,
        retryDelayMs,
        latencyMs: Date.now() - started,
        ...inputMetadata,
        promptTokens: null,
        completionTokens: null,
        estCostUsd: null,
      });
      throw attachInputMetadata(failure, inputMetadata);
    }
    const backoffMs = Math.min(retryDelayMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
    const delayMs = Math.min(failure.retryAfterMs ?? backoffMs, MAX_RETRY_AFTER_DELAY_MS);
    console.error(`multi-model: ${failure.message}; retrying in ${delayMs}ms`);
    if (delayMs > 0) await sleep(delayMs);
  }

  const pricing = body.model === provider.defaultModel ? provider.pricing : null;
  const estCostUsd = estimateCostUsd(pricing, data?.usage);
  const latencyMs = Date.now() - started;
  logUsage(resolveUsageLogFile(options), providerName, body.model, data?.usage, latencyMs, pricing, provider.billing);

  const content = data?.choices?.[0]?.message?.content;
  const finishReason = data?.choices?.[0]?.finish_reason ?? null;
  const reasoning = data?.choices?.[0]?.message?.reasoning_content
    ?? data?.choices?.[0]?.message?.reasoning
    ?? '';
  const reasoningChars = typeof reasoning === 'string' ? reasoning.length : 0;
  const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
  const responseRequestId = data?.request_id ?? body.request_id ?? null;
  const outputExhausted = finishReason === 'length'
    && (content === undefined || content === null || String(content).trim() === '');
  if (outputExhausted || content === undefined || content === null) {
    const failureCategory = outputExhausted ? 'output-limit' : 'malformed-response';
    const detail = outputExhausted
      ? `exhausted ${body.max_tokens} completion tokens before returning visible content`
      : 'missing choices[0].message.content';
    const failure = attachInputMetadata(
      new Error(outputExhausted ? `${providerName} ${detail}` : `Malformed response from ${providerName}: ${detail}`),
      inputMetadata,
    );
    failure.failureCategory = failureCategory;
    failure.retryable = false;
    logCall(callLogFile, {
      ...callContext,
      provider: providerName,
      model: body.model,
      ok: false,
      outcome: 'failed',
      failureCategory,
      error: truncateErrorMessage(failure.message),
      providerErrorCode: null,
      httpStatus: response.status ?? null,
      requestId: responseRequestId,
      finishReason,
      attempts,
      timeoutMs,
      retries,
      retryDelayMs,
      latencyMs,
      ...inputMetadata,
      promptTokens: data?.usage?.prompt_tokens ?? null,
      completionTokens: data?.usage?.completion_tokens ?? null,
      reasoningTokens,
      reasoningChars,
      estCostUsd,
    });
    throw failure;
  }

  logCall(callLogFile, {
    ...callContext,
    provider: providerName,
    model: body.model,
    ok: true,
    outcome: 'success',
    failureCategory: null,
    error: null,
    providerErrorCode: null,
    httpStatus: response.status ?? null,
    requestId: responseRequestId,
    finishReason,
    attempts,
    timeoutMs,
    retries,
    retryDelayMs,
    latencyMs,
    ...inputMetadata,
    outputChars: content.length,
    promptTokens: data?.usage?.prompt_tokens ?? null,
    completionTokens: data?.usage?.completion_tokens ?? null,
    reasoningTokens,
    reasoningChars,
    estCostUsd,
  });

  return {
    provider: providerName,
    model: body.model,
    content,
    usage: data.usage,
    latencyMs,
    requestId: responseRequestId,
    finishReason,
    input: inputMetadata,
  };
}
