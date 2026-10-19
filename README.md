# DSH Unreal Bridge 0.4.0

DeepSeek Harness 对话插件与 Unreal Editor 插件。对话分别绑定本机 UE 实例，在聊天输入框上方显示当前 Content Browser 资产、关卡 Actor 或组件选区，并通过同一连接使用 UE MCP 工具和项目知识查询。

## 本机安装

本交付面向 Windows、本机已安装的 DSH，以及 EHV 使用的 UEAS58（当前 UE 5.8.2）。DSH 源码目录 `F:\AI\deepseek-harness` 用于核对扩展接口；插件独立安装到 DSH desktop 配置，不修改核心代码。UE 插件安装在 `F:\UE5Project\EHV\Plugins\DSHUnrealBridge`。旧版 0.2.0-rc.2 的验证保留在历史记录中；视觉功能另已核对实际安装的 0.2.1-rc.1 组件接口。

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
2. 在 UE 的 Content Browser 选择资产，或在关卡视口、场景大纲中选择 Actor，也可在细节面板中选择 Actor 的组件。打开 Actor 蓝图后，在 Components 面板中点击组件也会同步。DSH 显示最近操作的选区；组件优先于其所属 Actor。支持多选及清空，选区变化只更新显示和本地缓存，不主动调用模型。
3. 例如：“读取当前选中的蓝图，在 BeginPlay 后增加 PrintString，打印 Hello。先预览，确认后应用，不要保存。”
4. 模型先读当前版本，再查询函数/引脚、生成补丁、预览并应用。安装配置中 `requireApproval: false` 时，应用不再弹出 DSH 批准提示。
5. 检查编辑器后明确要求保存；也可要求撤销最近一次插件图修改。

对其他资产提出查询、创建、修改或删除要求时，DSH 先列出 UE 5.8 MCP 工具集、读取目标工具的参数说明，再直接调用已绑定编辑器里的工具。无需生成 Python、Shell 或 Editor Utility 脚本。实际可用操作取决于工程启用的 UE 工具集；本机 EHV 已启用 `ModelContextProtocol` 与 `AllToolsets`。脚本执行型 MCP 工具在桥接层被拒绝。

关卡选区包含对象类型、名称、显示名、实例路径、世界路径，以及可用的类蓝图路径；组件还包含所属 Actor。实例属性操作使用实例路径；修改类蓝图逻辑使用蓝图资产路径。原生 Actor 或组件可能没有类蓝图。关卡选区同步需要 UE 插件声明 `level_selection` 能力，并配套更新 DSH 插件。

Actor 蓝图编辑器内的组件显示为“蓝图组件”，同步组件模板路径、变量名、所属 Actor 蓝图及继承标记，不附加关卡实例路径。点击蓝图树中的 Actor 根项时显示蓝图资产；关闭当前蓝图后清空其选区。该功能需要 `blueprint_component_selection` 能力，并配套更新 DSH 插件。

## PIE 运行实例诊断

运行或模拟游戏时，可以选择正在运行的 Actor/组件，再让 DSH 读取现场并联查相关逻辑。例如：“读取当前运行 Actor 的状态，检查可见性、组件变换和相关变量，结合蓝图与源码分析为什么显示异常。”选区与运行状态变化只刷新面板；读取快照由明确的诊断请求触发，不自动采集属性或调用模型。

在 PIE 的场景大纲中选择运行实例，或按 F8 弹出控制后再选择；SIE 也支持选区同步。F8 本身不会暂停游戏，需要稳定现场时先在编辑器中暂停。游戏画面里的普通点击通常属于游戏输入，不等于编辑器选区。面板将运行实例与编辑世界对象区分，显示运行/暂停状态、世界及 PIE 实例的客户端或服务器身份，避免把同名实例混淆。

`unreal_runtime_snapshot` 按需读取选中实例的当前反射属性、可用的类默认值、类继承信息及可选的 Actor 组件状态，帮助对照运行值与初始配置。它还返回变换、可见性、Mesh 及材质引用等可用信息，不包含材质实例的全部动态参数。集合分页有独立偏移和数量限制。省略 `target` 仅适用于当前恰好选中一个 PIE Actor/组件；多选时应明确指定完整目标身份。快照包含采集时间和帧号；运行中采样只是该帧状态，需要一致的现场时使用暂停。

目标使用“本次 PIE 运行编号＋世界编号＋对象编号”标识，不以路径或名称重新绑定。Actor/对象销毁、世界卸载、结束 PIE 后，相应目标立即失效；再次运行会得到新的运行编号，必须选择新的实例。暂停、继续或 F8 切换保留当前实例身份。读取前仍会检查目标有效性，销毁期间的请求会明确失败，不回退到同名对象。

每次运行最多跟踪 1024 个活跃对象句柄，包含已查看的 Actor 和组件。达到上限时回收最久未访问的句柄，并将对应旧快照标记为“跟踪句柄已回收”；这不表示对象已销毁。历史数据继续保留，重新选择仍存活的对象会生成新句柄。

已采集的快照作为当前对话的历史数据保留，面板明确显示采集时间以及销毁、运行结束或编辑器离线等状态。`unreal_runtime_history` 可列出摘要，也可用 `snapshotId` 读取完整历史快照；编辑器离线后仍可读取已保留的数据。最多保留最近 20 份，总计不超过 16 MiB，超限移除最旧数据；数据保存在 DSH 进程内，重启宿主后不保留。未采集过的状态无法在销毁后补取。

运行快照配合蓝图静态图、C++ 或 AngelScript 源码可以定位候选逻辑，但它不是执行 Trace，不能证明此前实际经过哪些节点或调用。自动追踪、断点和销毁前连续录像不在本次范围内。局部画面截图工具仍只支持编辑器视口，不能直接捕获 PIE 游戏画面。

## 局部画面对比

在当前对话绑定编辑器后，上传参考图（或提供本机图片路径），在关卡中选中一个 Actor/组件，然后说：“对比这张参考图与当前选中的物体，用中文说明差异。”也可以指定视口像素矩形，或要求先捕获当前画面作为基准。工具会返回对照图、可计算时的色差热图、指标和本机证据路径；支持图片的当前 DSH 模型直接读取持久化图片附件并解释，无需配置第二个模型服务。

`unreal_visual_capture` 支持关卡实例、矩形区域与完整视口；`unreal_visual_compare` 支持外部设计图的辅助评审，以及已确认相同相机、尺度和曝光的截图回归。默认辅助评审保留 `unknown` 结论；回归模式只有显式确认条件一致时才给通过/失败。不同尺寸不拉伸配准，不做像素级验收。Actor 裁剪为包含背景与遮挡的包围矩形，不代表目标分割。

只关心天空等局部区域的色彩、但两图构图或尺寸不同，可使用 `analysis: color_distribution`，分别指定参考图和当前截图的矩形区域。工具统计颜色均值/中位数、Lab 与线性相对亮度分布，保留咨询性结论，不把图像亮度比解释成曝光差。0.3.1 修复了 UE 相机负零数值触发 DSH 严格 JSON 输出校验的问题，该修复仅涉及 DSH 宿主；0.4.0 的 PIE 诊断需要同时更新 DSH 宿主和重新编译 UE 插件。

首版仅支持编辑器关卡视口、单帧 SDR PNG/JPEG/WebP 比较；不支持 PIE/UMG、蓝图预览组件、HDR、动态闪烁或自动调参。比较原图最多 8 Mi 像素，参考输入最多 20 MiB。图片或附件服务不可用时仍返回指标和证据路径，并明确说明模型没有看到图片。详情和参数见 [局部画面对比](docs/visual-comparison.md)。

## 项目图谱与资料

DSH 会按当前会话的工作区，向上找到最近的 `.uproject` 工程，将该工程 `Plugins/DSHUnrealBridge/Skills/` 中的技能接入原生技能列表。支持 `<技能目录>/SKILL.md` 和平铺的 `.md`；文件需包含有效的 `name`、`description` YAML 头。工程根目录及其 `Source/`、`Script/` 等子目录均可作为工作区，不要求 Git 仓库，也不要求 UE 编辑器在线。工作区上方有多个工程时，使用最近的工程，不扫描并列工程。

例如 EHV 插件中的 `ue-project-graph` 和自行加入插件 `Skills/` 的 `sr-proto-handler` 会在 EHV 工作区中可用。新增、删除、修改技能会刷新目录，调用 DSH 原生 `skill` 工具时直接读取当前正文，相对引用的脚本、资料与资源从该技能目录解析。项目 `.dsh/skills`、`.agents/skills` 及显式配置的自定义技能在同名时优先于插件技能；其他工程的技能不会随 UE 会话绑定而加入当前工作区。此功能面向本机 Windows 工作区；远程文件系统不会映射到宿主本机的同名目录。更新 DSH 桥接插件并重启 DSH 后生效，无需复制技能到用户全局目录或重新编译 UE DLL。

`DSHUnrealBridgeKnowledge` 是同一个 UE 插件中的编辑器模块。它从源码、配置、项目资料和 UE 资产快照生成图谱与记忆。Agent 使用已绑定编辑器上的 `unreal_knowledge` 查询 `project_status`、`project_context`、`project_search`、`graph_query`、`graph_feature`、`graph_impact`、`read_source` 和分页资产快照；需要保留带来源的结论时，用 `unreal_knowledge_record` 保存。它不启动独立的 Graph/Memory MCP 服务，也不开放旧的固定端口 HTTP 服务；实时资产修改继续走 UE MCP。

把人工维护的项目说明放在工程的 `ProjectKnowledge/`、`Docs/` 等目录；生成的索引、记忆与快照在 `Plugins/DSHUnrealBridge/Cache/`。插件配置在 `Config/Knowledge/ProjectMemory.project.json`，支持文本、Markdown、JSON、CSV、YAML、INI、DOCX、XLSX、旧版 XLS，以及 `.proto`。`.proto` 会提取消息、字段、枚举和 RPC，保留原文；`.xls` 会提取工作表名称与单元格内容。PDF 仍需先转为受支持格式。需要新鲜的全项目知识时，在 UE 编辑器菜单中执行“更新项目图谱与知识记忆”。常规查询不会自动重建；图谱命中与记忆摘要应由当前源码和编辑器状态核实。

安装脚本发现旧 `AgentProjectGraph/Cache` 时，会复制其 UE 快照及证据到新插件缓存，再把旧插件移入工程的 `Saved/DSHUnrealBridgeBackups/`，避免旧菜单与 HTTP 服务继续加载。旧图谱和记忆不会直接复用；在编辑器中更新一次即可按新路径重建。

**权限模式：** MCP 工具调用默认直接执行，无需逐次批准；这也包括 MCP 工具集中的资产写入操作。`allowWrites: false` 仍会禁用 MCP 调用和其他写入。安装配置将 `requireApproval` 设为 `false`，使蓝图应用、撤销、保存和项目知识记录不再调用 DSH 批准服务，适配 `approval: never` 的会话。预览、版本校验、请求去重及显式保存要求仍然生效。若希望这些写入逐次请求批准，可将 `requireApproval` 改为 `true`，并使用 `approval: ask` 的 DSH preset。

## 已实现

| 功能 | 行为 |
| --- | --- |
| 实例发现与会话隔离 | UE 主动连接本机桥接器；显示项目、PID、引擎版本；每个对话独立绑定 |
| 选区与蓝图变化 | 编辑器事件推送；已读取蓝图的变化使旧预览失效；UI 从 DSH 缓存刷新 |
| PIE 实例诊断 | 同步运行 Actor/组件、运行/暂停状态和世界身份；按需采集反射属性快照，目标失效后保留带时间和状态的历史 |
| UE 5.8 MCP 工具 | 独立 `DSHUnrealBridgeMCP` 模块直接访问当前编辑器注册的工具；支持发现工具集、读取 schema 和按名调用 |
| DataTable 字段复制 | 原生批量深复制指定字段，内存快照校验源行及其他字段，失败回滚；不经过整表 JSON/TSV，不保存或操作窗口 |
| 执行熔断 | UE 任务激活后限制本轮全部工具、模型步数、累计错误及耗时；达到阈值由宿主取消本轮，阻止换工具或脚本继续修补 |
| 项目知识 | 同插件的 `DSHUnrealBridgeKnowledge` 编辑器模块提供源码、资料、图谱与分页资产快照查询；缓存有项目身份和新鲜度校验 |
| 读取与 Token 控制 | 默认返回图摘要；可按图、节点编号读取节点/引脚/连接 |
| 函数目录 | 搜索已加载的原生 BlueprintCallable / BlueprintEvent 函数及其引脚 |
| 创建 | 新建 Actor、ActorComponent、Object 普通蓝图，拒绝覆盖现有资产 |
| 节点修改 | 添加原生函数/事件节点、删除、移动、设置输入默认值、连接/断开 |
| 修改后展示 | 成功创建或修改资产后自动打开并最大化编辑器窗口；蓝图、动画蓝图和材质在可识别节点时聚焦修改区域；`unreal_focus_asset` 可手动重新打开和定位 |

已选中蓝图的局部修改优先直接读取目标图、批量预览、应用并核验，无需先搜索整个工程或引擎源码。图读取会返回节点启用状态和是否为默认幽灵事件；连接默认 BeginPlay 的执行引脚即可激活它。`unreal_state` 同时返回实际批准配置和编辑器能力，方便直接发现配置或插件版本问题。

更新并重启 UE 插件后，`unreal_state` 会显示 `custom_event_patch` 能力。此时定时器等局部逻辑可以在同一补丁里添加自定义事件、原生 `Set Timer by Event` 函数节点、默认值和连线，避免逐节点调用 UE MCP。蓝图任务默认以预览编译、应用编译和一次图回读作为验收；只有明确要求运行时验证，或静态检查无法确定必要行为且确认有关 Actor 实例在运行时，才启动 PIE。查询其他 UE MCP 工具时，`unreal_mcp_describe` 可用 `query` 按工具名过滤，并用 `includeSchema: false` 先取得简短列表。

修改后展示需要正在运行的 UE 插件声明 `focus_asset` 能力。MCP 的 `{refPath: ...}` 资产、图和节点引用均可识别；对 `write_graph_dsl` 等不返回节点编号的图修改，桥接在目标图内比较修改前后状态以定位变化节点，不增加模型调用。更新源代码后，需要安装编译产物并重启 UE；更新 DSH 插件后也需要重启宿主。
| 预览与编译 | 临时副本验证补丁并编译，原资产不变；实际执行再次检查版本 |
| 冲突、撤销与保存 | 版本变化拒绝提交；仅撤销仍位于撤销栈顶部的插件图修改；显式编译并保存 |
| 连接可靠性 | 自动重连、心跳、请求超时、请求编号去重、未知结果查询 |
| 本机访问控制 | 仅监听 127.0.0.1、随机令牌、可选写操作批准、审计日志；没有远程执行脚本接口 |

## 支持范围

- 本插件自带的蓝图图操作仅支持普通 `UBlueprint` 和 `/Game/` 资产。其他资产操作由当前 UE 5.8 实例实际注册的 MCP 工具集决定；可先发现工具与参数，不承诺每一种资产类型都有对应的工具。
- MCP 工具可能立即保存、移动或删除资产，默认直接执行；这些工具不使用本插件的蓝图预览与版本校验。`ProgrammaticToolset` 等脚本执行入口被桥接层禁用。
- 展示行为由编辑器内统一服务执行，不改变资产写入结果。MCP 工具只有在成功返回且提供可识别的目标资产路径时才会自动展示；无法识别节点时打开资产并保留当前画布视角。删除后的资产无法打开。停靠的资产标签页会激活并最大化所在 UE 窗口，不强制弹出独立窗口。
- 原生函数必须已加载且对蓝图公开；废弃和内部函数被过滤。事件必须适用于资产父类。引脚连接不隐式拆线或增加转换节点。
- 默认值不支持对象、类及本地化文本引用。每次补丁最多 100 个操作。响应上限 2 MiB；较大图应按图/节点筛选读取。
- 冲突采用拒绝并重新读取/预览；没有自动三方合并、任意历史版本回滚或跨进程持久化撤销。创建新资产不提供插件删除工具。
- 当前仅验证 Windows、本机 DSH 0.2.0-rc.2 和 UEAS58。知识模块和固定 Node 运行环境只面向 Win64；其他 UE 构建应重新编译并提供对应运行环境。
- 会话绑定与预览在 DSH 进程内保存；重启 DSH 后重新绑定。断线重连同一编辑器保留绑定。写请求日志在 UE 进程内保存，不能恢复已退出编辑器的执行结果。

## 配置与排错

### 写入保护与循环控制

复制 DataTable 列使用 `unreal_data_table_copy_property`，提供 `assetPath`、`sourceRow`、反射字段名 `propertyName` 和 UUID `requestId`；不提供 `targetRows` 时复制到其他所有行。UE 必须声明 `data_table_copy_property` 能力。缺少能力时停止并更新插件，不回退到其他导入方式。嵌套 Map、软对象引用及浮点值直接复制，验证失败恢复操作前的内存值，包括已有未保存修改；不会从磁盘重载资产。

当前引擎 `DataTableTools.set_rows/add_rows/rename_rows` 的整表 JSON 往返可能损坏未指定字段，桥接在发送前拒绝这些入口。Slate 输入操作默认关闭；只读观察仍可用。UE 任务中调用 Shell 鼠标、键盘或剪贴板接口的替代路线同样被阻止。任意 MCP 返回 `isError:true` 会报告失败并结束当前任务，不把传输成功当作操作成功。通用 MCP 工具没有统一的事务回滚能力；工具未提供回滚时会明确记录未验证，不能声称已经恢复。

首次 UE 工具调用激活本轮预算，默认最多 40 个根工具调用、40 个模型步骤、累计 3 次错误、180 秒。之后的源码读取、Shell 和其他工具也计入预算；改变参数、UUID、工具名或编辑器绑定不会重置。策略拒绝、完整性检查失败或回滚失败立即由宿主取消当前轮；只有新的用户轮次重置预算。回滚无法确认时，编辑器写锁对所有对话生效，`unreal_state.writeLock` 显示失败请求；应人工核查并恢复资产后重启宿主，不能让模型用新的请求绕过。

预算依赖 DSH 的 `session/event`、`tools/pre-execute`、`tools/post-execute` 和 `agent/pre-step` 扩展；这些钩子取消当前 Agent 回合，不修改 DSH 主循环。只有桥接工具包装器可用的嵌入环境仍能限制 UE 调用，但不能拦截其他插件的工具。`unreal_state.executionSafety` 返回当前预算与状态。

在 DSH profile 的 `cordis.patch.yml` 中按插件 ID 覆盖配置：

```yaml
- id: dsh-unreal-bridge
  config:
    port: 17891
    allowWrites: true
    requireApproval: false
    requestTimeoutMs: 30000
    allowMcpDesktopInput: false
    guardMaxToolCalls: 40
    guardMaxSteps: 40
    guardMaxErrors: 3
    guardTimeoutMs: 180000
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
