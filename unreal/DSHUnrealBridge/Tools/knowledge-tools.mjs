// Worker dispatch admission. A cross-language contract test checks this list against
// the native routing catalog; every entry is exercised by the worker integration test.
export const workerToolNames = Object.freeze([
  'project_status',
  'project_update',
  'project_context',
  'project_search',
  'graph_query',
  'graph_feature',
  'graph_impact',
  'read_source',
  'validate_evidence',
  'experience_lookup',
  'remember_evidence',
  'experience_save',
  'experience_feedback'
]);

const workerTools = new Set(workerToolNames);
export const isWorkerTool = name => workerTools.has(name);
