import { createSourceProvider } from "./sourceRegistry.js";

export const graphSource = createSourceProvider("graph", "Project graph snapshot", [".sqlite", ".jsonl"]);
