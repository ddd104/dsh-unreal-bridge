import { createSourceProvider } from "./sourceRegistry.js";

export const csvSource = {
  ...createSourceProvider("csv", "CSV/TSV", [".csv", ".tsv"]),
  parse: async (filePath: string, content: Buffer) => {
    const text = content.toString("utf8");
    const rows = text.split(/\r?\n/).filter((line) => line.trim());
    const delimiter = filePath.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    return {
      sourceType: filePath.toLowerCase().endsWith(".tsv") ? "tsv" : "csv",
      title: rows[0],
      text,
      metadata: {
        rows: rows.length,
        delimiter
      }
    };
  }
};
