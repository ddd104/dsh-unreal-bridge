import {dirname,isAbsolute,join,normalize,resolve} from 'node:path';
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem';

const NAME='unreal-bridge-project',RANK=350,MAX_PROJECTS=32;
const absent=error=>['ENOENT','ENOTDIR','FS_NOT_FOUND','FS_NOT_DIRECTORY'].includes(error?.code);

/** Register workspace-local UE plugin skills; the caller owns the returned async disposer. */
export function registerProjectSkills(ctx) {
  const service=name=>ctx.get?.(name)??ctx[name];
  const warn=message=>ctx.logger?.warn?.(`[Unreal Bridge skills] ${message}`);
  const skills=service('skills'),fs=service('fs');
  if(!skills?.registerProvider||!fs?.resolve||!fs?.stat||!fs?.listDir||!fs?.readText||!fs?.processPath){
    warn('Project skills are disabled: the DSH skills and filesystem services are required.');
    return async()=>{};
  }

  // The native provider reads through ctx.fs, but its watchers run on the host.
  // Require an explicit same-world mapping rather than guessing from target keys.
  if(typeof fs.processPathFromHostPath!=='function'){
    warn('Project skills are disabled: this filesystem cannot confirm access to the local workspace.');
    return async()=>{};
  }
  const delegateContext={get:name=>name==='fs'?fs:service(name),logger:ctx.logger??{warn(){}}};
  const projects=new Map(),entries=new Set(),closing=new Set();
  let control,disposed=false,disposal,removeObservation,unregister,reportedMapping=false;
  const check=signal=>{signal?.throwIfAborted();control?.signal.throwIfAborted();};

  async function probe(path,signal){
    check(signal);
    try{
      const target=await fs.resolve(path,{signal});check(signal);
      const info=await fs.stat(target,signal);check(signal);
      return {target,info};
    }catch(error){check(signal);if(absent(error))return undefined;throw error;}
  }

  async function locate(options){
    const {cwd,signal}=options;check(signal);
    if(typeof cwd!=='string'||!cwd.trim())return undefined;
    const initial=await probe(cwd,signal);
    if(initial?.info?.type!=='directory')return undefined;
    const path=initial.target.displayPath;
    if(typeof path!=='string'||!isAbsolute(path)||normalize(fs.processPathFromHostPath(path)??'')!==normalize(path)){
      if(!reportedMapping){warn('Project skills are unavailable in this workspace: its filesystem does not map to the local host.');reportedMapping=true;}
      return undefined;
    }
    let current=resolve(path);
    while(true){
      check(signal);
      const directory=await probe(current,signal);
      if(directory?.info?.type!=='directory')return undefined;
      let entries;
      try{entries=await fs.listDir(directory.target,signal);}
      catch(error){check(signal);if(absent(error))return undefined;throw error;}
      check(signal);
      if(entries.some(entry=>entry.type==='file'&&entry.name.toLowerCase().endsWith('.uproject'))){
        const pluginRoot=join(current,'Plugins','DSHUnrealBridge');
        // A nearer UE project is a boundary even if it has no bridge plugin.
        return {key:directory.target.targetKey,path:current,skillsPath:join(pluginRoot,'Skills')};
      }
      const parent=dirname(current);if(parent===current)return undefined;current=parent;
    }
  }

  function retire(entry,force=false){
    entry.retired=true;
    if((entry.users&&!force)||entry.closing)return;
    entry.lifecycle.abort(new Error('UE project skill provider disposed'));
    const pending=entry.provider.dispose().catch(error=>warn(`Could not close a project skill watcher: ${error.message}`));
    entry.closing=pending;closing.add(pending);
    void pending.finally(()=>{closing.delete(pending);entries.delete(entry);});
  }

  function acquire(project){
    let entry=projects.get(project.key);
    // The same identity may have moved to a different display path.
    if(entry&&entry.path!==project.path){projects.delete(project.key);retire(entry);control.invalidate();entry=undefined;}
    if(!entry){
      const lifecycle=new AbortController();
      entry={path:project.path,lifecycle,users:0,retired:false};
      entry.provider=new FileSystemSkillProvider(delegateContext,{
        signal:lifecycle.signal,
        invalidate:()=>{if(!disposed&&!entry.retired)control.invalidate();},
      },{providerName:NAME,includeDefaultRoots:false,customSkillDirs:[project.skillsPath]});
      entries.add(entry);
    }
    projects.delete(project.key);projects.set(project.key,entry);entry.users++;
    while(projects.size>MAX_PROJECTS){
      const [key,oldest]=projects.entries().next().value;projects.delete(key);retire(oldest);
      // Registry catalogs must not outlive the watchers that keep them fresh.
      control.invalidate();
    }
    return {provider:entry.provider,release(){entry.users--;if(entry.retired)retire(entry);}};
  }

  function stop(){
    if(disposed)return;
    disposed=true;removeObservation?.();
    for(const entry of entries)retire(entry,true);
    projects.clear();
  }

  unregister=skills.registerProvider(registration=>{
    control=registration;control.signal.addEventListener('abort',stop,{once:true});
    return {
      name:NAME,
      async list(options={}){
        if(disposed)return [];
        const project=await locate(options);
        if(!project)return [];
        const lease=acquire(project);
        try{
          const result=await lease.provider.list(options);check(options.signal);
          const candidates=(Array.isArray(result)?result:result.candidates).map(candidate=>({
            ...candidate,provider:NAME,source:'unreal-plugin',rank:RANK,
            locator:{projectKey:project.key,candidate},
          }));
          return Array.isArray(result)?candidates:{...result,candidates};
        }finally{lease.release();}
      },
      async get(candidate,options={}){
        if(disposed)return undefined;
        const project=await locate(options),locator=candidate?.locator;
        if(!project||project.key!==locator?.projectKey||!locator.candidate)return undefined;
        const lease=acquire(project);
        try{
          const skill=await lease.provider.get(locator.candidate,options);check(options.signal);
          return skill?{...skill,provider:NAME,source:'unreal-plugin'}:undefined;
        }finally{lease.release();}
      },
    };
  });

  removeObservation=ctx.on?.('fs/observed',(target,_observation,actor)=>{
    if(disposed||!['write','edit'].includes(actor?.name)||typeof target?.displayPath!=='string')return;
    for(const entry of projects.values())entry.provider.observeHostMutation(target.displayPath);
    if(/\.(uproject|uplugin)$/i.test(target.displayPath))control.invalidate();
  });

  return ()=>{
    disposal??=(async()=>{
      stop();unregister?.();control.signal.removeEventListener('abort',stop);
      while(closing.size)await Promise.all([...closing]);
    })();
    return disposal;
  };
}
