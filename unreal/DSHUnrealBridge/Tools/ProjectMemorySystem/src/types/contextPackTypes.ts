import type { GraphContextResult, GraphFeatureResult, GraphStatus } from "../graph/projectGraphClient.js";
import type {
  ImplementationFeatureRecord,
  KeySymbolRecord,
  MemorySearchResult,
  ReuseGuidanceRecord
} from "./memoryTypes.js";

export type ContextTaskType = "feature" | "bugfix" | "refactor" | "blueprint" | "material" | "asset" | "question";

export interface ContextPackBudget {
  maxDocs: number;
  maxSystems: number;
  maxPatterns: number;
  maxGraphNodes: number;
  maxFiles: number;
  maxBlueprints: number;
  maxAssets: number;
  maxImplementations: number;
  maxReusableSymbols: number;
}

export interface ContextPackRequest {
  query: string;
  taskType?: ContextTaskType;
  budget?: Partial<ContextPackBudget>;
}

export interface EvidenceItem {
  id: string;
  title: string;
  sourcePaths: string[];
  sourceHash?: string;
  excerpt?: string;
  score?: number;
  status?: string;
}

export interface OwningSystemContext {
  id?: string;
  title?: string;
  confidence: "none" | "low" | "medium" | "high";
  sourcePaths: string[];
  sourceHash?: string;
  evidence: string[];
}

export interface GraphContextPack {
  status: GraphStatus;
  feature: GraphFeatureResult;
  context: GraphContextResult;
}

export interface ContextPack {
  query: string;
  projectCapsule: string;
  owningSystem: OwningSystemContext;
  secondarySystems: EvidenceItem[];
  architectureRules: EvidenceItem[];
  relevantDocs: MemorySearchResult[];
  relevantImplementations: ImplementationFeatureRecord[];
  existingPatterns: EvidenceItem[];
  reusableSymbols: KeySymbolRecord[];
  reusableBlueprints: string[];
  reusableAssets: string[];
  graphContext: GraphContextPack;
  filesToRead: string[];
  blueprintsToRead: string[];
  assetsToInspect: string[];
  forbiddenApproaches: string[];
  extensionGuidance: ReuseGuidanceRecord[];
  validationPlan: EvidenceItem[];
  missingInformation: string[];
}

export type MemoryContextPack = ContextPack;

export const DEFAULT_CONTEXT_BUDGET: ContextPackBudget = {
  maxDocs: 8,
  maxSystems: 4,
  maxPatterns: 5,
  maxGraphNodes: 16,
  maxFiles: 12,
  maxBlueprints: 8,
  maxAssets: 8,
  maxImplementations: 5,
  maxReusableSymbols: 12
};

export function resolveContextBudget(budget?: Partial<ContextPackBudget>): ContextPackBudget {
  return {
    ...DEFAULT_CONTEXT_BUDGET,
    ...budget
  };
}
