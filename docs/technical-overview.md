# DSH Unreal Bridge 技术架构与运行链路

这份文档面向第一次接触项目的读者，以问题和回答解释 DSH、桥接插件、UE 插件、引擎工具集和知识系统如何配合。先给出最关键的结论：

**聊天中的 UE 指令通过本机 WebSocket 长连接，以结构化 JSON 发送。DSH CLI 用于安装和管理插件。UE 收到指令后，或者进入本项目的原生 C++ 操作，或者调用引擎已注册的 MCP 工具。后一条链路中，UE 自带的 EditorToolset 有许多预置 Python 实现，但模型没有因此获得任意 Python 执行入口。**

源码基准为 2026 年 10 月 21 日的当前工作区。根包版本是 `0.6.0`，UE 描述文件的 `VersionName` 是 `0.5.1`；两侧版本元数据不同，实际能力应看运行实例的握手信息，不能据此认定本机已安装或已加载全部新功能。本文涉及引擎内部的部分以本机 UEAS58 所用 UE 5.8.2 源码为依据。

## 阅读导航

- [1 项目定位与核心概念](#1-项目定位与核心概念)
- [2 两侧框架与模块分工](#2-两侧框架与模块分工)
- [3 启动发现与会话绑定](#3-启动发现与会话绑定)
- [4 指令从模型到 UE 的完整链路](#4-指令从模型到-ue-的完整链路)
- [5 蓝图材质和数据表的执行方式](#5-蓝图材质和数据表的执行方式)
- [6 版本权限并发与失败恢复](#6-版本权限并发与失败恢复)
- [7 项目知识与缓存](#7-项目知识与缓存)
- [8 运行现场与视觉验证](#8-运行现场与视觉验证)
- [9 安装验证与排错](#9-安装验证与排错)
- [10 面试官追问与设计取舍](#10-面试官追问与设计取舍)
- [11 源码阅读地图](#11-源码阅读地图)

## 1 项目定位与核心概念

### Q1 这个项目解决什么问题

让 DSH 中的 AI 助手能够围绕一个明确的 Unreal Editor 实例开展工作：知道用户选中了什么，读取资产和运行现场，查询项目资料，调用工具修改资产，再把结果和证据带回对话。

其中有两个不同的插件：

| 组成 | 安装位置 | 主要职责 |
| --- | --- | --- |
| DSH 扩展包 | DSH 的 desktop profile | 把 UE 能力接入聊天工具、会话和界面 |
| UE 插件 DSHUnrealBridge | UE 工程的 Plugins 目录 | 连接 DSH，访问编辑器中的真实对象，执行操作和导出证据 |

同一个 Git 仓库交付两侧源码，不代表它们运行在同一个进程中。

### Q2 DSH 是模型还是插件

DSH 是 DeepSeek Harness，是承载 AI Agent 的应用框架。模型负责理解请求、选择工具和解释结果；DSH 负责组织对话与工具执行；本项目扩展 DSH，使它能使用 UE。

可以按下面的层次理解：

| 层次 | 回答的问题 | 在本项目中的例子 |
| --- | --- | --- |
| 模型 | 下一步应该做什么 | 先读蓝图，再查函数和引脚 |
| DSH Agent 与工具运行时 | 如何把模型的工具调用执行起来 | 调用已注册的 unreal_read_blueprint |
| DSH 桥接宿主 | 发给哪个编辑器，参数能否执行 | 找会话绑定、检查参数、发送 JSON |
| UE 桥接与工具实现 | 怎样访问和修改真实对象 | 修改 UBlueprint 或调用已注册工具 |
| UE 引擎 | 对象、反射、编译、事务、渲染如何工作 | UObject、Kismet 编译器、材质编译器 |

本插件复用 DSH 的模型和会话能力，没有另写一个聊天模型服务。

后面会反复出现几个术语：WebSocket 是支持双向消息的长连接；schema 是参数的字段和类型约定；UObject 是 UE 对象体系的基类；反射是运行时查询对象类型、属性和函数的机制；UFunction 是可被 UE 反射系统调用的函数。PIE 是在编辑器中运行游戏，SIE 是在编辑器中模拟运行；CDO 是类默认对象，用于表示默认配置，不是运行现场的实例。

### Q3 整体架构长什么样

~~~mermaid
flowchart TB
    User["用户"] --> UI["DSH 界面 React 面板"]
    User --> Agent["DSH Agent 与模型工具调用"]

    subgraph DSH["DSH 宿主运行环境"]
        Agent --> Tools["工具注册与执行保护"]
        Tools --> Bridge["UnrealBridge 服务"]
        HostState["会话绑定 选区 状态 缓存"] <--> Bridge
        Remote["Typert Remote"] --> HostState
    end

    UI --> Remote
    Bridge <-->|"本机 WebSocket 自定义 JSON 协议"| Connection

    subgraph UE["Unreal Editor 进程"]
        Connection["DSHUnrealBridge 连接与分派"]
        Connection --> Native["原生 C++ 蓝图 材质 DataTable 运行快照 截图"]
        Connection --> MCP["DSHUnrealBridgeMCP"]
        MCP --> Registry["UE ModelContextProtocol 与 ToolsetRegistry"]
        Registry --> Builtin["现成工具实现 C++ 或预置 Python"]
        Connection --> Knowledge["DSHUnrealBridgeKnowledge"]
        Knowledge --> Snapshots["UE 资产快照与对象反射"]
    end

    Knowledge -->|"启动私有 Node 进程 管道 JSONL"| Worker["knowledge-worker"]
    Worker --> Graph["ProjectGraph"]
    Worker --> Memory["ProjectMemorySystem"]
    Graph --> ProjectCache["工程插件 Cache"]
    Memory --> ProjectCache
    Snapshots --> ProjectCache
~~~

这里最容易混淆的三个边界是：

1. DSH 界面通过宿主提供的 Remote 服务读状态；界面不直接建立 UE WebSocket。
2. DSH 与 UE 之间传递的是本项目的请求协议；MCP 是 UE 进程内部可调用的一类工具能力。
3. 知识 worker 是 UE 模块启动的辅助进程；它不承担普通蓝图、材质修改的传输工作。

### Q4 所以到底是 CLI 执行还是 UE 执行 Python

需要分四种情况回答：

| 场景 | 实际方式 |
| --- | --- |
| 安装 DSH 扩展 | 使用 dsh plugin 命令和安装脚本 |
| 本项目自带的蓝图补丁、材质批次、DataTable 字段复制等 | JSON 到 UE 后，由本项目 C++ 直接调用编辑器 API |
| UE 自带 MCP 工具集中的具体操作 | JSON 到 UE 后调用注册工具；部分工具经引擎预置 Python 实现再调用 unreal API |
| 模型上传一段任意 Python 让 UE 执行 | 当前桥接策略拒绝此类脚本执行入口 |

因此，“每次从命令行调用 UE”和“整条链路完全没有 Python”都不符合当前实现。准确表述是：**桥接用结构化工具调用，工具内部可以使用引擎自己的 Python 集成。** 深入调用顺序见 Q19。

## 2 两侧框架与模块分工

### Q5 DSH 侧使用什么框架

DSH 自身采用 Cordis 插件体系。可以把 Cordis 理解为宿主为插件提供依赖注入、服务注册、事件钩子和生命周期清理的框架。

本项目的宿主入口导出 `apply(ctx, config)`，声明依赖 `tools`、`systemPrompt`、`typert`，再使用：

- `ctx.tools.register` 注册模型可调用的 UE 工具。
- `ctx.systemPrompt.section` 提供使用指南。
- `ctx.provide` 发布 UnrealBridge 状态服务。
- `ctx.effect` 在卸载时关闭连接和释放资源。
- 官方生命周期钩子限制工具调用和模型步骤。

构建脚本生成三个入口：

| 入口 | 运行位置 | 内容 |
| --- | --- | --- |
| lib/index.js | DSH Node 宿主 | 桥接服务、工具、权限、保护、缓存 |
| lib/client.js | DSH Web 前端 | React 面板、设置入口、图片结果视图 |
| lib/remote.js | DSH 前后端调用描述 | Typert Remote 的接口和参数描述 |

JavaScript 源码采用 ESM；`ws` 提供 WebSocket，Zod 校验本项目工具参数，Ajv 校验动态发现的 UE 工具参数，`sharp` 处理图像，esbuild 负责打包。DSH desktop 的 Electron 外壳属于 DSH 应用，本项目没有另造一个 Electron 应用。

源码入口：[宿主注册](../src/index.mjs)、[前端](../src/client.mjs)、[Remote 描述](../src/remote.mjs)、[构建脚本](../scripts/build.mjs)。

### Q6 UE 侧使用什么框架

UE 侧是 Unreal C++ 编辑器插件，使用 Unreal Build Tool 的 `ModuleRules` 构建，模块实现 `IModuleInterface` 并通过 `IMPLEMENT_MODULE` 注册。

它包含三个模块：

| 模块 | 加载方式 | 主要职责 |
| --- | --- | --- |
| DSHUnrealBridge | Editor，PostEngineInit | 连接、请求分派、选区、原生资产操作、运行诊断、截图与展示 |
| DSHUnrealBridgeMCP | Editor，PostEngineInit | 访问 UE 的 MCP 注册表，枚举并执行工具 |
| DSHUnrealBridgeKnowledge | Win64 EditorNoCommandlet，PostEngineInit | 资产快照、项目知识、菜单更新、Node worker 调度 |

主模块依赖 `UnrealEd`、`KismetCompiler`、`BlueprintGraph`、`MaterialEditor`、`WebSockets`、`Slate` 等 UE 模块，以及另外两个桥接模块。插件声明启用 `ModelContextProtocol` 和 `ToolsetRegistry`；具体有哪些工具集还取决于工程启用的引擎插件，例如本机工程使用的 `AllToolsets`。

这些是编辑器模块，不应理解为打包游戏内自带的远程控制服务。PIE 诊断也是借助仍在运行的编辑器完成。

源码入口：[插件声明](../unreal/DSHUnrealBridge/DSHUnrealBridge.uplugin)、[主模块构建依赖](../unreal/DSHUnrealBridge/Source/DSHUnrealBridge/DSHUnrealBridge.Build.cs)。

### Q7 插件会自己驱动模型循环吗

模型循环仍由 DSH 管理：模型产生工具调用，宿主执行，结果再回到模型。

插件会在这条既有循环上加保护。UE 任务激活后，它监听工具执行前后、模型下一步开始和系统提示组装等钩子，统计调用次数、错误次数、修复次数和耗时。达到限制后，可以减少可用工具、要求收尾，或在总时限耗尽时取消当前轮次。

所以“复用 DSH 主循环”不等于“完全不参与模型生命周期”。它参与执行边界控制，但没有自行实现另一套 Agent 主循环。

### Q8 Typert 是什么 面板怎么拿到 UE 状态

Typert 在这里承担 DSH 前端与宿主之间的带类型调用。前端通过 `remote.unrealBridge.state` 读取当前对话状态，通过 `bind` 修改绑定；全局缓存页则调用 `cacheStatus/cacheCleanup`。

两段更新方式不同：

- **UE 到 DSH 宿主：** UE 主动推送选区、蓝图变化和 PIE 状态事件。
- **DSH 宿主到 React 面板：** 面板轮询宿主的内存状态，活跃任务或写入期间约 700 毫秒一次，其他时候约 2 秒一次。

因此面板刷新不等于再次读取 UE 资产，也不等于再次询问模型。选区变化本身只刷新上下文和显示，不主动触发模型生成。

### Q9 项目技能从哪里来 与绑定的 UE 是同一件事吗

项目技能由 DSH 的文件系统技能提供方发现：从当前聊天工作区向上寻找最近的 `.uproject`，读取该工程 `Plugins/DSHUnrealBridge/Skills/`。

技能是告诉模型如何工作的说明，例如项目图谱查询流程、材质工作流。它不增加一个底层 UE 执行接口，也不代表其中写到的能力已经在当前编辑器加载。

有两个独立维度：

| 维度 | 决定什么 |
| --- | --- |
| 聊天工作区所属工程 | 从哪里发现项目技能 |
| 对话绑定的 editorId | UE 指令实际发给哪个编辑器 |

技能可在 UE 离线时读取；切换绑定不会自动把另一个工程的技能接入当前工作区。工作区和编辑器工程不一致时，应分别核对。

源码入口：[技能发现与注册](../src/skills.mjs)。

## 3 启动发现与会话绑定

### Q10 DSH 插件怎样被安装和加载

安装分成构建与注册：

1. 把宿主、前端、Remote 打包到 `lib`，再生成 npm 安装包。
2. 安装脚本调用 DSH 官方 `dsh plugin --profile desktop add file:...`。
3. 随包的 `cordis.patch.yml` 提供插件配置。
4. DSH profile 加载包后，调用宿主的 `apply`，注册服务和工具。

可选的 UE 安装步骤把另一侧源码、知识工具和运行时复制到 UE 工程的插件目录。DSH 包安装成功与 UE C++ 模块编译成功，是两件事。

安装程序会备份配置和已有 UE 插件，保留工程已修改的知识配置；检测到目标工程编辑器仍在运行时会拒绝覆盖，不会自动关闭应用。安装器本身不负责把 UE C++ 编译成适配任意引擎的 DLL。

### Q11 谁是服务端 谁主动连接

**DSH 宿主是 WebSocket 服务端，UE 是客户端。**

DSH 监听 `ws://127.0.0.1:17891/editor`，端口可配置。UE 插件周期性读取本机描述文件，拿到地址和令牌后主动连接。

普通 HTTP 请求只返回 404；这里不是给浏览器使用的一套资产操作 REST API。

这种方向使 UE 可以先开或后开，DSH 也不需要枚举所有 UE 窗口、寻找窗口句柄或为每个编辑器预先配置监听端口。

### Q12 UE 怎样知道 DSH 在哪里 怎么鉴权

Windows 默认描述文件是：

~~~text
%LOCALAPPDATA%\DSHUnrealBridge\bridge.json
~~~

DSH 启动时生成随机 32 字节令牌，写入描述文件中的 `url/token/protocol/pid/startedAt`。UE 读取后，在 WebSocket 升级请求中携带：

~~~text
Authorization: Bearer <token>
~~~

宿主检查 URL 路径、令牌和 Origin，并且只监听回环地址。UE 自身也检查目标地址必须符合本机 `127.0.0.1` 的预期格式。描述文件可以通过 UE 启动参数 `-DSHBridgeDescriptor=...` 覆盖，主要用于隔离测试或自定义环境。

`bridge.json` 是连接发现文件，不是命令队列。资产操作不靠不断改写这个文件传输。令牌应视为本机连接凭据，不应贴到文档、日志截图或提交到仓库。

### Q13 多开 UE 后怎么避免操作错工程

每个 UE 进程在连接对象启动时生成 `editorId`，握手上报工程名、工程路径、引擎版本、PID 和能力列表。宿主记录所有在线实例。

每个 DSH 对话另外保存 `sessionId → editorId` 绑定。用户在面板选择实例，也可以调用 `unreal_bind`。没有绑定时返回 `NOT_BOUND`，绑定实例离线时返回 `DISCONNECTED`，不会猜测应该发给哪个编辑器。

同一个 UE 进程重连仍使用原 editorId，因此原绑定可以继续对应它；关闭再启动 UE 会生成新身份。DSH 重启后，进程内的会话绑定需要重新建立。

### Q14 从启动到可执行的顺序是什么

~~~mermaid
sequenceDiagram
    participant D as DSH 宿主
    participant F as 本机 bridge.json
    participant U as UE 插件
    participant C as DSH 对话
    D->>D: 加载插件并监听回环端口
    D->>F: 原子写入地址和临时令牌
    U->>F: 读取连接描述
    U->>D: WebSocket 连接 携带 Bearer
    U->>D: hello 实例身份与 capabilities
    D-->>U: hello_ack
    U->>D: runtime_changed 与 selection_changed
    C->>D: 绑定 editorId
    C->>D: 调用 unreal 工具
    D->>U: request 方法与参数
    U-->>D: response 结果或错误
    D-->>C: 工具结果
~~~

能力列表相当于这个实例的“可用接口声明”。例如没有 `material_graph_patch` 时，不能仅因为 DSH 已经注册了材质工具，就认为旧 UE DLL 可以执行它。

同样，源码目录已更新也不代表正在运行的 DSH 或 UE 已加载新代码；运行实例的能力和状态更直接。

### Q15 网络线程收到消息后会立即修改 UObject 吗

不会直接在 WebSocket 回调里做资产操作。网络回调先将消息放进多生产者队列 `Inbox`；UE 的 CoreTicker 随后在编辑器主线程取出并分派。

当前 ticker 注册间隔为 0.1 秒，每次最多取 4 条消息。这是对桥接请求调度的限流，不是“所有操作 100 毫秒内完成”的承诺。实际编译、资产加载或工具内部工作仍可能耗时。

连接还使用 `Generation` 区分新旧连接。重连后，旧连接排队消息会被丢弃，避免迟到消息操作当前状态。异步 MCP 完成后的展示和结果收尾，也会切回 GameThread 处理。

源码入口：[FDSHConnection 的 Start、Connect、Request、Tick](../unreal/DSHUnrealBridge/Source/DSHUnrealBridge/Private/DSHUnrealBridgeModule.cpp)。

## 4 指令从模型到 UE 的完整链路

### Q16 读取一个蓝图时完整经过哪些函数

以“读取蓝图 BP_Demo”为例：

~~~text
用户自然语言
  → DSH 模型产生 unreal_read_blueprint 工具调用
  → DSH ToolRuntime 执行已注册的工具
  → src/index.mjs 校验参数并取得所属 sessionId
  → UnrealBridge.read
  → target(sessionId) 找到绑定 UE
  → request(editor, "read_blueprint", params)
  → WebSocket
  → UE Inbox → Tick → FDSHConnection::Request
  → FDSHBlueprintOps::Execute
  → 读取真实 UBlueprint
  → response 回到 DSH pending Promise
  → 工具结果进入模型上下文
  → 模型回答或继续调用
~~~

一个真实形状的请求如下；资产路径需替换成工程中存在的资产：

~~~json
{
  "type": "request",
  "protocol": 1,
  "id": "7c1bedc6-a394-40f7-b3a2-24263fa74926",
  "method": "read_blueprint",
  "params": {
    "assetPath": "/Game/Example/BP_Demo",
    "detail": "summary"
  }
}
~~~

成功响应使用 `{type:"response", id, ok:true, result:{...}}`；失败响应使用 `ok:false` 和结构化 `error`。宿主按 `id` 找等待中的请求，并且检查响应来自原来的编辑器连接。

模型看见的工具名与网络方法名可以不同，例如 `unreal_read_blueprint` 对应 `read_blueprint`。这是宿主工具接口与桥接协议的分层。

### Q17 自定义 WebSocket 协议和 MCP 是什么关系

MCP 是 Model Context Protocol，在这里主要指 UE 引擎注册和提供的工具能力。本项目直接复用其进程内接口。

外部链路是：

~~~text
DSH 的 unreal_mcp_* 工具
  → 自定义 WebSocket 方法 mcp_*
  → UE 桥接适配器
  → 引擎 IModelContextProtocolModule
~~~

它没有要求 DSH 再连接一套 UE MCP 的 HTTP、SSE 或 stdio 服务。网络消息也没有使用标准 JSON-RPC 的 `jsonrpc/method/id` 信封，而是使用本项目的 `type/protocol/id/method/params`。

常用映射如下：

| DSH 工具 | 桥接方法 | 用途 |
| --- | --- | --- |
| unreal_mcp_tools | mcp_list_tools | 列出 UE 顶层工具与 schema |
| unreal_mcp_toolsets | mcp_discover | 调 list_toolsets |
| unreal_mcp_describe | mcp_discover | 调 describe_toolset |
| unreal_mcp_call_toolset | mcp_call_tool | 通过 call_tool 调工具集中的函数 |
| unreal_mcp_call | mcp_call_tool | 调一个精确的顶层工具或规范化后的调度目标 |

### Q18 为什么要先发现工具再执行

因为具体工具集、工具名、参数和对象引用由当前 UE 实例提供，不能靠模型根据名字猜测。

一次 MCP 执行主要包含：

1. 根据当前会话找编辑器，检查所需能力。
2. 规范化短名和完整工具名，拒绝脚本执行、已知有损操作或不允许的桌面输入。
3. 从同一编辑器取得当前工具 schema，用 Ajv 检查必填项、类型、嵌套结构和多余参数。
4. 检查绑定是否仍是原连接；即使 A→B→A，旧的绑定版本也不再有效。
5. 对需要归属核验的 Blueprint/Object 工具，先请求 `mcp_operation_context`，取得原生所有者证据与 token。
6. UE 在真正派发前检查真实 UObject 类型、继承关系、图和节点归属、引脚身份，以及 token 对应对象是否仍有效。
7. 才调用注册工具，等待结果并做必要的布局和展示收尾。

JSON Schema 只能说明“参数长得对”，不能说明“这个 refPath 真的是一个蓝图”。原生预检解决后一个问题，但也不等于证明第三方工具内部所有逻辑都安全。

源码入口：[mcpCall](../src/bridge.mjs)、[动态 schema 校验](../src/mcp-contract.mjs)、[原生目标与操作上下文校验](../unreal/DSHUnrealBridge/Source/DSHUnrealBridge/Private/DSHMcpTargetValidation.cpp)。

### Q19 UE 工具集内部的 Python 到底怎样参与

本项目的 MCP 模块先执行：

~~~cpp
TSharedPtr<IModelContextProtocolTool> Tool = MCP->FindTool(Name);
Tool->RunAsync(ToolId, Arguments, OnComplete);
~~~

到此为止，桥接调用的是 C++ 接口。继续进入本机 UE 5.8.2 的引擎代码，可以看到：

- `EditorToolset/Content/Python/init_unreal.py` 导入并注册内置工具集。
- `toolsets/__init__.py` 注册 AssetTools、BlueprintTools、DataTableTools 等。
- `ToolsetRegistry` 的 Python 包装层把工具方法包装成带 `AICallable` 元数据的静态 `unreal.ufunction`。
- 注册表的 C++ 调用实现通过反射函数的 `Invoke` 进入这些已经注册好的方法。
- 预置 Python 方法再使用 `unreal` 模块调用引擎 API；其他工具也可以有原生 C++ 实现。

这里有一个重要区别：**执行引擎预先注册、具有参数定义的 Python 工具函数，与接收模型任意生成的 Python 文本并执行，是两种权限和执行模型。**

当前桥接明确禁止 `ProgrammaticToolset`、`execute_tool_script`，UE 侧还拒绝借 AssetTools 的 `write_file` 写入 `.py/.js/.ps1`。这些规则限制模型使用脚本入口，并不消除引擎内部对 PythonScriptPlugin 的使用。

因此，不能把“桥接不生成 Python”写成“UE 侧完全不用 Python”。引擎侧精确源码位置见文末阅读地图。

### Q20 可以给一个具体 MCP 调用例子吗

以读取 DataTable 的 schema 为例。首先列工具集，再取得 DataTable 工具的精确描述，最后提交：

~~~json
{
  "toolsetName": "editor_toolset.toolsets.data_table.DataTableTools",
  "toolName": "get_schema",
  "arguments": {
    "data_table": {
      "refPath": "/Game/Data/DT_Demo.DT_Demo"
    }
  },
  "requestId": "9f4961a2-0fa7-4ef5-9b46-09673c534d2b"
}
~~~

这是传给 `unreal_mcp_call_toolset` 的参数，不是直接发给命令行的命令。

宿主会把它转换为网络 `mcp_call_tool` 请求，其中 `name` 是 `call_tool`，内层参数为 `toolset_name/tool_name/arguments`。UE 查找这个顶层调度工具，再找到具体工具集方法。

例子中的 `data_table` 和 `refPath` 必须遵循实际 schema，不能擅自改为 `dataTablePath` 或裸字符串。MCP 对象路径通常需要 `包名.对象名`，而本项目部分原生工具可以接受包路径，二者不能混用规则。

### Q21 UE 选区怎样返回 DSH 会一直请求模型吗

UE 监听 Content Browser、关卡 Actor/组件、蓝图编辑器组件和 PIE 状态，把变化合并为事件：

~~~json
{
  "type": "event",
  "event": "selection_changed",
  "sequence": 12,
  "data": {
    "assets": [
      {
        "path": "/Game/Example/BP_Demo.BP_Demo",
        "class": "/Script/Engine.Blueprint"
      }
    ]
  }
}
~~~

宿主只接受比当前序号更新的事件，将其写入内存状态；面板随后显示。UE 重连后重发当前选区。

这条链路不主动调用模型，也不会自动把所有选中资产的完整图读一遍。资产、实例、组件模板的选区携带不同字段；模型真正诊断时，仍需调用相应的读取工具取得当前证据。

## 5 蓝图材质和数据表的执行方式

### Q22 原生蓝图补丁为什么分读取预览应用和保存

这是把不同风险拆成可以核验的阶段：

~~~text
unreal_read_blueprint
  → 得到当前 revision、图、节点和引脚
unreal_catalog
  → 查需要添加的原生函数与精确引脚
unreal_preview_patch
  → 在临时副本验证操作并编译
  → DSH 保存 previewId 与原始参数
unreal_apply
  → 按 previewId 取回同一批操作
  → UE 重新检查 baseRevision
  → 真实编辑事务 修改 编译 必要时恢复
unreal_read_blueprint
  → 回读真实结果
unreal_save
  → 用户明确要求后单独保存
~~~

原生补丁支持有限的结构化操作，例如新增函数调用节点、事件、自定义事件、连线、断线、引脚默认值、移动和删除节点。它并不等于任意蓝图编辑语言。

预览不改变原资产；应用成功主要表示内存中的资产修改通过了相应校验，默认不保存到磁盘。

### Q23 为什么不能凭感觉填写函数名和引脚名

蓝图节点是带类型、方向和约束的引擎对象，显示标题也未必等于内部函数路径或引脚名。

`unreal_catalog` 读取已加载、对蓝图公开的原生函数与引脚元数据。补丁据此指定精确 `/Script/模块.类:函数` 路径。读取已有图则获得真实节点 ID 和引脚信息。

连接时不会为了“帮模型成功”自动拆掉已有连线，或插入未授权的转换节点。这样可以把错误留在预览和校验阶段，而不是悄悄改变用户原有逻辑。

### Q24 关卡蓝图和普通 Actor 蓝图为什么走法不同

普通蓝图是独立资产；关卡蓝图是地图内部的子对象，其保存目标也与地图关联。

本项目原生蓝图读写接口只处理支持范围内的普通 `UBlueprint`。对于关卡蓝图，应先调用：

~~~text
unreal_level_blueprint({mapPath: "/Game/Maps/Map_Demo"})
~~~

该只读查询返回真实 `blueprint.refPath`、图引用和 `saveTarget`，再使用已发现的 MCP 图工具继续。不能猜一个名称，把地图当蓝图，或去掉关卡子对象路径。

查询必要时会加载地图资产包到内存，但不打开或切换当前地图，也不创建原本不存在的关卡蓝图。“只读”在这里不表示完全没有资产加载。

通过 MCP 修改关卡蓝图，也不能自动获得原生蓝图补丁的统一事务和回滚保证。安全展示只允许当前编辑世界及已加载流送关卡中的目标，不通过打开地图来“纠正”目标。

### Q25 材质批量修改和蓝图 previewId 是同一机制吗

思路相似，接口不同。材质使用 `unreal_material_read` 和 `unreal_material_patch`：

1. 读取材质或材质函数的当前 revision、表达式节点、属性和精确引脚。
2. 提交完整批次，`dryRun:true` 默认在副本上预检和编译。
3. 使用相同的 `baseRevision` 和原始操作，以 `dryRun:false`、新的 requestId 进行真实提交。
4. 回读并根据需要验证外观。

它不返回一个供 `unreal_apply` 使用的蓝图 previewId。临时节点别名可用于同批次连线，提交后应以返回映射或重新读取获得真实节点 ID。

独立 dry-run 是便于检查的步骤，不是服务端保存的批准凭证；代码不要求必须先调用一次独立预览。真实提交也会重新在副本上执行预检和编译，再修改原资产。

材质支持范围为普通 `UMaterial` 与 `UMaterialFunction`；材质实例的参数仍用已发现的参数工具。整图布局必须明确 `layout:"all"`；清理只处理明确给出的候选。函数接口存在已加载调用者等不支持的变更会被拒绝。

已打开材质编辑器持有独立的工作副本。原生提交需先确认没有未应用的人工编辑，再同步该副本并按真实节点 GUID 聚焦；仅资产未保存不构成冲突。原生材质事务的撤销/重做也单独同步，避免编辑器把旧副本写回原资产。窗口展示是提交后的批次结果，不是逐节点播放。

工具进行真实着色器编译并核验失败恢复，但编译通过不说明外观、动态效果或所有函数调用场景都已通过验收。提交不自动保存。

### Q26 为什么给 DataTable 单独写 C++ 复制工具

因为当前引擎部分 DataTable Python 写工具，会把表导出为 JSON、修改 JSON、再重建整张表。这个往返可能损失未指定字段的数据表达，局部修改也可能影响其他内容。

风险来源是全表序列化和重新导入，以及导入期间可能触发的回调，不是 Python 语言本身。

本项目因此拦截 `set_rows/add_rows/rename_rows` 等已知有损入口，提供 `unreal_data_table_copy_property`：

- 按 UE 反射 `FProperty` 的原生类型语义复制指定字段，保留容器、结构和值的语义；对象引用仍指向原对象，不会复制出另一份资产。
- 操作前保存内存状态，包括已有未保存修改。
- 核验源行、目标字段之外的内容和行集合没有被意外改变。
- 失败时恢复并核验；无法确认恢复则报告失败并保护后续写入。
- 不经过整表 JSON/TSV，不自动保存。

这是针对已知数据保真问题的专用路径，不能推广为所有 DataTable 操作或全部 MCP 工具都获得相同保证。

### Q27 自动布局和自动打开资产是修改本身吗

二者分开处理：

**布局会修改图坐标。** 原生蓝图补丁在批次结束后对相关逻辑做布局，内容和布局纳入同一个事务；纯手工移动补丁保留用户坐标。通用 MCP 的布局由适配器根据前后图差异处理，结果通过 `dshLayout` 报告，可能有独立撤销步骤或警告。

**展示主要修改视图。** 展示服务排队打开、激活资产编辑器和聚焦图节点，不把延后的展示再变成一次图编辑。它核验原对象身份，只展示已加载且支持的目标，不因为同名路径出现就重新绑定到替换后的对象。

工具成功不代表节点已正确进入用户视野；展示失败也不应被误认为资产操作必然失败。应分别看执行结果、布局结果和展示状态。


## 6 版本权限并发与失败恢复

### Q28 为什么有那么多编号 分别解决什么问题

| 标识 | 含义 | 不能代替什么 |
| --- | --- | --- |
| sessionId | DSH 对话身份 | 不能代替 UE 实例身份 |
| editorId | 本次 UE 进程中的桥接实例 | 不能保证下次重启仍是同一实例 |
| 网络 id | 匹配一条请求和它的响应 | 普通读取编号不等于资产版本 |
| requestId | 调用者保留的 UUID，用于执行去重和结果查询 | 换编号不能证明之前没有执行 |
| previewId | DSH 保存的一次原生蓝图预览 | 不能跨对话或跨编辑器使用 |
| baseRevision | 修改基于的资产状态摘要 | 不是完整资产备份 |
| operationToken | UE 生成的 MCP 目标及所有者预检凭据 | 不是写入事务或回滚快照 |
| captureId | 本次宿主中某对话的可复用截图记录 | 不是永久可用的图片地址 |
| playSessionId worldId objectId | 精确的 PIE 运行对象身份组合 | 对象路径或同名 Actor 不能替代它 |

对通过 `mutate` 派发的执行请求，调用者的 requestId 同时用作网络信封中的 id；其他读取请求可以由宿主生成一次性的 id。

这些编号分别约束“谁、发给谁、哪次执行、基于什么状态”，并不是重复设计。

### Q29 revision 怎样避免覆盖用户刚做的修改

本项目的原生蓝图补丁与材质批次在读取时返回 revision，提交时携带 baseRevision。UE 在实际修改前重新计算并比较，发现状态变化就拒绝，要求重新读取和预览。通用 MCP、DataTable 字段复制和知识记录没有共用这一套 baseRevision 协议。

原生蓝图预览在 DSH 中最多保留 5 分钟，记录会话、编辑器和原始参数。蓝图变化事件、断线或切换目标都可能使旧预览不可用。即使宿主尚未收到变化事件，UE 提交前的 revision 检查仍是最后一道防线。

这里采用的是“发现冲突就拒绝”，没有自动三方合并。蓝图 revision 由本插件关注的父类、图、节点、变量等编辑信息计算，不是整个工程的版本控制系统；材质批次也有自己的完整编辑状态校验范围。Git、资产备份和人工保存管理仍有独立作用。

### Q30 allowWrites 和 requireApproval 有什么区别

`allowWrites` 决定是否允许可能修改状态的操作；`requireApproval` 决定特定原生写操作是否调用 DSH 批准服务。

需要分别理解当前默认来源和执行路径：

| 情况 | 当前行为 |
| --- | --- |
| 设置 schema 默认值 | allowWrites 为 true，requireApproval 为 true |
| 随包 cordis.patch.yml | 显式设置 requireApproval 为 false |
| 原生 apply undo save、知识记录、DataTable 复制、材质真实提交 | 经过 approve，按当前配置决定是否请求批准 |
| unreal_mcp_call 与 unreal_mcp_call_toolset | 当前不调用 approve；仍受写权限、策略、校验、预算和互斥保护 |
| allowWrites 为 false | 禁用写入与未确认只读的 MCP，保留原生读取和精确审计的 MCP 查询 |

因此，打开 requireApproval 不等于所有 MCP 资产写入都逐次弹窗。实际配置应以当前 profile 和 `unreal_state` 为准。

MCP 只读分类也不依赖工具名是否以 get 开头，或工具自己提供的 readOnlyHint；宿主与 UE 使用精确审计名单。未知工具按可能写入处理。

### Q31 两个对话同时改一个 UE 会怎样

宿主的 `EditorWrites` 按 editorId 管理写入占用，而不是只限制单个对话。一个对话正在写，同一编辑器上的另一对话不能同时开始另一项写入，通常返回 `BUSY`。

UE 原生入口还维护自己的在途写入编号，拒绝异步修改重叠，返回 `EDITOR_BUSY`。冲突不会简单排到后台，稍后拿着可能过期的编辑请求执行。

不同编辑器可以独立工作；用于核验的原生读取和已审计 MCP 查询可以继续。这里限制的是桥接中的写入调度，并不能阻止用户同时手工编辑，也不能代替工具自身对异步工作和副作用的管理。

源码入口：[编辑器写入占用](../src/editor-writes.mjs)、[宿主 mutate](../src/bridge.mjs)。

### Q32 超时或取消是否表示 UE 没有修改

**不能这样判断。**

宿主超时或取消主要停止等待；常规请求没有发送一个能保证中断 UE 操作的远端 cancel 协议。UE 可能已经完成修改，也可能仍在运行。

对已经派发的写入，宿主会保留 `uncertain` 写入占用，阻止这个编辑器的其他对话继续写。正确处理是：

~~~text
保留原 requestId
  → unreal_request_status
  → pending 表示继续等待
  → completed 表示取回原始结果并核验
  → unknown 或 expired 不能当作未执行
  → 查清前不换 UUID 重新发起同一写入
~~~

任何绑定到同一编辑器的对话都可以查询原请求；确认完成后更新原所属对话的结果缓存。无效或迟到的状态响应不能释放另一个新请求的占用。

普通请求默认等待 30 秒，知识请求默认 120 秒，画面捕获默认 60 秒；改变等待时间不能改变“超时不等于未执行”这一语义。

### Q33 同一个请求重试会执行两次吗 保证能跨重启吗

在当前进程保存的执行记录范围内，同 requestId 与同参数会返回已记录的结果或错误；同编号不同参数返回 `IDEMPOTENCY_MISMATCH`。DSH 宿主先处理写入占用及缓存，重复调用可能先遇到 `BUSY`、`OUTCOME_UNKNOWN` 或先前缓存的超时错误。请求到达 UE 去重层后，仍在执行返回 `IN_PROGRESS`，已执行但完整结果被回收时返回 `RESULT_EXPIRED`，不会悄悄重做。

当前宿主保存最多 1000 条结果；UE 保存最多 10000 个写请求参数摘要及最近 1024 个完整结果，摘要日志达到上限会拒绝新的相关执行。MCP 调用即使被审计为只读，也使用其执行请求的去重链路。

这些执行记录主要在内存中：

- DSH 重启会丢失绑定、预览等宿主状态。
- UE 退出会丢失该进程的执行结果日志。
- 连接重试不会自动重放写入。
- 磁盘上的 audit.jsonl 是审计记录，不是可以重放并恢复全部执行状态的事务数据库。

所以这是有明确生命周期的执行去重与结果恢复，不能宣传为跨崩溃、跨重启的永久 exactly-once 保证。

### Q34 所有操作失败都能自动回滚吗

不同路径的保证不同：

| 操作路径 | 恢复边界 |
| --- | --- |
| 原生普通蓝图补丁 | 事务和版本受控；失败恢复还要检查撤销、重新编译和 revision |
| 原生 DataTable 字段复制 | 用修改前内存快照恢复，并核验源行和无关字段等完整性 |
| 原生材质批次 | 按内存快照恢复、重新编译并核验状态 |
| 通用 MCP 工具 | 事务、副作用、自动保存和失败恢复由工具自身决定，没有统一原子保证 |
| 知识索引构建 | 使用 staging 和目录发布恢复机制，不是 UE 资产编辑事务 |

恢复失败返回 `ROLLBACK_FAILED` 等结构化错误，宿主会对该 editorId 建立写锁；换对话或 requestId 不会解除。必须先核查并恢复资产，不能把重启宿主当作资产自动修复。

原生 `unreal_undo` 也只撤销自己记录且仍位于编辑器事务栈顶部的图修改，不是任意历史回滚。用户后来做了别的修改，就不能不加判断地撤销。

### Q35 为什么要限制修复次数和整轮预算

模型可能反复猜参数、换工具或连续“修复”，反而扩大问题。项目用两种尺度约束：

**单个问题的修复限制。** 默认最多 3 次修复写入，相同错误最多连续出现 2 次。首次失败后开始计修复额度；诊断读取和原请求状态查询不消耗修复写入次数。成功不清零本轮已用额度。

**整轮任务预算。** 当前默认 300 个根工具调用、200 个模型步骤、累计 50 次错误和 30 分钟。UE 任务首次激活后，后续源码读取、Shell 和其他工具也计入相应宿主钩子的预算。

操作归属由宿主结合 UE 原生证据确定。蓝图节点、引脚、ObjectTools 属性修改会尽量归入真实所属蓝图；换节点、别名、包装工具或 UUID 不会重新获得同一问题的额度。材质相关编辑同样按所属材质归类。

宿主不推断两个不同资产名是否服务于同一任务。因此错误恢复信息和材质 skill 进一步明确：独立工作仅指用户已要求的无关工作，不能靠换名、复制或替代重建继续被停止的问题。材质编辑器的未应用修改冲突使用独立恢复提示，不消耗问题修复额度，也不允许自动覆盖这些人工编辑。

预算耗尽或进入写锁保护后，通常保留有限状态查询与无工具总结；总耗时超限则直接取消当前轮。新用户轮次可重置任务预算，但不能清除编辑器写锁。

### Q36 修改设置会重连或清掉保护状态吗

官方设置页通过 DSH 配置编辑器保存 profile，使用配置 revision 防止旧草稿覆盖新配置。

不同设置的生效时机不同：

| 设置 | 生效时机 |
| --- | --- |
| 写权限、批准策略、请求超时 | 后续请求 |
| 调用预算、修复限制、总时限 | 下一轮首次激活 UE 任务时取快照 |
| 缓存保留和容量 | 下一次清理 |
| 端口、stateDir、底层桌面输入策略 | 按静态配置生命周期处理，修改后重启 |

热设置不会为了应用新值而重建桥接连接、换令牌，或清除未知写入占用与回滚写锁。设置页与工具状态共用状态投影；页面刷新不会触发知识重建。

源码入口：[设置定义](../src/settings-spec.mjs)、[宿主设置适配](../src/settings.mjs)、[执行保护](../src/execution-guard.mjs)、[修复跟踪](../src/repair-tracker.mjs)。

## 7 项目知识与缓存

### Q37 为什么 UE 插件里还要启动一个 Node 进程

UE 原生代码适合读取编辑器对象；源码扫描、文档格式解析和 SQLite 检索适合复用已有 JavaScript/TypeScript 工具。因此知识模块按工具类型分流：

| 后端 | 执行位置 | 工作 |
| --- | --- | --- |
| Editor | UE GameThread | 对象反射与现场检查 |
| Snapshot | UE 原生服务 | 采集、校验、分页读取资产快照 |
| Worker | 私有 Node 子进程 | Graph、Memory、源文件检索、证据和经验记录 |

Worker 请求的实际方式是：

~~~text
DSH unreal_knowledge
  → WebSocket knowledge_call
  → UE FProjectKnowledgeService::Execute
  → 后台工作线程
  → FPlatformProcess::CreateProc
  → 插件 Runtime/Win64/node.exe
     Tools/knowledge-worker.mjs --project ... --plugin ... --once
  → stdin 写一行 JSON
  → stdout 读一行 JSON 结果
  → 回到 UE GameThread
  → 原 WebSocket 返回 DSH
~~~

每次 Worker 请求启动一个 `--once` 进程，不是常驻 Node HTTP 服务。创建进程使用固定路径和管道，不经过 shell 或系统 PATH。它与 DSH 自己的 Node 宿主是两套用途和生命周期不同的运行环境。

源码入口：[知识服务](../unreal/DSHUnrealBridge/Source/DSHUnrealBridgeKnowledge/Private/ProjectKnowledgeService.cpp)、[Worker 入口](../unreal/DSHUnrealBridge/Tools/knowledge-worker.mjs)。

### Q38 ProjectGraph 和 ProjectMemorySystem 分别做什么

**ProjectGraph** 建立项目的结构与关系导航：源码中的类、函数、模块与引用，以及 UE 导出的资产和图信息。输出包括 nodes.jsonl、edges.jsonl 和 project_graph.sqlite。

**ProjectMemorySystem** 索引人工项目资料，提取项目概况、系统说明、架构规则、模式与实施线索，再组装可提供给模型的上下文。

它们回答“去哪里找相关实现”和“已有资料怎么说”，不会在查询时直接修改 UE 资产。实时资产操作仍回到编辑器工具。

人工资料放在工程的 `ProjectKnowledge/`、`Docs/` 等配置目录；生成数据放在插件 Cache 中，二者不要混为同一份需要人工维护的文档。

### Q39 这里的图谱和记忆是向量数据库或模型训练吗

当前实现不是。Graph 和 Memory 使用 Node 内置 `node:sqlite`；文档检索使用 SQLite FTS5 和 BM25 排序。摘要主要通过本地规则提取标题和要点。`VectorIndex` 当前明确 `enabled=false`，搜索返回空集合。

源码索引也有精度边界：C++ 使用正则和逐行启发式，AngelScript 是词法索引；没有因此构建完整编译器级 AST，也没有采集真实运行调用轨迹。

因此“知识记忆”在这里主要指**持久化索引、摘要和带来源的记录**。它没有修改模型权重，也不应被解释成模型自动学会了整个工程。

源码入口：[SQLite 图存储](../unreal/DSHUnrealBridge/Tools/ProjectGraph/src/graph/sqliteStore.ts)、[全文索引](../unreal/DSHUnrealBridge/Tools/ProjectMemorySystem/src/index/fullTextIndex.ts)、[未启用的向量索引](../unreal/DSHUnrealBridge/Tools/ProjectMemorySystem/src/index/vectorIndex.ts)。

### Q40 全项目知识怎样更新 是实时增量的吗

全量更新由 UE 菜单“更新项目图谱与知识记忆”触发，主要流程是：

1. 等待 AssetRegistry 扫描，枚举 /Game 与已启用项目插件的 Content 范围。
2. 分帧导出资产快照，未变化快照可复用；当前调度每次最多处理 4 个资产，循环预算约 8 毫秒。
3. 对期间失效的快照做有限复核，保存覆盖和完整性信息。
4. 后台写资产登记表，再调用 worker 的内部 project_update。
5. 在 staging 目录重建 Graph 与 Memory，成功后发布到稳定目录。

8 毫秒是调度检查预算，不是对一次资产加载耗时的硬性上限。当前 Worker 的 Graph/Memory 构建仍是 full_rebuild，不能因为快照能复用就称为完整的增量索引系统。

常规知识查询不会自动全量重建。内部 `project_update` 也没有暴露成 DSH 的普通知识查询工具。对象和属性变更、事务及资产登记变化会标记快照过期；读取时还会检查项目身份、会话与磁盘状态。

### Q41 缓存中的结论能证明当前运行正确吗

需要分清三种证据：

| 证据 | 能说明什么 | 不能直接说明什么 |
| --- | --- | --- |
| Graph 与文档检索 | 候选实现、关系和已有资料 | 当前运行实际经过了这条逻辑 |
| 资产快照 | 采集时可导出的部分资产状态 | 完整可重建资产或当前运行现场 |
| 运行快照与截图 | 某次采样的实例状态与画面 | 此前完整执行历史或未来行为 |

普通资产快照可能只有 opaque 元数据；蓝图、材质和 DataAsset 等快照也明确是 partial。它们不是 .uasset/.umap 的无损备份格式。

保存的推断被标为 inferred；规划经验即使通过结构校验，也保留 `effect_verified:false`。应回到当前源码、对象读取、编译和实际效果验证，不能把检索命中直接升级为执行成功。

### Q42 不同缓存在哪 清理会删工程资料吗

| 数据 | 默认位置或归属 |
| --- | --- |
| 连接描述与当前审计 | DSH stateDir，Windows 默认在 LOCALAPPDATA/DSHUnrealBridge |
| 图片证据 | DSH stateDir/visual |
| 审计归档 | DSH stateDir/audit-时间戳.jsonl |
| 运行快照历史 | DSH 进程内，每对话保留有限条数和容量 |
| UE 资产快照 | 工程插件 Cache/UE/asset_snapshots |
| 资产登记表 | 工程插件 Cache/UE/asset_registry |
| 图谱与记忆 | 工程插件 Cache/Graph 和 Cache/Memory |
| 推断与经验 | 工程插件 Cache/Evidence 和 Cache/Experiences |
| 人工编写资料 | 工程 ProjectKnowledge、Docs 等配置目录 |

DSH 的 CacheManager 只清理自己管理的图片证据和轮转审计归档，不负责删除项目知识索引，更不清理 UE 资产或人工资料。

视觉证据默认保留 30 天，容量目标 2048 MiB；正在生成、比较、读取附件或处于已承诺保留期的证据优先保护，所以容量是回收目标，不是绝对硬上限。启动时及每小时执行策略维护。手工清空闲置证据可能使 captureId 提前失效，已保存到对话的图片附件另有其生命周期。

## 8 运行现场与视觉验证

### Q43 Actor 路径蓝图路径和 PIE 运行身份怎么区分

可以把同一个角色分成四个层次：

| 对象 | 含义 | 常见用途 |
| --- | --- | --- |
| 蓝图资产 | 定义类的逻辑和默认配置 | 改函数、节点、类默认值 |
| 蓝图组件模板 | 蓝图编辑器组件树中的模板 | 改该蓝图组件的默认配置 |
| 编辑世界 Actor 或组件 | 关卡里放置的实例 | 读取或修改关卡实例属性 |
| PIE Actor 或组件 | 本次运行生成或复制的活对象 | 诊断运行时状态 |

`unreal_runtime_snapshot` 要求精确的 `playSessionId/worldId/objectId`；只有恰好选中一个运行对象时，才可省略目标。对象销毁、世界卸载、PIE 结束后，旧身份失效，不会自动按同名路径绑定新对象。

快照记录采集时间、帧号、反射属性、可用默认值和可选组件信息。每个对话的历史最多 20 份、总计不超过 16 MiB，保存在 DSH 进程内；离线后仍可读已有快照，宿主重启则不保留。

这是单次状态采样，不是执行 Trace。需要稳定现场时应先暂停；F8 弹出控制本身不等于暂停。不能读 CDO 或编辑世界对象后，声称它就是 PIE 中发生问题的实例。

### Q44 截图对比是模型自己看还是另一个视觉服务

这里有采集、计算和解释三步：

1. UE C++ 从编辑器关卡视口 ReadPixels，保存原图、裁剪图和采集信息。
2. DSH 使用 sharp 读取图片、生成对照图，按条件计算色差、SSIM、边缘距离和变化比例等指标。
3. DSH 把图片作为附件交给支持图片的当前模型，让它结合图像和指标解释差异。

这条路径不要求单独配置第二个视觉模型服务。大图片保存在本机证据目录，桥接 JSON 主要传路径和元数据，不把整幅图塞进 2 MiB 的消息信封。

独立的 `unreal_image_analyze` 可以在 UE 离线时分析本机图像的源 RGBA、透明度、采样点和指定底色合成统计；它不自动识别图形，也不会从像素统计推断材质结构。

### Q45 图片指标通过是否等于视觉效果正确

需要先满足可比较条件。当前捕获支持 SDR 编辑器关卡视口，不支持直接捕获 PIE、UMG 或资产预览窗口。Actor/组件裁剪是包围盒投影后的矩形，可能含背景和遮挡，不是物体分割。

对比有两类语义：

| 模式 | 用途 | 结论边界 |
| --- | --- | --- |
| assessment | 参考设计辅助评审 | 保留咨询性 unknown，不伪装为精确验收 |
| regression | 相同条件下截图回归 | 需要明确确认相机、尺度、曝光等条件一致，才能按阈值判断 |

图片尺寸不同时不会自动拉伸配准后给像素级通过。颜色分布分析可比较指定区域的色彩和亮度统计，但不能把亮度比直接解释为曝光差。

当前模型未声明图片输入能力、路由无法确认或附件交付失败时，工具会保留指标与证据路径并说明交付限制。附件准备成功也不能单靠接口返回证明模型已正确感知图像。编译通过、图像指标通过、模型观察和实际动态效果验收是不同层次的证据。

## 9 安装验证与排错

### Q46 要运行起来需要哪些环境

当前仓库主要面向 Windows、本机 DSH 与 UEAS58 所用 UE 5.8.2。根包兼容表显式列出 DSH `0.2.1-rc.2`，不能直接扩大为所有 DSH 或 UE 版本均兼容。

至少需要准备：

- DSH 可加载的扩展包及对应 profile。
- 与目标 UE 引擎构建匹配的 C++ 模块；源码安装不等于已得到兼容 DLL。
- 引擎 ModelContextProtocol、ToolsetRegistry，以及实际需要的工具集。
- 知识工具所需的固定 Node.js 24.15.0 win-x64 与已构建产物。
- 知识模块的项目配置；使用图谱和完整 Memory 前，应执行索引更新。缺少人工资料会使相应摘要缺失，但不阻塞当前源码查询。

构建/安装脚本本身要求可用的 Node.js 22+ 和 npm；知识运行期使用插件自带的固定 Node，不依赖系统 Node 或 Tools/node_modules。本项目自己的原生工具不通过 Python 脚本工作，而引擎 EditorToolset 路径会用到其 PythonScriptPlugin 依赖。

宿主 JavaScript 更新通常需要重新加载 DSH；C++ 能力变化则需重新编译并重启对应 UE。实际步骤见仓库 [README](../README.md)。

### Q47 怎样验证实现 现有测试分别证明什么

| 验证层 | 仓库入口 | 能验证的内容 |
| --- | --- | --- |
| 宿主测试 | test/*.test.mjs | 参数、绑定、协议、预算、缓存、分类及模拟连接行为 |
| 实际 DSH 运行时适配 | scripts/*runtime-check.mjs 等 | Cordis、ToolRuntime、Remote、设置、会话保存等真实接口兼容 |
| 知识工具测试 | UE 插件 Tools/test.mjs | 图谱、资料解析、Memory 与 Worker 路由 |
| UE Automation | C++ 中 DSH.Bridge 等测试 | 事务、对象、原生读写、快照、编译和失败恢复 |
| 真正桥接端到端 | scripts/ue-e2e.mjs 等 | 实际连接到 UE 后的发现、执行与结果恢复 |
| 业务与效果验收 | 具体任务的运行、截图和回读 | 是否实现用户真正想要的行为 |

根目录 `npm run check` 只表示构建宿主并运行根测试，不会自动完成全部 UE 编译、原生自动化、模型生成和视觉业务验收。

[验证记录](validation.md) 中的结果对应各次记录的代码、构建和环境。已有测试源码、历史报告或隔离工程编译成功，不能直接证明当前用户工程已加载相同代码或当前业务任务已成功。

### Q48 出现问题应该按什么顺序排查

先看 `unreal_state` 和界面执行状态，把故障定位到连接、绑定、能力、参数、目标、执行还是验证阶段：

| 现象或错误 | 优先核对 |
| --- | --- |
| 面板没有在线实例 | DSH 宿主是否加载，UE 模块是否启动，描述文件是否对应当前宿主，回环端口是否冲突 |
| NOT_BOUND | 当前对话是否明确选择了 UE 实例 |
| DISCONNECTED | 原 UE 进程是否退出，是否只是同工程新启动的另一个 editorId |
| 能发现实例但缺少新工具能力 | 正在运行的 DLL 是否仍是旧版，是否已重编译并重启 |
| MCP_INVALID_ARGUMENTS | 是否取得当前工具的精确 schema，字段名和 refPath 形状是否正确 |
| MCP_TARGET_* | 实际对象类型、图/节点归属、引脚 ID 或对象有效性是否符合要求 |
| PREVIEW_EXPIRED 或版本冲突 | 是否被手工编辑、断线、改绑或超过有效期，需要重新读取预览 |
| BUSY 或 EDITOR_BUSY | 同一 editorId 是否仍有在途修改 |
| TIMEOUT 或 OUTCOME_UNKNOWN | 保留原 requestId 查询结果，不直接重发写入 |
| ROLLBACK_FAILED 或 EDITOR_WRITE_LOCKED | 读取失败详情，人工核查恢复资产，不能靠换请求编号继续 |
| 知识查询旧或缺索引 | 资料目录、工程身份、快照 stale 与菜单更新是否完成 |
| 有指标但模型没有看图 | 检查图片附件是否实际进入当前模型上下文 |
| 已应用但磁盘看不到变化 | 是否只完成内存修改，是否明确执行保存 |

不要用生成脚本、终端鼠标输入或改走其他包装来绕过缺失能力和明确的策略拒绝。错误应帮助确定正确入口及未完成条件。

## 10 面试官追问与设计取舍

### Q49 为什么选择长连接和事件 而不是每次启动 CLI

长连接可以同时承载请求响应和 UE 主动事件，保持编辑器身份、当前选区和异步执行结果。一次操作无需再启动一个 UE 进程，也不用从进程输出猜测命令是否完成。

代价是必须处理断线、旧连接消息、实例生命周期、请求关联和在途写入。项目中的 generation、事件 sequence、pending、requestId 和 uncertain 正是这些问题的具体处理。

这是基于当前实现可以看出的设计取舍；不能据此声称已经测得某个固定的延迟或性能提升。

### Q50 为什么既复用引擎工具 又保留原生 C++ 路径

复用工具集可以覆盖较广的资产能力，跟随编辑器实际注册的 schema，不必为每一种功能重新实现一套桥接接口。

专用原生路径则可以针对风险较高或要求较精确的操作提供更强保证：蓝图的副本预览与版本提交、DataTable 字段深复制、材质批次校验和精确 PIE 实例诊断。

代价是存在两种执行语义，需要清楚说明每个工具是否预览、是否自动保存、事务和恢复保证是什么。不能因为某个操作走了统一 MCP 入口，就把专用原生工具的保证自动扩展过去。

### Q51 这个项目最难和最值得改进的地方是什么

当前难点不只在把 JSON 发到 UE，而在保持上下文与执行语义一致：

- 对话、编辑器、资产、图节点和运行实例都要对应真实身份。
- 动态工具 schema 与真实 UObject 类型要在派发前一致。
- 用户手工编辑、异步返回、超时和断线不能造成盲目重复写入。
- 必须把“未执行、执行失败、已恢复、结果未知、恢复失败”分别表达出来。
- 缓存和推断要保留来源与时效，不能冒充现场事实。

后续演进可以围绕已有边界展开：跨重启的执行记录、更多经过审计的工具语义、明确的远端取消能力、更多引擎版本验证、知识索引精度与增量构建。它们是演进方向，不能算作当前已经实现。

新增一个 UE 能力时，通常需要同步考虑协议 schema、宿主工具注册、能力声明、UE 路由、读写分类、失败恢复、状态展示和测试。知识工具另有 `ProjectKnowledgeTools.inl` 作为后端及公开范围的统一目录，不能只在某一层临时加白名单。

### Q52 用一分钟怎样讲清这个项目

可以这样介绍：

> DSH Unreal Bridge 是连接 DSH AI 助手与 Unreal Editor 的双侧插件。DSH 侧基于 Cordis 注册工具、管理每个对话绑定的 UE 实例，并提供 React 状态面板。UE 侧是三个编辑器模块，分别处理连接与原生编辑、引擎 MCP 适配和项目知识。
>
> 运行时由 UE 主动连接 DSH 的本机 WebSocket。模型的工具调用经宿主校验后，以 JSON 方法和参数发到 UE，由主线程分派到原生 C++ 或引擎已注册的工具。引擎的一部分工具有预置 Python 实现，但桥接不接收模型任意生成的 Python 脚本。
>
> 项目重点处理多实例绑定、真实目标校验、预览与版本冲突、写入互斥、执行去重、超时结果恢复和失败后的保护。知识系统把源码、资料与 UE 快照组织成可检索证据；运行快照和截图补充现场验证。每条执行路径的事务、保存和效果保证都需要分别判断。

## 11 源码阅读地图

建议按“注册工具 → 发请求 → UE 分派 → 具体操作 → 失败恢复”的顺序阅读。以下链接相对仓库，可随仓库一起使用；行号易随开发变化，优先按函数和类名定位。

| 关注点 | 文件与定位符号 |
| --- | --- |
| 包入口、依赖、兼容表 | [package.json](../package.json) |
| 安装配置 | [cordis.patch.yml](../cordis.patch.yml) |
| 宿主工具与批准入口 | [src/index.mjs](../src/index.mjs)，apply、tool、approve |
| 网络、绑定、预览、写入、状态恢复 | [src/bridge.mjs](../src/bridge.mjs)，UnrealBridge |
| 协议与参数 | [src/protocol.mjs](../src/protocol.mjs) |
| MCP 名称与参数适配 | [src/mcp-contract.mjs](../src/mcp-contract.mjs) |
| MCP 脚本及有损入口策略 | [src/mcp-policy.mjs](../src/mcp-policy.mjs) |
| 编辑器写入占用 | [src/editor-writes.mjs](../src/editor-writes.mjs) |
| 整轮保护与单问题额度 | [src/execution-guard.mjs](../src/execution-guard.mjs)、[src/repair-tracker.mjs](../src/repair-tracker.mjs) |
| 可信操作归属与状态投影 | [src/operation-context.mjs](../src/operation-context.mjs)、[src/state-service.mjs](../src/state-service.mjs) |
| 面板与 Remote | [src/client.mjs](../src/client.mjs)、[src/remote.mjs](../src/remote.mjs) |
| 项目技能 | [src/skills.mjs](../src/skills.mjs) |
| 视觉与缓存 | [src/visual.mjs](../src/visual.mjs)、[src/visual-compare.mjs](../src/visual-compare.mjs)、[src/image-analyze.mjs](../src/image-analyze.mjs)、[src/cache-manager.mjs](../src/cache-manager.mjs) |
| UE 模块声明 | [DSHUnrealBridge.uplugin](../unreal/DSHUnrealBridge/DSHUnrealBridge.uplugin) |
| UE 连接与请求总入口 | [DSHUnrealBridgeModule.cpp](../unreal/DSHUnrealBridge/Source/DSHUnrealBridge/Private/DSHUnrealBridgeModule.cpp)，FDSHConnection |
| UE 原生蓝图 | [DSHBlueprintOps.cpp](../unreal/DSHUnrealBridge/Source/DSHUnrealBridge/Private/DSHBlueprintOps.cpp)，Execute |
| UE 原生材质 | [DSHMaterialOps.cpp](../unreal/DSHUnrealBridge/Source/DSHUnrealBridge/Private/DSHMaterialOps.cpp)，Execute |
| UE 原生 DataTable | [DSHDataTableOps.cpp](../unreal/DSHUnrealBridge/Source/DSHUnrealBridge/Private/DSHDataTableOps.cpp)，CopyProperty |
| UE MCP 真实目标与归属 | [DSHMcpTargetValidation.cpp](../unreal/DSHUnrealBridge/Source/DSHUnrealBridge/Private/DSHMcpTargetValidation.cpp) |
| UE MCP 进程内适配 | [DSHUnrealBridgeMCPModule.cpp](../unreal/DSHUnrealBridge/Source/DSHUnrealBridgeMCP/Private/DSHUnrealBridgeMCPModule.cpp)，CallTool |
| UE 知识后端目录与服务 | [ProjectKnowledgeTools.inl](../unreal/DSHUnrealBridge/Source/DSHUnrealBridgeKnowledge/Private/ProjectKnowledgeTools.inl)、[ProjectKnowledgeService.cpp](../unreal/DSHUnrealBridge/Source/DSHUnrealBridgeKnowledge/Private/ProjectKnowledgeService.cpp) |
| 全项目知识更新与快照 | [DSHUnrealBridgeKnowledgeModule.cpp](../unreal/DSHUnrealBridge/Source/DSHUnrealBridgeKnowledge/Private/DSHUnrealBridgeKnowledgeModule.cpp)、[ProjectAssetSnapshots.cpp](../unreal/DSHUnrealBridge/Source/DSHUnrealBridgeKnowledge/Private/ProjectAssetSnapshots.cpp) |
| 私有 Worker | [knowledge-worker.mjs](../unreal/DSHUnrealBridge/Tools/knowledge-worker.mjs) |
| 知识工具约定 | [Tools/README.md](../unreal/DSHUnrealBridge/Tools/README.md) |
| 安装和知识运行时准备 | [scripts/install.ps1](../scripts/install.ps1)、[scripts/prepare-knowledge.ps1](../scripts/prepare-knowledge.ps1) |
| 参数细节与历史验证 | [工具协议](protocol.md)、[视觉说明](visual-comparison.md)、[验证记录](validation.md) |

引擎内部 Python 链路不在本仓库中。相对于 UE 安装的 Engine 目录，可查看以下位置：

| 引擎文件 | 关注点 |
| --- | --- |
| Plugins/Experimental/ModelContextProtocol/Source/ModelContextProtocolEditor/Private/ModelContextProtocolToolSearch.cpp | FCallTool::RunAsync |
| 同目录 ModelContextProtocolToolsetRegistryAdapter.cpp | DispatchToolCall 对接注册表 |
| Plugins/Experimental/ToolsetRegistry/Source/ToolsetRegistry/Private/ToolsetRegistry/ToolsetRegistry.cpp | ExecuteTool 查找工具集 |
| 同目录 FunctionLibraryToolset.cpp 和 ObjectFunctionToolCall.cpp | 转换 JSON 参数并 Invoke 反射函数 |
| Plugins/Experimental/ToolsetRegistry/Content/Python/toolset_registry/tool_call_impl.py | 把 Python 方法包装为 AICallable UFunction |
| Plugins/Experimental/PythonScriptPlugin/Source/PythonScriptPlugin/Private/PyWrapperObject.cpp | CallPythonFunction 进入已注册 Python 函数 |
| Plugins/Experimental/Toolsets/EditorToolset/Content/Python/init_unreal.py | 注册现成 EditorToolset |
| 同目录 editor_toolset/toolsets/data_table.py | get_schema 等读取与整表 JSON 写回实现 |

以 `call_tool` 调用 EditorToolset 的预置 Python 方法为例，调用顺序可概括为：

~~~text
FDSHConnection::Request
  → DSHUnrealBridgeMCP::CallTool
  → FindTool("call_tool")
  → FCallTool::RunAsync
  → DispatchToolCall
  → ToolsetRegistry::ExecuteTool
  → FunctionLibraryToolset
  → ObjectFunctionToolCall
  → UFunction::Invoke
  → UPythonGeneratedClass::CallPythonFunction
  → InvokePythonCallableFromUnrealFunctionThunk
  → 已注册的预置 Python 方法
  → unreal API 与引擎对象
~~~

原生 C++ 工具没有上述 Python 回调阶段；其他顶层 MCP 工具也不一定通过 call_tool 和 ToolsetRegistry 这条调度路径。


