import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
await mkdir('lib',{recursive:true});
await build({entryPoints:['src/index.mjs'],outfile:'lib/index.js',bundle:true,platform:'node',format:'esm',target:'node22',external:['ws','sharp','ajv','@deepseek-ai/dsh-skill-filesystem','@deepseek-ai/schemastery'],sourcemap:true});
await build({entryPoints:['src/remote.mjs'],outfile:'lib/remote.js',bundle:true,platform:'browser',format:'esm',target:'es2022'});
const client=await build({entryPoints:['src/client.mjs'],bundle:true,platform:'browser',format:'cjs',target:'es2022',external:['react'],write:false});
await writeFile('lib/client.js',`window.__ModuleLoader__.load({id:'dsh-unreal-bridge',factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
console.log('Built DSH host, conversation dock and Remote descriptors.');
