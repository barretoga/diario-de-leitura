import test from 'node:test';
import assert from 'node:assert/strict';
import * as operations from '../src/navigation/operationLock.ts';

test('navigation stays locked until a deferred operation and its completion finish', async () => {
  let finish;
  const deferred = new Promise(resolve => { finish = resolve; });
  const lock = { current: false };
  let navigationBlocked = false;
  let completed = false;
  const changes = [];
  const run = operations.runWithNavigationLock;
  assert.equal(typeof run, 'function');
  const pending = run(lock, busy => { navigationBlocked = busy; changes.push(busy); }, async () => {
    await deferred;
    assert.equal(navigationBlocked, true);
    completed = true;
  });
  assert.equal(navigationBlocked, true);
  await run(lock, () => assert.fail('duplicate operation'), async () => assert.fail('duplicate operation'));
  assert.equal(completed, false);
  finish();
  await pending;
  assert.equal(completed, true);
  assert.equal(navigationBlocked, false);
  assert.deepEqual(changes, [true, false]);
});

test('failed operations release navigation so the user can retry or leave', async () => {
  const lock = { current: false };
  const changes = [];
  assert.equal(typeof operations.runWithNavigationLock, 'function');
  await assert.rejects(operations.runWithNavigationLock(lock, busy => changes.push(busy), async () => { throw new Error('Failed'); }), /Failed/);
  assert.equal(lock.current, false);
  assert.deepEqual(changes, [true, false]);
});
