import { createSourceProvider } from "./sourceRegistry.js";

export const textSource = {
  ...createSourceProvider("text", "Plain text and protobuf schema", [".txt", ".proto"]),
  parse: async (_filePath: string, content: Buffer) => {
    const text = content.toString("utf8");
    const title = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return {
      sourceType: "text",
      title,
      text,
      metadata: {}
    };
  }
};
