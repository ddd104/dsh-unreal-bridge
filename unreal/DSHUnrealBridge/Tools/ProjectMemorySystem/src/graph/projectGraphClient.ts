import path from "node:path";
import type { LoadedProjectConfig, ProjectMemoryConfig } from "../types/memoryTypes.js";
import { McpGraphClient } from "./mcpGraphClient.js";
import { NullGraphClient } from "./nullGraphClient.js";
import { SqliteGraphClient } from "./sqliteGraphClient.js";

export type GraphClientMode = "none" | "sqlite" | "mcp";

export interface GraphStatus {
  mode: GraphClientMode;
  available: boolean;
  message: string;
  nodeCount?: number;
  edgeCount?: number;
  source?: string;
  warnings: string[];
}

export interface FindOptions {
  limit?: number;
}

export interface GraphQuery {
  text?: string;
  nodeIds?: string[];
  limit?: number;
}

export interface ExpandOptions {
  depth?: number;
  limit?: number;
}

export interface ImpactOptions {
  direction?: "in" | "out" | "both";
  limit?: number;
}

export interface GraphNode {
  id: string;
  type: string;
  name: string;
  path: string;
  system: string;
  language?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  metadata?: Record<string, unknown>;
}

export interface GraphFeatureResult {
  query: string;
  owningSystem?: string;
  nodes: GraphNode[];
  filesToRead: string[];
  blueprintsToRead: string[];
  assetsToInspect: string[];
  warnings: string[];
}

export interface GraphQueryResult {
  query: GraphQuery;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
}

export interface GraphContextResult {
  seedNodes: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  filesToRead: string[];
  blueprintsToRead: string[];
  assetsToInspect: string[];
  warnings: string[];
}

export interface ImpactResult {
  nodeIds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  impactedSystems: string[];
  risk: "none" | "low" | "medium" | "high";
  warnings: string[];
}

export interface ProjectGraphClient {
  isAvailable(): Promise<boolean>;
  status(): Promise<GraphStatus>;
  findFeatureContext(query: string, options?: FindOptions): Promise<GraphFeatureResult>;
  queryGraph(query: GraphQuery): Promise<GraphQueryResult>;
  expandContext(seedNodes: string[], options?: ExpandOptions): Promise<GraphContextResult>;
  impactAnalysis(nodeIds: string[], options?: ImpactOptions): Promise<ImpactResult>;
}

function graphConfigValue(config: ProjectMemoryConfig, key: string): string | undefined {
  const graph = config.graph as unknown as Record<string, unknown>;
  const value = graph[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function createProjectGraphClient(loaded: LoadedProjectConfig): ProjectGraphClient {
  if (!loaded.config.graph.enabled) {
    return new NullGraphClient("Project graph is disabled in ProjectMemory.project.json.");
  }

  if (loaded.config.graph.mode === "sqlite") {
    const sqlitePath =
      graphConfigValue(loaded.config, "sqlitePath") ??
      loaded.config.graph.sqlite?.databasePath ??
      "Plugins/DSHUnrealBridge/Cache/Graph/project_graph.sqlite";
    return new SqliteGraphClient(path.resolve(loaded.projectRoot, sqlitePath));
  }

  if (loaded.config.graph.mode === "mcp") {
    const serverName =
      graphConfigValue(loaded.config, "mcpServerName") ??
      loaded.config.graph.mcp?.serverName ??
      "ue_project_graph";
    const url = graphConfigValue(loaded.config, "url") ?? graphConfigValue(loaded.config, "mcpUrl");
    return new McpGraphClient({ serverName, url });
  }

  return new NullGraphClient("Unsupported project graph mode.");
}
