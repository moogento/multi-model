import { benchmarkProviders, loadConfig, parseArgs } from './config.js';
import { callChatCompletion, isProviderConfigured } from './providers.js';

export async function configCheck(deps = {}) {
  const config = deps.config || loadConfig();
  const call = deps.callChatCompletion || callChatCompletion;
  const providerNames = deps.all
    ? Object.keys(config.providers)
    : deps.providers || deps.preset
      ? benchmarkProviders(config, { providers: deps.providers, preset: deps.preset })
      : Object.keys(config.providers).filter((name) => config.providers[name].configCheck !== false);
  const results = [];
  for (const name of providerNames) {
    if (!config.providers[name]) {
      results.push({ provider: name, status: 'unknown-provider' });
      continue;
    }
    if (!isProviderConfigured(config, name)) {
      results.push({ provider: name, status: 'not-configured' });
      continue;
    }
    const viaFallback = !config.providers[name].apiKey ? config.providers[name].fallbackProvider : null;
    const target = viaFallback || name;
    try {
      const response = await call(config, target, [{ role: 'user', content: 'Reply with the single word: pong' }], { maxTokens: 512, noFallback: true });
      results.push({ provider: name, status: 'ok', latencyMs: response.latencyMs, model: response.model, viaFallback });
    } catch (err) {
      results.push({ provider: name, status: 'error', message: err.message, viaFallback });
    }
  }
  return { results };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2), { flags: ['all'] });
    const { results } = await configCheck({ providers: args.providers, preset: args.preset, all: args.all });
    for (const r of results) {
      const via = r.viaFallback ? ` via fallback ${r.viaFallback}` : '';
      if (r.status === 'ok') console.log(`${r.provider}: OK (${r.latencyMs}ms, ${r.model}${via})`);
      else if (r.status === 'not-configured') console.log(`${r.provider}: not configured`);
      else if (r.status === 'unknown-provider') console.log(`${r.provider}: unknown provider`);
      else console.log(`${r.provider}: ERROR${via} - ${r.message}`);
    }
  } catch (err) {
    console.error(`multi-model config-check failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
