import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {AUDITED_MCP_READS,isReadOnlyMcpCall} from '../src/mcp-contract.mjs';

test('host and editor exempt exactly the same audited MCP queries from mutation coordination',async()=>{
  const native=await readFile(new URL('../unreal/DSHUnrealBridge/Source/DSHUnrealBridge/Private/DSHUnrealBridgeModule.cpp',import.meta.url),'utf8');
  const nativeDeclaration=native.match(/static const TSet<FString> Reads=\{([^}]+)\}/)?.[1];
  assert.ok(nativeDeclaration,'The native mutation coordinator must declare its exact audited read policy');
  const hostReads=[...AUDITED_MCP_READS].sort();
  const nativeReads=[...nativeDeclaration.matchAll(/TEXT\("([^"]+)"\)/g)].map(match=>match[1]).sort();
  assert.ok(hostReads.length>0);
  assert.deepEqual(nativeReads,hostReads,'A policy change must update both sides before bypassing their write slots');
  for(const name of nativeReads){
    const toolset=name.slice(0,name.lastIndexOf('.'));
    assert.equal(isReadOnlyMcpCall({name,arguments:{}}),true);
    assert.equal(isReadOnlyMcpCall({name:'call_tool',arguments:{toolset_name:toolset,tool_name:name.slice(toolset.length+1),arguments:{}}}),true);
    assert.equal(isReadOnlyMcpCall({name:`${toolset}.get_and_mutate`,arguments:{readOnlyHint:true}}),false);
  }
});
