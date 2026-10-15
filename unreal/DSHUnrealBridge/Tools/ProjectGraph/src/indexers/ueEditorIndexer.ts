import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { symbolNodeId, toProjectPath, type GraphStore } from "../graph/graphStore.js";
import type { EdgeType, NodeRecord, NodeType } from "../graph/schema.js";

type JsonObject = Record<string, unknown>;

export interface UeEditorIndexerOptions {
  projectRoot: string;
  cacheRoot?: string;
}

export interface UeEditorIndexerResult {
  cacheRoot: string;
  ensuredDirectories: string[];
  blueprintFiles: number;
  assetRegistryFiles: number;
  materialFiles: number;
  snapshotFiles: number;
  warnings: string[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function assetLeaf(assetPath: string): string {
  const last = assetPath.split(/[/.]/).filter(Boolean).at(-1);
  return last || assetPath || "asset";
}

function normalizeAssetPath(assetPath: string): string {
  if (!assetPath) return "";
  const slash = assetPath.lastIndexOf("/");
  const dot = assetPath.lastIndexOf(".");
  if (dot > slash) {
    return assetPath.slice(0, dot);
  }
  return assetPath;
}

function safeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function addNode(
  store: GraphStore,
  type: NodeType,
  name: string,
  nodePath: string,
  summary: string,
  metadata: Record<string, unknown> = {}
): NodeRecord {
  const system = nodePath.startsWith("/Game") ? "Content" : "UE";
  return store.addNode({
    id: symbolNodeId(type, name || nodePath || type, nodePath || "ue-cache"),
    type,
    name: name || assetLeaf(nodePath),
    path: nodePath,
    system,
    language: "UnrealAsset",
    summary,
    metadata: safeMetadata({
      source: "ue-cache",
      ...metadata
    })
  });
}

function classifyAsset(assetPath: string, assetClass: string): NodeType {
  const loweredClass = assetClass.toLowerCase();
  const loweredPath = assetPath.toLowerCase();
  if (loweredClass.includes("materialinstance")) return "Asset";
  if (loweredClass.includes("material")) return "Material";
  if (loweredClass.includes("widgetblueprint") || loweredPath.includes("/ui/") || loweredPath.includes("/widget")) return "Widget";
  if (loweredClass.includes("world") || loweredClass.includes("level") || loweredPath.endsWith("_map")) return "Level";
  if (loweredClass.includes("dataasset") || loweredPath.includes("dataasset")) return "DataAsset";
  if (loweredClass.includes("blueprint")) return "Blueprint";
  return "Asset";
}

async function readJsonFiles(directory: string): Promise<Array<{ filePath: string; json: unknown }>> {
  try {
    await stat(directory);
  } catch {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ filePath: string; json: unknown }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(directory, entry.name);
    const text = decodeJsonText(await readFile(filePath));
    files.push({ filePath, json: JSON.parse(text) as unknown });
  }
  return files;
}

function decodeJsonText(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }

  if (buffer.length >= 4 && buffer[1] === 0x00 && buffer[3] === 0x00) {
    return buffer.toString("utf16le");
  }

  return buffer.toString("utf8");
}

function unwrapBlueprintJson(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  const nested = value.blueprint;
  if (isObject(nested)) return nested;
  if (typeof value.assetPath === "string" && typeof value.blueprintName === "string") return value;
  return undefined;
}

function unwrapMaterialJson(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  const nested = value.material;
  if (isObject(nested)) return nested;
  if (typeof value.assetPath === "string" && (typeof value.materialDomain === "string" || Array.isArray(value.expressions))) return value;
  return undefined;
}

function assetObjectsFromJson(value: unknown): JsonObject[] {
  if (!isObject(value)) return [];
  if (Array.isArray(value.assets)) return value.assets.filter(isObject);
  if (typeof value.assetPath === "string" && typeof value.assetClass === "string") return [value];
  return [];
}

function indexFunctionLike(
  store: GraphStore,
  blueprintNode: NodeRecord,
  functionLike: unknown,
  nodeType: Extract<NodeType, "Function" | "Macro"> = "Function",
  edgeType: Extract<EdgeType, "HAS_FUNCTION" | "HAS_MACRO"> = "HAS_FUNCTION"
): void {
  if (!isObject(functionLike)) return;
  const name = asString(functionLike.name) || asString(functionLike.function) || asString(functionLike.nodeTitle);
  if (!name) return;
  const functionNode = addNode(
    store,
    nodeType,
    name,
    blueprintNode.path,
    `Blueprint ${nodeType === "Macro" ? "macro" : "function"} ${name} on ${blueprintNode.name}`,
    { blueprint: blueprintNode.path, raw: functionLike }
  );
  store.addEdge({ from: blueprintNode.id, to: functionNode.id, type: edgeType, metadata: { source: "ue-cache" } });
}

function indexVariable(store: GraphStore, blueprintNode: NodeRecord, variable: unknown): void {
  if (!isObject(variable)) return;
  const name = asString(variable.name);
  if (!name) return;
  const variableNode = addNode(
    store,
    "Variable",
    name,
    blueprintNode.path,
    `Blueprint variable ${name} on ${blueprintNode.name}`,
    { blueprint: blueprintNode.path, raw: variable }
  );
  store.addEdge({ from: blueprintNode.id, to: variableNode.id, type: "HAS_VARIABLE", metadata: { source: "ue-cache" } });
}

function indexComponent(store: GraphStore, blueprintNode: NodeRecord, component: unknown): void {
  if (!isObject(component)) return;
  const name = asString(component.name) || asString(component.componentClass);
  if (!name) return;
  const componentNode = addNode(
    store,
    "Component",
    name,
    blueprintNode.path,
    `Blueprint component ${name} on ${blueprintNode.name}`,
    { blueprint: blueprintNode.path, componentClass: component.componentClass, raw: component }
  );
  store.addEdge({ from: blueprintNode.id, to: componentNode.id, type: "HAS_COMPONENT", metadata: { source: "ue-cache" } });
}

function indexBlueprint(store: GraphStore, blueprint: JsonObject): void {
  const assetPath = normalizeAssetPath(asString(blueprint.assetPath));
  const blueprintName = asString(blueprint.blueprintName) || assetLeaf(assetPath);
  if (!assetPath) return;

  const blueprintNode = addNode(store, "Blueprint", blueprintName, assetPath, `Blueprint ${blueprintName}`, {
    parentClass: blueprint.parentClass,
    generatedClass: blueprint.generatedClass,
    implementedInterfaces: blueprint.implementedInterfaces,
    variableCount: asArray(blueprint.variables).length,
    functionCount: asArray(blueprint.functions).length,
    macroCount: asArray(blueprint.macros).length,
    eventGraphCount: asArray(blueprint.eventGraphs).length,
    componentCount: asArray(blueprint.components).length,
    referencedAssetCount: asArray(blueprint.referencedAssets).length,
    hasDetailedGraphIr: asArray(blueprint.functions).concat(asArray(blueprint.macros), asArray(blueprint.eventGraphs)).some((graph) => {
      return isObject(graph) && asArray(graph.nodes).some((node) => isObject(node) && asArray(node.pins).length > 0);
    })
  });

  const parentClass = asString(blueprint.parentClass);
  if (parentClass) {
    const parentNode = addNode(store, "Class", assetLeaf(parentClass), parentClass, `Blueprint parent class ${parentClass}`, { source: "ue-cache" });
    store.addEdge({ from: blueprintNode.id, to: parentNode.id, type: "PARENT_CLASS", metadata: { source: "ue-cache" } });
  }

  for (const variable of asArray(blueprint.variables)) indexVariable(store, blueprintNode, variable);
  for (const component of asArray(blueprint.components)) indexComponent(store, blueprintNode, component);
  for (const graph of asArray(blueprint.functions)) indexFunctionLike(store, blueprintNode, graph);
  for (const graph of asArray(blueprint.macros)) indexFunctionLike(store, blueprintNode, graph, "Macro", "HAS_MACRO");
  for (const graph of asArray(blueprint.eventGraphs)) indexFunctionLike(store, blueprintNode, graph);
  // 折叠图与委托签名保留原生图表身份，也参与函数上下文索引。
  for (const graph of asArray(blueprint.otherGraphs)) indexFunctionLike(store, blueprintNode, graph);
  for (const call of asArray(blueprint.calledFunctions)) indexFunctionLike(store, blueprintNode, call);

  for (const referenced of asArray(blueprint.referencedAssets)) {
    const refPath = normalizeAssetPath(asString(referenced));
    if (!refPath) continue;
    const refNode = addNode(store, "Asset", assetLeaf(refPath), refPath, `Referenced asset ${refPath}`, { source: "ue-cache" });
    store.addEdge({ from: blueprintNode.id, to: refNode.id, type: "REFERENCES_ASSET", metadata: { source: "ue-cache" } });
  }
}

function indexAsset(store: GraphStore, asset: JsonObject): void {
  const assetPath = normalizeAssetPath(asString(asset.assetPath));
  if (!assetPath) return;
  const assetClass = asString(asset.assetClass);
  const nodeType = classifyAsset(assetPath, assetClass);
  const assetNode = addNode(store, nodeType, assetLeaf(assetPath), assetPath, `${nodeType} asset ${assetPath}`, {
    assetClass,
    packageName: asset.packageName,
    snapshotFile: asset.snapshotFile,
    fingerprint: asset.fingerprint,
    coverage: asset.coverage
  });

  for (const dependency of asArray(asset.dependencies)) {
    const dependencyPath = normalizeAssetPath(asString(dependency));
    if (!dependencyPath) continue;
    const dependencyNode = addNode(store, "Asset", assetLeaf(dependencyPath), dependencyPath, `Asset dependency ${dependencyPath}`, {
      source: "ue-cache"
    });
    store.addEdge({ from: assetNode.id, to: dependencyNode.id, type: "DEPENDS_ON", metadata: { source: "ue-cache" } });
  }

  const parentMaterial =
    asString(asset.parentMaterial) ||
    asString(asset.parent) ||
    asString(asset.metadata && isObject(asset.metadata) ? asset.metadata.parentMaterial : undefined);
  if (parentMaterial && assetClass.toLowerCase().includes("materialinstance")) {
    const materialNode = addNode(store, "Material", assetLeaf(parentMaterial), normalizeAssetPath(parentMaterial), `Parent material ${parentMaterial}`);
    store.addEdge({ from: assetNode.id, to: materialNode.id, type: "INSTANCE_OF_MATERIAL", metadata: { source: "ue-cache" } });
  }
}

function indexMaterial(store: GraphStore, material: JsonObject): void {
  const assetPath = normalizeAssetPath(asString(material.assetPath));
  if (!assetPath) return;
  const materialNode = addNode(store, "Material", assetLeaf(assetPath), assetPath, `Material ${assetPath}`, {
    materialDomain: material.materialDomain,
    blendMode: material.blendMode,
    shadingModel: material.shadingModel,
    expressionCount: asArray(material.expressions).length
  });

  for (const expression of asArray(material.expressions)) {
    if (!isObject(expression)) continue;
    const caption = Array.isArray(expression.caption) ? expression.caption.map(String).join(" ") : "";
    const referencedAsset = asString(expression.texture) || asString(expression.assetPath) || asString(expression.referencedAsset);
    if (!referencedAsset) continue;
    const assetNode = addNode(store, "Asset", assetLeaf(referencedAsset), normalizeAssetPath(referencedAsset), `Material referenced asset ${referencedAsset}`, {
      expression: expression.name,
      caption
    });
    store.addEdge({ from: materialNode.id, to: assetNode.id, type: "REFERENCES_ASSET", metadata: { source: "ue-cache" } });
  }
}

export async function indexUeEditorCache(options: UeEditorIndexerOptions, store: GraphStore): Promise<UeEditorIndexerResult> {
  const cacheRoot = path.resolve(options.projectRoot, options.cacheRoot ?? "Plugins/DSHUnrealBridge/Cache/UE");
  const cacheDirectories = ["blueprint_ir", "asset_registry", "material_ir", "asset_snapshots"];
  const ensuredDirectories: string[] = [];
  const warnings: string[] = [];
  let blueprintFiles = 0;
  let assetRegistryFiles = 0;
  let materialFiles = 0;
  let snapshotFiles = 0;

  for (const directoryName of cacheDirectories) {
    const directory = path.join(cacheRoot, directoryName);
    await mkdir(directory, { recursive: true });
    ensuredDirectories.push(toProjectPath(directory));
  }

  for (const file of await readJsonFiles(path.join(cacheRoot, "blueprint_ir"))) {
    try {
      const blueprint = unwrapBlueprintJson(file.json);
      if (blueprint) {
        indexBlueprint(store, blueprint);
        blueprintFiles += 1;
      }
    } catch (error) {
      warnings.push(`Failed to index blueprint cache ${toProjectPath(file.filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const file of await readJsonFiles(path.join(cacheRoot, "asset_registry"))) {
    try {
      for (const asset of assetObjectsFromJson(file.json)) {
        indexAsset(store, asset);
      }
      assetRegistryFiles += 1;
    } catch (error) {
      warnings.push(`Failed to index asset registry cache ${toProjectPath(file.filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const file of await readJsonFiles(path.join(cacheRoot, "material_ir"))) {
    try {
      const material = unwrapMaterialJson(file.json);
      if (material) {
        indexMaterial(store, material);
        materialFiles += 1;
      }
    } catch (error) {
      warnings.push(`Failed to index material cache ${toProjectPath(file.filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 逐文件消费轻索引，只读取有效快照；全扫描取消/失败留下的旧快照不得伪装为当前证据。
  const snapshotRoot = path.join(cacheRoot, "asset_snapshots");
  let snapshotIndex: JsonObject | undefined;
  try {
    const value: unknown = JSON.parse(decodeJsonText(await readFile(path.join(snapshotRoot, "index.json"))));
    if (isObject(value)) snapshotIndex = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Cannot read asset snapshot index: ${String(error)}`);
  }
  if (snapshotIndex) {
    const projectId = asString(snapshotIndex.projectId);
    const normalizeRoot = (value: string): string => path.resolve(value).replaceAll("\\", "/").toLowerCase();
    if (!projectId || normalizeRoot(path.dirname(projectId)) !== normalizeRoot(options.projectRoot)) {
      warnings.push("Asset snapshots belong to a different project; skipped snapshot details.");
    } else {
      if (snapshotIndex.complete !== true) warnings.push("Asset snapshot scan is incomplete; only individually valid snapshots are indexed.");
      const entries = isObject(snapshotIndex.assets) ? Object.entries(snapshotIndex.assets) : [];
      for (const [assetPath, entry] of entries) {
        if (!isObject(entry) || entry.stale === true) continue;
        const file = asString(entry.file);
        if (!/^[a-f0-9]{32}\.json$/i.test(file)) { warnings.push(`Invalid asset snapshot filename for ${assetPath}`); continue; }
        try {
          const snapshot: unknown = JSON.parse(decodeJsonText(await readFile(path.join(snapshotRoot, file))));
          if (!isObject(snapshot) || snapshot.assetPath !== assetPath || snapshot.projectId !== projectId || snapshot.stale === true || snapshot.fingerprint !== entry.fingerprint) {
            warnings.push(`Stale or mismatched asset snapshot: ${assetPath}`); continue;
          }
          const materialInstance = isObject(snapshot.materialInstance) ? snapshot.materialInstance : undefined;
          indexAsset(store, { ...snapshot, snapshotFile: toProjectPath(path.join(snapshotRoot, file)), parentMaterial: materialInstance?.parent });
          const blueprint = unwrapBlueprintJson(snapshot); if (blueprint) indexBlueprint(store, blueprint);
          const material = unwrapMaterialJson(snapshot); if (material) indexMaterial(store, material);
          snapshotFiles += 1;
        } catch (error) { warnings.push(`Cannot index snapshot ${assetPath}: ${String(error)}`); }
      }
    }
  }

  return { cacheRoot: toProjectPath(cacheRoot), ensuredDirectories, blueprintFiles, assetRegistryFiles, materialFiles, snapshotFiles, warnings };
}
