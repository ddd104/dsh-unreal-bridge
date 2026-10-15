# DSH Unreal Bridge 0.2.1

DeepSeek Harness 对话插件与 Unreal Editor 插件。对话分别绑定本机 UE 实例，在聊天输入框上方显示当前 Content Browser 选区，并通过同一连接使用 UE MCP 工具和项目知识查询。

## 本机安装

本交付面向 Windows、已安装的 DSH 0.2.0-rc.2，以及 EHV 使用的 UEAS58（UE 5.8.0）。DSH 源码目录 `F:\AI\deepseek-harness` 用于核对扩展接口；插件独立安装到 DSH desktop 配置，不修改核心代码。UE 插件安装在 `F:\UE5Project\EHV\Plugins\DSHUnrealBridge`。

Git 仓库包含 DSH 与 UE 插件源码。UE DLL 由目标引擎编译；知识模块使用安装时准备的 Node.js 24.15.0 和已编译工具。

从 Git 拉取源码后，在 Windows 上双击 `install-dsh.bat`，即可构建安装包并将插件安装到当前用户的 DSH `desktop` 配置。也可以在命令行传入 `.uproject` 路径，同时复制 UE 插件：

```bat
install-dsh.bat "D:\UnrealProjects\MyGame\MyGame.uproject"
```

批处理需要 Node.js 22+、npm 和已安装的 DSH；安装程序会从命令路径与 Windows 安装记录中查找 DSH CLI。若自动查找失败，可按提示输入 DSH 安装目录或 `dsh.cmd` 的完整路径，也可预先设置环境变量 `DSH_CLI`。安装 UE 插件时，准备脚本会下载并校验固定版本的 Node.js 24.15.0，构建知识工具；运行期不依赖系统 Node。Git 仓库不包含 UE 预编译 DLL，UE 插件需要使用目标工程对应的 Unreal Engine 编译。安装完成后完整退出并重新打开 DSH。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Project 'F:\UE5Project\EHV\EHV.uproject'
```

安装脚本先备份 DSH 配置，使用 DSH 官方插件命令安装 bundle，再复制 UE 插件。重复安装会备份已有 UE 插件，并保留工程已修改的知识配置与现有缓存。安装或升级前关闭目标 UE 编辑器；DSH 界面未自动更新时完整退出并重新打开 DSH。脚本不会结束任何应用。

## 使用

1. 打开 DSH 与 EHV。聊天输入框上方会出现 **Unreal Editor** 区域，选择 EHV 实例；每个对话分别选择。
2. 在 UE 的 Content Browser 选中普通蓝图，返回 DSH 提问。选区变化只更新显示和本地缓存，不主动调用模型。
3. 例如：“读取当前选中的蓝图，在 BeginPlay 后增加 PrintString，打印 Hello。先预览，确认后应用，不要保存。”
4. 在 DSH 的批准提示中允许后，修改才会执行。模型应先读当前版本，再查询函数/引脚、生成补丁、预览并应用。
5. 检查编辑器后明确要求保存；也可要求撤销最近一次插件图修改。

对其他资产提出查询、创建、修改或删除要求时，DSH 先列出 UE 5.8 MCP 工具集、读取目标工具的参数说明，再直接调用已绑定编辑器里的工具。无需生成 Python、Shell 或 Editor Utility 脚本。实际可用操作取决于工程启用的 UE 工具集；本机 EHV 已启用 `ModelContextProtocol` 与 `AllToolsets`。脚本执行型 MCP 工具在桥接层被拒绝。

## 项目图谱与资料

`DSHUnrealBridgeKnowledge` 是同一个 UE 插件中的编辑器模块。它从源码、配置、项目资料和 UE 资产快照生成图谱与记忆。Agent 使用已绑定编辑器上的 `unreal_knowledge` 查询 `project_status`、`project_context`、`project_search`、`graph_query`、`graph_feature`、`graph_impact`、`read_source` 和分页资产快照；需要保留带来源的结论时，用 `unreal_knowledge_record` 保存。它不启动独立的 Graph/Memory MCP 服务，也不开放旧的固定端口 HTTP 服务；实时资产修改继续走 UE MCP。

把人工维护的项目说明放在工程的 `ProjectKnowledge/`、`Docs/` 等目录；生成的索引、记忆与快照在 `Plugins/DSHUnrealBridge/Cache/`。插件配置在 `Config/Knowledge/ProjectMemory.project.json`，支持文本、Markdown、JSON、CSV、YAML、INI、`.proto`、DOCX 和 XLSX。PDF 与旧 `.xls` 需先转为受支持格式。需要新鲜的全项目知识时，在 UE 编辑器菜单中执行“更新项目图谱与知识记忆”。常规查询不会自动重建；图谱命中与记忆摘要应由当前源码和编辑器状态核实。

安装脚本发现旧 `AgentProjectGraph/Cache` 时，会复制其 UE 快照及证据到新插件缓存，再把旧插件移入工程的 `Saved/DSHUnrealBridgeBackups/`，避免旧菜单与 HTTP 服务继续加载。旧图谱和记忆不会直接复用；在编辑器中更新一次即可按新路径重建。

**权限模式：** MCP 工具调用默认直接执行，无需逐次批准；这也包括 MCP 工具集中的资产写入操作。`allowWrites: false` 仍会禁用 MCP 调用和其他写入。插件自己的蓝图应用、撤销和保存仍调用 DSH 批准服务；`approval: never` 会拒绝这些操作。`requireApproval: false` 只控制插件自己的蓝图写入批准，不影响 MCP 的默认执行方式。

## 已实现

| 功能 | 行为 |
| --- | --- |
| 实例发现与会话隔离 | UE 主动连接本机桥接器；显示项目、PID、引擎版本；每个对话独立绑定 |
| 选区与蓝图变化 | 编辑器事件推送；已读取蓝图的变化使旧预览失效；UI 从 DSH 缓存刷新 |
| UE 5.8 MCP 工具 | 独立 `DSHUnrealBridgeMCP` 模块直接访问当前编辑器注册的工具；支持发现工具集、读取 schema 和按名调用 |
| 项目知识 | 同插件的 `DSHUnrealBridgeKnowledge` 编辑器模块提供源码、资料、图谱与分页资产快照查询；缓存有项目身份和新鲜度校验 |
| 读取与 Token 控制 | 默认返回图摘要；可按图、节点编号读取节点/引脚/连接 |
| 函数目录 | 搜索已加载的原生 BlueprintCallable / BlueprintEvent 函数及其引脚 |
| 创建 | 新建 Actor、ActorComponent、Object 普通蓝图，拒绝覆盖现有资产 |
| 节点修改 | 添加原生函数/事件节点、删除、移动、设置输入默认值、连接/断开 |
| 预览与编译 | 临时副本验证补丁并编译，原资产不变；实际执行再次检查版本 |
| 冲突、撤销与保存 | 版本变化拒绝提交；仅撤销仍位于撤销栈顶部的插件图修改；显式编译并保存 |
| 连接可靠性 | 自动重连、心跳、请求超时、请求编号去重、未知结果查询 |
| 本机访问控制 | 仅监听 127.0.0.1、随机令牌、写操作批准、审计日志；没有远程执行脚本接口 |

## 支持范围

- 本插件自带的蓝图图操作仅支持普通 `UBlueprint` 和 `/Game/` 资产。其他资产操作由当前 UE 5.8 实例实际注册的 MCP 工具集决定；可先发现工具与参数，不承诺每一种资产类型都有对应的工具。
- MCP 工具可能立即保存、移动或删除资产，默认直接执行；这些工具不使用本插件的蓝图预览与版本校验。`ProgrammaticToolset` 等脚本执行入口被桥接层禁用。
- 原生函数必须已加载且对蓝图公开；废弃和内部函数被过滤。事件必须适用于资产父类。引脚连接不隐式拆线或增加转换节点。
- 默认值不支持对象、类及本地化文本引用。每次补丁最多 100 个操作。响应上限 2 MiB；较大图应按图/节点筛选读取。
- 冲突采用拒绝并重新读取/预览；没有自动三方合并、任意历史版本回滚或跨进程持久化撤销。创建新资产不提供插件删除工具。
- 当前仅验证 Windows、本机 DSH 0.2.0-rc.2 和 UEAS58。知识模块和固定 Node 运行环境只面向 Win64；其他 UE 构建应重新编译并提供对应运行环境。
- 会话绑定与预览在 DSH 进程内保存；重启 DSH 后重新绑定。断线重连同一编辑器保留绑定。写请求日志在 UE 进程内保存，不能恢复已退出编辑器的执行结果。

## 配置与排错

在 DSH profile 的 `cordis.patch.yml` 中按插件 ID 覆盖配置：

```yaml
- id: dsh-unreal-bridge
  config:
    port: 17891
    allowWrites: true
    requireApproval: true
    requestTimeoutMs: 30000
```

连接描述文件默认位于 `%LOCALAPPDATA%\DSHUnrealBridge\bridge.json`，审计记录为同目录的 `audit.jsonl`。描述文件含临时令牌，请勿分享。Windows 使用当前用户目录的继承权限；不隔离同一 Windows 用户下的其他程序。

若修改 `stateDir`，UE 需以 `-DSHBridgeDescriptor="绝对路径\bridge.json"` 启动。多个 DSH host 应使用不同端口和状态目录。端口被占用时插件会报错，不自动接管其他进程。

`CONFLICT` / `PREVIEW_EXPIRED`：重新读取、预览。`BUSY`：退出 PIE、结束当前事务后再试。`OUTCOME_UNKNOWN`：先调用 `unreal_request_status`，不可换新请求编号盲目重复写入。如果编辑器已经重启、原请求记录无法查询，人工检查资产后在新对话中重新读取再规划；旧对话保持写入保护。`UNDO_NOT_LATEST`：请使用 UE 的撤销历史。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -Project 'F:\UE5Project\EHV\EHV.uproject'
```

脚本使用 DSH 插件命令移除 bundle，把 UE 插件移入项目 `Saved/DSHUnrealBridgeBackups`，不删除蓝图资产，不恢复整份旧 DSH 配置以免覆盖后续设置。重启应用后生效。

## 开发与验证

从 Git 仓库获取源码并构建 DSH 安装包：

```powershell
git clone https://github.com/ddd104/dsh-unreal-bridge.git
cd dsh-unreal-bridge
npm ci
npm run check
npm pack --pack-destination ..
```

然后运行上方安装脚本，将 `-Project` 指向自己的 Unreal 工程。Git 仓库包含 UE 插件源码；预编译 DLL 不提交到 Git，需使用目标工程对应的 Unreal Engine 构建 Editor 目标。

`src` 为宿主与客户端源码，`lib` 为 DSH 可加载产物，`unreal` 为 Editor 模块。UE 自动化测试位于 `DSH.Bridge`。`scripts/ue-e2e.mjs` 只应针对可丢弃的测试工程运行，会创建和保存测试蓝图；不可对 EHV 等生产工程运行。具体工具协议见 [docs/protocol.md](docs/protocol.md)，本次验证证据见 [docs/validation.md](docs/validation.md)。
