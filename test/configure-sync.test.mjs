import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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

async function menu(root, answers, onOutput, queryCatalog) {
  const input = new PassThrough();
  input.isTTY = true;
  let text = '';
  const output = new Writable({ write(chunk, encoding, done) { text += chunk; onOutput?.(String(chunk)); done(); } });
  output.isTTY = true;
  const running = configureSync({ root, input, output, queryCatalog });
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

const liveCatalog = async (provider) => ({ status: 'ready', source: 'test CLI', models: [
  { value: provider === 'claude' ? 'fable' : 'gpt-test', label: `${provider} model`, resolvedModel: provider === 'claude' ? 'claude-test' : undefined, efforts: ['low', 'medium', 'high', 'max'] },
] });

test('edits all twelve presets from CLI choices and preserves Antigravity', async (t) => {
  const root = fixture(t, { providers: { antigravity: true }, modelPresets: { flagship: { claude: 'opus', codex: 'gpt-existing', antigravity: 'pro', extra: true } } });
  const answers = [];
  for (const field of [8, 9]) for (let slot = 1; slot <= 6; slot++) answers.push(field, slot, field === 8 ? 1 : 4);
  answers.push(7, 'y');
  const text = await menu(root, `${answers.join('\n')}\n`, undefined, liveCatalog);
  const { config } = loadSyncConfig(root);
  for (const preset of ['flagship', 'balanced', 'fast']) {
    assert.equal(config.modelPresets[preset].claude, 'fable');
    assert.equal(config.modelPresets[preset].codex, 'gpt-test');
  }
  for (const preset of ['low', 'medium', 'high']) {
    assert.equal(config.effortPresets[preset].claude, 'max');
    assert.equal(config.effortPresets[preset].codex, 'max');
  }
  assert.equal(config.modelPresets.flagship.antigravity, 'pro');
  assert.equal(config.modelPresets.flagship.extra, true);
  assert.equal(config.providers.antigravity, true);
  assert.match(text, /원본 에이전트가 없어/);
  assert.match(text, /claude-test/);
  assert.doesNotMatch(text, /Antigravity 동기화/);
});

test('lookup failure restricts preset changes but allows general edits and retry', async (t) => {
  const root = fixture(t);
  const before = loadSyncConfig(root).config;
  let calls = 0;
  const text = await menu(root, '8\n1\n1\n0\n3\n2\n7\ny\n', undefined, async () => {
    calls++;
    return { status: 'error', models: [], error: '인증 실패' };
  });
  assert.equal(calls, 2);
  assert.match(text, /인증 실패/);
  assert.match(text, /변경할 수 없습니다/);
  const after = loadSyncConfig(root).config;
  assert.equal(after.backup, 'off');
  assert.deepEqual(after.modelPresets, before.modelPresets);
});

test('missing effort capability disables effort editing without fallback', async (t) => {
  const root = fixture(t);
  const text = await menu(root, '9\n1\n0\n7\ny\n', undefined, async () => ({ status: 'ready', models: [{ value: 'fable', label: 'Fable', efforts: null }] }));
  assert.match(text, /추론 지원 정보가 없어/);
  assert.equal(loadSyncConfig(root).config.effortPresets.low.claude, 'low');
});

test('save checks actual independent preset combinations and permits correction', async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'sources', 'agents'), { recursive: true });
  writeFileSync(join(root, 'sources', 'agents', 'fast-high.md'), '---\nname: fast-high\ndescription: Example\nmodel: fast\neffort: high\n---\nBody');
  const catalog = async () => ({ status: 'ready', models: [
    { value: 'haiku', label: 'Haiku', efforts: ['low'] },
    { value: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] },
  ] });
  // high -> low is valid; then fast -> sonnet, high -> high are independently valid.
  const text = await menu(root, '8\n5\n2\n9\n5\n1\n8\n5\n1\n9\n5\n2\n7\n8\n5\n2\n7\ny\n', undefined, catalog);
  assert.match(text, /fast-high.md.*haiku은 high을 지원하지 않습니다/);
  assert.match(text, /저장할 수 없습니다/);
  assert.equal(loadSyncConfig(root).config.modelPresets.fast.claude, 'sonnet');
});

test('inherited model emits a concrete unverifiable capability notice', async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'sources', 'agents'), { recursive: true });
  writeFileSync(join(root, 'sources', 'agents', 'inherited.md'), '---\nname: inherited\ndescription: Example\neffort: high\n---\nBody');
  const text = await menu(root, '9\n5\n4\n7\ny\n', undefined, liveCatalog);
  assert.match(text, /inherited.md.*모델을 상속하므로/);
  assert.equal(loadSyncConfig(root).config.effortPresets.high.claude, 'max');
});


test('ultra from Codex catalog is restricted by the actual model and can be corrected', async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'sources', 'agents'), { recursive: true });
  writeFileSync(join(root, 'sources', 'agents', 'ultra-agent.md'), '---\nname: ultra-agent\ndescription: Example\nmodel: fast\neffort: high\n---\nBody');
  const catalog = async () => ({ status: 'ready', models: [
    { value: 'gpt-luna', label: 'Luna', efforts: ['high'] },
    { value: 'gpt-sol', label: 'Sol', efforts: ['high', 'ultra'] },
  ] });
  const text = await menu(root, '8\n6\n1\n9\n6\n2\n7\n8\n6\n2\n7\ny\n', undefined, catalog);
  assert.match(text, /ultra-agent.md.*gpt-luna은 ultra을 지원하지 않습니다/);
  assert.equal(loadSyncConfig(root).config.modelPresets.fast.codex, 'gpt-sol');
  assert.equal(loadSyncConfig(root).config.effortPresets.high.codex, 'ultra');
});

test('symlinked source agent is checked, while hidden draft is ignored like sync', async (t) => {
  const root = fixture(t, { modelPresets: { fast: { claude: 'opus', codex: 'gpt-test' } } });
  const agents = join(root, 'sources', 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'target.txt'), '---\nname: linked\ndescription: Example\nmodel: fast\neffort: high\n---\nBody');
  symlinkSync('target.txt', join(agents, 'linked.md'));
  writeFileSync(join(agents, '.draft.md'), '---\nname: draft\ndescription: Example\nmodel: unknown\n---\nBody');
  const catalog = async () => ({ status: 'ready', models: [
    { value: 'haiku', label: 'Haiku', efforts: ['low'] },
    { value: 'sonnet', label: 'Sonnet', efforts: ['high'] },
  ] });
  const text = await menu(root, '8\n5\n1\n7\n8\n5\n2\n7\ny\n', undefined, catalog);
  // The symlinked haiku + high combination is rejected; sonnet + high is valid.
  assert.doesNotMatch(text, /draft.md/);
  assert.match(text, /linked.md.*haiku은 high을 지원하지 않습니다/);
  assert.equal(existsSync(join(root, 'config', 'sync.config.json')), true);
});

test('Ctrl+C during lookup preserves edits and returns to the menu', async (t) => {
  const root = fixture(t);
  const text = await menu(root, '3\n2\n8\n1\n0\n7\ny\n', undefined, async (provider, { signal }) => {
    process.emit('SIGINT');
    assert.equal(signal.aborted, true);
    return { status: 'error', error: '모델 조회를 취소했습니다.', models: [] };
  });
  assert.match(text, /모델 조회를 취소했습니다/);
  assert.equal(loadSyncConfig(root).config.backup, 'off');
});

test('missing effort mapping blocks save even when model is inherited', async (t) => {
  const root = fixture(t, { effortPresets: { high: { codex: 'high' } } });
  mkdirSync(join(root, 'sources', 'agents'), { recursive: true });
  writeFileSync(join(root, 'sources', 'agents', 'missing-effort.md'), '---\nname: missing-effort\ndescription: Example\neffort: high\n---\nBody');
  const text = await menu(root, '8\n1\n1\n7\n9\n5\n4\n7\ny\n', undefined, liveCatalog);
  assert.match(text, /missing-effort.md.*추론 프리셋 매핑이 누락/);
  assert.match(text, /모델을 상속하므로/);
  assert.equal(loadSyncConfig(root).config.effortPresets.high.claude, 'max');
});

test('failed refresh restricts new selections but keeps earlier verified draft and general edits saveable', async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'sources', 'agents'), { recursive: true });
  writeFileSync(join(root, 'sources', 'agents', 'already-verified.md'), '---\nname: already-verified\ndescription: Example\nmodel: fast\neffort: high\n---\nBody');
  let calls = 0;
  const text = await menu(root, '8\n5\n1\n8\n1\n2\n0\n3\n2\n7\ny\n', undefined, async (provider) => {
    calls++;
    return calls === 1 ? liveCatalog(provider) : { status: 'error', error: '재조회 인증 실패', models: [] };
  });
  assert.equal(calls, 2);
  assert.match(text, /조회 상태: 실패 — 재조회 인증 실패/);
  assert.match(text, /조회 실패로 이 항목은 변경할 수 없습니다/);
  const { config } = loadSyncConfig(root);
  assert.equal(config.modelPresets.fast.claude, 'fable');
  assert.equal(config.modelPresets.flagship.claude, 'opus');
  assert.equal(config.backup, 'off');
});
