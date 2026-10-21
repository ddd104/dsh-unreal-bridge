# 本机验证记录

## 2026-10-21 模型参数恢复与等待计时

- 最新失败会话的材质补丁含一个多余的 `}`，DSH 在工具派发前以 `MALFORMED_RESPONSE` 结束；本次新增独立 `model-recovery` 模块，通过官方 `agent/request-error` 接口在当前 UE 任务中有限重新生成。默认每轮 2 次，设置可关闭；原始失败参数保持不变，已执行工具不重放，原预算及写保护继续生效。
- 计时改为扣除官方问题请求的纯等待区间，并行工具工作时仍计时。回答、异常或取消后恢复剩余预算；状态显示等待及暂停时间。实际安装的 DSH `0.2.1-rc.2` 问题服务实测：等待 125ms 超过测试期限 80ms 未被取消，回答后按原剩余时间恢复。记录 `.test-state/wait-budget-runtime-check.stdout`。
- 构建通过，JavaScript 全套 **354/354** 通过；其中模型参数恢复新增 6 组、等待计时新增 8 组。材质指引补充显式通道、精确 schema、完整可编译批次、真实预览编号及材质/组件赋值/地图保存的独立检查，技能结构及引用检查通过。
- 新增 `scripts/model-recovery-session-check.mjs`，使用真实安装的 AgentLoop、Session 校验器及 JSONL 后端完成 **7/7** 场景：同一步重新生成、每轮上限、关闭、非 UE 参数不恢复、预算未激活或已耗尽不恢复、下一轮重新计数。验证失败响应中的合法兄弟调用也不执行、先前成功操作不重放、修正补丁只执行一次，以及提示的冷读恢复和回放。构建报告 `.test-state/model-recovery-session-built.json`。
- 最终构建通过实际 DSH 的 MCP **7/7**、设置/生命周期 **8/8**、会话/执行保护 **8/8**，报告 `.test-state/task-recovery-{mcp,settings,session}-runtime.json`。全部使用离线适配器、临时状态及模拟工具；没有在线模型请求或真实 UE 业务资产修改，不代表原材质业务任务已经完成。
- 本次安装仅更新宿主及三份材质技能 Markdown，无需重新编译 UE。安装备份、哈希和自定义偏好保留记录见 `.test-state/task-recovery-installed.json`、`.test-state/task-recovery-skill-installed.json`；DSH 完整退出后重开加载新宿主，旧会话需重新加载材质技能。

## 2026-10-21 材质 skill 的通用细节检查

- 将入口和两份参考文档从偏重二维图形的描述改为按当前目标选择空间分布、表面响应、覆盖合成和时间/驱动特征。移除分段圆与径向孔洞的案例公式，保留共享约束、明确排除条件和主动纠偏方法；示例不作为所有材质的必查项。区分图案、数据贴图和受光照片，避免直接从最终像素推导 PBR 输入。
- 动态验收按周期、一次性和事件驱动选择证据。既有实例参数定值保持局部流程，临时测试后恢复本任务要求的最终值。独立代理的只读方案演练覆盖纵向拉丝金属、1.5 秒一次性溶解和实例 Roughness 定值，均按各自范围处理；这些是技能行为检查，没有调用 UE 或完成对应效果的渲染验收。
- 源版与 EHV 安装版格式检查通过，三个 Markdown 已同步，原 Custom/HLSL 项目偏好原样保留。安装及备份记录 `.test-state/material-general-skill-installed.json`；实际 DSH 运行时加载通过，记录 `.test-state/material-general-skill-runtime.json`。本次仅更新技能与验证记录，没有更新宿主/原生二进制或业务资产；旧会话重新调用 `/ue-material-workflow` 读取最新内容。

## 2026-10-21 材质编辑器同步、撤销与失败恢复

- 根据最新 `70d46a25-2194-46d8-ba40-258aaab356b1` 会话，区分了失败后另建的正式材质、正常 transient 编译副本，以及已有编辑器未同步的问题。诊断记录 `.test-state/radar-latest-audit.txt`。
- 原生提交现在检查未应用的编辑器改动，在成功且内容变化后刷新目标工作副本，按解析后的 GUID 在副本图内定位并选中整批节点。`MATERIAL_EDITOR_CONFLICT` 在原资产写入前拒绝，已应用但未保存的资产仍可继续；预览、失败与 no-op 不刷新。另修复带连字符与紧凑 GUID 的匹配差异。
- 独立审查补查 Undo/Redo：引擎材质编辑器会从旧副本写回原资产。原生材质批次使用独立事务上下文，在撤销/重做期间临时抑制该回调，恢复先前标志后延迟同步目标，补齐图引脚清理、视口和全局通知，保护无关窗口及未应用编辑。仅作用于桥接材质事务，模块关闭会清理监听。
- `npm run check` 构建及 **340/340** 项宿主测试通过，日志 `.test-state/material-presentation-host-check.log`。恢复结果携带禁止同一失败任务换名/复制重建的明确约束；真实资产之间仍独立，未声称已硬性识别跨资产语义任务。编辑器冲突有独立恢复指引且不消耗问题修复额度；停止及状态查询不再提示换 UUID 重试。
- 实际 DSH 0.2.1-rc.2 运行时的 MCP **7/7**、会话执行保护 **8/8** 组验证通过，记录 `.test-state/material-presentation-{mcp,session}-runtime.json`。工具检查使用构建产物，会话检查使用工作区执行保护源码；采用模拟编辑器和离线模型适配器，没有在线模型请求。
- UE 5.8.2 隔离 HostProject 的逐文件编译和强制 Unity 编译均通过；显式使用 `-DisableUnity` 与 `-ForceUnity -DisableAdaptiveUnity`，核对真实 Unity 输入包含本次修改文件，未把零操作构建算作 Unity 验证。日志 `.test-state/material-presentation-{nonunity,unity}-build.log`，53 份源码哈希清单 `.test-state/material-presentation-native-sources.json`。
- 真实 D3D12 SM5、Slate 材质编辑器回归 **20/20** 通过，错误 0（包含一项已有的预期查询警告）。包括先开空材质再提交、可见节点/GraphNode/GUID/批量选中、连续更新、编辑器冲突、dry-run/no-op、撤销/重做、函数调用者手改保护，以及普通事务通知和既有 suppression 所有权。报告 `.test-state/material-presentation-native-report/index.json`；不是 NullRHI 或仅验证调用次数。
- skill 三文件已更新，分别验收编译、参数行为与默认外观，并补充可测量细节、正确材质提交路径、单一交付目标及保存/草稿收尾。源版和 EHV 安装版格式验证通过；独立只读场景测试覆盖参考图、额度耗尽和 MI 局部改值。实际 DSH 技能加载验证通过，`.test-state/material-workflow-skill-runtime.json`；安装与备份 `.test-state/material-workflow-skill-installed.json`，原有 Custom/HLSL 项目偏好原样保留。
- 已安装到 DSH `desktop` 和 EHV，安装记录 `.test-state/material-presentation-installed.json` 为 **PASS**。宿主六个入口文件与工作区哈希一致，UE 更新五个源码/头文件及 DLL/PDB，共七个文件；备份编号 `20261021-142123-052-material-presentation`，备份路径见安装记录。profile 配置、本地 `dsh-emotion` 及已安装项目 skill 保留。宿主 bundle SHA-256 为 `3f74b24d5cedcb41fa70c56cea149e0ac264c12f90cf895add2d17f7efc9649f`，原生 DLL 为 `87489b6b962a41514ccc4cf04bffeea8d054109420545c7406cf92ef91e5ef3d`。
- 安装后使用实际安装的最终 bundle 再验证 MCP **7/7**、会话执行保护 **8/8** 及 EHV 技能发现/加载，全部通过；记录 `.test-state/material-presentation-installed-{mcp,session,skills}-runtime.json`，三份报告均对应上述宿主哈希。检查没有在线模型请求或业务资产写入。未自动关闭用户应用；DSH 需要完整退出后重开，EHV 下次打开加载新原生插件，旧会话需重新调用 `/ue-material-workflow`。
- 本次测试没有修改 EHV 的业务材质或地图，也没有复跑原模型生成任务；因此不把流程改进描述成原业务效果已完成视觉验收。

## 2026-10-21 材质效果理解与验收流程优化

- 根据 `M_RadarRingFan` 会话的源 RGBA、正式补丁及完整回读，确认白盘与错位来自生成的材质设计，而非透明度上传丢失或节点写入错误。溯源记录 `.test-state/radar-material-audit.txt`，逐项核对 `.test-state/radar-bridge-verification.json`。
- 更新 `ue-material-workflow/SKILL.md` 与两个参考文档。首次构建前明确可见内容、部件关系、参数行为和验收条件；关键透明度/几何判断保留在入口中，适用参考仍须实际读取。文字明确要求优先，默认值区分事实与估计；新增共享边界、真实内孔/间隙、颜色与覆盖率、UE Sine 周期单位的检查。按原要求逐项验收，保留局部参数修改的简短流程。
- 两个无历史上下文的独立代理执行了四种任务的离线行为检查：原图效果理解、实例标量局部修改、文字覆盖参考图并依次点亮能量条、接触点水波扩散。原图检查正确识别黑色 20% 不透明中心并共享分段几何；其余任务保留用户范围、覆盖文字优先和时间单位。根据检查补充“停止闪烁不等于隐藏”，减少可推导默认值上的重复提问。这些是设计阶段检查，不是 DeepSeek 或 UE 渲染端到端验收。
- 仓库及 EHV 两份技能的格式检查通过，引用路径存在。仅同步 EHV 的三个技能 Markdown，保留安装版原有两条 Custom/HLSL 项目偏好，并说明独立 HLSL 必须有实际受支持的接入方式；原文件已备份。安装清单及哈希 `.test-state/material-intent-skill-installed.json`。
- 使用实际安装 DSH 的官方运行时解析、文件系统和 SkillRegistry 加载 EHV 技能，发现、正文即时刷新、项目隔离、引用文件校验全部通过；记录 `.test-state/material-intent-skill-runtime.json`。未修改宿主/UE 二进制、业务材质或地图，无需重启；历史会话已加载的旧正文仍需重新调用技能。没有复跑在线 DeepSeek 或宣称原材质已修复。

## 2026-10-21 EHV Unity 编译失败修复（UE 0.5.1）

- 用户在 EHV 重新编译后发现 UE 插件报错，现场日志已保留为 `.test-state/ehv-material-unity-failure.log`。根因是 Unity 把全部实现文件合并到一个翻译单元；新材质代码与蓝图代码的 `Obj/Str`、数据表代码的 `MaxSnapshotBytes` 在匿名命名空间中重定义，后续类型错误均由此引发。
- 前次隔离构建日志明确显示 25 个实现/测试文件都被 Adaptive Build 排除出 Unity，因而此前编译和运行时测试没有覆盖本次失败的构建方式。这是原生构建验收的遗漏。材质内部辅助函数、类型和常量现统一放入独立私有命名空间，对外方法仅使用限定名和函数局部引入；未通过禁用工程 Unity 绕过问题。
- 修复同步到仓库与 EHV，UE 描述版本提升至 **0.5.1 / Version 11**。使用用户原来的 `EHVEditor Win64 Development` 完整构建命令，实际编译 `Module.DSHUnrealBridge.cpp`，其中包含全部实现文件；编译、链接及元数据生成通过，耗时 **31.57 秒**。日志 `.test-state/ehv-material-unity-build.log`。EHV 的新 DLL 由本次工程构建生成，SHA-256 为 `db108c453804791bdae3321f5cedbd4792fad693f277659def2112dc30a53638`。
- 同步相同源码后，隔离 HostProject 的逐文件 `DSHMaterialOps.cpp` 编译和完整目标链接也通过，日志 `.test-state/material-unity-fix-nonunity-build.log`。README 的发布验证要求已补齐两种构建模式，并要求检查真实编译输入，避免把 Adaptive Build 的排除结果算作 Unity 覆盖。
- 修复后隔离工程的 D3D12 SM5 原生回归 **12/12** 通过（10 项 MaterialBatch、2 项 WriteCoordination，错误 0；1 项包含预期的不存在目标查询警告），进程退出码 0。报告 `.test-state/material-unity-fix-native-report/index.json`，日志 `.test-state/material-unity-fix-native-automation.log`。测试仅运行在隔离工程；EHV 的验证为真实完整目标构建。最终安装记录 `.test-state/ehv-material-unity-fix-installed.json`。
- 原插件源码、描述文件和二进制备份至 `F:\UE5Project\EHV\Saved\DSHUnrealBridgeBackups\20261021-101424-446-unity-fix\DSHUnrealBridge`。EHV 工程文件、知识配置、技能及 3837 个缓存文件再次哈希校验保持原样，没有改动业务资产。本次修复仅涉及 UE 端，宿主仍为 0.6.0。

## 2026-10-21 材质流程与蓝图修复保护安装（宿主 0.6.0 / UE 0.5.0）

- 按用户要求，已通过官方 CLI 将 `desktop` profile 的宿主升级至 **0.6.0**，EHV 插件升级至 **0.5.0 / Version 10**。包括通用材质技能、三个材质/图像工具，以及蓝图节点、连线和 ObjectTools 共享真实资产修复范围的修复。
- 发布版本重新执行 `npm run check`，**336/336** 通过，日志 `.test-state/material-blueprint-release-check.log`。UE 使用此前已验证的隔离 HostProject 二进制；全部 **53 个**原生源码文件与构建输入哈希相同，描述文件仅提升版本，不更改原生代码。引擎及模块 BuildId 均为 `717ce51e-7d91-490e-b61d-b7032ba4bce8`，未使用工作区旧 DLL。
- 安装后核对宿主六个关键文件及 UE **259 个**交付文件，哈希全部一致，其中实际更新 UE 文件 **16 个**。安装清单 `.test-state/material-blueprint-install-plan.json`，结果 `.test-state/material-blueprint-installed.json`。DSH bundle SHA-256 为 `2ab8abc46285045d65cabbcbf26fd0db7c984ad1c3d61da55a1c1210eeeafd1a`。
- 使用已安装 DSH 0.2.1-rc.2 的正式运行时加载实际安装 bundle：MCP **7/7**、设置及生命周期 **8/8**、会话及执行保护 **8/8** 通过，记录 `.test-state/material-blueprint-installed-{mcp,settings,session}-runtime.json`。这些检查使用临时状态、模拟编辑器及离线模型适配器，没有在线模型请求或真实项目写入。已安装 sharp **0.35.5** 的 PNG 编解码验证保留源 RGBA，记录 `.test-state/material-blueprint-installed-dependencies.json`。
- 实际安装 bundle 经官方 `createRuntimeResolution/PluginPackages` 解析后，真实技能加载器成功发现并读取 EHV 的 `ue-material-workflow` 及原有 `sr-proto-handler/ue-project-graph`；两个相对引用文档均存在且非空，工程边界隔离检查通过。记录 `.test-state/material-blueprint-installed-skills-runtime.json`。首轮裸导入缺少宿主提供的 peer 包，按正常宿主解析流程验证即通过，未为测试更改安装依赖。
- 备份编号 **20261021-094932-431**：DSH 旧包及配置位于 `C:\Users\NiubilityPC\.dsh\profiles\desktop\.plugin-manager\dsh-unreal-bridge-backups\20261021-094932-431`；UE 被替换文件位于 `F:\UE5Project\EHV\Saved\DSHUnrealBridgeBackups\20261021-094932-431\DSHUnrealBridge`。原 profile 配置、EHV 工程文件、知识配置、**3837 个缓存文件**和 **2 个原有技能文件**保持原样。官方安装器移入 `.ignored` 的本地 `dsh-emotion` 已恢复，4 个文件哈希一致。
- 本次未关闭用户应用、启动 EHV 或修改工程资产。DSH 正在运行的进程尚未确认重载，需完整退出并重新打开；EHV 下次打开加载新插件。原业务材质的视觉及动态效果、模型任务耗时和 Token 降幅仍未实测。

## 2026-10-21 蓝图修复额度的跨工具归属修复（工作区实现）

- 修复两个已复现缺口：`connect_pins/break_pins/set_pin_value` 的嵌套 PinID 曾被归到 `editor_scope`，而新增节点归到蓝图；ObjectTools 的节点属性修改又被归到独立对象，导致连线被限制后仍能加节点或换入口继续修改。
- 新增内部只读 `mcp_operation_context` 预检及对应能力声明，不增加模型工具数量。宿主等待原生确认真实 Blueprint、图、节点、生成类或已有 CDO 的归属后才登记修复额度；关卡蓝图保留完整对象路径，普通场景实例不推断成其类蓝图。目标必须已经加载。按连接保存的短期 token 绑定调用参数及弱对象身份，实际执行前复核，拒绝同名替换、归属变化和跨连接使用；旧插件缺少能力时明确拒绝 BlueprintTools/ObjectTools 调用。
- 保留严格引脚校验，但把索引/方向判定放在归属已确认后的派发前阶段，使无效引脚错误计入正确蓝图。token 不参与幂等哈希，预检和派发前拒绝不消费写请求编号。修复全部受支持调用包装的一致性；缓存失败回放不重复消耗修复额度，也不重新派发写入。
- 原生与宿主精确只读名单增加 BlueprintTools 的 `get_default_object/list_graphs/find_nodes/get_node_infos` 和 ObjectTools 的 `get_class/get_properties/list_properties`。独立审计确认 `read_graph_dsl/get_node_type_pins` 会临时增删真实节点，未给予只读豁免；删除不存在方法名的诊断豁免。
- `npm run check` 构建及 **336/336** 项 JavaScript 测试通过，日志 `.test-state/blueprint-scope-host-check.log`。新增集成测试覆盖同蓝图跨工具/节点封禁、八种调用包装、其他资产继续、诊断不重置额度、关卡蓝图、非法证据、A→B→A 绑定变化、缓存回放、超时恢复和 token 重试；原有材质与设置测试保持通过。
- 实际安装 DSH 0.2.1-rc.2 的 ToolRuntime 使用最终宿主 bundle 完成 **7/7** 组检查，记录 `.test-state/blueprint-scope-mcp-runtime.json`。使用隔离状态及模拟编辑器，没有调用模型或修改已安装 profile；同时验证精简安全返回和 `unreal_state` 完整状态均通过真实输出校验。
- UE 5.8.2 隔离 HostProject 完整 Editor 目标编译成功，日志 `.test-state/blueprint-scope-native-build-final.log`。真实 UE 自动化 **15/15** 通过，包括新增 `McpOperationContext` 四项和原有目标校验、关卡蓝图、展示保护及写入协调；真实 WebSocket 桥接 **6/6** 组验收通过。记录 `.test-state/blueprint-scope-e2e/result.json`、同目录 `editor.log` 与 `native-report-*`。本轮使用 NullRHI 验证身份及执行保护，不将其描述为材质渲染或视觉验收。
- 本次更新工作区源码、文档和构建产物，**未安装到 DSH desktop 或 EHV，未修改 EHV 资产，未关闭用户应用**。实际生效需要更新宿主和 UE 插件并重新加载；没有原业务模型复跑的耗时或 Token 降幅数据。

## 2026-10-20 通用材质 skill、源图分析与批量编辑（工作区实现）

- 先将流程要求整理为 `ue-material-workflow`，再实现工具支持。技能适用于材质、普通材质函数和实例，按任务启用参考图、图构建或动态验收分支；小范围参数修改不强制重建图。默认值来源、单位、失败后诊断、图维护和完成证据均有明确要求，没有绑定特定项目、形状或颜色。
- 新增 `unreal_image_analyze`，通过 DSH 文件系统服务分析源 RGBA、透明度、指定样本和显式底色合成，保留源文件并把报告纳入受管缓存。新增 `unreal_material_read/patch`：读取精确引脚与完整编辑数据版本，在临时副本上检查、编译整批修改，显式提交后核验结果；失败恢复原有内存状态及 dirty 标记，不自动保存。排版和候选清理须显式指定。
- MaterialTools 的节点新增、连线等操作共享材质修复范围；原生读取证实归属后，相关 ObjectTools 属性修改也进入该范围。八项已审计材质查询在宿主及原生层保持只读。普通工具返回压缩重复安全历史，当前错误、请求状态、回滚和剩余额度保留；`unreal_state` 和界面仍提供完整记录。
- `npm run check` 构建及 **306/306** 项 JavaScript 测试通过，报告 `.test-state/material-host-check-final.log`。新增图像测试覆盖隐藏 RGB、各 EXIF 方向、PNG/JPEG/WebP、区域坐标、透明度合成、非法数据、取消和缓存清理；材质测试覆盖默认预览、只读模式、审批、请求去重、跨对话写保护、未知结果恢复、未核验提交锁定及可信归属。独立审查未发现剩余阻塞问题。
- skill 格式检查通过；使用实际安装 DSH 的 Cordis、文件系统和技能加载器，从隔离 HostProject 成功发现并读取新增技能。记录 `.test-state/material-skill-runtime-check.json`。检查使用工作区构建产物和临时工程，没有改动已安装插件或运行模型。
- UE 5.8.2 隔离 HostProject 完整 Editor 目标构建成功，日志 `.test-state/material-native-build-final.log`；参与最终构建的五份原生源码与工作区文件哈希一致。真实 D3D12 SM5 自动化 **12/12** 成功，包括 10 项 MaterialBatch 和 2 项 WriteCoordination；报告 `.test-state/material-native-report-final/index.json`，日志 `.test-state/material-native-automation-final.log`。其中 1 项带有故意查询不存在蓝图的警告，错误总数为 0。未使用 NullRHI 代替着色器编译。
- 原生验证覆盖项目/插件挂载、引脚预检、预览/提交/清理/注释/撤销、Custom 输入扩展保留连接、普通函数与递归拒绝、UI 材质、真实无效 HLSL 拒绝，以及保留未保存修改和拥有的子对象后恢复。版本测试覆盖软引用、Map/Set 及超过显示上限的数组。函数调用者测试验证：接口变更在写入前拒绝，内部修改能更新已编译调用材质且保留连接，注入失败后函数和调用者状态仍完整。
- 当前批次范围为普通 `UMaterial/UMaterialFunction`；不支持材质层/混合函数、复合/嵌套/执行引脚图和跨资产函数接口迁移。材质实例使用编辑器已有参数工具。函数预览编译不覆盖所有调用场景；Map/Set 参与读取与恢复，但不支持直接写入。具体限制见工具协议。
- **本次仅完成工作区源码、宿主 bundle 和隔离工程编译验证，未安装到 DSH desktop 或 EHV，未关闭用户应用，未修改 EHV 资产。** 生效需要更新两端插件并重新加载。没有复跑原业务的模型生成、视觉对照或动态效果验收，因此不宣称原材质已修复，也没有修复后端到端耗时或 Token 降幅的实测数字。

## 2026-10-20 全局设置入口补齐（0.5.1）

- 纠正 0.5.0 只提供插件详情页配置、未接入全局设置的问题，新增 **设置 → Unreal Bridge**。两个入口复用同一个官方 `configForms` 控制器及配置 revision；支持加载错误重试、只读、草稿保留和并发修改保护。
- 设置入口注册独立于 `remote.unrealBridge`，UE 未连接或缓存服务尚未就绪时仍可访问设置。显式声明官方设置 UI 依赖；缓存服务上线/离线时单独更新缓存面板。
- `npm run check` 构建与 **272/272** 项测试通过，包含全局入口注册、官方表单订阅/保存适配、读取失败恢复和 Remote 未就绪时的入口可用性。
- 已通过官方 CLI 安装到 DSH `desktop`；安装代码文件与本次构建逐项哈希一致，profile patch 保持原样，本地 `dsh-emotion` 的 4 个文件恢复后哈希一致。备份编号 `20261020-124207-765`，记录 `.test-state/settings-entry-installed.json`。已安装插件的官方设置/生命周期检查 **8/8** 通过，报告 `.test-state/settings-entry-installed-runtime.json`。
- 使用实际 DSH 窗口刷新并验证 **左下角账号 → 设置 → Unreal Bridge**：全局入口、执行权限、单问题修复次数（3）、相同错误上限（2）、预算、超时、缓存保留及缓存统计均正常显示。UE 未连接时读取配置成功，缓存显示 7.0 MiB / 4 组。仅浏览，未修改用户设置、触发清理或运行模型；未退出 DSH。本次不涉及 UE 原生插件更新。

## 2026-10-20 设置、执行状态、单问题限制与缓存管理（0.5.0）

- 后续按用户要求同步到实际安装：DSH `desktop` 升级至 **0.5.0**，EHV 的 UE 插件升级至 **0.4.5**。UE 使用已验证 HostProject 的 DLL/PDB，源码和引擎 BuildId 完全匹配，不使用工作区遗留旧 DLL；245 个源码/工具/运行时文件及 7 个二进制文件校验一致。安装报告 `.test-state/plugin-sync-installed.json`。
- 安装后再次对实际 `desktop/node_modules/dsh-unreal-bridge/lib/index.js` 执行官方设置/生命周期 **8/8**、MCP **7/7**、真实会话 **8/8** 检查，全通过；已安装 sharp 0.35.5 成功生成 PNG。报告 `.test-state/plugin-sync-{settings,mcp,session}-runtime.json`、`.test-state/plugin-sync-native-dependencies.json`。设置验证脚本补齐宿主官方依赖解析，避免裸 Electron 缺少宿主 peer 时误报安装失败。
- 安装备份编号 `20261020-122711-914`：DSH 位于 profile 的 `.plugin-manager/dsh-unreal-bridge-backups/`，UE 位于 EHV `Saved/DSHUnrealBridgeBackups/`。原 profile patch、工程文件、知识配置、3836 个缓存文件、2 个工程技能文件保持原样。安装器移入 `.ignored` 的本地 `dsh-emotion` 已完整备份并恢复原位，4 个文件哈希一致。未关闭正在运行的 DSH；完整退出并重新打开后加载新版。UE 当时未运行，下次打开工程即可加载。
- `npm run check` 构建与 **268/268** 项测试通过。覆盖热配置、不重建连接与写保护、本轮快照/下一轮生效、前后置钩子去重、问题额度与连续错误、诊断读取、跨对话查回成功结果、结束后冻结计时，以及界面草稿/冲突/清理确认。
- 使用已安装 DSH 0.2.1-rc.2 的真实 Loader、Settings、ConfigEditor 和 ToolRuntime，在隔离 profile 验证最终 `lib/index.js`：**8 组通过**。包括原子保存、冷启动恢复、旧 revision/非法值/静态字段拒绝、恢复继承默认和动态审批服务加入/移除。确认原 fiber、bridge、server、token 和未知写屏障保留。报告 `.test-state/settings-runtime-built-check.json`。
- 最终构建通过已安装 ToolRuntime 的 MCP **7/7** 检查，以及真实 AgentLoop/Session/JSONL **8/8** 检查；报告 `.test-state/settings-mcp-runtime.json`、`.test-state/settings-session-runtime.json`。
- 缓存测试仅操作临时目录，覆盖归档保留、容量目标、保留期承诺、证据生成/比较/附件使用保护、Windows 大小写及链接路径拒绝、并发清理与退出等待。真实本地 WebSocket 回归验证截图超时/取消后的迟到响应；同一连接确认完成前保留文件保护，未知断线持续保护并计入容量上限。
- 使用 Chrome 无界面模式渲染实际 React 组件并检查布局，预览 `.test-state/settings-preview/settings.png`；使用模拟表单和缓存数据，不是已安装应用截图。包内容检查未包含测试目录。没有运行模型或改动 UE 资产。
- 0.5.0 功能实现为宿主 JavaScript 更新，没有新增 UE 原生源码变化，无需为此重编译 UE。首轮只完成工作区构建，随后按用户要求安装，并同步此前尚未安装的 UE 0.4.5 修复；没有清理用户现有缓存。

## 2026-10-20 回滚保护、编辑器写入协调与知识路由（0.4.5）

- 架构调整限定在执行边界：宿主共用 `isUnsafeWriteError` 判定回滚失败，`EditorWrites` 管理每个编辑器的 `pending/uncertain` 写入占用；UE 原生异步入口另行拒绝重叠修改。冲突立即返回未执行的 `BUSY/EDITOR_BUSY`，不把可能过期的编辑请求排入后台队列。不同编辑器可独立执行，原生读取和四项精确审计的 DataTable MCP 查询可回读。
- 原生蓝图自动回滚只有在撤销成功、重新编译成功和图 revision 恢复原值后才报告 `rollback:"restored"`；否则输出 `ROLLBACK_FAILED` 与结构化失败详情。宿主兼容旧版只返回此错误码的情况，普通失败、MCP 嵌套失败和原请求状态恢复共用分类器。超过 2 MiB 的失败响应截短诊断内容，保留错误码、回滚与重试语义，不因响应限额丢失写锁依据。
- 已派发写入超时、取消或断线后，原编辑器的其他对话也无法继续写入。原请求结果可由同编辑器的其他对话查询，完成时更新原所属对话缓存；未知、过期、无效响应和迟到的旧查询均不能解除保护或释放新请求。派发前取消、审计失败、原生预检拒绝不占用未知状态，也不消费请求 UUID。已审计 MCP 读取在派发前和返回时检查绑定版本。
- UE Knowledge 服务改用 `ProjectKnowledgeTools.inl` 单一目录决定后端、写入类别和桥接公开范围，消除主桥接与服务层白名单漂移。`graph_query/graph_feature/graph_impact` 已正确进入 worker；内部索引更新和其他未公开工具不扩大权限。新增 worker 准入模块同步加入 UE 打包清单。
- `npm run check` 构建与 **208/208** 项宿主测试通过，记录 `.test-state/architecture-fixes-host-check.log`。新增真实回环 WebSocket 回归覆盖多对话互斥、不同编辑器并发、未知状态跨对话恢复、UUID 不重放、解绑/重连、迟到状态、无效响应、旧版回滚错误、派发前取消及审计失败、读取期间 A→B→A；另有错误分类和跨语言目录/只读策略一致性测试。
- 知识工具构建与 **28/28** 项测试通过（ProjectGraph 5、ProjectMemorySystem 21、worker 路由 2）。新增 worker 回归在临时工程缓存中检索实际 Class/Function/关系，覆盖三项图查询、空参数及关闭图谱的情况；未使用 EHV 索引或资产。
- UE 5.8.2 隔离 HostProject 完整 Editor 目标构建成功，最终增量构建记录 `.test-state/architecture-fixes-native-build-final.log`。原生自动化 **13/13** 项成功，进程退出 0：新增 `BlueprintRollbackSafety`、`WriteCoordination.AsyncAdmission`、`WriteCoordination.BoundedFailures`、`Knowledge.ToolCatalog`、`Knowledge.GraphWorkerRouting`，以及原蓝图往返、DataTable 复制与 MCP 目标校验回归。报告 `.test-state/architecture-fixes-native-report/index.json`，日志 `.test-state/architecture-fixes-native-automation.log`。图谱原生测试通过实际服务启动 worker 并检查其参数/缓存业务校验；查询结果正确性另由 worker 临时图谱回归覆盖。
- 最终宿主 bundle 通过实际安装 DSH 的 MCP ToolRuntime **7/7** 组和 AgentLoop/Session/JSONL 保存、冷读取与回放 **8/8** 组检查，报告 `.test-state/architecture-fixes-mcp-runtime.json` 与 `.test-state/architecture-fixes-session-runtime.json`；报告中的 bundle SHA-256 与最终 `lib/index.js` 一致。这些检查使用回环编辑器及离线模型适配器，未请求在线模型。
- 本次更新工作区源码、文档和宿主 bundle，并在 `.test-state/presentation-plugin-compiled/HostProject` 编译验证 UE DLL。**未安装到 DSH desktop 或 EHV，未关闭用户应用，未修改 EHV 资产。** 完整生效需要后续更新两端插件并重启对应应用。

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
