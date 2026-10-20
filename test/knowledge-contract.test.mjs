import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { knowledgeSchema, knowledgeRecordSchema } from '../src/protocol.mjs';
import { workerToolNames } from '../unreal/DSHUnrealBridge/Tools/knowledge-tools.mjs';

test('knowledge host schemas and worker admission match the native routing catalog', async () => {
  const source = await readFile(new URL('../unreal/DSHUnrealBridge/Source/DSHUnrealBridgeKnowledge/Private/ProjectKnowledgeTools.inl', import.meta.url), 'utf8');
  const declarations = source.split(/\r?\n/).filter(line => line.startsWith('DSH_KNOWLEDGE_TOOL('));
  const entries = declarations.map(line => {
    const match = /^DSH_KNOWLEDGE_TOOL\("([^"]+)", (Worker|Snapshot|Editor), (true|false), (true|false)\)$/.exec(line);
    assert.ok(match, `Unrecognized native tool declaration: ${line}`);
    return { name: match[1], backend: match[2], write: match[3] === 'true', bridge: match[4] === 'true' };
  });
  assert.ok(entries.length > 0, 'native catalog must not be empty');
  assert.equal(new Set(entries.map(entry => entry.name)).size, entries.length, 'tool names must be unique');
  const names = predicate => entries.filter(predicate).map(entry => entry.name).sort();
  assert.deepEqual([...knowledgeSchema.shape.tool.options].sort(), names(entry => entry.bridge && !entry.write));
  assert.deepEqual([...knowledgeRecordSchema.shape.tool.options].sort(), names(entry => entry.bridge && entry.write));
  assert.deepEqual([...workerToolNames].sort(), names(entry => entry.backend === 'Worker'));
  assert.equal(new Set(workerToolNames).size, workerToolNames.length, 'worker names must be unique');
});
