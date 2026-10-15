import { createFileNode, symbolNodeId } from "../graph/graphStore.js";
import type { GraphStore } from "../graph/graphStore.js";

export interface ConfigIndexInput {
  relativePath: string;
  content: string;
  system: string;
}

export function indexConfigFile(input: ConfigIndexInput, store: GraphStore): void {
  const fileNode = store.addNode(createFileNode(input.relativePath, input.system, "Config", `UE config ${input.relativePath}`));
  const lines = input.content.split(/\r?\n/);
  let currentSectionId: string | undefined;
  let currentSection = "";

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]?.trim() ?? "";
    if (!line || line.startsWith(";") || line.startsWith("#")) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      const sectionNode = store.addNode({
        id: symbolNodeId("Config", currentSection, `${input.relativePath}:${lineNumber}`),
        type: "Config",
        name: currentSection,
        path: input.relativePath,
        system: input.system,
        language: "Config",
        summary: `Config section [${currentSection}]`,
        metadata: { section: currentSection, line: lineNumber }
      });
      currentSectionId = sectionNode.id;
      store.addEdge({ from: fileNode.id, to: sectionNode.id, type: "DECLARES", metadata: { line: lineNumber } });
      continue;
    }

    const keyMatch = line.match(/^([^=]+)=(.*)$/);
    if (keyMatch && currentSectionId) {
      const key = keyMatch[1].trim();
      const value = keyMatch[2].trim();
      const keyName = `${currentSection}.${key}`;
      const keyNode = store.addNode({
        id: symbolNodeId("Config", keyName, `${input.relativePath}:${lineNumber}`),
        type: "Config",
        name: keyName,
        path: input.relativePath,
        system: input.system,
        language: "Config",
        summary: `Config key ${keyName}`,
        metadata: {
          section: currentSection,
          key,
          valuePreview: value.slice(0, 200),
          line: lineNumber
        }
      });
      store.addEdge({ from: currentSectionId, to: keyNode.id, type: "CONTAINS", metadata: { line: lineNumber } });
      store.addEdge({ from: fileNode.id, to: keyNode.id, type: "DECLARES", metadata: { line: lineNumber } });
    }
  }
}
