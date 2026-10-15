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

export class NullGraphClient implements ProjectGraphClient {
  constructor(private readonly reason = "Project graph integration is not available.") {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async status(): Promise<GraphStatus> {
    return {
      mode: "none",
      available: false,
      message: this.reason,
      warnings: [this.reason]
    };
  }

  async findFeatureContext(query: string, _options?: FindOptions): Promise<GraphFeatureResult> {
    return {
      query,
      nodes: [],
      filesToRead: [],
      blueprintsToRead: [],
      assetsToInspect: [],
      warnings: [this.reason]
    };
  }

  async queryGraph(query: GraphQuery): Promise<GraphQueryResult> {
    return {
      query,
      nodes: [],
      edges: [],
      warnings: [this.reason]
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
      warnings: [this.reason]
    };
  }

  async impactAnalysis(nodeIds: string[], _options?: ImpactOptions): Promise<ImpactResult> {
    return {
      nodeIds,
      nodes: [],
      edges: [],
      impactedSystems: [],
      risk: "none",
      warnings: [this.reason]
    };
  }
}
