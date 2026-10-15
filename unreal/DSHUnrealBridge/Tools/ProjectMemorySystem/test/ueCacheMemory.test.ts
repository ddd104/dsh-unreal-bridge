import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildMemory } from "../src/commands/buildMemory.js";
import { summarizeUeCacheContent } from "../src/summarizers/ueAssetSummarizer.js";

const blueprintFixture = {
  assetPath: "/Game/UI/WBP_Status.WBP_Status",
  blueprintName: "WBP_Status",
  parentClass: "/Script/UMG.UserWidget",
  generatedClass: "/Game/UI/WBP_Status.WBP_Status_C",
  variables: [
    {
      name: "HealthText",
      pinCategory: "object",
      pinSubCategoryObject: "/Script/UMG.TextBlock"
    }
  ],
  eventGraphs: [
    {
      name: "EventGraph",
      nodeCount: 2,
      nodes: [
        { title: "Event Construct", class: "/Script/BlueprintGraph.K2Node_Event" },
        { title: "SetText", class: "/Script/BlueprintGraph.K2Node_CallFunction" }
      ]
    }
  ],
  calledFunctions: [
    {
      graph: "EventGraph",
      function: "/Script/UMG.TextBlock:SetText",
      nodeTitle: "SetText"
    }
  ],
  referencedAssets: ["/Script/UMG"]
};

const materialFixture = {
  assetPath: "/Game/Materials/M_Status.M_Status",
  materialDomain: "MD_Surface",
  blendMode: "BLEND_Translucent",
  shadingModel: "MSM_Unlit",
  expressions: [
    {
      name: "MaterialExpressionScalarParameter_0",
      class: "/Script/Engine.MaterialExpressionScalarParameter",
      caption: ["Param (1)", "'Opacity'"]
    },
    {
      name: "MaterialExpressionMaterialFunctionCall_0",
      class: "/Script/Engine.MaterialExpressionMaterialFunctionCall",
      caption: ["MF_Status"]
    }
  ]
};

const assetRegistryFixture = {
  ok: true,
  assets: [
    {
      assetPath: "/Game/UI/WBP_Status.WBP_Status",
      assetClass: "/Script/Engine.WidgetBlueprint",
      packageName: "/Game/UI/WBP_Status",
      dependencies: ["/Script/UMG"],
      referencers: []
    }
  ]
};

test("summarizeUeCacheContent creates blueprint, material, and asset registry summaries", () => {
  const blueprint = summarizeUeCacheContent("cache/blueprint_ir/WBP_Status.json", JSON.stringify(blueprintFixture));
  assert.equal(blueprint.kind, "blueprint");
  assert.match(blueprint.text, /HealthText/);
  assert.match(blueprint.text, /SetText/);
  assert.equal(blueprint.metadata.variableCount, 1);

  const material = summarizeUeCacheContent("cache/material_ir/M_Status.json", JSON.stringify(materialFixture));
  assert.equal(material.kind, "material");
  assert.match(material.text, /BLEND_Translucent/);
  assert.match(material.text, /MF_Status/);
  assert.equal(material.metadata.parameterCount, 1);

  const registry = summarizeUeCacheContent("cache/asset_registry/assets.json", JSON.stringify(assetRegistryFixture));
  assert.equal(registry.kind, "asset-registry");
  assert.match(registry.text, /Assets: 1/);
  assert.equal(registry.metadata.assetCount, 1);
});

test("summarizeUeCacheContent accepts UTF-16LE cache JSON", () => {
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(JSON.stringify(blueprintFixture), "utf16le")
  ]);
  const blueprint = summarizeUeCacheContent("cache/blueprint_ir/WBP_Status.json", utf16);
  assert.equal(blueprint.kind, "blueprint");
  assert.match(blueprint.text, /WBP_Status/);
});

async function createUeCacheFixtureProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "project-memory-ue-cache-"));
  await mkdir(path.join(projectRoot, "AgentTools", "ProjectMemorySystem"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge"), { recursive: true });
  await mkdir(path.join(projectRoot, ".ai", "cache", "blueprint_ir"), { recursive: true });
  await mkdir(path.join(projectRoot, ".ai", "cache", "material_ir"), { recursive: true });
  await mkdir(path.join(projectRoot, ".ai", "cache", "asset_registry"), { recursive: true });
  await writeFile(path.join(projectRoot, "fixture.uproject"), "{}", "utf8");
  await writeFile(path.join(projectRoot, "ProjectKnowledge", "README.md"), "# Fixture\n\n- UE cache fixture.\n", "utf8");
  await writeFile(path.join(projectRoot, ".ai", "cache", "blueprint_ir", "WBP_Status.json"), JSON.stringify(blueprintFixture), "utf8");
  await writeFile(path.join(projectRoot, ".ai", "cache", "material_ir", "M_Status.json"), JSON.stringify(materialFixture), "utf8");
  await writeFile(path.join(projectRoot, ".ai", "cache", "asset_registry", "assets.json"), JSON.stringify(assetRegistryFixture), "utf8");
  await writeFile(
    path.join(projectRoot, "AgentTools", "ProjectMemorySystem", "ProjectMemory.project.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        projectId: "ue-cache-fixture",
        knowledgeRoots: ["ProjectKnowledge"],
        memoryOutputRoot: ".ai/project-memory",
        sourcePolicy: {
          includeExtensions: [".md"],
          includePatterns: ["ProjectKnowledge/**"],
          excludePatterns: ["**/*.uasset"]
        },
        graph: {
          enabled: true,
          mode: "sqlite",
          sqlite: {
            databasePath: ".ai/graph/project_graph.sqlite"
          },
          ueCacheRoots: {
            blueprints: ".ai/cache/blueprint_ir",
            assets: ".ai/cache/asset_registry",
            materials: ".ai/cache/material_ir"
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return projectRoot;
}

test("buildMemory writes read-only UE cache summaries", async () => {
  const projectRoot = await createUeCacheFixtureProject();
  await buildMemory({ projectRoot });
  const summariesPath = path.join(projectRoot, ".ai", "project-memory", "ue-cache", "summaries.jsonl");
  const summaries = (await readFile(summariesPath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { kind: string; sourcePaths: string[]; sourceHash: string; text: string });

  assert.equal(summaries.length, 3);
  assert.deepEqual(summaries.map((summary) => summary.kind).sort(), ["asset-registry", "blueprint", "material"]);
  assert.ok(summaries.every((summary) => summary.sourcePaths.length === 1));
  assert.ok(summaries.every((summary) => summary.sourceHash.length > 0));
  assert.ok(summaries.some((summary) => /do not edit \.uasset/i.test(summary.text)));
});
