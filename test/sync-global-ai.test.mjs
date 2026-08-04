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
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const CLI_PATH = join('scripts', 'sync-global-ai.mjs');
const BEGIN_MARKER = '<!-- ai-config-sync:begin instruction -->';
const END_MARKER = '<!-- ai-config-sync:end instruction -->';

function createTestEnvironment() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'ai-config-sync-test-'));
  const repository = join(temporaryRoot, 'repository');
  const home = join(temporaryRoot, 'home');
  cpSync(REPOSITORY_ROOT, repository, {
    recursive: true,
    filter: (source) => !['.git', 'node_modules'].includes(basename(source)),
  });
  mkdirSync(home);

  return {
    repository,
    home,
    cleanup() {
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
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

function writeSyncConfig(repository, overrides) {
  const configPath = join(repository, 'sync.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, ...overrides }, null, 2)}\n`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
