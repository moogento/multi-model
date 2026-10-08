import { loadConfig, parseArgs, savePatch, diffStats, defaultFanoutProviders } from './config.js';
import { callChatCompletion, isProviderConfigured } from './providers.js';
import { buildImplementMessages, extractDiff } from './prompt-builder.js';

export async function altImplement({ task, files }, deps = {}) {
  const config = deps.config || loadConfig();
  const call = deps.callChatCompletion || callChatCompletion;
  const save = deps.savePatch || savePatch;
  const messages = buildImplementMessages(task, files);

  const results = [];
  for (const providerName of defaultFanoutProviders(config)) {
    if (!isProviderConfigured(config, providerName)) continue;
    let response;
    try {
      response = await call(config, providerName, messages);
    } catch (err) {
      console.error(`multi-model: ${providerName} implement call failed: ${err.message}`);
      results.push({ provider: providerName, error: err.message });
      continue;
    }
    const diff = extractDiff(response.content);
    const patchPath = save(providerName, diff);
    results.push({ provider: providerName, model: response.model, diff, patchPath, stats: diffStats(diff) });
  }
  return { results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task || !args.files) {
    console.error('Usage: alt-implement.js --task "..." --files "path1,path2"');
    process.exit(2);
  }
  const files = args.files.split(',').map((f) => f.trim()).filter(Boolean);
  try {
    const { results } = await altImplement({ task: args.task, files });
    if (results.length === 0) {
      console.error('No providers configured. Run mm-provider to check.');
      process.exit(1);
    }
    for (const r of results) {
      if (r.error) {
        console.error(`${r.provider}: failed - ${r.error}`);
        continue;
      }
      console.log(`${r.provider} (${r.model}): ${r.patchPath} - files=${r.stats.files} +${r.stats.added}/-${r.stats.removed}`);
    }
    if (!results.some((r) => r.patchPath)) {
      console.error('All provider calls failed - no patches saved.');
      process.exit(1);
    }
  } catch (err) {
    console.error(`multi-model alt-implement failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
