import { createSourceProvider } from "./sourceRegistry.js";

export const markdownSource = {
  ...createSourceProvider("markdown", "Markdown", [".md", ".markdown"]),
  parse: async (_filePath: string, content: Buffer) => {
    const text = content.toString("utf8");
    const heading = text.split(/\r?\n/).find((line) => /^#\s+/.test(line));
    return {
      sourceType: "markdown",
      title: heading?.replace(/^#\s+/, "").trim(),
      text,
      metadata: {}
    };
  }
};
