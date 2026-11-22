// Run: node scripts/test-ocr-decoder.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const helperSource = fs.readFileSync(path.join(__dirname, "../src/lib/ocr-decoder.ts"), "utf8");
const helper = { exports: {} };
vm.runInNewContext(ts.transpileModule(helperSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, helper);
const { savedOcrDecoder, OCR_DECODERS } = helper.exports;
assert.deepEqual(Array.from(OCR_DECODERS), ["nvdec", "ffmpeg_cpu"]);
assert.equal(savedOcrDecoder(undefined), "ffmpeg_cpu");
assert.equal(savedOcrDecoder("unknown"), "ffmpeg_cpu");
assert.equal(savedOcrDecoder("opencv"), "ffmpeg_cpu", "retired persisted decoder migrates to CPU FFmpeg");
assert.equal(savedOcrDecoder("nvdec"), "nvdec");

const source = fs.readFileSync(path.join(__dirname, "../src/stores/pipeline-store.ts"), "utf8");
const ast = ts.createSourceFile("pipeline-store.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set(["newPipeline", "DEFAULT_DUB", "emptySteps", "settingsOf", "applyVideoSettings", "isValidRegion", "isValidRegions"]);
const selected = ast.statements.filter((node) =>
  ts.isFunctionDeclaration(node) ? names.has(node.name?.text) :
  ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => names.has(d.name.getText(ast)))
).map((node) => node.getText(ast).replace(/^export /, "")).join("\n");
const actions = {};
function find(node) {
  if (ts.isPropertyAssignment(node) && ["addPipeline", "addPipelineFromUpload", "updatePipeline"].includes(node.name.getText(ast))) {
    actions[node.name.getText(ast)] = node.initializer.getText(ast);
  }
  ts.forEachChild(node, find);
}
find(ast);
let state = { pipelines: [] };
const saved = [];
const context = vm.createContext({
  savedOcrDecoder, STEPS: Array(13).fill({}), detectOcrLang: () => "ch",
  set(update) { state = { ...state, ...update(state) }; },
  persistVideoSettings: (id) => saved.push(id), enqueue() {}, schedulePersist() {},
  sanitizeFilename: (s) => s,
});
vm.runInContext(ts.transpileModule(`${selected}
globalThis.make = newPipeline;
globalThis.apply = applyVideoSettings;
globalThis.settings = settingsOf;
globalThis.add = ${actions.addPipeline};
globalThis.upload = ${actions.addPipelineFromUpload};
globalThis.update = ${actions.updatePipeline};`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);

const fresh = context.make("new", "url");
assert.equal(fresh.ocrDecoder, "nvdec");
assert.equal(context.settings(fresh).ocrDecoder, "nvdec");
assert.equal(context.apply(fresh, undefined).ocrDecoder, "ffmpeg_cpu", "old video without settings migrates to CPU FFmpeg");
assert.equal(context.apply(fresh, {}).ocrDecoder, "ffmpeg_cpu");
for (const decoder of ["nvdec", "ffmpeg_cpu"]) {
  const restored = context.apply(fresh, { ocrDecoder: decoder });
  assert.equal(restored.ocrDecoder, decoder);
  assert.equal(context.settings(restored).ocrDecoder, decoder);
}
assert.equal(context.settings({ ...fresh, ocrDecoder: undefined }).ocrDecoder, "ffmpeg_cpu", "old local state migrates to CPU FFmpeg");
context.add("url");
assert.equal(state.pipelines.at(-1).ocrDecoder, "nvdec");
context.upload({ videoId: "video", filename: "clip.mp4", ocrDecoder: "ffmpeg_cpu" });
const uploaded = state.pipelines.at(-1);
assert.equal(uploaded.ocrDecoder, "ffmpeg_cpu");
assert.ok(saved.includes(uploaded.id));
context.update(uploaded.id, { ocrDecoder: "nvdec" });
assert.equal(state.pipelines.at(-1).ocrDecoder, "nvdec");
assert.equal(saved.filter((id) => id === uploaded.id).length, 2, "decoder changes persist to backend metadata");
assert.match(source, /decoder: savedOcrDecoder\(cur\.ocrDecoder\)/, "OCR request uses per-video decoder, not global form state");
console.log("OCR decoder: exactly two options, NVDEC defaults, legacy migration, metadata roundtrip and per-video update OK");
