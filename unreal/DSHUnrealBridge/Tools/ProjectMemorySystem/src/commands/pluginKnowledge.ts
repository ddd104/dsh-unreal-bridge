import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 外部 MCP 与 UE 使用同一受锁保护的知识进程，统一缓存发布和项目身份检查。
export function updatePluginKnowledge(projectRoot: string): Record<string, unknown> {
  const toolsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const result = spawnSync(process.execPath, [path.join(toolsRoot, "knowledge-worker.mjs"), "--project", projectRoot, "--plugin", path.dirname(toolsRoot), "--once"], {
    input: JSON.stringify({id:"mcp-update",tool:"project_update",arguments:{}})+"\n", encoding:"utf8", windowsHide:true, timeout:300000, maxBuffer:1024*1024
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || "Knowledge worker failed.");
  const response = JSON.parse(result.stdout.trim());
  if (response.isError) throw new Error(response.result?.message || "Knowledge update failed.");
  return response.result as Record<string, unknown>;
}
