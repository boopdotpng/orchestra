import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrchestraConfig, normalizeServiceTier } from "../src/config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
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
      path,
    });
  });

  test("keeps normal service tier by default", () => {
    const root = tempRoot();
    expect(loadOrchestraConfig({ cwd: root })).toEqual({
      model: "gpt-5.5",
      serviceTier: "default",
      fastMode: false,
    });
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
