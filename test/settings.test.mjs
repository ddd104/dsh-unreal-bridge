import test from 'node:test';
import assert from 'node:assert/strict';
import {Config, createConfigState, registerSettings} from '../src/settings.mjs';
import {FIELD_SPECS, DEFAULTS, fieldValueError} from '../src/settings-spec.mjs';

test('official Config exposes only editable fields as volatile and validates defaults and bounds', () => {
  const parsed = Config({});
  for (const field of FIELD_SPECS) {
    assert.equal(parsed[field.key].get(), DEFAULTS[field.key]);
    assert.equal(Config.dict[field.key].meta.volatile, true);
    if (field.type === 'number') {
      assert.throws(() => Config({[field.key]:field.min - 1}));
      assert.throws(() => Config({[field.key]:field.max + 1}));
      assert.throws(() => Config({[field.key]:field.min + 0.5}));
      assert.equal(Config({[field.key]:field.min})[field.key].get(), field.min);
    }
  }
  for (const key of ['port','stateDir','allowMcpDesktopInput']) assert.notEqual(Config.dict[key].meta.volatile, true);
  assert.equal(parsed.port, 17891);
  assert.equal(parsed.allowMcpDesktopInput, false);
  assert.equal(createConfigState({requireApproval:false}).current.requireApproval, false);
});

test('configuration views retain live references and operation snapshots stay unchanged', () => {
  const parsed = Config({port:17892, stateDir:'F:/isolated-state', guardMaxErrors:17});
  const state = createConfigState(parsed);
  const original = state.snapshot(), current = state.current;
  parsed.guardMaxErrors[Symbol.for('cosmokit.volatile.write')](22);
  assert.equal(state.current, current);
  assert.equal(current.guardMaxErrors, 22);
  assert.equal(original.guardMaxErrors, 17);
  assert.equal(state.snapshot().guardMaxErrors, 22);
  assert.equal(current.port, 17892);
  assert.ok(Object.isFrozen(current));
  assert.ok(Object.isFrozen(original));
  assert.equal(fieldValueError(FIELD_SPECS.find(field=>field.key==='guardMaxRepairAttempts'), 0), null);
});

test('custom settings presentation uses the official Settings service lifecycle', () => {
  const owner = {};
  let disposed = false;
  const ctx = {fiber:owner, inject(keys, callback) {
    assert.deepEqual(keys, ['settings']);
    callback({effect(factory) {const release=factory(); release();}, settings:{configure(policy,fiber) {
      assert.deepEqual(policy,{auto:false}); assert.equal(fiber,owner);
      return ()=>{disposed=true;};
    }}});
  }};
  registerSettings(ctx);
  assert.equal(disposed,true);
});
