import {readFile,writeFile,mkdir,mkdtemp,copyFile,readdir,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'dist/dsh');
function run(command,args,cwd=root){
  const result=spawnSync(command,args,{cwd,stdio:'inherit',shell:false});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${command} exited with ${result.status}`);
}
await mkdir(output,{recursive:true});
// A fresh staging directory keeps old sourcemaps and development files out.
const stage=await mkdtemp(join(output,'.stage-'));
run(process.execPath,[join(root,'scripts/build.mjs'),'--release','--outdir',join(stage,'lib')]);
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
delete manifest.scripts;
delete manifest.devDependencies;
manifest.files=['lib','cordis.patch.yml','LICENSE','THIRD_PARTY_NOTICES.md'];
await writeFile(join(stage,'package.json'),JSON.stringify(manifest,null,2)+'\n');
for(const name of ['cordis.patch.yml','LICENSE','THIRD_PARTY_NOTICES.md'])await copyFile(join(root,name),join(stage,name));
const files=await readdir(join(stage,'lib'));
if(files.length!==3||files.some(name=>!['index.js','client.js','remote.js'].includes(name)))throw new Error('Unexpected release build files');
for(const name of files){
  const content=await readFile(join(stage,'lib',name),'utf8');
  if(/sourceMappingURL|sourcesContent/.test(content))throw new Error(`Source map data in ${name}`);
}
// npm's JS entry avoids Windows shell quoting when paths contain spaces.
const npmCli=process.env.npm_execpath;
if(!npmCli||!/[\\/]npm-cli\.js$/i.test(npmCli))throw new Error('Run this script with npm run package:dsh');
run(process.execPath,[npmCli,'pack',stage,'--pack-destination',output,'--ignore-scripts']);
// stage is the absolute, freshly created directory below the release output.
if(dirname(stage)!==output)throw new Error('Staging directory escaped the release output');
await rm(stage,{recursive:true,force:true});
for(const name of ['install-dsh-release.ps1','resolve-dsh-cli.ps1'])await copyFile(join(root,'scripts',name),join(output,name));
await writeFile(join(output,'install-dsh.bat'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-dsh-release.ps1" %*\r\nif errorlevel 1 (pause & exit /b 1)\r\npause\r\n');
await writeFile(join(output,'INSTALL.txt'),`DSH Unreal Bridge ${manifest.version}\r\n\r\n1. Install DeepSeek Harness.\r\n2. Double-click install-dsh.bat.\r\n3. Fully exit DSH (including the tray) and reopen it.\r\n\r\nThe installer defaults to the desktop profile and needs no project source or system Node.js.\r\nInternet access may be required to install npm dependencies.\r\nCompiled JavaScript remains readable; this package is not source encryption.\r\n`);
console.log(`Release ready: ${output}\nDistribute the .tgz, both .ps1 files, install-dsh.bat and INSTALL.txt.`);
