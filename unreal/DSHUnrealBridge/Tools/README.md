# Project knowledge worker

`knowledge-worker.mjs` is the private worker for the `DSHUnrealBridgeKnowledge` editor module. DSH exposes its read-only queries through `unreal_knowledge` on the already bound editor connection. No separate Graph or Memory MCP process or HTTP port is needed.

The worker combines the ProjectGraph source and UE snapshot index with ProjectMemorySystem document memory. `scripts/prepare-knowledge.ps1` in the repository pins and verifies Node.js 24.15.0, installs build dependencies, and compiles the TypeScript tools. The installer copies the runtime and compiled `dist` folders into the UE plugin; `node_modules` is only a build dependency.

Author project information under `ProjectKnowledge/` or another configured knowledge root in the UE project. The plugin's `Config/Knowledge/ProjectMemory.project.json` defines indexed roots and formats. Generated identity, graph, memory, evidence, and UE snapshots live under `Plugins/DSHUnrealBridge/Cache/` and should not be treated as authored documentation.

For development, run `Runtime/Win64/node.exe Tools/test.mjs` from this plugin directory after preparing the tools.

