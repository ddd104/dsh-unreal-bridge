/** Optional Cordis services must be read in their injected child context.
 * Adding/removing one never remounts the bridge or discards write barriers. */
export function optionalServices(ctx,names) {
  const contexts=new Map();
  for(const name of names)ctx.inject?.([name],child=>{
    contexts.set(name,child);
    child.effect(()=>()=>{if(contexts.get(name)===child)contexts.delete(name);});
  });
  return name=>{
    const child=contexts.get(name);
    if(child)return child.get?.(name)??child[name];
    // Standalone embeddings/tests may supply plain objects without a registry.
    try{return ctx.get?.(name)??ctx[name];}catch{return undefined;}
  };
}
