import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type UeCacheKind = "blueprint" | "material" | "asset-registry" | "asset" | "unknown";

export interface UeCacheSummary {
  kind: UeCacheKind;
  title: string;
  assetPath?: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface UeAssetSummarizeOptions {
  cacheRoots?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return asArray(value).map((item) => asString(item)).filter((item): item is string => Boolean(item));
}

function firstStrings(values: string[], limit: number): string[] {
  return values.slice(0, limit);
}

function valueCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function basenameFromAssetPath(assetPath: string | undefined, filePath: string): string {
  if (!assetPath) return path.basename(filePath, path.extname(filePath));
  const objectName = assetPath.split(".").pop();
  const packageName = assetPath.split("/").pop();
  return objectName || packageName || path.basename(filePath, path.extname(filePath));
}

function decodeContent(content: Buffer | string): string {
  if (typeof content === "string") {
    return content.replace(/^\uFEFF/, "");
  }

  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return content.subarray(2).toString("utf16le").replace(/^\uFEFF/, "");
  }

  if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    const swapped = Buffer.alloc(content.length - 2);
    for (let index = 2; index + 1 < content.length; index += 2) {
      swapped[index - 2] = content[index + 1];
      swapped[index - 1] = content[index];
    }
    return swapped.toString("utf16le").replace(/^\uFEFF/, "");
  }

  const sample = content.subarray(0, Math.min(content.length, 80));
  const nullBytes = sample.filter((byte) => byte === 0).length;
  if (nullBytes > sample.length / 4) {
    return content.toString("utf16le").replace(/^\uFEFF/, "");
  }

  return content.toString("utf8").replace(/^\uFEFF/, "");
}

function parseJsonContent(filePath: string, content: Buffer | string): unknown {
  const text = decodeContent(content);
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

function detectKind(filePath: string, value: unknown): UeCacheKind {
  const lowerPath = filePath.replace(/\\/g, "/").toLowerCase();
  if (lowerPath.includes("/blueprint_ir/")) return "blueprint";
  if (lowerPath.includes("/material_ir/")) return "material";
  if (lowerPath.includes("/asset_registry/")) return "asset-registry";
  if (!isRecord(value)) return "unknown";
  if (Array.isArray(value.assets)) return "asset-registry";
  if (value.blueprintName || value.parentClass || value.eventGraphs) return "blueprint";
  if (value.materialDomain || value.blendMode || value.shadingModel || value.expressions) return "material";
  if (value.assetPath || value.assetClass || value.dependencies || value.referencers) return "asset";
  return "unknown";
}

function nodeTitles(nodes: unknown, limit = 12): string[] {
  return asArray(nodes)
    .map((node) => isRecord(node) ? asString(node.title) ?? asString(node.name) ?? asString(node.class) : undefined)
    .filter((item): item is string => Boolean(item))
    .slice(0, limit);
}

function summarizeBlueprint(filePath: string, value: Record<string, unknown>): UeCacheSummary {
  const assetPath = asString(value.assetPath);
  const title = `UE Blueprint Cache: ${asString(value.blueprintName) ?? basenameFromAssetPath(assetPath, filePath)}`;
  const variables = asArray(value.variables).filter(isRecord);
  const functions = asArray(value.functions).filter(isRecord);
  const eventGraphs = asArray(value.eventGraphs).filter(isRecord);
  const components = asArray(value.components).filter(isRecord);
  const calledFunctions = asArray(value.calledFunctions).filter(isRecord);
  const referencedAssets = stringArray(value.referencedAssets);

  const lines = [
    `# ${title}`,
    "",
    `Kind: blueprint`,
    assetPath ? `Asset Path: ${assetPath}` : "Asset Path: missing evidence",
    `Parent Class: ${asString(value.parentClass) ?? "missing evidence"}`,
    `Generated Class: ${asString(value.generatedClass) ?? "missing evidence"}`,
    `Implemented Interfaces: ${stringArray(value.implementedInterfaces).join(", ") || "none"}`,
    "",
    `Variables (${variables.length})`,
    ...variables.slice(0, 20).map((item) => `- ${asString(item.name) ?? "Unnamed"}: ${asString(item.pinCategory) ?? "unknown"} ${asString(item.pinSubCategoryObject) ?? ""}`.trim()),
    "",
    `Components (${components.length})`,
    ...components.slice(0, 20).map((item) => `- ${asString(item.name) ?? "Unnamed"}: ${asString(item.componentClass) ?? "unknown"}`),
    "",
    `Functions (${functions.length})`,
    ...functions.slice(0, 20).map((item) => {
      const titles = nodeTitles(item.nodes, 8);
      return `- ${asString(item.name) ?? "Unnamed"}: ${typeof item.nodeCount === "number" ? item.nodeCount : valueCount(item.nodes)} nodes${titles.length ? `; nodes: ${titles.join(", ")}` : ""}`;
    }),
    "",
    `Event Graphs (${eventGraphs.length})`,
    ...eventGraphs.slice(0, 20).map((item) => {
      const titles = nodeTitles(item.nodes, 12);
      return `- ${asString(item.name) ?? "Unnamed"}: ${typeof item.nodeCount === "number" ? item.nodeCount : valueCount(item.nodes)} nodes${titles.length ? `; nodes: ${titles.join(", ")}` : ""}`;
    }),
    "",
    `Called Functions (${calledFunctions.length})`,
    ...calledFunctions.slice(0, 30).map((item) => `- ${asString(item.function) ?? asString(item.nodeTitle) ?? "missing evidence"}${asString(item.graph) ? ` (${asString(item.graph)})` : ""}`),
    "",
    `Referenced Assets (${referencedAssets.length})`,
    ...firstStrings(referencedAssets, 40).map((item) => `- ${item}`),
    "",
    "Safety: read-only UE cache summary; do not edit .uasset directly."
  ];

  return {
    kind: "blueprint",
    title,
    assetPath,
    text: lines.join("\n"),
    metadata: {
      assetPath,
      blueprintName: asString(value.blueprintName),
      parentClass: asString(value.parentClass),
      generatedClass: asString(value.generatedClass),
      variableCount: variables.length,
      functionCount: functions.length,
      eventGraphCount: eventGraphs.length,
      componentCount: components.length,
      calledFunctionCount: calledFunctions.length,
      referencedAssetCount: referencedAssets.length
    }
  };
}

function expressionLabel(expression: Record<string, unknown>): string {
  const caption = stringArray(expression.caption).join(" / ");
  return caption || asString(expression.name) || asString(expression.class) || "Unnamed";
}

function summarizeMaterial(filePath: string, value: Record<string, unknown>): UeCacheSummary {
  const assetPath = asString(value.assetPath);
  const expressions = asArray(value.expressions).filter(isRecord);
  const expressionClasses = new Map<string, number>();
  for (const expression of expressions) {
    const className = asString(expression.class) ?? "unknown";
    expressionClasses.set(className, (expressionClasses.get(className) ?? 0) + 1);
  }
  const parameterExpressions = expressions.filter((expression) => /Parameter/i.test(asString(expression.class) ?? "") || /'[^']+'/.test(stringArray(expression.caption).join(" ")));
  const materialFunctions = expressions.filter((expression) => /MaterialFunctionCall/i.test(asString(expression.class) ?? "") || /MF_/i.test(stringArray(expression.caption).join(" ")));

  const lines = [
    `# UE Material Cache: ${basenameFromAssetPath(assetPath, filePath)}`,
    "",
    `Kind: material`,
    assetPath ? `Asset Path: ${assetPath}` : "Asset Path: missing evidence",
    `Material Domain: ${asString(value.materialDomain) ?? "missing evidence"}`,
    `Blend Mode: ${asString(value.blendMode) ?? "missing evidence"}`,
    `Shading Model: ${asString(value.shadingModel) ?? "missing evidence"}`,
    "",
    `Expressions (${expressions.length})`,
    ...[...expressionClasses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([className, count]) => `- ${className}: ${count}`),
    "",
    `Parameters (${parameterExpressions.length})`,
    ...parameterExpressions.slice(0, 30).map((item) => `- ${expressionLabel(item)} (${asString(item.class) ?? "unknown"})`),
    "",
    `Material Functions (${materialFunctions.length})`,
    ...materialFunctions.slice(0, 30).map((item) => `- ${expressionLabel(item)}`),
    "",
    "Safety: read-only UE cache summary; do not edit .uasset directly."
  ];

  return {
    kind: "material",
    title: `UE Material Cache: ${basenameFromAssetPath(assetPath, filePath)}`,
    assetPath,
    text: lines.join("\n"),
    metadata: {
      assetPath,
      materialDomain: asString(value.materialDomain),
      blendMode: asString(value.blendMode),
      shadingModel: asString(value.shadingModel),
      expressionCount: expressions.length,
      parameterCount: parameterExpressions.length,
      materialFunctionCount: materialFunctions.length
    }
  };
}

function summarizeAssetRegistry(filePath: string, value: Record<string, unknown>): UeCacheSummary {
  const assets = asArray(value.assets).filter(isRecord);
  const classes = new Map<string, number>();
  for (const asset of assets) {
    const className = asString(asset.assetClass) ?? "unknown";
    classes.set(className, (classes.get(className) ?? 0) + 1);
  }
  const lines = [
    "# UE Asset Registry Cache",
    "",
    "Kind: asset-registry",
    `Assets: ${assets.length}`,
    `Status: ${value.ok === true ? "ok" : "missing evidence"}`,
    "",
    "Asset Classes",
    ...[...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([className, count]) => `- ${className}: ${count}`),
    "",
    "Sample Assets",
    ...assets.slice(0, 80).map((asset) => {
      const assetPath = asString(asset.assetPath) ?? asString(asset.packageName) ?? "missing evidence";
      const assetClass = asString(asset.assetClass) ?? "unknown";
      return `- ${assetPath} [${assetClass}], dependencies=${valueCount(asset.dependencies)}, referencers=${valueCount(asset.referencers)}`;
    }),
    "",
    "Safety: read-only UE cache summary; do not edit .uasset directly."
  ];

  return {
    kind: "asset-registry",
    title: "UE Asset Registry Cache",
    text: lines.join("\n"),
    metadata: {
      assetCount: assets.length,
      classCount: classes.size,
      ok: value.ok === true,
      sourceFile: path.basename(filePath)
    }
  };
}

function summarizeAsset(filePath: string, value: Record<string, unknown>): UeCacheSummary {
  const assetPath = asString(value.assetPath) ?? asString(value.packageName);
  const dependencies = stringArray(value.dependencies);
  const referencers = stringArray(value.referencers);
  const lines = [
    `# UE Asset Cache: ${basenameFromAssetPath(assetPath, filePath)}`,
    "",
    "Kind: asset",
    assetPath ? `Asset Path: ${assetPath}` : "Asset Path: missing evidence",
    `Asset Class: ${asString(value.assetClass) ?? "missing evidence"}`,
    `Package Name: ${asString(value.packageName) ?? "missing evidence"}`,
    "",
    `Dependencies (${dependencies.length})`,
    ...firstStrings(dependencies, 40).map((item) => `- ${item}`),
    "",
    `Referencers (${referencers.length})`,
    ...firstStrings(referencers, 40).map((item) => `- ${item}`),
    "",
    "Safety: read-only UE cache summary; do not edit .uasset directly."
  ];

  return {
    kind: "asset",
    title: `UE Asset Cache: ${basenameFromAssetPath(assetPath, filePath)}`,
    assetPath,
    text: lines.join("\n"),
    metadata: {
      assetPath,
      assetClass: asString(value.assetClass),
      packageName: asString(value.packageName),
      dependencyCount: dependencies.length,
      referencerCount: referencers.length
    }
  };
}

function summarizeUnknown(filePath: string, value: unknown): UeCacheSummary {
  const preview = JSON.stringify(value, null, 2)?.slice(0, 4000) ?? "";
  return {
    kind: "unknown",
    title: `UE Cache: ${path.basename(filePath)}`,
    text: [
      `# UE Cache: ${path.basename(filePath)}`,
      "",
      "Kind: unknown",
      "Status: missing evidence",
      "",
      preview,
      "",
      "Safety: read-only UE cache summary; do not edit .uasset directly."
    ].join("\n"),
    metadata: {
      sourceFile: path.basename(filePath)
    }
  };
}

export function summarizeUeCacheJson(filePath: string, value: unknown): UeCacheSummary {
  const kind = detectKind(filePath, value);
  if (!isRecord(value)) return summarizeUnknown(filePath, value);
  if (kind === "blueprint") return summarizeBlueprint(filePath, value);
  if (kind === "material") return summarizeMaterial(filePath, value);
  if (kind === "asset-registry") return summarizeAssetRegistry(filePath, value);
  if (kind === "asset") return summarizeAsset(filePath, value);
  return summarizeUnknown(filePath, value);
}

export function summarizeUeCacheContent(filePath: string, content: Buffer | string): UeCacheSummary {
  const parsed = parseJsonContent(filePath, content);
  if (Array.isArray(parsed)) {
    return summarizeUnknown(filePath, parsed);
  }
  return summarizeUeCacheJson(filePath, parsed);
}

async function walkJsonFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(fullPath)));
    } else if (entry.isFile() && [".json", ".jsonl"].includes(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export async function summarizeUeAsset(assetPath: string, options: UeAssetSummarizeOptions = {}): Promise<string> {
  const normalized = assetPath.toLowerCase();
  const roots = Object.values(options.cacheRoots ?? {}).filter(Boolean);
  for (const root of roots) {
    for (const filePath of await walkJsonFiles(root)) {
      const summary = summarizeUeCacheContent(filePath, await readFile(filePath));
      if (summary.assetPath?.toLowerCase() === normalized || summary.text.toLowerCase().includes(normalized)) {
        return summary.text;
      }
    }
  }
  return `TODO / missing evidence: UE cache summary was not found for ${assetPath}. No .uasset files were read or edited.`;
}
