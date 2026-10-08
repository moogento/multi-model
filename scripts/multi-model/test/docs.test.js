import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { draftDocs } from '../docs.js';

process.env.MULTI_MODEL_LOCAL_CONFIG = 'off';
process.env.MULTI_MODEL_CLIENT = 'claude';

test('draftDocs defaults to markdown mode and saves under drafts/', async () => {
  const config = loadConfig();
  const fakeCall = async (cfg, providerName) => ({ provider: providerName, model: 'm', content: '# Guide\nSome docs.' });
  const result = await draftDocs({ task: 'document the widget', files: [] }, { config, callChatCompletion: fakeCall });
  assert.equal(result.mode, 'markdown');
  assert.match(result.outPath, /\.claude\/multi-model\/drafts\/.+\.md$/);
  assert.ok(existsSync(result.outPath));
  unlinkSync(result.outPath);
});

test('draftDocs mode=diff extracts and saves a patch', async () => {
  const config = loadConfig();
  const fakeCall = async (cfg, providerName) => ({ provider: providerName, model: 'm', content: '```diff\ndiff --git a/x.php b/x.php\n+/** doc */\n```' });
  const result = await draftDocs({ task: 'add phpdoc', files: [], mode: 'diff' }, { config, callChatCompletion: fakeCall });
  assert.equal(result.mode, 'diff');
  assert.match(result.outPath, /\.claude\/multi-model\/patches\/.+\.diff$/);
  unlinkSync(result.outPath);
});

// mirrors moo.md's Stage 8/9 commit-message/PR-draft steps: a captured diff dumped to a
// /tmp file and passed via --files, with no sensitive filename of its own to catch it.
test('draftDocs never forwards a captured diff that touches a sensitive path to the provider', async () => {
  const config = loadConfig();
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-docs-test-'));
  const diffPath = path.join(dir, 'mm-commit-diff-123.txt');
  writeFileSync(diffPath, [
    'diff --git a/.env b/.env',
    '--- a/.env',
    '+++ b/.env',
    '@@ -1 +1 @@',
    '-OLD=1',
    '+NEW=2',
    '',
  ].join('\n'));

  let sentMessages;
  const fakeCall = async (cfg, providerName, messages) => {
    sentMessages = messages;
    return { provider: providerName, model: 'm', content: 'draft commit message' };
  };

  const originalConsoleError = console.error;
  let outputPath;
  console.error = () => {};
  try {
    const result = await draftDocs(
      { task: 'draft a commit message for this diff', files: [diffPath], mode: 'markdown' },
      { config, callChatCompletion: fakeCall },
    );
    outputPath = result.outPath;
  } finally {
    console.error = originalConsoleError;
    if (outputPath && existsSync(outputPath)) unlinkSync(outputPath);
  }

  assert.ok(sentMessages, 'expected the provider to still be called with a draft-only prompt');
  const sentText = JSON.stringify(sentMessages);
  assert.doesNotMatch(sentText, /NEW=2/, `expected the secret diff line to never reach the provider payload: ${sentText}`);
  assert.match(sentText, /sensitive path/);
});
