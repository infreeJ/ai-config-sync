import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { configureSync, saveSyncConfig } from '../scripts/configure-sync.mjs';
import { loadSyncConfig } from '../scripts/lib/sync-config.mjs';

function fixture(t, config) {
  const root = mkdtempSync(join(tmpdir(), 'ai-config-menu-'));
  // A private trash location under /tmp keeps test cleanup within the sandbox.
  t.after(() => execFileSync('trash-put', ['--trash-dir', join(tmpdir(), 'ai-config-test-trash'), root]));
  mkdirSync(join(root, 'config'));
  cpSync(new URL('../config/sync.config.default.json', import.meta.url), join(root, 'config', 'sync.config.default.json'));
  if (config !== undefined) writeFileSync(join(root, 'config', 'sync.config.json'), JSON.stringify(config));
  return root;
}

async function menu(root, answers, onOutput) {
  const input = new PassThrough();
  input.isTTY = true;
  let text = '';
  const output = new Writable({ write(chunk, encoding, done) { text += chunk; onOutput?.(String(chunk)); done(); } });
  output.isTTY = true;
  const running = configureSync({ root, input, output });
  input.end(answers);
  await running;
  return text;
}

test('menu creates settings without sources and edits all general fields', async (t) => {
  const root = fixture(t);
  await menu(root, '1\n3\n2\n1\n3\n2\n4\n4\ninvalid\n0.5\n37\n5\n2\n6\n2\n7\ny\n');
  const { config } = loadSyncConfig(root);
  assert.equal(config.instructionsMode, 'sidecar');
  assert.equal(config.preCommitSync, 'on');
  assert.equal(config.backup, 'off');
  assert.equal(config.backupRetentionCount, 37);
  assert.equal(config.providers.claude, false);
  assert.equal(config.providers.codex, false);
  assert.equal(config.providers.antigravity, false);
  assert.equal(existsSync(join(root, 'sources')), false);
});

test('save preserves custom mappings, Antigravity and unrelated keys', async (t) => {
  const root = fixture(t, { custom: { keep: true }, providers: { antigravity: true }, modelPresets: { flagship: { codex: 'custom-model', antigravity: 'pro' } }, effortPresets: { high: { codex: 'xhigh' } } });
  const before = loadSyncConfig(root).config;
  await menu(root, '3\n2\n7\ny\n');
  const after = loadSyncConfig(root).config;
  assert.deepEqual(after.modelPresets, before.modelPresets);
  assert.deepEqual(after.effortPresets, before.effortPresets);
  assert.deepEqual(after.custom, before.custom);
  assert.equal(after.providers.antigravity, true);
});

for (const answers of ['1\n4\n0\n', '3\n2\n', '4\n0\n0\n', '7\nn\n0\n']) {
  test(`cancel or EOF preserves existing bytes: ${JSON.stringify(answers)}`, async (t) => {
    const root = fixture(t, { instructionsMode: 'append' });
    const file = loadSyncConfig(root).file;
    const before = readFileSync(file, 'utf8');
    await menu(root, answers);
    assert.equal(readFileSync(file, 'utf8'), before);
  });
}

test('invalid JSON remains unchanged', async (t) => {
  const root = fixture(t);
  const file = join(root, 'config', 'sync.config.json');
  writeFileSync(file, '{invalid');
  await assert.rejects(menu(root, '7\ny\n'), SyntaxError);
  assert.equal(readFileSync(file, 'utf8'), '{invalid');
});

test('external changes prevent overwrite and first-save creation races', (t) => {
  const root = fixture(t);
  const snapshot = loadSyncConfig(root);
  writeFileSync(snapshot.file, '{"external":true}');
  assert.throws(() => saveSyncConfig(snapshot, snapshot.config), /외부에서 변경/);
  assert.equal(readFileSync(snapshot.file, 'utf8'), '{"external":true}');
});

test('save error preserves destination and validation precedes writing', (t) => {
  const root = fixture(t);
  const snapshot = loadSyncConfig(root);
  assert.throws(() => saveSyncConfig(snapshot, { ...snapshot.config, backupRetentionCount: 0 }), /backupRetentionCount/);
  assert.equal(existsSync(snapshot.file), false);
  const blocker = join(root, 'not-directory');
  writeFileSync(blocker, 'keep');
  assert.throws(() => saveSyncConfig({ ...snapshot, file: join(blocker, 'config.json') }, snapshot.config));
  assert.equal(readFileSync(blocker, 'utf8'), 'keep');
});

test('SIGINT cancels before save', async (t) => {
  const root = fixture(t);
  const output = await menu(root, '1\n4\n7\ny\n', (chunk) => {
    if (chunk.includes('저장하시겠습니까')) process.emit('SIGINT');
  });
  assert.match(output, /취소했습니다/);
  assert.equal(existsSync(join(root, 'config', 'sync.config.json')), false);
});

test('noninteractive CLI rejects before creating config', () => {
  const result = spawnSync(process.execPath, ['scripts/configure-sync.mjs'], { encoding: 'utf8', input: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /대화형 터미널/);
});
