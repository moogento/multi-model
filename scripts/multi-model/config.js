import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(SCRIPT_DIR, 'config.default.json');

function repoRoot() {
  return process.cwd();
}

// .secrets/ is gitignored and not linked into feature worktrees the way vendor/ is
// (moo-worktree-vendor.sh only links vendor/), so a worktree-only lookup finds nothing
// even when the user configured secrets once in the main checkout.
function mainCheckoutRoot(cwd) {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return path.resolve(cwd, commonDir, '..');
  } catch {
    return cwd;
  }
}

export function multiModelClient() {
  const client = (process.env.MULTI_MODEL_CLIENT || 'claude').trim().toLowerCase();
  if (!['claude', 'codex'].includes(client)) {
    throw new Error(`Unsupported MULTI_MODEL_CLIENT: ${client}`);
  }
  return client;
}

function stateDirectory(cwd = repoRoot()) {
  return path.join(cwd, `.${multiModelClient()}`, 'multi-model');
}

export function defaultUsageLogPath(cwd = repoRoot()) {
  return path.join(stateDirectory(mainCheckoutRoot(cwd)), 'usage.jsonl');
}

export function defaultCallLogPath(cwd = repoRoot()) {
  return path.join(stateDirectory(mainCheckoutRoot(cwd)), 'calls.jsonl');
}

export function defaultOutcomeLogPath(cwd = repoRoot()) {
  return path.join(stateDirectory(mainCheckoutRoot(cwd)), 'outcomes.jsonl');
}

export function resolveCallLogFile(options = {}) {
  if (options.callLogFile === false) return null;
  if (typeof options.callLogFile === 'string') return options.callLogFile;
  const env = process.env.MULTI_MODEL_CALL_LOG;
  if (env === 'off' || env === '0' || env === 'false') return null;
  if (env) return env;
  return defaultCallLogPath();
}

export function resolveOutcomeLogFile(options = {}) {
  if (options.outcomeLogFile === false) return null;
  if (typeof options.outcomeLogFile === 'string') return options.outcomeLogFile;
  const env = process.env.MULTI_MODEL_OUTCOME_LOG;
  if (env === 'off' || env === '0' || env === 'false') return null;
  if (env) return env;
  return defaultOutcomeLogPath();
}

export function envFilePath(cwd = repoRoot()) {
  if (process.env.MULTI_MODEL_ENV_FILE) {
    return path.resolve(cwd, process.env.MULTI_MODEL_ENV_FILE);
  }
  const worktreeCandidate = path.resolve(cwd, '.secrets', 'multi-model.env');
  if (existsSync(worktreeCandidate)) return worktreeCandidate;
  const mainCandidate = path.resolve(mainCheckoutRoot(cwd), '.secrets', 'multi-model.env');
  return existsSync(mainCandidate) ? mainCandidate : worktreeCandidate;
}

dotenv.config({ path: envFilePath(), quiet: true });

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function deepMerge(base, override) {
  if (!override) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function localConfigFile() {
  const env = process.env.MULTI_MODEL_LOCAL_CONFIG;
  if (env === 'off' || env === '0' || env === 'false') return null;
  if (env) return path.resolve(repoRoot(), env);
  return path.join(stateDirectory(), 'config.local.json');
}

function numberSetting(envName, fallback) {
  if (!envName || process.env[envName] === undefined || process.env[envName] === '') {
    return fallback;
  }
  const value = Number(process.env[envName]);
  return Number.isFinite(value) ? value : fallback;
}

export function loadConfig() {
  let config = readJson(DEFAULT_CONFIG_PATH);
  const localConfigPath = localConfigFile();
  if (localConfigPath && existsSync(localConfigPath)) {
    config = deepMerge(config, readJson(localConfigPath));
  }
  config.limits = {
    maxInputChars: Number(process.env.MULTI_MODEL_MAX_INPUT_CHARS) || 150000,
    maxOutputTokens: Number(process.env.MULTI_MODEL_MAX_OUTPUT_TOKENS) || 16384,
    reviewMaxInputChars: Number(process.env.MULTI_MODEL_REVIEW_MAX_INPUT_CHARS) || 180000,
    reviewMaxOutputTokens: Number(process.env.MULTI_MODEL_REVIEW_MAX_OUTPUT_TOKENS) || 8192,
  };
  for (const [name, provider] of Object.entries(config.providers)) {
    provider.name = name;
    provider.baseUrl = process.env[provider.baseUrlEnv] || provider.defaultBaseUrl;
    provider.model = process.env[provider.modelEnv] || provider.defaultModel;
    provider.apiKey = process.env[provider.apiKeyEnv] || '';
    provider.maxInputChars = numberSetting(provider.maxInputCharsEnv, provider.maxInputChars);
    provider.maxOutputTokens = numberSetting(provider.maxOutputTokensEnv, provider.maxOutputTokens);
    provider.timeoutMs = numberSetting(provider.timeoutMsEnv, provider.timeoutMs);
    provider.retries = numberSetting(provider.retriesEnv, provider.retries);
    provider.retryDelayMs = numberSetting(provider.retryDelayMsEnv, provider.retryDelayMs);
  }
  return config;
}

export function resolveProviderForRole(config, role, explicitProvider) {
  if (explicitProvider) return explicitProvider;
  const roleValue = config.roles[role];
  return Array.isArray(roleValue) ? roleValue[0] : roleValue;
}

/**
 * Returns every provider listed for a role, or throws when the role is not configured
 */
export function providersForRole(config, role) {
  const roleValue = config.roles[role];
  if (!roleValue) throw new Error(`unknown role "${role}"`);
  return Array.isArray(roleValue) ? roleValue : [roleValue];
}

export function defaultFanoutProviders(config) {
  return Object.keys(config.providers).filter((name) => config.providers[name].reviewFanout !== false);
}

function splitProviderList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  return value.split(',').map((name) => name.trim()).filter(Boolean);
}

export function benchmarkProviders(config, { providers, preset } = {}) {
  const explicitProviders = splitProviderList(providers);
  if (explicitProviders) return explicitProviders;
  if (preset) {
    const selected = config.benchmarkPresets?.[preset];
    if (!Array.isArray(selected)) {
      throw new Error(`Unknown benchmark preset: ${preset}`);
    }
    return selected;
  }
  const roleValue = config.roles.benchmark;
  return Array.isArray(roleValue) ? roleValue : [roleValue];
}

export function parseArgs(argv, { flags = [] } = {}) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key.includes('=')) {
      const [k, ...rest] = key.split('=');
      args[k] = rest.join('=');
      continue;
    }
    if (flags.includes(key)) {
      args[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function diffStats(diffText) {
  const files = (diffText.match(/^diff --git/gm) || []).length;
  const added = (diffText.match(/^\+(?!\+\+ )/gm) || []).length;
  const removed = (diffText.match(/^-(?!-- )/gm) || []).length;
  return { files, added, removed };
}

export function savePatch(provider, content, { subdir = 'patches', extension = 'diff' } = {}) {
  const dir = path.join(stateDirectory(), subdir);
  mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(3).toString('hex');
  const filePath = path.join(dir, `${timestamp()}-${suffix}-${provider}.${extension}`);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}
