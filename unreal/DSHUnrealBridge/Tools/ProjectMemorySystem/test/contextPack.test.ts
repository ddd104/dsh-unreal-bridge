import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { getContextPack } from "../src/commands/getContextPack.js";
import { buildMemory } from "../src/commands/buildMemory.js";
import { loadProjectConfig } from "../src/config/loadProjectConfig.js";
import { NullGraphClient } from "../src/graph/nullGraphClient.js";
import { buildImplementationMap } from "../src/memory/implementationMemory.js";
import type {
  ExpandOptions,
  FindOptions,
  GraphContextResult,
  GraphFeatureResult,
  GraphQuery,
  GraphQueryResult,
  GraphStatus,
  ImpactOptions,
  ImpactResult,
  ProjectGraphClient
} from "../src/graph/projectGraphClient.js";
import { buildMemoryContextPack } from "../src/retrieval/contextPackBuilder.js";

class FakeGraphClient implements ProjectGraphClient {
  constructor(private readonly owningSystem = "Fixture/System") {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async status(): Promise<GraphStatus> {
    return {
      mode: "sqlite",
      available: true,
      message: "fake graph available",
      nodeCount: 2,
      edgeCount: 1,
      warnings: []
    };
  }

  async findFeatureContext(query: string, _options?: FindOptions): Promise<GraphFeatureResult> {
    if (/health|damage|enemy/i.test(query)) {
      return {
        query,
        owningSystem: "Combat",
        nodes: [
          {
            id: "class:Source/Combat/HealthComponent.h:UHealthComponent",
            type: "Class",
            name: "UHealthComponent",
            path: "Source/Combat/HealthComponent.h",
            system: "Combat",
            language: "Cpp",
            summary: "Health component broadcasts OnHealthChanged for UI listeners."
          },
          {
            id: "event:Source/Combat/HealthComponent.h:OnHealthChanged",
            type: "Event",
            name: "OnHealthChanged",
            path: "Source/Combat/HealthComponent.h",
            system: "Combat",
            language: "Cpp",
            summary: "Health changed event used by damage UI."
          },
          {
            id: "asset:/Game/UI/BP_EnemyHealthBar",
            type: "Blueprint",
            name: "BP_EnemyHealthBar",
            path: "/Game/UI/BP_EnemyHealthBar",
            system: "UI",
            language: "UnrealAsset",
            summary: "Enemy health bar widget blueprint."
          }
        ],
        filesToRead: ["Source/Combat/HealthComponent.h"],
        blueprintsToRead: ["/Game/UI/BP_EnemyHealthBar"],
        assetsToInspect: [],
        warnings: []
      };
    }

    return {
      query,
      owningSystem: this.owningSystem,
      nodes: [
        {
          id: "file:Source/Foo.cpp",
          type: "File",
          name: "Foo.cpp",
          path: "Source/Foo.cpp",
          system: this.owningSystem,
          language: "Cpp",
          summary: "Fixture implementation file"
        }
      ],
      filesToRead: ["Source/Foo.cpp"],
      blueprintsToRead: [],
      assetsToInspect: [],
      warnings: []
    };
  }

  async queryGraph(query: GraphQuery): Promise<GraphQueryResult> {
    return {
      query,
      nodes: [],
      edges: [],
      warnings: []
    };
  }

  async expandContext(seedNodes: string[], _options?: ExpandOptions): Promise<GraphContextResult> {
    if (seedNodes.some((node) => /Health|EnemyHealthBar/i.test(node))) {
      return {
        seedNodes,
        nodes: [
          {
            id: "class:Source/Combat/HealthComponent.h:UHealthComponent",
            type: "Class",
            name: "UHealthComponent",
            path: "Source/Combat/HealthComponent.h",
            system: "Combat",
            language: "Cpp",
            summary: "Health component broadcasts OnHealthChanged for UI listeners."
          },
          {
            id: "event:Source/Combat/HealthComponent.h:OnHealthChanged",
            type: "Event",
            name: "OnHealthChanged",
            path: "Source/Combat/HealthComponent.h",
            system: "Combat",
            language: "Cpp",
            summary: "Health changed event used by damage UI."
          },
          {
            id: "asset:/Game/UI/BP_EnemyHealthBar",
            type: "Blueprint",
            name: "BP_EnemyHealthBar",
            path: "/Game/UI/BP_EnemyHealthBar",
            system: "UI",
            language: "UnrealAsset",
            summary: "Enemy health bar widget blueprint."
          }
        ],
        edges: [
          {
            from: "asset:/Game/UI/BP_EnemyHealthBar",
            to: "event:Source/Combat/HealthComponent.h:OnHealthChanged",
            type: "BINDS_TO"
          }
        ],
        filesToRead: ["Source/Combat/HealthComponent.h"],
        blueprintsToRead: ["/Game/UI/BP_EnemyHealthBar"],
        assetsToInspect: [],
        warnings: []
      };
    }

    return {
      seedNodes,
      nodes: [
        {
          id: "file:Source/Foo.cpp",
          type: "File",
          name: "Foo.cpp",
          path: "Source/Foo.cpp",
          system: this.owningSystem,
          language: "Cpp",
          summary: "Fixture implementation file"
        },
        {
          id: "asset:/Game/Foo/BP_Foo",
          type: "Blueprint",
          name: "BP_Foo",
          path: "/Game/Foo/BP_Foo",
          system: this.owningSystem,
          language: "UnrealAsset",
          summary: "Fixture blueprint"
        }
      ],
      edges: [
        {
          from: "asset:/Game/Foo/BP_Foo",
          to: "file:Source/Foo.cpp",
          type: "DEPENDS_ON"
        }
      ],
      filesToRead: ["Source/Foo.cpp"],
      blueprintsToRead: ["/Game/Foo/BP_Foo"],
      assetsToInspect: [],
      warnings: []
    };
  }

  async impactAnalysis(nodeIds: string[], _options?: ImpactOptions): Promise<ImpactResult> {
    return {
      nodeIds,
      nodes: [],
      edges: [],
      impactedSystems: [this.owningSystem],
      risk: "low",
      warnings: []
    };
  }
}

async function createContextFixtureProject(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "project-memory-context-"));
  await mkdir(path.join(projectRoot, "AgentTools", "ProjectMemorySystem"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "overview"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "architecture"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "systems"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "patterns"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "design"), { recursive: true });
  await mkdir(path.join(projectRoot, "ProjectKnowledge", "validation"), { recursive: true });
  await mkdir(path.join(projectRoot, ".ai", "cache", "blueprint_ir"), { recursive: true });
  await writeFile(path.join(projectRoot, "fixture.uproject"), "{}", "utf8");
  await writeFile(
    path.join(projectRoot, "AgentTools", "ProjectMemorySystem", "ProjectMemory.project.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        projectId: "context-fixture",
        knowledgeRoots: ["ProjectKnowledge"],
        memoryOutputRoot: ".ai/project-memory",
        sourcePolicy: {
          includeExtensions: [".md", ".json"],
          includePatterns: ["ProjectKnowledge/**"],
          excludePatterns: ["**/*.uasset"]
        },
        graph: {
          enabled: false,
          mode: "sqlite",
          ueCacheRoots: {
            blueprints: ".ai/cache/blueprint_ir"
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(path.join(projectRoot, "ProjectKnowledge", "overview", "project_purpose.md"), "# Game UI Fixture\n\n- Purpose: test context pack retrieval.\n", "utf8");
  await writeFile(path.join(projectRoot, "ProjectKnowledge", "architecture", "architecture_rules.md"), "# Rules\n\n- UI damage feedback must use existing widgets before new systems.\n", "utf8");
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "systems", "combat.md"),
    [
      "# Combat",
      "",
      "- Feature: enemy-health",
      "- Responsibility: tracks enemy damage and health values for gameplay.",
      "- Key symbol: UHealthComponent",
      "- Key event: OnHealthChanged",
      "- Forbidden: 不要重复存 health state"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "systems", "ui.md"),
    [
      "# UI",
      "",
      "- Responsibility: renders enemy health bar and damage feedback.",
      "- Reuse: BP_EnemyHealthBar listens to OnHealthChanged for percent updates."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(projectRoot, "ProjectKnowledge", "patterns", "health_ui_pattern.md"),
    [
      "# Health UI Pattern",
      "",
      "- Feature: health-ui",
      "- Systems: Combat, UI",
      "- Recommended: bind health bar percent to OnHealthChanged.",
      "- Reusable symbol: UHealthComponent",
      "- Reusable event: OnHealthChanged",
      "- Reusable blueprint: BP_EnemyHealthBar",
      "- Forbidden: 不要 Tick polling",
      "- Forbidden: 不要重复存 health state"
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(projectRoot, "ProjectKnowledge", "validation", "test_map.json"), `${JSON.stringify({ tests: [{ id: "ui-health", scope: "enemy health bar damage UI" }] }, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(projectRoot, ".ai", "cache", "blueprint_ir", "BP_EnemyHealthBar.json"),
    `${JSON.stringify({
      assetPath: "/Game/UI/BP_EnemyHealthBar.BP_EnemyHealthBar",
      blueprintName: "BP_EnemyHealthBar",
      parentClass: "/Script/UMG.UserWidget",
      variables: [
        {
          name: "HealthComponent",
          pinCategory: "object",
          pinSubCategoryObject: "/Script/Fixture.UHealthComponent"
        }
      ],
      functions: [
        {
          name: "BindHealth",
          nodeCount: 3,
          nodes: [
            {
              title: "Bind Event to OnHealthChanged"
            }
          ]
        }
      ],
      eventGraphs: [
        {
          name: "EventGraph",
          nodeCount: 2,
          nodes: [
            {
              title: "OnHealthChanged"
            }
          ]
        }
      ],
      calledFunctions: [
        {
          function: "/Script/Fixture.UHealthComponent:OnHealthChanged",
          graph: "EventGraph"
        }
      ],
      referencedAssets: ["/Game/UI/BP_EnemyHealthBar"]
    }, null, 2)}\n`,
    "utf8"
  );
  return projectRoot;
}

test("getContextPack generates through the graph adapter", async () => {
  // 迁移后测试只依赖独立样例项目，不再隐式读取宿主仓库的图谱缓存。
  const projectRoot = await createContextFixtureProject();
  const result = await getContextPack("charging flow", {
    projectRoot
  });
  assert.equal(result.command, "memory context-pack");
  assert.equal(result.phase, "graph-adapter");
  assert.match(result.message, /ProjectGraphClient adapter/);
});

test("getContextPack requires a query", async () => {
  await assert.rejects(() => getContextPack("   ", { projectRoot: "../../" }), /requires non-empty/);
});

test("graph disabled context pack still generates", async () => {
  const projectRoot = await createContextFixtureProject();
  await buildMemory({ projectRoot });
  const loaded = await loadProjectConfig({ projectRoot });
  const pack = await buildMemoryContextPack({ query: "offline docs" }, {
    loaded,
    graphClient: new NullGraphClient("graph disabled for test")
  });
  assert.equal(pack.graphContext.status.available, false);
  assert.deepEqual(pack.graphContext.feature.nodes, []);
  assert.match(pack.missingInformation.join("\n"), /ProjectGraph adapter is unavailable/);
});

test("fake graph client results are merged into context pack", async () => {
  const projectRoot = await createContextFixtureProject();
  await buildMemory({ projectRoot });
  const loaded = await loadProjectConfig({ projectRoot });
  const pack = await buildMemoryContextPack({ query: "fixture foo" }, {
    loaded,
    graphClient: new FakeGraphClient()
  });
  assert.equal(pack.owningSystem.id, "Fixture/System");
  assert.deepEqual(pack.filesToRead, ["Source/Foo.cpp"]);
  assert.deepEqual(pack.blueprintsToRead, ["/Game/Foo/BP_Foo"]);
  assert.equal(pack.graphContext.feature.nodes.length, 1);
  assert.equal(pack.graphContext.context.nodes.length, 2);
  assert.equal(pack.graphContext.context.edges.length, 1);
});

test("context pack returns Combat/UI systems and health UI pattern", async () => {
  const projectRoot = await createContextFixtureProject();
  await buildMemory({ projectRoot });
  const loaded = await loadProjectConfig({ projectRoot });
  const pack = await buildMemoryContextPack(
    {
      query: "enemy health bar damage UI",
      taskType: "feature",
      budget: {
        maxDocs: 6,
        maxSystems: 4,
        maxPatterns: 4,
        maxGraphNodes: 4,
        maxFiles: 4,
        maxBlueprints: 4,
        maxAssets: 4
      }
    },
    {
      loaded,
      graphClient: new FakeGraphClient("combat")
    }
  );

  const systemTitles = [pack.owningSystem.title, ...pack.secondarySystems.map((system) => system.title)].filter(Boolean);
  assert.ok(systemTitles.includes("combat") || systemTitles.includes("Combat"));
  assert.ok(systemTitles.includes("UI"));
  assert.ok(pack.existingPatterns.some((pattern) => pattern.id === "health_ui_pattern"));
  assert.ok(pack.relevantDocs.some((doc) => /combat\.md$/.test(doc.path)));
  assert.ok(pack.relevantDocs.some((doc) => /ui\.md$/.test(doc.path)));
});

test("context pack merges implementation memory for health UI reuse", async () => {
  const projectRoot = await createContextFixtureProject();
  await buildMemory({ projectRoot });
  const loaded = await loadProjectConfig({ projectRoot });
  await buildImplementationMap(loaded, {
    graphClient: new FakeGraphClient("combat")
  });
  const pack = await buildMemoryContextPack(
    {
      query: "enemy health bar damage UI",
      taskType: "feature",
      budget: {
        maxDocs: 6,
        maxSystems: 4,
        maxPatterns: 4,
        maxGraphNodes: 6,
        maxFiles: 4,
        maxBlueprints: 4,
        maxAssets: 4,
        maxImplementations: 4,
        maxReusableSymbols: 8
      }
    },
    {
      loaded,
      graphClient: new FakeGraphClient("combat")
    }
  );

  assert.ok(pack.relevantImplementations.some((item) => item.id === "enemy-health" || item.id === "health-ui"));
  assert.ok(pack.reusableSymbols.some((symbol) => symbol.name === "UHealthComponent"));
  assert.ok(pack.reusableSymbols.some((symbol) => symbol.name === "OnHealthChanged"));
  assert.ok(pack.reusableBlueprints.some((item) => /BP_EnemyHealthBar/.test(item)));
  assert.ok(pack.forbiddenApproaches.some((item) => /Tick polling/.test(item)));
  assert.ok(pack.forbiddenApproaches.some((item) => /重复存 health state/.test(item)));
});
