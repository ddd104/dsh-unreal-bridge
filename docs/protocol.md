# 工具与通信协议

DSH host 使用 Cordis tools、systemPrompt、Typert remote 服务；客户端贡献 `conversation.input.dock`。不修改模型循环，不注册独立应用入口。模型可见的实时状态由工具返回，写入 DSH 的工具记录；选区事件不偷偷追加未记录的提示词。

## 模型工具

| 工具 | 参数与用途 |
| --- | --- |
| `unreal_state` | `{}`，获取在线编辑器、当前绑定、选区和未知写入状态 |
| `unreal_bind` | `editorId` 字符串或 null，仅改变当前对话绑定 |
| `unreal_catalog` | 可选 `query`、`limit`，查询函数路径和精确引脚名 |
| `unreal_knowledge` | `tool`、`arguments`，通过当前对话绑定的 UE 编辑器查询项目状态、资料、图谱候选、源码及分页资产快照 |
| `unreal_knowledge_record` | `tool`、`arguments`、UUID `requestId`，按配置保存带来源的推断或经验；写入项目缓存并支持请求状态查询 |
| `unreal_mcp_tools` | `{}`，列出当前 UE 实例注册的顶层 MCP 工具与参数 schema |
| `unreal_mcp_toolsets` | `{}`，列出当前 UE 实例中的工具集 |
| `unreal_mcp_describe` | `toolsetName`，可选 `query` 按工具名过滤、`includeSchema: false` 返回简短列表；需要调用的工具再取得精确参数 schema |
| `unreal_mcp_call_toolset` | `toolsetName`、`toolName`、`arguments`、UUID `requestId`，默认直接调用工具集函数 |
| `unreal_mcp_call` | `name`、`arguments`、UUID `requestId`，默认直接调用顶层 MCP 工具 |
| `unreal_read_blueprint` | `assetPath`，可选 `graph`、`nodeIds`、`detail: summary/full` |
| `unreal_focus_asset` | `assetPath`，可选 `graph`、`nodeIds`；手动打开并最大化资产编辑器，节点可识别时聚焦；返回 `queued` 表示展示任务已排队 |
| `unreal_preview_create` | `assetPath`、`parent: Actor/ActorComponent/Object` |
| `unreal_preview_patch` | `assetPath`、`graph`、`baseRevision`、`operations` |
| `unreal_apply` | `previewId`、UUID `requestId`，按配置应用，默认不保存 |
| `unreal_request_status` | UUID `requestId`，查询原请求结果，不重做写入 |
| `unreal_undo` | `assetPath`、`baseRevision`、UUID `requestId` |
| `unreal_save` | `assetPath`、`baseRevision`、UUID `requestId` |

每个工具需要所属 DSH 对话；其他对话不能使用本对话的 previewId。预览五分钟有效；绑定不同实例、断线或蓝图变化会阻止使用旧预览。资产路径使用 `/Game/Folder/BP_Name` 或对应对象路径，不能使用磁盘 `.uasset` 路径。

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

UE 首包 `hello` 包含 `protocol:1`、随机的进程生命周期 `editorId`、`project`、`projectPath`、`engineVersion`、`pid`、`capabilities`。host 返回 `hello_ack`。UE 推送 `{type:event,event,sequence,data}`；sequence 在每次重连时从零开始，旧序号被忽略。事件包括 `selection_changed` 与 `blueprint_changed`。

命令格式：`{type:request,protocol:1,id,method,params}`。响应格式：`{type:response,id,ok:true,result}` 或 `{type:response,id,ok:false,error:{code,message}}`。引擎线程队列每帧处理有限请求，重连会丢弃旧连接排队消息。所有 UObject 读写在游戏线程执行。

写入以 UUID 去重。编辑器保留最多 10000 个写入参数摘要和最近 1024 个完整结果，达到日志上限时拒绝写入。DSH 缓存已完成结果，并在超时/断线/取消后标记结果未知，阻止当前对话继续写入，直到查到原始结果。日志是进程内日志，重启编辑器会丢失；连接重试不重放写入。

蓝图版本由父类、图、节点序列化和变量信息计算摘要。它用于检测本插件操作相关的变化，不是资产的全量持久化版本库。保存/撤销需当前版本一致。实际修改先在临时副本编译，然后使用编辑器事务提交；提交编译失败时仅尝试撤销自己仍位于顶部的事务，回滚失败会明确返回错误。
