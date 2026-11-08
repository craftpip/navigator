import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
// usage: node stage-idx.mjs <file> <idx> [<idx>...]
const [file, ...idxs] = process.argv.slice(2);
const want = new Set(idxs.map(Number));
const diff = execSync(`git diff HEAD --unified=0 -- ${file}`, { encoding: "utf8", maxBuffer: 64e6 }).split("\n");
const header = diff.filter((l) => /^(diff |index |--- |\+\+\+ )/.test(l));
const hunks = []; let cur = null;
for (const line of diff) {
  if (line.startsWith("@@")) { cur = [line]; hunks.push(cur); }
  else if (cur) cur.push(line);
}
const picked = hunks.filter((_, i) => want.has(i));
if (picked.length !== want.size) { console.error("index mismatch"); process.exit(1); }
writeFileSync("/tmp/idx.patch", `${header.join("\n")}\n${picked.map((h) => h.join("\n")).join("\n")}\n`);
execSync("git apply --cached --unidiff-zero /tmp/idx.patch", { stdio: "inherit" });
console.log(`staged hunks [${[...want].join(",")}] of ${file}`);
