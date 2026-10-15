import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildContextPack } from "../src/graph/contextPack.js";
import { GraphStore } from "../src/graph/graphStore.js";
import { indexCppFile } from "../src/indexers/cppIndexer.js";

test("contextPack returns files around a class", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "project-graph-"));
  const relativePath = "Source/Test/Public/MyActor.h";
  const fullPath = path.join(projectRoot, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, "UCLASS()\nclass AMyActor {}\n", "utf8");

  try {
    const store = new GraphStore();
    indexCppFile(
      {
        relativePath,
        system: "Test",
        content: "UCLASS()\nclass AMyActor {}\n"
      },
      store
    );

    const classNode = store.nodes().find((node) => node.type === "Class" && node.name === "AMyActor");
    assert.ok(classNode);

    const pack = await buildContextPack(store, classNode.id, { projectRoot, depth: 1 });
    assert.equal(pack.root.id, classNode.id);
    assert.ok(pack.files.some((file) => file.path === relativePath));
    assert.ok(pack.nodes.some((node) => node.type === "File" && node.path === relativePath));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
