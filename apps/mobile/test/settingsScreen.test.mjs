import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Execute the real screen, ListRow, Section and icons. Only native host views
// and the font renderer are substituted because Node cannot mount Android UI.
const require = createRequire(import.meta.url);
const cache = new Map();
function loadUI(path) {
  if (cache.has(path)) return cache.get(path).exports;
  const module = { exports: {} }; cache.set(path, module);
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const localRequire = specifier => {
    if (specifier === 'react-native') return {
      View: 'View', Text: 'Text', Pressable: 'Pressable',
      StyleSheet: { create: value => value, hairlineWidth: 1 },
    };
    if (specifier === '@react-native-vector-icons/ionicons') return { Ionicons: 'Ionicons' };
    if (!specifier.startsWith('.')) return require(specifier);
    const base = resolve(dirname(path), specifier);
    const target = [base, base + '.tsx', base + '.ts'].find(existsSync);
    assert.ok(target, `Missing UI import: ${specifier}`);
    return loadUI(target);
  };
  runInNewContext(compiled, { module, exports: module.exports, require: localRequire }, { filename: path });
  return module.exports;
}
function nativeNodes(element) {
  if (!element || typeof element !== 'object') return [];
  if (Array.isArray(element)) return element.flatMap(nativeNodes);
  if (typeof element.type === 'function') return nativeNodes(element.type(element.props));
  return [element, ...nativeNodes(element.props?.children)];
}
const { SettingsScreen } = loadUI(fileURLToPath(new URL('../src/settings/SettingsScreen.tsx', import.meta.url)));

test('settings exposes an accessible KOReader action that opens the association flow', () => {
  const opened = [];
  const tree = SettingsScreen({ syncSummary: 'Em dia', onSync: () => opened.push('sync'),
    onBackup: () => opened.push('backup'), onKindle: () => opened.push('kindle'), onKOReader: () => opened.push('koreader') });
  const buttons = nativeNodes(tree).filter(node => node.type === 'Pressable' && node.props.accessibilityRole === 'button');
  const action = buttons.find(node => node.props.accessibilityLabel.startsWith('KOReader'));
  assert.ok(action, 'KOReader must be reachable from Settings');
  action.props.onPress(); assert.deepEqual(opened, ['koreader']);
  for (const label of ['Sincronização', 'Backup e restauração', 'Anotações Kindle']) {
    buttons.find(node => node.props.accessibilityLabel.startsWith(label)).props.onPress();
  }
  assert.deepEqual(opened, ['koreader', 'sync', 'backup', 'kindle']);
});

// SyncSettings uses hooks and Alert: run it with a tiny hook runtime and
// substitute only the native host views, Alert and the animated Button/Disclosure shells.
import { MIGRATED, NEEDS_IDENTITY, OTHER_SERVER, SAME_URL, migrateServer } from '../src/sync/transport.ts';
function syncSettingsHarness() {
  const slots = []; let index = 0; const alerts = [];
  const hooks = {
    useState: initial => { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useEffect: () => {},
  };
  const own = new Map();
  function load(path) {
    if (own.has(path)) return own.get(path).exports;
    const module = { exports: {} }; own.set(path, module);
    const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const localRequire = specifier => {
      if (specifier === 'react') return hooks;
      if (specifier === 'react-native') return {
        View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput',
        StyleSheet: { create: value => value, hairlineWidth: 1 },
        Alert: { alert: (title, message) => alerts.push({ title, message }) },
      };
      if (specifier === '../ui/Button') return { Button: ({ label, onPress, disabled }) => ({ type: 'Pressable', props: { accessibilityRole: 'button', accessibilityLabel: label, onPress, disabled } }) };
      if (specifier === '../ui/Disclosure') return { Disclosure: ({ children }) => ({ type: 'View', props: { children } }) };
      if (!specifier.startsWith('.')) return require(specifier);
      const base = resolve(dirname(path), specifier);
      const target = [base, base + '.tsx', base + '.ts'].find(existsSync);
      assert.ok(target, `Missing UI import: ${specifier}`);
      return load(target);
    };
    runInNewContext(compiled, { module, exports: module.exports, require: localRequire, Error }, { filename: path });
    return module.exports;
  }
  const { SyncSettings } = load(fileURLToPath(new URL('../src/sync/SyncSettings.tsx', import.meta.url)));
  return { alerts, render: sync => { index = 0; return nativeNodes(SyncSettings({ sync, editIssue: () => {}, books: [] })); } };
}
const baseSync = settings => ({ settings, issues: [], pending: 0, status: { phase: 'idle', message: null }, configuring: false,
  configure: async () => {}, sync: () => {}, pause: async () => {}, resolve: async () => {} });
const byLabel = (nodes, label) => nodes.find(node => node.props?.accessibilityLabel === label);
const tick = () => new Promise(resolveTick => setImmediate(resolveTick));

test('"Migrar servidor" is offered only once a server URL is bound', () => {
  const { render } = syncSettingsHarness();
  const unbound = render(baseSync({ url: '', paused: false, cursor: 0, lastSuccess: null, fatal: null, serverId: null }));
  assert.equal(byLabel(unbound, 'Migrar servidor'), undefined);
  assert.equal(byLabel(unbound, 'Novo endereço do servidor'), undefined);
  const bound = syncSettingsHarness().render(baseSync({ url: 'https://old.example', paused: false, cursor: 3, lastSuccess: null, fatal: null, serverId: 'server-a' }));
  assert.ok(byLabel(bound, 'Migrar servidor'));
  assert.ok(byLabel(bound, 'Novo endereço do servidor'));
  assert.equal(byLabel(bound, 'URL do servidor').props.editable, false);
});

test('migration flow from the screen: accepted, other server, missing identity, same url and network error', async () => {
  const cases = [
    { input: 'https://new.example', serverId: 'server-a', remote: 'server-a', expect: MIGRATED, migrated: true },
    { input: 'https://new.example', serverId: 'server-a', remote: 'server-b', expect: OTHER_SERVER },
    { input: 'https://new.example', serverId: null, remote: 'server-a', expect: NEEDS_IDENTITY },
    { input: 'https://Old.Example/', serverId: 'server-a', remote: 'server-a', expect: SAME_URL },
    { input: 'https://new.example', serverId: 'server-a', offline: true, expect: /Sem conexão/ },
  ];
  for (const item of cases) {
    const { render, alerts } = syncSettingsHarness();
    const settings = { url: 'https://old.example', paused: false, cursor: 3, lastSuccess: null, fatal: null, serverId: item.serverId };
    const migrations = [];
    const store = { settings: async () => settings, migrate: async (url, id) => { migrations.push([url, id]); } };
    const fetcher = item.offline ? async () => { throw new TypeError('offline'); }
      : async () => new Response(JSON.stringify({ protocolVersion: 1, serverId: item.remote }), { status: 200 });
    const sync = { ...baseSync(settings), migrate: async input => { await migrateServer(store, input, 'x'.repeat(32), { fetcher }); return MIGRATED; } };
    byLabel(render(sync), 'Novo endereço do servidor').props.onChangeText(item.input);
    byLabel(render(sync), 'Migrar servidor').props.onPress();
    await tick(); await tick();
    assert.equal(alerts.length, 1, `one alert for ${item.input}`);
    if (item.expect instanceof RegExp) assert.match(alerts[0].message, item.expect); else assert.equal(alerts[0].message, item.expect);
    assert.deepEqual(migrations, item.migrated ? [['https://new.example', 'server-a']] : []);
  }
});
