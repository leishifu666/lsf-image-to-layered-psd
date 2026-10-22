// All ready tasks start together by default. Embed in functions.exec, or require from Node.js.
async function runElementPool(tasks, execute, options = {}) {
  if (!Array.isArray(tasks) || typeof execute !== 'function') {
    throw new TypeError('Expected tasks array and execute function');
  }
  const requested = options.concurrency ?? 'all';
  const all = requested === 'all' || requested === Infinity;
  if (!all && (!Number.isInteger(requested) || requested < 1)) {
    throw new RangeError('concurrency must be all, Infinity, or a positive integer');
  }
  const concurrency = all ? tasks.length : Math.min(requested, tasks.length);
  const ids = tasks.map(task => task.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error('Each element needs a unique, non-empty string id');
  }
  const results = new Array(tasks.length);
  let next = 0;
  let paused = false;
  let completed = 0;
  const reason = error => ({ name: error?.name || 'Error', message: String(error?.message || error) });
  async function worker() {
    while (!paused && next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      try {
        results[index] = { id: task.id, status: 'fulfilled', value: await execute(task) };
      } catch (error) {
        results[index] = { id: task.id, status: 'rejected', reason: reason(error) };
        if (options.shouldPause) {
          try { paused = Boolean(await options.shouldPause(error, task)) || paused; }
          catch (hookError) { paused = true; results[index].pauseHookError = reason(hookError); }
        }
      }
      completed++;
      if (options.onResult) {
        try { await options.onResult(results[index], task, { completed, total: tasks.length }); }
        catch (error) { results[index].saveHookError = reason(error); }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  for (let index = 0; index < tasks.length; index++) {
    if (!results[index]) results[index] = { id: tasks[index].id, status: 'deferred' };
  }
  return { results, completed, total: tasks.length, paused, concurrency, requestedConcurrency: all ? 'all' : requested };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { runElementPool };
