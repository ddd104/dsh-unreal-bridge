// Run using the installed DSH Electron in Node mode, as for visual-runtime-check.mjs.
// Uses the real installed Cordis, filesystem and skill registry; no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {apply} from '../lib/index.js';

const args={};
for(let index=2;index<process.argv.length;index+=2){
  const key=process.argv[index];
  if(!['--runtime','--project','--output'].includes(key)||!process.argv[index+1])throw new Error('Expected --runtime, --project or --output followed by a path');
  args[key]=resolve(process.argv[index+1]);
}
const runtime=args['--runtime']??join(dirname(process.execPath),'resources','app.asar','dsh');
const runtimeRequire=createRequire(join(runtime,'package.json'));
const {Context}=runtimeRequire('@deepseek-ai/cordis');
const {LocalFileSystem}=runtimeRequire('@deepseek-ai/dsh-fs-local');
const {SkillRegistry}=runtimeRequire('@deepseek-ai/dsh-skill');
const temp=fs.mkdtempSync(join(tmpdir(),'dsh-skills-runtime-'));
let context;
try{
  const project=join(temp,'Game'),other=join(temp,'Other'),child=join(project,'Source');
  const directory=join(project,'Plugins','DSHUnrealBridge','Skills','runtime-fixture');
  fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(child,{recursive:true});fs.mkdirSync(other);
  fs.writeFileSync(join(project,'Game.uproject'),'{}');fs.writeFileSync(join(other,'Other.uproject'),'{}');
  fs.writeFileSync(join(project,'Plugins','DSHUnrealBridge','DSHUnrealBridge.uplugin'),'{}');
  const instruction=join(directory,'SKILL.md');
  const body=text=>`---\nname: runtime-fixture\ndescription: Offline workspace skill fixture\n---\n${text}\n`;
  fs.writeFileSync(instruction,body('Read references/example.md when needed.'));
  context=new Context();
  context.provide('tools',{register(){}});
  context.provide('systemPrompt',{section(){}});
  context.provide('typert',{register(){}});
  new LocalFileSystem(context,{cwd:project,diffBasisMaxBytes:1024*1024});
  new SkillRegistry(context);
  await apply(context,{port:0,stateDir:join(temp,'bridge')});
  const skills=context.skills;
  const snapshot=await skills.snapshot({cwd:child});
  assert.equal(snapshot.complete,true);
  assert.deepEqual(snapshot.skills.map(skill=>skill.name),['runtime-fixture']);
  const definition=await skills.get('runtime-fixture',{cwd:child});
  assert.equal(definition.resourceBase.path,directory);
  assert.match(definition.content,/references\/example.md/);
  assert.equal(definition.provider,'unreal-bridge-project');
  assert.equal((await skills.snapshot({cwd:other})).skills.length,0);
  assert.equal(await skills.get('runtime-fixture',{cwd:other}),undefined);
  fs.writeFileSync(instruction,body('Updated body from the plugin directory.'));
  assert.match((await skills.get('runtime-fixture',{cwd:child})).content,/Updated body/);
  assert.equal(context.unrealBridge.bridge.list().length,0,'skills must load without an editor connection');
  let actualProject;
  if(args['--project']){
    const cwd=fs.statSync(args['--project']).isDirectory()?args['--project']:dirname(args['--project']);
    const available=await skills.snapshot({cwd});
    assert.equal(available.complete,true);
    actualProject={cwd,skills:[]};
    for(const summary of available.skills){
      const loaded=await skills.get(summary.name,{cwd});assert.ok(loaded?.content);
      actualProject.skills.push({name:summary.name,path:loaded.path,resourceBase:loaded.resourceBase});
    }
  }
  const record={result:'PASS',checkedAt:new Date().toISOString(),node:process.versions.node,
    assertions:['built plugin activates its skill provider in installed DSH',
      'installed filesystem and skill registry discover a project and its subdirectory',
      'another UE project cannot discover or load this skill',
      'relative resource base and current body are preserved',
      'no editor connection or model call is needed'],actualProject};
  if(args['--output'])fs.writeFileSync(args['--output'],`${JSON.stringify(record,null,2)}\n`);
  console.log(JSON.stringify(record));
}finally{
  await context?.fiber.dispose();
  if(!resolve(temp).startsWith(resolve(tmpdir())+sep)||!basename(temp).startsWith('dsh-skills-runtime-'))throw new Error('Refusing unexpected cleanup path');
  fs.rmSync(temp,{recursive:true,force:true});
}
