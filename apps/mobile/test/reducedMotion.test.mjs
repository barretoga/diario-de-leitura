import test from 'node:test';
import assert from 'node:assert/strict';
import * as motion from '../src/ui/reducedMotion.ts';

function harness() {
  let resolve, reject, listener;
  const current = new Promise((yes, no) => { resolve = yes; reject = no; });
  const values = [];
  let removed = false;
  return { values, resolve: value => resolve(value), reject: () => reject(new Error('Unavailable')),
    event: value => listener(value), removed: () => removed,
    options: { getCurrent: () => current, subscribe: callback => { listener = callback; return () => { removed = true; }; }, onChange: value => values.push(value) } };
}

test('motion stays disabled while the preference is unknown, then follows the system', async () => {
  assert.equal(typeof motion.observeReducedMotion, 'function');
  const h = harness();
  const cleanup = motion.observeReducedMotion(h.options);
  assert.deepEqual(h.values, [true]);
  h.resolve(false); await Promise.resolve();
  assert.deepEqual(h.values, [true, false]);
  h.event(true);
  assert.deepEqual(h.values, [true, false, true]);
  cleanup();
});
test('a newer system preference beats a delayed initial read', async () => {
  assert.equal(typeof motion.observeReducedMotion, 'function');
  const h = harness(); const cleanup = motion.observeReducedMotion(h.options);
  h.event(true); h.resolve(false); await Promise.resolve();
  assert.equal(h.values.at(-1), true);
  assert.equal(h.values.includes(false), false);
  cleanup();
});
test('unmount removes the listener and ignores pending preference results', async () => {
  assert.equal(typeof motion.observeReducedMotion, 'function');
  const h = harness(); const cleanup = motion.observeReducedMotion(h.options);
  cleanup(); h.resolve(false); h.event(false); await Promise.resolve();
  assert.equal(h.removed(), true); assert.deepEqual(h.values, [true]);
});
test('unavailable preference keeps motion disabled without an unhandled failure', async () => {
  assert.equal(typeof motion.observeReducedMotion, 'function');
  const h = harness(); const cleanup = motion.observeReducedMotion(h.options);
  h.reject(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(h.values, [true]); cleanup();
});
