import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { createWorker } from '../knowledge-worker.mjs';
import { workerToolNames } from '../knowledge-tools.mjs';
import { GraphStore } from '../ProjectGraph/dist/src/graph/graphStore.js';

const pluginSource = fileURLToPath(new URL('../../', import.meta.url));
const tempRoot = path.join(pluginSource, 'Cache/TestRuns/Temp');

async function fixture(t) {
  await mkdir(tempRoot, { recursive: true });
  const project = await mkdtemp(path.join(tempRoot, 'knowledge-routing-'));
  t.after(async () => {
    const relative = path.relative(tempRoot, project);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'cleanup stays inside the test directory');
    await rm(project, { recursive: true, force: true });
  });
  const plugin = path.join(project, 'Plugins/DSHUnrealBridge');
  await mkdir(path.join(plugin, 'Config/Knowledge'), { recursive: true });
  await mkdir(path.join(project, 'Source'), { recursive: true });
  await writeFile(path.join(project, 'RoutingFixture.uproject'), '{"FileVersion":3}\n');
  await writeFile(path.join(project, 'Source/RouteFixture.h'), 'class RouteFixture { public: void Execute(); };\n');
  const configPath = path.join(plugin, 'Config/Knowledge/ProjectMemory.project.json');
  await copyFile(path.join(pluginSource, 'Config/Knowledge/ProjectMemory.project.json'), configPath);
  const worker = await createWorker(project, plugin);
  let sequence = 0;
  const call = (tool, args = {}) => worker({ id: `routing-${++sequence}`, tool, arguments: args });
  const updated = await call('project_update');
  assert.equal(updated.isError, false, JSON.stringify(updated.result));

  const graph = new GraphStore();
  graph.addNode({ id: 'class:RouteFixture', type: 'Class', name: 'RouteFixture', path: 'Source/RouteFixture.h', system: 'Routing', language: 'cpp', summary: 'RouteFixture executes routing work', metadata: {} });
  graph.addNode({ id: 'function:Execute', type: 'Function', name: 'Execute', path: 'Source/RouteFixture.h', system: 'Routing', language: 'cpp', summary: 'RouteFixture execution function', metadata: {} });
  graph.addEdge({ from: 'class:RouteFixture', to: 'function:Execute', type: 'HAS_FUNCTION', metadata: {} });
  await graph.writeJsonl(path.join(plugin, 'Cache/Graph'));
  return { call, configPath };
}

test('all registered worker tools reach a handler and unsupported tools are rejected', async t => {
  const { call } = await fixture(t);
  for (const tool of workerToolNames) {
    // project_update already ran successfully; avoid replacing the graph fixture.
    if (tool === 'project_update') continue;
    const response = await call(tool);
    assert.notEqual(response.result.code, 'unknown_tool', `${tool} must have a real handler`);
  }
  const unknown = await call('graph_not_registered');
  assert.equal(unknown.isError, true);
  assert.equal(unknown.result.code, 'unknown_tool');
  const nativeOnly = await call('inspect_asset');
  assert.equal(nativeOnly.result.code, 'unknown_tool', 'native tools must not enter the worker');
});

test('graph query, feature and impact return graph evidence and honor graph disabling', async t => {
  const { call, configPath } = await fixture(t);
  const query = await call('graph_query', { query: 'RouteFixture', limit: 1 });
  assert.equal(query.isError, false, JSON.stringify(query.result));
  assert.equal(query.result.authority, 'index_candidates');
  assert.equal(query.result.candidates.length, 1);
  assert.equal(query.result.candidates[0].node.id, 'class:RouteFixture');
  const feature = await call('graph_feature', { query: 'RouteFixture' });
  assert.equal(feature.isError, false, JSON.stringify(feature.result));
  assert.equal(feature.result.owningSystem, 'Routing');
  assert.equal(feature.result.owningSystemCandidate.verified, false);
  const impact = await call('graph_impact', { nodeId: 'class:RouteFixture' });
  assert.equal(impact.isError, false, JSON.stringify(impact.result));
  assert.equal(impact.result.root.id, 'class:RouteFixture');
  assert.equal(impact.result.totalImpacted, 1);
  assert.equal(impact.result.impacted[0].node.id, 'function:Execute');
  assert.equal((await call('graph_query')).result.code, 'invalid_query');
  assert.equal((await call('graph_feature')).result.code, 'invalid_query');
  assert.equal((await call('graph_impact')).result.code, 'invalid_node');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.graph.enabled = false;
  await writeFile(configPath, JSON.stringify(config));
  for (const tool of ['graph_query', 'graph_feature', 'graph_impact']) {
    const response = await call(tool, { query: 'RouteFixture', nodeId: 'class:RouteFixture' });
    assert.equal(response.isError, true);
    assert.equal(response.result.code, 'graph_disabled');
  }
});
