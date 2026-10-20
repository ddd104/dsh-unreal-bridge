# 本机验证记录

## 2026-10-20 工具异常纠正与错误预算

- 默认预算调整为 300 个根工具调用、200 个模型步骤、累计 50 次错误和 30 分钟；显式配置仍有效。成功调用不清零累计错误，换参数、UUID、工具或编辑器绑定不重置预算。
- `MCP_TOOL_ERROR`、策略拒绝、能力不可用，以及已恢复或未写入的验证失败，均把原始错误返回模型处理，不直接取消整轮。模型应按错误修正或改用许可方式，不能绕过被拒绝的操作。未提供回滚的写入失败须先回读真实状态；完成失败后的修正请求使用新 UUID，超时或断线结果未知则先查询原 UUID，不能盲目重放。
- ObjectTools 追加数组元素须原样保留旧元素的 JSON 表示，仅添加新项；不得同时把已有字符串引用重编码成 `refPath` 对象。
- 回滚失败与 `EDITOR_WRITE_LOCKED` 保留跨会话编辑器写锁，并进入最多两次状态查询及最后一次无工具总结；工具、步骤或错误预算耗尽同样收尾。上述情形不直接调用取消接口，总耗时超限仍立即取消。
- `npm run check` 宿主构建与 192/192 项 JavaScript 测试通过，报告 `.test-state/retry-final-check.log`。覆盖第 49 次失败后纠正成功、成功不清零、第 50 次收尾、重复钩子计数去重、结果未知查询原请求、迟到回滚失败升级保护，以及数组失败→回读原 25 项→保留原表示追加 7 项成功的回环编辑器回归。MCP 内层明确回滚失败或写锁信息向上传递，跨会话写锁仍生效；第三方声称已恢复不自动获得回滚保证。
- 实际安装的 DSH ToolRuntime/SystemPrompt 11 组检查通过，构建宿主 MCP 输出与纠错链 7 组检查通过；真实 AgentLoop、Session 校验器和 JSONL 后端 8 组检查通过，纠正提示只注入一次并可冷恢复回放，写锁与回滚失败均到达最后说明。报告 `.test-state/retry-guard-runtime.json`、`.test-state/retry-mcp-runtime.json`、`.test-state/retry-session-runtime.json`。使用合成工具、回环编辑器和离线模型适配器，未调用在线模型或修改 EHV 资产，不将这些检查表述为 DeepSeek 已完成原业务任务。
- 已通过官方插件命令安装到 desktop，配置备份在 `.dsh/profiles/desktop/.plugin-manager/dsh-unreal-bridge-backups/20261020-110040-753`。安装后的宿主及 source map 与本次构建哈希一致；再次对已安装文件运行 MCP 七组与真实会话八组检查全部通过，报告 `.test-state/retry-installed-mcp-runtime.json`、`.test-state/retry-installed-session-runtime.json`。安装器移动的无关本地 `dsh-emotion` 插件已原样移回原位置。
- 下方按日期记录此前版本的实测结果；其中即时取消策略和旧默认预算已由本节取代。此次只更新 DSH 宿主，完整重启 DSH 后加载，无需重新编译或重启 UE。

## 2026-10-20 原生目标预检与安全后处理（0.4.4）

- 10 月 19 日 22:32 的任务使用了正确的关卡蓝图引用，`add_function_graph` 成功后，旧展示代码把子对象路径降为 World，并在打开/聚焦两阶段重复打开地图。EHV 日志记录两次 `MAP LOAD`；本次退出没有新崩溃调用栈，不能推断具体底层崩溃指令。修复同时覆盖调用前和调用后的目标检查，不把这次问题简化为模型参数错误。
- 宿主保留精确 JSON schema 校验，新增绑定版本检查，A→B→A 也使预检失效。执行 MCP 必须具备 `mcp_target_validation`，旧编辑器可以发现工具但不能绕过原生预检执行。UE 在快照、工具派发和请求日志写入前，从当前注册表重新读取 schema，检查 UObject 真实类型、`Class@` 继承、graph/node 库存与归属及 PinID。校验不执行工具探测、不导入属性、不加载资产；顶层未加载资产可用注册表类型证据，未加载子对象及未知引用类型拒绝。
- 原生 `MCP_TARGET_* / execution:not_started` 拒绝不消费执行 UUID，宿主保留原错误类型与细节；纠正参数后可使用相同 UUID，已执行的结果继续去重。嵌套调度拒绝；跨蓝图批量 `get_node_infos` 允许独立读取，连线、布局等上下文操作保持归属约束。已有 DataTable 有损写入策略和未知写入失败保护保留。
- 布局保留原 owner/graph 弱身份，路径/GUID 被替换对象复用时不套用旧快照。展示仅使用已加载的受支持资产，保留真实关卡蓝图身份，禁止打开 World/Level；关卡必须属于当前编辑世界或其已加载流送关卡。首次至多打开一次，第二阶段只聚焦；失效后不按同名路径重绑。手动 focus 保留子对象路径，同样检查展示能力、真实类型和当前世界归属。
- `npm run check` 通过 187 项宿主测试；UE 5.8.2 完整 Editor 目标与增量构建成功。新原生回归九项通过（目标校验三项、展示四项、关卡查询两项），旧布局、MCP 展示提示、蓝图事务与定时器回归十一项通过。证据 `.test-state/target-validation-host-check-final.log`、`target-validation-native-build-final.log`、`target-validation-native-build-fixture.log`、`target-validation-regression-report/index.json`。首轮展示测试夹具创建抽象 UObject 触发 ensure，已改用具体 DataTable 对象；通过结果来自修正后重新运行的报告。
- `scripts/mcp-target-validation-e2e.mjs` 在独立 HostProject 的六组真实桥接验证通过：错误 World→Blueprint 不修改地图；同 UUID 改为真实 level BP 后新建函数且未保存；错误或不存在 DataTable 引用拦截；普通 Actor 蓝图正常；嵌套节点类型错误拦截；跨蓝图排版拒绝且双方状态不变。报告 `.test-state/target-validation-e2e-final/result.json`；本次未修改或保存 EHV 资产，没有调用模型。
- 预检证明目标的类型和已覆盖的归属条件，不证明任意第三方工具的全部属性写权限、图语法、引脚类型兼容或内部实现安全。编译、业务结果和保存仍需具体操作验证。本版本需同步更新 DSH 宿主与编译后的 UE 插件，重启两端生效。

## 2026-10-19 收尾消息持久化失败（宿主 0.4.3）

- 会话 `session-c0891fc4-fdcd-43b1-98a5-93e8ac9ee385` 第 2 轮在北京时间 21:40:45–21:40:57 失败。两次 `unreal_mcp_describe` 传空 `query`，一次 `get_properties` 使用 `object/property_names` 而非真实的 `instance/properties`，累计三次本地参数错误，触发正常收尾。随后 0.4.2 新增提示以 `role:developer` 经 `agent/pre-step` 返回；该入口只接受用户角色并统一写入 `user/message`，真实会话校验在 seq 247 拒绝消息，最终 seq 248 以 `UNKNOWN` 结束。此前仅验证消息构造与 ToolRuntime，遗漏会话保存路径，这是 0.4.2 引入的回归。
- 提示改为符合官方 `UserMessage` 约定的用户角色 notice；已取消、下游明确清空输入、空首步时保留原决定，避免提示重新激活被抑制的步骤。参数说明和指南补充空查询应省略、紧凑列表不含 schema、调用前须定向读取完整参数定义。
- `npm run check` 通过 183/183 项测试，其中守卫 34 项；真实已安装 DSH SystemPrompt/ToolRuntime 八组验收及构建宿主 MCP 输出六组验收通过，报告 `.test-state/notice-host-check.log`、`notice-guard-runtime-check.json`、`notice-built-runtime-check.json`。
- 新增 `scripts/execution-notice-session-check.mjs`：使用真实已安装 AgentLoop、Session 校验器与 JSONL 后端，旧 developer 提示负例确实复现同一异常；预警、调用耗尽、错误耗尽、步骤耗尽四条实际循环均到达最终回复，提示成功保存，三类收尾最终工具列表为空。刷新落盘并关闭后端后，以新后端读取并通过 `Session.fromRestore` / `Session.create` 回放全部事件。报告 `.test-state/execution-notice-session-check.json`。模型响应使用离线适配器，不将本测试视为业务任务生成成功。
- 原失败轮次在 UE 仅执行 `get_default_object` 和 `get_graph_dsl_docs` 两次成功读取，无资产修改或保存。本补丁只更新 DSH 宿主；原生 UE 保持 0.4.2，不需重编译或重启 UE。

## 2026-10-19 调用预算收尾与关卡蓝图入口（0.4.2）

- 针对 `session-c0891fc4-fdcd-43b1-98a5-93e8ac9ee385` 的第 41 次工具调用硬取消，默认预算改为 120 次工具、80 个模型步骤和 600 秒，显式较小配置保持有效。80% 时通过工具结果和模型步骤消息提示剩余预算；普通调用、步骤或可纠正错误预算耗尽停止新操作，保留最多两次状态恢复查询和有限收尾，恢复阶段加最后无工具总结最多两次额外采样。最后采样通过官方 `system-prompt/assemble` 去掉全部工具；写入错误、完整性、策略与超时仍立即取消。
- `npm run check` 构建及 181/181 项 JavaScript 测试通过。32 项守卫测试覆盖 39→41 次继续、120 次之后拒绝、恢复次数与根调用去重、无工具收尾、下游拒绝不消耗收尾采样、旧轮次预检拒绝后迟到回调隔离，以及全部致命保护。
- 实际安装的 DSH SystemPrompt/ToolRuntime 八组验收通过，报告 `.test-state/execution-budget-runtime-check.json`；验证明确的 `EXECUTION_BUDGET_EXHAUSTED`、零普通预算取消、真实工具列表过滤和最后零工具 schema。构建插件的实际 DSH 输出、原始错误、旧编辑器能力提示六组验证通过，报告 `.test-state/interruption-runtime-check.json`。
- 新增只读 `unreal_level_blueprint` 和 UE `level_blueprint_lookup` 能力，从地图取得现有蓝图、图引用和地图保存目标，不创建蓝图、不切换世界、不改变名称或原 dirty 状态。两组原生自动化通过；`scripts/level-blueprint-e2e.mjs` 的四项真实 UE 5.8.2 验收通过，使用返回引用调用现有 MCP `list_graphs` 和 `read_graph_dsl` 成功。报告 `.test-state/level-blueprint-e2e-final/result.json`，不涉及 EHV 资产或地图保存。
- 已备份并安装 EHV 的 0.4.2 原生 DLL、符号、模块描述和对应源码，八个文件哈希一致；记录 `.test-state/interruption-editor-installed.json`。运行中的编辑器继续持有旧映像，未结束用户进程；退出并重启 UE 后加载新能力。DSH 宿主也须重启加载预算及指南更新。普通蓝图原生预览、应用与保存仍不接受关卡子对象，关卡图读写通过发现的 MCP 工具执行并遵循其失败保证。

## 2026-10-19 MCP 调用适配与错误恢复（0.4.1）

- 复现 DSH 会话 `session-9a36baf9-bbba-40c7-aea5-bbfcc8fb12b4` 的失败：工具完整名被重复拼接，`dataTablePath` 与真实的 `data_table` 参数不符，首次读取失败触发整轮取消。发现结果现在同时返回短名与完整名；调用自动规范化，并在同一编辑器获取当前 schema，用 Ajv 检查必填、类型、嵌套引用及未知参数，未通过时不派发执行。
- 已核验的 DataTable 查询错误保留 UE 原文并允许预算内纠正；未知或写入错误、策略拦截、完整性及回滚失败继续停止。覆盖原始封装、空或省略工具集的顶层调用、完整名隐藏的嵌套调度、跨编辑器 schema、绑定切换及只读超时，调用规范化后重新检查策略。
- 宿主构建成功，168/168 项 JavaScript 测试通过；依赖审计无已知漏洞。`scripts/mcp-read-e2e.mjs` 在隔离 UE 5.8.2 HostProject 的四项验收通过：真实 schema 与短名、原错误参数零派发、完整名读取失败保留原文、同会话后续查询成功并返回 18 个结构。证据 `.test-state/mcp-adapter-live/result.json` 与 `editor.log`；未修改 EHV 资产、未调用模型。
- `scripts/mcp-runtime-check.mjs` 使用实际安装的 Cordis 4.0.5 与 DSH ToolRuntime 0.2.1-rc.2 验证工具输出。先复现错误详情含 `undefined` 时被严格 JSON 校验拒绝，再确认修复后的原始 UE 错误、参数预检、顶层工具未找到、无请求编号的发现错误均通过 output schema 与 render；只读错误可纠正继续，未触发取消。报告 `.test-state/mcp-contract-runtime-check.json`，仅使用合成回环编辑器和只读包解析元数据。
- 已通过 DSH 官方插件命令安装 desktop 宿主 0.4.1，保留配置备份。只涉及宿主 JavaScript 与依赖，不需重编译 UE；完整退出并重启 DSH 后加载新代码。

## 2026-10-19 蓝图编辑后自动布局

- UE 插件新增 `automatic_graph_layout` 能力。原生补丁在整批编辑结束后整理目标函数或事件块，再编译并记录最终版本；布局纳入原编辑事务。UE MCP 成功调用通过编辑前后的图内容差异识别目标，返回前完成整理，并在 `dshLayout` 中报告最终版本、警告和独立撤销步骤。读取、撤销、显式移动及显式排版不重复触发整理。
- 布局按执行、数据和委托依赖分层，处理循环、重路由、共享纯节点和嵌套注释。注释成员按原节点锚点确定，默认值变长时扩展原框；不依赖窗口或随机新 GUID。布局先规划后写入，坐标和工作规模检查失败时不留下部分坐标修改。功能范围是桥接工具编辑，不监听其他手工操作。
- 宿主构建及 145 项 JavaScript 测试通过，记录 `.test-state/blueprint-layout-host-check.log`。UE 5.8.2 隔离 HostProject 完整 Editor 目标编译、链接通过，记录 `.test-state/blueprint-layout-build-final.log`。
- UE 自动化 11/11 通过：新增 `DSH.Bridge.BlueprintLayout` 八组，覆盖拓扑与分支、事件及函数隔离、委托和共享纯节点、循环和注释、内容增长扩框、重复整理和新 GUID 稳定、坐标失败原子性、原生预览与一次撤销、MCP 多图与失败/移动排除；原 `BlueprintComponentSelection`、`BlueprintRoundTrip`、`BlueprintTimerPatch` 三组回归通过。报告 `.test-state/blueprint-layout-native-report/index.json`，日志 `.test-state/blueprint-layout-native.log`。
- `scripts/blueprint-layout-e2e.mjs` 在隔离工程中通过 7 项真实桥接检查：能力声明、原生无坐标批量排版及最终版本、一次撤销恢复、MCP 显式移动保留、真实 `BlueprintTools.set_pin_value` 自动整理及版本和撤销说明、同请求去重、同值编辑无布局漂移。结果 `.test-state/blueprint-layout-e2e/result.json`；没有付费模型调用，也没有修改 EHV 蓝图资产。
- 已更新 DSH desktop 和 EHV UE 插件；11 个 UE 文件及宿主构建产物哈希校验通过，知识配置和项目技能保持原值。实际安装的 DSH 运行时加载验证为 PASS。UE 备份 `F:/UE5Project/EHV/Saved/DSHUnrealBridgeBackups/20261019-172137-813/DSHUnrealBridge`，安装记录 `.test-state/blueprint-layout-installed.json`；需要重启 DSH 和 UE 才加载新代码。

## 2026-10-19 DataTable 原子写入与任务熔断

- `npm run check` 构建成功，145/145 项 JavaScript 测试通过。新增覆盖危险路由在派发前拦截、原生复制幂等、旧插件拒绝、MCP 内层错误传播、回滚失败跨对话写锁，以及超时后查回失败仍保留写锁。执行保护覆盖跨工具与 UUID 变化、根调用去重、模型步骤、累计错误、计时器、并发预检及调用 Agent 取消接口。
- UE 5.8 隔离 HostProject 构建成功，`DSH.Bridge.DataTableCopy` 4/4 组原生测试通过，进程退出 0。验证嵌套 Map、向量、软引用、字符串和静态数组保留；真实变化监听器故意清空源 Map、修改无关字段和增行后，操作检测失败并恢复行数据、行集合及原 dirty 状态。已有未保存数据从操作前的内存恢复；一次撤销恢复全部目标。日志 `.test-state/write-safety-build.log`、`.test-state/write-safety-native.log`，报告 `.test-state/write-safety-native-report/index.json`。
- `scripts/write-safety-runtime-check.mjs` 在实际安装的 DSH Electron/Node 24.21.0、Cordis 4.0.5、dsh-tools 0.2.1-rc.2 中运行，5 项离线验收通过，退出 0。真实工具管线证明：超预算调用不执行工具体；换工具和请求 ID 无法绕过；新宿主轮次可重新开始；即使外层 runtime 成功，内层 MCP 错误仍取消；普通源码搜索放行而真实输入脚本在执行前被挡；真实 `agent/pre-step` waterfall 执行步骤限制。记录 `.test-state/write-safety-runtime-check.json`。
- 本轮未调用模型 API，未替换 DSH desktop 或 EHV 的已安装插件，未操作用户鼠标或修改 EHV 资产。宿主 bundle 与隔离工程 DLL 已构建；生效需要更新宿主与 UE 插件并重启相应应用。通用 MCP 工具不具备统一的原子回滚保证，遇错会结束任务并报告未验证状态，不能声称自动恢复。

## 2026-10-19 工作区 UE 插件技能接入

- `npm run check`：107 项 JavaScript 测试通过，其中 9 项技能测试覆盖工程/子目录发现、最近 `.uproject` 边界、跨工程隔离、目录和平铺技能、原生 YAML 调用策略、相对资源、同名覆盖优先级、正文重读、文件监测、首次安装后恢复和清理。
- 用已安装 DSH 的 Electron Node 运行 `scripts/skills-runtime-check.mjs`，加载真实 Cordis、LocalFileSystem 和 SkillRegistry，并通过构建后的桥接 bundle 注册提供方。临时工程中验证发现、加载、切换工程隔离、正文更新、资源基目录与无编辑器连接读取，结果 `PASS`。
- 同一检查以只读方式枚举并加载了 EHV 插件的 `sr-proto-handler`、`ue-project-graph`，路径均来自 `F:\UE5Project\EHV\Plugins\DSHUnrealBridge\Skills`。没有调用模型、改写 EHV 文件或替换当前 DSH 安装；运行报告保存在本机 `.test-state/skills-runtime-check.json`。
- 本次功能仅需更新 DSH 宿主 bundle 及依赖并重启 DSH；UE 编译与已有资产操作不涉及本次变更。UE 打包规则已扩为包含整个 `Skills/`，使新增技能及其资源随插件交付。

## 历史交付验证

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

## 2026-10-15 项目知识模块整合与 EHV 验证

- 将原 AgentProjectGraph 的项目图谱、知识记忆和资产快照整合为 `DSHUnrealBridgeKnowledge` 编辑器模块，通过现有 DSH 会话提供 `unreal_knowledge` 与 `unreal_knowledge_record`；没有启动第二套 MCP 或 HTTP 服务。实时资产操作仍使用 UE MCP。
- DSH 宿主 19 项测试、Node 知识工具 25 项测试、隔离 UE 工程知识模块 6 项测试通过；UE 5.8 `BuildPlugin` 编译与打包成功。
- 已将插件源码及新编译的三个模块安装至 `F:\UE5Project\EHV\Plugins\DSHUnrealBridge`，安装后二进制与编译包的 SHA-256 逐项一致。原 `AgentProjectGraph` 备份于 `F:\UE5Project\EHV\Saved\DSHUnrealBridgeBackups\20261015-184312-197\AgentProjectGraph`。
- EHV 执行 `DSHUnrealBridge.Knowledge.ToolsMenuUpdate` 后，资产快照索引显示 `scanComplete=true`、`captureComplete=true`，覆盖 2,988/2,988 个资产，其中 32 个资产有未解析依赖。知识服务返回 `status=ready`、`needsUpdate=false`、`sourceFresh=true`、记忆 `fresh`；图谱有 19,710 个节点、36,907 条关系。测试日志位于 `.test-state/ehv-knowledge-update-release.log`。
- 该项 EHV 自动化测试报告为 `Fail`：遍历资产时，工程现有蓝图缺失父类、函数和依赖，并输出大量编译错误，被 UE 自动化框架计入测试错误。进程正常退出，未再出现此前的节点工具提示断言；索引与知识状态已单独核实为完成。这项测试不能记录为通过。
- 本次 EHV 验证只更新插件的生成缓存，没有保存或修改工程资产。DSH `desktop` 插件文件已同步；正在运行的 DSH 进程需要重启后才会加载新宿主代码。

## 2026-10-15 修改后展示增量验证

- `npm run check` 成功，20 项 JavaScript 测试通过，包括手动定位工具的会话绑定与旧版编辑器能力检查。
- UE 5.8 中三个插件模块编译、链接成功；隔离 HostProject 的蓝图回合、MCP 展示目标解析和输入拒绝自动化测试通过。
- 同一隔离工程的图形编辑器测试通过：蓝图资产打开、窗口最大化并切换到目标图；材质资产打开、窗口最大化并执行表达式定位。
- 真实桥接端到端测试通过 8 项，覆盖创建、图补丁、手动定位请求、撤销、保存及重连。无界面命令行编辑器跳过窗口展示，避免在自动化进程中打开 Slate 编辑器。
- 本次修改保留在工作区及隔离测试工程，未同步至 EHV 或已安装的 DSH 插件。

## 2026-10-16 BeginPlay 日志任务复盘与修复

证据来自本机 DSH 会话 `3970199d-1315-4963-ad5b-2d3f85c5badf` 与 EHV 编辑器日志；用户请求为“在actor里面添加逻辑，在开始运行的时候，也打印日志”，目标是 `/Game/EHV/Blueprints/ADAS/BP_RoadTimePrint`。

- 运行时间为北京时间 15:16:54.216 至 15:22:42.085，共 347.869 秒；57 个模型步骤，67 次工具调用。模型步骤响应累计约 186.9 秒，工具执行累计约 158.6 秒（并发与调度会使两者不严格相加为总时长）。
- 44 次工具调用属于文件读取、源码搜索、目录枚举和命令执行。两次全引擎目录递归分别耗时 49.95 秒和 45.86 秒。目标图在第 5.8 秒已经读取，真正的 `write_graph_dsl` 写入发生在第 326.9 秒，仅耗时约 0.31 秒。
- 主要绕路包括：研究默认 BeginPlay 幽灵事件的源码；无关的全项目搜索；使用非 UUID 请求编号导致失败；`requireApproval: true` 与 `approval: never` 冲突导致应用被自动拒绝；随后查询配置和改走另一工具；猜测 ObjectTools 参数并反复修正。旧的项目知识技能还要求所有实现前执行全项目上下文流程。
- 运行中的 UE 插件未声明 `focus_asset`，DLL 时间为 2026-10-15 19:06:41；此前的展示功能仅在工作区和隔离测试工程验证，未安装到 EHV。任务运行期间无该资产的编辑器打开记录，下一条打开记录在 15:23:06。当前磁盘配置已经设为 `requireApproval: false`，不能据此倒推历史运行的有效配置。
- 修复宿主指引：局部蓝图修改直接读取、预览、应用、核验；不因默认幽灵事件而搜索引擎源码；拒绝写入后明确停止，避免通过其他工具绕过批准。状态接口返回有效批准配置，节点读取返回启用状态和幽灵事件标记。
- 修复 MCP 展示适配：解析 UE 的嵌套 `refPath`，并对指定图捕获修改前后节点差异，使返回空值的图修改也能聚焦新增或变更节点。该比较仅在编辑器内进行，不增加模型或工具往返。
- 宿主构建及 21 项 JavaScript 测试通过；UE 5.8 主模块编译、链接成功。5 项 UE 自动化测试通过，覆盖蓝图预览/应用及幽灵事件激活、MCP 包装引用及节点差异、蓝图窗口打开/最大化/目标图和两个节点选中、材质展示、非法输入拒绝。首轮窗口测试额外调用打开图接口扰动了选择状态，改为直接读取当前编辑器选择后定向复跑通过；日志分别为 `.test-state/audit-focus-automation.log` 和 `.test-state/audit-focus-window.log`。
- 修复保留在本工作区和隔离测试工程，未覆盖正在运行的 EHV 插件，也未重新执行用户蓝图修改。未做付费模型复跑，因此尚无修复后模型调用次数或端到端耗时的实测结果。

## 2026-10-16 定时器任务耗时分析与流程优化

本机 DSH 会话 `db4dd26c-4026-4e49-9e7b-471cb64a4165` 在 16:42:00.206 至 16:46:37.203 执行“每隔 1 秒打印时间，BeginPlay 打印 Start”，共 276.997 秒、32 个模型步骤和 31 次工具调用。模型响应累计约 259.1 秒；工具执行累计约 16.3 秒，其中 PIE 启动及预热占 6.4 秒。第 143 秒完成蓝图应用与编译，第 160 秒完成连线回读，此后约 117 秒用于 PIE、日志和父类调查，仍未获得该 Actor 的运行输出。

- 宿主指引改为先读取当前完整图，再规划编辑；编译和一次图回读成功后结束。默认不启动 PIE；仅在明确要求运行时验证，或静态检查不足且已确认实例运行时使用。UE MCP 工具集说明支持按工具名过滤和只列简短名称，避免将整套 schema 溢出后再用命令行解析。
- UE 补丁新增 `add_custom_event`，可与原生 `K2_SetTimerDelegate`、默认值和连线一起在一份预览补丁中提交。新 UE 实例通过 `custom_event_patch` 声明能力；旧实例继续使用原来的 UE MCP 路径。
- 宿主构建和 23 项 JavaScript 测试通过，并已安装到 DSH `desktop` profile，重启 DSH 后加载。初次隔离 UE 构建因系统提交内存接近上限持续重试 PCH 编译而中止；用户关闭 EHV 编辑器后，利用 EHV 现有编译缓存成功编译、链接新模块。`DSH.Bridge.BlueprintTimerPatch` 自动化测试通过，覆盖自定义事件、定时器委托、预览不改原图、应用编译与回读；日志为 `.test-state/ehv-timer-build.log` 和 `.test-state/ehv-timer-automation.log`。EHV 已安装新的 UE DLL，重新打开编辑器后加载。尚无新流程的端到端模型耗时实测。

## 2026-10-17 关卡 Actor 与组件选区同步

- 现有选区事件新增 Actor 和组件实例，保留 Content Browser 资产格式。同步最近操作的选区，组件优先于所属 Actor；包含显示名、类、世界及实例路径、可用的类蓝图路径，组件额外包含所属 Actor。DSH 面板按类型显示，并把实例路径与蓝图路径的用途传给模型。
- `npm run check` 成功，25 项 JavaScript 测试通过；新增测试覆盖场景选区字段保留、资产/实例切换、清空、乱序保护、对话隔离，以及 Actor/组件面板显示。
- UE 5.8 隔离工程编译、链接成功；`DSH.Bridge.LevelSelection` 原生自动化测试通过，进程退出码 0。测试覆盖原生 Actor、多选、组件优先、取消选择、类蓝图与所属 Actor 蓝图、初始化已有选区、解除监听，以及禁用旧通知的 UE5 视口选择接口。日志为 `.test-state/level-selection-build-final.log` 和 `.test-state/level-selection-automation.log`。
- 隔离工程通过真实 WebSocket 宣告 `level_selection`；使用已发现的 UE MCP `SelectActors` 选择已有 Actor，宿主收到 `SM_SkySphere` 的实例信息，随后收到双 Actor 选区和清空事件。事件记录为 `.test-state/selection-live-state/events.json`。组件链路已由原生事件测试及宿主协议/UI 测试覆盖，本轮未将真实鼠标点选组件列为通过项。

## 2026-10-17 Actor 蓝图编辑器组件选区

- 新增 Actor 蓝图编辑器 Components 面板同步，通过 Blueprint Selection Notifier 接收原有组件树的选择事件，支持组件切换与多选。同步模板路径、变量名、所属 Actor 蓝图和继承标记，使用 `source:"blueprint_editor"` 与关卡实例区分；DSH 面板显示“蓝图组件”和“所属蓝图”。只查询已有继承覆盖，不为选区同步创建组件覆盖。
- 宿主构建及 26 项 JavaScript 测试通过。新增测试验证蓝图模板上下文完整传输、不混入关卡实例字段，并验证面板展示。
- UE 5.8 编译、链接成功；`DSH.Bridge.BlueprintComponentSelection` 在隔离编辑器中通过，退出码 0。测试实际打开 Actor 蓝图，通过 Components 树的选择接口验证模板路径、变量名、所属蓝图、组件多选与切换、启动时已有选区、关闭当前窗口清空，以及关闭旧窗口不覆盖后来的 Content 选区。日志为 `.test-state/blueprint-component-selection-build-final.log` 和 `.test-state/blueprint-component-selection-automation.log`。
- 本机引擎将 Blueprint Selection Notifier 标为内部接口，编译会有相应提示；本轮验证范围为当前 UE 5.8 构建。未将真实鼠标点选或其他引擎版本列为通过项。
## 2026-10-17 局部画面对比（0.3.0）

- `npm run check` 通过，68 项 JavaScript 测试覆盖图像算法、结果图库、附件持久化、真实 WebSocket 协议夹具、多对话截图排队、参考读取权限、取消与绑定变化。新增比较在主机范围排队，4K 原图比较实测约 3.27 秒、峰值 RSS 323 MiB。
- 本机 UEAS58 已更新至 5.8.2。独立 HostProject 的三个模块完成编译和链接，完整目标构建通过 UE 官方流程重新生成当前 BuildId `717ce51e-7d91-490e-b61d-b7032ba4bce8`；没有手工更改引擎或插件 BuildId。首轮单模块构建未更新旧元数据，启动测试因此失败；完整目标构建后已解决。
- 真实 D3D12 渲染自动化 `DSH.Bridge.VisualCapture.Projection`、`RenderedViewport`、`Validation` 全部成功，进程退出 0。覆盖 Actor/组件 PNG 裁剪、近裁面、离屏/后方目标、模板拒绝、矩形区域、文件不覆盖，以及选中轮廓/操作手柄恢复。日志 `.test-state/visual-automation-final.log`；报告 `.test-state/visual-automation-report-final/index.json`。
- `scripts/visual-e2e.mjs` 在独立渲染编辑器中执行 7 项真实桥接验证并通过：能力发现、原图和元数据引用、同图回归通过、人为改色失败/热图、不同尺寸设计图不做像素判定、区域截图、无效目标不影响资产写入状态。结果 `.test-state/visual-e2e/result.json`。
- 使用实际安装的 DSH 附件服务 0.2.1-rc.1 验证了 PNG 解码、原生图像块、JSON 历史回放与新服务实例重新读取；记录 `.test-state/visual-installed-runtime-check.json`。没有调用外部模型 API，所以本记录不把真实模型生成的中文评审列为已实测项。模型解释通过工具指南和原生双图输入接入当前对话。
- 已安装到 DSH `desktop` 配置及 `F:\UE5Project\EHV\Plugins\DSHUnrealBridge`。旧配置备份 `C:\Users\NiubilityPC\.dsh\profiles\desktop\.plugin-manager\dsh-unreal-bridge-backups\20261017-183800-887`；旧 UE 插件备份 `F:\UE5Project\EHV\Saved\DSHUnrealBridgeBackups\20261017-183800-887`。三个 DLL 和模块清单与独立工程验证版本 SHA-256 一致，记录 `.test-state/visual-installed-binaries.json`。已验证安装后的宿主模块可导入，sharp 0.35.5 在忽略安装脚本后仍可实际生成 PNG。
- 当前 JavaScript 依赖审计无已知漏洞。场景资产未改动，没有结束或重新启动用户应用；应用重新打开后加载新版本。支持范围为编辑器视口、单帧 SDR；遮挡/背景仍可能包含在目标包围矩形内。

## 2026-10-17 天空颜色任务日志复盘与宿主修复（0.3.1）

- 依据 DSH 会话 `session-f9874096-5a85-4f76-8141-d08138fa1923` 的日志还原 18:51:50–18:55:07（上海时间）任务。两种视觉工具共三次返回 `ToolOutputError / INVALID_TOOL_OUTPUT: value is not lossless JSON`；用户后续明确只比较天空色彩后，模型未重试视觉工具，改用窗口截图与临时脚本。脱敏摘录 `.test-state/sky-log-audit.json` 保留原始行号。原日志未修改。
- 日志只证明 DSH 拒绝返回值，不能单凭这条错误断定渲染或 UE 序列化失败。进一步检查本机已保存的三份原始 `capture.json`，均发现 `camera.rotation[2]` 是负零。使用实际安装的 DSH `ToolRuntime.execute` 及这份原始元数据重现了同一个输出错误；图片实际已成功生成。
- 宿主将无渲染意义的 `-0` 规范为 `0`，省略可选对象字段中的 `undefined`。NaN、Infinity、函数、循环引用等保留严格拒绝，并在 `INVALID_VISUAL_OUTPUT` 中说明具体字段路径；没有采用会静默丢失数据的 JSON stringify 往返。图像附件持久引用与 `unknown`/`null` 均保留。`unreal_state.visualTools` 返回已加载版本及 revision，减少对旧回合失败状态的沿用。
- 新增 `analysis: color_distribution` 与 `currentRegion`。不同尺寸的明确矩形区域可以比较颜色分布，不进行像素配准、SSIM/边缘合格判定或生成像素热图。原生像素统计 RGB 均值/中位数、Lab、线性 sRGB 相对亮度和分位数，不用棕色阈值选样本，不把图像相对亮度比当作曝光/照明强度之比。更新结果卡片、工具指南和参数说明。
- 原任务临时脚本首次裁剪到了编辑器下方并报 TypeError，第二次又使用参考/当前不同的棕色阈值找区域。这些过程会影响样本。日志未读取光照控制器当前状态、实际混合权重或曝光，因而无法证实最终调参建议的因果链。指南要求将这些因素明确保留为待验证假设。
- 使用当次已保存原图做独立矩形区域回放（按可见地平线选区，不按颜色筛选），不同尺寸下成功输出咨询统计、保留两图且不生成空间热图。记录 `.test-state/sky-color-replay-result.json`；结果仍受视角和云层构成影响，不代表物理参数验证。
- `npm run check` 通过，80 项测试；新增实际负零回归、非法值字段路径、颜色分布、不同尺寸/区域、零亮度分母和卡片说明测试。实际安装的 DSH 0.2.1-rc.2 工具执行层验证通过：修复前复现拒绝，修复后截图和双图比较均通过 output schema/render 校验，并保留原生图片块。可复现脚本 `scripts/visual-runtime-check.mjs`，证据 `.test-state/visual-runtime-signed-zero-check.json`。未额外调用模型 API。
- 本次仅更新 DSH 宿主 0.3.1，兼容已安装的 UE 0.3.0 截图接口；不需要重编译或替换 UE DLL。DSH 重启后加载新工具指南及实现。

## 2026-10-17 PIE 实例诊断与生命周期（0.4.0）

- PIE/SIE Actor 与组件选区附带独立运行、世界及对象句柄，保留编辑世界和蓝图组件原格式。按需 `unreal_runtime_snapshot` 同步读取反射属性、可用类默认值、继承关系、组件状态和引用，并记录 UTC 时间及帧号；不执行游戏函数，不自动采样。
- 销毁、世界卸载和 EndPIE 使旧句柄失效，重开 PIE 不按名称或相同路径恢复目标。UE 使用弱引用及 1024 个句柄的 LRU 上限，回收通知为 `tracking_evicted`，并保护正在采样的主对象。DSH 每对话保留最近 20 份、总计最多 16 MiB 的历史；离线、解绑和切换编辑器后仍可读取已采集数据，不能冒充实时状态。
- 宿主校验响应的真实连接、绑定版本及精确目标身份；运行结束或销毁先于响应到达时，快照保留为已失效历史。传输后的 JSON 递归校验拒绝非有限数值，再规范负零，覆盖 UE 变换和反射属性的严格 JSON 输出问题。两个新工具均为只读，`allowWrites:false` 下可用。
- `npm run check` 通过，98/98 项测试，包括 15 项运行协议/生命周期测试和 7 项面板测试。覆盖同路径重新生成、旧会话/旧句柄、乱序、对话隔离、离线历史、读取期间 A→B→A 绑定切换、读取期间失效、负零、历史数量/字节上限以及句柄回收。
- UE 5.8.2 的隔离 HostProject 完整 Editor 目标构建通过；记录 `.test-state/runtime-build-final.log`。`DSHUnrealBridge.Runtime` 三组及原 `LevelSelection`、`BlueprintComponentSelection` 共 5/5 通过，报告 `.test-state/runtime-native-final-report/index.json`。原生测试覆盖真实反射分页、跨世界拒绝、组件/Actor 销毁、世界卸载、1024 上限回收及采样主对象保护。
- `scripts/runtime-e2e.mjs` 在隔离编辑器中启动两次实际 PIE/SIE 会话，7/7 项桥接验收通过：能力发现、Actor 与组件选区、暂停快照、销毁失效、重启同路径的新身份、EndPIE 不断线、编辑器退出后读取历史。证据 `.test-state/runtime-e2e-final/result.json` 与 `editor.log`，未调用付费模型。使用 NullRHI 验证运行与同步，未验证真实鼠标 F8 操作或画面渲染；测试日志中的无视口 SIE 切换警告不属于截图或视觉验收。
- 本次未替换 DSH desktop 或 EHV 的已安装插件，也未修改 EHV 资产。源码、DSH bundle 和 UE 编译产物已准备；实际使用 0.4.0 时需要同时更新宿主与 UE 插件。执行 Trace、断点现场读取及 PIE 截图不在本次交付范围内。
