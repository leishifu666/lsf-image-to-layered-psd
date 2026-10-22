const test = require('node:test');
const assert = require('node:assert/strict');
const { runElementPool } = require('../scripts/element-pool.js');

test('all ready jobs start without an artificial concurrency cap', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const jobs = Array.from({ length: 9 }, (_, i) => ({ id: 'E' + i }));
  const pending = runElementPool(jobs, async job => { started.push(job.id); await gate; return job.id; });
  assert.equal(started.length, 9);
  release();
  const result = await pending;
  assert.deepEqual(result.results.map(x => x.id), jobs.map(x => x.id));
  assert.equal(result.requestedConcurrency, 'all');
  assert.equal(result.completed, 9);
});

test('one failure and a save-hook failure preserve other results', async () => {
  const result = await runElementPool([{ id: 'first' }, { id: 'bad' }, { id: 'last' }], async job => {
    if (job.id === 'bad') throw Error('provider rejected this job');
    return { asset: job.id };
  }, { onResult(item) { if (item.id === 'first') throw Error('save unavailable'); } });
  assert.equal(result.results[0].value.asset, 'first');
  assert.match(result.results[0].saveHookError.message, /save unavailable/);
  assert.equal(result.results[1].status, 'rejected');
  assert.equal(result.results[2].status, 'fulfilled');
});

test('an explicit cap and pause preserve never-submitted jobs', async () => {
  const result = await runElementPool([{ id: 'bad' }, { id: 'later' }], async () => { throw Error('rate limit'); },
    { concurrency: 1, shouldPause: () => true });
  assert.equal(result.paused, true);
  assert.equal(result.completed, 1);
  assert.equal(result.results[1].status, 'deferred');
});

test('duplicate IDs and invalid caps are rejected', async () => {
  await assert.rejects(runElementPool([{ id: 'same' }, { id: 'same' }], async () => 1), /unique/);
  await assert.rejects(runElementPool([], async () => 1, { concurrency: 0 }), /positive integer/);
  assert.equal((await runElementPool([], async () => 1)).completed, 0);
});
