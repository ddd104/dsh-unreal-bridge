---
name: ue-project-graph
description: Use project documentation, source indexes, graph relationships, and live Unreal Editor evidence to investigate cross-file UE features and change impact. Skip indexing for a small local task with enough context.
---

# UE project context

Use the project's own instructions first. Treat indexed graph nodes and memory summaries as navigation hints. Confirm conclusions in current source, assets, or running objects.

## Choose an entry

- If the DSH Unreal Bridge is connected, bind the correct editor with `unreal_state` and `unreal_bind`. Use `unreal_knowledge` for project status, context, source search, graph candidates, and cached asset snapshots. Use the discovered UE MCP asset tools for current editor state and asset changes.
- If another project knowledge provider is available, inspect its status and tool schema before using it. Do not assume a C++ service, skill file, or MCP server is connected merely because its files exist.
- If no knowledge provider is connected, search the project's source, configuration, and documentation directly. Use available editor tools for assets. State which evidence is unavailable.

## Check the index

Read `project_status` before relying on stored context. Verify that the `.uproject` identity matches, source hashes are current, and warnings or coverage limits are understood. An absent or stale hit does not show that a feature is absent.

Keep authored project facts in a project documentation directory such as `ProjectKnowledge/`; keep generated graph, memory, and asset snapshots in the plugin cache. The configured documentation roots and supported formats determine what is indexed. This package reads text, Markdown, JSON, CSV, YAML, INI, protobuf schemas, DOCX, XLSX, and legacy XLS. Proto messages, fields, enums, and RPCs are indexed with their source text; XLS sheet names and cell values are indexed. PDF needs conversion before indexing.

When the index needs an update, use the editor's **更新项目图谱与知识记忆** command. It captures registered assets before rebuilding graph and memory. Rebuild only when the task needs fresh project-wide context; normal queries should not trigger full scans.

## Investigate and change

Start with `project_context` or `project_search` for a broad task. Use `graph_feature` and `graph_query` for candidate files, symbols, and systems; use `graph_impact(nodeId)` for neighboring dependencies. The first ranked owning system and graph risk level are candidates, not verified ownership or runtime risk.

Read relevant source with `read_source`, preserving the returned path and hash; use `validate_evidence` if the task continues after files may have changed. For assets, inspect a valid cached snapshot first, then check live UE state when current values matter. Honor pagination, truncation, `partial` or `opaque` coverage, failed scans, and excluded packages.

Implement against verified current files and UE objects. Use the actual editor's supported preview, apply, and save flow for asset changes. Choose compile and editor verification based on the affected behavior.

Save reusable conclusions only when useful for later work. If available, `unreal_knowledge_record` accepts `remember_evidence` with current source path/hash pairs, or experience save/feedback with the worker's validated schema. These records remain inferred evidence and never replace live verification.

