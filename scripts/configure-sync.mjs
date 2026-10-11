#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadSyncConfig, validateSyncConfig } from './lib/sync-config.mjs';
import { queryProviderCatalog } from './lib/provider-catalogs.mjs';
import { validateCatalogMappings } from './lib/agent-catalog-validation.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODES = [
  ['append', '기존 지시문을 보존하고 공유 영역만 추가·갱신'],
  ['off', '지시문 동기화 안 함 (스킬·에이전트는 별도 동기화)'],
  ['sidecar', '별도 파일로 저장 (사용할 도구에서 별도 연결 필요)'],
  ['managed', '전역 지시문 전체를 원본으로 교체'],
];
const TOGGLES = [['on', '켬'], ['off', '끔']];

export function saveSyncConfig(snapshot, config) {
  validateSyncConfig(config);
  const current = () => existsSync(snapshot.file) ? readFileSync(snapshot.file, 'utf8') : null;
  const check = () => {
    if (current() !== snapshot.original) throw new Error('설정 파일이 외부에서 변경되었습니다. 다시 실행해 주세요.');
  };
  check();
  mkdirSync(dirname(snapshot.file), { recursive: true });
  const temporary = `${snapshot.file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    created = true;
    let writeFailed = false;
    try {
      writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`);
    } catch (error) {
      writeFailed = true;
      throw error;
    } finally {
      try { closeSync(descriptor); }
      catch (error) { if (!writeFailed) throw error; }
    }
    check();
    renameSync(temporary, snapshot.file);
  } catch (error) {
    if (created) {
      try { unlinkSync(temporary); }
      catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') error.message += ` 임시 파일을 보존했습니다: ${temporary}`;
      }
    }
    throw error;
  }
}

export async function configureSync({ root = ROOT, input = process.stdin, output = process.stdout, queryCatalog = queryProviderCatalog } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('대화형 터미널에서 npm run config를 실행해 주세요.');
  const snapshot = loadSyncConfig(root);
  const config = structuredClone(snapshot.config);
  const rl = createInterface({ input, output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const catalogs = {};
  // Retain only this session's successful response for validating choices already made.
  // The current status controls the picker, so a failed refresh cannot offer stale choices.
  const verifiedCatalogs = {};
  const selectedProviders = new Set();
  const controller = new AbortController();
  let lookupController;
  let interrupted = false;
  const interrupt = () => {
    if (lookupController && !lookupController.signal.aborted) { lookupController.abort(); return; }
    interrupted = true;
    controller.abort();
    rl.close();
  };
  process.on('SIGINT', interrupt);
  const print = (text) => output.write(`${text}\n`);
  async function ask(text) {
    output.write(text);
    if (interrupted) return null;
    const line = await lines.next();
    return line.done ? null : line.value.trim();
  }
  async function choose(title, values) {
    print(`\n${title}`);
    values.forEach(([value, label], index) => print(` ${index + 1}. ${label} (${value})`));
    print(' 0. 돌아가기');
    while (true) {
      const answer = await ask('선택: ');
      if (answer === null) return null;
      if (answer === '0') return undefined;
      if (/^[1-9]\d*$/.test(answer) && values[Number(answer) - 1]) return values[Number(answer) - 1][0];
      print('표시된 번호를 입력해 주세요.');
    }
  }
  function changes() {
    const rows = [];
    for (const field of ['instructionsMode', 'preCommitSync', 'backup', 'backupRetentionCount']) {
      if (config[field] !== snapshot.config[field]) rows.push(`${field}: ${snapshot.config[field]} → ${config[field]}`);
    }
    for (const provider of ['claude', 'codex']) {
      if (config.providers[provider] !== snapshot.config.providers[provider]) rows.push(`${provider}: ${snapshot.config.providers[provider]} → ${config.providers[provider]}`);
    }
    for (const field of ['modelPresets', 'effortPresets']) {
      for (const preset of field === 'modelPresets' ? ['flagship', 'balanced', 'fast'] : ['low', 'medium', 'high']) {
        for (const provider of ['claude', 'codex']) {
          if (config[field][preset]?.[provider] !== snapshot.config[field][preset]?.[provider]) rows.push(`${field}.${preset}.${provider}: ${snapshot.config[field][preset]?.[provider] ?? '미설정'} → ${config[field][preset]?.[provider] ?? '미설정'}`);
        }
      }
    }
    return rows;
  }
  function editedProviders() {
    return ['claude', 'codex'].filter((provider) => selectedProviders.has(provider) || ['modelPresets', 'effortPresets'].some((field) =>
      Object.keys(config[field]).some((preset) => config[field][preset]?.[provider] !== snapshot.config[field][preset]?.[provider])));
  }
  async function refresh(provider) {
    lookupController = new AbortController();
    print(`${provider}: 공식 CLI 모델·추론 목록 조회 중… (Ctrl+C: 조회 취소)`);
    try {
      catalogs[provider] = await queryCatalog(provider, { signal: lookupController.signal });
      if (catalogs[provider].status === 'ready') verifiedCatalogs[provider] = catalogs[provider];
    }
    catch (error) { catalogs[provider] = { status: 'error', error: error.message, models: [] }; }
    finally { lookupController = undefined; }
  }
  async function editPresets(field) {
    const modelField = field === 'modelPresets';
    const presets = modelField ? ['flagship', 'balanced', 'fast'] : ['low', 'medium', 'high'];
    const slots = presets.flatMap((preset) => ['claude', 'codex'].map((provider) => [`${preset}:${provider}`, `${preset} / ${provider}: ${config[field][preset]?.[provider] ?? '미설정'}`]));
    const slot = await choose(modelField ? '모델 프리셋 — 현재 값' : '추론 프리셋 — 현재 값 (모델과 독립적으로 설정)', slots);
    if (slot == null) return slot;
    const [preset, provider] = slot.split(':');
    if (!catalogs[provider]) await refresh(provider);
    while (!interrupted) {
      const catalog = catalogs[provider];
      print(`\n${preset} / ${provider} 현재 값: ${config[field][preset]?.[provider] ?? '미설정'}`);
      print(`조회 상태: ${catalog.status === 'ready' ? `성공 — ${catalog.source || '공식 CLI'}` : `실패 — ${catalog.error}`}`);
      print('목록은 CLI가 보고한 카탈로그입니다. 계정의 실제 모델 사용 권한은 추론 실행 전에는 보장할 수 없습니다.');
      let values = [];
      if (catalog.status === 'ready') {
        if (modelField) values = catalog.models.map((model) => [model.value, `${model.label}${model.resolvedModel ? ` → ${model.resolvedModel}` : ''} [추론: ${model.efforts?.join(', ') || (model.efforts === null ? '지원 정보 없음' : '지원 없음')}]`]);
        else {
          const levels = [...new Set(catalog.models.flatMap((model) => model.efforts || []))];
          values = levels.map((effort) => [effort, `${effort} — 지원 모델: ${catalog.models.filter((model) => model.efforts?.includes(effort)).map((model) => model.value).join(', ')}`]);
          if (values.length === 0) print('추론 지원 정보가 없어 이 항목을 변경할 수 없습니다. CLI 업데이트 후 재조회해 주세요.');
        }
      } else print('조회 실패로 이 항목은 변경할 수 없습니다. 기존 값은 보존됩니다.');
      const selected = await choose('공식 조회 선택지', [...values, ['refresh', '목록 재조회']]);
      if (selected == null) return selected;
      if (selected === 'refresh') { await refresh(provider); continue; }
      config[field][preset] = { ...config[field][preset], [provider]: selected };
      selectedProviders.add(provider);
      return;
    }
    return null;
  }
  try {
    print('동기화 설정 — 번호를 선택하세요. 저장 전까지 파일은 변경되지 않습니다.');
    if (snapshot.original === null) print('개인 설정이 없어 기본값을 사용합니다. 저장하면 개인 설정 파일을 만듭니다.');
    while (!interrupted) {
      print(`\n1. 지시문 반영 방식: ${config.instructionsMode}\n2. 커밋 전 자동 동기화: ${config.preCommitSync} (Git hook 별도 설치 필요)\n3. 변경 전 백업: ${config.backup}\n4. 보존할 최신 백업 개수: ${config.backupRetentionCount}\n5. Claude 동기화: ${config.providers.claude ? '켬' : '끔'}\n6. Codex 동기화: ${config.providers.codex ? '켬' : '끔'}\n7. 변경 확인 및 저장\n8. 모델 프리셋 (Claude·Codex 6개)\n9. 추론 프리셋 (Claude·Codex 6개)\n0. 취소`);
      const answer = await ask('선택: ');
      if (answer === null || answer === '0') break;
      let selected;
      if (answer === '1') {
        selected = await choose('지시문 반영 방식', MODES);
        if (selected !== undefined && selected !== null) config.instructionsMode = selected;
      } else if (answer === '2' || answer === '3') {
        const field = answer === '2' ? 'preCommitSync' : 'backup';
        selected = await choose(field === 'backup' ? '변경 전 백업' : '커밋 전 자동 동기화 (hook 설치는 실행하지 않습니다)', TOGGLES);
        if (selected !== undefined && selected !== null) config[field] = selected;
      } else if (answer === '4') {
        selected = await choose('보존할 최신 백업 개수', [[5, '5개'], [10, '10개 (기본값)'], [20, '20개'], ['custom', '직접 입력']]);
        if (selected === 'custom') {
          while (true) {
            const value = await ask('1 이상의 정수 (0: 돌아가기): ');
            if (value === null || value === '0') { selected = value === null ? null : undefined; break; }
            if (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) { selected = Number(value); break; }
            print('1 이상의 안전한 정수를 입력해 주세요.');
          }
        }
        if (selected !== undefined && selected !== null) config.backupRetentionCount = selected;
      } else if (answer === '5' || answer === '6') {
        const provider = answer === '5' ? 'claude' : 'codex';
        selected = await choose(`${provider} 동기화`, [[true, '켬'], [false, '끔']]);
        if (selected !== undefined && selected !== null) config.providers[provider] = selected;
      } else if (answer === '8' || answer === '9') {
        selected = await editPresets(answer === '8' ? 'modelPresets' : 'effortPresets');
      } else if (answer === '7') {
        let validation;
        try { validation = validateCatalogMappings(root, config, verifiedCatalogs, editedProviders()); }
        catch (error) { print(`저장할 수 없습니다: ${error.message}`); continue; }
        for (const warning of validation.warnings) print(`확인 필요: ${warning}`);
        if (validation.errors.length) {
          print(`저장할 수 없습니다:\n${validation.errors.join('\n')}`);
          continue;
        }
        print(`\n변경 내역:\n${changes().join('\n') || '변경 없음 (현재 설정으로 저장)'}`);
        print(`저장 위치: ${snapshot.file}\n동기화와 Git hook 설치는 별도로 실행해야 합니다.`);
        const confirmation = await ask('저장하시겠습니까? (y: 저장 / 그 외: 돌아가기): ');
        if (confirmation === null) break;
        if (confirmation.toLowerCase() === 'y' && !interrupted) {
          saveSyncConfig(snapshot, config);
          print('설정을 저장했습니다. npm run sync:dry로 동기화 계획을 확인할 수 있습니다.');
          return;
        }
      } else { print('표시된 번호를 입력해 주세요.'); }
      if (selected === null) break;
    }
    print('취소했습니다. 설정 파일은 변경하지 않았습니다.');
  } finally {
    controller.abort();
    process.off('SIGINT', interrupt);
    rl.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureSync().catch((error) => { console.error(`설정 오류: ${error.message}`); process.exitCode = 1; });
}
