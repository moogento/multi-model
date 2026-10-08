import { loadConfig, parseArgs, resolveProviderForRole } from './config.js';
import { callChatCompletion } from './providers.js';
import { buildPlanMessages } from './prompt-builder.js';

export async function cheapPlan({ task, files, provider }, deps = {}) {
  const config = deps.config || loadConfig();
  const providerName = resolveProviderForRole(config, 'planning', provider);
  const messages = buildPlanMessages(task, files);
  const call = deps.callChatCompletion || callChatCompletion;
  const response = await call(config, providerName, messages);
  return { provider: response.provider, model: response.model, markdown: response.content };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task || !args.files) {
    console.error('Usage: cheap-plan.js --task "..." --files "path1,path2" [--provider deepseek|glm]');
    process.exit(2);
  }
  const files = args.files.split(',').map((f) => f.trim()).filter(Boolean);
  try {
    const result = await cheapPlan({ task: args.task, files, provider: args.provider });
    console.log(`# Multi-model plan draft (${result.provider} / ${result.model})\n`);
    console.log(result.markdown);
  } catch (err) {
    console.error(`multi-model plan failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
