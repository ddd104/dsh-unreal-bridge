#!/usr/bin/env node
import path from "node:path";
import { analyzeImpact } from "./graph/impactAnalysis.js";
import { GraphStore } from "./graph/graphStore.js";
import { updatePluginKnowledge } from "./commands/pluginKnowledge.js";
import { findFeatureContext } from "./commands/findFeatureContext.js";
import { getContextPack } from "./commands/getContextPack.js";
import { queryGraph } from "./commands/queryGraph.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  projectRoot: string;
  graphDir?: string;
  limit?: number;
  depth?: number;
  includeUeCache?: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  project-graph build [--project <root>] [--graph-dir <dir>] [--include-ue-cache]",
    "  project-graph query <text> [--project <root>] [--limit <n>]",
    "  project-graph find-feature <text> [--project <root>] [--limit <n>]",
    "  project-graph context-pack <nodeId> [--project <root>] [--depth <n>]",
    "  project-graph impact <nodeId> [--project <root>]"
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  let projectRoot = process.cwd();
  let graphDir: string | undefined;
  let limit: number | undefined;
  let depth: number | undefined;
  let includeUeCache = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--project") {
      projectRoot = path.resolve(rest[++index] ?? projectRoot);
    } else if (arg === "--graph-dir") {
      graphDir = rest[++index];
    } else if (arg === "--limit") {
      limit = Number.parseInt(rest[++index] ?? "", 10);
    } else if (arg === "--depth") {
      depth = Number.parseInt(rest[++index] ?? "", 10);
    } else if (arg === "--include-ue-cache") {
      includeUeCache = true;
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, projectRoot, graphDir, limit, depth, includeUeCache };
}

async function loadStore(projectRoot: string, graphDir?: string): Promise<GraphStore> {
  return GraphStore.loadJsonl(path.resolve(projectRoot, graphDir ?? "Plugins/DSHUnrealBridge/Cache/Graph"));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "--help" || args.command === "-h") {
    console.log(usage());
    return;
  }

  if (args.command === "build") {
    // CLI 与编辑器统一缓存边界和发布事务；不允许把运行数据写回旧目录。
    if (args.graphDir && path.resolve(args.projectRoot,args.graphDir) !== path.resolve(args.projectRoot,"Plugins/DSHUnrealBridge/Cache/Graph")) {
      throw new Error("Graph output must remain in Plugins/DSHUnrealBridge/Cache/Graph.");
    }
    const result = updatePluginKnowledge(args.projectRoot);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "query") {
    const text = args.positional.join(" ");
    if (!text) throw new Error("query requires text");
    const results = await queryGraph(text, {
      projectRoot: args.projectRoot,
      graphDir: args.graphDir,
      limit: args.limit
    });
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (args.command === "find-feature") {
    const text = args.positional.join(" ");
    if (!text) throw new Error("find-feature requires text");
    const result = await findFeatureContext(text, {
      projectRoot: args.projectRoot,
      graphDir: args.graphDir,
      limit: args.limit
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "context-pack") {
    const nodeId = args.positional[0];
    if (!nodeId) throw new Error("context-pack requires nodeId");
    const result = await getContextPack(nodeId, {
      projectRoot: args.projectRoot,
      graphDir: args.graphDir,
      depth: args.depth
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "impact") {
    const nodeId = args.positional[0];
    if (!nodeId) throw new Error("impact requires nodeId");
    const store = await loadStore(args.projectRoot, args.graphDir);
    console.log(JSON.stringify(analyzeImpact(store, nodeId), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${args.command}\n${usage()}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
