import { readdir, readFile, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { toProjectPath } from "../graph/graphStore.js";

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  system: string;
  language: string;
  kind: "cpp" | "build" | "config" | "script" | "other";
}

const SKIP_DIRS = new Set([
  ".git",
  ".codex",
  ".agents",
  "Runtime",
  "Cache",
  "generated",
  ".idea",
  ".vs",
  ".vscode",
  "Binaries",
  "Intermediate",
  "DerivedDataCache",
  "Saved",
  "ArchivedBuilds",
  "Releases",
  "Build",
  "node_modules",
  "dist"
]);

const CPP_EXTENSIONS = new Set([".h", ".hh", ".hpp", ".inl", ".c", ".cc", ".cpp", ".cxx"]);
const SCRIPT_EXTENSIONS = new Set([".as", ".js", ".mjs", ".ts"]);

function isBuildFile(fileName: string): boolean {
  return fileName.endsWith(".Build.cs") || fileName.endsWith(".Target.cs");
}

function detectKind(fileName: string): ScannedFile["kind"] | undefined {
  if (isBuildFile(fileName)) return "build";
  const extension = path.extname(fileName).toLowerCase();
  if (CPP_EXTENSIONS.has(extension)) return "cpp";
  if (extension === ".ini") return "config";
  if (SCRIPT_EXTENSIONS.has(extension)) return "script";
  return undefined;
}

function detectLanguage(kind: ScannedFile["kind"], fileName: string): string {
  if (kind === "cpp") return "Cpp";
  if (kind === "build") return "CSharp";
  if (kind === "config") return "Config";
  if (kind === "script") {
    const extension = path.extname(fileName).toLowerCase();
    if (extension === ".ts") return "TypeScript";
    if (extension === ".js" || extension === ".mjs") return "JavaScript";
    return "AngelScript";
  }
  return path.extname(fileName).replace(/^\./, "") || "Unknown";
}

export function detectSystem(relativePath: string): string {
  const parts = toProjectPath(relativePath).split("/");
  if (parts[0] === "Source" && parts[1]) {
    return parts[1];
  }
  if (parts[0] === "Plugins" && parts[1]) {
    if (parts[2] === "Source" && parts[3]) {
      return `${parts[1]}/${parts[3]}`;
    }
    return parts[1];
  }
  if (parts[0] === "AgentTools" && parts[1]) {
    if (parts[2] === "ProjectGraph") {
      return `${parts[1]}/ProjectGraph`;
    }
    if (parts[2] === "mcp-server") {
      return `${parts[1]}/mcp-server`;
    }
    return parts[1];
  }
  if (parts[0] === "Config") {
    return "Config";
  }
  if (parts[0] === "Script") {
    return parts[1] ? `Script/${parts[1]}` : "Script";
  }
  return "Project";
}

function shouldSkipFile(fileName: string): boolean {
  return fileName.startsWith("Binds.Cache") || fileName.endsWith(".uasset") || fileName.endsWith(".umap");
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

async function walk(projectRoot: string, directory: string, out: ScannedFile[]): Promise<void> {
  // 根目录也可能是 Windows junction，不能沿链接索引项目外的源码。
  const resolved = await realpath(directory);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || resolved.toLowerCase() !== path.resolve(directory).toLowerCase()) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walk(projectRoot, path.join(directory, entry.name), out);
      continue;
    }

    if (!entry.isFile() || shouldSkipFile(entry.name)) {
      continue;
    }

    const kind = detectKind(entry.name);
    if (!kind) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    const relativePath = toProjectPath(path.relative(projectRoot, absolutePath));
    out.push({
      absolutePath,
      relativePath,
      system: detectSystem(relativePath),
      language: detectLanguage(kind, entry.name),
      kind
    });
  }
}

export async function scanProjectFiles(projectRoot: string): Promise<ScannedFile[]> {
  const roots: string[] = [];
  for (const rootName of ["Source", "Config", "Script"]) {
    const root = path.join(projectRoot, rootName);
    if (await pathExists(root)) {
      roots.push(root);
    }
  }

  const pluginsRoot = path.join(projectRoot, "Plugins");
  if (await pathExists(pluginsRoot)) {
    const plugins = await readdir(pluginsRoot, { withFileTypes: true });
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const sourceRoot = path.join(pluginsRoot, plugin.name, "Source");
      if (await pathExists(sourceRoot)) {
        roots.push(sourceRoot);
      }
    }
  }

  const agentToolsRoot = path.join(projectRoot, "AgentTools");
  if (await pathExists(agentToolsRoot)) {
    const tools = await readdir(agentToolsRoot, { withFileTypes: true });
    for (const tool of tools) {
      if (!tool.isDirectory()) continue;

      const toolRoot = path.join(agentToolsRoot, tool.name);
      for (const scriptRootName of ["mcp-server", "ProjectGraph/src"]) {
        const scriptRoot = path.join(toolRoot, scriptRootName);
        if (await pathExists(scriptRoot)) {
          roots.push(scriptRoot);
        }
      }
    }
  }

  const files: ScannedFile[] = [];
  for (const root of roots) {
    await walk(projectRoot, root, files);
  }

  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export async function readScannedFile(file: ScannedFile): Promise<string> {
  return readFile(file.absolutePath, "utf8");
}
