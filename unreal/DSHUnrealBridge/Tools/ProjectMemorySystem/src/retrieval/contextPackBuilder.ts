import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NullGraphClient } from "../graph/nullGraphClient.js";
import type { GraphContextResult, GraphFeatureResult, GraphStatus, ProjectGraphClient } from "../graph/projectGraphClient.js";
import { readLatestImplementationMap } from "../memory/implementationMemory.js";
import {
  type ContextPack,
  type ContextPackRequest,
  type EvidenceItem,
  resolveContextBudget
} from "../types/contextPackTypes.js";
import type {
  ImplementationFeatureRecord,
  ImplementationMemoryMap,
  ImplementationPatternRecord,
  KeySymbolRecord,
  LoadedProjectConfig,
  ReuseGuidanceRecord
} from "../types/memoryTypes.js";
import { findExistingPatterns } from "./findExistingPatterns.js";
import { findOwningSystem } from "./findOwningSystem.js";
import { findRelevantDocs } from "./findRelevantDocs.js";
import { rerankEvidenceItems } from "./reranker.js";

export interface BuildMemoryContextPackOptions {
  loaded: LoadedProjectConfig;
  graphClient: ProjectGraphClient;
  graphDepth?: number;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueSymbols(symbols: KeySymbolRecord[]): KeySymbolRecord[] {
  const merged = new Map<string, KeySymbolRecord>();
  for (const symbol of symbols) {
    const key = `${symbol.kind}:${symbol.name}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, {
        ...symbol,
        evidence: unique(symbol.evidence ?? [])
      });
      continue;
    }
    previous.evidence = unique([...previous.evidence, ...(symbol.evidence ?? [])]);
    previous.system ??= symbol.system;
    previous.source ??= symbol.source;
    previous.path ??= symbol.path;
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function scoreText(query: string, text: string): number {
  const tokens = query.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fa5]+/).filter((token) => token.length >= 2);
  const haystack = text.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

async function readTextIfExists(filePath: string): Promise<string> {
  if (!existsSync(filePath)) return "";
  return readFile(filePath, "utf8");
}

function parseHeaderEvidence(text: string): { sourcePaths: string[]; sourceHash?: string } {
  const sourcePathsLine = /^sourcePaths:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const sourceHash = /^sourceHash:\s*(.+)$/m.exec(text)?.[1]?.trim();
  return {
    sourcePaths: sourcePathsLine && !/missing evidence/i.test(sourcePathsLine)
      ? sourcePathsLine.split(",").map((item) => item.trim()).filter(Boolean)
      : [],
    sourceHash
  };
}

function itemFromMarkdown(id: string, title: string, text: string): EvidenceItem | undefined {
  if (!text.trim()) return undefined;
  const evidence = parseHeaderEvidence(text);
  const excerpt = text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("- "))
    .slice(0, 6)
    .join("\n");
  return {
    id,
    title,
    sourcePaths: evidence.sourcePaths,
    sourceHash: evidence.sourceHash,
    excerpt: excerpt || "TODO / missing evidence",
    score: evidence.sourcePaths.length > 0 ? 1 : 0,
    status: /TODO \/ missing evidence|Status:\s*missing_evidence/i.test(text) ? "missing_evidence" : "ok"
  };
}

async function loadProjectCapsule(loaded: LoadedProjectConfig): Promise<string> {
  const text = await readTextIfExists(path.join(loaded.resolvedMemoryOutputRoot, "project_capsule.md"));
  return text || "TODO / missing evidence: project_capsule.md is missing. Run memory build --capsule.";
}

async function loadArchitectureRules(loaded: LoadedProjectConfig): Promise<EvidenceItem[]> {
  const text = await readTextIfExists(path.join(loaded.resolvedMemoryOutputRoot, "architecture_rules.md"));
  const item = itemFromMarkdown("architecture_rules", "Architecture Rules", text);
  return item ? [item] : [];
}

async function loadSystemMap(loaded: LoadedProjectConfig): Promise<EvidenceItem[]> {
  const mapPath = path.join(loaded.resolvedMemoryOutputRoot, "system_map.json");
  if (!existsSync(mapPath)) return [];
  const parsed = JSON.parse(await readFile(mapPath, "utf8")) as {
    systems?: Array<{
      systemId: string;
      title: string;
      status?: string;
      sourcePaths?: string[];
      sourceHash?: string;
      notes?: string[];
    }>;
  };
  return (parsed.systems ?? []).map((system) => ({
    id: system.systemId,
    title: system.title,
    sourcePaths: system.sourcePaths ?? [],
    sourceHash: system.sourceHash,
    excerpt: (system.notes ?? []).join("\n"),
    status: system.status,
    score: (system.sourcePaths?.length ?? 0) > 0 ? 1 : 0
  }));
}

async function loadValidationPlan(loaded: LoadedProjectConfig): Promise<EvidenceItem[]> {
  const validationDir = path.join(loaded.resolvedMemoryOutputRoot, "validation");
  if (!existsSync(validationDir)) return [];
  const names = ["build_commands.json", "test_map.json"];
  const items: EvidenceItem[] = [];
  for (const name of names) {
    const filePath = path.join(validationDir, name);
    if (!existsSync(filePath)) continue;
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
      sourcePaths?: string[];
      sourceHash?: string;
      content?: unknown;
    };
    items.push({
      id: name,
      title: name,
      sourcePaths: parsed.sourcePaths ?? [],
      sourceHash: parsed.sourceHash,
      excerpt: JSON.stringify(parsed.content ?? {}, null, 2).slice(0, 1200),
      score: parsed.sourceHash ? 1 : 0,
      status: /待填写|待确认|TODO/i.test(JSON.stringify(parsed.content ?? {})) ? "missing_evidence" : "ok"
    });
  }
  return items;
}

function implementationFeatureHaystack(feature: ImplementationFeatureRecord): string {
  return [
    feature.id,
    feature.name,
    feature.systems.join(" "),
    feature.purpose,
    feature.primaryCode.join(" "),
    feature.primaryBlueprints.join(" "),
    feature.primaryAssets.join(" "),
    feature.keySymbols.map((symbol) => symbol.name).join(" "),
    feature.keyVariables.join(" "),
    feature.keyEvents.join(" "),
    feature.keyDataAssets.join(" "),
    feature.implementationPattern.join(" "),
    feature.extensionGuidance.map((item) => item.summary).join(" "),
    feature.forbiddenApproaches.join(" "),
    feature.validationHints.join(" "),
    feature.evidence.join(" ")
  ].join(" ");
}

function patternHaystack(pattern: ImplementationPatternRecord): string {
  return [
    pattern.id,
    pattern.name,
    pattern.systems.join(" "),
    pattern.summary,
    pattern.recommendedApproaches.join(" "),
    pattern.forbiddenApproaches.join(" "),
    pattern.reusableSymbols.map((symbol) => symbol.name).join(" "),
    pattern.reusableBlueprints.join(" "),
    pattern.reusableAssets.join(" "),
    pattern.evidence.join(" ")
  ].join(" ");
}

function rankImplementations(query: string, implementationMap: ImplementationMemoryMap | undefined, limit: number): ImplementationFeatureRecord[] {
  if (!implementationMap) return [];
  return implementationMap.features
    .map((feature) => {
      const textScore = scoreText(query, implementationFeatureHaystack(feature));
      return {
        feature,
        score: textScore > 0 ? textScore + (feature.sourcePaths.length > 0 ? 1 : 0) : 0
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.feature.id.localeCompare(b.feature.id))
    .slice(0, limit)
    .map((item) => item.feature);
}

function rankImplementationPatterns(query: string, implementationMap: ImplementationMemoryMap | undefined, limit: number): ImplementationPatternRecord[] {
  if (!implementationMap) return [];
  return implementationMap.patterns
    .map((pattern) => {
      const textScore = scoreText(query, patternHaystack(pattern));
      return {
        pattern,
        score: textScore > 0 ? textScore + (pattern.sourcePaths.length > 0 ? 1 : 0) : 0
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.pattern.id.localeCompare(b.pattern.id))
    .slice(0, limit)
    .map((item) => item.pattern);
}

function implementationPatternEvidence(pattern: ImplementationPatternRecord): EvidenceItem {
  return {
    id: pattern.id,
    title: pattern.name,
    sourcePaths: pattern.sourcePaths,
    sourceHash: pattern.sourceHash,
    excerpt: [
      pattern.summary,
      ...pattern.recommendedApproaches.slice(0, 4),
      ...pattern.forbiddenApproaches.slice(0, 4).map((item) => `Forbidden: ${item}`)
    ].filter(Boolean).join("\n"),
    score: pattern.sourcePaths.length > 0 ? 1 : 0,
    status: /TODO \/ missing evidence/i.test(pattern.summary) ? "missing_evidence" : "ok"
  };
}

function implementationGuidanceFor(
  implementations: ImplementationFeatureRecord[],
  implementationPatterns: ImplementationPatternRecord[],
  implementationMap: ImplementationMemoryMap | undefined,
  query: string
): ReuseGuidanceRecord[] {
  const scored = [
    ...implementations.flatMap((feature) => feature.extensionGuidance),
    ...implementationPatterns.flatMap((pattern) => pattern.recommendedApproaches.map((summary) => ({
      summary,
      sourcePaths: pattern.sourcePaths,
      evidence: [summary]
    } satisfies ReuseGuidanceRecord))),
    ...(implementationMap?.reuseGuidance ?? []).filter((item) => scoreText(query, `${item.summary} ${item.evidence.join(" ")}`) > 0)
  ];
  const seen = new Set<string>();
  return scored.filter((item) => {
    const key = `${item.summary}\0${item.sourcePaths.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function symbolsForQuery(
  query: string,
  implementations: ImplementationFeatureRecord[],
  implementationPatterns: ImplementationPatternRecord[],
  implementationMap: ImplementationMemoryMap | undefined,
  limit: number
): KeySymbolRecord[] {
  const symbols = uniqueSymbols([
    ...implementations.flatMap((feature) => feature.keySymbols),
    ...implementationPatterns.flatMap((pattern) => pattern.reusableSymbols),
    ...(implementationMap?.keySymbols ?? []).filter((symbol) => scoreText(query, `${symbol.name} ${symbol.path ?? ""} ${symbol.evidence.join(" ")}`) > 0)
  ]);
  return symbols.slice(0, limit);
}

function trimImplementationFeature(feature: ImplementationFeatureRecord, budget: ReturnType<typeof resolveContextBudget>): ImplementationFeatureRecord {
  return {
    ...feature,
    primaryCode: feature.primaryCode.slice(0, budget.maxFiles),
    primaryBlueprints: feature.primaryBlueprints.slice(0, budget.maxBlueprints),
    primaryAssets: feature.primaryAssets.slice(0, budget.maxAssets),
    keySymbols: uniqueSymbols(feature.keySymbols).slice(0, budget.maxReusableSymbols),
    keyVariables: feature.keyVariables.slice(0, 12),
    keyEvents: feature.keyEvents.slice(0, 12),
    keyDataAssets: feature.keyDataAssets.slice(0, budget.maxAssets),
    extensionGuidance: feature.extensionGuidance.slice(0, 8),
    forbiddenApproaches: unique(feature.forbiddenApproaches).slice(0, 12),
    validationHints: unique(feature.validationHints).slice(0, 12),
    evidence: feature.evidence.slice(0, 12)
  };
}

function graphContextWarnings(status: GraphStatus, feature: GraphFeatureResult, context: GraphContextResult): string[] {
  return unique([...status.warnings, ...feature.warnings, ...context.warnings]);
}

function missingInformation(pack: {
  projectCapsule: string;
  owningSystem: { confidence: string };
  architectureRules: EvidenceItem[];
  secondarySystems: EvidenceItem[];
  existingPatterns: EvidenceItem[];
  validationPlan: EvidenceItem[];
  graphStatus: GraphStatus;
  docsWarnings: string[];
  graphWarnings: string[];
  implementationMap?: ImplementationMemoryMap;
  relevantImplementations: ImplementationFeatureRecord[];
}): string[] {
  const missing: string[] = [];
  if (/TODO \/ missing evidence|project_capsule\.md is missing/i.test(pack.projectCapsule)) {
    missing.push("Project capsule lacks confirmed evidence.");
  }
  if (pack.owningSystem.confidence === "none") {
    missing.push("Owning system could not be determined from Project Memory or ProjectGraph.");
  }
  if (pack.architectureRules.length === 0 || pack.architectureRules.some((item) => item.status === "missing_evidence")) {
    missing.push("Architecture rules are missing or template-only.");
  }
  if (pack.secondarySystems.length === 0 || pack.secondarySystems.every((item) => item.status === "missing_evidence")) {
    missing.push("System memory is missing or lacks confirmed evidence.");
  }
  if (pack.existingPatterns.length === 0 || pack.existingPatterns.every((item) => item.status === "missing_evidence")) {
    missing.push("No confirmed existing implementation pattern was found.");
  }
  if (pack.validationPlan.length === 0 || pack.validationPlan.some((item) => item.status === "missing_evidence")) {
    missing.push("Validation memory is missing or contains TODO placeholders.");
  }
  if (!pack.graphStatus.available) {
    missing.push("ProjectGraph adapter is unavailable; graph context may be incomplete.");
  }
  if (!pack.implementationMap || pack.implementationMap.features.length === 0) {
    missing.push("Implementation Memory is missing or lacks confirmed feature records.");
  }
  if (pack.implementationMap) {
    missing.push(...pack.implementationMap.missingInformation);
  }
  if (pack.implementationMap && pack.implementationMap.features.length > 0 && pack.relevantImplementations.length === 0) {
    missing.push("No relevant implemented feature record matched this query.");
  }
  missing.push(...pack.docsWarnings, ...pack.graphWarnings);
  return unique(missing);
}

export async function buildMemoryContextPack(requestOrQuery: ContextPackRequest | string, options: BuildMemoryContextPackOptions): Promise<ContextPack> {
  const request: ContextPackRequest = typeof requestOrQuery === "string" ? { query: requestOrQuery } : requestOrQuery;
  const budget = resolveContextBudget(request.budget);
  const query = request.query;

  const [projectCapsule, architectureRules, systems, patterns, validation, relevantDocsResult, graphStatus, implementationMap] = await Promise.all([
    loadProjectCapsule(options.loaded),
    loadArchitectureRules(options.loaded),
    loadSystemMap(options.loaded),
    findExistingPatterns(query, options.loaded, budget.maxPatterns),
    loadValidationPlan(options.loaded),
    findRelevantDocs(query, options.loaded, budget.maxDocs),
    options.graphClient.status(),
    readLatestImplementationMap(options.loaded)
  ]);

  // 图谱尚未生成时仍返回资料证据与明确缺口，供 AI 继续读取源码和编辑器对象。
  const activeGraph = graphStatus.available ? options.graphClient : new NullGraphClient(graphStatus.message);
  const feature = await activeGraph.findFeatureContext(query, {
    limit: budget.maxGraphNodes
  });
  const seedNodes = feature.nodes.map((node) => node.id).slice(0, budget.maxGraphNodes);
  const graphContext = await activeGraph.expandContext(seedNodes, {
    depth: options.graphDepth ?? 1,
    limit: budget.maxGraphNodes
  });

  const rankedSystems = rerankEvidenceItems(systems).slice(0, budget.maxSystems);
  const owningSystem = findOwningSystem(query, rankedSystems, feature);
  const graphWarnings = graphContextWarnings(graphStatus, feature, graphContext);
  const rawRelevantImplementations = rankImplementations(query, implementationMap, budget.maxImplementations);
  const implementationPatterns = rankImplementationPatterns(query, implementationMap, budget.maxPatterns);
  const mergedPatterns = rerankEvidenceItems([
    ...patterns,
    ...implementationPatterns.map(implementationPatternEvidence)
  ]).slice(0, budget.maxPatterns);
  const reusableSymbols = symbolsForQuery(query, rawRelevantImplementations, implementationPatterns, implementationMap, budget.maxReusableSymbols);
  const reusableBlueprints = unique([
    ...rawRelevantImplementations.flatMap((item) => item.primaryBlueprints),
    ...implementationPatterns.flatMap((item) => item.reusableBlueprints)
  ]).slice(0, budget.maxBlueprints);
  const reusableAssets = unique([
    ...rawRelevantImplementations.flatMap((item) => item.primaryAssets),
    ...implementationPatterns.flatMap((item) => item.reusableAssets)
  ]).slice(0, budget.maxAssets);
  const extensionGuidance = implementationGuidanceFor(rawRelevantImplementations, implementationPatterns, implementationMap, query).slice(0, 8);
  const relevantImplementations = rawRelevantImplementations.map((item) => trimImplementationFeature(item, budget));

  const filesToRead = unique([
    ...feature.filesToRead,
    ...graphContext.filesToRead,
    ...rawRelevantImplementations.flatMap((item) => item.primaryCode)
  ]).slice(0, budget.maxFiles);
  const blueprintsToRead = unique([
    ...feature.blueprintsToRead,
    ...graphContext.blueprintsToRead,
    ...reusableBlueprints
  ]).slice(0, budget.maxBlueprints);
  const assetsToInspect = unique([
    ...feature.assetsToInspect,
    ...graphContext.assetsToInspect,
    ...reusableAssets
  ]).slice(0, budget.maxAssets);

  const forbiddenApproaches = [
    "Do not directly edit .uasset or .umap files.",
    "Do not invent project facts when ProjectKnowledge or source evidence is missing.",
    "Do not create a new Manager or Subsystem until existing owners are checked.",
    ...rawRelevantImplementations.flatMap((item) => item.forbiddenApproaches),
    ...implementationPatterns.flatMap((item) => item.forbiddenApproaches)
  ];
  if (request.taskType === "blueprint" || request.taskType === "material" || request.taskType === "asset") {
    forbiddenApproaches.push("Do not modify Blueprint, Material, or Content Browser assets without UE MCP read/analyze/dry-run/apply validation.");
  }

  const pack: ContextPack = {
    query,
    projectCapsule,
    owningSystem,
    secondarySystems: rankedSystems.filter((system) => system.id !== owningSystem.id).slice(0, budget.maxSystems),
    architectureRules: rerankEvidenceItems(architectureRules),
    relevantDocs: relevantDocsResult.docs,
    relevantImplementations,
    existingPatterns: mergedPatterns,
    reusableSymbols,
    reusableBlueprints,
    reusableAssets,
    graphContext: {
      status: graphStatus,
      feature: {
        ...feature,
        nodes: feature.nodes.slice(0, budget.maxGraphNodes)
      },
      context: {
        ...graphContext,
        nodes: graphContext.nodes.slice(0, budget.maxGraphNodes)
      }
    },
    filesToRead,
    blueprintsToRead,
    assetsToInspect,
    forbiddenApproaches: unique(forbiddenApproaches),
    extensionGuidance,
    validationPlan: validation,
    missingInformation: []
  };

  pack.missingInformation = missingInformation({
    projectCapsule,
    owningSystem,
    architectureRules: pack.architectureRules,
    secondarySystems: pack.secondarySystems,
    existingPatterns: pack.existingPatterns,
    validationPlan: pack.validationPlan,
    graphStatus,
    docsWarnings: relevantDocsResult.warnings,
    graphWarnings,
    implementationMap,
    relevantImplementations
  });
  return pack;
}
