import Schema from '@deepseek-ai/schemastery';
import {FIELD_SPECS, DEFAULTS} from './settings-spec.mjs';

export {FIELD_SPECS, DEFAULTS} from './settings-spec.mjs';

const fields = Object.fromEntries(FIELD_SPECS.map(field => [
  field.key,
  (field.type === 'boolean' ? Schema.boolean() : Schema.number().step(1).min(field.min).max(field.max))
    .default(field.defaultValue).description(field.hint).volatile(),
]));

// Only volatile fields appear in DSH's official settings form. Transport identity
// and desktop-input policy retain their existing plugin lifecycle semantics.
export const Config = Schema.object({
  port: Schema.number().step(1).min(0).max(65535).default(17891),
  stateDir: Schema.string().min(1),
  allowMcpDesktopInput: Schema.boolean().default(false),
  ...fields,
});

const unwrap = value => value && typeof value.get === 'function' ? value.get() : value;

/** Keep Loader-owned volatile references live without remounting the bridge. */
export function createConfigState(raw = {}) {
  const normalized = Config(Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, unwrap(value)])));
  const current = {};
  for (const key of Object.keys(Config.dict)) {
    const fallback = unwrap(normalized[key]);
    const reference = raw[key] && typeof raw[key].get === 'function' ? raw[key] : null;
    Object.defineProperty(current, key, {
      enumerable: true,
      get: () => reference ? reference.get() : fallback,
    });
  }
  Object.freeze(current);
  return Object.freeze({
    current,
    snapshot: () => Object.freeze(Object.fromEntries(Object.entries(current).filter(([, value]) => value !== undefined))),
  });
}

/** Use the official profile editor; no private settings file or write RPC. */
export function registerSettings(ctx) {
  return ctx.inject?.(['settings'], child => {
    child.effect(() => child.settings.configure({auto:false}, ctx.fiber));
  });
}
