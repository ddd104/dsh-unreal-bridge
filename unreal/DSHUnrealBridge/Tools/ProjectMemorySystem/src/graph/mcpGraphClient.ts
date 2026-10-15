import type {
  ExpandOptions,
  FindOptions,
  GraphContextResult,
  GraphFeatureResult,
  GraphQuery,
  GraphQueryResult,
  GraphStatus,
  ImpactOptions,
  ImpactResult,
  ProjectGraphClient
} from "./projectGraphClient.js";

export interface McpGraphClientOptions {
  serverName: string;
  url?: string;
}

export class McpGraphClient implements ProjectGraphClient {
  constructor(private readonly options: McpGraphClientOptions) {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async status(): Promise<GraphStatus> {
    return {
      mode: "mcp",
      available: false,
      source: this.options.url ?? this.options.serverName,
      message: "Project Graph MCP adapter is configured, but direct MCP invocation is not implemented in Phase 5.",
      warnings: [
        "Use a host-provided MCP bridge in a later phase, or switch graph.mode to sqlite for local read-only graph context."
      ]
    };
  }

  async findFeatureContext(query: string, _options?: FindOptions): Promise<GraphFeatureResult> {
    return {
      query,
      nodes: [],
      filesToRead: [],
      blueprintsToRead: [],
      assetsToInspect: [],
      warnings: [this.unavailableMessage()]
    };
  }

  async queryGraph(query: GraphQuery): Promise<GraphQueryResult> {
    return {
      query,
      nodes: [],
      edges: [],
      warnings: [this.unavailableMessage()]
    };
  }

  async expandContext(seedNodes: string[], _options?: ExpandOptions): Promise<GraphContextResult> {
    return {
      seedNodes,
      nodes: [],
      edges: [],
      filesToRead: [],
      blueprintsToRead: [],
      assetsToInspect: [],
      warnings: [this.unavailableMessage()]
    };
  }

  async impactAnalysis(nodeIds: string[], _options?: ImpactOptions): Promise<ImpactResult> {
    return {
      nodeIds,
      nodes: [],
      edges: [],
      impactedSystems: [],
      risk: "none",
      warnings: [this.unavailableMessage()]
    };
  }

  private unavailableMessage(): string {
    return `Project Graph MCP adapter (${this.options.url ?? this.options.serverName}) is not callable from this Phase 5 implementation.`;
  }
}
