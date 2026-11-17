import test from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator, TASK_STATUS, AGENT_ROLES } from '../orchestrator/orchestrator.mjs';

test('Orchestrator: respects dependencies and safe parallelism', async () => {
  const orchestrator = new Orchestrator({ maxParallel: 2 });

  const executionOrder = [];

  orchestrator.executor = async (task) => {
    executionOrder.push(`start:${task.id}`);
    await new Promise(r => setTimeout(r, 20));
    executionOrder.push(`end:${task.id}`);
    return { ok: true };
  };

  orchestrator.addTask({ id: 'task-1', description: 'Survey', role: AGENT_ROLES.SURVEYOR, files: ['src/a.js'] });
  orchestrator.addTask({ id: 'task-2', description: 'Implement A', deps: ['task-1'], files: ['src/a.js'] });
  orchestrator.addTask({ id: 'task-3', description: 'Implement B (independent)', deps: ['task-1'], files: ['src/b.js'] });

  const outcome = await orchestrator.run();
  assert.equal(outcome.success, true);
  assert.equal(outcome.tasks['task-1'].status, TASK_STATUS.COMPLETED);
  assert.equal(outcome.tasks['task-2'].status, TASK_STATUS.COMPLETED);
  assert.equal(outcome.tasks['task-3'].status, TASK_STATUS.COMPLETED);

  const end1Idx = executionOrder.indexOf('end:task-1');
  const start2Idx = executionOrder.indexOf('start:task-2');
  const start3Idx = executionOrder.indexOf('start:task-3');

  assert.ok(end1Idx < start2Idx, 'task-2 must start after task-1 ends');
  assert.ok(end1Idx < start3Idx, 'task-3 must start after task-1 ends');
});

test('Orchestrator: escalates model on repeated task failure', async () => {
  const models = ['tier-1-fast', 'tier-2-medium', 'tier-3-smart'];
  const orchestrator = new Orchestrator({ maxRetries: 2, escalationModels: models });

  let attempts = 0;
  orchestrator.executor = async (task) => {
    attempts++;
    if (attempts < 3) {
      throw new Error(`Attempt ${attempts} failed`);
    }
    return { ok: true, modelUsed: task.model };
  };

  orchestrator.addTask({ id: 'failing-task', description: 'Hard task' });

  const outcome = await orchestrator.run();
  assert.equal(outcome.success, true);
  assert.equal(attempts, 3);
  assert.equal(outcome.tasks['failing-task'].model, 'tier-3-smart');
});

test('Orchestrator: a task that never succeeds blocks its dependents and leaves independents running', async () => {
  const orchestrator = new Orchestrator({ maxRetries: 1, escalationModels: ['m1', 'm2'] });
  orchestrator.executor = async (task) => {
    if (task.id === 'broken') throw new Error('compile error: missing brace');
    return { ok: true };
  };
  orchestrator.addTask({ id: 'broken', description: 'Broken task', files: ['src/broken.js'] });
  orchestrator.addTask({ id: 'dependent', description: 'Needs broken', deps: ['broken'] });
  orchestrator.addTask({ id: 'independent', description: 'Free task', files: ['src/free.js'] });

  const outcome = await orchestrator.run();
  assert.equal(outcome.success, false);
  assert.equal(outcome.tasks.broken.status, TASK_STATUS.FAILED);
  assert.equal(outcome.tasks.dependent.status, TASK_STATUS.BLOCKED);
  assert.equal(outcome.tasks.independent.status, TASK_STATUS.COMPLETED,
    'a partial replan keeps independent work going');
});

test('Orchestrator: sequential batches are not parallelised when the gain is negative', () => {
  const orchestrator = new Orchestrator({ maxParallel: 3 });
  const single = orchestrator.parallelEstimate([{ role: 'implement' }]);
  assert.equal(single.parallel, false, 'one task is never parallel');
  const two = orchestrator.parallelEstimate([{ role: 'implement' }, { role: 'implement' }]);
  assert.equal(two.parallel, true, 'two equal 240ms tasks halve the wall time');
});

test('Orchestrator: two ready tasks naming one file never run concurrently', async () => {
  const orchestrator = new Orchestrator({ maxParallel: 3 });
  let active = 0;
  let peak = 0;
  const order = [];

  orchestrator.executor = async (task) => {
    active += 1;
    peak = Math.max(peak, active);
    order.push(`start:${task.id}`);
    await new Promise((r) => setTimeout(r, 20));
    order.push(`end:${task.id}`);
    active -= 1;
    return { ok: true };
  };

  // Both are ready before the first batch is committed and both name src/shared.js.
  orchestrator.addTask({ id: 'edit-a', description: 'Edit shared file', files: ['src/shared.js'] });
  orchestrator.addTask({ id: 'edit-b', description: 'Edit shared file too', files: ['src/shared.js'] });

  const outcome = await orchestrator.run();
  assert.equal(outcome.success, true);
  assert.equal(outcome.tasks['edit-a'].status, TASK_STATUS.COMPLETED);
  assert.equal(outcome.tasks['edit-b'].status, TASK_STATUS.COMPLETED);
  assert.equal(peak, 1, 'the file lock must be claimed before the batch is committed');
  assert.deepEqual(order, ['start:edit-a', 'end:edit-a', 'start:edit-b', 'end:edit-b'],
    'the conflicting task waits for a later batch instead of running alongside');
});

test('Orchestrator: a failure blocks dependents transitively, not only direct ones', async () => {
  const orchestrator = new Orchestrator({ maxRetries: 1, escalationModels: ['m1', 'm2'] });
  orchestrator.executor = async (task) => {
    if (task.id === 'root') throw new Error('root exploded');
    return { ok: true };
  };

  orchestrator.addTask({ id: 'root', description: 'Fails', files: ['src/root.js'] });
  orchestrator.addTask({ id: 'mid', description: 'Direct dependent', deps: ['root'] });
  orchestrator.addTask({ id: 'leaf', description: 'Second-order dependent', deps: ['mid'] });
  orchestrator.addTask({ id: 'free', description: 'Independent', files: ['src/free.js'] });

  const outcome = await orchestrator.run();
  assert.equal(outcome.tasks.root.status, TASK_STATUS.FAILED);
  assert.equal(outcome.tasks.mid.status, TASK_STATUS.BLOCKED);
  assert.equal(outcome.tasks.leaf.status, TASK_STATUS.BLOCKED,
    'a second-order dependent must not be left pending when the loop exits');
  assert.equal(outcome.tasks.free.status, TASK_STATUS.COMPLETED);
  assert.equal(outcome.blocked, 2);
});
