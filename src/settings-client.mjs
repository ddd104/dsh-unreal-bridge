import React, {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {FIELD_SPECS, SETTING_GROUPS, SETTINGS_NAMESPACE, SETTINGS_SLOT_KEY, fieldValueError, parseFieldInput} from './settings-spec.mjs';

const h = React.createElement;
const color = {
  text:'var(--dsw-alias-label-primary, #17191d)', muted:'var(--dsw-alias-label-secondary, #62666d)',
  border:'var(--dsw-alias-border-l2, #d5d8dc)', surface:'var(--dsw-alias-bg-layer-2, #fff)',
  error:'var(--dsw-alias-state-error-primary, #b91c1c)', accent:'var(--dsw-alias-brand-primary, #175cd3)',
};
const buttonStyle = {padding:'7px 12px', border:`1px solid ${color.border}`, borderRadius:6, background:color.surface, color:color.text, cursor:'pointer'};
const valuesOf = value => Object.fromEntries(FIELD_SPECS.map(field => [field.key, value?.[field.key] ?? field.defaultValue]));
const same = (left, right) => FIELD_SPECS.every(field => Object.is(left?.[field.key], right?.[field.key]));
const initialDraft = state => ({values:valuesOf(state.value), baseline:valuesOf(state.value), revision:state.revision, reset:false});

export function SettingsPage({view='page', form, renderCache:Cache}) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const mounted = useRef(true);
  const state = form?.state;
  const ready = state?.status === 'ready' && state.value !== undefined;
  const dirty = !!draft && (draft.reset || !same(draft.values, draft.baseline));
  const conflict = !!draft && dirty && draft.revision !== state?.revision;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (ready && !saving && (!draft || !dirty)) setDraft(initialDraft(state));
  }, [ready, state?.revision, state?.value, saving]);

  if (view === 'summary') return h('span', null, '设置修复次数、执行预算、请求超时与缓存保留。');
  if (!form || state?.status === 'unavailable') return h('p', {role:'status'}, '设置暂不可用。请确认 DSH 已加载支持设置的插件版本。');
  if (!ready || !draft) return h('p', {role:'status'}, '正在读取插件设置…');
  const disabled = saving || !state.writable;
  const errors = Object.fromEntries(FIELD_SPECS.flatMap(field => {
    const message = fieldValueError(field, draft.values[field.key]);
    return message ? [[field.key, message]] : [];
  }));
  const change = (key, value) => {
    setDraft(previous => ({...previous, values:{...previous.values, [key]:value}}));
    setNotice(''); setFailure('');
  };
  const cancel = () => {setDraft(initialDraft(state)); setNotice('已恢复最新已保存设置。'); setFailure('');};
  const restore = () => {setDraft(previous => ({...previous, values:valuesOf(state.base), reset:true})); setNotice('默认值已放入草稿；点击保存后生效。'); setFailure('');};
  const save = async event => {
    event?.preventDefault();
    if (disabled || !dirty || conflict || Object.keys(errors).length) return;
    const base = valuesOf(state.base);
    const ops = FIELD_SPECS.flatMap(field => {
      const value = draft.values[field.key];
      if (draft.reset && Object.is(value, base[field.key])) return [{op:'unset', path:[field.key]}];
      if (draft.reset || !Object.is(value, draft.baseline[field.key])) return [{op:'set', path:[field.key], value}];
      return [];
    });
    setSaving(true); setFailure(''); setNotice('');
    try {
      const accepted = await form.mutate(ops, draft.revision);
      if (!mounted.current) return;
      if (accepted) {setDraft(null); setNotice('设置已保存。执行限制从下一轮任务生效，权限与超时从下一次请求生效，缓存参数从下一次清理生效。');}
      else setFailure('保存未被接受，草稿已保留。配置可能已在其他窗口更新；请取消草稿并读取最新设置后重试。');
    } catch (error) {
      if (mounted.current) setFailure(`保存失败，草稿已保留：${error.message ?? String(error)}`);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  return h('section', {'aria-label':'DSH Unreal Bridge 设置', style:{color:color.text, maxWidth:760}},
    h('form', {onSubmit:save},
      h('p', {role:'status', style:{color:color.muted}}, saving ? '正在保存…' : conflict ? '配置已在其他窗口更新。当前草稿未覆盖，请取消草稿并读取最新设置。' : dirty ? '有未保存的设置。' : '当前设置已同步。'),
      !state.writable ? h('p', {role:'status'}, '当前配置不可写。') : null,
      ...SETTING_GROUPS.map(group => h('fieldset', {key:group.key, disabled, style:{margin:'16px 0', padding:16, border:`1px solid ${color.border}`, borderRadius:8}},
        h('legend', {style:{fontWeight:600}}, group.label),
        h('p', {style:{margin:'0 0 12px', fontSize:12, color:color.muted}}, group.hint),
        ...FIELD_SPECS.filter(field => field.group === group.key).map(field => h('div', {key:field.key, style:{marginTop:12}},
          h('label', {htmlFor:`unreal-setting-${field.key}`, style:{display:'flex', alignItems:'center', gap:12, justifyContent:'space-between', flexWrap:'wrap'}},
            h('span', null, field.label),
            field.type === 'boolean'
              ? h('input', {id:`unreal-setting-${field.key}`, name:field.key, type:'checkbox', checked:draft.values[field.key], disabled, onChange:event=>change(field.key,event.target.checked)})
              : h('span', null, h('input', {
                id:`unreal-setting-${field.key}`, name:field.key, type:'number',
                value:Number.isFinite(draft.values[field.key]) ? draft.values[field.key]/field.scale : '',
                min:field.min/field.scale, max:field.max/field.scale, step:field.scale === 1 ? 1 : 'any',
                disabled, 'aria-invalid':!!errors[field.key], 'aria-describedby':`unreal-setting-hint-${field.key}`,
                style:{width:120, padding:6, border:`1px solid ${color.border}`, borderRadius:5, background:color.surface, color:color.text},
                onChange:event=>{
                  change(field.key,parseFieldInput(field,event.target.value));
                },
              }), field.unit ? ` ${field.unit}` : ''),
          ),
          h('p', {id:`unreal-setting-hint-${field.key}`, style:{fontSize:12, color:errors[field.key]?color.error:color.muted, margin:'5px 0'}}, errors[field.key] ?? field.hint),
        )),
      )),
      failure ? h('p', {role:'alert', style:{color:color.error}}, failure) : null,
      notice ? h('p', {role:'status'}, notice) : null,
      h('div', {style:{display:'flex', gap:8, flexWrap:'wrap'}},
        h('button', {type:'submit', disabled:disabled||!dirty||conflict||Object.keys(errors).length>0, style:{...buttonStyle, fontWeight:600}}, '保存设置'),
        h('button', {type:'button', disabled:saving||!dirty, onClick:cancel, style:buttonStyle}, '取消草稿'),
        h('button', {type:'button', disabled, onClick:restore, style:buttonStyle}, '恢复默认'),
      ),
    ),
    Cache ? h(Cache) : null,
  );
}

function useSnapshot(source) {
  const store = useMemo(() => ({
    subscribe:listener=>source.subscribe(listener),
    getSnapshot:()=>source.getSnapshot(),
  }), [source]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Global Settings does not supply the plugin manager's owner `form` prop. */
export function SettingsSection({configForm, describe, renderCache}) {
  const state = useSnapshot(configForm);
  const mirror = useSnapshot(describe);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {mounted.current=true; return () => {mounted.current=false;};}, []);
  const mutate = useMemo(() => (ops, revision) => configForm.mutate(ops, revision), [configForm]);
  const error = retryError || mirror.error;
  const retry = async() => {
    setRetrying(true); setRetryError('');
    try {await describe.load();}
    catch (failure) {if(mounted.current)setRetryError(failure.message ?? String(failure));}
    finally {if(mounted.current)setRetrying(false);}
  };
  return h('section', {'aria-label':'Unreal Bridge', style:{color:color.text, maxWidth:760}},
    h('h2', {style:{margin:'0 0 8px', fontSize:18}}, 'Unreal Bridge'),
    h('p', {style:{color:color.muted}}, '设置 UE 执行权限、修复次数、任务预算和缓存保留。'),
    error ? h('div', null,
      h('p', {role:'alert', style:{color:color.error}}, `读取设置失败：${error}`),
      h('button', {type:'button', disabled:retrying, onClick:retry, style:buttonStyle}, retrying?'正在重试…':'重新读取'),
    ) : null,
    !error || state.status !== 'loading'
      ? h(SettingsPage, {form:{state,mutate}, renderCache})
      : null,
  );
}

/** Both entries use the same official form; editor RPC availability is unrelated. */
export function registerSettingsClient(ctx, options={}) {
  const row = ctx.slots.inject('plugins.row.config', () =>
    ctx.slots.register({
      name:'plugins.row.config', key:SETTINGS_SLOT_KEY,
      inject:()=>({renderCache:options.renderCache}),
    }, SettingsPage));
  const section = ctx.inject(['configForms'], child => {
    const configForm = child.configForms.get(SETTINGS_NAMESPACE);
    const describe = child.configForms.describe();
    child.slots.inject('settings.section', () => child.slots.register({
      name:'settings.section', id:SETTINGS_NAMESPACE, order:60,
      label:()=>'Unreal Bridge',
      inject:()=>({configForm,describe,renderCache:options.renderCache}),
    }, SettingsSection));
  });
  return async() => {row?.(); await section?.dispose();};
}
