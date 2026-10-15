export type GraphMode = "sqlite" | "mcp";

export interface ProjectGraphConfig {
  enabled: boolean;
  mode: GraphMode;
  sqlitePath?: string;
  mcpServerName?: string;
  url?: string;
  mcpUrl?: string;
  supportedModes?: GraphMode[];
  optional?: boolean;
  mcp?: {
    serverName?: string;
    tools?: Record<string, string>;
  };
  sqlite?: {
    databasePath?: string;
    nodesPath?: string;
    edgesPath?: string;
  };
}

export interface ProjectMemoryConfig {
  schemaVersion: number;
  projectId: string;
  project?: {
    name?: string;
    root?: string;
    uproject?: string;
    primaryModule?: string;
    targetPlatforms?: string[];
  };
  pathRules?: Record<string, unknown>;
  knowledgeRoots: string[];
  memoryOutputRoot: string;
  sourcePolicy?: {
    includeExtensions?: string[];
    includePatterns?: string[];
    excludePatterns?: string[];
    excludeGlobs?: string[];
    readOnlyBinaryAssets?: boolean;
  };
  memory?: Record<string, unknown>;
  graph: ProjectGraphConfig;
  validation?: {
    buildCommands?: string;
    testMap?: string;
  };
}

export interface LoadedProjectConfig {
  config: ProjectMemoryConfig;
  configPath: string;
  projectRoot: string;
  resolvedKnowledgeRoots: string[];
  resolvedMemoryOutputRoot: string;
}

export interface SourceDocument {
  id: string;
  path: string;
  sourceType: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface DocumentRecord {
  id: string;
  path: string;
  sourceType: string;
  title: string;
  text: string;
  metadata: Record<string, unknown>;
  hash: string;
  modifiedAt: string;
}

export interface MemorySearchResult {
  id: string;
  title: string;
  path: string;
  score: number;
  excerpt: string;
  sourceType: string;
}

export type KeySymbolKind =
  | "class"
  | "function"
  | "property"
  | "event"
  | "variable"
  | "blueprint"
  | "asset"
  | "dataAsset"
  | "material"
  | "unknown";

export type ImplementationEvidenceSource =
  | "project-knowledge"
  | "project-graph"
  | "ue-cache"
  | "summary";

export interface KeySymbolRecord {
  name: string;
  kind: KeySymbolKind;
  path?: string;
  system?: string;
  source?: ImplementationEvidenceSource;
  evidence: string[];
}

export interface ReuseGuidanceRecord {
  summary: string;
  sourcePaths: string[];
  evidence: string[];
}

export interface ImplementationPatternRecord {
  id: string;
  name: string;
  systems: string[];
  summary: string;
  recommendedApproaches: string[];
  forbiddenApproaches: string[];
  reusableSymbols: KeySymbolRecord[];
  reusableBlueprints: string[];
  reusableAssets: string[];
  evidence: string[];
  sourcePaths: string[];
  sourceHash: string;
}

export interface ImplementationFeatureRecord {
  id: string;
  name: string;
  systems: string[];
  purpose: string;
  primaryCode: string[];
  primaryBlueprints: string[];
  primaryAssets: string[];
  keySymbols: KeySymbolRecord[];
  keyVariables: string[];
  keyEvents: string[];
  keyDataAssets: string[];
  implementationPattern: string[];
  extensionGuidance: ReuseGuidanceRecord[];
  forbiddenApproaches: string[];
  validationHints: string[];
  evidence: string[];
  sourcePaths: string[];
  sourceHash: string;
}

export interface ImplementationGraphLinkRecord {
  featureId: string;
  nodeIds: string[];
}

export interface ImplementationBlueprintLinkRecord {
  featureId: string;
  blueprints: string[];
}

export interface ImplementationAssetLinkRecord {
  featureId: string;
  assets: string[];
}

export interface ImplementationMemoryMap {
  schemaVersion: 1;
  projectId: string;
  runId: string;
  generatedAt: string;
  sourcePaths: string[];
  sourceHash: string;
  features: ImplementationFeatureRecord[];
  patterns: ImplementationPatternRecord[];
  keySymbols: KeySymbolRecord[];
  reuseGuidance: ReuseGuidanceRecord[];
  graphLinks: ImplementationGraphLinkRecord[];
  blueprintLinks: ImplementationBlueprintLinkRecord[];
  assetLinks: ImplementationAssetLinkRecord[];
  missingInformation: string[];
}

export interface CommandResult {
  command: string;
  projectId: string;
  phase: "skeleton" | "docs-index" | "graph-adapter";
  message: string;
  warnings: string[];
  data?: unknown;
}
