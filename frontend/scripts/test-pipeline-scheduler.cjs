// Exercise the real admission functions without a browser or backend.
// Run: node scripts/test-pipeline-scheduler.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { spawnSync } = require("node:child_process");

// Check both the new default (3) and the opt-in rollback configuration (2).
if (!process.env.PIPELINE_TEST_SLOTS) {
  for (const limit of [2, 3]) {
    const result = spawnSync(process.execPath, [__filename], {
      stdio: "inherit", env: { ...process.env, PIPELINE_TEST_SLOTS: String(limit) },
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
const slots = Number(process.env.PIPELINE_TEST_SLOTS);
const ids = ["a", "b", "c", "d", "e"].slice(0, slots + 2);
const waitingId = ids[slots];
const extraId = ids[slots + 1];

const source = fs.readFileSync(path.join(__dirname, "../src/stores/pipeline-store.ts"), "utf8");
const ast = ts.createSourceFile("pipeline-store.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "MAX_ACTIVE_PIPELINES", "queue", "occupiedSlots", "priorityPipelines",
  "enqueue", "enqueuePrep", "enqueueFront", "releaseSlot", "processQueue", "launchEntry",
  "emptySteps", "pipelineResumeStep",
]);
const selected = ast.statements.filter((node) =>
  ts.isFunctionDeclaration(node) ? names.has(node.name?.text) :
  ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => names.has(d.name.getText(ast)))
).map((node) => node.getText(ast)).join("\n");
const launches = [];
const pipelines = ids.slice(0, slots + 1).map((id) => ({ id }));
const context = vm.createContext({
  process: { env: slots === 2 ? { NEXT_PUBLIC_MAX_ACTIVE_PIPELINES: "2" } : {} },
  usePipelineStore: { getState: () => ({ pipelines }) },
  runPrep: (id, step) => { launches.push([id, step, "prep"]); return new Promise(() => {}); },
  runPipeline: (id, step) => { launches.push([id, step, "heavy"]); return new Promise(() => {}); },
});
vm.runInContext(ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
const run = (code) => vm.runInContext(code, context);

for (const id of ids.slice(0, slots + 1)) run(`enqueue(${JSON.stringify(id)}, 0)`);
assert.deepEqual(launches, ids.slice(0, slots + 1).map((id) => [id, 0, "prep"]));
assert.equal(run("occupiedSlots.size"), 0);
// Only the configured number of videos may enter OCR and later processing.
for (const id of ids.slice(0, slots + 1)) run(`enqueue(${JSON.stringify(id)}, 4)`);
assert.deepEqual(launches.slice(-slots), ids.slice(0, slots).map((id) => [id, 4, "heavy"]));
assert.equal(run("occupiedSlots.size"), slots);
assert.equal(run('queue[0].id'), waitingId);
// Additional videos can prepare while all processing slots are busy.
pipelines.push({ id: extraId });
for (const step of [0, 2, 3]) run(`enqueue(${JSON.stringify(extraId)}, ${step})`);
assert.deepEqual(launches.slice(-3), [0, 2, 3].map((step) => [extraId, step, "prep"]));
assert.equal(run("occupiedSlots.size"), slots);
// Prep watermark selection is unrestricted even with step index 4.
run(`enqueuePrep(${JSON.stringify(extraId)}, 4)`);
assert.deepEqual(launches.at(-1), [extraId, 4, "prep"]);
run(`enqueue(${JSON.stringify(extraId)}, 4); enqueue(${JSON.stringify(extraId)}, 4)`);
assert.equal(run(`queue.filter(q => q.id === ${JSON.stringify(extraId)}).length`), 1);
// An admitted pipeline at a later manual gate retains its slot. Resume
// reuses that slot and never exceeds the configured capacity.
run('enqueueFront("b", 8)');
assert.deepEqual(launches.at(-1), ["b", 8, "heavy"]);
assert.equal(run("occupiedSlots.size"), slots);
run('releaseSlot("a")');
assert.deepEqual(launches.at(-1), [waitingId, 4, "heavy"]);
assert.equal(run("occupiedSlots.size"), slots);
run('releaseSlot("b")');
assert.deepEqual(launches.at(-1), [extraId, 4, "heavy"]);
assert.equal(run("occupiedSlots.size"), slots);
// Exercise the real pause/resume store actions, not a simulated releaseSlot.
const actions = {};
function findActions(node) {
  if (ts.isPropertyAssignment(node) && ["pausePipeline", "resumePipeline"].includes(node.name.getText(ast))) {
    actions[node.name.getText(ast)] = node.initializer.getText(ast);
  }
  ts.forEachChild(node, findActions);
}
findActions(ast);
Object.assign(context, {
  get: () => ({ pipelines }),
  set: (update) => {
    const next = update({ pipelines });
    pipelines.splice(0, pipelines.length, ...next.pipelines);
  },
  patch: (id, update) => Object.assign(pipelines.find((p) => p.id === id), update),
  bumpGen() {}, abortDelogo() {}, appendLog() {}, resolvePauseWaiters() {},
  runGen: new Map(), refreshStepTimings: async () => [],
  reportPipeline() {}, schedulePersist() {},
  STEP_STAGE: { translating: 7 }, STEPS: Array.from({ length: 13 }, () => ({ label: "test" })),
  fetch: async () => ({ ok: true }),
});
run(ts.transpileModule(`const pauseAction = ${actions.pausePipeline}; const resumeAction = ${actions.resumePipeline};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText);
async function testPauseResume() {
  run("queue = []; occupiedSlots.clear(); priorityPipelines.clear()");
  pipelines.splice(0, pipelines.length, ...ids.map((id) => ({
    id, status: "running", paused: false, stage: "translating", videoId: id,
    processingAdmitted: true, resumeStep: 7,
    stepProgress: Array(13).fill(null), stepStarts: Array(13).fill(null),
    stepEnds: Array(13).fill(null), stepSkipped: Array(13).fill(false),
  })));
  for (const [i, id] of ids.entries()) run(`enqueue(${JSON.stringify(id)}, ${i === 0 ? 7 : i === 1 ? 8 : 4})`);
  await run('pauseAction("a")');
  assert.equal(pipelines.find((p) => p.id === "a").processingAdmitted, false);
  assert.equal(run('occupiedSlots.has("a")'), false);
  assert.deepEqual(launches.at(-1), [waitingId, 4, "heavy"]);
  assert.equal(run("occupiedSlots.size"), slots);
  const count = launches.length;
  run('resumeAction("a")');
  assert.equal(launches.length, count); // no preemption, all slots busy
  assert.equal(run('queue[0].id'), "a");
  run('releaseSlot("b")');
  assert.deepEqual(launches.at(-1), ["a", 7, "heavy"]);
  assert.equal(run("occupiedSlots.size"), slots);
  await run(`pauseAction(${JSON.stringify(extraId)})`); // queued video must not start later
  assert.equal(run(`queue.some(q => q.id === ${JSON.stringify(extraId)})`), false);
  console.log(`Pipeline admission (${slots} slots): unrestricted prep, gates, pause release, resume priority, FIFO, dedup OK`);
}
testPauseResume().catch((error) => { console.error(error); process.exitCode = 1; });
