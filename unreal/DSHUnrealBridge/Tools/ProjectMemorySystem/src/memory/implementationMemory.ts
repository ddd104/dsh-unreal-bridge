import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  GraphContextResult,
  GraphFeatureResult,
  GraphNode,
  ProjectGraphClient
} from "../graph/projectGraphClient.js";
import {
  extractEvidenceBullets,
  extractTitle,
  sourceEvidence,
  toProjectPath
} from "../summarizers/documentSummarizer.js";
import type {
  ImplementationAssetLinkRecord,
  ImplementationBlueprintLinkRecord,
  ImplementationFeatureRecord,
  ImplementationGraphLinkRecord,
  ImplementationMemoryMap,
  ImplementationPatternRecord,
  KeySymbolKind,
  KeySymbolRecord,
  LoadedProjectConfig,
  ReuseGuidanceRecord
} from "../types/memoryTypes.js";
import type { UeCacheMemoryEntry } from "./ueCacheMemory.js";

type SourceCategory = "system" | "pattern" | "design";

interface MarkdownImplementationSource {
  category: SourceCategory;
  filePath: string;
  projectPath: string;
  id: string;
  title: string;
  text: string;
  bullets: string[];
  sourceHash: string;
}

export interface BuildImplementationMapOptions {
  runId?: string;
  graphClient?: ProjectGraphClient;
}

export interface ImplementationMemoryBuildResult {
  outputPath: string;
  latestPath: string;
  map: ImplementationMemoryMap;
  warnings: string[];
}

const MARKDOWN_DIRS: Array<{ category: SourceCategory; segments: string[] }> = [
  { category: "system", segments: ["systems"] },
  { category: "pattern", segments: ["patterns"] },
  { category: "design", segments: ["design"] }
];

const TEMPLATE_LINE = /待填写|待确认|TODO|missing evidence|当前文件只|文档模板|模板和说明|不要凭记忆/i;
const FORBIDDEN_LINE = /Forbidden|Forbid|禁止|不要|不允许|Do not|Don't|Never/i;
const GUIDANCE_LINE = /Recommended|Recommend|Reuse|Reusable|Extension|Guidance|优先|复用|扩展|建议|沿用|遵循/i;
const VALIDATION_LINE = /Validation|Validate|Test|测试|验证|Build|编译|运行/i;
const GENERIC_MATCH_TOKENS = new Set([
  "project",
  "memory",
  "system",
  "systems",
  "implementation",
  "implementations",
  "pattern",
  "patterns",
  "cache",
  "summary",
  "summaries",
  "source",
  "sources",
  "blueprint",
  "blueprints",
  "asset",
  "assets",
  "material",
  "materials",
  "generated",
  "safety",
  "readonly",
  "read",
  "only",
  "directly",
  "status",
  "confirmed",
  "based",
  "tools",
  "codex"
]);

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueSymbols(symbols: KeySymbolRecord[]): KeySymbolRecord[] {
  const merged = new Map<string, KeySymbolRecord>();
  for (const symbol of symbols) {
    const key = `${symbol.kind}:${symbol.name}:${symbol.path ?? ""}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, {
        ...symbol,
        evidence: unique(symbol.evidence)
      });
      continue;
    }
    previous.evidence = unique([...previous.evidence, ...symbol.evidence]);
    previous.system ??= symbol.system;
    previous.source ??= symbol.source;
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function hashStrings(values: string[]): string {
  const hasher = createHash("sha256");
  for (const value of values.sort()) {
    hasher.update(value);
  }
  return hasher.digest("hex");
}

function createRunId(date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, "").replace(/[^\dTZ]/g, "");
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "implementation";
}

function cleanLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^(Feature|Purpose|Responsibility|Pattern|Recommended|Reusable symbol|Reusable event|Key symbol|Key event|Key variable|Forbidden|Validation|功能|用途|职责|模式|建议|复用|禁止|验证)\s*[:：]\s*/i, "")
    .trim();
}

function isUsefulLine(line: string): boolean {
  const cleaned = cleanLine(line);
  return Boolean(cleaned) && !TEMPLATE_LINE.test(cleaned);
}

function extractExplicitFeatureId(text: string): string | undefined {
  const match = /(?:^|\n)\s*(?:[-*]\s*)?(?:Feature|Implementation|功能|实现)\s*[:：]\s*([A-Za-z0-9_.-]+)/i.exec(text);
  return match?.[1] ? slug(match[1]) : undefined;
}

function extractListFromLabeledLine(text: string, labels: string[]): string[] {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:${escaped})\\s*[:：]\\s*(.+)`, "gi");
  const values: string[] = [];
  for (const match of text.matchAll(pattern)) {
    values.push(...match[1].split(/[,，、]/).map((item) => item.trim()).filter(Boolean));
  }
  return unique(values);
}

function extractPurpose(text: string, bullets: string[]): string {
  const line = text
    .split(/\r?\n/)
    .find((item) => /Purpose|Responsibility|用途|职责|目标|目的/i.test(item) && isUsefulLine(item));
  if (line) return cleanLine(line);
  return bullets.find((item) => !FORBIDDEN_LINE.test(item) && !GUIDANCE_LINE.test(item)) ?? "TODO / missing evidence";
}

function extractCodePaths(text: string): string[] {
  const matches = text.match(/\b(?:Source|Plugins|Script|Config)\/[A-Za-z0-9_./-]+(?:\.[A-Za-z0-9_]+)?/g) ?? [];
  return unique(matches);
}

function extractAssetPaths(text: string): string[] {
  const matches = text.match(/\/Game\/[A-Za-z0-9_./-]+/g) ?? [];
  const objectNames = text.match(/\b(?:BP|WBP|ABP|BPI|DA|DT|M|MI|T|SK|SM)_[A-Za-z0-9_]+\b/g) ?? [];
  return unique([...matches, ...objectNames]);
}

function isBlueprintReference(value: string): boolean {
  return /(^|\/)(?:BP|WBP|ABP|BPI)_|Blueprint|WidgetBlueprint/i.test(value);
}

function isDataAssetReference(value: string): boolean {
  return /(^|\/)(?:DA|DT)_|DataAsset|DataTable/i.test(value);
}

function isMaterialReference(value: string): boolean {
  return /(^|\/)(?:M|MI)_|Material/i.test(value);
}

function extractPrimaryBlueprints(text: string): string[] {
  return extractAssetPaths(text).filter(isBlueprintReference);
}

function extractPrimaryAssets(text: string): string[] {
  return extractAssetPaths(text).filter((value) => !isBlueprintReference(value));
}

function classifySymbol(name: string, fallback: KeySymbolKind = "unknown"): KeySymbolKind {
  if (/^(?:BP|WBP|ABP|BPI)_/.test(name)) return "blueprint";
  if (/^(?:DA|DT)_/.test(name)) return "dataAsset";
  if (/^(?:M|MI)_/.test(name)) return "material";
  if (/^On[A-Z]/.test(name)) return "event";
  if (/^[USAFIE][A-Z]/.test(name)) return "class";
  return fallback;
}

function symbolFromName(name: string, evidence: string, source: KeySymbolRecord["source"], system?: string, pathValue?: string): KeySymbolRecord {
  return {
    name,
    kind: classifySymbol(name),
    path: pathValue,
    system,
    source,
    evidence: [evidence]
  };
}

function extractSymbols(text: string, source: KeySymbolRecord["source"], system?: string, pathValue?: string): KeySymbolRecord[] {
  const symbols: KeySymbolRecord[] = [];
  const explicit = [
    ...extractListFromLabeledLine(text, ["Key symbol", "Reusable symbol", "Symbol", "关键符号", "复用符号"]),
    ...extractListFromLabeledLine(text, ["Key event", "Reusable event", "Event", "关键事件", "复用事件"])
  ];
  for (const name of explicit) {
    symbols.push(symbolFromName(name, `Explicit symbol in ${pathValue ?? "source"}`, source, system, pathValue));
  }

  const matches = text.match(/\b(?:[USAFIE][A-Z][A-Za-z0-9_]{2,}|On[A-Z][A-Za-z0-9_]{2,}|(?:BP|WBP|ABP|BPI|DA|DT|M|MI)_[A-Za-z0-9_]+)\b/g) ?? [];
  for (const name of matches) {
    symbols.push(symbolFromName(name, `Mentioned in ${pathValue ?? "source"}`, source, system, pathValue));
  }

  return uniqueSymbols(symbols);
}

function extractVariables(text: string): string[] {
  return unique([
    ...extractListFromLabeledLine(text, ["Key variable", "Variable", "变量", "关键变量"]),
    ...(text.match(/\b[a-z][A-Za-z0-9_]*(?:Health|Damage|State|Percent|Component|Widget)\b/g) ?? [])
  ]);
}

function extractEvents(text: string): string[] {
  return unique([
    ...extractListFromLabeledLine(text, ["Key event", "Event", "事件", "关键事件"]),
    ...(text.match(/\bOn[A-Z][A-Za-z0-9_]{2,}\b/g) ?? [])
  ]);
}

function extractForbidden(text: string): string[] {
  return unique(text.split(/\r?\n/).filter((line) => FORBIDDEN_LINE.test(line) && isUsefulLine(line)).map(cleanLine));
}

function extractValidationHints(text: string): string[] {
  return unique(text.split(/\r?\n/).filter((line) => VALIDATION_LINE.test(line) && isUsefulLine(line)).map(cleanLine));
}

function extractGuidance(text: string, sourcePaths: string[]): ReuseGuidanceRecord[] {
  return text
    .split(/\r?\n/)
    .filter((line) => GUIDANCE_LINE.test(line) && isUsefulLine(line))
    .map((line) => {
      const summary = cleanLine(line);
      return {
        summary,
        sourcePaths,
        evidence: [summary]
      };
    });
}

function systemNamesFromText(text: string, fallbackSystems: string[]): string[] {
  const explicit = extractListFromLabeledLine(text, ["Systems", "System", "系统", "所属系统"]);
  const matched = fallbackSystems.filter((system) => system && text.toLowerCase().includes(system.toLowerCase()));
  return unique([...explicit, ...matched]);
}

function nodeToSymbol(node: GraphNode): KeySymbolRecord | undefined {
  if (!node.name) return undefined;
  const nodeType = node.type.toLowerCase();
  let kind: KeySymbolKind = "unknown";
  if (nodeType.includes("class") || nodeType.includes("component")) kind = "class";
  if (nodeType.includes("function")) kind = "function";
  if (nodeType.includes("event")) kind = "event";
  if (nodeType.includes("property") || nodeType.includes("variable")) kind = "property";
  if (nodeType.includes("blueprint")) kind = "blueprint";
  if (nodeType.includes("dataasset")) kind = "dataAsset";
  if (nodeType.includes("material")) kind = "material";
  if (nodeType.includes("asset") && kind === "unknown") kind = "asset";
  return {
    name: node.name,
    kind: kind === "unknown" ? classifySymbol(node.name) : kind,
    path: node.path,
    system: node.system,
    source: "project-graph",
    evidence: [node.summary ?? `${node.type}: ${node.path}`]
  };
}

function applyNodeToFeature(feature: ImplementationFeatureRecord, node: GraphNode): void {
  if (node.type === "File") {
    feature.primaryCode = unique([...feature.primaryCode, node.path]);
  } else if (/Blueprint/i.test(node.type)) {
    feature.primaryBlueprints = unique([...feature.primaryBlueprints, node.path]);
  } else if (/Asset|Material|DataAsset|Widget|Level/i.test(node.type)) {
    feature.primaryAssets = unique([...feature.primaryAssets, node.path]);
  }
  const symbol = nodeToSymbol(node);
  if (symbol) feature.keySymbols = uniqueSymbols([...feature.keySymbols, symbol]);
  if (/DataAsset/i.test(node.type)) feature.keyDataAssets = unique([...feature.keyDataAssets, node.path]);
  if (node.system) feature.systems = unique([...feature.systems, node.system]);
}

function applyGraphResultToFeature(feature: ImplementationFeatureRecord, result: GraphFeatureResult | GraphContextResult): void {
  for (const node of result.nodes) applyNodeToFeature(feature, node);
  feature.primaryCode = unique([...feature.primaryCode, ...result.filesToRead]);
  feature.primaryBlueprints = unique([...feature.primaryBlueprints, ...result.blueprintsToRead]);
  feature.primaryAssets = unique([...feature.primaryAssets, ...result.assetsToInspect]);
}

function tokenSet(text: string): string[] {
  return unique(
    text
      .toLowerCase()
      .split(/[^a-z0-9_\u4e00-\u9fa5]+/)
      .filter((token) => token.length >= 2 && !GENERIC_MATCH_TOKENS.has(token) && !/^\d+$/.test(token))
  );
}

function scoreMatch(query: string, haystack: string): number {
  const tokens = tokenSet(query).filter((token) => !["the", "and", "with", "from", "this", "that"].includes(token));
  const lower = haystack.toLowerCase();
  return tokens.reduce((score, token) => score + (lower.includes(token) ? 1 : 0), 0);
}

function referenceNames(values: string[]): string[] {
  return unique(values.flatMap((value) => {
    const normalized = value.replace(/\\/g, "/");
    const base = normalized.split("/").pop() ?? normalized;
    const objectName = base.split(".").pop() ?? base;
    return [value, base, objectName].filter((item) => item.length >= 3);
  }));
}

function featureQuery(feature: ImplementationFeatureRecord): string {
  return [
    feature.id,
    feature.name,
    feature.systems.join(" "),
    feature.purpose,
    feature.implementationPattern.join(" "),
    feature.keySymbols.map((symbol) => symbol.name).join(" ")
  ].join(" ");
}

function ueEntryMatchesFeature(feature: ImplementationFeatureRecord, entry: UeCacheMemoryEntry): boolean {
  const query = featureQuery(feature);
  const haystack = `${entry.title} ${entry.assetPath ?? ""} ${entry.text}`;
  const lowerHaystack = haystack.toLowerCase();
  const directReferences = referenceNames([...feature.primaryBlueprints, ...feature.primaryAssets, ...feature.keyDataAssets]);
  if (directReferences.some((reference) => lowerHaystack.includes(reference.toLowerCase()))) return true;

  const symbolReferences = unique([
    ...feature.keySymbols.map((symbol) => symbol.name),
    ...feature.keyEvents,
    ...feature.keyVariables.filter((item) => item.length >= 5)
  ]).filter((item) => item.length >= 5);
  if (symbolReferences.some((reference) => lowerHaystack.includes(reference.toLowerCase()))) return true;

  const meaningfulTokens = tokenSet(query).filter((token) => token.length >= 5);
  return meaningfulTokens.some((token) => lowerHaystack.includes(token)) && scoreMatch(query, haystack) >= 3;
}

function applyUeEntryToFeature(feature: ImplementationFeatureRecord, entry: UeCacheMemoryEntry): void {
  const assetPath = entry.assetPath ?? entry.title;
  if (entry.kind === "blueprint") {
    feature.primaryBlueprints = unique([...feature.primaryBlueprints, assetPath]);
  } else if (entry.kind === "material" || entry.kind === "asset-registry" || entry.kind === "asset") {
    feature.primaryAssets = unique([...feature.primaryAssets, assetPath]);
  }
  feature.primaryBlueprints = unique([...feature.primaryBlueprints, ...extractPrimaryBlueprints(entry.text)]);
  feature.primaryAssets = unique([...feature.primaryAssets, ...extractPrimaryAssets(entry.text)]);
  feature.keySymbols = uniqueSymbols([...feature.keySymbols, ...extractSymbols(entry.text, "ue-cache", feature.systems[0], entry.sourcePaths[0])]);
  feature.keyVariables = unique([...feature.keyVariables, ...extractVariables(entry.text)]);
  feature.keyEvents = unique([...feature.keyEvents, ...extractEvents(entry.text)]);
  feature.keyDataAssets = unique([...feature.keyDataAssets, ...extractAssetPaths(entry.text).filter(isDataAssetReference)]);
  feature.evidence = unique([...feature.evidence, `${entry.title}: ${entry.assetPath ?? "no asset path"}`]);
}

async function walkMarkdown(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdown(fullPath)));
    } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function readMarkdownSources(loaded: LoadedProjectConfig): Promise<MarkdownImplementationSource[]> {
  const sources: MarkdownImplementationSource[] = [];
  for (const root of loaded.resolvedKnowledgeRoots) {
    for (const dir of MARKDOWN_DIRS) {
      const sourceDir = path.join(root, ...dir.segments);
      for (const filePath of await walkMarkdown(sourceDir)) {
        if (/^README\.md$/i.test(path.basename(filePath))) continue;
        const text = await readFile(filePath, "utf8");
        const evidence = await sourceEvidence(loaded.projectRoot, [filePath]);
        const projectPath = toProjectPath(loaded.projectRoot, filePath);
        const fallback = path.basename(filePath, path.extname(filePath));
        sources.push({
          category: dir.category,
          filePath,
          projectPath,
          id: slug(fallback),
          title: extractTitle(text, fallback),
          text,
          bullets: extractEvidenceBullets(text, 16),
          sourceHash: evidence.sourceHash
        });
      }
    }
  }
  return sources;
}

async function readUeCacheEntries(loaded: LoadedProjectConfig): Promise<UeCacheMemoryEntry[]> {
  const filePath = path.join(loaded.resolvedMemoryOutputRoot, "ue-cache", "summaries.jsonl");
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as UeCacheMemoryEntry);
}

function featureFromSource(source: MarkdownImplementationSource, fallbackSystems: string[]): ImplementationFeatureRecord {
  const sourcePaths = [source.projectPath];
  const explicitId = extractExplicitFeatureId(source.text);
  const id = explicitId ?? source.id;
  const systems = source.category === "system"
    ? unique([source.title, ...systemNamesFromText(source.text, fallbackSystems)])
    : systemNamesFromText(source.text, fallbackSystems);
  const purpose = extractPurpose(source.text, source.bullets);
  const primaryAssets = extractPrimaryAssets(source.text);
  return {
    id,
    name: explicitId ? source.title : source.title,
    systems,
    purpose,
    primaryCode: extractCodePaths(source.text),
    primaryBlueprints: extractPrimaryBlueprints(source.text),
    primaryAssets,
    keySymbols: extractSymbols(source.text, "project-knowledge", systems[0], source.projectPath),
    keyVariables: extractVariables(source.text),
    keyEvents: extractEvents(source.text),
    keyDataAssets: unique([...extractListFromLabeledLine(source.text, ["Key DataAsset", "DataAsset", "Data Asset", "关键 DataAsset"]), ...primaryAssets.filter(isDataAssetReference)]),
    implementationPattern: source.category === "pattern" ? [source.title] : extractListFromLabeledLine(source.text, ["Pattern", "Implementation pattern", "模式", "实现模式"]),
    extensionGuidance: extractGuidance(source.text, sourcePaths),
    forbiddenApproaches: extractForbidden(source.text),
    validationHints: extractValidationHints(source.text),
    evidence: source.bullets.length ? source.bullets : ["TODO / missing evidence"],
    sourcePaths,
    sourceHash: source.sourceHash
  };
}

export function extractImplementationPatterns(sources: MarkdownImplementationSource[], fallbackSystems: string[]): ImplementationPatternRecord[] {
  const patterns = sources
    .filter((source) => source.category === "pattern")
    .map((source) => {
      const sourcePaths = [source.projectPath];
      const systems = systemNamesFromText(source.text, fallbackSystems);
      return {
        id: source.id,
        name: source.title,
        systems,
        summary: source.bullets.find((bullet) => !FORBIDDEN_LINE.test(bullet)) ?? "TODO / missing evidence",
        recommendedApproaches: unique(source.text.split(/\r?\n/).filter((line) => GUIDANCE_LINE.test(line) && isUsefulLine(line)).map(cleanLine)),
        forbiddenApproaches: extractForbidden(source.text),
        reusableSymbols: extractSymbols(source.text, "project-knowledge", systems[0], source.projectPath),
        reusableBlueprints: extractPrimaryBlueprints(source.text),
        reusableAssets: extractPrimaryAssets(source.text),
        evidence: source.bullets.length ? source.bullets : ["TODO / missing evidence"],
        sourcePaths,
        sourceHash: source.sourceHash
      } satisfies ImplementationPatternRecord;
    });
  return patterns.sort((a, b) => a.id.localeCompare(b.id));
}

function mergeFeature(target: ImplementationFeatureRecord, incoming: ImplementationFeatureRecord): ImplementationFeatureRecord {
  const sourceHash = hashStrings([target.sourceHash, incoming.sourceHash]);
  return {
    ...target,
    name: target.name || incoming.name,
    systems: unique([...target.systems, ...incoming.systems]),
    purpose: target.purpose !== "TODO / missing evidence" ? target.purpose : incoming.purpose,
    primaryCode: unique([...target.primaryCode, ...incoming.primaryCode]),
    primaryBlueprints: unique([...target.primaryBlueprints, ...incoming.primaryBlueprints]),
    primaryAssets: unique([...target.primaryAssets, ...incoming.primaryAssets]),
    keySymbols: uniqueSymbols([...target.keySymbols, ...incoming.keySymbols]),
    keyVariables: unique([...target.keyVariables, ...incoming.keyVariables]),
    keyEvents: unique([...target.keyEvents, ...incoming.keyEvents]),
    keyDataAssets: unique([...target.keyDataAssets, ...incoming.keyDataAssets]),
    implementationPattern: unique([...target.implementationPattern, ...incoming.implementationPattern]),
    extensionGuidance: [...target.extensionGuidance, ...incoming.extensionGuidance],
    forbiddenApproaches: unique([...target.forbiddenApproaches, ...incoming.forbiddenApproaches]),
    validationHints: unique([...target.validationHints, ...incoming.validationHints]),
    evidence: unique([...target.evidence, ...incoming.evidence]),
    sourcePaths: unique([...target.sourcePaths, ...incoming.sourcePaths]),
    sourceHash
  };
}

export async function linkImplementationsToGraphNodes(
  features: ImplementationFeatureRecord[],
  graphClient?: ProjectGraphClient
): Promise<{ links: ImplementationGraphLinkRecord[]; warnings: string[] }> {
  if (!graphClient) return { links: [], warnings: ["ProjectGraph adapter was not provided for Implementation Memory build."] };
  const available = await graphClient.isAvailable().catch(() => false);
  if (!available) return { links: [], warnings: ["ProjectGraph adapter unavailable; Implementation Memory graph links were skipped."] };

  const links: ImplementationGraphLinkRecord[] = [];
  const warnings: string[] = [];
  for (const feature of features) {
    try {
      const featureResult = await graphClient.findFeatureContext(featureQuery(feature), { limit: 12 });
      applyGraphResultToFeature(feature, featureResult);
      const seedNodes = featureResult.nodes.map((node) => node.id).slice(0, 12);
      const contextResult = await graphClient.expandContext(seedNodes, { depth: 1, limit: 24 });
      applyGraphResultToFeature(feature, contextResult);
      const nodeIds = unique([...featureResult.nodes, ...contextResult.nodes].map((node) => node.id));
      if (nodeIds.length > 0) links.push({ featureId: feature.id, nodeIds });
      warnings.push(...featureResult.warnings, ...contextResult.warnings);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`Implementation graph link failed for ${feature.id}: ${reason}`);
    }
  }
  return { links, warnings: unique(warnings) };
}

export function linkImplementationsToBlueprints(
  features: ImplementationFeatureRecord[],
  ueEntries: UeCacheMemoryEntry[]
): ImplementationBlueprintLinkRecord[] {
  const links: ImplementationBlueprintLinkRecord[] = [];
  for (const feature of features) {
    for (const entry of ueEntries.filter((item) => item.kind === "blueprint" && ueEntryMatchesFeature(feature, item))) {
      applyUeEntryToFeature(feature, entry);
    }
    if (feature.primaryBlueprints.length > 0) {
      links.push({ featureId: feature.id, blueprints: feature.primaryBlueprints });
    }
  }
  return links;
}

export function linkImplementationsToAssets(
  features: ImplementationFeatureRecord[],
  ueEntries: UeCacheMemoryEntry[]
): ImplementationAssetLinkRecord[] {
  const links: ImplementationAssetLinkRecord[] = [];
  for (const feature of features) {
    for (const entry of ueEntries.filter((item) => item.kind !== "blueprint" && ueEntryMatchesFeature(feature, item))) {
      applyUeEntryToFeature(feature, entry);
    }
    if (feature.primaryAssets.length > 0) {
      links.push({ featureId: feature.id, assets: feature.primaryAssets });
    }
  }
  return links;
}

function trimFeatureRecordForCache(feature: ImplementationFeatureRecord): void {
  feature.primaryCode = feature.primaryCode.slice(0, 64);
  feature.primaryBlueprints = feature.primaryBlueprints.slice(0, 64);
  feature.primaryAssets = feature.primaryAssets.slice(0, 64);
  feature.keySymbols = uniqueSymbols(feature.keySymbols).slice(0, 160);
  feature.keyVariables = feature.keyVariables.slice(0, 80);
  feature.keyEvents = feature.keyEvents.slice(0, 80);
  feature.keyDataAssets = feature.keyDataAssets.slice(0, 64);
  feature.extensionGuidance = feature.extensionGuidance.slice(0, 40);
  feature.forbiddenApproaches = feature.forbiddenApproaches.slice(0, 40);
  feature.validationHints = feature.validationHints.slice(0, 40);
  feature.evidence = feature.evidence.slice(0, 80);
}

export function latestImplementationMapPointerPath(loaded: LoadedProjectConfig): string {
  return path.join(loaded.resolvedMemoryOutputRoot, "runs", "latest.json");
}

export async function readLatestImplementationMap(loaded: LoadedProjectConfig): Promise<ImplementationMemoryMap | undefined> {
  const latestPath = latestImplementationMapPointerPath(loaded);
  if (existsSync(latestPath)) {
    try {
      const latest = JSON.parse(await readFile(latestPath, "utf8")) as { path?: string };
      const mapPath = latest.path ? path.resolve(loaded.projectRoot, latest.path) : undefined;
      if (mapPath && existsSync(mapPath)) {
        return JSON.parse(await readFile(mapPath, "utf8")) as ImplementationMemoryMap;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function buildImplementationMap(
  loaded: LoadedProjectConfig,
  options: BuildImplementationMapOptions = {}
): Promise<ImplementationMemoryBuildResult> {
  const runId = options.runId ?? createRunId();
  const runDir = path.join(loaded.resolvedMemoryOutputRoot, "runs", runId);
  const outputPath = path.join(runDir, "implementation_map.json");
  const latestPath = latestImplementationMapPointerPath(loaded);
  const generatedAt = new Date().toISOString();
  const warnings: string[] = [];

  const sources = await readMarkdownSources(loaded);
  const fallbackSystems = sources.filter((source) => source.category === "system").map((source) => source.title);
  const sourceFeatures = sources
    .filter((source) => source.category === "system" || source.category === "design" || extractExplicitFeatureId(source.text))
    .map((source) => featureFromSource(source, fallbackSystems));
  const patterns = extractImplementationPatterns(sources, fallbackSystems);

  for (const pattern of patterns) {
    const patternSource = sources.find((source) => source.id === pattern.id && source.category === "pattern");
    if (!patternSource) continue;
    const explicitFeatureId = extractExplicitFeatureId(patternSource.text);
    if (explicitFeatureId) sourceFeatures.push(featureFromSource(patternSource, fallbackSystems));
  }

  const featureMap = new Map<string, ImplementationFeatureRecord>();
  for (const feature of sourceFeatures) {
    const previous = featureMap.get(feature.id);
    featureMap.set(feature.id, previous ? mergeFeature(previous, feature) : feature);
  }
  const features = [...featureMap.values()].sort((a, b) => a.id.localeCompare(b.id));
  const ueEntries = await readUeCacheEntries(loaded);

  const graphLinkResult = await linkImplementationsToGraphNodes(features, options.graphClient);
  let blueprintLinks = linkImplementationsToBlueprints(features, ueEntries);
  let assetLinks = linkImplementationsToAssets(features, ueEntries);
  warnings.push(...graphLinkResult.warnings);
  for (const feature of features) trimFeatureRecordForCache(feature);
  blueprintLinks = features
    .filter((feature) => feature.primaryBlueprints.length > 0)
    .map((feature) => ({ featureId: feature.id, blueprints: feature.primaryBlueprints }));
  assetLinks = features
    .filter((feature) => feature.primaryAssets.length > 0)
    .map((feature) => ({ featureId: feature.id, assets: feature.primaryAssets }));

  const keySymbols = uniqueSymbols([
    ...features.flatMap((feature) => feature.keySymbols),
    ...patterns.flatMap((pattern) => pattern.reusableSymbols)
  ]);
  const reuseGuidance = [
    ...features.flatMap((feature) => feature.extensionGuidance),
    ...patterns.flatMap((pattern) => pattern.recommendedApproaches.map((summary) => ({
      summary,
      sourcePaths: pattern.sourcePaths,
      evidence: [summary]
    } satisfies ReuseGuidanceRecord)))
  ];
  const sourcePaths = unique([
    ...sources.map((source) => source.projectPath),
    ...ueEntries.flatMap((entry) => entry.sourcePaths)
  ]);
  const sourceHash = hashStrings([
    ...sources.map((source) => source.sourceHash),
    ...ueEntries.map((entry) => entry.sourceHash)
  ]);
  const missingInformation: string[] = [];
  if (sources.length === 0) missingInformation.push("No ProjectKnowledge systems, patterns, or design markdown files were available for Implementation Memory.");
  if (features.length === 0) missingInformation.push("No implemented feature records could be confirmed from ProjectKnowledge.");
  if (patterns.length === 0) missingInformation.push("No implementation pattern records could be confirmed from ProjectKnowledge/patterns.");
  if (ueEntries.length === 0) missingInformation.push("UE cache summaries were not available; blueprint/material/asset implementation links may be incomplete.");
  if (graphLinkResult.links.length === 0) missingInformation.push("ProjectGraph did not contribute confirmed implementation node links.");

  const map: ImplementationMemoryMap = {
    schemaVersion: 1,
    projectId: loaded.config.projectId,
    runId,
    generatedAt,
    sourcePaths,
    sourceHash,
    features,
    patterns,
    keySymbols,
    reuseGuidance,
    graphLinks: graphLinkResult.links,
    blueprintLinks,
    assetLinks,
    missingInformation
  };

  await mkdir(runDir, { recursive: true });
  await mkdir(path.dirname(latestPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  await writeFile(latestPath, `${JSON.stringify({
    runId,
    path: toProjectPath(loaded.projectRoot, outputPath),
    generatedAt
  }, null, 2)}\n`, "utf8");

  return {
    outputPath,
    latestPath,
    map,
    warnings: unique(warnings)
  };
}
