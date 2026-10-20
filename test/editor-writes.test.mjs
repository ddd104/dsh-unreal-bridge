import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {UnrealBridge} from '../src/bridge.mjs';

const DATA_TABLE = 'editor_toolset.toolsets.data_table.DataTableTools';
const ok = result => ({ok: true, result});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const save = (bridge, session, requestId = randomUUID(), signal) =>
  bridge.mutate(session, 'save', {assetPath: '/Game/Test/BP_Test'}, requestId, signal);

async function fixture(t, config = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-editor-writes-'));
  const bridge = await new UnrealBridge({port: 0, stateDir, ...config}).start();
  t.after(async () => {
    await bridge.close();
    await rm(stateDir, {recursive: true, force: true});
  });
  return bridge;
}

async function editor(bridge, editorId, handler) {
  const calls = [];
  const socket = new WebSocket(bridge.descriptor.url, {headers: {Authorization: `Bearer ${bridge.token}`}});
  await once(socket, 'open');
  const ack = once(socket, 'message');
  socket.send(JSON.stringify({
    type: 'hello', protocol: 1, editorId, project: editorId, projectPath: `/tmp/${editorId}`,
    engineVersion: '5.8', pid: 42, capabilities: ['mcp_tools', 'mcp_target_validation', 'read_blueprint'],
  }));
  await ack;
  socket.on('message', async raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'request') return;
    calls.push(message);
    const response = await handler(message);
    if (response !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({type: 'response', id: message.id, ...response}));
    }
  });
  return {calls, socket};
}

test('pending mutations exclude other conversations on the editor while another editor and native reads proceed', async t => {
  const bridge = await fixture(t);
  const started = deferred(), finish = deferred();
  let writes = 0;
  const a = await editor(bridge, 'A', async message => {
    if (message.method !== 'save') return ok({read: true});
    if (++writes === 1) { started.resolve(); await finish.promise; }
    return ok({saved: true});
  });
  await editor(bridge, 'B', () => ok({saved: true}));
  bridge.bind('one', 'A'); bridge.bind('two', 'A'); bridge.bind('independent', 'B');
  const pending = save(bridge, 'one');
  await started.promise;
  assert.equal(bridge.state('two').editorWrite.sessionId, 'one');
  await assert.rejects(save(bridge, 'two'), e => e.code === 'BUSY' && e.details.execution === 'not_started');
  assert.deepEqual(await save(bridge, 'independent'), {saved: true});
  assert.deepEqual(await bridge.read('two', {assetPath: '/Game/Test/BP_Test'}), {read: true});
  assert.equal(a.calls.filter(call => call.method === 'save').length, 1);
  finish.resolve(); await pending;
  assert.equal(bridge.state('two').editorWrite, null);
  await save(bridge, 'two');
  assert.equal(writes, 2);
});

test('unknown writes protect every conversation until a peer reconciles the original request and owner cache', async t => {
  const bridge = await fixture(t, {requestTimeoutMs: 60});
  let status = 'pending', writes = 0;
  const requestId = randomUUID();
  await editor(bridge, 'A', message => {
    if (message.method === 'save') { writes++; return undefined; }
    if (message.params.requestId !== requestId) return ok({status: 'unknown'});
    return ok(status === 'completed' ? {status, response: ok({saved: true})} : {status});
  });
  bridge.bind('owner', 'A'); bridge.bind('peer', 'A');
  await assert.rejects(save(bridge, 'owner', requestId), {code: 'TIMEOUT'});
  assert.equal(bridge.state('peer').uncertain.requestId, requestId);
  for (status of ['pending', 'unknown', 'expired']) {
    await bridge.requestStatus('peer', requestId);
    await assert.rejects(save(bridge, 'peer'), {code: 'OUTCOME_UNKNOWN'});
  }
  await bridge.requestStatus('peer', randomUUID());
  assert.equal(bridge.state('peer').editorWrite.phase, 'uncertain');
  status = 'completed';
  await bridge.requestStatus('peer', requestId);
  assert.equal(bridge.state('owner').uncertain, null);
  assert.equal(bridge.state('peer').editorWrite, null);
  assert.deepEqual(await save(bridge, 'owner', requestId), {saved: true});
  assert.equal(writes, 1, 'querying from another chat updates the original cache without replay');
});

test('changing the owner binding cannot move or discard an unresolved editor write', async t => {
  const bridge = await fixture(t, {requestTimeoutMs: 60});
  const requestId = randomUUID();
  await editor(bridge, 'A', message => message.method === 'save' ? undefined : ok({status: 'completed', response: ok({saved: true})}));
  await editor(bridge, 'B', () => ok({saved: true}));
  bridge.bind('owner', 'A'); bridge.bind('peer', 'A');
  await assert.rejects(save(bridge, 'owner', requestId), {code: 'TIMEOUT'});
  bridge.bind('owner', null); bridge.bind('owner', 'B');
  await assert.rejects(save(bridge, 'owner'), {code: 'OUTCOME_UNKNOWN'});
  await assert.rejects(save(bridge, 'peer'), {code: 'OUTCOME_UNKNOWN'});
  await bridge.requestStatus('peer', requestId);
  assert.deepEqual(await save(bridge, 'owner'), {saved: true});
  bridge.bind('owner', 'A');
  assert.deepEqual(await save(bridge, 'owner', requestId), {saved: true});
});

test('audited MCP reads remain available during unknown writes and read-only mode; unknown tools stay blocked', async t => {
  const bridge = await fixture(t, {requestTimeoutMs: 60});
  const calls = (await editor(bridge, 'A', message => {
    if (message.method === 'save') return undefined;
    if (message.method === 'mcp_discover') return ok({content: [{type: 'text', text: JSON.stringify({
      tools: [{name: `${DATA_TABLE}.get_schema`, inputSchema: {type: 'object', properties: {}}}],
    })}]});
    return ok({schema: 'FTest'});
  })).calls;
  bridge.bind('owner', 'A'); bridge.bind('peer', 'A');
  await assert.rejects(save(bridge, 'owner'), {code: 'TIMEOUT'});
  const read = () => bridge.mcpCallToolset('peer', {toolsetName: DATA_TABLE, toolName: 'get_schema', arguments: {}, requestId: randomUUID()});
  assert.deepEqual(await read(), {schema: 'FTest'});
  const count = calls.length;
  await assert.rejects(bridge.mcpCallToolset('peer', {toolsetName: 'UnknownTools', toolName: 'get_and_modify', arguments: {}, requestId: randomUUID()}), {code: 'OUTCOME_UNKNOWN'});
  assert.equal(calls.length, count, 'unknown tools cannot use discovery as a way around the barrier');
  bridge.config.allowWrites = false;
  assert.deepEqual(await read(), {schema: 'FTest'});
  assert.equal(bridge.state('owner').editorWrite.phase, 'uncertain', 'a read does not release another request');
});

test('legacy Blueprint rollback failures lock the editor immediately and when recovered by another chat', async t => {
  for (const recovered of [false, true]) {
    const bridge = await fixture(t, {requestTimeoutMs: 60});
    const error = {code: 'ROLLBACK_FAILED', message: 'automatic rollback was not possible'};
    const calls = (await editor(bridge, 'A', message =>
      message.method === 'request_status' ? ok({status: 'completed', response: {ok: false, error}})
        : recovered ? undefined : {ok: false, error}
    )).calls;
    bridge.bind('owner', 'A'); bridge.bind('peer', 'A');
    const requestId = randomUUID();
    await assert.rejects(save(bridge, 'owner', requestId), {code: recovered ? 'TIMEOUT' : 'ROLLBACK_FAILED'});
    if (recovered) await assert.rejects(bridge.requestStatus('peer', requestId), {code: 'ROLLBACK_FAILED'});
    assert.equal(bridge.state('peer').writeLock.rollback, 'failed');
    const count = calls.length;
    await assert.rejects(save(bridge, 'peer'), {code: 'EDITOR_WRITE_LOCKED'});
    assert.equal(calls.length, count);
  }
});

test('cancellation after dispatch retains protection, but cancellation before dispatch releases the lease', async t => {
  const bridge = await fixture(t);
  const started = deferred();
  let dispatched = false;
  await editor(bridge, 'A', message => {
    if (message.method === 'save') { dispatched = true; started.resolve(); return undefined; }
    return ok({status: 'completed', response: ok({saved: true})});
  });
  bridge.bind('owner', 'A'); bridge.bind('peer', 'A');
  const before = new AbortController(); before.abort();
  await assert.rejects(save(bridge, 'owner', randomUUID(), before.signal), e => e.code === 'CANCELLED' && e.details.execution === 'not_started');
  assert.equal(dispatched, false); assert.equal(bridge.state('peer').editorWrite, null);
  const during = new AbortController(), requestId = randomUUID();
  const pending = save(bridge, 'owner', requestId, during.signal);
  const rejected = assert.rejects(pending, {code: 'CANCELLED'});
  await started.promise; during.abort(); await rejected;
  await assert.rejects(save(bridge, 'peer'), {code: 'OUTCOME_UNKNOWN'});
  await bridge.requestStatus('peer', requestId);
  assert.equal(bridge.state('owner').uncertain, null);
});

test('an audit failure before dispatch releases the editor for another conversation', async t => {
  const bridge = await fixture(t);
  const calls = (await editor(bridge, 'A', () => ok({saved: true}))).calls;
  bridge.bind('owner', 'A'); bridge.bind('peer', 'A');
  const audit = bridge.audit.bind(bridge);
  bridge.audit = async row => { if (row.phase === 'requested') throw new Error('disk unavailable'); };
  const requestId = randomUUID();
  await assert.rejects(save(bridge, 'owner', requestId), /disk unavailable/);
  assert.equal(calls.length, 0); assert.equal(bridge.state('peer').editorWrite, null);
  bridge.audit = audit;
  assert.deepEqual(await save(bridge, 'owner', requestId), {saved: true});
  assert.deepEqual(await save(bridge, 'peer'), {saved: true});
});

test('a stale parallel status response cannot release a newer pending mutation', async t => {
  const bridge = await fixture(t, {requestTimeoutMs: 250});
  const firstId = randomUUID(), secondId = randomUUID();
  const lateStatus = deferred(), lateStarted = deferred(), secondStarted = deferred(), finishSecond = deferred();
  let statuses = 0;
  await editor(bridge, 'A', async message => {
    if (message.method === 'save') {
      if (message.id === firstId) return undefined;
      secondStarted.resolve(); await finishSecond.promise; return ok({saved: true});
    }
    if (++statuses === 2) { lateStarted.resolve(); await lateStatus.promise; }
    return ok({status: 'completed', response: ok({saved: true})});
  });
  bridge.bind('owner', 'A'); bridge.bind('peer', 'A');
  await assert.rejects(save(bridge, 'owner', firstId), {code: 'TIMEOUT'});
  const first = bridge.requestStatus('owner', firstId), late = bridge.requestStatus('peer', firstId);
  await lateStarted.promise; await first;
  const second = save(bridge, 'owner', secondId);
  await secondStarted.promise; lateStatus.resolve(); await late;
  assert.equal(bridge.state('peer').editorWrite.requestId, secondId);
  await assert.rejects(save(bridge, 'peer'), {code: 'BUSY'});
  finishSecond.resolve(); await second;
});

test('reconnecting the same editor preserves unresolved writes until the original result is recovered', async t => {
  const bridge = await fixture(t);
  const started = deferred();
  const old = await editor(bridge, 'A', () => { started.resolve(); return undefined; });
  bridge.bind('owner', 'A'); bridge.bind('peer', 'A');
  const requestId = randomUUID(), pending = save(bridge, 'owner', requestId);
  const rejected = assert.rejects(pending, {code: 'DISCONNECTED'});
  await started.promise;
  const closed = once(bridge.editors.get('A').ws, 'close'); old.socket.close(); await closed; await rejected;
  await editor(bridge, 'A', () => ok({status: 'completed', response: ok({saved: true})}));
  await assert.rejects(save(bridge, 'peer'), {code: 'OUTCOME_UNKNOWN'});
  await bridge.requestStatus('peer', requestId);
  assert.deepEqual(await save(bridge, 'owner', requestId), {saved: true});
});

test('malformed completed status does not unlock an uncertain write', async t => {
  const bridge = await fixture(t, {requestTimeoutMs: 60});
  let response;
  await editor(bridge, 'A', message => message.method === 'save' ? undefined : ok({status: 'completed', response}));
  bridge.bind('owner', 'A'); bridge.bind('peer', 'A');
  const requestId = randomUUID();
  await assert.rejects(save(bridge, 'owner', requestId), {code: 'TIMEOUT'});
  for (response of [{}, {ok: true}, {ok: true, result: null}, {ok: true, id: '', result: {}}, {ok: true, id: randomUUID(), result: {}}, {ok: false, error: {code: 'FAIL'}}]) {
    await assert.rejects(bridge.requestStatus('peer', requestId), {code: 'INVALID_REQUEST_STATUS'});
    await assert.rejects(save(bridge, 'peer'), {code: 'OUTCOME_UNKNOWN'});
  }
});

test('an audited read cannot return data after its binding changes during audit or execution', async t => {
  for (const phase of ['audit', 'execution']) {
    const bridge = await fixture(t);
    const started = deferred(), finish = deferred();
    let dispatches = 0;
    await editor(bridge, 'A', async message => {
      if (message.method === 'mcp_discover') return ok({content: [{type: 'text', text: JSON.stringify({
        tools: [{name: `${DATA_TABLE}.get_schema`, inputSchema: {type: 'object', properties: {}}}],
      })}]});
      dispatches++;
      if (phase === 'execution') { started.resolve(); await finish.promise; }
      return ok({editor: 'A'});
    });
    await editor(bridge, 'B', () => ok({editor: 'B'}));
    bridge.bind('chat', 'A');
    const audit = bridge.audit.bind(bridge);
    bridge.audit = async row => {
      if (phase === 'audit' && row.phase === 'requested') { started.resolve(); await finish.promise; }
      return audit(row);
    };
    const pending = bridge.mcpCallToolset('chat', {toolsetName: DATA_TABLE, toolName: 'get_schema', arguments: {}, requestId: randomUUID()});
    const rejected = assert.rejects(pending, {code: 'INSTANCE_CHANGED'});
    await started.promise;
    bridge.bind('chat', 'B'); bridge.bind('chat', 'A');
    finish.resolve(); await rejected;
    assert.equal(dispatches, phase === 'audit' ? 0 : 1);
  }
});
