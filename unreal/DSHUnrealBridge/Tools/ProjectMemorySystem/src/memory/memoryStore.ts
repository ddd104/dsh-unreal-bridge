import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { discoverDocumentSources } from "../index/documentIndexer.js";
import type { LoadedProjectConfig } from "../types/memoryTypes.js";
import {
  signatureSetsEqual,
  type FileSignature,
  type MemoryManifest,
  type MemoryManifestCacheFile,
  type MemoryManifestGraphFile,
  type MemoryManifestSource,
  type MemoryStatus
} from "./manifest.js";

export interface MemoryStatusResult {
  status: MemoryStatus;
  manifestPath: string;
  projectConfigHash?: string;
  manifestGeneratedAt?: string;
  sourceCount: number;
  cacheFiles: MemoryManifestCacheFile[];
  graphFiles: MemoryManifestGraphFile[];
  warnings: string[];
}

function toProjectPath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).replace(/\\/g, "/");
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function hashDirectory(filePath: string): Promise<string> {
  const hasher = createHash("sha256");
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      hasher.update(path.relative(filePath, absolutePath).replace(/\\/g, "/"));
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        hasher.update(await readFile(absolutePath));
      }
    }
  }
  await visit(filePath);
  return hasher.digest("hex");
}

async function directorySize(filePath: string): Promise<number> {
  let size = 0;
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        size += (await stat(absolutePath)).size;
      }
    }
  }
  await visit(filePath);
  return size;
}

async function fileSignature(projectRoot: string, filePath: string): Promise<FileSignature | undefined> {
  if (!existsSync(filePath)) return undefined;
  const stats = await stat(filePath);
  const [hash, size] = stats.isDirectory()
    ? await Promise.all([hashDirectory(filePath), directorySize(filePath)])
    : await Promise.all([hashFile(filePath), Promise.resolve(stats.size)]);
  return {
    path: toProjectPath(projectRoot, filePath),
    hash,
    modifiedAt: stats.mtime.toISOString(),
    size: stats.size
  };
}

async function existingCacheFiles(loaded: LoadedProjectConfig): Promise<MemoryManifestCacheFile[]> {
  const candidates: Array<{ kind: MemoryManifestCacheFile["kind"]; path: string }> = [
    {
      kind: "documents_jsonl",
      path: path.join(loaded.resolvedMemoryOutputRoot, "index", "documents.jsonl")
    },
    {
      kind: "fts_sqlite",
      path: path.join(loaded.resolvedMemoryOutputRoot, "index", "fts.sqlite")
    }
  ];
  const files: MemoryManifestCacheFile[] = [];
  for (const candidate of candidates) {
    const signature = await fileSignature(loaded.projectRoot, candidate.path);
    if (signature) files.push({ ...signature, kind: candidate.kind });
  }
  return files;
}

function graphCandidatePaths(loaded: LoadedProjectConfig): Array<{ kind: MemoryManifestGraphFile["kind"]; path: string }> {
  if (!loaded.config.graph.enabled) return [];
  const sqlite = loaded.config.graph.sqlite;
  const candidates = [
    sqlite?.databasePath,
    sqlite?.nodesPath,
    sqlite?.edgesPath
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const ueCacheRoots = (loaded.config.graph as unknown as { ueCacheRoots?: Record<string, string> }).ueCacheRoots;
  const cacheCandidates = Object.values(ueCacheRoots ?? {}).filter((value): value is string => typeof value === "string" && value.length > 0);

  return [
    ...candidates.map((candidate) => ({ kind: "project_graph" as const, path: path.resolve(loaded.projectRoot, candidate) })),
    ...cacheCandidates.map((candidate) => ({ kind: "ue_cache" as const, path: path.resolve(loaded.projectRoot, candidate) }))
  ];
}

async function graphFileSignatures(loaded: LoadedProjectConfig): Promise<MemoryManifestGraphFile[]> {
  const files: MemoryManifestGraphFile[] = [];
  for (const candidate of graphCandidatePaths(loaded)) {
    const signature = await fileSignature(loaded.projectRoot, candidate.path);
    if (signature) files.push({ ...signature, kind: candidate.kind });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export class MemoryStore {
  constructor(readonly rootDir: string) {}

  manifestPath(): string {
    return path.join(this.rootDir, "manifest.json");
  }

  async readManifest(): Promise<MemoryManifest | null> {
    try {
      return JSON.parse(await readFile(this.manifestPath(), "utf8")) as MemoryManifest;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeManifest(manifest: MemoryManifest): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  async createManifest(loaded: LoadedProjectConfig, sources: MemoryManifestSource[]): Promise<MemoryManifest> {
    return {
      schemaVersion: 1,
      projectId: loaded.config.projectId,
      generatedAt: new Date().toISOString(),
      projectConfigHash: await hashFile(loaded.configPath),
      phase: "docs-index",
      sources: [...sources].sort((a, b) => a.path.localeCompare(b.path)),
      graphFiles: await graphFileSignatures(loaded),
      cacheFiles: await existingCacheFiles(loaded)
    };
  }

  async status(loaded?: LoadedProjectConfig): Promise<{ rootDir: string; hasManifest: boolean } | MemoryStatusResult> {
    if (!loaded) {
      return {
        rootDir: this.rootDir,
        hasManifest: (await this.readManifest()) !== null
      };
    }

    const manifest = await this.readManifest();
    const manifestPath = this.manifestPath();
    if (!manifest) {
      return {
        status: "missing",
        manifestPath,
        sourceCount: 0,
        cacheFiles: [],
        graphFiles: [],
        warnings: ["manifest.json does not exist."]
      };
    }

    if (manifest.schemaVersion !== 1 || manifest.projectId !== loaded.config.projectId) {
      return {
        status: "needs_full_rebuild",
        manifestPath,
        manifestGeneratedAt: manifest.generatedAt,
        sourceCount: manifest.sources.length,
        cacheFiles: manifest.cacheFiles ?? [],
        graphFiles: manifest.graphFiles ?? [],
        warnings: ["Manifest schema version or projectId does not match the current project."]
      };
    }

    const projectConfigHash = await hashFile(loaded.configPath);
    if (manifest.projectConfigHash !== projectConfigHash) {
      return {
        status: "stale_config",
        manifestPath,
        projectConfigHash,
        manifestGeneratedAt: manifest.generatedAt,
        sourceCount: manifest.sources.length,
        cacheFiles: manifest.cacheFiles ?? [],
        graphFiles: manifest.graphFiles ?? [],
        warnings: ["ProjectMemory.project.json changed since the last build."]
      };
    }

    const cacheFiles = await existingCacheFiles(loaded);
    if (!signatureSetsEqual(manifest.cacheFiles ?? [], cacheFiles) || cacheFiles.length < 2) {
      return {
        status: "needs_full_rebuild",
        manifestPath,
        projectConfigHash,
        manifestGeneratedAt: manifest.generatedAt,
        sourceCount: manifest.sources.length,
        cacheFiles,
        graphFiles: manifest.graphFiles ?? [],
        warnings: ["One or more cache files are missing or changed outside the manifest."]
      };
    }

    const currentGraphFiles = await graphFileSignatures(loaded);
    if (loaded.config.graph.enabled && !signatureSetsEqual(manifest.graphFiles ?? [], currentGraphFiles)) {
      return {
        status: "stale_graph",
        manifestPath,
        projectConfigHash,
        manifestGeneratedAt: manifest.generatedAt,
        sourceCount: manifest.sources.length,
        cacheFiles,
        graphFiles: currentGraphFiles,
        warnings: ["Project graph cache files changed since the last build."]
      };
    }

    const discovered = await discoverDocumentSources(loaded);
    if (!signatureSetsEqual(manifest.sources ?? [], discovered.sources)) {
      return {
        status: "stale_sources",
        manifestPath,
        projectConfigHash,
        manifestGeneratedAt: manifest.generatedAt,
        sourceCount: discovered.sources.length,
        cacheFiles,
        graphFiles: currentGraphFiles,
        warnings: discovered.warnings
      };
    }

    return {
      status: "fresh",
      manifestPath,
      projectConfigHash,
      manifestGeneratedAt: manifest.generatedAt,
      sourceCount: discovered.sources.length,
      cacheFiles,
      graphFiles: currentGraphFiles,
      warnings: discovered.warnings
    };
  }
}
