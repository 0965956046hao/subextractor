// Run: node scripts/test-retranslation.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const transpile = (code) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const helper = { exports: {} };
vm.runInNewContext(transpile(fs.readFileSync(path.join(__dirname, "../src/lib/api-response.ts"), "utf8")), {
  exports: helper.exports, Error,
});
const { readApiJson } = helper.exports;
const source = fs.readFileSync(path.join(__dirname, "../src/stores/pipeline-store.ts"), "utf8");
const ast = ts.createSourceFile("store.ts", source, ts.ScriptTarget.Latest, true);
let repair;
function find(node) {
  if (ts.isTryStatement(node) && node.tryBlock.statements.some((statement) =>
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => d.name.getText(ast) === "retRes")
  )) repair = node.getText(ast);
  ts.forEachChild(node, find);
}
find(ast);
assert.ok(repair, "exercise the actual post-translation repair block");

async function test() {
  for (const [body, status] of [["Internal Server Error", 500], ["<html>Gateway Timeout</html>", 504]]) {
    await assert.rejects(readApiJson(new Response(body, { status }), "Dịch lại"), (error) =>
      error.message.includes(`HTTP ${status}`) && error.message.includes(body) && !error.message.includes("Unexpected token"));
  }
  await assert.rejects(readApiJson(new Response('{"detail":"API limit"}', { status: 429 }), "Dịch lại"), /API limit/);
  assert.equal((await readApiJson(new Response('{"job_id":"repair"}'), "Dịch lại")).job_id, "repair");

  const calls = [];
  const logs = [];
  const cancellations = [];
  let finish;
  const context = vm.createContext({
    Error,
    id: "pipeline", gen: 1, videoId: "video", translateTarget: "en", sourceTrack: "vi", trackSourceLang: "vi",
    srtText: "old subtitles", JSON_HEADERS: {}, readApiJson,
    appendLog: (_id, message) => logs.push(message),
    appendBackendLogs() {}, prioritizeIfNeeded: async () => {}, isStaleRun: () => false,
    cancelJob: async (id) => cancellations.push(id),
    fetch: async (url, options) => {
      calls.push([url, options]);
      return url.includes("/retranslate") ? new Response('{"job_id":"repair"}') : new Response("repaired subtitles");
    },
    pollJob: async (_job, tick) => {
      tick({ logs: [] });
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  const execute = () => vm.runInContext(transpile(`(async () => { ${repair} })()`), context);
  const pending = execute();
  await new Promise(setImmediate);
  assert.equal(calls.length, 1, "do not download/advance before the queued repair finishes");
  assert.equal(JSON.parse(calls[0][1].body).background, true);
  assert.equal(JSON.parse(calls[0][1].body).source_track, "vi");
  finish({ status: "done" });
  await pending;
  assert.equal(calls.length, 2);
  assert.ok(calls[1][0].endsWith("?lang=en"));
  assert.equal(context.srtText, "repaired subtitles");

  // A proxy error is logged without JSON SyntaxError or discarding the SRT.
  context.fetch = async () => new Response("Internal Server Error", { status: 500 });
  await execute();
  assert.ok(logs.at(-1).includes("HTTP 500"));
  assert.equal(context.srtText, "repaired subtitles");

  // A stale/paused runner must not fetch patched content or continue its chain.
  let downloads = 0;
  context.fetch = async () => { downloads++; return new Response('{"job_id":"repair"}'); };
  context.pollJob = async () => ({ status: "done" });
  context.isStaleRun = () => true;
  await execute();
  assert.equal(downloads, 1);
  assert.deepEqual(cancellations, ["repair"]);

  // Pause while polling also prevents downloads and subsequent processing.
  downloads = 0;
  let stale = false;
  context.isStaleRun = () => stale;
  context.pollJob = async () => { stale = true; return { status: "done" }; };
  await execute();
  assert.equal(downloads, 1);
  console.log("Retranslation: JSON/proxy errors, background job polling, language/source selection and pause guards OK");
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
