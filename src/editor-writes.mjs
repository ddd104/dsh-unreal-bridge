import {fail} from './protocol.mjs';

/**
 * One mutation at a time per editor, regardless of the owning conversation.
 * A transport failure retains the lease until the original result is known.
 */
export class EditorWrites {
  constructor() {
    this.leases = new Map();
  }

  get(editorId) {
    return this.leases.get(editorId);
  }

  details(lease) {
    const {editorId, sessionId, requestId, method, assetPath, phase} = lease;
    return {editorId, sessionId, requestId, method, ...(assetPath ? {assetPath} : {}), phase};
  }

  assertAvailable(editorId) {
    const lease = this.get(editorId);
    if (!lease) return;
    if (lease.phase === 'uncertain') {
      fail('OUTCOME_UNKNOWN', 'This editor has an unresolved write; query its original requestId before another write', this.details(lease));
    }
    fail('BUSY', 'Another conversation or request is writing to this editor', {
      ...this.details(lease), execution: 'not_started', retryable: true,
    });
  }

  acquire(record) {
    this.assertAvailable(record.editorId);
    const lease = {...record, phase: 'pending'};
    this.leases.set(lease.editorId, lease);
    return lease;
  }

  markUncertain(lease) {
    if (this.get(lease.editorId) === lease) lease.phase = 'uncertain';
  }

  release(lease) {
    if (this.get(lease.editorId) === lease) this.leases.delete(lease.editorId);
  }
}
