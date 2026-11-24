import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseEnvFile,
  upsertEnvText,
  removeEnvKeysText,
  backupEnvFile,
  revertEnvFile,
  latestBackupPath,
  writeEnvFile,
  readEnvFile,
  getEnvFilePath,
} from "../src/env-file.js";

describe("env-file", () => {
  // Restore NAVIGATOR_ENV_FILE to the suite default (vitest.config.js
  // test.env) rather than deleting it: unset, it means <cwd>/.env.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("parseEnvFile", () => {
    it("preserves raw lines, comments and quoted values", () => {
      const { lines, keyToLine } = parseEnvFile(
        "# header comment\nFOO=bar\nQUOTED=\"hello world\"\n# trailing comment\n"
      );
      expect(lines.length).toBe(5);
      expect(keyToLine.get("FOO").value).toBe("bar");
      expect(keyToLine.get("QUOTED").value).toBe("hello world");
      expect(lines[0].raw).toBe("# header comment");
      expect(lines[0].hasValue).toBe(false);
      expect(lines[4].raw).toBe("");
    });

    it("strips inline comments", () => {
      const { keyToLine } = parseEnvFile("DEBUG=1 # enable debug\n");
      expect(keyToLine.get("DEBUG").value).toBe("1");
    });
  });

  describe("upsertEnvText", () => {
    it("updates an existing key in place, preserving comments", () => {
      const text = "# keep me\nMAX_CONCURRENT_PAGE_OPS=30\nHEADLESS=true\n";
      const { text: out, changed } = upsertEnvText(text, { MAX_CONCURRENT_PAGE_OPS: 40 });
      expect(changed).toEqual(["MAX_CONCURRENT_PAGE_OPS"]);
      expect(out).toContain("# keep me");
      expect(out).toContain("MAX_CONCURRENT_PAGE_OPS=40");
    });

    it("appends a new key at the end", () => {
      const { text: out, changed } = upsertEnvText("FOO=1", { BAR: "2" });
      expect(changed).toEqual(["BAR"]);
      expect(out).toContain("BAR=2");
    });

    it("reports unchanged values", () => {
      const { unchanged } = upsertEnvText("FOO=1", { FOO: "1" });
      expect(unchanged).toEqual(["FOO"]);
    });

    it("quotes values that need quoting, leaves simple ones bare", () => {
      expect(upsertEnvText("", { UA: "Mozilla/5.0 (Linux x86_64) Chrome/130" }).text).toContain('UA="Mozilla/5.0 (Linux x86_64) Chrome/130"');
      expect(upsertEnvText("", { N: "40" }).text).toContain("N=40");
    });
  });

  describe("removeEnvKeysText", () => {
    it("removes the named keys", () => {
      const { text, removed } = removeEnvKeysText("A=1\nB=2\nC=3", ["B"]);
      expect(removed).toEqual(["B"]);
      expect(text).not.toContain("B=2");
      expect(text).toContain("A=1");
      expect(text).toContain("C=3");
    });
  });

  describe("backup + revert", () => {
    it("creates a backup and reverts from it", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "navigator-env-"));
      const file = path.join(dir, ".env");
      try {
        await writeEnvFile(file, "FOO=1\n");
        const backup = await backupEnvFile(file);
        expect(backup).toContain(".env.backup-");
        expect(await latestBackupPath(file)).toBe(backup);
        await writeEnvFile(file, "FOO=2\n");
        const reverted = await revertEnvFile(file);
        expect(reverted).toBe(backup);
        expect(await readEnvFile(file)).toBe("FOO=1\n");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("getEnvFilePath", () => {
    it("defaults to cwd/.env and honors NAVIGATOR_ENV_FILE", () => {
      vi.stubEnv("NAVIGATOR_ENV_FILE", undefined);
      expect(getEnvFilePath()).toBe(path.join(process.cwd(), ".env"));
      vi.stubEnv("NAVIGATOR_ENV_FILE", "/tmp/custom.env");
      expect(getEnvFilePath()).toBe("/tmp/custom.env");
    });
  });
});
