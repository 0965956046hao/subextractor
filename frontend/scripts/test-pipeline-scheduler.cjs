// Exercise real frontend admission/restore actions without a browser or backend.
// Run: node scripts/test-pipeline-scheduler.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/stores/pipeline-store.ts"), "utf8");
const ast = ts.createSourceFile("pipeline-store.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "queue", "occupiedSlots", "priorityPipelines", "restoreRunning",
  "enqueue", "enqueuePrep", "enqueueFront", "releaseSlot", "processQueue", "launchEntry",
  "emptySteps", "pipelineResumeStep", "runRestorePaused", "takePriority",
]);
const selected = ast.statements.filter((node) =>
  ts.isFunctionDeclaration(node) ? names.has(node.name?.text) :
  ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => names.has(d.name.getText(ast)))
).map((node) => node.getText(ast)).join("\n");
const actions = {};
function findActions(node) {
  if (ts.isPropertyAssignment(node) && ["pausePipeline", "resumePipeline"].includes(node.name.getText(ast))) {
    actions[node.name.getText(ast)] = node.initializer.getText(ast);
  }
  ts.forEachChild(node, findActions);
}
findActions(ast);
const launches = [];
const pipelines = [];
const restored = [];
const liveRunners = new Set();
let videoFetches = 0;
const context = vm.createContext({
  // A leftover old setting must not restore the two-video limit.
  process: { env: { NEXT_PUBLIC_MAX_ACTIVE_PIPELINES: "2" } },
  usePipelineStore: { getState: () => ({ pipelines }) },
  runPrep: (id, step) => { launches.push([id, step, "prep"]); return new Promise(() => {}); },
  runPipeline: (id, step) => { launches.push([id, step, "heavy"]); return new Promise(() => {}); },
  get: () => ({ pipelines }),
  set: (update) => {
    const next = update({ pipelines });
    pipelines.splice(0, pipelines.length, ...next.pipelines);
  },
  patch: (id, update) => Object.assign(pipelines.find((p) => p.id === id), update),
  bumpGen() {}, abortDelogo() {}, appendLog() {}, resolvePauseWaiters() {},
  runGen: new Map(), liveRunners, refreshStepTimings: async () => [],
  reportPipeline() {}, schedulePersist() {},
  STEP_STAGE: { processing: 4, translating: 7, dub: 8, muxing: 9 },
  STEPS: Array.from({ length: 13 }, () => ({ label: "test" })),
  fetch: async () => ({ ok: true }),
  listVideos: async () => { videoFetches++; return []; },
  resumeHeavy: async (id, videoId, step) => { restored.push([id, step]); },
});
const transpile = (code) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
vm.runInContext(transpile(`${selected}
const pauseAction = ${actions.pausePipeline};
const resumeAction = ${actions.resumePipeline};`), context);
const run = (code) => vm.runInContext(code, context);
function makePipeline(id, extra = {}) {
  return {
    id, videoId: id, status: "running", paused: false, stage: "translating",
    processingAdmitted: true, resumeStep: 7,
    stepProgress: Array(13).fill(null), stepStarts: Array(13).fill(null),
    stepEnds: Array(13).fill(null), stepSkipped: Array(13).fill(false), ...extra,
  };
}
function reset(rows) {
  launches.length = 0;
  restored.length = 0;
  liveRunners.clear();
  pipelines.splice(0, pipelines.length, ...rows);
  run("queue = []; occupiedSlots.clear(); priorityPipelines.clear()");
}

async function test() {
  // Three videos at different steps never block a fourth video from OCR.
  reset(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => makePipeline(id)));
  run('enqueue("a", 7); enqueue("b", 8); enqueue("c", 9); enqueue("d", 4)');
  assert.deepEqual(launches, [["a", 7, "heavy"], ["b", 8, "heavy"], ["c", 9, "heavy"], ["d", 4, "heavy"]]);
  for (const id of ["e", "f", "g", "h"]) run(`enqueue(${JSON.stringify(id)}, 4)`);
  assert.equal(launches.length, 8, "all ready videos reach backend scheduling, not just 2/3");
  assert.equal(run("queue.length"), 0);
  assert.equal(run("occupiedSlots.size"), 8);

  // Manual review and prep waits do not gate unrelated videos.
  pipelines[0].timelineCheck = { waiting: true };
  pipelines.push(makePipeline("prep", { processingAdmitted: false }));
  run('enqueuePrep("prep", 4)');
  assert.deepEqual(launches.at(-1), ["prep", 4, "prep"]);
  assert.equal(run('occupiedSlots.has("prep")'), false);
  pipelines.push(makePipeline("new"));
  run('enqueue("new", 4)');
  assert.deepEqual(launches.at(-1), ["new", 4, "heavy"]);

  // Resume submits immediately with backend priority despite other runners.
  await run('pauseAction("b")');
  assert.equal(pipelines.find((p) => p.id === "b").processingAdmitted, false);
  assert.equal(run('occupiedSlots.has("b")'), false);
  const count = launches.length;
  run('resumeAction("b")');
  assert.equal(launches.length, count + 1);
  assert.deepEqual(launches.at(-1), ["b", 7, "heavy"]);
  assert.equal(run('takePriority("b")'), true);
  assert.equal(run('takePriority("b")'), false);

  // FIFO/dedup/priority of pending entries, excluding paused/deleted videos.
  reset(["a", "b", "c", "paused"].map((id) => makePipeline(id)));
  pipelines.find((p) => p.id === "paused").paused = true;
  run(`const drain = processQueue; processQueue = () => {};
    enqueue("a", 4); enqueue("b", 4); enqueue("a", 8);
    enqueue("paused", 4); enqueue("deleted", 4); enqueueFront("c", 7);`);
  assert.equal(run('queue.filter(q => q.id === "a").length'), 1);
  run("processQueue = drain; processQueue()");
  assert.deepEqual(launches, [["c", 7, "heavy"], ["b", 4, "heavy"], ["a", 8, "heavy"]]);
  assert.equal(run("queue.length"), 0);

  // Reload restores all eight videos, excluding paused/manual/live runners.
  reset(Array.from({ length: 8 }, (_, i) => makePipeline(`restore-${i}`, {
    status: i % 2 ? "queued" : "running", stage: "processing", resumeStep: 4,
  })));
  pipelines.push(makePipeline("paused", { paused: true }));
  pipelines.push(makePipeline("review", { timelineCheck: { waiting: true } }));
  pipelines.push(makePipeline("live"));
  liveRunners.add("live");
  await run("runRestorePaused()");
  assert.deepEqual(restored, Array.from({ length: 8 }, (_, i) => [`restore-${i}`, 4]));
  assert.equal(videoFetches, 1);
  assert.equal(run('occupiedSlots.has("restore-7")'), true, "no three-video cap during reload");
  console.log("Pipeline admission: no global cap, mixed steps, manual gates, pause/resume priority, FIFO, dedup and reload OK");
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
