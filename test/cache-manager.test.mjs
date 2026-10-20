import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,lstat,symlink,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CacheManager} from '../src/cache-manager.mjs';

const DAY=86400000,MiB=1024*1024,session='a'.repeat(24);
const absent=async path=>{await assert.rejects(lstat(path),{code:'ENOENT'});};
async function fixture(t,initial={}){
  const sandbox=await mkdtemp(join(tmpdir(),'dsh-cache-policy-')),stateDir=join(sandbox,'state');
  await mkdir(stateDir);
  let config=Object.freeze(initial),time=Date.UTC(2026,9,20);
  const cache=new CacheManager({stateDir,getConfig:()=>config,now:()=>time});
  t.after(async()=>{await cache.dispose();await rm(sandbox,{recursive:true,force:true});});
  return {sandbox,stateDir,cache,setConfig:value=>{config=Object.freeze(value);},advance:days=>{time+=days*DAY;},now:()=>time};
}
async function entry(f,{bytes=10,age=0,name='crop.png'}={}){
  const dir=await f.cache.createDirectory(session,randomUUID());
  await writeFile(join(dir,name),Buffer.alloc(bytes,1));
  const time=new Date(f.now()-age*DAY);
  await utimes(join(dir,name),time,time);await utimes(dir,time,time);return dir;
}

test('status only inspects; policy removes old owned evidence and archives without touching active audit, credentials or other files',async t=>{
  const f=await fixture(t,{visualCacheRetentionDays:10,auditRetentionDays:10,auditMaxArchives:2});
  const old=await entry(f,{age:20}),current=await entry(f);
  const oldArchive=join(f.stateDir,`audit-${f.now()-20*DAY}.jsonl`),recentArchive=join(f.stateDir,`audit-${f.now()-DAY}.jsonl`);
  await writeFile(oldArchive,'old');await writeFile(recentArchive,'recent');
  const protectedNames=['audit.jsonl','bridge.json','write-locks.json','audit-123.jsonl','audit-other.jsonl'];
  for(const name of protectedNames)await writeFile(join(f.stateDir,name),name);
  await mkdir(join(f.stateDir,'project-cache'));await writeFile(join(f.stateDir,'project-cache','keep'),'project');
  const status=await f.cache.status();assert.equal(status.visual.entries,2);assert.equal(status.audit.archives,2);assert.equal(status.busy,false);
  assert.equal((await lstat(old)).isDirectory(),true,'Status must never delete');
  const result=await f.cache.cleanup({mode:'policy'});
  assert.equal(result.deleted.visualEntries,1);assert.equal(result.deleted.auditArchives,1);
  await absent(old);await absent(oldArchive);
  assert.ok(await lstat(current));assert.ok(await lstat(recentArchive));
  for(const name of protectedNames)assert.equal(await readFile(join(f.stateDir,name),'utf8'),name);
  assert.equal(await readFile(join(f.stateDir,'project-cache','keep'),'utf8'),'project');
});

test('new policy takes effect on the next cleanup and limits visual bytes plus archive count',async t=>{
  const f=await fixture(t,{visualCacheMaxMiB:5,auditMaxArchives:10});
  const older=await entry(f,{bytes:800000,age:2}),newer=await entry(f,{bytes:800000,age:1});
  for(let index=0;index<3;index++)await writeFile(join(f.stateDir,`audit-${f.now()-index*1000}.jsonl`),'audit');
  assert.equal((await f.cache.cleanup()).deleted.visualEntries,0);
  f.setConfig({visualCacheMaxMiB:1,auditMaxArchives:1});
  assert.ok(await lstat(older),'Saving a policy must not delete immediately');
  const cleaned=await f.cache.cleanup();assert.equal(cleaned.deleted.visualEntries,1);assert.equal(cleaned.deleted.auditArchives,2);
  await absent(older);assert.ok(await lstat(newer));assert.ok((await f.cache.status()).visual.bytes<=MiB);
  f.setConfig({auditMaxArchives:0});assert.equal((await f.cache.cleanup()).deleted.auditArchives,1);
});

test('published capture retention can exceed the capacity target; explicit idle cleanup expires it, while active pins always win',async t=>{
  const f=await fixture(t,{visualCacheMaxMiB:1,visualCacheRetentionDays:1});
  const retained=await entry(f,{bytes:1200000,age:2});f.cache.retain(retained,f.now()+10*DAY);
  const events=[];f.cache.subscribeEvictions(event=>events.push(event));
  let result=await f.cache.cleanup();assert.equal(result.deleted.visualEntries,0);assert.equal(result.skipped.retained,1);
  const status=await f.cache.status();assert.equal(status.visual.retainedEntries,1);assert.ok(status.visual.overBudgetBytes>0);
  const release=f.cache.protect([join(retained,'crop.png')]);
  result=await f.cache.cleanup({mode:'all_idle'});assert.equal(result.deleted.visualEntries,0);assert.equal(result.skipped.busy,1);
  release();release();
  result=await f.cache.cleanup({mode:'all_idle'});assert.equal(result.deleted.visualEntries,1);
  assert.deepEqual(events,[{path:retained,reason:'cache_cleanup'}]);await absent(retained);
});

test('expired reservations and failed empty output directories are eligible for cleanup',async t=>{
  const f=await fixture(t,{visualCacheRetentionDays:1});
  const path=await entry(f,{age:2});f.cache.retain(path,f.now()+DAY);f.advance(2);
  const empty=await f.cache.createDirectory(session,randomUUID());
  await utimes(empty,new Date(f.now()),new Date(f.now()));
  assert.equal((await f.cache.cleanup()).deleted.visualEntries,1);await absent(path);
  assert.equal((await f.cache.cleanup({mode:'all_idle'})).deleted.visualEntries,1);await absent(empty);
});

test('links and unexpected files are never traversed or deleted',async t=>{
  const f=await fixture(t);
  const outside=join(f.sandbox,'outside');await mkdir(outside);await writeFile(join(outside,'crop.png'),'external');
  const valid=await entry(f),unowned=await entry(f,{name:'user-document.txt'});
  const linked=join(f.cache.root,session,randomUUID());
  await symlink(outside,linked,process.platform==='win32'?'junction':'dir');
  const archive=join(f.stateDir,`audit-${f.now()}.jsonl`);await symlink(join(outside,'crop.png'),archive,'file');
  const fileLinked=await f.cache.createDirectory(session,randomUUID());await symlink(join(outside,'crop.png'),join(fileLinked,'crop.png'),'file');
  const result=await f.cache.cleanup({mode:'all_idle'});
  assert.equal(result.deleted.visualEntries,1);assert.ok(result.skipped.unsafe>=3);await absent(valid);
  assert.equal(await readFile(join(outside,'crop.png'),'utf8'),'external');
  assert.ok((await lstat(linked)).isSymbolicLink());assert.ok((await lstat(archive)).isSymbolicLink());
  assert.equal(await readFile(join(unowned,'user-document.txt'),'utf8'),'\u0001'.repeat(10));
  assert.ok((await lstat(join(fileLinked,'crop.png'))).isSymbolicLink());
});

test('a redirected visual root or state root fails closed before deletion or directory allocation',async t=>{
  const f=await fixture(t),outside=join(f.sandbox,'outside');await mkdir(outside);await writeFile(join(outside,'keep'),'external');
  await symlink(outside,f.cache.root,process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.cache.cleanup({mode:'all_idle'}),{code:'CACHE_UNSAFE_PATH'});
  await assert.rejects(f.cache.createDirectory(session,randomUUID()),{code:'CACHE_UNSAFE_PATH'});
  const redirected=join(f.sandbox,'redirected');await symlink(f.stateDir,redirected,process.platform==='win32'?'junction':'dir');
  const other=new CacheManager({stateDir:redirected});t.after(()=>other.dispose());
  await assert.rejects(other.cleanup({mode:'all_idle'}),{code:'CACHE_UNSAFE_PATH'});
  assert.equal(await readFile(join(outside,'keep'),'utf8'),'external');
});

test('cleanup serializes button actions and prevents evidence readers from entering a directory already admitted for deletion',async t=>{
  const f=await fixture(t),path=await entry(f),entered=Promise.withResolvers(),release=Promise.withResolvers();
  const remove=f.cache.deleteEntry.bind(f.cache);
  f.cache.deleteEntry=async directory=>{entered.resolve();await release.promise;return remove(directory);};
  const pending=f.cache.cleanup({mode:'all_idle'});await entered.promise;
  try{
    assert.equal((await f.cache.status()).busy,true);
    await assert.rejects(f.cache.cleanup({mode:'all_idle'}),{code:'CACHE_BUSY'});
    assert.throws(()=>f.cache.protect([join(path,'crop.png')]),{code:'CAPTURE_EXPIRED'});
  }finally{release.resolve();}
  await pending;assert.equal((await f.cache.status()).busy,false);
});

test('Windows case variants share the same active evidence pin and retained deadline',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),path=await entry(f,{age:40}),variant=path.toUpperCase();
  assert.equal(f.cache.entryPath(variant),f.cache.entryPath(path));
  const release=f.cache.protect([join(variant,'CROP.PNG')]);
  try{assert.equal((await f.cache.cleanup({mode:'all_idle'})).skipped.busy,1);}finally{release();}
  f.cache.retain(variant,f.now()+DAY);
  assert.equal((await f.cache.cleanup()).skipped.retained,1);
  assert.equal((await f.cache.cleanup({mode:'all_idle'})).deleted.visualEntries,1);
});

test('disposal waits for a cleanup already removing evidence to finish',async t=>{
  const f=await fixture(t),path=await entry(f),entered=Promise.withResolvers(),release=Promise.withResolvers();
  const remove=f.cache.deleteEntry.bind(f.cache);
  f.cache.deleteEntry=async directory=>{entered.resolve();await release.promise;return remove(directory);};
  const pending=f.cache.cleanup({mode:'all_idle'});await entered.promise;
  let finished=false;
  const disposing=Promise.resolve(f.cache.dispose()).then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);
  release.resolve();await disposing;await pending;
  assert.equal(finished,true);await absent(path);
});

test('allocation rejects path traversal and maintenance starts only explicitly with a disposable timer',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.cache.createDirectory('../outside',randomUUID()),TypeError);
  await assert.rejects(f.cache.createDirectory(session,'../../outside'),TypeError);
  let calls=0;f.cache.cleanup=async({mode})=>{assert.equal(mode,'policy');calls++;};
  assert.equal(calls,0);f.cache.start();await Promise.resolve();assert.equal(calls,1);assert.ok(f.cache.timer);
  f.cache.start();assert.equal(calls,1);f.cache.dispose();assert.equal(f.cache.timer,null);
});
