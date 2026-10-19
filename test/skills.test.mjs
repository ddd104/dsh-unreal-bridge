import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,relative,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Context} from '@deepseek-ai/cordis';
import {SkillRegistry} from '@deepseek-ai/dsh-skill';
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem';
import {registerProjectSkills} from '../src/skills.mjs';

const skill=(name,body=`Instructions for ${name}.`,frontmatter='')=>`---\nname: ${name}\ndescription: Use ${name} in this project.\n${frontmatter}---\n${body}\n`;
const candidates=result=>Array.isArray(result)?result:result.candidates;
const names=rows=>rows.map(row=>row.name).sort();
const absent=error=>error.code==='ENOENT'||error.code==='ENOTDIR';

async function put(path,content){
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,content,'utf8');
  return path;
}

function localFileSystem(reads){
  const target=path=>({targetKey:resolve(path),displayPath:resolve(path)});
  return {
    async resolve(path,options={}){options.signal?.throwIfAborted();return target(resolve(options.cwd??'.',path));},
    processPath:entry=>entry.displayPath,
    processPathFromHostPath:path=>resolve(path),
    async stat(entry,signal){
      signal?.throwIfAborted();
      try{
        const info=await stat(entry.displayPath);
        return {type:info.isDirectory()?'directory':info.isFile()?'file':'other',size:info.size,version:String(info.mtimeMs)};
      }catch(error){if(absent(error))return undefined;throw error;}
    },
    async listDir(entry,signal){
      signal?.throwIfAborted();
      return (await readdir(entry.displayPath,{withFileTypes:true})).map(child=>({
        name:child.name,type:child.isDirectory()?'directory':child.isFile()?'file':'other',target:target(join(entry.displayPath,child.name)),
      }));
    },
    async readText(entry,signal){
      signal?.throwIfAborted();reads.push(entry.displayPath);
      return readFile(entry.displayPath,{encoding:'utf8',signal});
    },
  };
}

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'dsh-project-skills-'));
  const ctx=new Context();const registry=new SkillRegistry(ctx);const reads=[];
  const fs=localFileSystem(reads);ctx.provide('fs',fs);
  let provider;let changes=0;
  ctx.on('skills/change',()=>changes++);
  const skills={registerProvider(create){return ctx.skills.registerProvider(control=>{provider=create(control);return provider;});}};
  const pluginContext={
    skills,fs,logger:ctx.logger,on:(...args)=>ctx.on(...args),
    get:name=>name==='skills'?skills:ctx.get(name),
  };
  const dispose=registerProjectSkills(pluginContext);
  assert.equal(typeof dispose,'function');
  assert.equal(provider.name,'unreal-bridge-project');
  const disposeEffect=ctx.effect(()=>dispose,'test project skill lifecycle');
  t.after(async()=>{await disposeEffect();await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true});});
  async function project(name,{plugin=true,skillsDirectory=true}={}){
    const root=join(directory,name);const uproject=await put(join(root,`${name}.uproject`),'{}');
    const pluginRoot=join(root,'Plugins','DSHUnrealBridge');const skillsRoot=join(pluginRoot,'Skills');
    if(plugin)await put(join(pluginRoot,'DSHUnrealBridge.uplugin'),'{}');
    if(skillsDirectory)await mkdir(skillsRoot,{recursive:true});
    return {root,uproject,pluginRoot,skillsRoot,skill:(name,body,frontmatter)=>put(join(skillsRoot,name,'SKILL.md'),skill(name,body,frontmatter))};
  }
  return {directory,ctx,registry,provider,dispose:disposeEffect,project,reads,get changes(){return changes;}};
}

async function eventually(check,message){
  const deadline=Date.now()+8000;
  do{if(await check())return;await delay(40);}while(Date.now()<deadline);
  assert.fail(message);
}

test('project plugin skills are discovered from UE workspace and child directories without Git or an editor',async t=>{
  const f=await fixture(t);const a=await f.project('ProjectA',{plugin:false});
  await a.skill('unreal-workflow');
  const child=join(a.root,'Source','Game');await mkdir(child,{recursive:true});
  for(const cwd of [a.root,child]){
    const rows=candidates(await f.provider.list({cwd}));
    assert.deepEqual(names(rows),['unreal-workflow']);
    assert.equal(rows[0].rank,350);assert.equal(rows[0].source,'unreal-plugin');
    assert.equal(rows[0].provider,'unreal-bridge-project');
    assert.deepEqual(names(await f.registry.list({cwd})),['unreal-workflow']);
  }
  assert.ok(f.reads.length>0);
  assert.ok(f.reads.every(path=>!relative(f.directory,path).startsWith('..')),'skill contents only come from temporary projects');
});

test('nearest .uproject is the boundary and plugin-only or non-UE workspaces contribute no skills',async t=>{
  const f=await fixture(t);const outer=await f.project('Outer');await outer.skill('outer-only');
  await mkdir(join(f.directory,'.git'));
  const nested=join(outer.root,'Examples','Nested');await put(join(nested,'Nested.uproject'),'{}');
  await mkdir(join(nested,'Source'),{recursive:true});
  const noPlugin=await f.project('NoPlugin',{plugin:false,skillsDirectory:false});
  const loose=join(f.directory,'Loose');
  await put(join(loose,'Plugins','DSHUnrealBridge','DSHUnrealBridge.uplugin'),'{}');
  await put(join(loose,'Plugins','DSHUnrealBridge','Skills','loose','SKILL.md'),skill('loose'));
  for(const cwd of [undefined,f.directory,nested,join(nested,'Source'),noPlugin.root,loose]){
    const result=await f.provider.list({cwd});
    assert.deepEqual(candidates(result),[],String(cwd));
    assert.equal(Array.isArray(result)||result.complete,true,'an empty plugin directory is a complete catalog');
  }
});

test('several directory and flat skills retain native YAML policies and relative resource bases',async t=>{
  const f=await fixture(t);const p=await f.project('Policies');
  const folder=join(p.skillsRoot,'any-directory-name');
  await put(join(folder,'SKILL.md'),skill('human-only','Read [reference](references/details.md) and run scripts/check.py.','disable-model-invocation: true\nwhenToUse: Explicit project requests\nmetadata:\n  owner: project-team\n'));
  await put(join(folder,'references','details.md'),'Project-specific details.');
  await put(join(folder,'scripts','check.py'),'print("project")');
  await put(join(p.skillsRoot,'model.md'),skill('model-only','Use the local reference.md.','user-invocable: false\n'));
  await p.skill('both');
  await put(join(p.skillsRoot,'legacy.md'),skill('legacy','','disableModelInvocation: true\n'));
  await put(join(p.skillsRoot,'invalid.md'),'# Missing frontmatter');
  const listed=await f.registry.list({cwd:p.root});
  assert.deepEqual(names(listed),['both','human-only','model-only']);
  const human=await f.registry.get('human-only',{cwd:p.root});
  assert.deepEqual(human.invocation,{modelInvocable:false,userInvocable:true});
  assert.deepEqual(human.resourceBase,{kind:'directory',path:folder});
  assert.equal(human.whenToUse,'Explicit project requests');
  assert.deepEqual(human.metadata,{owner:'project-team'});
  assert.equal(human.content,'Read [reference](references/details.md) and run scripts/check.py.');
  assert.equal(await readFile(join(human.resourceBase.path,'references','details.md'),'utf8'),'Project-specific details.');
  const model=await f.registry.get('model-only',{cwd:p.root});
  assert.deepEqual(model.invocation,{modelInvocable:true,userInvocable:false});
  assert.deepEqual(model.resourceBase,{kind:'directory',path:p.skillsRoot});
  assert.deepEqual((await f.registry.get('both',{cwd:p.root})).invocation,{modelInvocable:true,userInvocable:true});
});

test('catalog and direct loads stay isolated when switching between projects',async t=>{
  const f=await fixture(t);const a=await f.project('A');const b=await f.project('B');
  await a.skill('project-a');await a.skill('shared','A body');
  await b.skill('project-b');await b.skill('shared','B body');
  const rows=candidates(await f.provider.list({cwd:a.root}));
  const fromA=rows.find(row=>row.name==='shared');
  assert.equal(await f.provider.get(fromA,{cwd:b.root}),undefined);
  assert.equal(await f.provider.get(fromA,{}),undefined);
  assert.equal(await f.provider.get(fromA,{cwd:f.directory}),undefined);
  assert.deepEqual(names(await f.registry.list({cwd:a.root})),['project-a','shared']);
  assert.deepEqual(names(await f.registry.list({cwd:b.root})),['project-b','shared']);
  assert.equal((await f.registry.get('shared',{cwd:b.root})).content,'B body');
  assert.equal(await f.registry.get('project-a',{cwd:b.root}),undefined);
  assert.equal((await f.registry.get('shared',{cwd:a.root})).content,'A body');
  await rm(a.uproject);
  assert.equal(await f.provider.get(fromA,{cwd:a.root}),undefined,'get revalidates the project marker');
});

test('plugin skill registration coexists with multiple custom filesystem skills at their native rank',async t=>{
  const f=await fixture(t);const p=await f.project('Ranks');
  await p.skill('shared','Plugin body');await p.skill('plugin-only');
  const custom=join(f.directory,'CustomSkills');
  await put(join(custom,'shared.md'),skill('shared','Custom body'));
  await put(join(custom,'custom-one','SKILL.md'),skill('custom-one'));
  await put(join(custom,'custom-two.md'),skill('custom-two'));
  let native;
  const unregister=f.ctx.skills.registerProvider(control=>native=new FileSystemSkillProvider(f.ctx,control,{includeDefaultRoots:false,customSkillDirs:[custom]}));
  t.after(async()=>{await unregister();await native.dispose();});
  assert.deepEqual(names(await f.registry.list({cwd:p.root})),['custom-one','custom-two','plugin-only','shared']);
  assert.equal((await f.registry.get('shared',{cwd:p.root})).content,'Custom body');
  assert.equal((await f.registry.get('shared',{cwd:p.root})).provider,'filesystem');
  assert.deepEqual(names(await f.registry.list({cwd:f.directory})),['custom-one','custom-two','shared']);
});

test('loads reread skill bodies after catalog discovery and return undefined for removed files',async t=>{
  const f=await fixture(t);const p=await f.project('Reread');
  const path=await p.skill('changing','Original body');
  await f.registry.list({cwd:p.root});
  await writeFile(path,skill('changing','Edited body'),'utf8');
  assert.equal((await f.registry.get('changing',{cwd:p.root})).content,'Edited body');
  await rm(path);
  assert.equal(await f.registry.get('changing',{cwd:p.root}),undefined);
});

test('filesystem changes invalidate cached catalogs for added, edited, and removed skill files',async t=>{
  const f=await fixture(t);const p=await f.project('Watching');
  const original=await p.skill('original');
  assert.deepEqual(names(await f.registry.list({cwd:p.root})),['original']);
  const initial=f.changes;
  const added=await p.skill('added');
  await eventually(async()=>names(await f.registry.list({cwd:p.root})).join(',')==='added,original','new skill was not observed');
  assert.ok(f.changes>initial,'watcher notifies the skill registry');
  await writeFile(added,skill('renamed','New body'),'utf8');
  await eventually(async()=>names(await f.registry.list({cwd:p.root})).join(',')==='original,renamed','frontmatter changes were not observed');
  await rm(original);
  await eventually(async()=>names(await f.registry.list({cwd:p.root})).join(',')==='renamed','removed skill was not observed');
  assert.equal((await f.registry.get('renamed',{cwd:p.root})).content,'New body');
});

test('missing plugin skill directories produce a complete empty catalog and are observed when installed',async t=>{
  const f=await fixture(t);const p=await f.project('InstallLater',{plugin:false,skillsDirectory:false});
  assert.deepEqual(await f.registry.snapshot({cwd:p.root}),{skills:[],complete:true});
  await p.skill('newly-installed');
  await eventually(async()=>names(await f.registry.list({cwd:p.root})).join(',')==='newly-installed','a newly installed plugin skill directory was not observed');
  assert.equal((await f.registry.get('newly-installed',{cwd:p.root})).content,'Instructions for newly-installed.');
});

test('disposing unregisters project skills, closes watchers, and ignores later mutations',async t=>{
  const f=await fixture(t);const p=await f.project('Disposing');
  const path=await p.skill('temporary');
  assert.deepEqual(names(await f.registry.list({cwd:p.root})),['temporary']);
  await f.dispose();await f.dispose();
  assert.deepEqual(await f.registry.list({cwd:p.root}),[]);
  const changes=f.changes;
  await writeFile(path,skill('after-dispose'),'utf8');
  f.ctx.emit('fs/observed',{displayPath:path},{kind:'present',version:'test'},{name:'write'});
  await delay(450);
  assert.equal(f.changes,changes,'late filesystem events do not invalidate disposed registrations');
  assert.deepEqual(await f.registry.list({cwd:p.root}),[]);
});
