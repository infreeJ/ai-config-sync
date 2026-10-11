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

const claudeRow = { value: 'fable', displayName: 'Fable', resolvedModel: 'claude-fable-test', supportsEffort: true, supportedEffortLevels: ['low', 'max'] };
const claudeReply = (message, models = [claudeRow]) => ({ type: 'control_response', response: {
  request_id: message.request_id, subtype: 'success', response: { models },
} });
const runClaude = (child, options = {}) => claudeModels({ command: 'claude-fixture', spawnProcess: () => child, ...options });

test('Claude sends only initialize and isolates hooks, settings, tools, MCP and persistence', async () => {
  const child = fakeCodex((message, process) => {
    assert.equal(process.stdin.writableEnded, false, 'stdin must stay open until the response');
    return claudeReply(message);
  });
  const models = await runClaude(child, { spawnProcess(command, args, options) {
    assert.equal(command, 'claude-fixture');
    assert.deepEqual(args, [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--no-session-persistence', '--setting-sources', '',
      '--settings', '{"disableAllHooks":true}', '--tools', '',
      '--strict-mcp-config', '--disable-slash-commands',
    ]);
    assert.notEqual(options.cwd, process.cwd());
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    return child;
  } });
  assert.deepEqual(models, [{ value: 'fable', label: 'Fable', resolvedModel: 'claude-fable-test', efforts: ['low', 'max'] }]);
  assert.deepEqual(child.sent, [{ type: 'control_request', request_id: 'ai-config-sync-initialize', request: { subtype: 'initialize' } }]);
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('Claude accepts fragmented and consecutive JSON lines and matches the request ID', async () => {
  const child = fakeCodex((message, process) => {
    const unrelated = claudeReply({ request_id: 'another-request' }, [{ value: 'wrong' }]);
    const payload = `${JSON.stringify({ type: 'system', subtype: 'status' })}\n${JSON.stringify(unrelated)}\n${JSON.stringify(claudeReply(message))}\n`;
    process.stdout.write(payload.slice(0, 11));
    process.stdout.write(payload.slice(11, 31));
    process.stdout.write(payload.slice(31));
  });
  assert.equal((await runClaude(child))[0].value, 'fable');
});

for (const [name, output, error] of [
  ['empty models', (message) => claudeReply(message, []), /빈 모델 목록/],
  ['missing models', (message) => ({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response: {} } }), /응답 형식.*호환/],
  ['error response', (message) => ({ type: 'control_response', response: { request_id: message.request_id, subtype: 'error', error: 'PRIVATE_CONFIG' } }), /초기화에 실패/],
  ['unknown response subtype', (message) => ({ type: 'control_response', response: { request_id: message.request_id, subtype: 'future' } }), /응답 형식.*호환/],
  ['unexpected control request', () => ({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool' } }), /응답 형식.*호환/],
  ['null JSON', () => null, /응답 형식.*호환/],
  ['array JSON', () => [], /응답 형식.*호환/],
  ['missing type', () => ({}), /응답 형식.*호환/],
  ['malformed control envelope', () => ({ type: 'control_response', response: {} }), /응답 형식.*호환/],
  ['invalid model ID', (message) => claudeReply(message, [{ value: 'bad model' }]), /모델 ID/],
  ['invalid effort', (message) => claudeReply(message, [{ value: 'fable', supportedEffortLevels: ['invented'] }]), /추론 수준/],
]) test(`Claude ${name} fails and terminates without fallback or private output`, async () => {
  const child = fakeCodex((message, process) => {
    process.stderr.write('PRIVATE_CONFIG');
    return output(message);
  });
  await assert.rejects(runClaude(child), (failure) => {
    assert.match(failure.message, error);
    assert.doesNotMatch(failure.message, /PRIVATE_CONFIG/);
    return true;
  });
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(child.sent.length, 1);
});

test('Claude malformed JSON fails without exposing its content', async () => {
  const child = fakeCodex((message, process) => { process.stdout.write('PRIVATE_CONFIG invalid-json\n'); });
  await assert.rejects(runClaude(child), (failure) => {
    assert.match(failure.message, /올바르지 않은 JSON/);
    assert.doesNotMatch(failure.message, /PRIVATE_CONFIG/);
    return true;
  });
  assert.deepEqual(child.kills, ['SIGTERM']);
});

for (const kind of ['spawn', 'stdin', 'exit']) test(`Claude ${kind} failure ends lookup and cleans up`, async () => {
  const child = fakeCodex((message, process) => {
    if (kind === 'exit') {
      process.exitCode = 2;
      process.emit('exit', 2);
    } else (kind === 'spawn' ? process : process.stdin).emit('error', new Error('PRIVATE_CONFIG'));
  });
  await assert.rejects(runClaude(child), (failure) => {
    assert.match(failure.message, kind === 'exit' ? /코드 2/ : /실패/);
    assert.doesNotMatch(failure.message, /PRIVATE_CONFIG/);
    return true;
  });
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.kills, kind === 'exit' ? [] : ['SIGTERM']);
});

for (const stream of ['stdout', 'stderr']) test(`Claude ${stream} read failure is private and terminates lookup`, async () => {
  const child = fakeCodex((message, process) => {
    process[stream].destroy(new Error('READ_FAILURE_PRIVATE'));
  });
  const result = await queryProviderCatalog('claude', { adapters: { claude: () => runClaude(child) } });
  assert.equal(result.status, 'error');
  assert.match(result.error, /통신에 실패/);
  assert.doesNotMatch(result.error, /READ_FAILURE_PRIVATE/);
  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('Claude absorbs late stdout and stderr errors after readline closes', async () => {
  const child = fakeCodex((message) => claudeReply(message));
  assert.equal((await runClaude(child))[0].value, 'fable');
  child.stdout.destroy(new Error('LATE_STDOUT_PRIVATE'));
  child.stderr.destroy(new Error('LATE_STDERR_PRIVATE'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('Claude timeout aborts and terminates the subprocess without a prompt', async () => {
  const child = fakeCodex(() => undefined);
  const result = await queryProviderCatalog('claude', { timeoutMs: 20, adapters: { claude: ({ signal }) => runClaude(child, { signal }) } });
  assert.equal(result.status, 'error');
  assert.match(result.error, /시간이 초과/);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(child.sent.length, 1);
});

test('Claude cancellation terminates the subprocess and pre-cancel never spawns', async () => {
  const controller = new AbortController();
  const child = fakeCodex(() => controller.abort());
  const result = await queryProviderCatalog('claude', { signal: controller.signal, adapters: { claude: ({ signal }) => runClaude(child, { signal }) } });
  assert.equal(result.status, 'error');
  assert.match(result.error, /취소/);
  assert.deepEqual(child.kills, ['SIGTERM']);
  await assert.rejects(claudeModels({ signal: controller.signal, command: 'fake', spawnProcess() { assert.fail('cancelled lookup spawned'); } }), /취소/);
});

test('Claude cleanup escalates to SIGKILL if SIGTERM does not exit', async () => {
  const child = fakeCodex((message) => claudeReply(message));
  let killed;
  const exited = new Promise((resolve) => { killed = resolve; });
  child.kill = (signal) => {
    child.kills.push(signal);
    if (signal === 'SIGKILL') {
      child.signalCode = signal;
      child.emit('exit', null);
      killed();
    }
  };
  // The production fallback timer is unref'ed; this handle keeps the fixture alive.
  const keepAlive = setTimeout(() => {}, 2000);
  try { await runClaude(child); await exited; } finally { clearTimeout(keepAlive); }
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
});

test('Claude effort absence, no-support, deduplication and source retain the menu contract', async () => {
  const child = fakeCodex((message) => claudeReply(message, [
    { value: 'haiku', supportsEffort: false, supportedEffortLevels: ['invalid-but-unsupported'] },
    { value: 'sonnet' },
    { ...claudeRow, supportedEffortLevels: ['low', 'max', 'max'] },
    claudeRow,
  ]));
  const result = await queryProviderCatalog('claude', { adapters: { claude: () => runClaude(child) } });
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'Claude CLI stream-json initialize');
  assert.deepEqual(result.models.map(({ value, efforts }) => ({ value, efforts })), [
    { value: 'haiku', efforts: [] }, { value: 'sonnet', efforts: null }, { value: 'fable', efforts: ['low', 'max'] },
  ]);
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
