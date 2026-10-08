import { loadConfig } from './config.js';
import { callChatCompletion } from './providers.js';

export async function callGlm(messages, options = {}) {
  const config = options.config || loadConfig();
  const call = options.callChatCompletion || callChatCompletion;
  return call(config, 'glm', messages, options);
}
