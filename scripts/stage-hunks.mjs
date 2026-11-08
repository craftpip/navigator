#!/usr/bin/env node
/**
 * Stage selected hunks of a file by matching a marker string inside each hunk.
 * Used to keep a plan's commit scoped to its own lines in files that also carry
 * unrelated in-flight work.
 *
 *   node scripts/stage-hunks.mjs <file> <marker> [<marker> ...]
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [file, ...markers] = process.argv.slice(2);
if (!file || !markers.length) {
  console.error('usage: node scripts/stage-hunks.mjs <file> <marker> [...]');
  process.exit(2);
}

const diff = execSync(`git diff HEAD -- ${file}`, { encoding: 'utf8', maxBuffer: 64e6 }).split('\n');
const header = diff.filter((l) => /^(diff |index |--- |\+\+\+ )/.test(l));
const hunks = [];
let cur = null;
for (const line of diff) {
  if (line.startsWith('@@')) { cur = [line]; hunks.push(cur); }
  else if (cur) cur.push(line);
}

const wanted = hunks.filter((h) => markers.some((m) => h.some((l) => l.includes(m))));
if (wanted.length !== markers.length) {
  console.error(`error: matched ${wanted.length} hunks for ${markers.length} markers in ${file}`);
  process.exit(1);
}

writeFileSync('/tmp/stage-hunks.patch', `${header.join('\n')}\n${wanted.map((h) => h.join('\n')).join('\n')}\n`);
execSync('git apply --cached /tmp/stage-hunks.patch', { stdio: 'inherit' });
console.log(`staged ${wanted.length} hunk(s) of ${file}`);
