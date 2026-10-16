# ProjectMemorySystem

This package indexes authored project documents and builds memory summaries. Its compiled commands are used by the private knowledge worker; the Agent-facing entry is DSH `unreal_knowledge`.

Keep source documents in project documentation roots such as `ProjectKnowledge/`. The supported formats are Markdown, text, protobuf schema, JSON, CSV/TSV, YAML, INI, DOCX, XLSX, and legacy XLS. Protobuf schemas are parsed into message, field, enum, and RPC declarations while retaining the source text. XLS worksheets are indexed by sheet name and cell value. Imported protobuf files are listed but are not resolved during document indexing. Convert PDF to a supported format before indexing. Generated summaries and indexes belong in the plugin Cache.

