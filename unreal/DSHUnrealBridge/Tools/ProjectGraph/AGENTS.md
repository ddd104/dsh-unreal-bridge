# ProjectGraph tool scope

This directory is part of `Plugins/DSHUnrealBridge/Tools`, with shared dependencies under its `node_modules` and bundled Node under `Runtime/Win64`.

Read `../README.md` for the current runtime and cache contract. Build with the plugin Node and `Tools/build.mjs`; validate with `Tools/test.mjs`. All generated project data belongs below the plugin `Cache` directory.

Use Project Memory first for project tasks. Graph query results are navigation evidence, not proof of runtime behavior. AngelScript support is a lexical class/function/binding index, not a full parser.

Never directly edit `.uasset` or `.umap`. Use the plugin knowledge worker for coordinated graph and memory updates; it supplies project identity checks, a cross-process lock, and staged cache publication.
