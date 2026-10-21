# DSH 插件发行与安装

在项目根目录执行（打包机器需要 Node.js 22+）：

```powershell
npm ci
npm run package:dsh
```

已安装开发依赖时可以跳过 `npm ci`。输出位于 `dist/dsh/`：

- `dsh-unreal-bridge-版本.tgz`
- `install-dsh.bat`
- `install-dsh-release.ps1`
- `resolve-dsh-cli.ps1`
- `INSTALL.txt`

将这五个文件放在同一目录交付，安装机器双击 `install-dsh.bat`，完成后完整退出 DSH（包括托盘）再打开。无需 UE 工程、项目源码或系统 Node.js；安装依赖可能需要联网。默认安装到已初始化的 `desktop` 配置。

也可以执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-dsh-release.ps1
```

指定安装包、配置或 DSH 安装路径：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-dsh-release.ps1 -Archive "D:\Downloads\dsh-unreal-bridge-0.6.0.tgz" -Profile desktop -DshCli "D:\Apps\DeepSeek Harness"
```

安装脚本通过 DSH 官方 `plugin add` 命令安装。修改前备份配置，安装包按 SHA256 保存在配置目录，避免升级后仍使用同版本的旧包。失败时报告备份目录，不自动覆盖恢复其他配置。若目录中有多个版本的 `.tgz`，需显式指定 `-Archive`。

发行构建使用独立临时目录，只打包三个压缩后的 JS 文件、插件配置、包声明和许可文件；不包含 `src/`、测试、开发文档或 sourcemap，不改变开发构建的 `lib/`。不包含 UE 插件，也不是离线依赖包。JavaScript 仍可阅读或还原，不是源码加密。第三方依赖仍受各自许可证约束。
