// Run: node scripts/test-watermark-prep.cjs
// Exercise the real prep/queue/restore functions with the browser and backend mocked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/stores/pipeline-store.ts"), "utf8");
const ast = ts.createSourceFile("pipeline-store.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "STEP_STAGE", "queue", "occupiedSlots", "priorityPipelines",
  "enqueue", "enqueuePrep", "enqueueFront", "releaseSlot", "processQueue", "launchEntry",
  "runPrep", "runRestorePaused", "restoreRunning",
]);
const selected = ast.statements.filter((node) =>
  ts.isFunctionDeclaration(node) ? names.has(node.name?.text) :
  ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => names.has(d.name.getText(ast)))
).map((node) => node.getText(ast).replace(/^export /, "")).join("\n");
const actions = {};
function findActions(node) {
  if (ts.isPropertyAssignment(node) && ["confirmRegion", "confirmSubtitleStyle", "confirmWatermarkRegions"].includes(node.name.getText(ast))) {
    actions[node.name.getText(ast)] = node.initializer.getText(ast);
  }
  ts.forEachChild(node, findActions);
}
findActions(ast);
const heavy = [];
const waiters = new Map();
const liveRunners = new Set();
let pipeline;
const context = vm.createContext({
  process: { env: {} }, liveRunners, runGen: new Map(), abortedPipelines: new Set(),
  subtitleStyleWaiters: new Map(), regionWaiters: new Map(),
  usePipelineStore: { getState: () => ({ pipelines: [pipeline] }) },
  get: () => ({ pipelines: [pipeline] }),
  set: (update) => { pipeline = update({ pipelines: [pipeline] }).pipelines[0]; },
  patch: (_id, update) => Object.assign(pipeline, update),
  detectOcrType: () => "rapid", isStaleRun: () => false, staleExitPrep: () => false,
  emptySteps: (value) => Array(13).fill(value),
  appendLog() {}, persistVideoSettings() {}, reportPipeline() {}, markStepStart() {}, markStepEnd() {},
  listVideos: async () => [], refreshStepTimings: async () => [],
  waitForWatermarkRegion: (id) => new Promise((resolve) => waiters.set(id, resolve)),
  confirmWatermarkRegionAction: (id, regions) => { waiters.get(id)?.(regions); waiters.delete(id); },
  runPipeline: (id, step) => { heavy.push([id, step]); return new Promise(() => {}); },
  fetch: async () => { throw new Error("No backend request is allowed before watermark confirmation"); },
});
const transpile = (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
vm.runInContext(transpile(`${selected}\n${Object.entries(actions).map(([name, code]) => `const ${name}Action = ${code};`).join("\n")}`), context);
const run = (code) => vm.runInContext(code, context);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const regions = [{ x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.2 }];

function reset(extra = {}) {
  heavy.length = 0;
  liveRunners.clear();
  waiters.clear();
  run("queue = []; occupiedSlots.clear(); priorityPipelines.clear()");
  pipeline = {
    id: "p", videoId: "video", url: "video.mp4", stage: "subtitle_preview", resumeStep: 4,
    status: "running", paused: false, autoFit: false, removeWatermarkEnabled: true,
    removeWatermarkRegions: [], processingAdmitted: false, subtitleStyle: null,
    bigThumbs: [], region: { x1: 0, y1: 0.7, x2: 1, y2: 1 },
    stepProgress: Array(13).fill(null), stepStarts: Array(13).fill(null),
    stepEnds: Array(13).fill(null), stepSkipped: Array(13).fill(false), ...extra,
  };
}
function assertWaiting() {
  assert.equal(pipeline.stage, "watermark_region");
  assert.equal(pipeline.resumeStep, 4);
  assert.equal(pipeline.processingAdmitted, false);
  assert.equal(waiters.has("p"), true);
  assert.equal(heavy.length, 0, "OCR must not start before watermark confirmation");
  assert.equal(run('occupiedSlots.has("p")'), false, "manual prep cannot reserve an OCR slot");
}

async function test() {
  // Exact regression: backend restart + refresh while waiting for subtitle style.
  reset();
  run('confirmSubtitleStyleAction("p", { font_size: 56, margin_v: 80 })');
  assertWaiting();
  assert.equal(pipeline.subtitleStyle.font_size, 56, "restored prep preserves the confirmed style");
  run(`confirmWatermarkRegionsAction("p", ${JSON.stringify(regions)})`);
  await flush();
  assert.deepEqual(heavy, [["p", 4]]);
  assert.equal(pipeline.removeWatermarkRegions.length, 1);

  // Existing processing videos do not block prep or backend OCR submission.
  for (const enqueue of ['enqueue("p", 4)', 'enqueueFront("p", 4)']) {
    reset({ stage: "processing" });
    run('for (let i = 0; i < 10; i++) occupiedSlots.add(`busy-${i}`)');
    run(enqueue);
    assertWaiting();
    run(`confirmWatermarkRegionsAction("p", ${JSON.stringify(regions)})`);
    await flush();
    assert.deepEqual(heavy, [["p", 4]]);
  }

  // Refresh in the watermark selector must restore prep, not attach/start OCR.
  for (const resumeStep of [null, 4]) {
    reset({ stage: "watermark_region", resumeStep, processingAdmitted: true });
    await run("runRestorePaused()");
    assertWaiting();
    run(`confirmWatermarkRegionsAction("p", ${JSON.stringify(regions)})`);
    await flush();
    assert.deepEqual(heavy, [["p", 4]]);
  }

  // Auto-fit region confirmation after refresh still goes through watermark prep.
  reset({ stage: "region", autoFit: true, resumeStep: 3 });
  run('confirmRegionAction("p", { x1: 0, y1: 0.7, x2: 1, y2: 1 })');
  assertWaiting();
  run(`confirmWatermarkRegionsAction("p", ${JSON.stringify(regions)})`);
  await flush();
  assert.deepEqual(heavy, [["p", 4]]);

  // Already selected regions or disabled removal never ask for another selection.
  for (const extra of [{ removeWatermarkRegions: regions }, { removeWatermarkEnabled: false }]) {
    reset(extra);
    run('confirmSubtitleStyleAction("p", { font_size: 48 })');
    await flush();
    assert.deepEqual(heavy, [["p", 4]]);
    assert.equal(waiters.size, 0);
  }

  // A legacy post-OCR selector can no longer accept new manual selections.
  reset({ stage: "watermark_region", resumeStep: 5 });
  run(`confirmWatermarkRegionsAction("p", ${JSON.stringify(regions)})`);
  assert.equal(pipeline.removeWatermarkRegions.length, 0);
  assert.equal(heavy.length, 0);

  const heavyRunner = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === "runPipeline");
  let waits = 0;
  let missingRegionsGuard;
  function inspect(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "waitForWatermarkRegion") waits++;
    if (ts.isIfStatement(node) && node.expression.getText(ast) === "cur.removeWatermarkRegions.length === 0") missingRegionsGuard = node;
    ts.forEachChild(node, inspect);
  }
  inspect(heavyRunner);
  assert.equal(waits, 0, "the entire post-OCR runner must contain no watermark selection waiter");
  reset({ stage: "wm_delogo", resumeStep: 5 });
  assert.throws(() => run(transpile(`{ const cur = get().pipelines[0]; ${missingRegionsGuard.getText(ast)} }`)), /Thiếu vùng xoá watermark/);

  // Even an internal call bypassing queue admission cannot start OCR without regions.
  run(transpile(heavyRunner.getText(ast).replace("function runPipeline(", "function guardedRunPipeline(")));
  reset({ stage: "processing" });
  await run('guardedRunPipeline("p", 4)');
  assertWaiting();
  run(`confirmWatermarkRegionsAction("p", ${JSON.stringify(regions)})`);
  await flush();
  assert.deepEqual(heavy, [["p", 4]]);

  console.log("Watermark prep: refresh, restore, priority/full queue, auto-fit, preselected/disabled removal, and no post-OCR manual gate OK");
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
