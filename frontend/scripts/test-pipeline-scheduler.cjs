// Exercise the real admission functions without a browser or backend.
// Run: node scripts/test-pipeline-scheduler.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/stores/pipeline-store.ts"), "utf8");
const ast = ts.createSourceFile("pipeline-store.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "MAX_ACTIVE_PIPELINES", "queue", "occupiedSlots", "priorityPipelines",
  "enqueue", "enqueuePrep", "enqueueFront", "releaseSlot", "processQueue", "launchEntry",
]);
const selected = ast.statements.filter((node) =>
  ts.isFunctionDeclaration(node) ? names.has(node.name?.text) :
  ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => names.has(d.name.getText(ast)))
).map((node) => node.getText(ast)).join("\n");
const launches = [];
const pipelines = ["a", "b", "c"].map((id) => ({ id }));
const context = vm.createContext({
  usePipelineStore: { getState: () => ({ pipelines }) },
  runPrep: (id, step) => { launches.push([id, step, "prep"]); return new Promise(() => {}); },
  runPipeline: (id, step) => { launches.push([id, step, "heavy"]); return new Promise(() => {}); },
});
vm.runInContext(ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
const run = (code) => vm.runInContext(code, context);

run('enqueue("a", 0); enqueue("b", 0); enqueue("c", 0)');
assert.deepEqual(launches, [["a", 0, "prep"], ["b", 0, "prep"], ["c", 0, "prep"]]);
assert.equal(run("occupiedSlots.size"), 0);
// Once prep finishes, only two videos may enter OCR and later processing.
run('enqueue("a", 4); enqueue("b", 4); enqueue("c", 4)');
assert.deepEqual(launches.slice(-2), [["a", 4, "heavy"], ["b", 4, "heavy"]]);
assert.equal(run("occupiedSlots.size"), 2);
assert.equal(run('queue[0].id'), "c");
// A fourth video can download, select region and adjust subtitles while two
// processing slots are busy and the third video is already waiting for OCR.
pipelines.push({ id: "d" });
run('enqueue("d", 0); enqueue("d", 2); enqueue("d", 3)');
assert.deepEqual(launches.slice(-3), [["d", 0, "prep"], ["d", 2, "prep"], ["d", 3, "prep"]]);
assert.equal(run("occupiedSlots.size"), 2);
// Prep watermark selection is unrestricted even with step index 4.
run('enqueuePrep("d", 4)');
assert.deepEqual(launches.at(-1), ["d", 4, "prep"]);
run('enqueue("d", 4); enqueue("d", 4)');
assert.equal(run('queue.filter(q => q.id === "d").length'), 1);
// An admitted pipeline at a later manual gate retains its slot. Resume
// reuses that slot and never admits a third processing pipeline.
run('enqueueFront("b", 8)');
assert.deepEqual(launches.at(-1), ["b", 8, "heavy"]);
assert.equal(run("occupiedSlots.size"), 2);
run('releaseSlot("a")');
assert.deepEqual(launches.at(-1), ["c", 4, "heavy"]);
assert.equal(run("occupiedSlots.size"), 2);
run('releaseSlot("b")');
assert.deepEqual(launches.at(-1), ["d", 4, "heavy"]);
assert.equal(run("occupiedSlots.size"), 2);
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
  reportPipeline() {}, schedulePersist() {},
  STEP_STAGE: { translating: 7 }, STEPS: Array.from({ length: 13 }, () => ({ label: "test" })),
  fetch: async () => ({ ok: true }),
});
run(ts.transpileModule(`const pauseAction = ${actions.pausePipeline}; const resumeAction = ${actions.resumePipeline};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText);
async function testPauseResume() {
  run("queue = []; occupiedSlots.clear(); priorityPipelines.clear()");
  pipelines.splice(0, pipelines.length, ...["a", "b", "c", "d"].map((id) => ({
    id, status: "running", paused: false, stage: "translating", videoId: id,
    processingAdmitted: true, resumeStep: 7,
    stepProgress: Array(13).fill(null), stepStarts: Array(13).fill(null),
    stepEnds: Array(13).fill(null), stepSkipped: Array(13).fill(false),
  })));
  run('enqueue("a", 7); enqueue("b", 8); enqueue("c", 4); enqueue("d", 4)');
  await run('pauseAction("a")');
  assert.equal(pipelines.find((p) => p.id === "a").processingAdmitted, false);
  assert.equal(run('occupiedSlots.has("a")'), false);
  assert.deepEqual(launches.at(-1), ["c", 4, "heavy"]);
  assert.equal(run("occupiedSlots.size"), 2);
  const count = launches.length;
  run('resumeAction("a")');
  assert.equal(launches.length, count); // no preemption, both slots busy
  assert.equal(run('queue[0].id'), "a");
  run('releaseSlot("b")');
  assert.deepEqual(launches.at(-1), ["a", 7, "heavy"]);
  assert.equal(run("occupiedSlots.size"), 2);
  await run('pauseAction("d")'); // queued video must not start later
  assert.equal(run('queue.some(q => q.id === "d")'), false);
  console.log("Pipeline admission: unrestricted prep, slots, pause release, resume priority, dedup OK");
}
testPauseResume().catch((error) => { console.error(error); process.exitCode = 1; });
