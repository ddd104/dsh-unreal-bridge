import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// 编译两个原有工具，始终复用当前插件的 Node 运行环境。
const root = path.dirname(fileURLToPath(import.meta.url));
for (const name of ['ProjectGraph', 'ProjectMemorySystem']) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, name, 'tsconfig.json')], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
