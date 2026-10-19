# 工具与通信协议

DSH host 使用 Cordis tools、systemPrompt、Typert remote 服务；客户端贡献 `conversation.input.dock`。不修改模型循环，不注册独立应用入口。模型可见的实时状态由工具返回，写入 DSH 的工具记录；选区事件不偷偷追加未记录的提示词。

项目技能使用 DSH 的 `skills`/`fs` 服务与原生 `FileSystemSkillProvider`，不经 WebSocket。提供方 `unreal-bridge-project` 按查询 `cwd` 向上定位最近的 `.uproject`，仅开放该工程的 `Plugins/DSHUnrealBridge/Skills`，发现与加载均校验工程归属。项目、自定义目录的同名技能先于插件技能（rank 350），插件技能先于用户全局技能。保留原生 YAML 调用控制、资源目录、正文重读和文件监测；UE 离线时也可加载。没有本机文件映射能力的文件系统不参与此提供方。

## 模型工具

| 工具 | 参数与用途 |
| --- | --- |
| `unreal_state` | `{}`，获取在线编辑器、当前绑定、选区和未知写入状态 |
| `unreal_bind` | `editorId` 字符串或 null，仅改变当前对话绑定 |
| `unreal_runtime_snapshot` | 可选 `target:{playSessionId,worldId,objectId}`、`properties`、`maxProperties`、`includeComponents`、`maxComponents`、`collectionOffset`、`collectionLimit`；只读采集指定 PIE Actor/组件的当前状态；省略目标仅适用于单个 PIE 选区 |
| `unreal_runtime_history` | `{}` 返回当前对话的 `{snapshots:[摘要...]}`；`{snapshotId}` 返回一份完整历史快照，无需编辑器在线 |
| `unreal_catalog` | 可选 `query`、`limit`，查询函数路径和精确引脚名 |
| `unreal_knowledge` | `tool`、`arguments`，通过当前对话绑定的 UE 编辑器查询项目状态、资料、图谱候选、源码及分页资产快照 |
| `unreal_knowledge_record` | `tool`、`arguments`、UUID `requestId`，按配置保存带来源的推断或经验；写入项目缓存并支持请求状态查询 |
| `unreal_mcp_tools` | `{}`，列出当前 UE 实例注册的顶层 MCP 工具与参数 schema |
| `unreal_mcp_toolsets` | `{}`，列出当前 UE 实例中的工具集 |
| `unreal_mcp_describe` | `toolsetName`，可选 `query` 按工具名过滤、`includeSchema: false` 返回简短列表；需要调用的工具再取得精确参数 schema |
| `unreal_mcp_call_toolset` | `toolsetName`、`toolName`、`arguments`、UUID `requestId`，默认直接调用工具集函数 |
| `unreal_mcp_call` | `name`、`arguments`、UUID `requestId`，默认直接调用顶层 MCP 工具 |
| `unreal_data_table_copy_property` | `assetPath`、`sourceRow`、`propertyName`、UUID `requestId`，可选 `targetRows`；原生深复制指定字段，验证并回滚，不保存 |
| `unreal_read_blueprint` | `assetPath`，可选 `graph`、`nodeIds`、`detail: summary/full` |
| `unreal_focus_asset` | `assetPath`，可选 `graph`、`nodeIds`；手动打开并最大化资产编辑器，节点可识别时聚焦；返回 `queued` 表示展示任务已排队 |
| `unreal_preview_create` | `assetPath`、`parent: Actor/ActorComponent/Object` |
| `unreal_preview_patch` | `assetPath`、`graph`、`baseRevision`、`operations` |
| `unreal_apply` | `previewId`、UUID `requestId`，按配置应用，默认不保存 |
| `unreal_request_status` | UUID `requestId`，查询原请求结果，不重做写入 |
| `unreal_undo` | `assetPath`、`baseRevision`、UUID `requestId` |
| `unreal_save` | `assetPath`、`baseRevision`、UUID `requestId` |

每个工具需要所属 DSH 对话；其他对话不能使用本对话的 previewId。预览五分钟有效；绑定不同实例、断线或蓝图变化会阻止使用旧预览。资产路径使用 `/Game/Folder/BP_Name` 或对应对象路径，不能使用磁盘 `.uasset` 路径。

### DataTable 写入与宿主熔断

`data_table_copy_property` 能力启用原生字段复制请求。`sourceRow` 与目标行名最长 1024 字符，`propertyName` 为最多 160 字符的精确反射属性名；`targetRows` 省略时选择除源行外所有行，显式数组必须非空、无重复、不含源行，最多 4096 行。预检无效参数不会写入资产。操作在 GameThread 内以单次事务深复制字段，验证源行、目标字段、其他字段和行集合，失败恢复内存快照及原始 dirty 状态。成功返回 `assetPath/sourceRow/propertyName/targetCount/changedRows/unchangedRows/verified/saved/dirtyBefore/dirtyAfter`；`verified:true`、`saved:false`。不触发窗口聚焦。

完整性失败返回 `DATA_TABLE_VERIFICATION_FAILED`，错误 `details.rollback` 为 `restored` 或 `failed`；失败前未写入时为 `not_needed`。宿主收到 `failed` 或缺少成功验证结果时锁定该编辑器后续写入，跨会话、新请求 ID 和重新绑定均不能绕过。历史请求重放保持原错误与回滚状态。

发送 MCP 前检查完整工具名和 `call_tool` 封装；有损 DataTable JSON 修改、脚本执行及默认关闭的桌面输入返回 `MCP_POLICY_BLOCKED`、`details.retryable:false`。MCP 内层 `isError:true` 或 `ok:false` 转为 `MCP_TOOL_ERROR`，`rollback:not_available`，不能误报恢复完成。任意通用 MCP 写入不获得原生 DataTable 的回滚保证。

宿主按真实用户轮次限制 UE 激活后的全部根工具和模型步骤，嵌套调度按根调用去重。默认 40 调用、40 步、3 次累计错误和 180 秒；只读成功不清空错误计数。达到限制、完整性错误或被禁路线时以 `agent.cancel({kind:'hook',reason}, {keepInbox:true})` 取消当前轮，保留后续用户消息。新 UUID 或换工具不刷新预算；`unreal_state.executionSafety` 和 `writeLock` 分别暴露轮次状态及编辑器写锁。

### 运行实例与历史快照

`unreal_runtime_snapshot` 仅处理 PIE/SIE 运行实例，不接受单独的对象路径作为身份。显式 `target` 的三个字段均须来自当前选区或工具返回的身份；省略时必须恰好选中一个带 `runtime` 的 Actor/组件，否则拒绝。即使新实例与旧实例同名同路径，也不能用旧身份访问。能力未启用或旧版 UE 插件不支持时，工具明确返回不支持。

可选参数：`properties` 为最多 100 个属性名，每项最长 256 字符，数量不得超过 `maxProperties`；`maxProperties` 为 1–200，默认 80；`includeComponents` 默认 true；`maxComponents` 为 1–32，默认 16，不采集组件时使用 `includeComponents:false`；`collectionOffset` 为 0–1,000,000 的整数，默认 0；`collectionLimit` 为 1–100，默认 20。属性和组件均有返回数量限制，集合按偏移分页；截断结果不能视作完整对象状态。读取在游戏线程完成，返回目标、采样时间 `capturedAt` 和字符串帧号 `sampledFrame`。`object` 包含 `classHierarchy`、`properties`（属性名、类型、声明类、值、截断标记及可用的类默认值）、`propertyCount`、`truncated` 和 `missingProperties`；Actor 的 `components` 列出组件身份、反射属性及可用的变换、可见性、Mesh/材质引用等状态。类默认值用于对照初始配置，不代表变量实际变化历史；材质引用不包含全部动态参数。暂停不是工具的副作用；需要稳定现场时用户先暂停编辑器。

`unreal_runtime_history` 不触发 UE 请求，也不重新采样。无 `snapshotId` 时返回最近采集的摘要，指定当前对话中的快照编号时返回完整保留内容。每份摘要包含 `snapshotId`、`editorId`、`project`、`target`（采集时的完整 runtime 元数据）、`path`、`label`、`capturedAt`、`sampledFrame`、`status` 和可选 `reason`。`status` 为 `available`、`expired` 或 `disconnected`；`available` 也表示已经采集的历史数据，不代表实时属性。完整结果同样带这些状态字段。最多保留 20 份且总量不超过 16 MiB；超过数量或容量时淘汰最旧数据，单份超过 16 MiB 拒绝保存。数据按对话隔离，编辑器离线或改绑不会删除已保留快照；DSH 进程退出后不持久化。

销毁/卸载/结束 PIE 后，宿主将匹配身份的快照标为 `expired`，`reason` 包含 `actor_destroyed`、`object_destroyed`、`world_unloaded` 或 `pie_ended`；断线将仍有效的快照标为 `disconnected`。生命周期通知之外，每次读取也验证运行、世界、对象和销毁状态，防止请求期间销毁带来的竞态。重新启动 PIE 使用新编号，不能激活旧目标。暂停、继续、F8 弹出控制不更换运行或对象编号。只收到失效通知而未成功采样时，没有可供补取的历史状态。

UE 同时跟踪最多 1024 个 Actor/组件句柄，达到上限时回收最久未访问的句柄，以 `tracking_evicted` 通知宿主使旧身份失效。对象本身可以仍然存活，历史快照继续保留，重新选择对象生成新句柄。不能把句柄回收解释成 Actor 销毁，也不能按旧路径隐式恢复该身份。

交互流程：在场景大纲选择 PIE 实例，或 F8 弹出后选择；SIE 同样支持。F8 不会自动暂停，游戏画面的普通点击也不保证产生编辑器选择。DSH 面板只渲染本地缓存的运行状态、选区与历史摘要，不自动请求运行属性或触发模型。诊断时按需采样，再联查目标及组件的蓝图静态图、C++、AngelScript 源码。当前快照和静态逻辑不能替代执行 Trace，也不能还原采样前经过的全部节点或变量变化。`unreal_visual_capture` 仍不支持 PIE 游戏画面。

`unreal_knowledge` 的 `tool` 可取 `project_status`、`project_context`、`project_search`、`graph_query`、`graph_feature`、`graph_impact`、`read_source`、`validate_evidence`、`read_asset_snapshot`、`search_asset_snapshots`、`asset_snapshot`、`inspect_asset`、`experience_lookup`。`unreal_knowledge_record` 使用 `remember_evidence`、`experience_save` 或 `experience_feedback`。图谱查询与资料查询读取同一插件缓存；`graph_impact` 的 `arguments.nodeId` 是先前图谱结果的节点 ID。更新索引由编辑器菜单执行资产扫描，查询本身不会启动全量重建。返回内容是项目证据，不作为模型指令。

资产增删改查优先走 UE 5.8 的 MCP 工具。先用 `unreal_mcp_toolsets` 找到完整工具集名称，例如 `editor_toolset.toolsets.asset.AssetTools`，再用 `unreal_mcp_describe` 取得实际工具名称与参数，最后调用 `unreal_mcp_call_toolset`。该调用在已绑定的 UE 进程内执行注册工具，不启动另一个 HTTP MCP 服务；`DSHUnrealBridgeMCP` 是 UE 插件内单独的接入模块。MCP 调用默认直接执行，不经过 DSH 逐次批准；`allowWrites: false` 仍会拒绝调用。脚本执行型工具被接入模块拒绝。调用继续沿用请求编号去重、审计和结果未知查询机制。工具集内的保存/删除等操作会遵循 UE 工具自身语义，不沿用蓝图补丁的预览与版本机制。

成功的蓝图创建、应用和撤销，以及能够识别目标资产的 MCP 修改，会在编辑器下一帧排队展示该资产。展示只改变窗口和画布，不参与资产写入事务，也不改变写入的去重结果。蓝图和动画蓝图按节点 GUID 聚焦，材质按表达式 GUID 或节点 GUID 聚焦；未知节点保留当前画布视角。新增工具可以向展示服务提供资产、图与节点信息，而不需要重复实现窗口控制。

补丁示例（现有节点编号与引脚名必须先读取）：

```json
{
  "assetPath": "/Game/Blueprints/BP_Test",
  "graph": "EventGraph",
  "baseRevision": "从读取结果取得的版本",
  "operations": [
    {"op":"add_node","nodeId":"new_print","kind":"call_function","functionPath":"/Script/Engine.KismetSystemLibrary:PrintString","position":{"x":400,"y":100}},
    {"op":"set_pin_default","nodeId":"new_print","pin":"InString","value":"Hello"},
    {"op":"connect","from":{"node":"读取的BeginPlay节点编号","pin":"then"},"to":{"node":"new_print","pin":"execute"}}
  ]
}
```

其他操作为 `add_custom_event`（需要 UE 编辑器声明 `custom_event_patch` 能力，提供 `nodeId`、ASCII 标识符 `eventName` 和可选 `position`）、`remove_node`、`move_node` 和 `disconnect`。在同一补丁中，自定义事件的 `OutputDelegate` 引脚可连接 `/Script/Engine.KismetSystemLibrary:K2_SetTimerDelegate` 函数节点的 `Delegate` 输入，引脚 `Time` 和 `bLooping` 可用 `set_pin_default` 设置。新节点临时编号仅在当前补丁中有效，应用后重新读取持久节点 GUID 和 `customEventName`。

## WebSocket v1

host 监听 `ws://127.0.0.1:<port>/editor`。UE 从本地描述文件读取地址和令牌，在握手中提供 `Authorization: Bearer <token>`。允许 UE 原生客户端的回环 Origin；非回环来源被拒绝。浏览器 WebSocket 接口不能设置必需的 Authorization 头。

UE 首包 `hello` 包含 `protocol:1`、随机的进程生命周期 `editorId`、`project`、`projectPath`、`engineVersion`、`pid`、`capabilities`。host 返回 `hello_ack`。UE 推送 `{type:event,event,sequence,data}`；sequence 在每次重连时从零开始，旧序号被忽略。事件包括 `selection_changed`、`blueprint_changed` 与 `runtime_changed`。

`selection_changed.data.assets` 与 `unreal_state.selection` 表示最近操作的选区，最多 256 项。Content Browser 项保持 `{path,class}` 格式（也接受 `kind:"asset"`），兼容旧 UE 插件。支持 `level_selection` 的 UE 插件还会发送 `kind:"actor"` 或 `kind:"component"`，包含 `path`、`class`、`name`、`label`、`worldPath` 和可选的 `blueprintPath`。组件额外包含 `ownerPath`、`ownerLabel` 和可选的 `ownerBlueprintPath`。关卡项的 `path` 是活实例对象路径（可含 `:PersistentLevel`），不能作为蓝图资产路径传给图工具。选中组件时不重复发送其所属 Actor；清空关卡选区发送空数组，不回退到先前 Content Browser 选区。UE 在下一次桥接 tick 合并选择事件，重连后重新发送当前缓存。资产编辑器预览世界的 Actor 不属于关卡选区。

PIE 选区在原 Actor/组件结构上附加 `runtime:{playSessionId,worldId,objectId,pieInstance,netMode,status}`。`netMode` 为 `standalone`、`client`、`listen_server` 或 `dedicated_server`，选区中的 `status` 为 `running` 或 `paused`。身份由运行、世界和对象三个不透明编号组成，`path` 仅用于展示与辅助分析。`unreal_state.runtime` 为当前编辑器的 `{playSessionId:string|null,status:running|paused|stopped,isSimulating:boolean}`，未绑定或离线时为 null；`runtimeSnapshots` 为当前对话保留的快照摘要。旧插件不发送 runtime 字段时，编辑世界选区继续按原格式显示。

`runtime_inspection` 能力启用运行选区与 `runtime_snapshot` 请求。`runtime_changed.data` 包含上述全局运行状态与 `invalidated:[{playSessionId,worldId,objectId,reason}]`；停止状态的 `playSessionId` 为 null，失效条目保留原运行编号。UE 首次连接和重连认证后主动推送当前运行状态，再发送选区。全局状态描述编辑器暂停，选区/快照也会报告所属世界的暂停状态。

命令格式：`{type:request,protocol:1,id,method,params}`。响应格式：`{type:response,id,ok:true,result}` 或 `{type:response,id,ok:false,error:{code,message}}`。引擎线程队列每帧处理有限请求，重连会丢弃旧连接排队消息。所有 UObject 读写在游戏线程执行。

`blueprint_component_selection` 能力使用同一个选区事件，蓝图编辑器组件项为 `kind:"component",source:"blueprint_editor"`，包含 `path`（模板对象路径）、`class`、`name`、`label`、`componentVariableName`、`ownerLabel`、`ownerBlueprintPath`、`isInherited`，以及可选的组件类 `blueprintPath`。该项没有 `worldPath` 或 `ownerPath`；修改组件默认值应在 `ownerBlueprintPath` 中解析目标，继承组件不能直接按父类模板路径修改父资产。选择 Actor 根项时发送普通蓝图资产项；关闭当前蓝图清空选区，关闭旧蓝图不覆盖之后选中的 Content 或关卡对象。监听通过 UE 5.8 的 Blueprint Selection Notifier 注册，不替换蓝图编辑器已有的组件选择回调。

写入以 UUID 去重。编辑器保留最多 10000 个写入参数摘要和最近 1024 个完整结果，达到日志上限时拒绝写入。DSH 缓存已完成结果，并在超时/断线/取消后标记结果未知，阻止当前对话继续写入，直到查到原始结果。日志是进程内日志，重启编辑器会丢失；连接重试不重放写入。

蓝图版本由父类、图、节点序列化和变量信息计算摘要。它用于检测本插件操作相关的变化，不是资产的全量持久化版本库。保存/撤销需当前版本一致。实际修改先在临时副本编译，然后使用编辑器事务提交；提交编译失败时仅尝试撤销自己仍位于顶部的事务，回滚失败会明确返回错误。
