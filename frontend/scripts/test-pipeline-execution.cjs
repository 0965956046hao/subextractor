// Run: node scripts/test-pipeline-execution.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
function load(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(transpile(fs.readFileSync(path.join(__dirname, file), "utf8")), {
    exports, require: (name) => imports[name],
  });
  return exports;
}
const timing = load("../src/lib/processing-timing.ts");
const { pipelineExecution } = load("../src/lib/pipeline-execution.ts", { "./processing-timing": timing });
const now = 10000;
const pipeline = { videoId: "video", stage: "translating", status: "running", paused: false, progress: 77 };
function snapshot(state, extra = {}) {
  return { receivedAt: now, jobs: [{ video_id: "video", job_id: "job", job_type: "translate", state,
    queue_position: null, waiting_resources: [], ...extra }] };
}
assert.equal(pipelineExecution(pipeline, 7, null, now).kind, "checking", "frontend running is not execution evidence");
let result = pipelineExecution(pipeline, 7, snapshot("queued", { queue_position: 2 }), now);
assert.equal(result.kind, "queued");
assert.equal(result.queuePosition, 2);
result = pipelineExecution(pipeline, 7, snapshot("waiting_resources", { waiting_resources: ["gemini"] }), now);
assert.equal(result.kind, "waiting_resources");
assert.deepEqual(Array.from(result.resources), ["gemini"]);
assert.equal(pipelineExecution(pipeline, 7, snapshot("waiting_executor"), now).kind, "waiting_executor");
assert.equal(pipelineExecution(pipeline, 7, snapshot("running"), now).kind, "running");
assert.equal(pipelineExecution(pipeline, 7, snapshot("running"), now + 9000).kind, "checking", "stale backend state cannot claim running");
assert.equal(pipelineExecution({ ...pipeline, paused: true }, 7, snapshot("running"), now).kind, "paused");
assert.equal(pipelineExecution({ ...pipeline, timelineCheck: { waiting: true } }, 7, snapshot("running"), now).kind, "manual");
assert.equal(pipelineExecution({ ...pipeline, voiceCheck: { waiting: true } }, 8, snapshot("running"), now).kind, "manual");
for (const stage of ["region", "subtitle_preview", "watermark_region", "keep_original", "thumbnail_review"]) {
  assert.equal(pipelineExecution({ ...pipeline, stage }, 4, snapshot("running"), now).kind, "manual");
}
assert.equal(pipelineExecution({ ...pipeline, status: "done" }, 7, snapshot("running"), now).kind, "done");
assert.equal(pipelineExecution({ ...pipeline, status: "error" }, 7, snapshot("running"), now).kind, "error");
assert.equal(pipelineExecution(pipeline, 8, snapshot("running"), now).kind, "checking", "translation job must not light up dub");
const otherVideo = snapshot("running");
otherVideo.jobs[0].video_id = "other-video";
assert.equal(pipelineExecution(pipeline, 7, otherVideo, now).kind, "checking");
const repair = snapshot("running");
repair.jobs.push({ ...repair.jobs[0], job_id: "repair", state: "queued", queue_position: 1 });
assert.equal(pipelineExecution(pipeline, 7, repair, now).jobId, "repair", "use latest matching attempt");

// SSE watermark work uses its fresh backend timing, not lane ownership.
const watermark = { ...pipeline, stage: "wm_delogo", stepTimings: Array(13).fill(null) };
watermark.stepTimings[5] = { jobId: "delogo", running: true, started: true, receivedAt: now, elapsedMs: 100 };
assert.equal(pipelineExecution(watermark, 5, { receivedAt: now, jobs: [], directWatermarkJob: "delogo" }, now).kind, "running");
assert.equal(pipelineExecution(watermark, 5, { receivedAt: now, jobs: [] }, now).kind, "checking", "persisted SSE flags alone cannot claim execution");
assert.equal(pipelineExecution(watermark, 5, { receivedAt: now + 9000, jobs: [] }, now + 9000).kind, "checking");

// Exercise the actual row's timer: it freezes for queued/resource/manual waits.
const ui = fs.readFileSync(path.join(__dirname, "../src/components/AutoPipeline.tsx"), "utf8");
const ast = ts.createSourceFile("AutoPipeline.tsx", ui, ts.ScriptTarget.Latest, true);
const elapsed = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name.text === "pipelineElapsed");
const context = vm.createContext({ processingElapsed: timing.processingElapsed,
  STEPS: Array(13).fill({}), fmtElapsed: (ms) => String(ms) });
vm.runInContext(transpile(elapsed.getText(ast)), context);
const p = { ...pipeline, stepTimings: Array(13).fill(null) };
p.stepTimings[7] = { jobId: "job", running: true, started: true, receivedAt: now, elapsedMs: 100 };
for (const kind of ["queued", "waiting_resources", "waiting_executor", "manual", "checking", "paused"]) {
  assert.equal(context.pipelineElapsed(p, now + 5000, { kind, step: 7 }), "100", `${kind}: do not count waiting wall time`);
}
assert.equal(context.pipelineElapsed(p, now + 5000, { kind: "running", step: 7, jobId: "job" }), "5100");
assert.match(ui, /execution\.kind === "running" && <IconSpinner/);
assert.match(ui, /<PipelineExecutionProvider>/);
console.log("Pipeline execution: backend truth, queue positions/resources, freshness, manual gates, latest jobs, SSE and frozen wait clocks OK");
