import { createSourceProvider } from "./sourceRegistry.js";

export const jsonSource = {
  ...createSourceProvider("json", "JSON/JSONL", [".json", ".jsonl"]),
  parse: async (filePath: string, content: Buffer) => {
    const raw = content.toString("utf8");
    const isJsonl = filePath.toLowerCase().endsWith(".jsonl");
    let text = raw;
    const metadata: Record<string, unknown> = {};

    if (isJsonl) {
      const lines = raw.split(/\r?\n/).filter((line) => line.trim());
      metadata.records = lines.length;
      text = lines
        .map((line) => {
          try {
            return JSON.stringify(JSON.parse(line), null, 2);
          } catch {
            return line;
          }
        })
        .join("\n");
    } else {
      try {
        const parsed = JSON.parse(raw);
        text = JSON.stringify(parsed, null, 2);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const title = (parsed as Record<string, unknown>).title;
          if (typeof title === "string") metadata.title = title;
        }
      } catch {
        metadata.parseWarning = "Invalid JSON; indexed as raw text.";
      }
    }

    return {
      sourceType: isJsonl ? "jsonl" : "json",
      title: typeof metadata.title === "string" ? metadata.title : undefined,
      text,
      metadata
    };
  }
};
