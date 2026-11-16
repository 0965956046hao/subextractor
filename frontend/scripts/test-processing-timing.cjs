const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/lib/processing-timing.ts"), "utf8");
const context = vm.createContext({ exports: {} });
vm.runInContext(ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
} }).outputText, context);
const { processingElapsed, receivedTiming } = context.exports;
const queued = receivedTiming("queued", { started_at: null, finished_at: null, elapsed_ms: 0, running: false }, 1000);
assert.equal(processingElapsed(queued, 999999, true), null);
const running = receivedTiming("ocr", { started_at: 9999999, finished_at: null, elapsed_ms: 12000, running: true }, 1000);
assert.equal(processingElapsed(running, 4000, true), 15000); // independent of server clock
assert.equal(processingElapsed(running, 999999, false), 12000); // paused/error, no ongoing counting
const finished = receivedTiming("ocr", { started_at: 1, finished_at: 41, elapsed_ms: 40000, running: false }, 90000);
assert.equal(processingElapsed(finished, 9999999, true), 40000); // excludes polling and manual review
assert.equal(processingElapsed(JSON.parse(JSON.stringify(finished)), 9999999, true), 40000); // persisted reload
assert.equal(processingElapsed(null, 9999999, true), null); // new attempt starts blank
console.log("Processing time: queued hidden, active-only live clock, final duration, pause, reload, clock skew OK");

const storeSource = fs.readFileSync(path.join(__dirname, "../src/stores/pipeline-store.ts"), "utf8");
const ast = ts.createSourceFile("store.ts", storeSource, ts.ScriptTarget.Latest, true);
const names = new Set(["applyJobTiming", "markStepStart", "markStepEnd", "markStepSkipped", "emptySteps", "resumeHeavy", "stageForJobType", "refreshStepTimings"]);
const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text))
  .map((node) => node.getText(ast)).join("\n");
const pipeline = { id: "p", stepStarts: Array(13).fill(null), stepEnds: Array(13).fill(null),
  stepProgress: Array(13).fill(null), stepSkipped: Array(13).fill(false) };
const queuedSteps = [];
Object.assign(context, {
  STEPS: Array(13).fill({}), STEP_STAGE: { processing: 4, translating: 7, dub: 8, muxing: 9, context: 6 },
  usePipelineStore: { getState: () => ({ pipelines: [pipeline] }) },
  patch: (_id, update) => Object.assign(pipeline, update), reportPipeline() {}, recalcOverall() {},
  enqueue: (id, step) => queuedSteps.push(step),
  AbortSignal, isStaleRun: () => false,
});
vm.runInContext(ts.transpileModule(selected, { compilerOptions: {
  target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
} }).outputText, context);
context.markStepStart("p", 4);
assert.equal(pipeline.stepTimings[4], null);
context.applyJobTiming("p", 4, "ocr", { started_at: null, finished_at: null, elapsed_ms: 0, running: false });
assert.equal(processingElapsed(pipeline.stepTimings[4], 9999999, true), null);
const finalTiming = { started_at: 1, finished_at: 41, elapsed_ms: 40000, running: false };
context.applyJobTiming("p", 4, "ocr", finalTiming);
context.markStepEnd("p", 4);
assert.equal(pipeline.stepTimings[4].elapsedMs, 40000); // frontend end/poll timestamp never replaces backend duration
context.markStepSkipped("p", 4, true);
assert.equal(pipeline.stepCached[4], true);
context.markStepStart("p", 4);
assert.equal(pipeline.stepTimings[4], null);
assert.equal(pipeline.stepCached[4], false);
context.resumeHeavy("p", "video", 4, "processing", [], [{ job_id: "ocr", job_type: "ocr",
  status: "done", phase: "saving", processing_timing: finalTiming }]).then(() => {
  assert.equal(pipeline.stepTimings[4].elapsedMs, 40000);
  assert.deepEqual(queuedSteps, [5]); // completed during F5: continue, never resubmit OCR
  console.log("Store timing: reset attempts, cached labels, authoritative final time, finished-during-reload recovery OK");
  context.markStepStart("p", 4); // rerun cleared outputs; an old completed job must not skip this new OCR
  context.fetch = async () => ({ ok: true, json: async () => ({ jobs: [{ job_id: "old-ocr", job_type: "ocr",
    status: "done", phase: "saving", processing_timing: finalTiming }] }) });
  return context.refreshStepTimings("p", "video", 0);
}).then((jobs) => {
  assert.equal(jobs.length, 0);
  assert.equal(pipeline.stepTimings[4], null);
  context.applyJobTiming("p", 4, "old-ocr", { started_at: null, finished_at: null, elapsed_ms: 0, running: false });
  return context.refreshStepTimings("p", "video", 0);
}).then((jobs) => {
  assert.equal(jobs.length, 1); // exact saved job identity may finish during reload
  assert.equal(pipeline.stepTimings[4].elapsedMs, 40000);
  console.log("Reload attempt matching: ignores old pre-reset jobs, recovers the exact submitted job OK");
}).catch((error) => { console.error(error); process.exitCode = 1; });
