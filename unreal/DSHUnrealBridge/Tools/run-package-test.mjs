import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
// 单包命令也使用插件 Node，不通过 PATH 寻找 npm、tsc 或 node。
const root=path.dirname(fileURLToPath(import.meta.url));
const name=process.argv[2];
if(!['ProjectGraph','ProjectMemorySystem'].includes(name)) throw new Error('Unknown tool package');
const temp=path.resolve(root,'../Cache/TestRuns/Temp');mkdirSync(temp,{recursive:true});
const options={cwd:path.join(root,name),stdio:'inherit',windowsHide:true,env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp}};
for(const args of [[path.join(root,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],['--test','dist/test/*.test.js']]) {
 const result=spawnSync(process.execPath,args,options);if(result.status!==0)process.exit(result.status??1);
}
