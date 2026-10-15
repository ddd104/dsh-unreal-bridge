import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildMemory } from "../src/commands/buildMemory.js";

async function createSummaryFixtureProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "project-memory-summary-"));
  await mkdir(path.join(projectRoot, "AgentTools", "ProjectMemorySystem"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "overview"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "architecture"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "systems"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "patterns"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "validation"), { recursive: true });
  await writeFile(path.join(projectRoot, "fixture.uproject"), "{}", "utf8");
  await writeFile(
    path.join(projectRoot, "AgentTools", "ProjectMemorySystem", "ProjectMemory.project.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        projectId: "summary-fixture",
        knowledgeRoots: ["ProjectKnowledge"],
        memoryOutputRoot: ".ai/project-memory",
        sourcePolicy: {
          includeExtensions: [".md", ".json"],
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
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "overview", "project_purpose.md"),
    "# Fixture Project\n\n- Core purpose: provide phase six summary evidence.\n",
    "utf8"
  );
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "architecture", "architecture_rules.md"),
    "# Fixture Rules\n\n- Runtime code must stay separate from generated memory cache.\n",
    "utf8"
  );
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "systems", "lighting.md"),
    "# Lighting System\n\n- Responsibility: controls scene lighting state.\n",
    "utf8"
  );
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "systems", "README.md"),
    "# Systems\n\n当前文件只提供模板。\n\n- 项目背景：待填写\n",
    "utf8"
  );
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "patterns", "cache-pattern.md"),
    "# Cache Pattern\n\n- Recommended: write derived files under memoryOutputRoot.\n",
    "utf8"
  );
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "patterns", "README.md"),
    "# Patterns\n\n当前文件只提供模板。\n\n- 项目背景：待填写\n",
    "utf8"
  );
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "validation", "build_commands.json"),
    `${JSON.stringify({ commands: [{ id: "quick", command: "echo ok" }] }, null, 2)}\n`,
    "utf8"
  );
  return projectRoot;
}

test("buildMemory generates capsule, system, pattern, architecture, and validation caches", async () => {
  const projectRoot = await createSummaryFixtureProject();
  const result = await buildMemory({ projectRoot });
  assert.equal(result.phase, "docs-index");

  const outputRoot = path.join(projectRoot, ".ai", "project-memory");
  const capsule = await readFile(path.join(outputRoot, "project_capsule.md"), "utf8");
  const architecture = await readFile(path.join(outputRoot, "architecture_rules.md"), "utf8");
  const systemMap = JSON.parse(await readFile(path.join(outputRoot, "system_map.json"), "utf8")) as { sourcePaths: string[]; sourceHash: string; systems: unknown[] };
  const systemSummary = await readFile(path.join(outputRoot, "summaries", "systems", "lighting.md"), "utf8");
  const patterns = await readFile(path.join(outputRoot, "patterns", "patterns.jsonl"), "utf8");
  const validation = JSON.parse(await readFile(path.join(outputRoot, "validation", "build_commands.json"), "utf8")) as { sourcePaths: string[]; sourceHash: string };

  assert.match(capsule, /sourcePaths:/);
  assert.match(capsule, /sourceHash:/);
  assert.match(capsule, /Core purpose/);
  assert.match(architecture, /sourceHash:/);
  assert.equal(systemMap.systems.length, 1);
  assert.deepEqual(systemMap.sourcePaths, ["ProjectKnowledge/systems/lighting.md"]);
  assert.ok(systemMap.sourceHash.length > 0);
  assert.match(systemSummary, /sourcePaths:/);
  assert.match(patterns, /"sourceHash"/);
  assert.equal(patterns.trim().split(/\r?\n/).length, 1);
  assert.doesNotMatch(patterns, /README/);
  assert.deepEqual(validation.sourcePaths, ["ProjectKnowledge/validation/build_commands.json"]);
  assert.ok(validation.sourceHash.length > 0);
  assert.ok((await stat(path.join(outputRoot, "patterns", "patterns.jsonl"))).isFile());
});

test("capsule template documents are marked as missing evidence", async () => {
  const projectRoot = await createSummaryFixtureProject();
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "overview", "project_purpose.md"),
    "# Project Purpose\n\n当前文件只是模板。\n\n- 项目背景：待填写\n",
    "utf8"
  );
  await buildMemory({ projectRoot, capsule: true });
  const capsule = await readFile(path.join(projectRoot, ".ai", "project-memory", "project_capsule.md"), "utf8");
  assert.match(capsule, /TODO \/ missing evidence/);
});
