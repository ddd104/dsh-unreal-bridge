import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { signatureMap, signaturesEqual, type MemoryManifestSource } from "../memory/manifest.js";
import { csvSource } from "../sources/csvSource.js";
import { iniSource } from "../sources/iniSource.js";
import { jsonSource } from "../sources/jsonSource.js";
import { markdownSource } from "../sources/markdownSource.js";
import { createDefaultSourceRegistry, type SourceRegistry } from "../sources/sourceRegistry.js";
import { textSource } from "../sources/textSource.js";
import { yamlSource } from "../sources/yamlSource.js";
import type { DocumentRecord, LoadedProjectConfig, ProjectMemoryConfig } from "../types/memoryTypes.js";
import { FullTextIndex } from "./fullTextIndex.js";

export interface DocumentIndexResult {
  documentsIndexed: number;
  documentsPath: string;
  ftsPath: string;
  warnings: string[];
  sources: MemoryManifestSource[];
  changedSources: string[];
  unchangedSources: string[];
  removedSources: string[];
}

interface IndexOptions {
  writeCache?: boolean;
  incremental?: boolean;
  previousSources?: MemoryManifestSource[];
}

const BINARY_DENY_EXTENSIONS = new Set([".uasset", ".umap", ".dll", ".so", ".apk", ".aar", ".jar"]);

function toProjectPath(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath).replace(/\\/g, "/");
}

function normalizePattern(value: string): string {
  return value.replace(/\\/g, "/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizePattern(glob);
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegex(char);
    }
  }
  return new RegExp(`^${pattern}$`, "i");
}

function matchesAny(projectPath: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(projectPath));
}

function configuredIncludePatterns(config: ProjectMemoryConfig): string[] {
  const patterns = config.sourcePolicy?.includePatterns;
  return patterns && patterns.length > 0 ? patterns : ["**/*"];
}

function configuredExcludePatterns(config: ProjectMemoryConfig): string[] {
  return [
    ...(config.sourcePolicy?.excludePatterns ?? []),
    ...(config.sourcePolicy?.excludeGlobs ?? []),
    "**/*.uasset",
    "**/*.umap"
  ];
}

function configuredExtensions(config: ProjectMemoryConfig, registry: SourceRegistry): Set<string> {
  const requested = config.sourcePolicy?.includeExtensions?.map((extension) => extension.toLowerCase()) ?? [];
  const registered = new Set(registry.list().flatMap((provider) => provider.extensions));
  const defaults = [".md", ".txt", ".proto", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".ini", ".xlsx", ".docx"];
  return new Set((requested.length > 0 ? requested : defaults).filter((extension) => registered.has(extension)));
}

async function walkFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      // 避免遍历生成目录和插件自带环境，再执行配置中的精确过滤。
      if (["node_modules", "Binaries", "Intermediate", "Saved", "Cache", "Runtime", "dist", ".git", ".codex", ".agents"].includes(entry.name)) continue;
      found.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      found.push(fullPath);
    }
  }

  return found;
}

function createRegistry(): SourceRegistry {
  const registry = createDefaultSourceRegistry();
  registry.register(markdownSource);
  registry.register(textSource);
  registry.register(jsonSource);
  registry.register(csvSource);
  registry.register(yamlSource);
  registry.register(iniSource);
  return registry;
}

function fallbackTitle(filePath: string, text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.slice(0, 120) || path.basename(filePath);
}

export interface DocumentSourceEntry extends MemoryManifestSource {
  absolutePath: string;
  extension: string;
}

async function sourceEntry(projectRoot: string, filePath: string, registry: SourceRegistry): Promise<DocumentSourceEntry | undefined> {
  const extension = path.extname(filePath).toLowerCase();
  const provider = registry.findByExtension(extension);
  if (!provider) return undefined;

  const [content, stats] = await Promise.all([readFile(filePath), stat(filePath)]);
  const projectPath = toProjectPath(projectRoot, filePath);
  const hash = createHash("sha256").update(content).digest("hex");

  return {
    id: hash.slice(0, 16),
    path: projectPath,
    sourceType: provider.id,
    hash,
    modifiedAt: stats.mtime.toISOString(),
    size: stats.size,
    absolutePath: filePath,
    extension
  };
}

async function readDocument(projectRoot: string, source: DocumentSourceEntry, registry: SourceRegistry): Promise<DocumentRecord | undefined> {
  const provider = registry.findByExtension(source.extension);
  if (!provider) return undefined;

  const content = await readFile(source.absolutePath);
  const parsed = await provider.parse(source.absolutePath, content);
  const text = parsed.text.trim();

  return {
    id: source.id,
    path: source.path,
    sourceType: parsed.sourceType,
    title: parsed.title?.trim() || fallbackTitle(source.absolutePath, text),
    text,
    metadata: {
      ...parsed.metadata,
      extension: source.extension,
      sizeBytes: source.size
    },
    hash: source.hash,
    modifiedAt: source.modifiedAt
  };
}

export async function discoverDocumentSources(loaded: LoadedProjectConfig): Promise<{ sources: DocumentSourceEntry[]; warnings: string[] }> {
  const registry = createRegistry();
  const extensions = configuredExtensions(loaded.config, registry);
  const includePatterns = configuredIncludePatterns(loaded.config);
  const excludePatterns = configuredExcludePatterns(loaded.config);
  const warnings: string[] = [];
  const sources: DocumentSourceEntry[] = [];

  for (const root of loaded.resolvedKnowledgeRoots) {
    // 配置根目录也要验证真实路径，防止 junction 指向项目外部。
    let resolvedRoot: string;
    try { resolvedRoot = await realpath(root); } catch { continue; }
    const relativeRoot = path.relative(loaded.projectRoot, resolvedRoot);
    if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot) || resolvedRoot.toLowerCase() !== path.resolve(root).toLowerCase()) continue;
    const files = await walkFiles(root);
    for (const file of files) {
      const extension = path.extname(file).toLowerCase();
      const projectPath = toProjectPath(loaded.projectRoot, file);
      if (BINARY_DENY_EXTENSIONS.has(extension)) continue;
      if (!extensions.has(extension)) continue;
      if (!matchesAny(projectPath, includePatterns)) continue;
      if (matchesAny(projectPath, excludePatterns)) continue;

      try {
        const source = await sourceEntry(loaded.projectRoot, file, registry);
        if (source) sources.push(source);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(`Skipped ${projectPath}: ${reason}`);
      }
    }
  }

  sources.sort((a, b) => a.path.localeCompare(b.path));
  return { sources, warnings };
}

async function readDocumentsJsonl(documentsPath: string): Promise<Map<string, DocumentRecord>> {
  try {
    const text = await readFile(documentsPath, "utf8");
    const documents = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DocumentRecord);
    return new Map(documents.map((document) => [document.path, document]));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

export async function collectDocuments(loaded: LoadedProjectConfig): Promise<{ documents: DocumentRecord[]; sources: MemoryManifestSource[]; warnings: string[] }> {
  const registry = createRegistry();
  const discovered = await discoverDocumentSources(loaded);
  const documents: DocumentRecord[] = [];
  const warnings = [...discovered.warnings];

  for (const source of discovered.sources) {
    try {
      const document = await readDocument(loaded.projectRoot, source, registry);
      if (document) documents.push(document);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Skipped ${source.path}: ${reason}`);
    }
  }

  documents.sort((a, b) => a.path.localeCompare(b.path));
  return {
    documents,
    sources: discovered.sources.map(({ absolutePath: _absolutePath, extension: _extension, ...source }) => source),
    warnings
  };
}

export async function writeDocumentsJsonl(outputRoot: string, documents: DocumentRecord[]): Promise<string> {
  const indexDir = path.join(outputRoot, "index");
  await mkdir(indexDir, { recursive: true });
  const documentsPath = path.join(indexDir, "documents.jsonl");
  const lines = documents.map((document) => JSON.stringify(document));
  await writeFile(documentsPath, `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`, "utf8");
  return documentsPath;
}

export async function indexDocuments(loaded: LoadedProjectConfig, options: IndexOptions = {}): Promise<DocumentIndexResult> {
  const outputRoot = loaded.resolvedMemoryOutputRoot;
  const indexDir = path.join(outputRoot, "index");
  const documentsPath = path.join(indexDir, "documents.jsonl");
  const ftsPath = path.join(indexDir, "fts.sqlite");
  const registry = createRegistry();
  const discovered = await discoverDocumentSources(loaded);
  const previousSourceMap = signatureMap(options.previousSources ?? []);
  const existingDocuments = options.incremental ? await readDocumentsJsonl(documentsPath) : new Map<string, DocumentRecord>();
  const documents: DocumentRecord[] = [];
  const warnings = [...discovered.warnings];
  const changedSources: string[] = [];
  const unchangedSources: string[] = [];
  const currentSourcePaths = new Set(discovered.sources.map((source) => source.path));

  for (const source of discovered.sources) {
    const previous = previousSourceMap.get(source.path);
    const existingDocument = existingDocuments.get(source.path);
    if (options.incremental && previous && existingDocument && signaturesEqual(previous, source)) {
      documents.push(existingDocument);
      unchangedSources.push(source.path);
      continue;
    }

    try {
      const document = await readDocument(loaded.projectRoot, source, registry);
      if (document) documents.push(document);
      changedSources.push(source.path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Skipped ${source.path}: ${reason}`);
    }
  }

  const removedSources = [...previousSourceMap.keys()].filter((sourcePath) => !currentSourcePaths.has(sourcePath)).sort();
  documents.sort((a, b) => a.path.localeCompare(b.path));

  if (options.writeCache !== false) {
    await mkdir(indexDir, { recursive: true });
    await writeDocumentsJsonl(outputRoot, documents);
    await rm(ftsPath, { force: true });
    const fullTextIndex = FullTextIndex.create(ftsPath);
    fullTextIndex.replaceAll(documents);
    fullTextIndex.close();
  }

  return {
    documentsIndexed: documents.length,
    documentsPath,
    ftsPath,
    warnings,
    sources: discovered.sources.map(({ absolutePath: _absolutePath, extension: _extension, ...source }) => source),
    changedSources,
    unchangedSources,
    removedSources
  };
}
