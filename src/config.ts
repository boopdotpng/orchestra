import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_MODEL = "gpt-5.5";
export const DEFAULT_SERVICE_TIER = "default";

export type ServiceTier = "default" | "priority";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type OrchestraConfig = {
  model: string;
  serviceTier: ServiceTier;
  fastMode: boolean;
  reasoningEffort?: ReasoningEffort | undefined;
  sources: string[];
};

export type OrchestraConfigPatch = {
  model?: string | undefined;
  fastMode?: boolean | undefined;
  serviceTier?: ServiceTier | undefined;
  reasoningEffort?: ReasoningEffort | null | undefined;
};

export type ConfigScope = "global" | "local";

export function loadOrchestraConfig(options: { path?: string | undefined; cwd?: string | undefined } = {}): OrchestraConfig {
  const sources = resolveConfigSources(options);
  let raw: Partial<OrchestraConfigPatch> = {};
  for (const source of sources) {
    raw = { ...raw, ...parseConfigFile(source) };
  }

  const model = raw.model ?? DEFAULT_MODEL;
  const serviceTier = raw.serviceTier ?? (raw.fastMode === true ? "priority" : DEFAULT_SERVICE_TIER);
  return {
    model,
    serviceTier,
    fastMode: serviceTier === "priority",
    reasoningEffort: raw.reasoningEffort ?? undefined,
    sources,
  };
}

export function writeOrchestraConfig(
  patch: OrchestraConfigPatch,
  options: { scope?: ConfigScope | undefined; path?: string | undefined; cwd?: string | undefined } = {},
): OrchestraConfig {
  const path = options.path ? expandHome(options.path) : configPathForScope(options.scope ?? "global", options.cwd ?? process.cwd());
  const existing = existsSync(path) ? parseConfigFile(path) : {};
  const next: OrchestraConfigPatch = { ...existing, ...patch };
  if (next.serviceTier && patch.fastMode === undefined) {
    next.fastMode = next.serviceTier === "priority";
  }
  if (patch.fastMode !== undefined) {
    next.serviceTier = patch.fastMode ? "priority" : "default";
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, configToToml(next));
  return loadOrchestraConfig({ cwd: options.cwd });
}

export function ensureGlobalOrchestraConfig(): string {
  const path = configPathForScope("global", process.cwd());
  if (!existsSync(path)) {
    writeOrchestraConfig({ model: DEFAULT_MODEL, fastMode: false }, { path });
  }
  return path;
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

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh") {
    return normalized;
  }
  throw new Error(`invalid reasoning effort: ${value}`);
}

function resolveConfigSources(options: { path?: string | undefined; cwd?: string | undefined }): string[] {
  const explicit = options.path ?? process.env.ORCHESTRA_CONFIG;
  if (explicit) {
    const path = expandHome(explicit);
    if (!existsSync(path)) {
      throw new Error(`config file not found: ${path}`);
    }
    return [path];
  }

  const cwd = options.cwd ?? process.cwd();
  return [
    configPathForScope("global", cwd),
    resolve(cwd, ".orchestra"),
    resolve(cwd, ".orchestra.toml"),
    resolve(cwd, ".orchestra", "config.toml"),
  ].filter((candidate) => isReadableFile(candidate));
}

function parseConfigFile(path: string): OrchestraConfigPatch {
  const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const model = stringValue(parsed.model);
  const explicit = parsed.service_tier ?? parsed.serviceTier;
  const explicitTier = normalizeServiceTier(explicit);
  const reasoningEffort = normalizeReasoningEffort(parsed.reasoning_effort ?? parsed.reasoningEffort ?? parsed.model_reasoning_effort);
  const fastMode = parsed.fast_mode ?? parsed.fastMode;
  const patch: OrchestraConfigPatch = {};
  if (model) {
    patch.model = model;
  }
  if (reasoningEffort) {
    patch.reasoningEffort = reasoningEffort;
  }
  if (explicitTier) {
    patch.serviceTier = explicitTier;
    patch.fastMode = explicitTier === "priority";
  } else if (typeof fastMode === "boolean") {
    patch.fastMode = fastMode;
    patch.serviceTier = fastMode ? "priority" : "default";
  }
  return patch;
}

function configPathForScope(scope: ConfigScope, cwd: string): string {
  if (scope === "local") {
    return resolve(cwd, ".orchestra");
  }
  return join(homeDir(), ".orchestra", "config.toml");
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function configToToml(config: OrchestraConfigPatch): string {
  const lines: string[] = [];
  if (config.model) {
    lines.push(`model = ${JSON.stringify(config.model)}`);
  }
  if (config.fastMode !== undefined) {
    lines.push(`fast_mode = ${config.fastMode ? "true" : "false"}`);
  } else if (config.serviceTier) {
    lines.push(`service_tier = ${JSON.stringify(config.serviceTier)}`);
  }
  if (config.reasoningEffort) {
    lines.push(`reasoning_effort = ${JSON.stringify(config.reasoningEffort)}`);
  }
  return `${lines.join("\n")}\n`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function expandHome(path: string): string {
  if (path === "~") {
    return homeDir();
  }
  if (path.startsWith("~/")) {
    return join(homeDir(), path.slice(2));
  }
  return resolve(path);
}

function homeDir(): string {
  return process.env.HOME ?? homedir();
}
