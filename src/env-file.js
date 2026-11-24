import fs from "node:fs/promises";
import path from "node:path";

export function getEnvFilePath() {
  return process.env.NAVIGATOR_ENV_FILE
    ? path.resolve(process.env.NAVIGATOR_ENV_FILE)
    : path.join(process.cwd(), ".env");
}

export function parseEnvFile(text) {
  const lines = [];
  const keyToLine = new Map();
  String(text || "")
    .split("\n")
    .forEach((raw, index) => {
      const match = ENV_LINE.exec(raw);
      const entry = { raw, index, key: null, value: null, hasValue: false };
      if (match) {
        const key = match[2];
        const value = parseEnvValue(match[3]);
        entry.key = key;
        entry.value = value;
        entry.hasValue = true;
        if (!keyToLine.has(key)) keyToLine.set(key, entry);
      }
      lines.push(entry);
    });
  return { lines, keyToLine };
}

// `[export ]KEY = value` — group 1 is everything up to and including `=`
// (kept verbatim on update), group 2 the key, group 3 the raw value.
const ENV_LINE = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)(.*?)\s*$/;
const DOUBLE_QUOTE_ESCAPES = { "\\": "\\", n: "\n", t: "\t", '"': '"' };

/**
 * Parse the right-hand side of a .env line. Quoting is resolved FIRST: a
 * quoted value ends at its closing quote, so a `#` inside quotes is data, and
 * anything after the closing quote (e.g. ` # comment`) is ignored. Only an
 * unquoted value has an inline comment (` #…`) stripped.
 */
export function parseEnvValue(rawValue) {
  const text = String(rawValue || "").trim();
  const quote = text[0];
  if (quote === '"') {
    let out = "";
    for (let i = 1; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length && Object.hasOwn(DOUBLE_QUOTE_ESCAPES, text[i + 1])) {
        out += DOUBLE_QUOTE_ESCAPES[text[i + 1]];
        i += 1;
        continue;
      }
      if (ch === '"') return out;
      out += ch;
    }
    return text; // unterminated quote: keep the value as written
  }
  if (quote === "'") {
    const close = text.indexOf("'", 1);
    return close === -1 ? text : text.slice(1, close);
  }
  const comment = text.search(/\s#/);
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

function serializeValue(raw) {
  const value = String(raw);
  if (/^[A-Za-z0-9_,.\-:/+@%]+$/.test(value) && value === value.trim()) {
    return value;
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export function upsertEnvText(text, updates) {
  const { lines, keyToLine } = parseEnvFile(text);
  const result = { changed: [], unchanged: [] };
  let didAddNewline = false;

  for (const [key, value] of Object.entries(updates)) {
    const existing = keyToLine.get(key);
    if (existing && existing.hasValue) {
      // Concatenate, never String.replace with a template: replacement
      // patterns ($&, $1, $$) inside the value would be expanded.
      const newRaw = `${ENV_LINE.exec(existing.raw)[1]}${serializeValue(value)}`;
      if (newRaw !== existing.raw) {
        existing.raw = newRaw;
        existing.value = String(value);
        result.changed.push(key);
      } else {
        result.unchanged.push(key);
      }
    } else {
      if (!didAddNewline && lines.length && lines[lines.length - 1].raw !== "") {
        lines.push({ raw: "", index: lines.length, key: null, value: null, hasValue: false });
        didAddNewline = true;
      }
      lines.push({
        raw: `${key}=${serializeValue(value)}`,
        index: lines.length,
        key,
        value: String(value),
        hasValue: true
      });
      result.changed.push(key);
    }
  }

  return { text: lines.map((entry) => entry.raw).join("\n"), changed: result.changed, unchanged: result.unchanged };
}

export function removeEnvKeysText(text, keys) {
  const { lines } = parseEnvFile(text);
  const remove = new Set(keys);
  const removed = [];
  const kept = lines.filter((entry) => {
    if (entry.key && remove.has(entry.key)) {
      removed.push(entry.key);
      return false;
    }
    return true;
  });
  return { text: kept.map((entry) => entry.raw).join("\n"), removed };
}

export async function backupEnvFile(filePath) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = `${filePath}.backup-${stamp}`;
    const text = await fs.readFile(filePath, "utf8");
    await fs.writeFile(backupPath, text, "utf8");
    return backupPath;
  } catch {
    return null;
  }
}

export async function latestBackupPath(filePath) {
  try {
    const dir = path.dirname(filePath);
    const entries = await fs.readdir(dir);
    const prefix = `${path.basename(filePath)}.backup-`;
    const backups = entries.filter((entry) => entry.startsWith(prefix)).sort().reverse();
    return backups.length ? path.join(dir, backups[0]) : null;
  } catch {
    return null;
  }
}

export async function revertEnvFile(filePath) {
  const backupPath = await latestBackupPath(filePath);
  if (!backupPath) return null;
  const text = await fs.readFile(backupPath, "utf8");
  await fs.writeFile(filePath, text, "utf8");
  return backupPath;
}

const envChangeHistory = [];

export function recordEnvChange(entry) {
  envChangeHistory.unshift({ ts: new Date().toISOString(), ...entry });
  if (envChangeHistory.length > 50) envChangeHistory.length = 50;
}

export function getEnvChangeHistory() {
  return envChangeHistory.slice();
}

export async function readEnvFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function writeEnvFile(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}
