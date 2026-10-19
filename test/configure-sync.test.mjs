import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { configureSync, saveSyncConfig } from '../scripts/configure-sync.mjs';
import { loadSyncConfig } from '../scripts/lib/sync-config.mjs';

function fixture(t, config) {
  const root = mkdtempSync(join(tmpdir(), 'ai-config-menu-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'config'));
  cpSync(new URL('../config/sync.config.default.json', import.meta.url), join(root, 'config', 'sync.config.default.json'));
  if (config !== undefined) writeFileSync(join(root, 'config', 'sync.config.json'), JSON.stringify(config));
  return root;
}

async function menu(root, answers, onOutput, queryCatalog, env = { NO_COLOR: '' }) {
  const input = new PassThrough();
  input.isTTY = true;
  let text = '';
  const output = new Writable({ write(chunk, encoding, done) { text += chunk; onOutput?.(String(chunk)); done(); } });
  output.isTTY = true;
  const running = configureSync({ root, input, output, queryCatalog, env });
  input.end(answers);
  await running;
  return text;
}

test('menu creates settings without sources and edits all general fields', async (t) => {
  const root = fixture(t);
  await menu(root, '1\n2\n2\n1\n3\n2\n4\n4\ninvalid\n0.5\n37\n5\n2\n6\n2\n9\ny\n');
  const { config } = loadSyncConfig(root);
  assert.equal(config.instructionsMode, 'managed');
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
  await menu(root, '3\n2\n9\ny\n');
  const after = loadSyncConfig(root).config;
  assert.deepEqual(after.modelPresets, before.modelPresets);
  assert.deepEqual(after.effortPresets, before.effortPresets);
  assert.deepEqual(after.custom, before.custom);
  assert.equal(after.providers.antigravity, true);
});

for (const answers of ['1\n4\n0\n', '3\n2\n', '4\n0\n0\n', '9\nn\n0\n']) {
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
  await assert.rejects(menu(root, '9\ny\n'), SyntaxError);
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

function withFsMocks(t, replacements, run) {
  const mocks = Object.entries(replacements).map(([name, implementation]) => t.mock.method(fs, name, implementation));
  syncBuiltinESMExports();
  try { return run(); }
  finally {
    mocks.forEach((mock) => mock.mock.restore());
    syncBuiltinESMExports();
  }
}

test('successful save leaves no temporary file', (t) => {
  const root = fixture(t);
  const snapshot = loadSyncConfig(root);
  saveSyncConfig(snapshot, snapshot.config);
  assert.deepEqual(JSON.parse(readFileSync(snapshot.file, 'utf8')), snapshot.config);
  assert.deepEqual(readdirSync(join(root, 'config')).sort(), ['sync.config.default.json', 'sync.config.json']);
});

test('rename failure removes the generated temporary file and preserves destination', (t) => {
  const root = fixture(t, { custom: 'keep' });
  const snapshot = loadSyncConfig(root);
  const failure = new Error('rename failed');
  withFsMocks(t, { renameSync() { throw failure; } }, () => {
    assert.throws(() => saveSyncConfig(snapshot, snapshot.config), (error) => error === failure);
  });
  assert.equal(readFileSync(snapshot.file, 'utf8'), snapshot.original);
  assert.equal(readdirSync(join(root, 'config')).some((name) => name.endsWith('.tmp')), false);
});

test('partial write failure removes the generated temporary file', (t) => {
  const root = fixture(t);
  const snapshot = loadSyncConfig(root);
  const write = fs.writeFileSync;
  const failure = new Error('write failed');
  withFsMocks(t, { writeFileSync(descriptor) { write(descriptor, 'partial'); throw failure; } }, () => {
    assert.throws(() => saveSyncConfig(snapshot, snapshot.config), (error) => error === failure);
  });
  assert.equal(existsSync(snapshot.file), false);
  assert.deepEqual(readdirSync(join(root, 'config')), ['sync.config.default.json']);
});

test('write failure stays primary when closing also fails', (t) => {
  const root = fixture(t, { custom: 'keep' });
  const snapshot = loadSyncConfig(root);
  const write = fs.writeFileSync;
  const close = fs.closeSync;
  const failure = new Error('write failed');
  withFsMocks(t, {
    writeFileSync(descriptor) { write(descriptor, 'partial'); throw failure; },
    closeSync(descriptor) { close(descriptor); throw new Error('close failed'); },
  }, () => {
    assert.throws(() => saveSyncConfig(snapshot, snapshot.config), (error) => error === failure);
  });
  assert.equal(readFileSync(snapshot.file, 'utf8'), snapshot.original);
  assert.equal(readdirSync(join(root, 'config')).some((name) => name.endsWith('.tmp')), false);
});

test('close failure after successful writing prevents replacement and removes temporary', (t) => {
  const root = fixture(t, { custom: 'keep' });
  const snapshot = loadSyncConfig(root);
  const close = fs.closeSync;
  const failure = new Error('close failed');
  withFsMocks(t, { closeSync(descriptor) { close(descriptor); throw failure; } }, () => {
    assert.throws(() => saveSyncConfig(snapshot, snapshot.config), (error) => error === failure);
  });
  assert.equal(readFileSync(snapshot.file, 'utf8'), snapshot.original);
  assert.equal(readdirSync(join(root, 'config')).some((name) => name.endsWith('.tmp')), false);
});

test('cleanup failure retains the original save error and remaining temporary path', (t) => {
  const root = fixture(t, { custom: 'keep' });
  const snapshot = loadSyncConfig(root);
  const failure = new Error('rename failed');
  let temporary;
  withFsMocks(t, {
    renameSync() { throw failure; },
    unlinkSync(file) { temporary = file; throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' }); },
  }, () => {
    assert.throws(() => saveSyncConfig(snapshot, snapshot.config), (error) => error === failure);
  });
  assert.equal(failure.message, `rename failed 임시 파일을 보존했습니다: ${temporary}`);
  assert.equal(existsSync(temporary), true);
  assert.equal(readFileSync(snapshot.file, 'utf8'), snapshot.original);
});

test('external change after temporary writing is preserved and temporary is removed', (t) => {
  const root = fixture(t, { custom: 'keep' });
  const snapshot = loadSyncConfig(root);
  const write = fs.writeFileSync;
  withFsMocks(t, { writeFileSync(descriptor, contents) {
    write(descriptor, contents);
    write(snapshot.file, 'external change');
  } }, () => {
    assert.throws(() => saveSyncConfig(snapshot, snapshot.config), /외부에서 변경/);
  });
  assert.equal(readFileSync(snapshot.file, 'utf8'), 'external change');
  assert.equal(readdirSync(join(root, 'config')).some((name) => name.endsWith('.tmp')), false);
});

test('exclusive creation collision preserves the preexisting temporary path', (t) => {
  const root = fixture(t);
  const snapshot = loadSyncConfig(root);
  const open = fs.openSync;
  let temporary;
  withFsMocks(t, { openSync(file, flags, mode) {
    temporary = file;
    writeFileSync(file, 'preexisting');
    return open(file, flags, mode);
  } }, () => {
    assert.throws(() => saveSyncConfig(snapshot, snapshot.config), { code: 'EEXIST' });
  });
  assert.equal(readFileSync(temporary, 'utf8'), 'preexisting');
  assert.equal(existsSync(snapshot.file), false);
});

test('SIGINT cancels before save', async (t) => {
  const root = fixture(t);
  const output = await menu(root, '1\n4\n9\ny\n', (chunk) => {
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
  for (const field of [7, 8]) for (const provider of [1, 2]) {
    answers.push(field, provider);
    for (let preset = 1; preset <= 3; preset++) answers.push(preset, field === 7 ? 1 : 4);
    answers.push(0, 0);
  }
  answers.push(9, 'y');
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
  const text = await menu(root, '7\n1\n1\n1\n0\n0\n0\n3\n2\n9\ny\n', undefined, async () => {
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
  const text = await menu(root, '8\n1\n1\n0\n0\n0\n9\ny\n', undefined, async () => ({ status: 'ready', models: [{ value: 'fable', label: 'Fable', efforts: null }] }));
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
  const text = await menu(root, '7\n1\n3\n2\n0\n0\n8\n1\n3\n1\n0\n0\n7\n1\n3\n1\n0\n0\n8\n1\n3\n2\n0\n0\n9\n7\n1\n3\n2\n0\n0\n9\ny\n', undefined, catalog);
  assert.match(text, /fast-high.md.*haiku은 high을 지원하지 않습니다/);
  assert.match(text, /저장할 수 없습니다/);
  assert.equal(loadSyncConfig(root).config.modelPresets.fast.claude, 'sonnet');
});

test('inherited model emits a concrete unverifiable capability notice', async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'sources', 'agents'), { recursive: true });
  writeFileSync(join(root, 'sources', 'agents', 'inherited.md'), '---\nname: inherited\ndescription: Example\neffort: high\n---\nBody');
  const text = await menu(root, '8\n1\n3\n4\n0\n0\n9\ny\n', undefined, liveCatalog);
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
  const text = await menu(root, '7\n2\n3\n1\n0\n0\n8\n2\n3\n2\n0\n0\n9\n7\n2\n3\n2\n0\n0\n9\ny\n', undefined, catalog);
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
  const text = await menu(root, '7\n1\n3\n1\n0\n0\n9\n7\n1\n3\n2\n0\n0\n9\ny\n', undefined, catalog);
  // The symlinked haiku + high combination is rejected; sonnet + high is valid.
  assert.doesNotMatch(text, /draft.md/);
  assert.match(text, /linked.md.*haiku은 high을 지원하지 않습니다/);
  assert.equal(existsSync(join(root, 'config', 'sync.config.json')), true);
});

test('Ctrl+C during lookup preserves edits and returns to the menu', async (t) => {
  const root = fixture(t);
  const text = await menu(root, '3\n2\n7\n1\n1\n0\n0\n0\n9\ny\n', undefined, async (provider, { signal }) => {
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
  const text = await menu(root, '7\n1\n1\n1\n0\n0\n9\n8\n1\n3\n4\n0\n0\n9\ny\n', undefined, liveCatalog);
  assert.match(text, /missing-effort.md.*추론 프리셋 매핑이 누락/);
  assert.match(text, /모델을 상속하므로/);
  assert.equal(loadSyncConfig(root).config.effortPresets.high.claude, 'max');
});

test('failed refresh restricts new selections but keeps earlier verified draft and general edits saveable', async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'sources', 'agents'), { recursive: true });
  writeFileSync(join(root, 'sources', 'agents', 'already-verified.md'), '---\nname: already-verified\ndescription: Example\nmodel: fast\neffort: high\n---\nBody');
  let calls = 0;
  const text = await menu(root, '7\n1\n3\n1\n1\n2\n0\n0\n0\n3\n2\n9\ny\n', undefined, async (provider) => {
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

for (const [field, title, presets] of [[7, '모델', ['flagship', 'balanced', 'fast']], [8, '추론', ['low', 'medium', 'high']]]) {
  test(`${title} menu selects a provider before showing only its three presets, without querying`, async (t) => {
    const root = fixture(t);
    const queried = [];
    const text = await menu(root, `${field}\n1\n0\n2\n0\n0\n0\n`, undefined, async (provider) => {
      queried.push(provider);
      return liveCatalog(provider);
    });
    assert.deepEqual(queried, []);
    const providerMenu = text.split(`${title} 프리셋 — 제공자 선택`)[1].split(`${title} 프리셋 — Claude 현재 값`)[0];
    assert.match(providerMenu, /1\. Claude\n 2\. Codex\n 0\. 돌아가기/);
    for (const provider of ['Claude', 'Codex']) {
      const providerPresets = text.split(`${title} 프리셋 — ${provider} 현재 값`)[1].split(`${title} 프리셋 — 제공자 선택`)[0];
      for (const [index, preset] of presets.entries()) assert.match(providerPresets, new RegExp(`${index + 1}\\. ${preset}:`));
      assert.doesNotMatch(providerPresets, /[4-6]\. |flagship \/|low \//);
      assert.doesNotMatch(providerPresets, provider === 'Claude' ? /gpt-5|Codex 현재 값/ : /opus|sonnet|haiku|Claude 현재 값/);
    }
    assert.equal(existsSync(join(root, 'config', 'sync.config.json')), false);
  });

  test(`${title} picker back returns to presets, then provider, then main menu`, async (t) => {
    const root = fixture(t);
    const text = await menu(root, `${field}\n1\n1\n0\n0\n0\n0\n`, undefined, liveCatalog);
    const screens = [...text.matchAll(new RegExp(`${title} 프리셋 — (제공자 선택|Claude 현재 값)|공식 조회 선택지|동기화 설정(?=\\n)`, 'g'))].map((match) => match[1] || match[0]);
    assert.deepEqual(screens, ['동기화 설정', '제공자 선택', 'Claude 현재 값', '공식 조회 선택지', 'Claude 현재 값', '제공자 선택', '동기화 설정']);
  });

  for (const answers of [`${field}\n`, `${field}\n1\n`, `${field}\n1\n1\n`, `${field}\n1\n1\n1\n`]) {
    test(`EOF cancels the whole session at ${title} depth: ${JSON.stringify(answers)}`, async (t) => {
      const root = fixture(t, { custom: 'preserve bytes' });
      const snapshot = loadSyncConfig(root);
      const text = await menu(root, answers, undefined, liveCatalog);
      assert.match(text, /취소했습니다/);
      assert.equal(readFileSync(snapshot.file, 'utf8'), snapshot.original);
    });
  }
}

for (const [field, preset] of [[7, 'flagship'], [8, 'low']]) {
  for (const [providerNumber, provider, other] of [[1, 'claude', 'codex'], [2, 'codex', 'claude']]) {
    test(`editing ${field}/${provider} queries only that provider and preserves the other provider`, async (t) => {
      const root = fixture(t);
      const before = loadSyncConfig(root).config;
      const calls = [];
      const text = await menu(root, `${field}\n${providerNumber}\n1\n${field === 7 ? 1 : 4}\n0\n0\n9\ny\n`, undefined, async (selectedProvider) => {
        calls.push(selectedProvider);
        return liveCatalog(selectedProvider);
      });
      assert.deepEqual(calls, [provider]);
      const after = loadSyncConfig(root).config;
      const editedField = field === 7 ? 'modelPresets' : 'effortPresets';
      assert.equal(after[editedField][preset][provider], field === 7 ? (provider === 'claude' ? 'fable' : 'gpt-test') : 'max');
      for (const mapping of ['modelPresets', 'effortPresets']) {
        for (const name of Object.keys(before[mapping])) assert.equal(after[mapping][name][other], before[mapping][name][other]);
      }
      const providerName = provider === 'claude' ? 'Claude' : 'Codex';
      assert.equal(text.split(`${field === 7 ? '모델' : '추론'} 프리셋 — ${providerName} 현재 값`).length - 1, 2);
    });
  }
}

for (const [name, initial, toggles, expected] of [
  ['Off to On', 'off', [1], true],
  ['On unchanged', 'on', [], false],
  ['Off unchanged', 'off', [], false],
  ['Off stays Off', 'off', [2], false],
  ['On to Off', 'on', [2], false],
  ['Off to On to Off', 'off', [1, 2], false],
  ['On to Off to On', 'on', [2, 1], false],
]) {
  test(`hook installation guidance appears only after saving a new activation: ${name}`, async (t) => {
    const root = fixture(t, { preCommitSync: initial });
    const steps = [...toggles.flatMap((toggle) => [2, toggle]), 9, 'y'];
    const text = await menu(root, `${steps.join('\n')}\n`);
    assert.equal(text.includes('Git hook 설치 안내:'), expected);
    assert.equal(text.includes('git config core.hooksPath scripts/hooks'), expected);
    assert.equal((text.match(/hook/gi) || []).length, expected ? 3 : 0);
    if (expected) assert.ok(text.indexOf('설정을 저장했습니다') < text.indexOf('Git hook 설치 안내:'));
    assert.equal(loadSyncConfig(root).config.preCommitSync, toggles.length ? (toggles.at(-1) === 1 ? 'on' : 'off') : initial);
  });
}

test('hook guidance is omitted when a new activation is cancelled', async (t) => {
  const root = fixture(t);
  const text = await menu(root, '2\n1\n9\nn\n0\n');
  assert.doesNotMatch(text, /hook/i);
  assert.equal(existsSync(join(root, 'config', 'sync.config.json')), false);
});

test('toggles use On/Off in the main menu, choices and change summary while JSON stays unchanged', async (t) => {
  const root = fixture(t);
  const text = await menu(root, '2\n1\n3\n2\n5\n2\n6\n2\n9\ny\n');
  for (const label of ['커밋 전 자동 동기화: Off', '변경 전 백업: On', 'Claude 동기화: On', 'Codex 동기화: On', 'preCommitSync: Off → On', 'backup: On → Off', 'claude: On → Off', 'codex: On → Off']) assert.ok(text.includes(label), label);
  assert.match(text, /1\. On\n 2\. Off\n 0\. 돌아가기/);
  assert.doesNotMatch(text, /켬|끔|\(true\)|\(false\)|\(on\)|\(off\)/);
  const { config } = loadSyncConfig(root);
  assert.equal(config.preCommitSync, 'on');
  assert.equal(config.backup, 'off');
  assert.equal(config.providers.claude, false);
  assert.equal(config.providers.codex, false);
});

test('TTY menus distinguish titles, numbers, current values and errors with ANSI colors', async (t) => {
  const root = fixture(t);
  const text = await menu(root, 'invalid\n0\n', undefined, undefined, { TERM: 'xterm-256color' });
  assert.match(text, /\x1b\[1;34m동기화 설정/);
  assert.match(text, /\x1b\[34m1\.\x1b\[0m/);
  assert.match(text, /\x1b\[1;32mOn\x1b\[0m/);
  assert.match(text, /\x1b\[31m표시된 번호를 입력해 주세요\.\x1b\[0m/);
  const plain = await menu(root, 'invalid\n0\n');
  assert.equal(text.replace(/\x1b\[[\d;]*m/g, ''), plain);
});

for (const env of [{ NO_COLOR: '' }, { NO_COLOR: '1', TERM: 'xterm' }, { TERM: 'dumb' }]) {
  test(`ANSI colors are disabled for ${JSON.stringify(env)}`, async (t) => {
    const root = fixture(t);
    const text = await menu(root, 'invalid\n0\n', undefined, undefined, env);
    assert.doesNotMatch(text, /\x1b\[/);
    assert.match(text, /동기화 설정/);
    assert.match(text, /Claude 동기화: On/);
    assert.match(text, /표시된 번호를 입력해 주세요/);
  });
}


test('removed sidecar setting prevents menu writes and explains append migration', async (t) => {
  const root = fixture(t, { instructionsMode: 'sidecar' });
  const file = join(root, 'config', 'sync.config.json');
  const before = readFileSync(file, 'utf8');
  await assert.rejects(menu(root, '9\ny\n'), /sidecar.*no longer supported.*append.*config\/sync.config.json/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('instruction menu offers append, managed and off in order', async (t) => {
  const root = fixture(t);
  const output = await menu(root, '1\n0\n0\n');
  assert.doesNotMatch(output, /sidecar/);
  assert.match(output, /1\. 기존 지시문[^\n]*\(append\)/);
  assert.match(output, /2\. 전역 지시문[^\n]*\(managed\)/);
  assert.match(output, /3\. 지시문 동기화 안 함[^\n]*\(off\)/);
});
