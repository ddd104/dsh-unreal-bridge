import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateProjectConfig } from "./schema.js";
import type { LoadedProjectConfig } from "../types/memoryTypes.js";

export interface LoadProjectConfigOptions {
  projectRoot?: string;
  configPath?: string;
  startDir?: string;
}

function findUProjectRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    try {
      if (readdirSync(current).some((entry) => entry.endsWith(".uproject"))) {
        return current;
      }
    } catch {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function firstExistingPath(paths: string[]): string | undefined {
  return paths.find((candidate) => existsSync(candidate));
}

export async function loadProjectConfig(options: LoadProjectConfigOptions = {}): Promise<LoadedProjectConfig> {
  const startDir = path.resolve(options.startDir ?? process.cwd());
  const projectRoot = path.resolve(options.projectRoot ?? findUProjectRoot(startDir) ?? startDir);
  const configPath = options.configPath
    ? path.resolve(options.configPath)
    : firstExistingPath([
        // 优先读取随插件迁移的通用模板。
        path.join(projectRoot, "Plugins", "DSHUnrealBridge", "Config", "Knowledge", "ProjectMemory.project.json"),
        // 保留旧工具的显式项目配置兼容入口。
        path.join(projectRoot, "AgentTools", "ProjectMemorySystem", "ProjectMemory.project.json"),
        path.join(projectRoot, "ProjectMemory.project.json"),
        path.join(startDir, "ProjectMemory.project.json")
      ]);

  if (!configPath) {
    throw new Error(
      `ProjectMemory.project.json was not found. Looked under ${projectRoot} and ${startDir}. ` +
        "Pass --project <projectRoot> or --config <configPath>."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ProjectMemory.project.json at ${configPath}: ${reason}`);
  }

  const config = validateProjectConfig(parsed, configPath);
  // 模板不固化项目名称；同一插件复制到其他 UE 项目时自动绑定当前项目。
  if (config.projectId === "$project") {
    const uproject = readdirSync(projectRoot).find((entry) => entry.endsWith(".uproject"));
    config.projectId = uproject ? path.basename(uproject, ".uproject") : path.basename(projectRoot);
    if (config.project) { config.project.name = config.projectId; config.project.uproject = uproject ?? ""; }
  }
  return {
    config,
    configPath,
    projectRoot,
    resolvedKnowledgeRoots: config.knowledgeRoots.map((root) => path.resolve(projectRoot, root)),
    resolvedMemoryOutputRoot: path.resolve(projectRoot, config.memoryOutputRoot)
  };
}
