import { execSync } from "node:child_process";

const from = process.argv[2] || "";
const tag = process.env.GITHUB_REF_NAME || "";
const repo = process.env.GITHUB_REPOSITORY || "craftpip/navigator";

const range = from ? `${from}..HEAD` : "";
const log = execSync(
  `git log --no-merges --pretty=format:'%h%x09%s' ${range}`,
  { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
);

const lines = log.trim().split("\n").filter(Boolean);

const groups = {
  "Features": [],
  "Bug Fixes": [],
  "Documentation": [],
  "Tests": [],
  "Refactors & Chores": [],
  "Other": [],
};

const typeOf = (msg) => {
  const m = msg.match(/^([a-z]+)[(!:]/);
  if (!m) return "Other";
  switch (m[1]) {
    case "feat":
      return "Features";
    case "fix":
      return "Bug Fixes";
    case "docs":
      return "Documentation";
    case "test":
      return "Tests";
    case "refactor":
    case "perf":
    case "chore":
    case "build":
    case "ci":
    case "style":
      return "Refactors & Chores";
    default:
      return "Other";
  }
};

for (const line of lines) {
  const [hash, ...rest] = line.split("\t");
  const subject = rest.join("\t").trim();
  const group = typeOf(subject);
  groups[group].push(`- ${subject} ([${hash}](https://github.com/${repo}/commit/${hash}))`);
}

const out = [];
out.push(`## Navigator ${tag || ""}`.trim());
out.push("");
if (from) {
  out.push(`${lines.length} commits since \`${from}\`.`);
  out.push("");
}

for (const [name, items] of Object.entries(groups)) {
  if (items.length === 0) continue;
  out.push(`### ${name}`);
  out.push("");
  out.push(...items);
  out.push("");
}

if (from && tag) {
  out.push(`**Full Changelog**: https://github.com/${repo}/compare/${from}...${tag}`);
}

process.stdout.write(out.join("\n"));