import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const sourceUrl = new URL('../src/shared-callback-batcher.ts', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const js = stripTypeScriptTypes(source, { mode: 'transform' });
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const { createCallbackBatcher } = mod;

const event = (id, overrides = {}) => ({
  source: 'background-task',
  id,
  label: `task ${id}`,
  status: 'completed',
  detailTool: 'bg_task_status',
  ...overrides,
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('busy timer flush retains and aggregates until explicit boundary steer', async () => {
  let ready = false;
  const sent = [];
  const batcher = createCallbackBatcher({ sendMessage: (...args) => sent.push(args) }, {
    windowMs: 5,
    canFlush: () => ready,
    deliverAs: 'steer',
  });
  batcher.enqueue(event('one'));
  await delay(20);
  assert.equal(sent.length, 0);
  assert.equal(batcher.pendingCount(), 1);
  assert.equal(await batcher.flush(), false);
  assert.equal(batcher.pendingCount(), 1);
  await delay(15);
  assert.equal(sent.length, 0, 'busy state must not poll repeatedly');
  batcher.enqueue(event('two'));
  await delay(15);
  assert.equal(sent.length, 0);
  assert.equal(batcher.pendingCount(), 2);
  ready = true;
  assert.equal(await batcher.flush(), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0][0].content, /2 background completions are ready/);
  assert.deepEqual(sent[0][1], { deliverAs: 'steer', triggerTurn: true });
});

test('rechecks durable delivery immediately before sending and drops read items', async () => {
  let read = false;
  const sent = [];
  const delivered = [];
  const batcher = createCallbackBatcher({ sendMessage: (...args) => sent.push(args) }, { windowMs: 10_000 });
  batcher.enqueue(event('read-later', { isDelivered: () => read, onDelivered: () => delivered.push('read') }));
  batcher.enqueue(event('still-new', { onDelivered: () => delivered.push('new') }));
  read = true;
  assert.equal(await batcher.flush(), true);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0][0].content, /read-later/);
  assert.match(sent[0][0].content, /still-new/);
  assert.deepEqual(delivered, ['new']);
});

test('defaults ordinary batches to followUp', async () => {
  const sent = [];
  const batcher = createCallbackBatcher({ sendMessage: (...args) => sent.push(args) }, { windowMs: 10_000 });
  batcher.enqueue(event('default'));
  await batcher.flush();
  assert.deepEqual(sent[0][1], { deliverAs: 'followUp', triggerTurn: true });
});

test('cancel clears pending work and prevents timer delivery', async () => {
  const sent = [];
  const batcher = createCallbackBatcher({ sendMessage: (...args) => sent.push(args) }, { windowMs: 5 });
  batcher.enqueue(event('cancelled'));
  batcher.cancel();
  await delay(20);
  assert.equal(sent.length, 0);
  assert.equal(batcher.pendingCount(), 0);
});

test('failed send retains batch for explicit retry and delays onDelivered', async () => {
  let attempts = 0;
  let delivered = 0;
  const batcher = createCallbackBatcher({
    sendMessage() {
      attempts++;
      if (attempts === 1) throw new Error('queue unavailable');
    },
  }, { windowMs: 10_000, retryMs: 10_000 });
  batcher.enqueue(event('retry', { onDelivered: () => delivered++ }));
  assert.equal(await batcher.flush(), false);
  assert.equal(batcher.pendingCount(), 1);
  assert.equal(delivered, 0);
  assert.equal(await batcher.flush(), true);
  assert.equal(attempts, 2);
  assert.equal(delivered, 1);
  assert.equal(batcher.pendingCount(), 0);
});

test('callback false is not queued or sent', async () => {
  const sent = [];
  const batcher = createCallbackBatcher({ sendMessage: (...args) => sent.push(args) }, { windowMs: 0 });
  assert.equal(batcher.enqueue(event('disabled', { callback: false })), false);
  assert.equal(await batcher.flush(), true);
  assert.equal(sent.length, 0);
});

test('suppression is rechecked before send and reported without host delivery', async () => {
  let reason;
  const sent = [];
  const batcher = createCallbackBatcher({ sendMessage: (...args) => sent.push(args) }, { windowMs: 10_000 });
  batcher.enqueue(event('suppressed', {
    getSuppressionReason: () => 'already acknowledged',
    onSuppressed: (value) => { reason = value; },
  }));
  assert.equal(await batcher.flush(), true);
  assert.equal(reason, 'already acknowledged');
  assert.equal(sent.length, 0);
});
