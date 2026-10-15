export type MemoryStatus =
  | "missing"
  | "fresh"
  | "stale_config"
  | "stale_sources"
  | "stale_graph"
  | "needs_full_rebuild";

export interface FileSignature {
  path: string;
  hash: string;
  modifiedAt: string;
  size: number;
}

export interface MemoryManifestSource extends FileSignature {
  id: string;
  sourceType: string;
}

export interface MemoryManifestCacheFile extends FileSignature {
  kind: "documents_jsonl" | "fts_sqlite";
}

export interface MemoryManifestGraphFile extends FileSignature {
  kind: "project_graph" | "ue_cache";
}

export interface MemoryManifest {
  schemaVersion: 1;
  projectId: string;
  generatedAt: string;
  projectConfigHash: string;
  phase: "docs-index";
  sources: MemoryManifestSource[];
  graphFiles: MemoryManifestGraphFile[];
  cacheFiles: MemoryManifestCacheFile[];
}

export function createEmptyManifest(projectId: string): MemoryManifest {
  return {
    schemaVersion: 1,
    projectId,
    generatedAt: new Date(0).toISOString(),
    projectConfigHash: "",
    phase: "docs-index",
    sources: [],
    graphFiles: [],
    cacheFiles: []
  };
}

export function signaturesEqual(left: FileSignature, right: FileSignature): boolean {
  return left.path === right.path && left.hash === right.hash && left.modifiedAt === right.modifiedAt && left.size === right.size;
}

export function signatureMap<T extends FileSignature>(signatures: T[]): Map<string, T> {
  return new Map(signatures.map((signature) => [signature.path, signature]));
}

export function signatureSetsEqual<T extends FileSignature>(left: T[], right: T[]): boolean {
  const leftMap = signatureMap(left);
  const rightMap = signatureMap(right);
  if (leftMap.size !== rightMap.size) return false;
  for (const [key, leftSignature] of leftMap) {
    const rightSignature = rightMap.get(key);
    if (!rightSignature || !signaturesEqual(leftSignature, rightSignature)) return false;
  }
  return true;
}
