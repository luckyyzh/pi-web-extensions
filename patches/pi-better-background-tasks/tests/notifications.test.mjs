import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

let sequence = 0;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
function loadSource(source, dependencies = {}) {
  const js = stripTypeScriptTypes(source).replace(/from\s+"([^"]+)"/g, (_, specifier) => {
    if (specifier.startsWith('node:')) return `from ${JSON.stringify(specifier)}`;
    assert.ok(dependencies[specifier], `missing test dependency: ${specifier}`);
    return `from ${JSON.stringify(dependencies[specifier])}`;
  });
  return import(dataUrl(js));
}
const readSource = (name) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
const stubs = (names) => names.split(' ').map((name) => `export const ${name} = () => { throw new Error('Unexpected runtime call: ${name}'); };`).join('\n');

// Real patched tools/runtime/batcher, with only process, filesystem and UI adapters
// replaced. No subprocess, real task registry, session, network or callback is used.
async function fixture(t, toolsSource = readSource('tools')) {
  const key = `background-notifications-test-${++sequence}`;
  const state = { metas: new Map(), logs: new Map(), resumed: [], writes: [], maintenance: 0 };
  globalThis[key] = state;
  t.after(() => { delete globalThis[key]; });
  const prelude = `const s = globalThis[${JSON.stringify(key)}];\n`;
  const registry = dataUrl(prelude + `
    export const readMeta = id => structuredClone(s.metas.get(id));
    export const writeMeta = meta => { s.writes.push(meta.id); s.metas.set(meta.id, structuredClone(meta)); };
    export const listMetas = () => [...s.metas.values()].map(x => structuredClone(x));
    export const listMetasForOrigin = o => listMetas().filter(m => m.callbackOrigin?.sessionId === o.sessionId);
    export const listActiveMetasForOrigin = o => listMetasForOrigin(o).filter(m => m.status === 'running');
    ${stubs('ensureTaskDir logPathFor nextTaskId sandboxProfilePathFor')}
  `);
  const batcherUrl = dataUrl(stripTypeScriptTypes(readSource('shared-callback-batcher')));
  const types = dataUrl("export const isTerminalStatus = status => status !== 'running';");
  const logs = dataUrl(prelude + `
    export const readLog = path => { const text = s.logs.get(path); if (text instanceof Error) throw text; return { text: text || '', truncated: false }; };
    ${stubs('appendLine appendTaskOutput appendWatchResult retainLogTail resolveMaxLogBytes')}
  `);
  const sandbox = dataUrl(`export class ForegroundSandboxBlockedError extends Error {}\n${stubs('confineCommandSpec resolveForegroundSandboxPlan')}`);
  const runtimeDependencies = {
    './registry.js': registry, './types.js': types, './logs.js': logs,
    './shared-callback-batcher.js': batcherUrl, './sandbox.js': sandbox,
    './conditions.js': dataUrl(stubs('evaluateCondition')),
    './process.js': dataUrl(stubs('processExists runCommandOnce spawnCommand stopProcessGroup')),
    './process-identity.js': dataUrl(stubs('currentProcessStartToken readProcessStartToken')),
    './remote-task-preset.js': dataUrl(`export const DEFAULT_TMUX_BOOTSTRAP_TIMEOUT_MS = 1000; ${stubs('expandSshRemoteTaskPreset')}`),
  };
  const runtime = await loadSource(readSource('runtime'), runtimeDependencies);
  const runtimeUrl = dataUrl(prelude + `
    export const resumeRunningTask = (_pi, meta) => { s.resumed.push(meta.id); };
    ${stubs('spawnTask startWatchTask stopTask')}
  `);
  const { registerTools } = await loadSource(toolsSource, {
    './registry.js': registry, './types.js': types, './logs.js': logs,
    './shared-callback-batcher.js': batcherUrl, './sandbox.js': sandbox, './runtime.js': runtimeUrl,
    './navigator-provider.js': dataUrl('export const refreshBackgroundTasksNavigator = () => {};'),
    './maintenance.js': dataUrl(prelude + 'export const runTaskMaintenance = () => { s.maintenance++; };'),
    typebox: dataUrl('export const Type = new Proxy({}, { get: (_, name) => (...args) => ({ name, args }) });'),
  });
  const hooks = new Map(), tools = new Map(), messages = [];
  const pi = {
    on(event, handler) { const handlers = hooks.get(event) ?? []; handlers.push(handler); hooks.set(event, handlers); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendMessage(message, options) { messages.push({ message, options }); },
  };
  const context = { cwd: '/project', sessionManager: { getSessionId: () => 'owner' }, isIdle: () => false, hasUI: false };
  const origin = { cwd: '/project', sessionId: 'owner' };
  registerTools(pi);
  const emit = async (event, value = {}) => { for (const handler of hooks.get(event) ?? []) await handler(value, context); };
  const { getCallbackBatcher } = await import(batcherUrl);
  const batcher = getCallbackBatcher(pi);
  t.after(() => batcher.cancel());
  const add = (id, changes = {}) => {
    const meta = { id, kind: 'process', status: 'succeeded', startedAt: 1, endedAt: 2, lastExitCode: 0, cwd: '/project', logPath: `${id}.log`, callbackOrigin: origin, ...changes };
    state.metas.set(id, structuredClone(meta));
    return meta;
  };
  const terminal = (id) => runtime.resumeRunningTask(pi, structuredClone(state.metas.get(id)), () => origin);
  const call = async (name, args, callId = `call-${++sequence}`) => {
    const result = await tools.get(name).execute(callId, args, undefined, undefined, context);
    return { role: 'toolResult', toolName: name, toolCallId: callId, isError: false, ...result };
  };
  const endTurn = (toolResults = [], stopReason = 'toolUse') => emit('turn_end', { message: { role: 'assistant', stopReason }, toolResults });
  await emit('session_start');
  return { state, tools, messages, context, origin, batcher, add, terminal, call, emit, endTurn };
}

test('busy completions merge at a safe turn boundary; only already-inspected terminal result is dropped', async (t) => {
  const f = await fixture(t);
  for (const id of ['read', 'unread-1', 'unread-2']) { f.add(id); f.terminal(id); await f.batcher.flush(); }
  assert.equal(f.messages.length, 0);
  const result = await f.call('bg_task_status', { id: 'read' });
  assert.equal(f.state.metas.get('read').callbackSuppressedAt, undefined, 'no ack before finalized result');
  await f.endTurn([result]);
  assert.ok(f.state.metas.get('read').callbackSuppressedAt);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].options.deliverAs, 'steer');
  assert.match(f.messages[0].message.content, /2 background completions/);
  assert.doesNotMatch(f.messages[0].message.content, /id=read\b/);
  await f.endTurn();
  assert.equal(f.messages.length, 1);
});

test('direct status and both action wrappers acknowledge successes and failures, including verbose results', async (t) => {
  const f = await fixture(t);
  for (const [i, name] of ['bg_task_status', 'bg_task', 'bg_status'].entries()) {
    const id = `status-${i}`;
    f.add(id, { status: 'failed', lastExitCode: 1 });
    const result = await f.call(name, { id, action: 'status', verbose: true });
    await f.endTurn([result]);
    assert.match(f.state.metas.get(id).callbackSuppressedReason, /inspected/);
  }
});

test('running reads, list/UI lookup and another owning session do not acknowledge', async (t) => {
  const f = await fixture(t);
  f.add('running', { status: 'running', endedAt: undefined });
  const runningResult = await f.call('bg_task_status', { id: 'running' });
  f.state.metas.get('running').status = 'succeeded';
  f.state.metas.get('running').endedAt = 2;
  f.add('listed');
  f.add('other', { callbackOrigin: { ...f.origin, sessionId: 'other' } });
  const listed = await f.call('bg_task_list', {});
  const other = await f.call('bg_task_status', { id: 'other' });
  await f.endTurn([runningResult, listed, other]);
  for (const id of ['running', 'listed', 'other']) assert.equal(f.state.metas.get(id).callbackSuppressedAt, undefined);
});

test('failed/replaced results and aborted turns do not consume or wake the session', async (t) => {
  const f = await fixture(t);
  f.add('failed-result');
  f.add('replaced');
  const failed = await f.call('bg_task_status', { id: 'failed-result' });
  const replaced = await f.call('bg_task_status', { id: 'replaced' });
  await f.endTurn([{ ...failed, isError: true }, { ...replaced, content: [{ type: 'text', text: 'blocked' }] }]);
  assert.equal(f.state.writes.length, 0);
  f.add('aborted'); f.terminal('aborted');
  const result = await f.call('bg_task_status', { id: 'aborted' });
  await f.endTurn([result], 'aborted');
  f.context.isIdle = () => true;
  await f.emit('agent_settled');
  assert.equal(f.messages.length, 0);
  assert.equal(f.state.metas.get('aborted').callbackSuppressedAt, undefined);
  await f.emit('agent_start');
  await f.endTurn();
  assert.equal(f.messages.length, 1, 'pending completion survives until a subsequent run');
});

test('log reads acknowledge only readable nonempty terminal evidence, including wrappers', async (t) => {
  const f = await fixture(t);
  for (const [i, name] of ['bg_task_log', 'bg_task', 'bg_status'].entries()) {
    const id = `log-${i}`;
    f.add(id, { status: 'failed', lastExitCode: 3 });
    f.state.logs.set(`${id}.log`, 'some output');
    const result = await f.call(name, { id, action: 'log' });
    assert.match(result.content[0].text, /failed; exit=3/);
    await f.endTurn([result]);
    assert.ok(f.state.metas.get(id).callbackSuppressedAt);
  }
  f.add('empty'); f.add('unreadable');
  f.state.logs.set('unreadable.log', new Error('permission denied'));
  await assert.rejects(f.call('bg_task_log', { id: 'unreadable' }), /permission denied/);
  await f.endTurn([await f.call('bg_task_log', { id: 'empty' })]);
  assert.equal(f.state.metas.get('empty').callbackSuppressedAt, undefined);
  assert.equal(f.state.metas.get('unreadable').callbackSuppressedAt, undefined);
});

test('runtime skips disabled, cancelled, cleared and inspected tasks; late clear is checked again at flush', async (t) => {
  const f = await fixture(t);
  for (const [id, change] of Object.entries({ disabled: { callback: false }, cancelled: { status: 'cancelled' }, cleared: { dismissedAt: 1 }, inspected: { callbackSuppressedAt: 1 }, sent: { callbackSentAt: 1 } })) {
    f.add(id, change); f.terminal(id);
  }
  f.add('clear-after-enqueue'); f.terminal('clear-after-enqueue');
  f.state.metas.get('clear-after-enqueue').dismissedAt = 1;
  await f.endTurn();
  assert.equal(f.messages.length, 0);
});

test('Windows restore filters dismissed/inspected tasks; shutdown clears outbox without marking delivered', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  f.add('cleared', { dismissedAt: 1 });
  f.add('inspected', { callbackSuppressedAt: 1 });
  f.add('pending');
  await f.emit('session_start');
  assert.deepEqual(f.state.resumed, ['pending']);
  f.terminal('pending');
  await f.emit('session_shutdown');
  f.context.isIdle = () => true;
  await f.batcher.flush();
  assert.equal(f.messages.length, 0);
  assert.equal(f.state.metas.get('pending').callbackSentAt, undefined);
});

test('idle completion can flush immediately and a vetoed before-switch does not strand the outbox', async (t) => {
  const f = await fixture(t);
  f.add('idle'); f.terminal('idle');
  await f.emit('session_before_switch'); // Another extension may cancel replacement.
  f.context.isIdle = () => true;
  await f.batcher.flush();
  assert.equal(f.messages.length, 1);
});
