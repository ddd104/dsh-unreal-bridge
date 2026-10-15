import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';

const MAX_BYTES = 48 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const READ_TOOLS = new Set(['read_source', 'inspect_asset', 'inspect_object', 'find_objects', 'runtime_context']);
const FEEDBACK = new Set(['plan_validated', 'sent', 'assertion_passed', 'assertion_failed', 'execution_failed']);
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// 只统一规范等价 Unicode 和首尾空白，显式文本值中的空格及全半角差异不能被吞掉。
export function normalizeExperienceQuery(query) { return query.normalize('NFC').trim(); }

function string(value, name, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || value.includes('\0')) fail('invalid_experience', `${name} must be a bounded string.`);
  return value;
}
function array(value, name, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail('invalid_experience', `${name} must be an array of at most ${maximum} entries.`);
  return value;
}
function stringArray(value, name) { return [...new Set(array(value, name, 128).map(item => string(item, name, 512)))]; }

// 冻结选择参与语义隔离；空选择兼容旧缓存键，不合并不同目标上的相同描述。
function assetTargets(value = []) {
  return [...new Set(array(value, 'asset_targets', 128).map(item => {
    const target = string(item, 'asset target', 2048);
    if (!/^\/[\p{L}\p{N}_-]+\/[\p{L}\p{N}_/.-]+\.[\p{L}\p{N}_-]+$/u.test(target) || target.includes('..')) fail('invalid_experience', 'Asset targets must be full object paths.');
    return target;
  }))].sort();
}

// 经验只保存结构化方法和证据引用，不接收密钥、完整能力目录或原始证据正文。
function safeJson(value, depth = 0) {
  if (depth > 20) fail('invalid_experience', 'Experience JSON is nested too deeply.');
  if (typeof value === 'string') {
    if (value.length > 8192 || /\b(?:sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})\b|(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?[^\s,"';]{8,}/i.test(value)) fail('invalid_experience', 'Long text or possible credentials cannot be stored as experience.');
    return value;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return array(value, 'JSON list', 256).map(item => safeJson(item, depth + 1));
  if (!plain(value) || Object.keys(value).length > 128) fail('invalid_experience', 'Experience JSON must be a bounded object.');
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 128 || /^(?:__proto__|prototype|constructor|authorization|api[_-]?key|access[_-]?token|password|secret|full[_-]?capabilities|raw[_-]?evidence|evidence[_-]?text)$/i.test(key)) fail('invalid_experience', 'Private or raw evidence fields cannot be stored as experience.');
    copy[key] = safeJson(item, depth + 1);
  }
  return copy;
}
function tokens(query) {
  const result = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const match of query.matchAll(/[\p{Script=Han}]{2,}/gu)) for (let i = 0; i < Math.min(match[0].length - 1, 64); i++) result.push(match[0].slice(i, i + 2));
  return [...new Set(result)].slice(0, 100);
}
function compact(record) {
  const { identity, normalized_query, created_at, updated_at, feedback, ...recipe } = record;
  return recipe;
}
function hint(record) {
  // 失效经验只提供调查入口，不把旧计划、旧取值或旧指纹交给复用执行路径。
  const result = { id: record.id, query: record.query.slice(0, 512), intent: record.intent.slice(0, 512), summary: record.summary.slice(0, 1024), action_ids: [], probe_ids: [], sources: [], reads: [], reusable: false, requires_research: true };
  const append = (field, value) => { if (Buffer.byteLength(JSON.stringify({ ...result, [field]: [...result[field], value] }), 'utf8') <= 12288) result[field].push(value); };
  for (const source of record.sources.slice(0, 4)) append('sources', source);
  for (const action of record.action_ids.slice(0, 16)) append('action_ids', action);
  for (const probe of record.probe_ids.slice(0, 16)) append('probe_ids', probe);
  for (const read of record.reads.slice(0, 8)) {
    const entry = { tool: read.tool, arguments: read.arguments, ...(read.selector ? { selector: read.selector } : {}) };
    append('reads', entry);
  }
  return result;
}

// 与图谱代目录独立保存；图谱重建不会删除经验，全部缓存仍位于插件内。
export function createExperienceStore({ cache, identity, safeCache, atomicJson, validateEvidence }) {
  const directory = path.join(cache, 'Experiences');
  const keyFor = (query, adapter, targets = []) => sha(`${identity}\n${adapter}\n${targets.length ? `\0asset_targets:${JSON.stringify(targets)}\n` : ''}${normalizeExperienceQuery(query)}`);

  async function read(id) {
    if (!HASH.test(id)) return null;
    const file = path.join(directory, `${id}.json`);
    try {
      await safeCache(file);
      if ((await stat(file)).size > MAX_BYTES) return null;
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (record.schema !== 1 || record.id !== id || record.identity !== identity || record.validation !== 'plan_validated' || record.effect_verified !== false) return null;
      const targets = assetTargets(record.asset_targets);
      if (typeof record.query !== 'string' || typeof record.adapter !== 'string' || id !== keyFor(record.query, record.adapter, targets)
        || typeof record.catalog !== 'string' || typeof record.intent !== 'string' || typeof record.summary !== 'string'
        || typeof record.updated_at !== 'string' || typeof record.reusable !== 'boolean'
        || !Array.isArray(record.sources) || record.sources.length > 64 || !plain(record.feedback)
        || !plain(record.planning_plan) || !Array.isArray(record.reads) || !Array.isArray(record.bindings)) return null;
      // 局部损坏或手工编辑的缓存不能让整次检索失败，也不能绕过写入时的结构门禁。
      string(record.query, 'query', 8192); string(record.adapter, 'adapter', 256); string(record.catalog, 'catalog', 512);
      string(record.intent, 'intent', 1024, true); string(record.summary, 'summary', 4096, true);
      string(record.runtime_signature, 'runtime_signature', 512, !record.reusable);
      stringArray(record.action_ids, 'action_ids'); stringArray(record.probe_ids, 'probe_ids');
      for (const source of record.sources) {
        if (!plain(source) || !HASH.test(source.hash)) return null;
        string(source.path, 'source path', 2048);
      }
      for (const read of array(record.reads, 'reads', 64)) {
        if (!plain(read) || !READ_TOOLS.has(read.tool) || !plain(read.arguments)) return null;
        string(read.id, 'read id', 128); string(read.fingerprint, 'read fingerprint', 512);
      }
      if (new Set(record.reads.map(read => read.id)).size !== record.reads.length) return null;
      for (const [status, count] of Object.entries(record.feedback)) if (!FEEDBACK.has(status) || !Number.isInteger(count) || count < 0 || count > 1000000000) return null;
      array(record.bindings, 'bindings', 64); safeJson(record);
      record.asset_targets = targets;
      return record;
    } catch { return null; }
  }

  async function freshness(record, catalog) {
    if (record.catalog !== catalog) return { id: record.id, reason: 'catalog_changed', hint: hint(record) };
    const validation = await validateEvidence(record);
    if (!validation.fresh) return { id: record.id, reason: 'sources_changed', sources: validation.changed, hint: hint(record) };
    return null;
  }

  async function lookup(args) {
    const empty = { exact: null, related: [], stale: [], match: 'miss' };
    if (typeof args.query !== 'string' || !args.query.trim() || typeof args.adapter !== 'string' || !args.adapter.trim() || typeof args.catalog !== 'string' || !args.catalog.trim()) return empty;
    string(args.query, 'query', 8192); string(args.adapter, 'adapter', 256); string(args.catalog, 'catalog', 512);
    const targets = assetTargets(args.asset_targets);
    const id = keyFor(args.query, args.adapter, targets);
    const exact = await read(id);
    if (exact) {
      const stale = await freshness(exact, args.catalog);
      if (stale) empty.stale.push(stale);
      else if (exact.reusable === true) return { ...empty, exact: compact(exact), match: 'exact' };
      else empty.stale.push({ id: exact.id, reason: 'requires_research', hint: hint(exact) });
    }
    let entries;
    try { await safeCache(directory); entries = await readdir(directory, { withFileTypes: true }); } catch { return empty; }
    const words = tokens(args.query);
    const candidates = [];
    const recentCandidates = [];
    // 精确命中只读单条；相似检索有界读取经验目录，不触发全项目扫描。
    for (const entry of entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).slice(0, 1024)) {
      const candidateId = entry.name.slice(0, -5);
      if (candidateId === id) continue;
      const record = await read(candidateId);
      if (!record || record.adapter !== args.adapter || JSON.stringify(record.asset_targets) !== JSON.stringify(targets)) continue;
      recentCandidates.push(record);
      const candidateWords = new Set(tokens(`${record.query} ${record.intent} ${record.summary}`));
      const overlaps = words.filter(word => candidateWords.has(word)).length;
      if (!overlaps) continue;
      candidates.push({ record, score: overlaps / Math.max(words.length, 1) });
    }
    candidates.sort((a, b) => b.score - a.score || b.record.updated_at.localeCompare(a.record.updated_at));
    const checked = new Map();
    for (const { record, score } of candidates.slice(0, 12)) {
      const stale = await freshness(record, args.catalog);
      checked.set(record.id, stale);
      if (stale) { if (empty.stale.length < 8) empty.stale.push(stale); continue; }
      empty.related.push({ ...compact(record), similarity: score, matchBasis: 'lexical' });
      if (empty.related.length === 3) break;
    }
    // 换语言或完全不同措辞时提供少量近期候选，让模型确认意图；零相似度绝不授权直接复用。
    if (empty.related.length === 0) {
      const uses = record => (record.feedback.sent ?? 0) + (record.feedback.plan_validated ?? 0);
      recentCandidates.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || uses(b) - uses(a));
      for (const record of recentCandidates.slice(0, 12)) {
        const alreadyChecked = checked.has(record.id);
        const stale = alreadyChecked ? checked.get(record.id) : await freshness(record, args.catalog);
        if (stale) { if (!alreadyChecked && empty.stale.length < 8) empty.stale.push(stale); continue; }
        empty.related.push({ ...compact(record), similarity: 0, matchBasis: 'recent_fallback' });
        if (empty.related.length === 3) break;
      }
    }
    empty.match = empty.related.length ? 'related' : empty.stale.length ? 'stale' : 'miss';
    return empty;
  }

  async function save(args) {
    if (!plain(args) || args.schema !== 1 || typeof args.reusable !== 'boolean') fail('invalid_experience', 'A version 1 experience record and reusable flag are required.');
    const query = string(args.query, 'query', 8192);
    const adapter = string(args.adapter, 'adapter', 256);
    const catalog = string(args.catalog, 'catalog', 512);
    const targets = assetTargets(args.asset_targets);
    const id = keyFor(query, adapter, targets);
    const sources = array(args.sources, 'sources', 64).map(source => {
      if (!plain(source) || !HASH.test(source.hash)) fail('invalid_experience', 'Each source requires a SHA-256 hash.');
      return { path: string(source.path, 'source path', 2048), hash: source.hash };
    });
    const reads = array(args.reads, 'reads', 64).map(read => {
      if (!plain(read) || !READ_TOOLS.has(read.tool) || !plain(read.arguments)) fail('invalid_experience', 'Experience reads must use an allowed read-only tool.');
      return { id: string(read.id, 'read id', 128), tool: read.tool, arguments: safeJson(read.arguments), ...(read.selector !== undefined ? { selector: safeJson(read.selector) } : {}), fingerprint: string(read.fingerprint, 'read fingerprint', 512) };
    });
    if (new Set(reads.map(read => read.id)).size !== reads.length) fail('invalid_experience', 'Read IDs must be unique.');
    if (!plain(args.planning_plan)) fail('invalid_experience', 'planning_plan must contain the unresolved planning recipe.');
    const now = new Date().toISOString();
    const previous = await read(id);
    const record = {
      schema: 1, id, identity, query, normalized_query: normalizeExperienceQuery(query), adapter, catalog, asset_targets: targets,
      intent: string(args.intent, 'intent', 1024, true), summary: string(args.summary, 'summary', 4096, true),
      planning_plan: safeJson(args.planning_plan), bindings: safeJson(array(args.bindings, 'bindings', 64)), sources, reads,
      runtime_signature: string(args.runtime_signature, 'runtime_signature', 512, !args.reusable), reusable: args.reusable,
      action_ids: stringArray(args.action_ids, 'action_ids'), probe_ids: stringArray(args.probe_ids, 'probe_ids'),
      validation: 'plan_validated', effect_verified: false,
      created_at: previous?.created_at ?? now, updated_at: now,
      feedback: previous?.feedback ?? { plan_validated: 0, sent: 0, assertion_passed: 0, assertion_failed: 0, execution_failed: 0 }
    };
    safeJson({ query, intent: record.intent, summary: record.summary });
    record.feedback.plan_validated = Math.min((record.feedback.plan_validated ?? 0) + 1, 1000000000);
    if (Buffer.byteLength(JSON.stringify(record, null, 2), 'utf8') > MAX_BYTES - 512) fail('experience_too_large', 'Experience exceeds the 48 KiB storage limit.');
    const validation = await validateEvidence(record);
    if (!validation.fresh) fail('source_changed', 'Experience sources changed before persistence; research them again.');
    await atomicJson(path.join(directory, `${id}.json`), record);
    return { id, validation: 'plan_validated', effect_verified: false, reusable: record.reusable, stored: true };
  }

  async function feedback(args) {
    if (!HASH.test(args.id) || !FEEDBACK.has(args.status)) fail('invalid_feedback', 'Feedback must identify a stored record and an observed planning, send, or assertion status.');
    const record = await read(args.id);
    if (!record) return { updated: false, reason: 'experience_missing' };
    const count = args.observation_count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 10000) fail('invalid_feedback', 'observation_count must be an integer between 1 and 10000.');
    // 发送回执、断言统计不能冒充视觉或最终业务效果验证。
    record.feedback[args.status] = Math.min((record.feedback[args.status] ?? 0) + count, 1000000000);
    record.updated_at = new Date().toISOString();
    await atomicJson(path.join(directory, `${record.id}.json`), record);
    return { id: record.id, updated: true, validation: 'plan_validated', effect_verified: false, feedback: record.feedback };
  }
  return { lookup, save, feedback };
}
