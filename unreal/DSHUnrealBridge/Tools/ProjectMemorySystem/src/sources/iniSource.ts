import { createSourceProvider } from "./sourceRegistry.js";

export const iniSource = {
  ...createSourceProvider("ini", "INI", [".ini"]),
  parse: async (_filePath: string, content: Buffer) => ({
    sourceType: "ini",
    text: content.toString("utf8"),
    metadata: {}
  })
};
