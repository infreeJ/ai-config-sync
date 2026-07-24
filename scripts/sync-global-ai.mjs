#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const SOURCE_ROOT = join(ROOT, 'sources');
const SOURCE_SKILLS = join(SOURCE_ROOT, 'skills');
const SOURCE_AGENTS = join(SOURCE_ROOT, 'agents');
const CONFIG_FILE = join(ROOT, 'sync.config.json');
const DRY_RUN_REQUESTED = process.argv.includes('--dry-run');
const YES_REQUESTED = process.argv.includes('--yes');
const PRE_COMMIT_REQUESTED = process.argv.includes('--pre-commit');

const DEFAULT_CONFIG = {
  instructionsMode: 'append',
  preCommitSync: 'off',
  codexAgentDefaults: {
    model: 'gpt-5',
    reasoningEffort: 'high',
  },
  codexAgentModelMap: {
    opus: { model: 'gpt-5', reasoningEffort: 'xhigh' },
    sonnet: { model: 'gpt-5', reasoningEffort: 'high' },
    haiku: { model: 'gpt-5', reasoningEffort: 'medium' },
  },
};

const home = process.env.USERPROFILE || process.env.HOME;
if (!home) {
  throw new Error('USERPROFILE or HOME is required to locate global .claude/.codex directories.');
}

const TARGETS = {
  claude: {
    root: join(home, '.claude'),
    claudeMd: join(home, '.claude', 'CLAUDE.md'),
    claudeSyncMd: join(home, '.claude', 'CLAUDE-sync.md'),
    skills: join(home, '.claude', 'skills'),
    agents: join(home, '.claude', 'agents'),
  },
  codex: {
    root: join(home, '.codex'),
    agentsMd: join(home, '.codex', 'AGENTS.md'),
    agentsSyncMd: join(home, '.codex', 'AGENTS-sync.md'),
    skills: join(home, '.codex', 'skills'),
    agents: join(home, '.codex', 'agents'),
  },
};

const HEADER = 'AUTO-GENERATED from ai-config-sync. Edit the source under sources/.';
const MANAGED_INSTRUCTION_BEGIN = '<!-- ai-config-sync:begin instruction -->';
const MANAGED_INSTRUCTION_END = '<!-- ai-config-sync:end instruction -->';
const INSTRUCTION_MODES = new Set(['append', 'off', 'sidecar', 'managed']);
const PRE_COMMIT_SYNC_MODES = new Set(['on', 'off']);
let DRY_RUN = true;
let stats;
let operations;
let plannedCreates;

function createStats() {
  return {
    create: 0,
    overwrite: 0,
    unchanged: 0,
    skipped: 0,
  };
}

function createOperations() {
  return {
    targetRoots: [],
    instructions: [],
    skills: [],
    agents: [],
    skipped: [],
  };
}

function resetRunState(dryRun) {
  DRY_RUN = dryRun;
  stats = createStats();
  operations = createOperations();
  plannedCreates = new Set();
}

function readConfig() {
  if (!existsSync(CONFIG_FILE)) return DEFAULT_CONFIG;
  const userConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    codexAgentDefaults: {
      ...DEFAULT_CONFIG.codexAgentDefaults,
      ...(userConfig.codexAgentDefaults || {}),
    },
    codexAgentModelMap: {
      ...DEFAULT_CONFIG.codexAgentModelMap,
      ...(userConfig.codexAgentModelMap || {}),
    },
  };
}

const config = readConfig();
if (!INSTRUCTION_MODES.has(config.instructionsMode)) {
  throw new Error(
    `Invalid instructionsMode "${config.instructionsMode}". Expected one of: append, off, sidecar, managed.`,
  );
}
if (!PRE_COMMIT_SYNC_MODES.has(config.preCommitSync)) {
  throw new Error(`Invalid preCommitSync "${config.preCommitSync}". Expected one of: on, off.`);
}
const instructionMode = config.instructionsMode;
const preCommitSync = config.preCommitSync;

function instructionSpecsForMode(mode) {
  if (mode === 'off') return [];

  const destinations =
    mode === 'managed' || mode === 'append'
      ? {
          codex: TARGETS.codex.agentsMd,
          claude: TARGETS.claude.claudeMd,
        }
      : {
          codex: TARGETS.codex.agentsSyncMd,
          claude: TARGETS.claude.claudeSyncMd,
        };

  return [
    {
      name: 'AGENTS.md',
      source: join(SOURCE_ROOT, 'AGENTS.md'),
      target: TARGETS.codex,
      destination: destinations.codex,
    },
    {
      name: 'CLAUDE.md',
      source: join(SOURCE_ROOT, 'CLAUDE.md'),
      target: TARGETS.claude,
      destination: destinations.claude,
    },
  ];
}

const instructionSpecs = instructionSpecsForMode(instructionMode);

function recordOperation(section, action, label, destination) {
  stats[action] += 1;
  operations[section].push({ action, label, destination });
}

function markUnchanged() {
  stats.unchanged += 1;
}

function recordSkip(message) {
  stats.skipped += 1;
  operations.skipped.push(message);
}

function listEntries(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .map((name) => ({ name, path: join(dir, name), stat: statSync(join(dir, name)) }));
}

function ensureInside(path, parent) {
  const resolvedPath = resolve(path);
  const resolvedParent = resolve(parent);
  const rel = resolvedPath.slice(resolvedParent.length);
  if (resolvedPath !== resolvedParent && !rel.startsWith('\\') && !rel.startsWith('/')) {
    throw new Error(`Refusing to touch path outside ${resolvedParent}: ${resolvedPath}`);
  }
}

function ensureTargetRoot(target) {
  ensureInside(target.root, home);
  if (existsSync(target.root)) {
    const rootStat = statSync(target.root);
    if (!rootStat.isDirectory()) {
      throw new Error(`Global target is not a directory: ${target.root}`);
    }
    return;
  }

  if (DRY_RUN) {
    const resolvedRoot = resolve(target.root);
    if (!plannedCreates.has(resolvedRoot)) {
      plannedCreates.add(resolvedRoot);
      recordOperation('targetRoots', 'create', target.root);
    }
    return;
  }

  recordOperation('targetRoots', 'create', target.root);
  mkdirSync(target.root, { recursive: true });
}

function removeIfExists(path, targetRoot) {
  ensureInside(path, targetRoot);
  if (!existsSync(path)) return false;
  if (DRY_RUN) return true;
  rmSync(path, { recursive: true, force: true });
  return true;
}

function sameFileContent(path, content) {
  const expected = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const actualStat = statSync(path);
  if (!actualStat.isFile() || actualStat.size !== expected.length) return false;
  return readFileSync(path).equals(expected);
}

function sameTreeContent(source, destination) {
  if (!existsSync(destination)) return false;

  const sourceStat = statSync(source);
  const destinationStat = statSync(destination);

  if (sourceStat.isFile() || destinationStat.isFile()) {
    return sourceStat.isFile() && destinationStat.isFile() && sameFileContent(destination, readFileSync(source));
  }

  if (!sourceStat.isDirectory() || !destinationStat.isDirectory()) return false;

  const sourceNames = readdirSync(source).sort();
  const destinationNames = readdirSync(destination).sort();
  if (sourceNames.length !== destinationNames.length) return false;

  for (let index = 0; index < sourceNames.length; index += 1) {
    if (sourceNames[index] !== destinationNames[index]) return false;
    if (!sameTreeContent(join(source, sourceNames[index]), join(destination, destinationNames[index]))) {
      return false;
    }
  }

  return true;
}

function copyDirectory(source, destination, targetRoot) {
  ensureInside(destination, targetRoot);
  if (DRY_RUN) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function writeFile(destination, content, targetRoot, operation) {
  ensureInside(destination, targetRoot);
  const action = existsSync(destination) ? 'overwrite' : 'create';
  if (existsSync(destination)) {
    const destinationStat = statSync(destination);
    if (destinationStat.isFile() && sameFileContent(destination, content)) {
      markUnchanged();
      return;
    }

    if (!destinationStat.isFile()) {
      removeIfExists(destination, targetRoot);
    }
  }

  recordOperation(operation.section, action, operation.label, destination);
  if (DRY_RUN) {
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function countOccurrences(text, needle) {
  let count = 0;
  let position = text.indexOf(needle);
  while (position !== -1) {
    count += 1;
    position = text.indexOf(needle, position + needle.length);
  }
  return count;
}

function managedInstructionBlock(source) {
  const separator = source.endsWith('\n') ? '' : '\n';
  return `${MANAGED_INSTRUCTION_BEGIN}\n${source}${separator}${MANAGED_INSTRUCTION_END}`;
}

function appendManagedInstruction(destination, source) {
  const managedBlock = managedInstructionBlock(source);
  if (!existsSync(destination)) return managedBlock;

  const destinationStat = statSync(destination);
  if (!destinationStat.isFile()) {
    throw new Error(`Global instruction target is not a file: ${destination}`);
  }

  const existing = readFileSync(destination, 'utf8');
  const beginCount = countOccurrences(existing, MANAGED_INSTRUCTION_BEGIN);
  const endCount = countOccurrences(existing, MANAGED_INSTRUCTION_END);
  if (beginCount === 0 && endCount === 0) {
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    return `${existing}${separator}${managedBlock}`;
  }

  const beginIndex = existing.indexOf(MANAGED_INSTRUCTION_BEGIN);
  const endIndex = existing.indexOf(MANAGED_INSTRUCTION_END);
  if (beginCount !== 1 || endCount !== 1 || beginIndex > endIndex) {
    throw new Error(
      `Malformed managed instruction markers in ${destination}. Expected exactly one "${MANAGED_INSTRUCTION_BEGIN}" before exactly one "${MANAGED_INSTRUCTION_END}".`,
    );
  }

  const managedEnd = endIndex + MANAGED_INSTRUCTION_END.length;
  const existingManagedBlock = existing.slice(beginIndex, managedEnd);
  if (existingManagedBlock === managedBlock) return existing;
  return `${existing.slice(0, beginIndex)}${managedBlock}${existing.slice(managedEnd)}`;
}

function syncInstructions() {
  const plans = [];
  let count = 0;
  for (const spec of instructionSpecs) {
    if (!existsSync(spec.source)) {
      recordSkip(`instruction ${spec.name}: source file does not exist`);
      continue;
    }

    const sourceStat = statSync(spec.source);
    if (!sourceStat.isFile()) {
      recordSkip(`instruction ${spec.name}: instructions must be top-level files`);
      continue;
    }

    const source = readFileSync(spec.source, 'utf8');
    plans.push({
      spec,
      content: instructionMode === 'append' ? appendManagedInstruction(spec.destination, source) : source,
    });
    count += 1;
  }

  for (const { spec, content } of plans) {
    ensureTargetRoot(spec.target);
    writeFile(spec.destination, content, spec.target.root, {
      section: 'instructions',
      label: join('sources', spec.name),
    });
  }
  return count;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { meta, body: match[2] };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function codexAgentToml(name, markdown) {
  const { meta, body } = parseFrontmatter(markdown);
  const modelKey = meta.model;
  const mapped = modelKey ? config.codexAgentModelMap[modelKey] : undefined;
  const agentConfig = {
    ...config.codexAgentDefaults,
    ...(mapped || {}),
  };
  const description = meta.description || '';
  const instructions = body.replace(/^\r?\n+/, '').replace(/\s+$/, '');

  return [
    `# ${HEADER}`,
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    `model = ${tomlString(agentConfig.model)}`,
    `model_reasoning_effort = ${tomlString(agentConfig.reasoningEffort)}`,
    `developer_instructions = ${tomlString(instructions)}`,
    '',
  ].join('\n');
}

function replaceSkill(name, sourceDir, target) {
  const destination = join(target.skills, name);
  if (sameTreeContent(sourceDir, destination)) {
    markUnchanged();
    return;
  }

  recordOperation('skills', existsSync(destination) ? 'overwrite' : 'create', name, destination);
  removeIfExists(destination, target.root);
  copyDirectory(sourceDir, destination, target.root);
}

function syncSkills() {
  let count = 0;
  for (const entry of listEntries(SOURCE_SKILLS)) {
    if (!entry.stat.isDirectory()) {
      recordSkip(`skill ${entry.name}: skills must be top-level directories`);
      continue;
    }

    for (const target of Object.values(TARGETS)) {
      ensureTargetRoot(target);
      replaceSkill(entry.name, entry.path, target);
    }
    count += 1;
  }
  return count;
}

function clearAgentName(target, name, keepPath) {
  for (const candidate of [
    join(target.agents, `${name}.md`),
    join(target.agents, `${name}.toml`),
    join(target.agents, name),
  ]) {
    if (keepPath && resolve(candidate) === resolve(keepPath)) continue;
    if (existsSync(candidate)) {
      recordOperation('agents', 'overwrite', `stale ${basename(candidate)}`, candidate);
      removeIfExists(candidate, target.root);
    }
  }
}

function syncMarkdownAgent(entry) {
  const name = basename(entry.name, '.md');
  const markdown = readFileSync(entry.path, 'utf8');

  ensureTargetRoot(TARGETS.claude);
  const claudeDestination = join(TARGETS.claude.agents, `${name}.md`);
  clearAgentName(TARGETS.claude, name, claudeDestination);
  writeFile(claudeDestination, markdown, TARGETS.claude.root, {
    section: 'agents',
    label: entry.name,
  });

  ensureTargetRoot(TARGETS.codex);
  const codexDestination = join(TARGETS.codex.agents, `${name}.toml`);
  clearAgentName(TARGETS.codex, name, codexDestination);
  writeFile(codexDestination, codexAgentToml(name, markdown), TARGETS.codex.root, {
    section: 'agents',
    label: entry.name,
  });
}

function syncAgents() {
  let count = 0;
  for (const entry of listEntries(SOURCE_AGENTS)) {
    if (!entry.stat.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
      recordSkip(`agent ${entry.name}: agents must be top-level .md files`);
      continue;
    }

    syncMarkdownAgent(entry);
    count += 1;
  }
  return count;
}

function operationLine(operation) {
  const target = operation.destination ? `${operation.label} -> ${operation.destination}` : operation.label;
  return `  ${operation.action.padEnd(10)} ${target}`;
}

function appendOperationSection(lines, title, sectionOperations) {
  if (sectionOperations.length === 0) return;
  lines.push('', title, ...sectionOperations.map(operationLine));
}

function hasChangingOperations() {
  return Object.entries(operations)
    .filter(([section]) => section !== 'skipped')
    .some(([, sectionOperations]) => sectionOperations.length > 0);
}

function readGitHooksPath() {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function samePath(left, right) {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (process.platform === 'win32') {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  }
  return resolvedLeft === resolvedRight;
}

function isPreCommitHookConfigured() {
  const hooksPath = readGitHooksPath();
  if (!hooksPath) return false;
  return samePath(resolve(ROOT, hooksPath), join(ROOT, 'scripts', 'hooks'));
}

function reportNotices() {
  if (preCommitSync !== 'on' || isPreCommitHookConfigured()) return [];
  return [
    'preCommitSync is on, but git core.hooksPath is not set to scripts/hooks. Run: git config core.hooksPath scripts/hooks',
  ];
}

function printReport(result) {
  const lines = [`[sync-global-ai] ${DRY_RUN ? 'dry-run plan' : 'sync result'}`, `mode: ${instructionMode}`];
  if (instructionSpecs.length === 0) {
    lines.push('instruction targets: none');
  } else {
    lines.push('instruction targets:', ...instructionSpecs.map((spec) => `  ${spec.destination}`));
  }

  appendOperationSection(lines, 'Target roots', operations.targetRoots);
  appendOperationSection(lines, 'Instructions', operations.instructions);
  appendOperationSection(lines, 'Skills', operations.skills);
  appendOperationSection(lines, 'Agents', operations.agents);

  if (!hasChangingOperations()) {
    lines.push('', '(no changes)');
  }

  if (operations.skipped.length > 0) {
    lines.push('', 'Skipped', ...operations.skipped.map((message) => `  ${message}`));
  }

  const notices = reportNotices();
  if (notices.length > 0) {
    lines.push('', 'Notices', ...notices.map((message) => `  ${message}`));
  }

  lines.push(
    '',
    'Summary',
    `  create: ${stats.create}`,
    `  overwrite: ${stats.overwrite}`,
    `  unchanged: ${stats.unchanged}`,
    `  skipped: ${stats.skipped}`,
    `  scanned: ${result.instructions} instruction file(s), ${result.skills} skill(s), ${result.agents} agent(s)`,
    '  preserved unrelated global entries: yes',
  );

  console.log(lines.join('\n'));
}

function runSync(dryRun) {
  resetRunState(dryRun);
  const result = {
    instructions: syncInstructions(),
    skills: syncSkills(),
    agents: syncAgents(),
  };
  result.hasChanges = hasChangingOperations();
  printReport(result);
  return result;
}

async function confirmSync() {
  const rl = createInterface({ input, output });
  try {
    output.write('\nApply these changes? [y/N] ');
    for await (const line of rl) {
      const answer = line.trim();
      if (answer === 'Y' || answer === 'y') return true;
      if (answer === 'N' || answer === 'n' || answer === '') return false;
      output.write('Please answer Y or N.\n\nApply these changes? [y/N] ');
    }
    return false;
  } finally {
    rl.close();
  }
}

async function main() {
  if (DRY_RUN_REQUESTED) {
    runSync(true);
    return;
  }

  if (PRE_COMMIT_REQUESTED && preCommitSync === 'off') {
    console.log('[sync-global-ai] pre-commit sync skipped because preCommitSync is off.');
    return;
  }

  const plan = runSync(true);
  if (!plan.hasChanges) {
    console.log('\nNo changes to apply; sync cancelled without writing.');
    return;
  }

  if (YES_REQUESTED || PRE_COMMIT_REQUESTED) {
    console.log(
      PRE_COMMIT_REQUESTED
        ? '\n--pre-commit provided; applying planned changes without prompting.'
        : '\n--yes provided; applying planned changes without prompting.',
    );
  } else if (!(await confirmSync())) {
    console.log('Sync cancelled; no files were written.');
    return;
  }

  runSync(false);
}

await main();
