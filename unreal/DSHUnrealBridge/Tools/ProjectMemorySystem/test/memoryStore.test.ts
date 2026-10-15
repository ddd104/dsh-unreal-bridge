import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildMemory } from "../src/commands/buildMemory.js";
import { memoryStatus } from "../src/commands/memoryStatus.js";
import { updateMemory } from "../src/commands/updateMemory.js";
import { createEmptyManifest } from "../src/memory/manifest.js";
import { MemoryStore } from "../src/memory/memoryStore.js";

async function createStatusFixtureProject(): Promise<{ projectRoot: string; markdownPath: string }> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "project-memory-status-"));
  await mkdir(path.join(projectRoot, "AgentTools", "ProjectMemorySystem"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge"), { recursive: true });
  await writeFile(path.join(projectRoot, "fixture.uproject"), "{}", "utf8");
  const markdownPath = path.join(projectRoot, "ProjectKnowledge", "sample.md");
  await writeFile(markdownPath, "# Sample\n\nalpha-status\n", "utf8");
  await writeFile(
    path.join(projectRoot, "AgentTools", "ProjectMemorySystem", "ProjectMemory.project.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        projectId: "status-fixture",
        knowledgeRoots: ["ProjectKnowledge"],
        memoryOutputRoot: ".ai/project-memory",
        sourcePolicy: {
          includeExtensions: [".md"],
          includePatterns: ["ProjectKnowledge/**"],
          excludePatterns: ["**/*.uasset"]
        },
        graph: {
          enabled: false,
          mode: "sqlite"
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return { projectRoot, markdownPath };
}

test("MemoryStore reports missing manifest and can write one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-memory-store-"));
  try {
    const store = new MemoryStore(root);
    assert.equal(await store.readManifest(), null);

    await store.writeManifest(createEmptyManifest("fixture"));
    const manifest = await store.readManifest();
    assert.equal(manifest?.projectId, "fixture");
    const status = await store.status();
    assert.ok("hasManifest" in status);
    assert.equal(status.hasManifest, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory status becomes stale_sources after markdown edit and fresh after update", async () => {
  const fixture = await createStatusFixtureProject();
  await buildMemory({ projectRoot: fixture.projectRoot, docsOnly: true });

  const fresh = await memoryStatus({ projectRoot: fixture.projectRoot });
  assert.equal((fresh.data as { memory: { status: string } }).memory.status, "fresh");

  await writeFile(fixture.markdownPath, "# Sample\n\nalpha-status changed\n", "utf8");
  const stale = await memoryStatus({ projectRoot: fixture.projectRoot });
  assert.equal((stale.data as { memory: { status: string } }).memory.status, "stale_sources");

  const update = await updateMemory({ projectRoot: fixture.projectRoot });
  const updateData = update.data as { changedSources: string[]; unchangedSources: string[] };
  assert.deepEqual(updateData.changedSources, ["ProjectKnowledge/sample.md"]);
  assert.deepEqual(updateData.unchangedSources, []);

  const refreshed = await memoryStatus({ projectRoot: fixture.projectRoot });
  assert.equal((refreshed.data as { memory: { status: string } }).memory.status, "fresh");
});
