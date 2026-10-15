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
