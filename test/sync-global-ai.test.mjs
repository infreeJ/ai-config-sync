import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const CLI_PATH = join('scripts', 'sync-global-ai.mjs');
const INIT_CLI_PATH = join('scripts', 'init-sources.mjs');
const BEGIN_MARKER = '<!-- ai-config-sync:begin instruction -->';
const END_MARKER = '<!-- ai-config-sync:end instruction -->';

function createTestEnvironment({ initializeGit = true, initializeSources = true } = {}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'ai-config-sync-test-'));
  const repository = join(temporaryRoot, 'repository');
  const home = join(temporaryRoot, 'home');
  cpSync(REPOSITORY_ROOT, repository, {
    recursive: true,
    filter: (source) =>
      source !== join(REPOSITORY_ROOT, 'sources') && !['.git', 'node_modules'].includes(basename(source)),
  });
  mkdirSync(home);
  if (initializeGit) {
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
  }

  const environment = {
    repository,
    home,
    cleanup() {
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };

  if (initializeSources) {
    const result = runInit(environment);
    if (result.status !== 0) throw new Error(result.output);
  }

  return environment;
}

function runInit({ repository }) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [INIT_CLI_PATH], {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout || ''}${error.stderr || ''}`,
    };
  }
}

function runSync({ repository, home }, arguments_ = ['--yes']) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [CLI_PATH, ...arguments_], {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          USERPROFILE: home,
          HOME: home,
        },
      }),
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout || ''}${error.stderr || ''}`,
    };
  }
}

function markerCount(content, marker) {
  return content.split(/\r?\n/).filter((line) => line === marker).length;
}

test('init creates sources from the template without staging them', () => {
  const environment = createTestEnvironment({ initializeSources: false });
  try {
    const result = runInit(environment);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Created sources\/ from the bundled template/);
    assert.equal(
      readFileSync(join(environment.repository, 'sources', 'AGENTS.md'), 'utf8'),
      readFileSync(join(environment.repository, 'scripts', 'templates', 'sources', 'AGENTS.md'), 'utf8'),
    );
    assert.equal(
      readFileSync(join(environment.repository, 'sources', 'CLAUDE.md'), 'utf8'),
      readFileSync(join(environment.repository, 'scripts', 'templates', 'sources', 'CLAUDE.md'), 'utf8'),
    );
    assert.throws(() => {
      execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', 'sources/AGENTS.md'], {
        cwd: environment.repository,
      });
    });
    assert.equal(
      execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: environment.repository,
        encoding: 'utf8',
      }),
      '',
    );
  } finally {
    environment.cleanup();
  }
});

test('a new skill under sources is detected by normal Git status', () => {
  const environment = createTestEnvironment();
  try {
    const skillDirectory = join(environment.repository, 'sources', 'skills', 'example');
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(join(skillDirectory, 'SKILL.md'), '# Example skill\n');

    const status = execFileSync('git', ['status', '--short', '--untracked-files=all'], {
      cwd: environment.repository,
      encoding: 'utf8',
    });
    assert.match(status, /^\?\? sources\/skills\/example\/SKILL\.md$/m);
  } finally {
    environment.cleanup();
  }
});

test('init preserves an existing sources directory without staging its files', () => {
  const environment = createTestEnvironment({ initializeSources: false });
  try {
    const customInstruction = '# Private instruction\n';
    mkdirSync(join(environment.repository, 'sources'));
    writeFileSync(join(environment.repository, 'sources', 'AGENTS.md'), customInstruction);

    const result = runInit(environment);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /sources\/ already exists; preserved existing files/);
    assert.equal(readFileSync(join(environment.repository, 'sources', 'AGENTS.md'), 'utf8'), customInstruction);
    const stagedFiles = execFileSync('git', ['diff', '--cached', '--name-only'], {
      cwd: environment.repository,
      encoding: 'utf8',
    });
    assert.equal(stagedFiles, '');
  } finally {
    environment.cleanup();
  }
});

test('init creates sources outside a Git work tree', () => {
  const environment = createTestEnvironment({ initializeGit: false, initializeSources: false });
  try {
    const result = runInit(environment);

    assert.equal(result.status, 0, result.output);
    assert.equal(existsSync(join(environment.repository, 'sources', 'AGENTS.md')), true);
  } finally {
    environment.cleanup();
  }
});

test('sync requires sources created by init before it touches global paths', () => {
  const environment = createTestEnvironment({ initializeSources: false });
  try {
    const result = runSync(environment);

    assert.notEqual(result.status, 0);
    assert.match(result.output, /Source directory is missing/);
    assert.match(result.output, /npm run init/);
    assert.equal(existsSync(join(environment.home, '.codex')), false);
    assert.equal(existsSync(join(environment.home, '.claude')), false);
  } finally {
    environment.cleanup();
  }
});

test('append mode preserves local instructions and creates then updates managed blocks', () => {
  const environment = createTestEnvironment();
  try {
    const codexInstructions = join(environment.home, '.codex', 'AGENTS.md');
    const claudeInstructions = join(environment.home, '.claude', 'CLAUDE.md');
    mkdirSync(join(environment.home, '.codex'));
    mkdirSync(join(environment.home, '.claude'));
    writeFileSync(codexInstructions, '## Local Codex instructions\nKeep this setting.');
    writeFileSync(claudeInstructions, '## Local Claude instructions\nKeep this setting.');

    const firstRun = runSync(environment);
    assert.equal(firstRun.status, 0, firstRun.output);
    assert.doesNotMatch(firstRun.output, /Target roots/);

    const initialCodexContent = readFileSync(codexInstructions, 'utf8');
    const initialClaudeContent = readFileSync(claudeInstructions, 'utf8');
    const initialCodexSource = readFileSync(join(environment.repository, 'sources', 'AGENTS.md'), 'utf8');
    const initialClaudeSource = readFileSync(join(environment.repository, 'sources', 'CLAUDE.md'), 'utf8');

    assert.match(initialCodexContent, /^## Local Codex instructions\nKeep this setting\.\n/);
    assert.equal(markerCount(initialCodexContent, BEGIN_MARKER), 1);
    assert.equal(markerCount(initialCodexContent, END_MARKER), 1);
    assert.match(
      initialCodexContent,
      new RegExp(`<!-- AUTO-GENERATED from ${escapeRegExp(join(environment.repository, 'sources'))} -->`),
    );
    assert.match(initialCodexContent, new RegExp(escapeRegExp(initialCodexSource)));
    assert.match(initialClaudeContent, /^## Local Claude instructions\nKeep this setting\.\n/);
    assert.equal(markerCount(initialClaudeContent, BEGIN_MARKER), 1);
    assert.equal(markerCount(initialClaudeContent, END_MARKER), 1);
    assert.match(initialClaudeContent, new RegExp(escapeRegExp(initialClaudeSource)));

    const updatedCodexSource = '# Updated Codex source instructions\n\n- New managed content\n';
    const updatedClaudeSource = '# Updated Claude source instructions\n\n- New managed content\n';
    writeFileSync(join(environment.repository, 'sources', 'AGENTS.md'), updatedCodexSource);
    writeFileSync(join(environment.repository, 'sources', 'CLAUDE.md'), updatedClaudeSource);

    const secondRun = runSync(environment);
    assert.equal(secondRun.status, 0, secondRun.output);
    assert.match(secondRun.output, /Instructions\r?\n/);
    assert.match(secondRun.output, /update - AGENTS\.md/);
    assert.doesNotMatch(secondRun.output, /overwrite/);
    assert.doesNotMatch(secondRun.output, new RegExp(escapeRegExp(environment.home)));

    const updatedCodexContent = readFileSync(codexInstructions, 'utf8');
    const updatedClaudeContent = readFileSync(claudeInstructions, 'utf8');
    assert.match(updatedCodexContent, /^## Local Codex instructions\nKeep this setting\.\n/);
    assert.match(updatedCodexContent, new RegExp(escapeRegExp(updatedCodexSource)));
    assert.doesNotMatch(updatedCodexContent, new RegExp(escapeRegExp(initialCodexSource)));
    assert.equal(markerCount(updatedCodexContent, BEGIN_MARKER), 1);
    assert.equal(markerCount(updatedCodexContent, END_MARKER), 1);
    assert.match(updatedClaudeContent, /^## Local Claude instructions\nKeep this setting\.\n/);
    assert.match(updatedClaudeContent, new RegExp(escapeRegExp(updatedClaudeSource)));
    assert.doesNotMatch(updatedClaudeContent, new RegExp(escapeRegExp(initialClaudeSource)));
    assert.equal(markerCount(updatedClaudeContent, BEGIN_MARKER), 1);
    assert.equal(markerCount(updatedClaudeContent, END_MARKER), 1);
  } finally {
    environment.cleanup();
  }
});

test('append mode rejects malformed markers without writing instructions', () => {
  const environment = createTestEnvironment();
  try {
    const codexInstructions = join(environment.home, '.codex', 'AGENTS.md');
    const malformedContent = `## Local instructions\n${BEGIN_MARKER}\nUnclosed managed block\n`;
    mkdirSync(join(environment.home, '.codex'));
    writeFileSync(codexInstructions, malformedContent);

    const result = runSync(environment);

    assert.notEqual(result.status, 0);
    assert.match(result.output, /Malformed managed instruction markers/);
    assert.equal(readFileSync(codexInstructions, 'utf8'), malformedContent);
    assert.equal(existsSync(join(environment.home, '.claude', 'CLAUDE.md')), false);
  } finally {
    environment.cleanup();
  }
});

test('--dry-run does not create or modify isolated global paths', () => {
  const environment = createTestEnvironment();
  try {
    const codexInstructions = join(environment.home, '.codex', 'AGENTS.md');
    const claudeInstructions = join(environment.home, '.claude', 'CLAUDE.md');
    const codexContent = '## Existing Codex instructions\nKeep unchanged.\n';
    const claudeContent = '## Existing Claude instructions\nKeep unchanged.\n';
    mkdirSync(join(environment.home, '.codex'));
    mkdirSync(join(environment.home, '.claude'));
    writeFileSync(codexInstructions, codexContent);
    writeFileSync(claudeInstructions, claudeContent);

    const result = runSync(environment, ['--dry-run']);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /dry-run plan/);
    assert.equal(readFileSync(codexInstructions, 'utf8'), codexContent);
    assert.equal(readFileSync(claudeInstructions, 'utf8'), claudeContent);
    assert.deepEqual(backupDirectories(environment.repository), []);
  } finally {
    environment.cleanup();
  }
});

test('sync backs up every global instruction, skill, and agent before applying changes', () => {
  const environment = createTestEnvironment();
  try {
    const codexInstructions = join(environment.home, '.codex', 'AGENTS.md');
    const claudeInstructions = join(environment.home, '.claude', 'CLAUDE.md');
    const claudeSkill = join(environment.home, '.claude', 'skills', 'local-claude-skill');
    const codexSkill = join(environment.home, '.agents', 'skills', 'local-codex-skill');
    const claudeAgent = join(environment.home, '.claude', 'agents', 'local-agent.md');
    const codexAgent = join(environment.home, '.codex', 'agents', 'local-agent.toml');
    const codexContent = '## Local Codex instructions\nPreserve this version.\n';
    const claudeContent = '## Local Claude instructions\nPreserve this version.\n';

    mkdirSync(join(claudeSkill, 'references'), { recursive: true });
    mkdirSync(codexSkill, { recursive: true });
    mkdirSync(dirname(claudeAgent), { recursive: true });
    mkdirSync(dirname(codexAgent), { recursive: true });
    writeFileSync(codexInstructions, codexContent);
    writeFileSync(claudeInstructions, claudeContent);
    writeFileSync(join(claudeSkill, 'SKILL.md'), '# Local Claude skill\n');
    writeFileSync(join(claudeSkill, 'references', 'guide.md'), 'Claude skill reference\n');
    writeFileSync(join(codexSkill, 'SKILL.md'), '# Local Codex skill\n');
    writeFileSync(claudeAgent, 'Local Claude agent\n');
    writeFileSync(codexAgent, 'Local Codex agent\n');

    const result = runSync(environment);

    assert.equal(result.status, 0, result.output);
    const backups = backupDirectories(environment.repository);
    assert.equal(backups.length, 1);
    assert.match(result.output, new RegExp(`backup: backup/${escapeRegExp(backups[0])}`));

    const backup = join(environment.repository, 'backup', backups[0]);
    assert.equal(readFileSync(join(backup, '.codex', 'AGENTS.md'), 'utf8'), codexContent);
    assert.equal(readFileSync(join(backup, '.claude', 'CLAUDE.md'), 'utf8'), claudeContent);
    assert.equal(readFileSync(join(backup, '.claude', 'skills', 'local-claude-skill', 'SKILL.md'), 'utf8'), '# Local Claude skill\n');
    assert.equal(
      readFileSync(join(backup, '.claude', 'skills', 'local-claude-skill', 'references', 'guide.md'), 'utf8'),
      'Claude skill reference\n',
    );
    assert.equal(readFileSync(join(backup, '.agents', 'skills', 'local-codex-skill', 'SKILL.md'), 'utf8'), '# Local Codex skill\n');
    assert.equal(readFileSync(join(backup, '.claude', 'agents', 'local-agent.md'), 'utf8'), 'Local Claude agent\n');
    assert.equal(readFileSync(join(backup, '.codex', 'agents', 'local-agent.toml'), 'utf8'), 'Local Codex agent\n');
  } finally {
    environment.cleanup();
  }
});

test('sync does not create a backup when there are no changes to apply', () => {
  const environment = createTestEnvironment();
  try {
    const firstRun = runSync(environment);
    assert.equal(firstRun.status, 0, firstRun.output);
    const backupsBefore = backupDirectories(environment.repository);
    assert.equal(backupsBefore.length, 1);

    const secondRun = runSync(environment);

    assert.equal(secondRun.status, 0, secondRun.output);
    assert.match(secondRun.output, /No changes to apply; sync cancelled without writing\./);
    assert.doesNotMatch(secondRun.output, /^backup:/m);
    assert.deepEqual(backupDirectories(environment.repository), backupsBefore);
  } finally {
    environment.cleanup();
  }
});

test('backup off skips backup creation while applying changes', () => {
  const environment = createTestEnvironment();
  try {
    const codexInstructions = join(environment.home, '.codex', 'AGENTS.md');
    const initialCodexContent = 'Local Codex instructions\n';
    writeSyncConfig(environment.repository, { backup: 'off' });
    mkdirSync(join(environment.home, '.codex'), { recursive: true });
    writeFileSync(codexInstructions, initialCodexContent);

    const result = runSync(environment);

    assert.equal(result.status, 0, result.output);
    assert.notEqual(readFileSync(codexInstructions, 'utf8'), initialCodexContent);
    assert.match(readFileSync(codexInstructions, 'utf8'), new RegExp(escapeRegExp(BEGIN_MARKER)));
    assert.doesNotMatch(result.output, /^backup:/m);
    assert.deepEqual(backupDirectories(environment.repository), []);
  } finally {
    environment.cleanup();
  }
});

test('each changed sync creates a distinct backup and preserves earlier backups', () => {
  const environment = createTestEnvironment();
  try {
    const codexInstructions = join(environment.home, '.codex', 'AGENTS.md');
    const initialCodexContent = '## Local Codex instructions\nFirst version.\n';
    mkdirSync(dirname(codexInstructions), { recursive: true });
    writeFileSync(codexInstructions, initialCodexContent);

    const firstRun = runSync(environment);
    assert.equal(firstRun.status, 0, firstRun.output);
    const [firstBackup] = backupDirectories(environment.repository);
    assert.ok(firstBackup);
    const firstBackupPath = join(environment.repository, 'backup', firstBackup);
    assert.equal(readFileSync(join(firstBackupPath, '.codex', 'AGENTS.md'), 'utf8'), initialCodexContent);
    const codexAfterFirstSync = readFileSync(codexInstructions, 'utf8');

    const sourceInstructions = join(environment.repository, 'sources', 'AGENTS.md');
    writeFileSync(sourceInstructions, `${readFileSync(sourceInstructions, 'utf8')}\n## Updated source instructions\n`);

    const secondRun = runSync(environment);
    assert.equal(secondRun.status, 0, secondRun.output);
    const backups = backupDirectories(environment.repository);
    assert.equal(backups.length, 2);
    assert.ok(backups.includes(firstBackup));
    assert.equal(readFileSync(join(firstBackupPath, '.codex', 'AGENTS.md'), 'utf8'), initialCodexContent);
    const secondBackup = backups.find((backup) => backup !== firstBackup);
    assert.ok(secondBackup);
    assert.equal(
      readFileSync(join(environment.repository, 'backup', secondBackup, '.codex', 'AGENTS.md'), 'utf8'),
      codexAfterFirstSync,
    );
  } finally {
    environment.cleanup();
  }
});

test('missing backup configuration defaults to creating a backup before changes', () => {
  const environment = createTestEnvironment();
  try {
    const configPath = join(environment.repository, 'sync.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.backup;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = runSync(environment);

    assert.equal(result.status, 0, result.output);
    assert.equal(backupDirectories(environment.repository).length, 1);
    assert.match(result.output, /^backup: backup\//m);
  } finally {
    environment.cleanup();
  }
});

test('sync retains the newest configured backups and reports the expired snapshot', () => {
  const environment = createTestEnvironment();
  try {
    const codexInstructions = join(environment.home, '.codex', 'AGENTS.md');
    const sourceInstructions = join(environment.repository, 'sources', 'AGENTS.md');
    const initialCodexContent = '## Local Codex instructions\nOriginal version.\n';
    writeSyncConfig(environment.repository, { backupRetentionCount: 2 });
    mkdirSync(dirname(codexInstructions), { recursive: true });
    writeFileSync(codexInstructions, initialCodexContent);

    const firstRun = runSync(environment);
    assert.equal(firstRun.status, 0, firstRun.output);
    const [firstBackup] = backupDirectories(environment.repository);
    assert.ok(firstBackup);
    assert.equal(readFileSync(join(environment.repository, 'backup', firstBackup, '.codex', 'AGENTS.md'), 'utf8'), initialCodexContent);

    const codexBeforeSecondSync = readFileSync(codexInstructions, 'utf8');
    writeFileSync(sourceInstructions, `${readFileSync(sourceInstructions, 'utf8')}\n## Second source version\n`);
    const secondRun = runSync(environment);
    assert.equal(secondRun.status, 0, secondRun.output);
    const backupsAfterSecondSync = backupDirectories(environment.repository);
    assert.equal(backupsAfterSecondSync.length, 2);
    const secondBackup = backupsAfterSecondSync.find((backup) => backup !== firstBackup);
    assert.ok(secondBackup);
    assert.equal(
      readFileSync(join(environment.repository, 'backup', secondBackup, '.codex', 'AGENTS.md'), 'utf8'),
      codexBeforeSecondSync,
    );

    const codexBeforeThirdSync = readFileSync(codexInstructions, 'utf8');
    writeFileSync(sourceInstructions, `${readFileSync(sourceInstructions, 'utf8')}\n## Third source version\n`);
    const thirdRun = runSync(environment);

    assert.equal(thirdRun.status, 0, thirdRun.output);
    assert.match(thirdRun.output, new RegExp(`deleted backup: backup/${escapeRegExp(firstBackup)}`));
    const retainedBackups = backupDirectories(environment.repository);
    assert.equal(retainedBackups.length, 2);
    assert.ok(retainedBackups.includes(secondBackup));
    assert.equal(existsSync(join(environment.repository, 'backup', firstBackup)), false);
    const thirdBackup = retainedBackups.find((backup) => backup !== secondBackup);
    assert.ok(thirdBackup);
    assert.equal(
      readFileSync(join(environment.repository, 'backup', thirdBackup, '.codex', 'AGENTS.md'), 'utf8'),
      codexBeforeThirdSync,
    );
  } finally {
    environment.cleanup();
  }
});

test('missing backupRetentionCount keeps the default ten newest backups', () => {
  const environment = createTestEnvironment();
  try {
    const configPath = join(environment.repository, 'sync.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.backupRetentionCount;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const backupRoot = join(environment.repository, 'backup');
    const oldestBackup = '2025-01-01T00-00-00-000Z';

    for (let index = 0; index < 10; index += 1) {
      const name = `2025-01-${String(index + 1).padStart(2, '0')}T00-00-00-000Z`;
      const fixture = join(backupRoot, name, '.codex');
      mkdirSync(fixture, { recursive: true });
      writeFileSync(join(fixture, 'AGENTS.md'), `Backup ${index + 1}\n`);
    }
    const backupsBeforeSync = backupDirectories(environment.repository);

    const result = runSync(environment);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`deleted backup: backup/${escapeRegExp(oldestBackup)}`));
    const retainedBackups = backupDirectories(environment.repository);
    const newBackup = retainedBackups.find((backup) => !backupsBeforeSync.includes(backup));
    assert.ok(newBackup);
    assert.deepEqual(retainedBackups, [...backupsBeforeSync.slice(1), newBackup].sort());
    assert.equal(existsSync(join(backupRoot, oldestBackup)), false);
  } finally {
    environment.cleanup();
  }
});

test('backup retention sorts same-timestamp suffixes by their numeric sequence', () => {
  const environment = createTestEnvironment();
  try {
    const backupRoot = join(environment.repository, 'backup');
    const timestamp = '2025-01-01T00-00-00-000Z';
    const existingBackups = Array.from({ length: 11 }, (_, index) => (index === 0 ? timestamp : `${timestamp}-${index}`));
    writeSyncConfig(environment.repository, { backupRetentionCount: 2 });
    for (const backup of existingBackups) {
      createBackupFixture(backupRoot, backup);
    }

    const result = runSync(environment);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`deleted backup: backup/${escapeRegExp(timestamp)}(?:\\r?\\n|$)`));
    assert.match(result.output, new RegExp(`deleted backup: backup/${escapeRegExp(`${timestamp}-9`)}(?:\\r?\\n|$)`));
    assert.doesNotMatch(result.output, new RegExp(`deleted backup: backup/${escapeRegExp(`${timestamp}-10`)}(?:\\r?\\n|$)`));
    const retainedBackups = backupDirectories(environment.repository);
    const newBackup = retainedBackups.find((backup) => !existingBackups.includes(backup));
    assert.ok(newBackup);
    assert.deepEqual(retainedBackups, [`${timestamp}-10`, newBackup].sort());
  } finally {
    environment.cleanup();
  }
});

for (const invalidRetentionCount of [0, -1, 1.5, '2']) {
  test(`invalid backupRetentionCount ${JSON.stringify(invalidRetentionCount)} fails without writing global settings or backups`, () => {
    const environment = createTestEnvironment();
    try {
      const codexInstructions = join(environment.home, '.codex', 'AGENTS.md');
      const backupRoot = join(environment.repository, 'backup');
      writeSyncConfig(environment.repository, { backupRetentionCount: invalidRetentionCount });
      mkdirSync(dirname(codexInstructions), { recursive: true });
      writeFileSync(codexInstructions, '## Local Codex instructions\nKeep unchanged.\n');
      mkdirSync(join(backupRoot, '2025-01-01T00-00-00-000Z'), { recursive: true });
      writeFileSync(join(backupRoot, '2025-01-01T00-00-00-000Z', 'saved.txt'), 'Keep this backup.\n');
      const homeBefore = snapshotDirectory(environment.home);
      const backupsBefore = snapshotDirectory(backupRoot);

      const result = runSync(environment);

      assert.notEqual(result.status, 0);
      assert.match(result.output, /Invalid backupRetentionCount/);
      assert.deepEqual(snapshotDirectory(environment.home), homeBefore);
      assert.deepEqual(snapshotDirectory(backupRoot), backupsBefore);
    } finally {
      environment.cleanup();
    }
  });
}

for (const syncMode of [
  { name: 'backup off', config: { backup: 'off', backupRetentionCount: 1 }, arguments_: ['--yes'] },
  { name: 'dry run', config: { backupRetentionCount: 1 }, arguments_: ['--dry-run'] },
]) {
  test(`${syncMode.name} does not prune existing backups`, () => {
    const environment = createTestEnvironment();
    try {
      const backupRoot = join(environment.repository, 'backup');
      writeSyncConfig(environment.repository, syncMode.config);
      createBackupFixture(backupRoot, '2025-01-01T00-00-00-000Z');
      createBackupFixture(backupRoot, '2025-01-02T00-00-00-000Z');
      const backupsBefore = snapshotDirectory(backupRoot);

      const result = runSync(environment, syncMode.arguments_);

      assert.equal(result.status, 0, result.output);
      assert.deepEqual(snapshotDirectory(backupRoot), backupsBefore);
    } finally {
      environment.cleanup();
    }
  });
}

test('backup retention preserves backup folders not created by the sync tool', () => {
  const environment = createTestEnvironment();
  try {
    const backupRoot = join(environment.repository, 'backup');
    const expiredBackup = '2025-01-01T00-00-00-000Z';
    const manualBackup = join(backupRoot, 'manual-backup');
    writeSyncConfig(environment.repository, { backupRetentionCount: 1 });
    createBackupFixture(backupRoot, expiredBackup);
    mkdirSync(manualBackup, { recursive: true });
    writeFileSync(join(manualBackup, 'keep.txt'), 'Do not remove this folder.\n');

    const result = runSync(environment);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, new RegExp(`deleted backup: backup/${escapeRegExp(expiredBackup)}`));
    assert.equal(existsSync(join(backupRoot, expiredBackup)), false);
    assert.equal(readFileSync(join(manualBackup, 'keep.txt'), 'utf8'), 'Do not remove this folder.\n');
    assert.equal(backupDirectories(environment.repository).length, 2);
  } finally {
    environment.cleanup();
  }
});

test('summary excludes hidden target root setup', () => {
  const environment = createTestEnvironment();
  try {
    const result = runSync(environment, ['--dry-run']);

    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /create: 2/);
    assert.doesNotMatch(result.output, /Target roots/);
  } finally {
    environment.cleanup();
  }
});

test('managed mode replaces complete global instruction files with their sources', () => {
  const environment = createTestEnvironment();
  try {
    const codexInstructions = join(environment.home, '.codex', 'AGENTS.md');
    const claudeInstructions = join(environment.home, '.claude', 'CLAUDE.md');
    const codexSource = readFileSync(join(environment.repository, 'sources', 'AGENTS.md'), 'utf8');
    const claudeSource = readFileSync(join(environment.repository, 'sources', 'CLAUDE.md'), 'utf8');
    writeSyncConfig(environment.repository, { instructionsMode: 'managed' });
    mkdirSync(join(environment.home, '.codex'));
    mkdirSync(join(environment.home, '.claude'));
    writeFileSync(codexInstructions, '## Local Codex instructions\nThis content is replaced.\n');
    writeFileSync(claudeInstructions, '## Local Claude instructions\nThis content is replaced.\n');

    const result = runSync(environment);

    assert.equal(result.status, 0, result.output);
    assert.equal(readFileSync(codexInstructions, 'utf8'), codexSource);
    assert.equal(readFileSync(claudeInstructions, 'utf8'), claudeSource);
  } finally {
    environment.cleanup();
  }
});

test('off mode does not modify or create global instruction files', () => {
  for (const instructionCase of [
    { directory: '.codex', fileName: 'AGENTS.md', missingDirectory: '.claude', missingFileName: 'CLAUDE.md' },
    { directory: '.claude', fileName: 'CLAUDE.md', missingDirectory: '.codex', missingFileName: 'AGENTS.md' },
  ]) {
    const environment = createTestEnvironment();
    try {
      const existingInstructions = join(
        environment.home,
        instructionCase.directory,
        instructionCase.fileName,
      );
      const missingInstructions = join(
        environment.home,
        instructionCase.missingDirectory,
        instructionCase.missingFileName,
      );
      const existingContent = '## Local instructions\nKeep unchanged.\n';
      writeSyncConfig(environment.repository, { instructionsMode: 'off' });
      mkdirSync(join(environment.home, instructionCase.directory));
      writeFileSync(existingInstructions, existingContent);

      const result = runSync(environment);

      assert.equal(result.status, 0, result.output);
      assert.equal(readFileSync(existingInstructions, 'utf8'), existingContent);
      assert.equal(existsSync(missingInstructions), false);
    } finally {
      environment.cleanup();
    }
  }
});

test('syncs nested skills to .agents while preserving legacy Codex skills and agents idempotently', () => {
  const environment = createTestEnvironment();
  try {
    const sourceSkill = join(environment.repository, 'sources', 'skills', 'nested-skill');
    const sourceAgent = join(environment.repository, 'sources', 'agents', 'review-agent.md');
    const claudeSkill = join(environment.home, '.claude', 'skills', 'nested-skill');
    const codexSkill = join(environment.home, '.agents', 'skills', 'nested-skill');
    const legacyCodexSkill = join(environment.home, '.codex', 'skills', 'nested-skill');
    const claudeAgent = join(environment.home, '.claude', 'agents', 'review-agent.md');
    const codexAgent = join(environment.home, '.codex', 'agents', 'review-agent.toml');
    const agentMarkdown = [
      '---',
      'name: review-agent',
      'description: Reviews implementation changes',
      'model: opus',
      '---',
      '',
      '# Review agent',
      '',
      'Inspect the requested implementation.',
      '',
    ].join('\n');

    writeSyncConfig(environment.repository, { instructionsMode: 'off' });
    mkdirSync(join(sourceSkill, 'references'), { recursive: true });
    mkdirSync(join(environment.home, '.claude', 'skills', 'preserved-skill'), { recursive: true });
    mkdirSync(legacyCodexSkill, { recursive: true });
    mkdirSync(join(environment.home, '.codex', 'skills', 'preserved-skill'), { recursive: true });
    mkdirSync(join(environment.home, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(environment.home, '.codex', 'agents'), { recursive: true });
    mkdirSync(join(environment.repository, 'sources', 'agents'), { recursive: true });
    writeFileSync(join(sourceSkill, 'SKILL.md'), '# Nested skill\n');
    writeFileSync(join(sourceSkill, 'references', 'guide.md'), 'Nested reference\n');
    writeFileSync(join(environment.home, '.claude', 'skills', 'preserved-skill', 'SKILL.md'), 'Claude local skill\n');
    writeFileSync(join(legacyCodexSkill, 'SKILL.md'), 'Legacy Codex nested skill\n');
    writeFileSync(join(environment.home, '.codex', 'skills', 'preserved-skill', 'SKILL.md'), 'Codex local skill\n');
    writeFileSync(sourceAgent, agentMarkdown);
    writeFileSync(join(environment.home, '.claude', 'agents', 'review-agent.toml'), 'stale Claude variant\n');
    writeFileSync(join(environment.home, '.claude', 'agents', 'review-agent'), 'stale Claude extensionless variant\n');
    writeFileSync(join(environment.home, '.codex', 'agents', 'review-agent.md'), 'stale Codex variant\n');
    writeFileSync(join(environment.home, '.codex', 'agents', 'review-agent'), 'stale Codex extensionless variant\n');

    const firstRun = runSync(environment);

    assert.equal(firstRun.status, 0, firstRun.output);
    assert.equal((firstRun.output.match(/create - nested-skill/g) ?? []).length, 2);
    assert.equal((firstRun.output.match(/create - review-agent\.md/g) ?? []).length, 2);
    assert.equal(readFileSync(join(claudeSkill, 'SKILL.md'), 'utf8'), '# Nested skill\n');
    assert.equal(readFileSync(join(claudeSkill, 'references', 'guide.md'), 'utf8'), 'Nested reference\n');
    assert.equal(readFileSync(join(codexSkill, 'SKILL.md'), 'utf8'), '# Nested skill\n');
    assert.equal(readFileSync(join(codexSkill, 'references', 'guide.md'), 'utf8'), 'Nested reference\n');
    assert.equal(readFileSync(join(legacyCodexSkill, 'SKILL.md'), 'utf8'), 'Legacy Codex nested skill\n');
    assert.equal(
      readFileSync(join(environment.home, '.claude', 'skills', 'preserved-skill', 'SKILL.md'), 'utf8'),
      'Claude local skill\n',
    );
    assert.equal(
      readFileSync(join(environment.home, '.codex', 'skills', 'preserved-skill', 'SKILL.md'), 'utf8'),
      'Codex local skill\n',
    );
    assert.equal(readFileSync(claudeAgent, 'utf8'), agentMarkdown);
    assert.match(readFileSync(codexAgent, 'utf8'), /name = "review-agent"/);
    assert.match(readFileSync(codexAgent, 'utf8'), /description = "Reviews implementation changes"/);
    assert.match(readFileSync(codexAgent, 'utf8'), /model = "gpt-5\.6-sol"/);
    assert.match(readFileSync(codexAgent, 'utf8'), /model_reasoning_effort = "xhigh"/);
    assert.match(readFileSync(codexAgent, 'utf8'), /developer_instructions = "# Review agent\\n\\nInspect the requested implementation\."/);
    assert.equal(existsSync(join(environment.home, '.claude', 'agents', 'review-agent.toml')), false);
    assert.equal(existsSync(join(environment.home, '.claude', 'agents', 'review-agent')), false);
    assert.equal(existsSync(join(environment.home, '.codex', 'agents', 'review-agent.md')), false);
    assert.equal(existsSync(join(environment.home, '.codex', 'agents', 'review-agent')), false);

    const homeAfterFirstRun = snapshotDirectory(environment.home);
    const secondRun = runSync(environment);

    assert.equal(secondRun.status, 0, secondRun.output);
    assert.match(secondRun.output, /\(no changes\)/);
    assert.doesNotMatch(secondRun.output, /Instructions/);
    assert.match(secondRun.output, /No changes to apply; sync cancelled without writing\./);
    assert.deepEqual(snapshotDirectory(environment.home), homeAfterFirstRun);
  } finally {
    environment.cleanup();
  }
});

for (const invalidConfig of [
  {
    name: 'instructionsMode',
    value: 'invalid',
    error: /Invalid instructionsMode "invalid"/,
  },
  {
    name: 'preCommitSync',
    value: 'invalid',
    error: /Invalid preCommitSync "invalid"/,
  },
  {
    name: 'backup',
    value: 'invalid',
    error: /Invalid backup "invalid"/,
  },
]) {
  test(`invalid ${invalidConfig.name} fails before writing the isolated home directory`, () => {
    const environment = createTestEnvironment();
    try {
      const codexInstructions = join(environment.home, '.codex', 'AGENTS.md');
      const claudeInstructions = join(environment.home, '.claude', 'CLAUDE.md');
      const codexContent = '## Local Codex instructions\nKeep unchanged.\n';
      const claudeContent = '## Local Claude instructions\nKeep unchanged.\n';
      writeSyncConfig(environment.repository, { [invalidConfig.name]: invalidConfig.value });
      addSyncSourceFixtures(environment.repository);
      mkdirSync(join(environment.home, '.codex'));
      mkdirSync(join(environment.home, '.claude'));
      writeFileSync(codexInstructions, codexContent);
      writeFileSync(claudeInstructions, claudeContent);
      const homeBefore = snapshotDirectory(environment.home);

      const result = runSync(environment);

      assert.notEqual(result.status, 0);
      assert.match(result.output, invalidConfig.error);
      assert.deepEqual(snapshotDirectory(environment.home), homeBefore);
      assert.deepEqual(backupDirectories(environment.repository), []);
    } finally {
      environment.cleanup();
    }
  });
}

function addSyncSourceFixtures(repository) {
  const skillDirectory = join(repository, 'sources', 'skills', 'watch-skill');
  const agentDirectory = join(repository, 'sources', 'agents');
  mkdirSync(skillDirectory, { recursive: true });
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, 'SKILL.md'), '# Watch skill\n');
  writeFileSync(
    join(agentDirectory, 'watch-agent.md'),
    '---\nname: watch-agent\ndescription: Detects writes after invalid configuration\n---\n\nWatch agent.\n',
  );
}

function snapshotDirectory(directory) {
  const entries = [];

  function visit(currentDirectory, relativeDirectory = '') {
    const currentEntries = readdirSync(currentDirectory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of currentEntries) {
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      const fullPath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory' });
        visit(fullPath, relativePath);
      } else if (entry.isFile()) {
        entries.push({ path: relativePath, type: 'file', content: readFileSync(fullPath, 'utf8') });
      }
    }
  }

  visit(directory);
  return entries;
}

function backupDirectories(repository) {
  const backupRoot = join(repository, 'backup');
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function createBackupFixture(backupRoot, name) {
  const fixture = join(backupRoot, name, '.codex');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, 'AGENTS.md'), `Backup fixture: ${name}\n`);
}

function writeSyncConfig(repository, overrides) {
  const configPath = join(repository, 'sync.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, ...overrides }, null, 2)}\n`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
