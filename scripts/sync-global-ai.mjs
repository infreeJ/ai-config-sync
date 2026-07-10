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
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const SOURCE_ROOT = join(ROOT, 'sources');
const SOURCE_SKILLS = join(SOURCE_ROOT, 'skills');
const SOURCE_AGENTS = join(SOURCE_ROOT, 'agents');
const CONFIG_FILE = join(ROOT, 'sync.config.json');
const DRY_RUN = process.argv.includes('--dry-run');

const DEFAULT_CONFIG = {
  instructionsMode: 'sidecar',
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
const INSTRUCTION_MODES = new Set(['off', 'sidecar', 'managed']);

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
    `Invalid instructionsMode "${config.instructionsMode}". Expected one of: off, sidecar, managed.`,
  );
}
const instructionMode = config.instructionsMode;

function instructionSpecsForMode(mode) {
  if (mode === 'off') return [];

  const destinations =
    mode === 'managed'
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

function log(message) {
  console.log(`[sync-global-ai] ${message}`);
}

function logInstructionMode() {
  if (instructionMode === 'off') {
    log('instruction mode: off; instruction targets: none');
    return;
  }

  log(
    `instruction mode: ${instructionMode}; instruction targets: ${instructionSpecs
      .map((spec) => spec.destination)
      .join(', ')}`,
  );
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
    log(`would create target root ${target.root}`);
    return;
  }

  mkdirSync(target.root, { recursive: true });
}

function removeIfExists(path, targetRoot) {
  ensureInside(path, targetRoot);
  if (!existsSync(path)) return false;
  if (DRY_RUN) {
    log(`would remove ${path}`);
    return true;
  }
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
  if (DRY_RUN) {
    log(`would copy ${source} -> ${destination}`);
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function writeFile(destination, content, targetRoot) {
  ensureInside(destination, targetRoot);
  if (existsSync(destination)) {
    const destinationStat = statSync(destination);
    if (destinationStat.isFile() && sameFileContent(destination, content)) {
      log(`unchanged ${destination}`);
      return;
    }

    if (!destinationStat.isFile()) {
      removeIfExists(destination, targetRoot);
    }
  }

  if (DRY_RUN) {
    log(`would write ${destination}`);
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function syncInstructions() {
  let count = 0;
  for (const spec of instructionSpecs) {
    if (!existsSync(spec.source)) {
      log(`skip instruction ${spec.name}: source file does not exist`);
      continue;
    }

    const sourceStat = statSync(spec.source);
    if (!sourceStat.isFile()) {
      log(`skip instruction ${spec.name}: instructions must be top-level files`);
      continue;
    }

    ensureTargetRoot(spec.target);
    writeFile(spec.destination, readFileSync(spec.source), spec.target.root);
    count += 1;
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
    log(`unchanged ${destination}`);
    return;
  }

  removeIfExists(destination, target.root);
  copyDirectory(sourceDir, destination, target.root);
}

function syncSkills() {
  let count = 0;
  for (const entry of listEntries(SOURCE_SKILLS)) {
    if (!entry.stat.isDirectory()) {
      log(`skip skill ${entry.name}: skills must be top-level directories`);
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
    removeIfExists(candidate, target.root);
  }
}

function syncMarkdownAgent(entry) {
  const name = basename(entry.name, '.md');
  const markdown = readFileSync(entry.path, 'utf8');

  ensureTargetRoot(TARGETS.claude);
  const claudeDestination = join(TARGETS.claude.agents, `${name}.md`);
  clearAgentName(TARGETS.claude, name, claudeDestination);
  writeFile(claudeDestination, markdown, TARGETS.claude.root);

  ensureTargetRoot(TARGETS.codex);
  const codexDestination = join(TARGETS.codex.agents, `${name}.toml`);
  clearAgentName(TARGETS.codex, name, codexDestination);
  writeFile(codexDestination, codexAgentToml(name, markdown), TARGETS.codex.root);
}

function syncAgents() {
  let count = 0;
  for (const entry of listEntries(SOURCE_AGENTS)) {
    if (!entry.stat.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
      log(`skip agent ${entry.name}: agents must be top-level .md files`);
      continue;
    }

    syncMarkdownAgent(entry);
    count += 1;
  }
  return count;
}

logInstructionMode();
const instructions = syncInstructions();
const skills = syncSkills();
const agents = syncAgents();
const mode = DRY_RUN ? 'dry-run complete' : 'complete';
log(`${mode}: ${instructions} instruction file(s), ${skills} skill(s), ${agents} agent(s) synced; unrelated global entries preserved.`);
