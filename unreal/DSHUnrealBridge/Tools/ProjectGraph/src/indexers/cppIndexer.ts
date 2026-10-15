import { createFileNode, fileNodeId, symbolNodeId } from "../graph/graphStore.js";
import type { GraphStore } from "../graph/graphStore.js";
import type { NodeRecord, NodeType } from "../graph/schema.js";

export interface CppIndexInput {
  relativePath: string;
  content: string;
  system: string;
  language?: string;
}

interface Scope {
  nodeId: string;
  name: string;
  depth: number;
}

function addSymbolNode(
  store: GraphStore,
  type: NodeType,
  name: string,
  input: CppIndexInput,
  line: number,
  metadata: Record<string, unknown> = {}
): NodeRecord {
  return store.addNode({
    id: symbolNodeId(type, name, `${input.relativePath}:${line}`),
    type,
    name,
    path: input.relativePath,
    system: input.system,
    language: input.language ?? "Cpp",
    summary: `${type} ${name} declared in ${input.relativePath}`,
    metadata: {
      line,
      confidence: "heuristic",
      ...metadata
    }
  });
}

function addExternalClass(store: GraphStore, name: string): NodeRecord {
  return store.addNode({
    id: symbolNodeId("Class", name, "external"),
    type: "Class",
    name,
    path: "",
    system: "External",
    language: "Cpp",
    summary: `Referenced external class ${name}`,
    metadata: { confidence: "reference" }
  });
}

function parseFunctionName(signature: string): string | undefined {
  const cleaned = signature
    .replace(/\bUFUNCTION\s*\([^)]*\)/g, " ")
    .replace(/\/\/.*$/, " ")
    .replace(/=\s*0\s*;?$/, " ")
    .trim();
  const match = cleaned.match(/\b(?:virtual\s+|static\s+|inline\s+|FORCEINLINE\s+|constexpr\s+)*[\w:<>~,*&\s]+\s+([A-Za-z_]\w*)\s*\(/);
  const name = match?.[1];
  if (!name || ["if", "for", "while", "switch", "return"].includes(name)) {
    return undefined;
  }
  return name;
}

function parsePropertyName(declaration: string): string | undefined {
  const cleaned = declaration
    .replace(/\bUPROPERTY\s*\([^)]*\)/g, " ")
    .replace(/\/\/.*$/, " ")
    .split(";")[0]
    .split("=")[0]
    .trim();
  const tokens = cleaned.match(/[A-Za-z_]\w*/g);
  return tokens?.at(-1);
}

function countChar(value: string, char: string): number {
  return [...value].filter((current) => current === char).length;
}

function addCallNode(store: GraphStore, fileId: string, name: string, line: number): void {
  const callNode = store.addNode({
    id: symbolNodeId("Function", name, "UnrealRuntime"),
    type: "Function",
    name,
    path: "",
    system: "Unreal",
    language: "Cpp",
    summary: `Unreal runtime helper ${name}`,
    metadata: { confidence: "builtin" }
  });
  store.addEdge({
    from: fileId,
    to: callNode.id,
    type: "CALLS",
    metadata: { line, confidence: "heuristic" }
  });
}

function addAssetReference(store: GraphStore, fileId: string, assetPath: string, line: number): void {
  const assetNode = store.addNode({
    id: symbolNodeId("Asset", assetPath, "asset-reference"),
    type: "Asset",
    name: assetPath.split("/").filter(Boolean).at(-1) ?? assetPath,
    path: assetPath,
    system: "Content",
    language: "UnrealAsset",
    summary: `Referenced asset ${assetPath}`,
    metadata: { confidence: "string-literal" }
  });
  store.addEdge({
    from: fileId,
    to: assetNode.id,
    type: "REFERENCES_ASSET",
    metadata: { line, confidence: "heuristic" }
  });
}

export function indexCppFile(input: CppIndexInput, store: GraphStore): void {
  const fileNode = store.addNode(createFileNode(input.relativePath, input.system, input.language ?? "Cpp"));
  const fileId = fileNode.id;
  const lines = input.content.split(/\r?\n/);
  let braceDepth = 0;
  let pendingMacro: "UCLASS" | "USTRUCT" | "UENUM" | undefined;
  let pendingFunction = false;
  let pendingProperty = false;
  let pendingScope: Pick<Scope, "nodeId" | "name"> | undefined;
  const scopes: Scope[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index] ?? "";
    const line = rawLine.replace(/\/\*.*?\*\//g, " ");

    while (scopes.length > 0 && braceDepth < scopes[scopes.length - 1].depth) {
      scopes.pop();
    }
    const currentScope = scopes.at(-1);

    const includeMatch = line.match(/^\s*#\s*include\s+[<"]([^>"]+)[>"]/);
    if (includeMatch) {
      const includeName = includeMatch[1];
      const includeNode = store.addNode({
        id: fileNodeId(`include:${includeName}`),
        type: "File",
        name: includeName.split(/[\\/]/).at(-1) ?? includeName,
        path: includeName,
        system: "External",
        language: "Cpp",
        summary: `Included header ${includeName}`,
        metadata: { confidence: "include" }
      });
      store.addEdge({ from: fileId, to: includeNode.id, type: "INCLUDES", metadata: { line: lineNumber } });
    }

    if (/\bUCLASS\b/.test(line)) pendingMacro = "UCLASS";
    if (/\bUSTRUCT\b/.test(line)) pendingMacro = "USTRUCT";
    if (/\bUENUM\b/.test(line)) pendingMacro = "UENUM";
    if (/\bUFUNCTION\b/.test(line)) pendingFunction = true;
    if (/\bUPROPERTY\b/.test(line)) pendingProperty = true;

    const enumMatch = line.match(/\benum\s+(?:class\s+)?([A-Za-z_]\w*)/);
    if (enumMatch && (pendingMacro === "UENUM" || line.includes("{"))) {
      const enumNode = addSymbolNode(store, "Enum", enumMatch[1], input, lineNumber, { ueMacro: pendingMacro });
      store.addEdge({ from: fileId, to: enumNode.id, type: "DECLARES", metadata: { line: lineNumber } });
      pendingMacro = undefined;
    }

    const typeMatch = line.match(/\b(class|struct)\s+(?:[A-Z0-9_]+_API\s+)?([A-Za-z_]\w*)\b(?:[^:{;]*:\s*public\s+([A-Za-z_][\w:]*))?/);
    if (typeMatch && (pendingMacro || line.includes("{") || !line.trim().endsWith(";"))) {
      const keyword = typeMatch[1];
      const name = typeMatch[2];
      const base = typeMatch[3];
      const nodeType: NodeType = pendingMacro === "USTRUCT" || keyword === "struct" ? "Struct" : "Class";
      const typeNode = addSymbolNode(store, nodeType, name, input, lineNumber, { ueMacro: pendingMacro });
      store.addEdge({ from: fileId, to: typeNode.id, type: "DECLARES", metadata: { line: lineNumber } });
      if (base) {
        const baseNode = addExternalClass(store, base);
        store.addEdge({ from: typeNode.id, to: baseNode.id, type: "INHERITS", metadata: { line: lineNumber } });
      }
      pendingScope = { nodeId: typeNode.id, name };
      pendingMacro = undefined;
    }

    if (pendingFunction) {
      const name = parseFunctionName(line);
      if (name) {
        const functionNode = addSymbolNode(store, "Function", name, input, lineNumber, {
          owner: currentScope?.name,
          ueMacro: "UFUNCTION"
        });
        store.addEdge({ from: fileId, to: functionNode.id, type: "DECLARES", metadata: { line: lineNumber } });
        if (currentScope) {
          store.addEdge({ from: currentScope.nodeId, to: functionNode.id, type: "CONTAINS", metadata: { line: lineNumber } });
        }
        pendingFunction = false;
      }
    }

    if (pendingProperty) {
      const name = parsePropertyName(line);
      if (name) {
        const propertyNode = addSymbolNode(store, "Property", name, input, lineNumber, {
          owner: currentScope?.name,
          ueMacro: "UPROPERTY"
        });
        store.addEdge({ from: fileId, to: propertyNode.id, type: "DECLARES", metadata: { line: lineNumber } });
        if (currentScope) {
          store.addEdge({ from: currentScope.nodeId, to: propertyNode.id, type: "HAS_PROPERTY", metadata: { line: lineNumber } });
        }
        pendingProperty = false;
      }
    }

    if (/\bSpawnActor\s*</.test(line)) addCallNode(store, fileId, "SpawnActor", lineNumber);
    if (/\bLoadObject\s*</.test(line)) addCallNode(store, fileId, "LoadObject", lineNumber);
    if (/\bLoadClass\s*</.test(line)) addCallNode(store, fileId, "LoadClass", lineNumber);
    if (/\bConstructorHelpers::F(?:Class|Object)Finder\s*</.test(line)) {
      addCallNode(store, fileId, "ConstructorHelpers", lineNumber);
    }

    const assetRegex = /(?:TEXT\s*\(\s*)?["']([^"']*(?:\/Game|\/Script)[^"']*)["']\s*\)?/g;
    for (const match of line.matchAll(assetRegex)) {
      addAssetReference(store, fileId, match[1], lineNumber);
    }

    const opens = countChar(line, "{");
    const closes = countChar(line, "}");
    braceDepth += opens - closes;
    if (pendingScope && opens > 0) {
      scopes.push({ ...pendingScope, depth: braceDepth });
      pendingScope = undefined;
    }
  }
}
