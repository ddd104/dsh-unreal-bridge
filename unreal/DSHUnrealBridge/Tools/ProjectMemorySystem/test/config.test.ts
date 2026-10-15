import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadProjectConfig } from "../src/config/loadProjectConfig.js";
import { validateProjectConfig } from "../src/config/schema.js";

function validConfig(projectId = "fixture-project"): object {
  return {
    schemaVersion: 1,
    projectId,
    knowledgeRoots: ["ProjectKnowledge", "Docs"],
    memoryOutputRoot: ".ai/project-memory",
    graph: {
      enabled: true,
      mode: "sqlite"
    }
  };
}

async function createFixtureProject(config: object): Promise<{ root: string; configPath: string }> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "project-memory-"));
  await mkdir(path.join(projectRoot, "AgentTools", "ProjectMemorySystem"), { recursive: true });
  await writeFile(path.join(projectRoot, "fixture.uproject"), "{}", "utf8");
  const configPath = path.join(projectRoot, "AgentTools", "ProjectMemorySystem", "ProjectMemory.project.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { root: projectRoot, configPath };
}

test("loadProjectConfig reads ProjectMemory.project.json", async () => {
  const fixture = await createFixtureProject(validConfig("fixture"));
  const loaded = await loadProjectConfig({ projectRoot: fixture.root });
  assert.equal(loaded.config.projectId, "fixture");
  assert.equal(loaded.config.graph.mode, "sqlite");
  assert.equal(loaded.configPath, fixture.configPath);
});

test("validateProjectConfig requires projectId", () => {
  const config = validConfig();
  delete (config as Record<string, unknown>).projectId;
  assert.throws(() => validateProjectConfig(config), /projectId/);
});

test("validateProjectConfig rejects unsupported graph mode", () => {
  const config = validConfig() as Record<string, unknown>;
  config.graph = { enabled: true, mode: "rest" };
  assert.throws(() => validateProjectConfig(config), /sqlite, mcp/);
});
