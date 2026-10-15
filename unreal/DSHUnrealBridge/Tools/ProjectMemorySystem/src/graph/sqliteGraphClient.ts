import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  ExpandOptions,
  FindOptions,
  GraphContextResult,
  GraphEdge,
  GraphFeatureResult,
  GraphNode,
  GraphQuery,
  GraphQueryResult,
  GraphStatus,
  ImpactOptions,
  ImpactResult,
  ProjectGraphClient
} from "./projectGraphClient.js";

interface NodeRow {
  id: string;
  type: string;
  name: string;
  path: string;
  system: string;
  language: string;
  summary: string;
  metadata: string;
}

interface EdgeRow {
  from_id: string;
  to_id: string;
  type: string;
  metadata: string;
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function rowToNode(row: NodeRow, score?: number): GraphNode {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    path: row.path,
    system: row.system,
    language: row.language,
    summary: row.summary,
    metadata: parseMetadata(row.metadata),
    score
  };
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    from: row.from_id,
    to: row.to_id,
    type: row.type,
    metadata: parseMetadata(row.metadata)
  };
}

function classifyNodePaths(nodes: GraphNode[]) {
  return {
    filesToRead: [...new Set(nodes.filter((node) => node.type === "File").map((node) => node.path).filter(Boolean))],
    blueprintsToRead: [...new Set(nodes.filter((node) => node.type === "Blueprint").map((node) => node.path).filter(Boolean))],
    assetsToInspect: [
      ...new Set(
        nodes
          .filter((node) => ["Asset", "Material", "DataAsset", "Widget", "Level"].includes(node.type))
          .map((node) => node.path)
          .filter(Boolean)
      )
    ]
  };
}

export class SqliteGraphClient implements ProjectGraphClient {
  constructor(private readonly sqlitePath: string) {}

  async isAvailable(): Promise<boolean> {
    if (!existsSync(this.sqlitePath)) return false;
    try {
      const db = this.open();
      db.prepare("SELECT count(*) AS count FROM nodes").get();
      db.close();
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<GraphStatus> {
    if (!existsSync(this.sqlitePath)) {
      return {
        mode: "sqlite",
        available: false,
        source: this.sqlitePath,
        message: `Project graph sqlite database not found: ${this.sqlitePath}`,
        warnings: [`Project graph sqlite database not found: ${this.sqlitePath}`]
      };
    }

    try {
      const db = this.open();
      const nodeCount = (db.prepare("SELECT count(*) AS count FROM nodes").get() as { count: number }).count;
      const edgeCount = (db.prepare("SELECT count(*) AS count FROM edges").get() as { count: number }).count;
      db.close();
      return {
        mode: "sqlite",
        available: true,
        source: this.sqlitePath,
        nodeCount,
        edgeCount,
        message: "Project graph sqlite database is available.",
        warnings: []
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        mode: "sqlite",
        available: false,
        source: this.sqlitePath,
        message: `Project graph sqlite database could not be read: ${reason}`,
        warnings: [reason]
      };
    }
  }

  async findFeatureContext(query: string, options: FindOptions = {}): Promise<GraphFeatureResult> {
    const result = await this.queryGraph({ text: query, limit: options.limit ?? 8 });
    const owningSystem = result.nodes[0]?.system;
    const paths = classifyNodePaths(result.nodes);
    return {
      query,
      owningSystem,
      nodes: result.nodes,
      ...paths,
      warnings: result.warnings
    };
  }

  async queryGraph(query: GraphQuery): Promise<GraphQueryResult> {
    const db = this.open();
    try {
      const limit = Math.max(1, Math.min(query.limit ?? 20, 200));
      const nodes = query.nodeIds && query.nodeIds.length > 0
        ? this.nodesById(db, query.nodeIds, limit)
        : this.searchNodes(db, query.text ?? "", limit);
      const nodeIds = nodes.map((node) => node.id);
      const edges = this.edgesFor(db, nodeIds, "both", limit * 4);
      return {
        query,
        nodes,
        edges,
        warnings: []
      };
    } finally {
      db.close();
    }
  }

  async expandContext(seedNodes: string[], options: ExpandOptions = {}): Promise<GraphContextResult> {
    const db = this.open();
    try {
      const limit = Math.max(1, Math.min(options.limit ?? 80, 500));
      const depth = Math.max(0, Math.min(options.depth ?? 1, 3));
      const visited = new Set<string>();
      let frontier = [...seedNodes];
      const edges: GraphEdge[] = [];

      for (let level = 0; level <= depth; level += 1) {
        for (const id of frontier) visited.add(id);
        if (level === depth) break;
        const frontierEdges = this.edgesFor(db, frontier, "both", limit);
        edges.push(...frontierEdges);
        frontier = frontierEdges
          .flatMap((edge) => [edge.from, edge.to])
          .filter((id) => !visited.has(id))
          .slice(0, limit);
      }

      const nodes = this.nodesById(db, [...visited], limit);
      const paths = classifyNodePaths(nodes);
      return {
        seedNodes,
        nodes,
        edges,
        ...paths,
        warnings: []
      };
    } finally {
      db.close();
    }
  }

  async impactAnalysis(nodeIds: string[], options: ImpactOptions = {}): Promise<ImpactResult> {
    const db = this.open();
    try {
      const limit = Math.max(1, Math.min(options.limit ?? 80, 500));
      const direction = options.direction ?? "both";
      const edges = this.edgesFor(db, nodeIds, direction, limit);
      const ids = [...new Set([...nodeIds, ...edges.flatMap((edge) => [edge.from, edge.to])])];
      const nodes = this.nodesById(db, ids, limit);
      const impactedSystems = [...new Set(nodes.map((node) => node.system).filter(Boolean))].sort();
      return {
        nodeIds,
        nodes,
        edges,
        impactedSystems,
        risk: edges.length === 0 ? "none" : edges.length < 10 ? "low" : edges.length < 50 ? "medium" : "high",
        warnings: []
      };
    } finally {
      db.close();
    }
  }

  private open(): DatabaseSync {
    return new DatabaseSync(this.sqlitePath, { readOnly: true });
  }

  private nodesById(db: DatabaseSync, ids: string[], limit: number): GraphNode[] {
    if (ids.length === 0) return [];
    const statement = db.prepare("SELECT * FROM nodes WHERE id = ?");
    const nodes: GraphNode[] = [];
    for (const id of ids.slice(0, limit)) {
      const row = statement.get(id) as NodeRow | undefined;
      if (row) nodes.push(rowToNode(row));
    }
    return nodes;
  }

  private searchNodes(db: DatabaseSync, text: string, limit: number): GraphNode[] {
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (tokens.length === 0) return [];
    const rows = db.prepare("SELECT * FROM nodes").all() as unknown as NodeRow[];
    return rows
      .map((row) => {
        const haystack = `${row.name} ${row.path} ${row.system} ${row.summary}`.toLowerCase();
        const score = tokens.reduce((value, token) => value + (haystack.includes(token) ? 1 : 0), 0);
        return { row, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.row.path.localeCompare(b.row.path))
      .slice(0, limit)
      .map((item) => rowToNode(item.row, item.score));
  }

  private edgesFor(db: DatabaseSync, nodeIds: string[], direction: "in" | "out" | "both", limit: number): GraphEdge[] {
    if (nodeIds.length === 0) return [];
    const edges: GraphEdge[] = [];
    const incoming = db.prepare("SELECT from_id, to_id, type, metadata FROM edges WHERE to_id = ? LIMIT ?");
    const outgoing = db.prepare("SELECT from_id, to_id, type, metadata FROM edges WHERE from_id = ? LIMIT ?");
    for (const nodeId of nodeIds) {
      if (direction === "in" || direction === "both") {
        edges.push(...((incoming.all(nodeId, limit) as unknown as EdgeRow[]).map(rowToEdge)));
      }
      if (direction === "out" || direction === "both") {
        edges.push(...((outgoing.all(nodeId, limit) as unknown as EdgeRow[]).map(rowToEdge)));
      }
    }
    const seen = new Set<string>();
    return edges.filter((edge) => {
      const key = `${edge.from}\0${edge.type}\0${edge.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);
  }
}
