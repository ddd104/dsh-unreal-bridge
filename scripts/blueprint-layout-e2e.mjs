// Exercises real native and MCP graph edits in a disposable project only.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {UnrealBridge} from '../src/bridge.mjs';

const [engine,project,stateRoot]=process.argv.slice(2);
if(!engine||!project||!stateRoot)throw new Error('Usage: node scripts/blueprint-layout-e2e.mjs <engine-root> <disposable.uproject> <state-dir>');
const projectPath=resolve(project);
if(!projectPath.replaceAll('\\','/').toLowerCase().includes('/.test-state/'))throw new Error('Use a disposable .test-state project only');
const stateDir=resolve(stateRoot);await mkdir(stateDir,{recursive:true});
const bridge=await new UnrealBridge({port:0,stateDir,requestTimeoutMs:60000}).start();
const diagnostics=[],checks=[];bridge.on('diagnostic',message=>diagnostics.push(message));
const child=spawn(join(engine,'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'),[projectPath,'-unattended','-NullRHI','-RenderOffscreen','-nosplash','-nop4','-nosound',`-DSHBridgeDescriptor=${bridge.descriptorPath}`,`-abslog=${join(stateDir,'editor.log')}`],{stdio:'ignore',windowsHide:true});
const session='blueprint-layout-e2e';
const pass=label=>{checks.push(label);console.log(`PASS: ${label}`);};
const value=result=>{
  assert.notEqual(result.isError,true);
  const parsed=result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);
  return parsed.returnValue??parsed;
};
const call=(toolName,arguments_,requestId=randomUUID())=>bridge.mcpCallToolset(session,{toolsetName:'editor_toolset.toolsets.blueprint.BlueprintTools',toolName,arguments:arguments_,requestId});
try{
  const deadline=Date.now()+150000;
  while(!bridge.list().length){if(child.exitCode!==null)throw new Error(`Editor exited (${child.exitCode})`);if(Date.now()>deadline)throw new Error('Editor registration timed out');await new Promise(r=>setTimeout(r,100));}
  bridge.bind(session,bridge.list()[0].editorId);
  assert.ok(bridge.target(session).capabilities.includes('automatic_graph_layout'));pass('real editor advertises automatic graph layout');
  const assetPath=`/Game/DSHBridgeTests/BP_LayoutE2E_${randomUUID().replaceAll('-','')}`;
  const created=await bridge.apply(session,(await bridge.preview(session,'create',{assetPath,parent:'Actor'})).previewId,randomUUID());
  const read=()=>bridge.read(session,{assetPath,graph:'EventGraph',detail:'full'});
  const before=await read(),begin=before.graphs[0].nodes.find(n=>n.functionPath==='/Script/Engine.Actor:ReceiveBeginPlay');
  assert.ok(begin);
  const operations=[];
  for(const id of ['one','two'])operations.push({op:'add_node',nodeId:id,kind:'call_function',functionPath:'/Script/Engine.KismetSystemLibrary:PrintString'},{op:'set_pin_default',nodeId:id,pin:'InString',value:`Layout ${id}`});
  operations.push({op:'connect',from:{node:begin.id,pin:'then'},to:{node:'one',pin:'execute'}},{op:'connect',from:{node:'one',pin:'then'},to:{node:'two',pin:'execute'}});
  const preview=await bridge.preview(session,'patch',{assetPath,graph:'EventGraph',baseRevision:before.revision,operations});
  assert.equal((await read()).revision,before.revision);
  const applied=await bridge.apply(session,preview.previewId,randomUUID());
  assert.equal(applied.compiled,true);assert.ok(applied.layout.movedNodes>0);assert.equal(applied.layout.undoSeparate,false);assert.equal(applied.saved,false);
  let after=await read();assert.equal(after.revision,applied.revision);
  const prints=after.graphs[0].nodes.filter(n=>n.functionPath==='/Script/Engine.KismetSystemLibrary:PrintString');
  const one=prints.find(n=>n.pins.some(p=>p.name==='InString'&&p.defaultValue==='Layout one'));
  const two=prints.find(n=>n.pins.some(p=>p.name==='InString'&&p.defaultValue==='Layout two'));
  assert.ok(one.x<two.x);pass('native batch arranges unspecified positions before returning its final revision');
  const undone=await bridge.mutate(session,'undo',{assetPath,baseRevision:after.revision},randomUUID());
  assert.equal(undone.revision,before.revision);pass('one native undo restores content and original layout');
  const repeated=await bridge.preview(session,'patch',{assetPath,graph:'EventGraph',baseRevision:undone.revision,operations});
  await bridge.apply(session,repeated.previewId,randomUUID());
  const graph=value(await call('get_graph',{blueprint:{refPath:created.assetPath},graph_name:'EventGraph'}));
  const nodes=value(await call('find_nodes',{graph,title:''}));
  const infos=value(await call('get_node_infos',{nodes}));
  const first=infos.find(n=>n.input_pins.some(p=>p.name==='InString'&&p.value==='Layout one'));
  const second=infos.find(n=>n.input_pins.some(p=>p.name==='InString'&&p.value==='Layout two'));
  assert.ok(first&&second);
  // Deliberately overlap two nodes with the dedicated movement tool, then edit a pin.
  const moved=await call('set_node_position',{node:second.node,pos:first.position});
  assert.equal(moved.dshLayout,undefined);pass('explicit MCP node movement preserves requested coordinates');
  const untouched=(await read()).graphs[0].nodes.filter(n=>n.functionPath!=='/Script/Engine.KismetSystemLibrary:PrintString'&&n.id!==begin.id);
  const pin=first.input_pins.find(p=>p.name==='InString').pin_id;
  const requestId=randomUUID(),changed=await call('set_pin_value',{pin,value:'A longer value requiring a wider node and a fresh layout'},requestId);
  assert.equal(changed.dshLayout.status,'applied');assert.ok(changed.dshLayout.movedNodes>0);assert.equal(changed.dshLayout.undoSeparate,true);
  after=await read();assert.equal(changed.dshLayout.revisions.find(x=>x.assetPath===created.assetPath).revision,after.revision);
  const current=after.graphs[0].nodes;
  const firstAfter=current.find(n=>n.pins.some(p=>p.name==='InString'&&p.defaultValue.startsWith('A longer value')));
  const secondAfter=current.find(n=>n.pins.some(p=>p.name==='InString'&&p.defaultValue==='Layout two'));
  assert.ok(firstAfter.x<secondAfter.x);
  for(const node of untouched){const actual=current.find(n=>n.id===node.id);assert.equal(actual.x,node.x);assert.equal(actual.y,node.y);}
  pass('real MCP pin edit arranges the affected event block and reports the final revision and separate undo');
  assert.deepEqual(await call('set_pin_value',{pin,value:'A longer value requiring a wider node and a fresh layout'},requestId),changed);
  assert.equal((await read()).revision,after.revision);pass('request replay does not repeat layout or change the revision');
  const sameValue=await call('set_pin_value',{pin,value:'A longer value requiring a wider node and a fresh layout'});
  assert.ok(!sameValue.dshLayout||sameValue.dshLayout.movedNodes===0);
  assert.equal((await read()).revision,after.revision);pass('an unchanged pin value does not drift the layout');
  await writeFile(join(stateDir,'result.json'),JSON.stringify({status:'passed',checks,diagnostics,layout:changed.dshLayout},null,2));
}finally{child.kill();await bridge.close();}
