import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
const root=path.dirname(fileURLToPath(import.meta.url));
const temp=path.resolve(root,'../Cache/TestRuns/Temp');mkdirSync(temp,{recursive:true});
// 原测试使用包内相对 fixtures，按各包目录启动并继承插件 Node。
for (const [directory,pattern] of [['ProjectGraph','dist/test/*.test.js'],['ProjectMemorySystem','dist/test/*.test.js'],['.','test/*.test.mjs']]) {
  const result=spawnSync(process.execPath,['--test',pattern],{cwd:path.join(root,directory),stdio:'inherit',windowsHide:true,env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp}});
  if(result.status!==0) process.exit(result.status??1);
}
