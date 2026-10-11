function parseQuotedScalar(rawValue, quote, sourcePath, lineNumber) {
  let value = '';
  let doubleQuotedLiteral = quote;
  let index = 1;
  while (index < rawValue.length) {
    const character = rawValue[index];
    if (quote === '"' && character === '\\') {
      if (index + 1 === rawValue.length) {
        throw new Error(`Invalid frontmatter in ${sourcePath} at line ${lineNumber}: unterminated quoted value.`);
      }
      doubleQuotedLiteral += `${character}${rawValue[index + 1]}`;
      index += 2;
      continue;
    }
    if (character !== quote) {
      value += character;
      doubleQuotedLiteral += character;
      index += 1;
      continue;
    }

    if (quote === "'" && rawValue[index + 1] === "'") {
      value += "'";
      index += 2;
      continue;
    }
    break;
  }

  if (index === rawValue.length) {
    throw new Error(`Invalid frontmatter in ${sourcePath} at line ${lineNumber}: unterminated quoted value.`);
  }

  const remainder = rawValue.slice(index + 1).trim();
  if (remainder !== '' && !remainder.startsWith('#')) {
    throw new Error(`Invalid frontmatter in ${sourcePath} at line ${lineNumber}: invalid quoted value.`);
  }
  if (quote === '"') {
    try {
      return JSON.parse(`${doubleQuotedLiteral}"`);
    } catch {
      throw new Error(`Invalid frontmatter in ${sourcePath} at line ${lineNumber}: invalid quoted value.`);
    }
  }
  return value;
}

function parseScalar(rawValue, sourcePath, lineNumber) {
  const value = rawValue.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    return parseQuotedScalar(value, value[0], sourcePath, lineNumber);
  }
  if (value.startsWith('#')) return '';
  return value.replace(/\s+#.*$/, '').trim();
}

export function parseFrontmatter(text, sourcePath = 'source file') {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { meta: {}, body: text };
  }

  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid frontmatter in ${sourcePath}: missing closing --- delimiter.`);
  }

  const meta = {};
  for (const [index, line] of match[1].split(/\r?\n/).entries()) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      throw new Error(`Invalid frontmatter in ${sourcePath} at line ${index + 2}: ${line}`);
    }
    if (Object.hasOwn(meta, kv[1])) {
      throw new Error(`Invalid frontmatter in ${sourcePath}: duplicate field "${kv[1]}".`);
    }
    meta[kv[1]] = parseScalar(kv[2], sourcePath, index + 2);
  }
  return { meta, body: match[2] };
}
