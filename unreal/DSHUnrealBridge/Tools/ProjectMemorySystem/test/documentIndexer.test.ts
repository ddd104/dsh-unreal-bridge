import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildMemory } from "../src/commands/buildMemory.js";
import { queryMemory } from "../src/commands/queryMemory.js";
import { updateMemory } from "../src/commands/updateMemory.js";

async function createFixtureProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "project-memory-docs-"));
  const fixtureRoot = path.resolve("test/fixtures/docs");
  await cp(fixtureRoot, projectRoot, { recursive: true });
  await mkdir(path.join(projectRoot, "AgentTools", "ProjectMemorySystem"), { recursive: true });
  await writeFile(path.join(projectRoot, "fixture.uproject"), "{}", "utf8");
  await writeFile(
    path.join(projectRoot, "AgentTools", "ProjectMemorySystem", "ProjectMemory.project.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        projectId: "docs-fixture",
        knowledgeRoots: ["ProjectKnowledge"],
        memoryOutputRoot: ".ai/project-memory",
        sourcePolicy: {
          includeExtensions: [".md", ".json", ".csv"],
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
  return projectRoot;
}

test("buildMemory --docs-only indexes markdown, json, and csv", async () => {
  const projectRoot = await createFixtureProject();
  const result = await buildMemory({ projectRoot, docsOnly: true });
  assert.equal(result.phase, "docs-index");

  const documentsPath = path.join(projectRoot, ".ai/project-memory/index/documents.jsonl");
  const ftsPath = path.join(projectRoot, ".ai/project-memory/index/fts.sqlite");
  const documentsJsonl = await readFile(documentsPath, "utf8");
  const documents = documentsJsonl
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { sourceType: string; path: string; text: string });

  assert.equal(documents.length, 3);
  assert.deepEqual(
    documents.map((document) => document.sourceType).sort(),
    ["csv", "json", "markdown"]
  );
  assert.ok(documents.some((document) => document.text.includes("alpha-memory")));
  assert.ok((await stat(ftsPath)).isFile());
});

test("queryMemory searches the generated full-text index", async () => {
  const projectRoot = await createFixtureProject();
  await buildMemory({ projectRoot, docsOnly: true });
  const result = await queryMemory("gamma-memory", { projectRoot });
  assert.equal(result.phase, "docs-index");
  const data = result.data as { results: Array<{ path: string; excerpt: string }> };
  assert.equal(data.results.length, 1);
  assert.match(data.results[0].path, /sample\.csv/);
});

test("updateMemory removes deleted source records", async () => {
  const projectRoot = await createFixtureProject();
  await buildMemory({ projectRoot, docsOnly: true });
  await rm(path.join(projectRoot, "ProjectKnowledge", "sample.json"));

  const update = await updateMemory({ projectRoot });
  const updateData = update.data as { removedSources: string[] };
  assert.deepEqual(updateData.removedSources, ["ProjectKnowledge/sample.json"]);

  const documentsPath = path.join(projectRoot, ".ai/project-memory/index/documents.jsonl");
  const documentsJsonl = await readFile(documentsPath, "utf8");
  assert.doesNotMatch(documentsJsonl, /sample\.json/);
});

test("protobuf schema files become searchable project documents", async () => {
  const projectRoot = await createFixtureProject();
  const configPath = path.join(projectRoot, "AgentTools/ProjectMemorySystem/ProjectMemory.project.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.sourcePolicy.includeExtensions.push(".proto");
  await writeFile(configPath, JSON.stringify(config), "utf8");
  await writeFile(path.join(projectRoot, "ProjectKnowledge", "route.proto"), [
    'syntax = "proto3";',
    "package ehv.route;",
    "message RouteTelemetry { string road_segment_name = 1; }",
    "enum RouteMode { ROUTE_UNKNOWN = 0; ROUTE_READY = 1; }",
    "service Router { rpc Resolve (RouteTelemetry) returns (RouteTelemetry); }"
  ].join("\n"), "utf8");
  await buildMemory({ projectRoot, docsOnly: true });
  const result = await queryMemory("RouteTelemetry", { projectRoot });
  const data = result.data as { results: Array<{ path: string }> };
  assert.ok(data.results.some((item) => item.path.endsWith("ProjectKnowledge/route.proto")));
  const documents = (await readFile(path.join(projectRoot, ".ai/project-memory/index/documents.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const document = documents.find((item) => item.path.endsWith("ProjectKnowledge/route.proto"));
  assert.equal(document.sourceType, "proto");
  assert.deepEqual(document.metadata.messages, ["ehv.route.RouteTelemetry"]);
  assert.deepEqual(document.metadata.enums, ["ehv.route.RouteMode"]);
  assert.deepEqual(document.metadata.services, ["ehv.route.Router"]);
  assert.match(document.text, /rpc Resolve \(RouteTelemetry\) returns \(RouteTelemetry\)/);
  assert.match(document.text, /1: string road_segment_name/);
});

test("legacy XLS worksheets become searchable project documents", async () => {
  const projectRoot = await createFixtureProject();
  const configPath = path.join(projectRoot, "AgentTools/ProjectMemorySystem/ProjectMemory.project.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.sourcePolicy.includeExtensions.push(".xls");
  await writeFile(configPath, JSON.stringify(config), "utf8");
  await buildMemory({ projectRoot, docsOnly: true });
  const result = await queryMemory("legacy-marker", { projectRoot });
  const data = result.data as { results: Array<{ path: string }> };
  assert.ok(data.results.some((item) => item.path.endsWith("ProjectKnowledge/sample.xls")));
  const documents = (await readFile(path.join(projectRoot, ".ai/project-memory/index/documents.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const document = documents.find((item) => item.path.endsWith("ProjectKnowledge/sample.xls"));
  assert.equal(document.sourceType, "xls");
  assert.deepEqual(document.metadata.sheetNames, ["Legacy"]);
  assert.match(document.text, /legacy-marker\t42/);
});
