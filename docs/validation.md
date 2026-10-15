# 本机验证记录

日期：2026-10-14。交付版本：0.1.2。系统：Windows；Node：24.15.0；已安装 DSH：0.2.0-rc.2；引擎：UEAS58 / UE 5.8.0-0+UE5；目标工程：`F:\UE5Project\EHV\EHV.uproject`。

## 已通过的检查

| 检查 | 结果 |
| --- | --- |
| JavaScript 构建与测试 | `npm run check` 成功，15 项测试通过 |
| DSH 实际安装版本的宿主接口 | 真实 Cordis、TypertRegistry、TypertGateway；10 个工具的参数/输出 schema 校验及 state 调用通过 |
| UE 独立工程编译 | 使用本机 UEAS58 与 Visual Studio 工具链，成功 |
| EHV 工程插件编译 | `EHVEditor Win64 Development -Module=DSHUnrealBridge` 成功；工程原有的其他插件依赖声明警告仍存在 |
| UE 原生自动化 | `DSH.Bridge.BlueprintRoundTrip`、`DSH.Bridge.RejectUnsafeInputs` 均成功，进程退出码 0 |
| 真正 WebSocket 与 UE 的端到端测试 | 7 组流程通过，详见下方 |
| 实际 DSH Web 页面 | 浏览器加载正式 DSH profile，插件显示、真实 UE 实例列举、会话绑定、解除绑定通过；未出现浏览器运行错误 |
| 安装与脚本 | 官方 DSH 插件安装命令成功；安装/卸载脚本语法检查通过；未对用户环境执行卸载 |

15 项 JavaScript 测试覆盖认证拒绝、UE 回环 Origin、会话隔离、事件顺序、输入校验、预览归属与失效、请求去重、未知结果查询、只读模式、进行中请求的绑定保护、真实批准结果门控、客户端 Remote 挂载及结果解包、面板操作、旧会话响应隔离。

UE 自动化覆盖原生蓝图创建、稳定版本、连接已有 BeginPlay 节点的临时副本预览、不修改原图、应用与编译、中文内容变化的版本检测、旧版本拒绝、撤销恢复和路径拒绝。

真实 UE 网络测试结果：

```text
PASS: real UE instance authenticated and registered
PASS: native function catalog and exact pin metadata
PASS: create, preview, connected graph patch, compile and read-back
PASS: editor-side stale revision rejection
PASS: owned editor undo restores blueprint
PASS: explicit save in disposable project
PASS: editor reconnect keeps conversation binding
{"status":"passed","engine":"5.8.0-0+UE5","tests":7}
```

## 安装与数据保护

DSH 插件安装进用户 desktop profile；该 profile 自动加载了宿主桥接服务。现有 `cordis.patch.yml` 未修改。首次安装前备份位于 `%USERPROFILE%\.dsh\profiles\desktop\.plugin-manager\dsh-unreal-bridge-backups\20261014-225025-456`。

UE 插件新增至 `F:\UE5Project\EHV\Plugins\DSHUnrealBridge`。没有改动 `EHV.uproject`；插件使用 Editor-only 模块和 EnabledByDefault。没有编辑 EHV 的蓝图、地图或其他资产。原有 `Script/Binds.Cache.Headers` 修改仍保留。`F:\AI\deepseek-harness` 源码工作区没有修改。

测试创建和保存的蓝图仅位于独立的可丢弃 HostProject。最终 ZIP 不包含测试资产、node_modules、DSH 数据、令牌、用户凭据、UE 中间文件或 PDB。编译 DLL 对应本机引擎 BuildId `4372b68f-d352-4ab4-b85c-67441ca62d24`。

## 验证边界

- 未进行付费模型端到端生成测试，没有读取或使用用户 API Key。已验证工具注册、批准服务调用接口和直接蓝图执行，模型是否生成适合实际业务的补丁仍取决于所选模型与提示。
- Content Browser 选区事件传输、会话隔离和面板显示经过受控事件测试；后台无界面 UE 的脚本点选未产生可验证的真实选区结果，因此没有将真实 GUI 点选列为通过项。
- EHV 中验证了插件编译与引擎二进制兼容性，没有启动并修改用户工程资产。完整蓝图写入测试在独立工程完成。
- 未验证 DSH 源码目录中的 0.2.1-alpha.3 构建、其他 UE 版本或其他操作系统。完整交付范围及不支持的蓝图类型见 README。

## 2026-10-15 MCP 接入增量验证

- `npm run check` 成功，17 项 JavaScript 测试通过；新增测试覆盖按会话绑定发现 MCP 工具、实际调用的批准门控与请求去重、旧版 UE 不支持 MCP 时的明确报错。
- 使用本机 UEAS58 对新增 `DSHUnrealBridgeMCP` 模块与主模块执行 `BuildPlugin`，两个模块编译、链接成功。
- 在独立的可丢弃 UE 工程启动真实编辑器，发现 `list_toolsets`、`describe_toolset`、`call_tool`，读取 `AssetTools` schema，并直接调用资产搜索、文件夹创建、存在性查询、移动和删除；请求状态查询返回完成。脚本执行工具调用被拒绝。
- 已将新二进制和源码同步至 EHV 插件目录，旧目录备份在 `F:\UE5Project\EHV\Saved\DSHUnrealBridgeBackups\mcp-20261015-151104`；DSH desktop 宿主 bundle 已同步，旧 bundle 备份在 `%USERPROFILE%\.dsh\profiles\desktop\.plugin-manager\dsh-unreal-bridge-backups\mcp-20261015-151120`。DSH 进程需重启后加载新宿主代码。
- 没有修改 EHV 项目的资产；增删改查验证只作用于临时工程。未针对 EHV 的业务资产执行 MCP 写入。

## 2026-10-15 MCP 默认执行修复（宿主 0.1.3）

- `npm run check` 成功，17 项测试通过；MCP 顶层工具和工具集调用在批准服务拒绝时仍能执行，且继续验证会话绑定、请求编号去重和不支持 MCP 的编辑器报错。
- 蓝图补丁应用、撤销和保存仍使用原有 DSH 批准流程；UE MCP 层的脚本执行拦截与 `allowWrites` 写入开关未更改。
- 对话指导明确优先使用蓝图默认对象及属性 MCP 工具查询类默认值，不生成 `.uasset` 解析脚本。
