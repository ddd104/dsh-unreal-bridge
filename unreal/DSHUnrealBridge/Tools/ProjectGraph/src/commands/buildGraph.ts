import { indexAngelScriptFile } from "../indexers/angelScriptIndexer.js";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { GraphStore, createFileNode } from "../graph/graphStore.js";
import { writeSqliteDatabase } from "../graph/sqliteStore.js";
import { indexBuildCsFile } from "../indexers/buildCsIndexer.js";
import { indexConfigFile } from "../indexers/configIndexer.js";
import { indexCppFile } from "../indexers/cppIndexer.js";
import { readScannedFile, scanProjectFiles } from "../indexers/fileScanner.js";
import { indexUeEditorCache, type UeEditorIndexerResult } from "../indexers/ueEditorIndexer.js";

export interface BuildGraphOptions {
  projectRoot: string;
  outputDir?: string;
  includeUeCache?: boolean;
  ueCacheRoot?: string;
}

export interface BuildGraphResult {
  projectRoot: string;
  outputDir: string;
  nodesPath: string;
  edgesPath: string;
  sqlitePath: string;
  nodeCount: number;
  edgeCount: number;
  indexedFiles: number;
  ueCache?: UeEditorIndexerResult;
}

export async function buildGraph(options: BuildGraphOptions): Promise<BuildGraphResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const outputDir = path.resolve(projectRoot, options.outputDir ?? "Plugins/DSHUnrealBridge/Cache/Graph");
  const store = new GraphStore();
  const files = await scanProjectFiles(projectRoot);

  for (const file of files) {
    const content = await readScannedFile(file);
    if (file.kind === "cpp") {
      indexCppFile({ relativePath: file.relativePath, content, system: file.system, language: file.language }, store);
    } else if (file.kind === "build") {
      indexBuildCsFile({ relativePath: file.relativePath, content, system: file.system }, store);
    } else if (file.kind === "config") {
      indexConfigFile({ relativePath: file.relativePath, content, system: file.system }, store);
    } else if (file.language === "AngelScript") {
      indexAngelScriptFile({relativePath:file.relativePath, content, system:file.system},store);
    } else {
      store.addNode(createFileNode(file.relativePath, file.system, file.language));
    }
  }

  const ueCache = options.includeUeCache ? await indexUeEditorCache({ projectRoot, cacheRoot: options.ueCacheRoot }, store) : undefined;

  await mkdir(outputDir, { recursive: true });
  const { nodesPath, edgesPath } = await store.writeJsonl(outputDir);
  const sqlitePath = path.join(outputDir, "project_graph.sqlite");
  writeSqliteDatabase(nodesPath, edgesPath, sqlitePath);

  return {
    projectRoot,
    outputDir,
    nodesPath,
    edgesPath,
    sqlitePath,
    nodeCount: store.nodes().length,
    edgeCount: store.edges().length,
    indexedFiles: files.length,
    ueCache
  };
}
