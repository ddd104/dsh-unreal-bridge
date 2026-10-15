import { loadProjectConfig, type LoadProjectConfigOptions } from "../config/loadProjectConfig.js";
import { createProjectGraphClient } from "../graph/projectGraphClient.js";
import { buildMemoryContextPack } from "../retrieval/contextPackBuilder.js";
import type { ContextPackRequest } from "../types/contextPackTypes.js";
import type { CommandResult } from "../types/memoryTypes.js";

function parseRequest(input: string | ContextPackRequest): ContextPackRequest {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("memory context-pack requires non-empty <query>.");
  }
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as ContextPackRequest;
    if (!parsed.query?.trim()) throw new Error("memory context-pack JSON input requires non-empty query.");
    return parsed;
  }
  return { query: trimmed };
}

export async function getContextPack(input: string | ContextPackRequest, options: LoadProjectConfigOptions = {}): Promise<CommandResult> {
  const request = parseRequest(input);

  const loaded = await loadProjectConfig(options);
  const pack = await buildMemoryContextPack(request, {
    loaded,
    graphClient: createProjectGraphClient(loaded)
  });
  return {
    command: "memory context-pack",
    projectId: loaded.config.projectId,
    phase: "graph-adapter",
    message: "Project Memory context pack generated through the ProjectGraphClient adapter.",
    warnings: pack.missingInformation,
    data: pack
  };
}
