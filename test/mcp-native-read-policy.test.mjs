import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isReadOnlyMcpCall} from '../src/mcp-contract.mjs';

test('host and editor exempt exactly the same audited MCP queries from mutation coordination',async()=>{
  const [host,native]=await Promise.all([
    readFile(new URL('../src/mcp-contract.mjs',import.meta.url),'utf8'),
    readFile(new URL('../unreal/DSHUnrealBridge/Source/DSHUnrealBridge/Private/DSHUnrealBridgeModule.cpp',import.meta.url),'utf8'),
  ]);
  const toolset=host.match(/const DATA_TABLE='([^']+)'/)?.[1];
  const hostDeclaration=host.match(/const READS=new Set\(\[([^\]]+)\]\.map/)?.[1];
  const nativeDeclaration=native.match(/static const TSet<FString> Reads=\{([^}]+)\}/)?.[1];
  assert.ok(toolset&&hostDeclaration&&nativeDeclaration,'Both mutation coordinators must declare their exact audited read policy');
  const hostReads=[...hostDeclaration.matchAll(/'([^']+)'/g)].map(match=>`${toolset}.${match[1]}`).sort();
  const nativeReads=[...nativeDeclaration.matchAll(/TEXT\("([^"]+)"\)/g)].map(match=>match[1]).sort();
  assert.ok(hostReads.length>0);
  assert.deepEqual(nativeReads,hostReads,'A policy change must update both sides before bypassing their write slots');
  for(const name of nativeReads){
    assert.equal(isReadOnlyMcpCall({name,arguments:{}}),true);
    assert.equal(isReadOnlyMcpCall({name:'call_tool',arguments:{toolset_name:toolset,tool_name:name.slice(toolset.length+1),arguments:{}}}),true);
  }
  assert.equal(isReadOnlyMcpCall({name:`${toolset}.get_and_mutate`,arguments:{readOnlyHint:true}}),false);
});
