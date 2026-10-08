import { benchmarkProviders, loadConfig, parseArgs } from './config.js';
import { callChatCompletion, isProviderConfigured } from './providers.js';

export async function benchmark({ task, providers, preset }, deps = {}) {
  const config = deps.config || loadConfig();
  const call = deps.callChatCompletion || callChatCompletion;
  const candidateProviders = benchmarkProviders(config, { providers, preset });
  const messages = [{ role: 'user', content: task }];

  const results = [];
  for (const name of candidateProviders) {
    if (!isProviderConfigured(config, name)) {
      results.push({ provider: name, status: 'not-configured' });
      continue;
    }
    try {
      const response = await call(config, name, messages, { noFallback: true });
      results.push({
        provider: name,
        status: 'ok',
        model: response.model,
        latencyMs: response.latencyMs,
        usage: response.usage,
        responseLength: response.content.length,
        preview: response.content.slice(0, 200),
      });
    } catch (err) {
      results.push({ provider: name, status: 'error', message: err.message });
    }
  }
  return { results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error('Usage: benchmark.js --task "..." [--providers deepseek,glm | --preset openrouter-cheap]');
    process.exit(2);
  }
  try {
    const { results } = await benchmark({ task: args.task, providers: args.providers, preset: args.preset });
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    console.error(`multi-model benchmark failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
