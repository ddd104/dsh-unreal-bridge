import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertEdgeRecord, assertNodeRecord, type EdgeRecord, type NodeRecord, type NodeType } from "./schema.js";

export function toProjectPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function makeSafeId(value: string): string {
  return toProjectPath(value).replace(/[^A-Za-z0-9_:/.-]+/g, "_");
}

export function fileNodeId(relativePath: string): string {
  return `file:${makeSafeId(relativePath)}`;
}

export function symbolNodeId(type: NodeType, name: string, scope: string): string {
  return `${type.toLowerCase()}:${makeSafeId(scope)}:${makeSafeId(name)}`;
}

export function createFileNode(relativePath: string, system: string, language: string, summary?: string): NodeRecord {
  const normalizedPath = toProjectPath(relativePath);
  return {
    id: fileNodeId(normalizedPath),
    type: "File",
    name: path.posix.basename(normalizedPath),
    path: normalizedPath,
    system,
    language,
    summary: summary ?? `${language} file ${normalizedPath}`,
    metadata: {}
  };
}

function normalizeNode(node: NodeRecord): NodeRecord {
  return {
    ...node,
    path: toProjectPath(node.path),
    metadata: node.metadata ?? {}
  };
}

function edgeKey(edge: EdgeRecord): string {
  return `${edge.from}\u0000${edge.type}\u0000${edge.to}\u0000${JSON.stringify(edge.metadata ?? {})}`;
}

export class GraphStore {
  private readonly nodeMap = new Map<string, NodeRecord>();
  private readonly edgeMap = new Map<string, EdgeRecord>();

  addNode(node: NodeRecord): NodeRecord {
    const normalized = normalizeNode(node);
    assertNodeRecord(normalized);

    const existing = this.nodeMap.get(normalized.id);
    if (!existing) {
      this.nodeMap.set(normalized.id, normalized);
      return normalized;
    }

    const merged: NodeRecord = {
      ...existing,
      ...normalized,
      summary: normalized.summary || existing.summary,
      metadata: {
        ...existing.metadata,
        ...normalized.metadata
      }
    };
    this.nodeMap.set(merged.id, merged);
    return merged;
  }

  addEdge(edge: EdgeRecord): EdgeRecord {
    const normalized: EdgeRecord = {
      ...edge,
      metadata: edge.metadata ?? {}
    };
    assertEdgeRecord(normalized);
    this.edgeMap.set(edgeKey(normalized), normalized);
    return normalized;
  }

  getNode(id: string): NodeRecord | undefined {
    return this.nodeMap.get(id);
  }

  nodes(): NodeRecord[] {
    return [...this.nodeMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  edges(): EdgeRecord[] {
    return [...this.edgeMap.values()].sort((a, b) => {
      const from = a.from.localeCompare(b.from);
      if (from !== 0) return from;
      const type = a.type.localeCompare(b.type);
      if (type !== 0) return type;
      return a.to.localeCompare(b.to);
    });
  }

  outgoing(nodeId: string): EdgeRecord[] {
    return this.edges().filter((edge) => edge.from === nodeId);
  }

  incoming(nodeId: string): EdgeRecord[] {
    return this.edges().filter((edge) => edge.to === nodeId);
  }

  adjacent(nodeId: string): EdgeRecord[] {
    return this.edges().filter((edge) => edge.from === nodeId || edge.to === nodeId);
  }

  findNodesByPath(relativePath: string): NodeRecord[] {
    const normalized = toProjectPath(relativePath);
    return this.nodes().filter((node) => node.path === normalized);
  }

  async writeJsonl(outputDir: string): Promise<{ nodesPath: string; edgesPath: string }> {
    await mkdir(outputDir, { recursive: true });
    const nodesPath = path.join(outputDir, "nodes.jsonl");
    const edgesPath = path.join(outputDir, "edges.jsonl");
    await writeFile(nodesPath, this.nodes().map((node) => JSON.stringify(node)).join("\n") + "\n", "utf8");
    await writeFile(edgesPath, this.edges().map((edge) => JSON.stringify(edge)).join("\n") + "\n", "utf8");
    return { nodesPath, edgesPath };
  }

  static async loadJsonl(inputDir: string): Promise<GraphStore> {
    const store = new GraphStore();
    const nodesPath = path.join(inputDir, "nodes.jsonl");
    const edgesPath = path.join(inputDir, "edges.jsonl");

    const nodesText = await readFile(nodesPath, "utf8");
    for (const line of nodesText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const node = JSON.parse(line) as NodeRecord;
      store.addNode(node);
    }

    const edgesText = await readFile(edgesPath, "utf8");
    for (const line of edgesText.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const edge = JSON.parse(line) as EdgeRecord;
      store.addEdge(edge);
    }

    return store;
  }
}
