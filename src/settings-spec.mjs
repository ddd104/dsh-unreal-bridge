export const SETTINGS_NAMESPACE = 'dsh-unreal-bridge';
export const SETTINGS_SLOT_KEY = `${SETTINGS_NAMESPACE}#${SETTINGS_NAMESPACE}`;

const number = (key, label, defaultValue, min, max, group, hint, scale = 1, unit = '') =>
  ({key, label, type:'number', defaultValue, min, max, group, hint, scale, unit});
const boolean = (key, label, defaultValue, hint) =>
  ({key, label, type:'boolean', defaultValue, group:'permissions', hint});

export const SETTING_GROUPS = Object.freeze([
  {key:'permissions', label:'执行权限', hint:'保存后，从下一次请求开始使用；不清除写锁，也不改变已派发请求。'},
  {key:'repair', label:'修复限制', hint:'下一轮用户任务生效。修复次数与整轮累计错误次数分别计数。'},
  {key:'budget', label:'整轮任务预算', hint:'下一轮用户任务生效；进行中的任务保留启动时的预算。'},
  {key:'timeouts', label:'请求超时', hint:'下一次请求生效。写入超时后先查询原请求结果，不会自动重放。'},
  {key:'cache', label:'缓存保留', hint:'下一次清理生效；保存设置本身不会删除文件。'},
]);

export const FIELD_SPECS = Object.freeze([
  boolean('allowWrites', '允许修改 UE 资产和项目知识', true, '关闭后仍可读取；未知 MCP 操作按可能写入处理。'),
  boolean('requireApproval', '原生写入前请求批准', true, '适用于蓝图应用、撤销、保存和知识记录等原生写入；UE MCP 按既有策略执行。开启后需使用支持批准的 DSH 会话。'),
  number('guardMaxRepairAttempts', '每个问题最多修复次数', 3, 0, 50, 'repair', '0 表示发生问题后不尝试修复；失败请求不会被自动原样重放。'),
  number('guardMaxRepeatedErrors', '相同错误最多连续出现次数', 2, 1, 50, 'repair', '达到上限后停止继续尝试同一问题，并说明现状。'),
  number('guardMaxToolCalls', '工具调用总上限', 300, 1, 1000, 'budget', '包括 UE 任务激活后的其他工具调用。'),
  number('guardMaxSteps', '模型步骤总上限', 200, 1, 1000, 'budget', '单轮用户任务的模型步骤总数。'),
  number('guardMaxErrors', '累计错误总上限', 50, 1, 1000, 'budget', '成功调用不会清零；与单个问题的修复次数不同。'),
  number('guardTimeoutMs', '任务总时限', 1800000, 1000, 1800000, 'budget', '达到总时限会中止本轮任务。', 60000, '分钟'),
  number('requestTimeoutMs', '普通请求超时', 30000, 1000, 120000, 'timeouts', '原生编辑和一般查询的单次等待时间。', 1000, '秒'),
  number('knowledgeTimeoutMs', '知识查询超时', 120000, 1000, 600000, 'timeouts', '项目图谱、资料及知识查询的单次等待时间。', 1000, '秒'),
  number('visualTimeoutMs', '画面捕获超时', 60000, 1000, 300000, 'timeouts', '等待 UE 画面捕获完成的时间。', 1000, '秒'),
  number('visualCacheRetentionDays', '视觉证据保留天数', 30, 1, 3650, 'cache', '过期证据按清理规则处理；清理不会删除 UE 资产。', 1, '天'),
  number('visualCacheMaxMiB', '视觉缓存容量上限', 2048, 1, 1048576, 'cache', '清理时尝试将可回收的视觉缓存控制在此容量内。', 1, 'MiB'),
  number('auditRetentionDays', '审计归档保留天数', 30, 1, 3650, 'cache', '只清理符合规则的历史归档；当前审计日志保留。', 1, '天'),
  number('auditMaxArchives', '最多保留审计归档数', 10, 0, 10000, 'cache', '超过数量时优先清理较旧归档；0 表示不保留轮转归档，当前日志仍保留。'),
].map(Object.freeze));

export const DEFAULTS = Object.freeze(Object.fromEntries(FIELD_SPECS.map(field => [field.key, field.defaultValue])));

export function fieldValueError(field, value) {
  if (field.type === 'boolean') return typeof value === 'boolean' ? null : '请选择开或关。';
  if (!Number.isSafeInteger(value) || value < field.min || value > field.max)
    return `请输入 ${field.min / field.scale}–${field.max / field.scale} ${field.unit}范围内的有效数值。`;
  return null;
}
