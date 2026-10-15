#!/usr/bin/env node
import path from "node:path";
import { updatePluginKnowledge } from "./commands/pluginKnowledge.js";
import { loadProjectConfig } from "./config/loadProjectConfig.js";
import { getContextPack } from "./commands/getContextPack.js";
import { memoryStatus } from "./commands/memoryStatus.js";
import { queryMemory } from "./commands/queryMemory.js";
import type { CommandResult } from "./types/memoryTypes.js";

interface ParsedArgs {
  rootCommand: string;
  command: string;
  positional: string[];
  projectRoot?: string;
  configPath?: string;
  docsOnly?: boolean;
  capsule?: boolean;
  systems?: boolean;
  patterns?: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  memory status [--project <root>] [--config <path>]",
    "  memory build [--docs-only] [--capsule] [--systems] [--patterns] [--project <root>] [--config <path>]",
    "  memory update [--project <root>] [--config <path>]",
    "  memory query <text> [--project <root>] [--config <path>]",
    "  memory context-pack <query> [--project <root>] [--config <path>]"
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const [rootCommand = "", command = "", ...rest] = argv;
  const positional: string[] = [];
  let projectRoot: string | undefined;
  let configPath: string | undefined;
  let docsOnly = false;
  let capsule = false;
  let systems = false;
  let patterns = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--project") {
      projectRoot = path.resolve(rest[++index] ?? "");
    } else if (arg === "--config") {
      configPath = path.resolve(rest[++index] ?? "");
    } else if (arg === "--docs-only") {
      docsOnly = true;
    } else if (arg === "--capsule") {
      capsule = true;
    } else if (arg === "--systems") {
      systems = true;
    } else if (arg === "--patterns") {
      patterns = true;
    } else {
      positional.push(arg);
    }
  }

  return { rootCommand, command, positional, projectRoot, configPath, docsOnly, capsule, systems, patterns };
}

function printResult(result: CommandResult): void {
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.rootCommand || args.rootCommand === "--help" || args.rootCommand === "-h") {
    console.log(usage());
    return;
  }

  if (args.rootCommand !== "memory") {
    throw new Error(`Unknown root command: ${args.rootCommand}\n${usage()}`);
  }

  const options = {
    projectRoot: args.projectRoot,
    configPath: args.configPath
  };

  if (args.command === "status") {
    printResult(await memoryStatus(options));
    return;
  }

  if (args.command === "build" || args.command === "update") {
    // CLI 也由插件知识进程协调图谱和记忆，避免多个入口同时覆盖缓存。
    const loaded = await loadProjectConfig(options);
    const result = updatePluginKnowledge(loaded.projectRoot);
    printResult({command:`memory ${args.command}`,projectId:loaded.config.projectId,phase:"docs-index",message:"Plugin graph and memory caches refreshed.",warnings:result.warnings as string[] ?? [],data:result});
    return;
  }

  if (args.command === "query") {
    printResult(await queryMemory(args.positional.join(" "), options));
    return;
  }

  if (args.command === "context-pack") {
    printResult(await getContextPack(args.positional.join(" "), options));
    return;
  }

  throw new Error(`Unknown memory command: ${args.command || "(missing)"}\n${usage()}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
