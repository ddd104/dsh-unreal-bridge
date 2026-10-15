import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { GraphStore } from "../src/graph/graphStore.js";
import { indexUeEditorCache } from "../src/indexers/ueEditorIndexer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("ueEditorIndexer builds parent class and asset reference edges from fixtures", async () => {
  const store = new GraphStore();
  const cacheRoot = path.resolve(__dirname, "../../test/fixtures/ue-cache");

  const result = await indexUeEditorCache({ projectRoot: cacheRoot, cacheRoot }, store);

  assert.equal(result.blueprintFiles, 1);
  assert.equal(result.assetRegistryFiles, 1);
  assert.equal(result.materialFiles, 1);

  const edges = store.edges();
  assert.ok(edges.some((edge) => edge.type === "PARENT_CLASS"));
  assert.ok(edges.some((edge) => edge.type === "REFERENCES_ASSET"));
  assert.ok(edges.some((edge) => edge.type === "HAS_VARIABLE"));
  assert.ok(edges.some((edge) => edge.type === "HAS_FUNCTION"));
  assert.ok(edges.some((edge) => edge.type === "HAS_MACRO"));
  assert.ok(edges.some((edge) => edge.type === "HAS_COMPONENT"));
  assert.ok(edges.some((edge) => edge.type === "DEPENDS_ON"));

  const nodes = store.nodes();
  assert.ok(nodes.some((node) => node.type === "Blueprint" && node.name === "BP_TestWidget"));
  assert.ok(nodes.some((node) => node.type === "Macro" && node.name === "FormatTitle"));
  assert.ok(nodes.some((node) => node.type === "Widget"));
  assert.ok(nodes.some((node) => node.type === "Material"));

  const refresh = nodes.find((node) => node.type === "Function" && node.name === "Refresh");
  assert.ok(refresh);
  assert.equal((refresh.metadata.raw as { nodes?: unknown[] }).nodes?.length, 1);

  const rootCanvas = nodes.find((node) => node.type === "Component" && node.name === "RootCanvas");
  assert.ok(rootCanvas);
  assert.equal(
    ((rootCanvas.metadata.raw as { defaultProperties?: Record<string, string> }).defaultProperties ?? {}).Visibility,
    "Visible"
  );
});

test("per-asset snapshots index graph details, opaque assets and MI parents while rejecting stale/foreign entries", async (t) => {
  // 独立临时目录覆盖新格式，与旧 IR fixtures 并存，不需要编辑项目资产。
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "asset-snapshot-index-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const cacheRoot = path.join(projectRoot, "Cache", "UE");
  const snapshots = path.join(cacheRoot, "asset_snapshots");
  await mkdir(snapshots, { recursive: true });
  const projectId = path.join(projectRoot, "SnapshotTest.uproject");
  const assets: Record<string, unknown> = {};
  const values = [
    { assetPath: "/Game/BP_Test.BP_Test", assetClass: "/Script/Engine.Blueprint", blueprint: { assetPath: "/Game/BP_Test.BP_Test", blueprintName: "BP_Test", variables: [{ name: "Enabled", defaultValue: "true" }], otherGraphs: [{ name: "Collapsed", path: "/Game/BP_Test.BP_Test:Collapsed", nodes: [{ nodeGuid: "guid", pins: [{ name: "then" }] }] }] } },
    { assetPath: "/ProjectPlugin/MI_Test.MI_Test", assetClass: "/Script/Engine.MaterialInstanceConstant", materialInstance: { parent: "/Game/M_Base.M_Base", parameters: [] } },
    { assetPath: "/Game/T_Unknown.T_Unknown", assetClass: "/Script/Engine.Texture2D", coverage: { status: "opaque" } },
    { assetPath: "/Game/BP_Stale.BP_Stale", assetClass: "/Script/Engine.Blueprint", stale: true },
    { assetPath: "/Game/BP_Foreign.BP_Foreign", assetClass: "/Script/Engine.Blueprint", projectId: "/Other/Foreign.uproject" }
  ];
  for (const [index, value] of values.entries()) {
    const file = `${index.toString(16).padStart(32, "0")}.json`;
    const snapshot = { schemaVersion: 1, projectId, fingerprint: `fingerprint-${index}`, dependencies: ["/Game/Shared"], ...value };
    await writeFile(path.join(snapshots, file), JSON.stringify(snapshot));
    assets[value.assetPath] = { file, fingerprint: snapshot.fingerprint, stale: value.stale ?? false };
  }
  // 不允许索引中的文件名越过快照缓存目录。
  assets["/Game/Traversal.Traversal"] = { file: "../outside.json", fingerprint: "invalid" };
  await writeFile(path.join(snapshots, "index.json"), JSON.stringify({ projectId, complete: false, assets }));
  const store = new GraphStore();
  const result = await indexUeEditorCache({ projectRoot, cacheRoot }, store);
  assert.equal(result.snapshotFiles, 3);
  assert.ok(store.nodes().some(node => node.name === "Collapsed" && node.type === "Function"));
  assert.ok(store.nodes().some(node => node.name === "T_Unknown" && (node.metadata.coverage as { status: string }).status === "opaque"));
  assert.ok(store.edges().some(edge => edge.type === "INSTANCE_OF_MATERIAL"));
  assert.ok(!store.nodes().some(node => /Stale|Foreign|Traversal/.test(node.name)));
  assert.ok(result.warnings.some(warning => warning.includes("incomplete")));
  assert.ok(result.warnings.some(warning => warning.includes("mismatched")));
  assert.ok(result.warnings.some(warning => warning.includes("filename")));
  await writeFile(path.join(snapshots, "index.json"), JSON.stringify({ projectId: path.join(projectRoot, "Other", "Foreign.uproject"), complete: true, assets }));
  const foreign = await indexUeEditorCache({ projectRoot, cacheRoot }, new GraphStore());
  assert.equal(foreign.snapshotFiles, 0);
  assert.ok(foreign.warnings.some(warning => warning.includes("different project")));
});
