import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { claudeModels, codexModels, queryProviderCatalog } from '../scripts/lib/provider-catalogs.mjs';

function fakeCodex(respond) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.sent = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', null));
  };
  child.stdin = new Writable({ write(chunk, encoding, done) {
    const message = JSON.parse(String(chunk));
    child.sent.push(message);
    queueMicrotask(() => {
      const response = respond(message, child);
      if (response !== undefined) child.stdout.write(`${JSON.stringify({ id: message.id, ...response })}\n`);
    });
    done();
  } });
  return child;
}
const row = (model = 'gpt-model') => ({ model, displayName: 'GPT Model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] });

test('Codex handshake and model-list pagination use exact CLI IDs without inference', async () => {
  const child = fakeCodex((message) => {
    if (message.method === 'initialize') return { result: {} };
    if (message.method === 'model/list') return { result: message.params.cursor
      ? { data: [row('gpt-second')], nextCursor: null }
      : { data: [row()], nextCursor: 'next' } };
  });
  const models = await codexModels({ command: 'codex-fixture', spawnProcess: (command, args, options) => {
    assert.equal(command, 'codex-fixture');
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
    assert.notEqual(options.cwd, process.cwd());
    return child;
  } });
  assert.deepEqual(models.map((model) => model.value), ['gpt-model', 'gpt-second']);
  assert.deepEqual(models[0].efforts, ['low', 'high']);
  assert.deepEqual(child.sent.map((message) => message.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.equal(child.sent[3].params.cursor, 'next');
  assert.deepEqual(child.kills, ['SIGTERM']);
});

for (const [name, result, error] of [
  ['empty', { result: { data: [], nextCursor: null } }, /빈 모델 목록/],
  ['authentication', { error: { message: 'authentication required' } }, /authentication required/],
  ['malformed', { result: {} }, /응답 형식/],
]) test(`Codex ${name} error never falls back`, async () => {
  const child = fakeCodex((message) => message.method === 'initialize' ? { result: {} } : message.method === 'model/list' ? result : undefined);
  await assert.rejects(codexModels({ command: 'fake', spawnProcess: () => child }), error);
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('missing capability stays unknown rather than inventing effort choices', async () => {
  const child = fakeCodex((message) => message.method === 'initialize' ? { result: {} } : message.method === 'model/list' ? { result: { data: [{ model: 'gpt-model' }], nextCursor: null } } : undefined);
  const models = await codexModels({ command: 'fake', spawnProcess: () => child });
  assert.equal(models[0].efforts, null);
});

test('lookup timeout aborts and terminates the actual adapter subprocess', async () => {
  const child = fakeCodex(() => undefined);
  const result = await queryProviderCatalog('codex', { timeoutMs: 20, adapters: { codex: ({ signal }) => codexModels({ signal, command: 'fake', spawnProcess: () => child }) } });
  assert.equal(result.status, 'error');
  assert.match(result.error, /시간이 초과/);
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('cancel aborts and terminates the subprocess', async () => {
  const controller = new AbortController();
  const child = fakeCodex(() => { controller.abort(); });
  const result = await queryProviderCatalog('codex', { signal: controller.signal, adapters: { codex: ({ signal }) => codexModels({ signal, command: 'fake', spawnProcess: () => child }) } });
  assert.equal(result.status, 'error');
  assert.match(result.error, /취소/);
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('unexpected CLI exit reports failure instead of hanging', async () => {
  const child = fakeCodex((message, process) => {
    process.exitCode = 2;
    process.emit('exit', 2);
  });
  await assert.rejects(codexModels({ command: 'fake', spawnProcess: () => child }), /코드 2/);
});

test('Claude asks only supportedModels and never sends a user message', async () => {
  let input;
  let opts;
  let closed = 0;
  const models = await claudeModels({ command: '/test/claude', loadSdk: async () => ({ query({ prompt, options }) {
    input = prompt;
    opts = options;
    return { supportedModels: async () => [{ value: 'fable', displayName: 'Fable', resolvedModel: 'claude-fable-test', supportsEffort: true, supportedEffortLevels: ['low', 'max'] }], close: () => closed++ };
  } }) });
  assert.deepEqual(models[0].efforts, ['low', 'max']);
  assert.equal(models[0].resolvedModel, 'claude-fable-test');
  // The empty stream completes after cleanup and yields no user message.
  assert.deepEqual(await input.next(), { value: undefined, done: true });
  assert.equal(opts.abortController.signal.aborted, true);
  assert.equal(closed, 1);
  assert.deepEqual(opts.settingSources, []);
  assert.deepEqual(opts.tools, []);
  assert.deepEqual(opts.mcpServers, {});
  assert.equal(opts.settings.disableAllHooks, true);
  assert.equal(opts.persistSession, false);
  assert.equal(opts.pathToClaudeCodeExecutable, '/test/claude');
  assert.deepEqual(opts.extraArgs, { 'strict-mcp-config': null });
});

test('Claude timeout closes an unresponsive SDK session without a prompt', async () => {
  let closed = 0;
  const result = await queryProviderCatalog('claude', { timeoutMs: 20, adapters: { claude: ({ signal }) => claudeModels({ signal, command: 'fake', loadSdk: async () => ({ query: () => ({
    supportedModels: () => new Promise(() => {}), close: () => closed++,
  }) }) }) } });
  assert.equal(result.status, 'error');
  assert.equal(closed, 1);
});

test('Claude explicit no-effort support yields no choices, and empty response fails', async () => {
  const run = (models) => claudeModels({ command: 'fake', loadSdk: async () => ({ query: () => ({ supportedModels: async () => models, close() {} }) }) });
  assert.deepEqual((await run([{ value: 'haiku', supportsEffort: false }]))[0].efforts, []);
  await assert.rejects(run([]), /빈 모델 목록/);
});

test('actual CLI ultra effort is preserved with per-model capability differences', async () => {
  const child = fakeCodex((message) => message.method === 'initialize' ? { result: {} } : message.method === 'model/list' ? { result: { data: [
    { ...row('gpt-sol'), supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultra' }] },
    row('gpt-luna'),
  ], nextCursor: null } } : undefined);
  const models = await codexModels({ command: 'fake', spawnProcess: () => child });
  assert.deepEqual(models[0].efforts, ['high', 'ultra']);
  assert.deepEqual(models[1].efforts, ['low', 'high']);
});
