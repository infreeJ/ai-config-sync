import { accessSync, constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { isEffortValue, isModelValue } from './provider-values.mjs';

function executable(name) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    for (const extension of process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']) {
      const file = join(directory, `${name}${extension}`);
      try { accessSync(file, constants.X_OK); return file; } catch { /* next PATH entry */ }
    }
  }
  throw new Error(`${name} CLI를 PATH에서 찾을 수 없습니다. CLI 설치와 로그인을 확인해 주세요.`);
}

function normalize(provider, rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('CLI가 빈 모델 목록을 반환했습니다.');
  const models = rows.map((row) => {
    const value = provider === 'claude' ? row.value : row.model;
    if (!isModelValue(provider, value)) throw new Error('CLI 모델 ID가 동기화 출력 계약과 맞지 않습니다. CLI와 도구 버전을 확인해 주세요.');
    const rawEfforts = provider === 'claude' ? row.supportedEffortLevels : row.supportedReasoningEfforts?.map((effort) => effort.reasoningEffort);
    const efforts = provider === 'claude' && row.supportsEffort === false ? [] : rawEfforts;
    if (efforts !== undefined && (!Array.isArray(efforts) || efforts.some((effort) => !isEffortValue(provider, effort)))) {
      throw new Error(`${value}: CLI 추론 수준이 동기화 출력 계약과 맞지 않습니다. CLI와 도구 버전을 확인해 주세요.`);
    }
    return { value, label: row.displayName || value, resolvedModel: row.resolvedModel, efforts: efforts === undefined ? null : [...new Set(efforts)] };
  });
  return models.filter((model, index) => models.findIndex((other) => other.value === model.value) === index);
}

// No thread or inference turn is created. Only initialization and model/list RPCs.
export async function codexModels({ signal, spawnProcess = spawn, command = executable('codex') } = {}) {
  const child = spawnProcess(command, ['app-server', '--listen', 'stdio://'], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  let failure;
  const fail = (error) => {
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const abort = () => fail(new Error('모델 조회를 취소했습니다.'));
  child.on('error', (error) => fail(new Error(`Codex CLI 실행 실패: ${error.message}`)));
  child.stdin.on('error', (error) => fail(new Error(`Codex CLI 통신 실패: ${error.message}`)));
  // Do not display raw stderr: CLI errors may include private configuration.
  child.stderr.resume();
  child.on('exit', (code) => fail(new Error(`Codex CLI가 조회 중 종료되었습니다 (코드 ${code ?? 'signal'}). 설치·인증 상태를 확인해 주세요.`)));
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error('Codex CLI가 올바르지 않은 JSON을 반환했습니다.')); return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`Codex model/list 오류: ${message.error.message || '인증 및 CLI 상태를 확인해 주세요.'}`));
    else waiter.resolve(message.result);
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  signal?.addEventListener('abort', abort, { once: true });
  let killTimer;
  try {
    if (signal?.aborted) throw new Error('모델 조회를 취소했습니다.');
    await request('initialize', { clientInfo: { name: 'ai_config_sync', title: 'AI Config Sync', version: '0.1.0' } });
    send({ method: 'initialized', params: {} });
    const models = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data)) throw new Error('Codex CLI 모델 목록 응답 형식이 잘못되었습니다.');
      models.push(...page.data);
      cursor = page.nextCursor;
      if (cursor != null && (typeof cursor !== 'string' || cursor === '' || cursors.has(cursor) || cursors.size >= 100)) {
        throw new Error('Codex CLI 모델 목록의 페이지 커서가 잘못되었습니다.');
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return normalize('codex', models);
  } finally {
    signal?.removeEventListener('abort', abort);
    lines.close();
    fail(new Error('모델 조회가 끝났습니다.'));
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      killTimer.unref();
      child.once('exit', () => clearTimeout(killTimer));
    }
  }
}

export async function claudeModels({ signal, loadSdk = () => import('@anthropic-ai/claude-agent-sdk'), command = executable('claude') } = {}) {
  const { query } = await loadSdk();
  const controller = new AbortController();
  let session;
  const abort = () => { controller.abort(); session?.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  async function* noMessages() {
    if (!controller.signal.aborted) await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
  }
  try {
    if (signal?.aborted) throw new Error('모델 조회를 취소했습니다.');
    session = query({ prompt: noMessages(), options: {
      pathToClaudeCodeExecutable: command,
      cwd: tmpdir(), abortController: controller,
      settingSources: [], tools: [], mcpServers: {}, persistSession: false,
      settings: { disableAllHooks: true }, extraArgs: { 'strict-mcp-config': null },
    } });
    return normalize('claude', await session.supportedModels());
  } finally {
    signal?.removeEventListener('abort', abort);
    controller.abort();
    session?.close();
  }
}

export async function queryProviderCatalog(provider, { signal, timeoutMs = 15000, adapters = { claude: claudeModels, codex: codexModels } } = {}) {
  const controller = new AbortController();
  let timeout;
  let abort;
  let timedOut = false;
  try {
    const cancelled = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(new Error('모델 조회를 취소했습니다.')); };
      signal?.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`모델 조회 시간이 초과되었습니다 (${timeoutMs}ms). CLI 로그인·연결을 확인하고 재조회해 주세요.`));
      }, timeoutMs);
      if (signal?.aborted) abort();
    });
    const models = await Promise.race([cancelled, Promise.resolve().then(() => adapters[provider]({ signal: controller.signal }))]);
    if (!Array.isArray(models) || models.length === 0) throw new Error('CLI가 빈 모델 목록을 반환했습니다.');
    return { status: 'ready', models, source: provider === 'claude' ? 'Claude Agent SDK supportedModels' : 'Codex app-server model/list' };
  } catch (error) {
    return { status: 'error', models: [], error: timedOut ? `모델 조회 시간이 초과되었습니다 (${timeoutMs}ms). 재조회해 주세요.` : error.message };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
