import path from "node:path";
import type { GraphMode, ProjectMemoryConfig } from "../types/memoryTypes.js";

const VALID_GRAPH_MODES = new Set<GraphMode>(["sqlite", "mcp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, source: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source}: required string field "${key}" is missing or empty.`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, source: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${source}: required boolean field "${key}" is missing.`);
  }
  return value;
}

function requireStringArray(record: Record<string, unknown>, key: string, source: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${source}: required string array field "${key}" is missing or invalid.`);
  }
  return value;
}

function assertRelativePath(value: string, field: string, source: string): void {
  // 配置只接受项目内的相对路径。
  if (path.isAbsolute(value) || value.replace(/\\/g, "/").split("/").includes("..") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`${source}: field "${field}" must be relative to the project root.`);
  }
}

function optionalRelativePath(record: Record<string, unknown>, key: string, source: string): void {
  const value = record[key];
  if (typeof value === "string" && value.trim() !== "") {
    assertRelativePath(value, key, source);
  }
}

export function validateProjectConfig(raw: unknown, source = "ProjectMemory.project.json"): ProjectMemoryConfig {
  if (!isRecord(raw)) {
    throw new Error(`${source}: config must be a JSON object.`);
  }

  const projectId = requireString(raw, "projectId", source);
  const knowledgeRoots = requireStringArray(raw, "knowledgeRoots", source);
  const memoryOutputRoot = requireString(raw, "memoryOutputRoot", source);

  for (const root of knowledgeRoots) {
    assertRelativePath(root, "knowledgeRoots", source);
  }
  assertRelativePath(memoryOutputRoot, "memoryOutputRoot", source);

  const graph = raw.graph;
  if (!isRecord(graph)) {
    throw new Error(`${source}: required object field "graph" is missing.`);
  }

  const enabled = requireBoolean(graph, "enabled", `${source}.graph`);
  const mode = requireString(graph, "mode", `${source}.graph`);
  if (!VALID_GRAPH_MODES.has(mode as GraphMode)) {
    throw new Error(`${source}.graph: field "mode" must be one of: sqlite, mcp.`);
  }

  if (isRecord(graph.sqlite)) {
    optionalRelativePath(graph.sqlite, "databasePath", `${source}.graph.sqlite`);
    optionalRelativePath(graph.sqlite, "nodesPath", `${source}.graph.sqlite`);
    optionalRelativePath(graph.sqlite, "edgesPath", `${source}.graph.sqlite`);
  }
  optionalRelativePath(graph, "sqlitePath", `${source}.graph`);

  if (isRecord(raw.validation)) {
    optionalRelativePath(raw.validation, "buildCommands", `${source}.validation`);
    optionalRelativePath(raw.validation, "testMap", `${source}.validation`);
  }

  return {
    ...(raw as unknown as ProjectMemoryConfig),
    projectId,
    knowledgeRoots,
    memoryOutputRoot,
    graph: {
      ...(graph as unknown as ProjectMemoryConfig["graph"]),
      enabled,
      mode: mode as GraphMode
    }
  };
}
