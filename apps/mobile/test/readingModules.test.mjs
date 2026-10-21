import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const mobileRequire = createRequire(new URL('../package.json', import.meta.url));
const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
const metroRuntime = readFileSync(resolve(dirname(expoRequire.resolve('@expo/cli/package.json')), 'build/metro-require/require.js'), 'utf8');
const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

// Use Expo's installed Metro loader: Node ESM permits this cycle silently and
// cannot reproduce the warning seen on the device. Only console is captured.
function readingModules(entry) {
  const warnings = [];
  const context = vm.createContext({__DEV__: true, __METRO_GLOBAL_PREFIX__: '', console: {warn: value => warnings.push(value)}});
  context.global = context;
  vm.runInContext(metroRuntime, context);
  const ids = new Map();
  function load(file) {
    if (!ids.has(file)) {
      const id = ids.size; ids.set(file, id);
      const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
      const factory = vm.runInContext(`(function(global, require, importDefault, importAll, module, exports) {${compiled}\n})`, context);
      context.__d((global, _require, importDefault, importAll, module, exports) => {
        const requireLocal = specifier => {
          assert.ok(specifier.startsWith('.'), 'reading helpers must not load native dependencies');
          const dependency = resolve(dirname(file), specifier);
          return load(extname(dependency) ? dependency : dependency + '.ts');
        };
        factory(global, requireLocal, importDefault, importAll, module, exports);
      }, id, [], relative(sourceRoot, file));
    }
    return context.__r(ids.get(file));
  }
  load(resolve(sourceRoot, entry));
  return {warnings, source: load(resolve(sourceRoot, 'logs/source.ts')), stats: load(resolve(sourceRoot, 'statistics/readingStats.ts'))};
}

test('reading presentation and statistics load through Metro in either order without require cycles', () => {
  for (const entry of ['logs/source.ts', 'statistics/readingStats.ts']) {
    const {warnings, source, stats} = readingModules(entry);
    assert.deepEqual(warnings, [], entry);
    assert.equal(source.logPresentation({id: 'manual-log', minutes: 90}).duration, '1h 30min');
    assert.equal(stats.formatMinutes(60), '1h');
    assert.equal(stats.formatMinutes(59.6), '1h');
    const id = 'koreader-' + 'a'.repeat(64);
    assert.equal(source.logPresentation({id, minutes: 0}).duration, 'Menos de 1 min');
    assert.equal(stats.isReading({id, minutes: 0, progress_value: null, progress_unit: null}), true);
  }
});
