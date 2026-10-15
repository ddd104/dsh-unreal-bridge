# DSH Unreal Bridge 0.1.2

DeepSeek Harness 对话插件与 Unreal Editor 插件。对话分别绑定本机 UE 实例，在聊天输入框上方显示当前 Content Browser 选区，通过模型工具读取、预览、修改、编译和保存普通蓝图。

## 本机安装

本交付面向 Windows、已安装的 DSH 0.2.0-rc.2，以及 EHV 使用的 UEAS58（UE 5.8.0）。DSH 源码目录 `F:\AI\deepseek-harness` 用于核对扩展接口；插件独立安装到 DSH desktop 配置，不修改核心代码。UE 插件安装在 `F:\UE5Project\EHV\Plugins\DSHUnrealBridge`。

发行包内含 DSH 的 `.tgz` 安装包、UE 插件源码与本机引擎对应的 DLL，以及完整插件源码和测试。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Project 'F:\UE5Project\EHV\EHV.uproject'
```

安装脚本先备份 DSH 配置，使用 DSH 官方插件命令安装 bundle，再复制 UE 插件。重复安装会备份已有 UE 插件。安装或升级前关闭目标 UE 编辑器；DSH 界面未自动更新时完整退出并重新打开 DSH。脚本不会结束任何应用。

## 使用

1. 打开 DSH 与 EHV。聊天输入框上方会出现 **Unreal Editor** 区域，选择 EHV 实例；每个对话分别选择。
2. 在 UE 的 Content Browser 选中普通蓝图，返回 DSH 提问。选区变化只更新显示和本地缓存，不主动调用模型。
3. 例如：“读取当前选中的蓝图，在 BeginPlay 后增加 PrintString，打印 Hello。先预览，确认后应用，不要保存。”
4. 在 DSH 的批准提示中允许后，修改才会执行。模型应先读当前版本，再查询函数/引脚、生成补丁、预览并应用。
5. 检查编辑器后明确要求保存；也可要求撤销最近一次插件图修改。

**权限模式：** 插件默认调用 DSH 批准服务。DSH 的 `approval: never` 会拒绝这类请求，因此需要在该对话选择允许询问批准的模式（例如本机的 `workspace-write`）。插件不会更改你的全局权限设置。`requireApproval: false` 是配置选项，仅适合你明确决定无需逐次批准的环境。

## 已实现

| 功能 | 行为 |
| --- | --- |
| 实例发现与会话隔离 | UE 主动连接本机桥接器；显示项目、PID、引擎版本；每个对话独立绑定 |
| 选区与蓝图变化 | 编辑器事件推送；已读取蓝图的变化使旧预览失效；UI 从 DSH 缓存刷新 |
| 读取与 Token 控制 | 默认返回图摘要；可按图、节点编号读取节点/引脚/连接 |
| 函数目录 | 搜索已加载的原生 BlueprintCallable / BlueprintEvent 函数及其引脚 |
| 创建 | 新建 Actor、ActorComponent、Object 普通蓝图，拒绝覆盖现有资产 |
| 节点修改 | 添加原生函数/事件节点、删除、移动、设置输入默认值、连接/断开 |
| 预览与编译 | 临时副本验证补丁并编译，原资产不变；实际执行再次检查版本 |
| 冲突、撤销与保存 | 版本变化拒绝提交；仅撤销仍位于撤销栈顶部的插件图修改；显式编译并保存 |
| 连接可靠性 | 自动重连、心跳、请求超时、请求编号去重、未知结果查询 |
| 本机访问控制 | 仅监听 127.0.0.1、随机令牌、写操作批准、审计日志；没有远程执行脚本接口 |

## 支持范围

- 仅普通 `UBlueprint` 和 `/Game/` 资产。Widget、AnimBlueprint、材质、场景编辑、自定义蓝图函数调用、变量创建、组件树修改、宏/分支等特殊节点不在本版本操作集合中。
- 原生函数必须已加载且对蓝图公开；废弃和内部函数被过滤。事件必须适用于资产父类。引脚连接不隐式拆线或增加转换节点。
- 默认值不支持对象、类及本地化文本引用。每次补丁最多 100 个操作。响应上限 2 MiB；较大图应按图/节点筛选读取。
- 冲突采用拒绝并重新读取/预览；没有自动三方合并、任意历史版本回滚或跨进程持久化撤销。创建新资产不提供插件删除工具。
- 当前仅验证 Windows、本机 DSH 0.2.0-rc.2 和 UEAS58。其他 UE 构建应重新编译；macOS/Linux 只有路径处理代码，未经编译与运行验证。
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
