import { summarizeUeCacheContent } from "../summarizers/ueAssetSummarizer.js";
import type { SourceProvider } from "./sourceRegistry.js";

export const ueCacheSource: SourceProvider = {
  id: "ue-cache",
  label: "UE cache",
  extensions: [".json", ".jsonl"],
  phase: "docs-index",
  describe: () => "UE cache source provider for read-only Blueprint, asset registry, and material summaries.",
  parse: async (filePath, content) => {
    const summary = summarizeUeCacheContent(filePath, content);
    return {
      sourceType: `ue-cache-${summary.kind}`,
      title: summary.title,
      text: summary.text,
      metadata: summary.metadata
    };
  }
};
