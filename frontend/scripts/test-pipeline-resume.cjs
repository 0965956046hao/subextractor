// Run: node scripts/test-pipeline-resume.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/stores/pipeline-store.ts"), "utf8");
const ast = ts.createSourceFile("pipeline-store.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["STEP_STAGE", "pipelineResumeStep", "markStepStart", "emptySteps"]);
const selected = ast.statements.filter((node) =>
  ts.isFunctionDeclaration(node) ? names.has(node.name?.text) :
  ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => names.has(d.name.getText(ast)))
).map((node) => node.getText(ast).replace(/^export /, "")).join("\n");
const actions = {};
function findActions(node) {
  if (ts.isPropertyAssignment(node) && ["pausePipeline", "resumePipeline", "retryFailedPipeline"].includes(node.name.getText(ast))) {
    actions[node.name.getText(ast)] = node.initializer.getText(ast);
  }
  ts.forEachChild(node, findActions);
}
findActions(ast);
let pipeline;
const queued = [];
let resets = 0;
const context = vm.createContext({
  get: () => ({ pipelines: [pipeline] }),
  usePipelineStore: { getState: () => ({ pipelines: [pipeline] }) },
  set: (update) => { pipeline = update({ pipelines: [pipeline] }).pipelines[0]; },
  patch: (_id, update) => Object.assign(pipeline, update),
  enqueueFront: (id, step) => queued.push(step),
  resetVideoFromStep: async () => { resets++; throw new Error("retry must not reset saved outputs"); },
  bumpGen() {}, abortDelogo() {}, appendLog() {}, resolvePauseWaiters() {},
  reportPipeline() {}, schedulePersist() {}, releaseSlot() {},
  refreshStepTimings: async () => [], runGen: new Map(), priorityPipelines: new Set(),
  STEPS: Array.from({ length: 13 }, () => ({ label: "test" })),
  fetch: async () => ({ ok: true }),
});
vm.runInContext(ts.transpileModule(`${selected}
const pauseAction = ${actions.pausePipeline};
const resumeAction = ${actions.resumePipeline};
const retryAction = ${actions.retryFailedPipeline};
let queue = [];`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
const run = (code) => vm.runInContext(code, context);
function reset(stage, resumeStep, extra = {}) {
  pipeline = {
    id: "p", videoId: "video", stage, resumeStep, status: "running", paused: false,
    stepProgress: Array(13).fill(100), stepStarts: Array(13).fill(1),
    stepEnds: Array(13).fill(2), stepSkipped: Array(13).fill(false), ...extra,
  };
  queued.length = 0;
}
async function test() {
  const stages = { context: 6, translating: 7, saving: 7, dub: 8, keep_original: 8,
    muxing: 9, meta: 10, thumbnail: 11, thumbnail_review: 11, youtube: 12 };
  for (const [stage, step] of Object.entries(stages)) {
    for (const staleStep of [null, 3, 4, 5]) {
      reset(stage, staleStep);
      await run('pauseAction("p")');
      assert.equal(pipeline.resumeStep, step, `${stage}: pause records current step`);
      assert.equal(pipeline.stepEnds[5], 2, "earlier completed steps remain intact");
      run('resumeAction("p")');
      assert.deepEqual(queued, [step], `${stage}: resumes without earlier steps`);

      // Already paused state persisted by the old code must also recover.
      reset(stage, staleStep, { paused: true, status: "queued" });
      run('resumeAction("p")');
      assert.deepEqual(queued, [step], `${stage}: repairs stale persisted checkpoint`);
    }
  }
  for (const [stage, checkpoint, expected, extra] of [
    ["region", 3, 3], ["subtitle_preview", 4, 4],
    ["watermark_region", 4, 4], ["wm_delogo", 4, 4],
    ["watermark_region", 5, 5], ["wm_delogo", 5, 5],
    ["saving", 8, 8, { timelineCheck: { waiting: true } }],
    ["dub", 9, 9, { voiceCheck: { waiting: true } }],
    ["idle", null, 0],
  ]) {
    reset(stage, checkpoint, extra);
    await run('pauseAction("p")');
    run('resumeAction("p")');
    assert.deepEqual(queued, [expected], `${stage}: preserves manual gate checkpoint`);
  }
  reset("translating", 5);
  run('markStepStart("p", 7)');
  assert.equal(pipeline.resumeStep, 7, "starting a step updates the checkpoint");
  reset("error", 4, {
    status: "error", failedStep: 7, error: "Internal Server Error", finishedAt: 123,
    reviewedSubtitleLangs: ["vi"], dubbedUrl: "/existing-audio", resultUrl: "/existing-video",
  });
  const oldProgress = pipeline.stepProgress;
  const oldStarts = pipeline.stepStarts;
  run('queue = [{ id: "p", startStep: 4 }, { id: "other", startStep: 8 }]');
  run('retryAction("p")');
  assert.deepEqual(queued, [7], "retry uses the failed translation step, not a stale resumeStep");
  assert.equal(pipeline.status, "queued");
  assert.equal(pipeline.paused, false);
  assert.equal(pipeline.failedStep, null);
  assert.equal(pipeline.error, "");
  assert.equal(pipeline.finishedAt, null);
  assert.equal(pipeline.resumeStep, 7);
  assert.deepEqual(pipeline.reviewedSubtitleLangs, ["vi"], "never clear approved tracks on non-destructive retry");
  assert.equal(pipeline.dubbedUrl, "/existing-audio");
  assert.equal(pipeline.resultUrl, "/existing-video");
  assert.equal(pipeline.stepProgress, oldProgress);
  assert.equal(pipeline.stepStarts, oldStarts, "earlier completed steps are untouched");
  assert.equal(resets, 0, "no reset-from API call");
  assert.equal(run('queue.some(q => q.id === "p")'), false, "remove stale queued copies before retry");
  assert.equal(run('queue.some(q => q.id === "other")'), true);
  run('retryAction("p")');
  assert.deepEqual(queued, [7], "double-click cannot launch a second retry");
  for (const status of ["running", "queued", "done"]) {
    reset("translating", 7, { status });
    run('retryAction("p")');
    assert.deepEqual(queued, [], `do not retry a ${status} pipeline`);
  }
  reset("error", 8, { status: "error", failedStep: null });
  run('retryAction("p")');
  assert.deepEqual(queued, [8], "legacy errors fall back to the saved step");
  console.log("Pipeline resume: current step, legacy persisted state, manual gates, earlier outputs OK");
  console.log("Non-destructive retry: failed step, preserved results/review decisions, no reset API, dedup and double-click guards OK");
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
