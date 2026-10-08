import { loadConfig, parseArgs, resolveProviderForRole } from './config.js';
import { callChatCompletion } from './providers.js';
import { buildExplainMessages } from './prompt-builder.js';

export async function explain({ files, symbol, provider }, deps = {}) {
  const config = deps.config || loadConfig();
  const providerName = resolveProviderForRole(config, 'explanation', provider);
  const messages = buildExplainMessages(files, symbol);
  const call = deps.callChatCompletion || callChatCompletion;
  const response = await call(config, providerName, messages);
  return { provider: response.provider, model: response.model, markdown: response.content };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.files) {
    console.error('Usage: explain.js --files "path1,path2" [--symbol name] [--provider glm|deepseek]');
    process.exit(2);
  }
  const files = args.files.split(',').map((f) => f.trim()).filter(Boolean);
  try {
    const result = await explain({ files, symbol: args.symbol, provider: args.provider });
    console.log(`# Explanation (${result.provider} / ${result.model})\n`);
    console.log(result.markdown);
  } catch (err) {
    console.error(`multi-model explain failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
