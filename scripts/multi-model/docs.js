import { loadConfig, parseArgs, resolveProviderForRole, savePatch } from './config.js';
import { callChatCompletion } from './providers.js';
import { buildDocsMessages, extractDiff } from './prompt-builder.js';

export async function draftDocs({ task, files, mode, provider }, deps = {}) {
  const config = deps.config || loadConfig();
  const providerName = resolveProviderForRole(config, 'documentation', provider);
  const resolvedMode = mode === 'diff' ? 'diff' : 'markdown';
  const messages = buildDocsMessages(task, files, resolvedMode);
  const call = deps.callChatCompletion || callChatCompletion;
  const response = await call(config, providerName, messages);
  const save = deps.savePatch || savePatch;

  if (resolvedMode === 'diff') {
    const diff = extractDiff(response.content);
    const outPath = save(providerName, diff, { subdir: 'patches', extension: 'diff' });
    return { provider: response.provider, model: response.model, mode: 'diff', content: diff, outPath };
  }

  const outPath = save(providerName, response.content, { subdir: 'drafts', extension: 'md' });
  return { provider: response.provider, model: response.model, mode: 'markdown', content: response.content, outPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task || !args.files) {
    console.error('Usage: docs.js --task "..." --files "path1,path2" [--mode diff|markdown] [--provider glm|deepseek]');
    process.exit(2);
  }
  const files = args.files.split(',').map((f) => f.trim()).filter(Boolean);
  try {
    const result = await draftDocs({ task: args.task, files, mode: args.mode, provider: args.provider });
    console.log(`Saved ${result.mode} draft from ${result.provider} (${result.model}) to ${result.outPath}`);
  } catch (err) {
    console.error(`multi-model docs failed: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
