const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
function worker(localData = {}, syncData = {}) {
  const listeners = [], calls = { reads: 0, removed: [], alarms: [] };
  const fail = { cloud: false, write: false };
  function area(data, cloud) {
    return {
      async get(keys) { if (cloud) calls.reads++; return structuredClone(keys == null ? data : Object.fromEntries([].concat(keys).filter(k => k in data).map(k => [k, data[k]]))); },
      async set(value) { if (fail.write) throw new Error("QUOTA"); Object.assign(data, structuredClone(value)); },
      async remove(keys) { if (cloud && fail.cloud) throw new Error("offline"); for (const key of keys) { delete data[key]; if (cloud) calls.removed.push(key); } },
    };
  }
  const chrome = { storage: { local: area(localData), sync: area(syncData, true) }, alarms: { async clear(name) { calls.alarms.push(name); } }, runtime: { id: "ext", getURL: p => `chrome-extension://ext/${p}`, onMessage: { addListener(fn) { listeners.push(fn); } } } };
  const c = vm.createContext({ chrome, crypto: webcrypto, structuredClone, console, URL });
  for (const file of ["resume-schema", "resume-storage", "resume-suggestions", "resume-documents", "resume-local-worker"]) vm.runInContext(fs.readFileSync(path.join(__dirname, `../shared/${file}.js`), "utf8"), c);
  const sender = { id: "ext", url: chrome.runtime.getURL("resume-editor.html") };
  async function message(request, from = sender) { return new Promise(resolve => listeners[0](request, from, resolve)); }
  async function call(method, args = [], bases = {}, observedActiveId) {
    const r = await message({ action: "resumeStorage", method, args, bases, observedActiveId });
    if (!r.ok) throw new Error(r.error); return r.value;
  }
  return { c, localData, syncData, calls, fail, message, call, chrome };
}
const bases = state => Object.fromEntries(state.templates.map(t => [t.id, { template: t }]));
test("retirement deletes only cloud resume keys, verifies and never uploads or reads again", async () => {
  const w = worker({ resumeSyncState: { enabled: true }, models: ["keep"] }, { "resumeSyncV1:part:a": "secret", resumeProfile: { name: "old" }, models: "keep", setting: true });
  const r = await w.message({ action: "resumeCloudCleanup" });
  assert.equal(r.value.complete, true);
  assert.deepEqual(w.syncData, { models: "keep", setting: true });
  assert.deepEqual(w.localData.models, ["keep"]);
  assert.equal(w.localData.resumeSyncState, undefined);
  assert.ok(w.calls.alarms.includes("resume-sync-retry"));
  const reads = w.calls.reads;
  await w.call("loadTemplateState"); await w.message({ action: "resumeCloudCleanup" });
  assert.equal(w.calls.reads, reads);
});
test("failed cleanup is retryable and local operations stay available", async () => {
  const w = worker({}, { "resumeSyncV1:head:a": {} }); w.fail.cloud = true;
  const r = await w.message({ action: "resumeCloudCleanup" });
  assert.equal(r.value.complete, false);
  assert.ok((await w.call("loadTemplateState")).templates.length);
  w.fail.cloud = false;
  assert.equal((await w.message({ action: "resumeCloudCleanup" })).value.complete, true);
});
test("two stale editors retain independent custom fields and advance their saved base", async () => {
  const w = worker(); const initial = await w.call("loadTemplateState"), id = initial.activeTemplateId;
  const make = label => w.c.ResumeSchema.updateSectionFields({}, "personal", [{ key: "custom_note", label, input: "text", placeholder: "" }]);
  const a = await w.call("saveTemplateContent", [id, { profile: make("A") }], bases(initial));
  const b = await w.call("saveTemplateContent", [id, { profile: make("B") }], bases(initial));
  assert.equal(b._localConflict, true); assert.notEqual(a.id, b.id);
  const current = await w.call("loadTemplateState");
  assert.equal(current.templates.length, 2);
  assert.deepEqual(Array.from(current.templates, t => t.profile.fieldConfig.sections[0].fields[0].label).sort(), ["A", "B"]);
  await w.call("saveTemplateContent", [b.id, { rawText: "edited" }], bases(current));
  assert.equal((await w.call("loadTemplateState")).templates.length, 2);
});
test("deleted resume edited by stale page becomes a copy; stale deletion is rejected", async () => {
  const w = worker(), initial = await w.call("loadTemplateState"), id = initial.activeTemplateId;
  const saved = await w.call("saveTemplateContent", [id, { rawText: "changed" }], bases(initial));
  await assert.rejects(w.call("deleteTemplate", [id], bases(initial)), /重新加载/);
  const latest = await w.call("loadTemplateState");
  await w.call("deleteTemplate", [id], bases(latest));
  const copy = await w.call("saveTemplateContent", [id, { rawText: "stale edit" }], { [id]: { template: saved } });
  assert.equal(copy._localConflict, true); assert.equal(copy.rawText, "stale edit");
});
test("quota failure does not partially persist conflict copies", async () => {
  const w = worker(), initial = await w.call("loadTemplateState"), id = initial.activeTemplateId;
  await w.call("saveTemplateContent", [id, { rawText: "first" }], bases(initial));
  const before = JSON.stringify(w.localData.resumeTemplates); w.fail.write = true;
  await assert.rejects(w.call("saveTemplateContent", [id, { rawText: "second" }], bases(initial)), /QUOTA/);
  assert.equal(JSON.stringify(w.localData.resumeTemplates), before);
});
test("storage and cleanup reject website content scripts and allow the document page", async () => {
  const w = worker();
  assert.equal((await w.message({ action: "resumeCloudCleanup" }, { id: "ext", url: "https://example.com" })).ok, false);
  assert.equal((await w.message({ action: "resumeDocuments", method: "list" }, { id: "ext", url: "chrome-extension://ext/resume-documents.html?sourceTabId=1" })).ok, true);
});
test("single resume import targets the editor's observed template", async () => {
  const w = worker(), initial = await w.call("loadTemplateState"), id = initial.activeTemplateId;
  const other = await w.call("createTemplate", ["other"]);
  await w.call("setActiveTemplateId", [other.id]);
  const saved = await w.call("importActiveTemplateData", [{ profile: {}, rawText: "imported" }], bases(initial), id);
  assert.equal(saved.id, id);
  assert.equal(w.localData.resumeTemplates[id].rawText, "imported");
  assert.equal(w.localData.resumeTemplates[other.id].rawText, "");
});
test("new template results and client saved bases stay aligned with normalized storage", async () => {
  const w = worker(); await w.call("loadTemplateState");
  const created = await w.call("createTemplate", ["New"]);
  const saved = await w.call("saveTemplateContent", [created.id, { rawText: "first edit" }], { [created.id]: { template: created } });
  assert.equal(saved._localConflict, undefined);
  const client = vm.createContext({ document: {}, window: {}, console, chrome: { runtime: { sendMessage: request => w.message(request) } } });
  client.window.chrome = client.chrome;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/resume-storage.js"), "utf8"), client);
  const api = client.window.ResumeStorage;
  await api.loadTemplateState();
  await api.saveTemplateContent(created.id, { rawText: "second edit" });
  const third = await api.saveTemplateContent(created.id, { rawText: "third edit" });
  assert.equal(third._localConflict, undefined);
  assert.equal(w.localData.resumeTemplates[created.id].rawText, "third edit");
});
test("worker serializes duplicate approval requests and rejects subsequent stale approvals", async () => {
  const w = worker(), state = await w.call("loadTemplateState"), template = state.templates[0];
  const pages = [{ id: "p", title: "Page", url: "https://example.com", fields: [{ id: "f", label: "Name" }] }];
  const item = w.c.ResumeSuggestions.normalize([{ kind: "set_value", sectionKey: "personal", fieldKey: "fullName", value: "Approved", evidence: ["p/f"] }], pages)[0];
  const doc = { version: 1, id: "approval-doc", pages, review: { id: "batch", baseTemplate: w.c.ResumeSuggestions.snapshot(template), items: [item] } };
  const request = { action: "resumeDocuments", method: "applySuggestions", document: doc, selectedIds: [item.id] };
  const results = await Promise.all([w.message(request), w.message(request)]);
  assert.ok(results.every(r => r.ok));
  assert.equal(results.filter(r => r.value.alreadyApplied).length, 1);
  assert.equal(w.localData.resumeRequirementDocumentsV1[0].approvals.length, 1);
  assert.equal(w.localData.resumeTemplates[template.id].profile.personal.fullName, "Approved");
  doc.id = "another-doc"; doc.review.id = "another-batch";
  const stale = await w.message({ ...request, document: doc });
  assert.equal(stale.ok, false); assert.match(stale.error, /已改变或删除/);
});
