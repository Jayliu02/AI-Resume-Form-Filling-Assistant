const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
function setup() {
  const c = vm.createContext({ URL, crypto: webcrypto, structuredClone });
  for (const file of ["resume-schema", "resume-suggestions", "resume-documents"]) vm.runInContext(fs.readFileSync(path.join(__dirname, `../shared/${file}.js`), "utf8"), c);
  const data = {};
  const local = { async get(k) { return structuredClone({ [k]: data[k] }); }, async set(values) { Object.assign(data, structuredClone(values)); } };
  return { D: c.ResumeDocuments, local, data };
}
function sample() {
  return { version: 1, id: "doc", title: "Recruiting", pages: [{ id: "page1", title: "Page 1", url: "https://example.com/form?token=secret#private", fields: [{ id: "f1", label: "Email", type: "email", required: true, value: "private@example.com", constraints: { maxlength: "100" } }] }], analysis: { summary: "One requirement", requirements: [{ section: "Contact", requirement: "Email required", evidence: ["page1/f1"], resumePath: "personal.email", status: "missing", suggestion: "Add email" }] } };
}
test("document normalization excludes values, arbitrary HTML and URL secrets", () => {
  const { D } = setup(); const input = sample(); input.html = "<script>evil</script>";
  const doc = D.document(input); const text = JSON.stringify(doc);
  assert.equal(doc.pages[0].url, "https://example.com/form");
  for (const secret of ["private@example.com", "token", "private", "<script>"]) assert.ok(!text.includes(secret));
  assert.equal(doc.pages[0].fields[0].constraints.maxlength, "100");
});
test("analysis rejects invented evidence, invalid paths and statuses without changing previous results", () => {
  const { D } = setup(), doc = D.document(sample()); const before = JSON.stringify(doc);
  for (const patch of [{ evidence: ["fake/f1"] }, { resumePath: "secrets.key" }, { status: "guessed" }]) {
    const bad = structuredClone(doc.analysis); Object.assign(bad.requirements[0], patch);
    assert.throws(() => D.validateAnalysis(bad, doc.pages, new Set(["personal.email"])));
  }
  assert.equal(JSON.stringify(doc), before);
  assert.throws(() => D.validateAnalysis({}, doc.pages));
  assert.throws(() => D.validateAnalysis({ summary: "Omitted", requirements: [] }, doc.pages), /遗漏/);
});
test("save/reload/export/import preserves multiple pages and creates import copies", async () => {
  const { D, local } = setup(); const doc = sample();
  doc.pages.push({ ...structuredClone(doc.pages[0]), id: "page2", title: "Second step" });
  doc.analysis.requirements[0].evidence.push("page2/f1");
  const saved = await D.dispatch({ method: "save", document: doc }, local);
  const exported = await D.dispatch({ method: "export" }, local);
  await D.dispatch({ method: "import", data: JSON.parse(JSON.stringify(exported)) }, local);
  const list = await D.dispatch({ method: "list" }, local);
  assert.equal(list.length, 2); assert.notEqual(list[0].id, list[1].id);
  assert.equal(list[0].pages.length, 2);
  assert.equal(list[0].analysis.requirements[0].evidence[0], "page1/f1");
  const stale = await D.dispatch({ method: "save", document: { ...saved, title: "stale" }, baseUpdatedAt: "old" }, local);
  assert.notEqual(stale.id, saved.id);
  await assert.rejects(D.dispatch({ method: "delete", id: saved.id, baseUpdatedAt: "old" }, local), /已更新/);
});
test("invalid import and quota failure leave saved documents intact", async () => {
  const { D, local, data } = setup(); await D.dispatch({ method: "save", document: sample() }, local);
  const before = JSON.stringify(data);
  await assert.rejects(D.dispatch({ method: "import", data: { kind: "resume-requirement-documents", version: 1, documents: [sample(), { version: 2 }] } }, local));
  assert.equal(JSON.stringify(data), before);
  const fail = { get: local.get, async set() { throw new Error("QUOTA"); } };
  await assert.rejects(D.dispatch({ method: "save", document: sample() }, fail), /导出当前结果/);
  assert.equal(JSON.stringify(data), before);
});
test("Markdown escapes untrusted markup and includes evidence, suggestions and unknown state", () => {
  const { D } = setup(), doc = D.document(sample()); doc.title = '<img src=x onerror="alert(1)">';
  const md = D.markdown(doc);
  assert.ok(!md.includes("<img")); assert.ok(md.includes("page1/f1")); assert.ok(md.includes("Add email"));
  assert.ok(md.includes("尚未分析"));
});
test("oversized AI requests fail instead of silently truncating requirements", () => {
  const { D } = setup(); assert.throws(() => D.buildPrompt(sample(), [{ value: "x".repeat(180000) }]), /拆分/);
  const prompt = JSON.parse(D.buildPrompt(sample(), [{ path: "personal.email", value: "" }]));
  assert.equal(prompt.pages.length, 1); assert.equal(prompt.resumeFields[0].path, "personal.email");
});
test("repeated requirements merge sources but retain distinct constraints, values and records", () => {
  const { D } = setup(), doc = sample();
  const page2 = { ...structuredClone(doc.pages[0]), id: "page2" };
  const a = doc.analysis.requirements[0], b = { ...a, evidence: ["page2/f1"] };
  let result = D.compactRequirements([a, b], [doc.pages[0], page2]);
  assert.equal(result.length, 1); assert.equal(result[0].evidence.length, 2);
  page2.fields[0].constraints.maxlength = "200";
  assert.equal(D.compactRequirements([a, b], [doc.pages[0], page2]).length, 2);
  page2.fields[0].constraints.maxlength = "100"; page2.fields[0].value = "different";
  assert.equal(D.compactRequirements([a, b], [doc.pages[0], page2]).length, 2);
  const samePage = structuredClone(doc.pages[0]); samePage.fields.push({ ...samePage.fields[0], id: "f2" });
  assert.equal(D.compactRequirements([a, { ...a, evidence: ["page1/f2"] }], [samePage]).length, 2);
});
test("captured values survive backup and prompts; old documents remain explicitly uncaptured", async () => {
  const { D, local } = setup(), input = sample();
  input.pages[0].fields[0].valueCaptured = true;
  const saved = await D.dispatch({ method: "save", document: input }, local);
  assert.equal(saved.pages[0].fields[0].value, "private@example.com");
  assert.ok(D.markdown(saved).includes("private@example"));
  assert.ok(D.buildPrompt(saved, []).includes("private@example.com"));
  assert.equal(D.document(sample()).pages[0].fields[0].valueCaptured, false);
  input.pages[0].fields[0].type = "password";
  assert.equal(D.document(input).pages[0].fields[0].value, undefined);
});
test("analysis parser accepts prose, fences, BOM, thinking blocks and trailing commas without corrupting strings", () => {
  const { D } = setup();
  const value = sample().analysis; value.summary = 'literal ,} and quoted "text"';
  const json = JSON.stringify(value);
  for (const raw of [json, '\uFEFF' + json, '说明：\n```json\n' + json + '\n```\n说明 {additional.notes}', '<think>{"summary":"not the answer","requirements":[]}</think>' + json, json.slice(0, -1) + ',}']) {
    assert.equal(D.parseAnalysis(raw).summary, value.summary);
  }
  assert.throws(() => D.parseAnalysis('{"summary":"incomplete","requirements":['), /完整/);
  assert.throws(() => D.parseAnalysis('no JSON'), /JSON/);
});
test("analysis batches fields, retries invalid JSON once and validates combined coverage", async () => {
  const { D } = setup(), doc = sample();
  doc.pages[0].fields = Array.from({ length: 45 }, (_, i) => ({ ...doc.pages[0].fields[0], id: 'f' + i, valueCaptured: true, value: 'web value' }));
  const original = JSON.stringify(doc); let calls = 0; const sizes = [];
  const result = await D.analyze(doc, [], async prompt => {
    calls++;
    if (calls === 1) return 'not JSON';
    const p = JSON.parse(prompt.split('\n上次响应')[0]).pages[0]; sizes.push(p.fields.length);
    return JSON.stringify({ summary: 'done', requirements: p.fields.map(f => ({ section: '', requirement: f.label, evidence: [p.id + '/' + f.id], resumePath: '', status: 'review', suggestion: '' })) });
  });
  assert.equal(calls, 4); assert.deepEqual(sizes, [20, 20, 5]);
  assert.equal(result.requirements.length, 45); assert.equal(JSON.stringify(doc), original);
});
test("truncated model output is split into smaller batches; persistent malformed output fails without partial mutation", async () => {
  const { D } = setup(), doc = sample();
  doc.pages[0].fields.push({ ...doc.pages[0].fields[0], id: 'f2' });
  let calls = 0;
  const result = await D.analyze(doc, [], async prompt => {
    calls++; const p = JSON.parse(prompt).pages[0];
    if (p.fields.length > 1) throw new Error('AI_OUTPUT_TRUNCATED');
    return JSON.stringify({ summary: 'done', requirements: p.fields.map(f => ({ requirement: f.label, evidence: [p.id + '/' + f.id], resumePath: '', status: 'unknown' })) });
  });
  assert.equal(calls, 3); assert.equal(result.requirements.length, 2);
  const original = JSON.stringify(doc); calls = 0;
  await assert.rejects(D.analyze(doc, [], async () => { calls++; return 'broken'; }), /自动重试一次/);
  assert.equal(calls, 2); assert.equal(JSON.stringify(doc), original);
});
