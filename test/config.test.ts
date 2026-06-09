import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrchestraConfig, normalizeServiceTier, writeOrchestraConfig } from "../src/config";

const roots: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  process.env.HOME = originalHome;
  delete process.env.ORCHESTRA_CONFIG;
});

describe("orchestra config", () => {
  test("loads model and fast mode from toml", () => {
    const root = tempRoot();
    const path = join(root, "orchestra.toml");
    writeFileSync(path, 'model = "gpt-6"\nfast_mode = true\n');

    expect(loadOrchestraConfig({ path })).toEqual({
      model: "gpt-6",
      serviceTier: "priority",
      fastMode: true,
      sources: [path],
    });
  });

  test("keeps normal service tier by default", () => {
    const root = tempRoot();
    const path = join(root, "empty.toml");
    writeFileSync(path, "");
    expect(loadOrchestraConfig({ path })).toEqual({
      model: "gpt-5.5",
      serviceTier: "default",
      fastMode: false,
      sources: [path],
    });
  });

  test("local workdir config overrides global config", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const cwd = join(root, "project");
    run(["mkdir", "-p", cwd]);
    process.env.HOME = home;
    writeOrchestraConfig({ model: "global-model", fastMode: false }, { scope: "global", cwd });
    writeFileSync(join(cwd, ".orchestra"), 'model = "local-model"\nfast_mode = true\n');

    const config = loadOrchestraConfig({ cwd });
    expect(config.model).toBe("local-model");
    expect(config.serviceTier).toBe("priority");
    expect(config.sources).toEqual([join(home, ".orchestra", "config.toml"), join(cwd, ".orchestra")]);
  });

  test("accepts explicit service tier aliases", () => {
    expect(normalizeServiceTier("default")).toBe("default");
    expect(normalizeServiceTier("normal")).toBe("default");
    expect(normalizeServiceTier("priority")).toBe("priority");
    expect(normalizeServiceTier("fast")).toBe("priority");
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orchestra-config-test-"));
  roots.push(root);
  return root;
}

function run(cmd: string[]): void {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString());
  }
}
