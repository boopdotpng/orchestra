import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_MODEL = "gpt-5.5";
export const DEFAULT_SERVICE_TIER = "default";

export type ServiceTier = "default" | "priority";

export type OrchestraConfig = {
  model: string;
  serviceTier: ServiceTier;
  fastMode: boolean;
  path?: string | undefined;
};

export function loadOrchestraConfig(options: { path?: string | undefined; cwd?: string | undefined } = {}): OrchestraConfig {
  const path = resolveConfigPath(options);
  if (!path) {
    return defaultConfig();
  }

  const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const model = stringValue(parsed.model) ?? DEFAULT_MODEL;
  const serviceTier = serviceTierFromConfig(parsed);
  return {
    model,
    serviceTier,
    fastMode: serviceTier === "priority",
    path,
  };
}

export function normalizeServiceTier(value: unknown): ServiceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "default" || normalized === "normal" || normalized === "off") {
    return "default";
  }
  if (normalized === "priority" || normalized === "fast" || normalized === "on") {
    return "priority";
  }
  throw new Error(`invalid service tier: ${value}`);
}

function defaultConfig(): OrchestraConfig {
  return {
    model: DEFAULT_MODEL,
    serviceTier: DEFAULT_SERVICE_TIER,
    fastMode: false,
  };
}

function resolveConfigPath(options: { path?: string | undefined; cwd?: string | undefined }): string | undefined {
  const explicit = options.path ?? process.env.ORCHESTRA_CONFIG;
  if (explicit) {
    const path = expandHome(explicit);
    if (!existsSync(path)) {
      throw new Error(`config file not found: ${path}`);
    }
    return path;
  }

  const cwd = options.cwd ?? process.cwd();
  const candidates = [resolve(cwd, "orchestra.toml"), join(homedir(), ".orchestra", "config.toml")];
  return candidates.find((candidate) => existsSync(candidate));
}

function serviceTierFromConfig(parsed: Record<string, unknown>): ServiceTier {
  const explicit = parsed.service_tier ?? parsed.serviceTier;
  const explicitTier = normalizeServiceTier(explicit);
  if (explicitTier) {
    return explicitTier;
  }

  const fastMode = parsed.fast_mode ?? parsed.fastMode;
  if (typeof fastMode === "boolean") {
    return fastMode ? "priority" : "default";
  }
  return DEFAULT_SERVICE_TIER;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}
