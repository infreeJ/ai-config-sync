#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadSyncConfig, validateSyncConfig } from './lib/sync-config.mjs';

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
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    check();
    renameSync(temporary, snapshot.file);
  } catch (error) {
    if (existsSync(temporary)) {
      try { execFileSync('trash-put', [temporary], { stdio: 'ignore' }); }
      catch { error.message += ` 임시 파일을 보존했습니다: ${temporary}`; }
    }
    throw error;
  }
}

export async function configureSync({ root = ROOT, input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('대화형 터미널에서 npm run config를 실행해 주세요.');
  const snapshot = loadSyncConfig(root);
  const config = structuredClone(snapshot.config);
  const rl = createInterface({ input, output, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  let interrupted = false;
  const interrupt = () => { interrupted = true; rl.close(); };
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
    return rows;
  }
  try {
    print('동기화 설정 — 번호를 선택하세요. 저장 전까지 파일은 변경되지 않습니다.');
    if (snapshot.original === null) print('개인 설정이 없어 기본값을 사용합니다. 저장하면 개인 설정 파일을 만듭니다.');
    while (!interrupted) {
      print(`\n1. 지시문 반영 방식: ${config.instructionsMode}\n2. 커밋 전 자동 동기화: ${config.preCommitSync} (Git hook 별도 설치 필요)\n3. 변경 전 백업: ${config.backup}\n4. 보존할 최신 백업 개수: ${config.backupRetentionCount}\n5. Claude 동기화: ${config.providers.claude ? '켬' : '끔'}\n6. Codex 동기화: ${config.providers.codex ? '켬' : '끔'}\n7. 변경 확인 및 저장\n0. 취소`);
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
      } else if (answer === '7') {
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
    process.off('SIGINT', interrupt);
    rl.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configureSync().catch((error) => { console.error(`설정 오류: ${error.message}`); process.exitCode = 1; });
}
