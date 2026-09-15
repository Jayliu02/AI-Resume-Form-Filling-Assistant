const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function context() {
  const c = vm.createContext({ console, TextEncoder, crypto: webcrypto, structuredClone,
    Blob, Response, CompressionStream, DecompressionStream, btoa, atob });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/resume-sync.js"), "utf8"), c);
  return c;
}
const S = context().ResumeSync;
const template = (name = "简历", text = "原始简历") => ({ id: "tpl-default", name, profile: { personal: { name: text } }, rawText: text, schemaVersion: 1 });
const initial = async () => S.seed({ "tpl-default": template() });
async function edit(records, device, value, bases = {}) {
  const before = S.materialize(records).templates;
  const after = structuredClone(before);
  if (value === null) delete after["tpl-default"];
  else after["tpl-default"] = template("简历", value);
  return (await S.capture({ device, counter: 0, records }, before, after, bases)).records;
}
test("Chinese long resumes round trip; partial and corrupt generations are rejected", async () => {
  const records = await S.seed({ "tpl-default": template("简历", Array.from({length: 9000}, (_, i) => `${i}中文${webcrypto.randomUUID()}`).join("")) });
  const packed = await S.pack(records);
  assert.ok(packed.parts.length > 1);
  const head = { version: 1, digest: packed.digest, count: packed.parts.length, prefix: "part:" };
  const data = Object.fromEntries(packed.parts.map((p, i) => [head.prefix + i, p]).reverse());
  assert.equal(S.stable(await S.unpack(head, data)), S.stable(records));
  const missing = { ...data }; delete missing["part:0"];
  await assert.rejects(S.unpack(head, missing), /尚未到齐/);
  await assert.rejects(S.unpack(head, { ...data, "part:0": "bad" }), /校验失败/);
  await assert.rejects(S.unpack({ ...head, version: 2 }, data), /清单格式/);
});
test("concurrent edits converge and produce only one deterministic conflict copy", async () => {
  const base = await initial();
  const a = await edit(base, "device-a", "甲"), b = await edit(base, "device-b", "乙");
  const ab = S.merge(a, b), ba = S.merge(b, a);
  assert.equal(S.stable(ab), S.stable(ba));
  assert.equal(S.stable(S.merge(ab, a)), S.stable(ab));
  const view = S.materialize(ab).templates;
  assert.equal(Object.keys(view).length, 2);
  assert.deepEqual(Object.values(view).map(t => t.rawText).sort(), ["乙", "甲"].sort());
  assert.equal(Object.values(view).filter(t => t.name.includes("冲突副本")).length, 1);
});
test("causal edits replace ancestors and deletion prevents resurrection", async () => {
  const base = await initial(), edited = await edit(base, "a", "更新");
  assert.equal(Object.keys(S.materialize(S.merge(base, edited)).templates).length, 1);
  const removed = await edit(edited, "b", null);
  assert.equal(Object.keys(S.materialize(S.merge(base, removed)).templates).length, 0);
});
test("concurrent deletion retains modified text as a conflict copy", async () => {
  const base = await initial();
  const merged = S.merge(await edit(base, "a", null), await edit(base, "b", "不要丢失"));
  const values = Object.values(S.materialize(merged).templates);
  assert.equal(values.length, 1);
  assert.equal(values[0].rawText, "不要丢失");
  assert.match(values[0].name, /冲突副本/);
});
test("stale editor base preserves remote changes", async () => {
  const base = await initial();
  const bases = { "tpl-default": S.materialize(base).templates["tpl-default"]._syncBase };
  const current = await edit(base, "remote", "远端");
  const stale = await edit(current, "local", "未保存的编辑", bases);
  assert.equal(Object.keys(S.materialize(stale).templates).length, 2);
});
test("identical initial templates deduplicate and empty placeholder is skipped", async () => {
  assert.equal(S.stable(await initial()), S.stable(await initial()));
  assert.equal(Object.keys(await S.seed({ "tpl-default": { id: "tpl-default", name: "默认简历", profile: { name: "" }, rawText: "" } })).length, 0);
});
test("quota counts UTF-8, temporary generations, individual items and key count", () => {
  assert.equal(S.quota({ a: "中" }), 6);
  assert.throws(() => S.quota({ a: "中".repeat(3000) }), /容量不足/);
  assert.throws(() => S.quota(Object.fromEntries(Array.from({length: 16}, (_, i) => ["k" + i, "x".repeat(7000)]))), /容量不足/);
  assert.throws(() => S.quota(Object.fromEntries(Array.from({length: 513}, (_, i) => ["k" + i, ""]))), /容量不足/);
});

function event() {
  const handlers = [];
  return { handlers, addListener(fn) { handlers.push(fn); } };
}
function area(state) {
  return {
    state, fail: false,
    async get(keys) {
      if (keys == null) return structuredClone(state);
      return Object.fromEntries([].concat(keys).filter(k => k in state).map(k => [k, structuredClone(state[k])]));
    },
    async set(values) { if (this.fail) throw new Error("模拟断网写入失败"); Object.assign(state, structuredClone(values)); },
    async remove(keys) { for (const k of [].concat(keys)) delete state[k]; },
    async getBytesInUse() { return S.quota(state); },
  };
}
function device(remote, saved) {
  const c = context();
  const storage = { local: area(saved || { resumeTemplates: { "tpl-default": template() }, activeResumeTemplateId: "tpl-default" }), sync: remote, onChanged: event() };
  const alarms = new Map();
  c.chrome = { storage,
    runtime: { id: "test", getURL: p => "chrome-extension://test/" + p, onMessage: event(), onStartup: event() },
    alarms: { async create(k, v) { alarms.set(k, v); }, async clear(k) { alarms.delete(k); }, onAlarm: event() },
  };
  c.setTimeout = () => 1; c.clearTimeout = () => {};
  for (const file of ["resume-storage.js", "resume-sync-worker.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/" + file), "utf8"), c);
  async function request(message, sender = { id: "test", url: "chrome-extension://test/popup.html" }) {
    const response = await new Promise(resolve => c.chrome.runtime.onMessage.handlers[0](message, sender, resolve));
    if (!response.ok) throw new Error(response.error);
    return response.value;
  }
  const call = (method, args = [], bases = {}) => request({ action: "resumeStorage", method, args, bases });
  const control = (command = "retry", enabled = true) => request({ action: "resumeSync", command, enabled });
  return { c, storage, alarms, call, control, request };
}
test("two workers sync, preserve local settings, recover durable failure after restart", async () => {
  const remote = area({});
  const a = device(remote), b = device(remote);
  await a.call("loadTemplateState"); await b.call("loadTemplateState");
  await a.storage.local.set({ apiKey: "secret", modelConfigs: { private: true } });
  await a.control("enable"); await b.control("enable");
  await a.call("saveTemplateContent", ["tpl-default", { rawText: "设备甲更新", profile: { name: "甲" } }]);
  remote.fail = true;
  const failed = await a.control();
  assert.equal(failed.pending, true);
  assert.equal(a.alarms.size, 1);
  const restarted = device(remote, a.storage.local.state);
  remote.fail = false;
  await restarted.control(); await b.control();
  const state = await b.call("loadTemplateState");
  assert.equal(state.templates[0].rawText, "设备甲更新");
  assert.equal((await restarted.control()).pending, false);
  for (const [key, head] of Object.entries(remote.state)) {
    if (!key.includes("head:")) continue;
    const payload = S.stable(await S.unpack(head, remote.state));
    assert.ok(!payload.includes("secret")); assert.ok(!payload.includes("modelConfigs"));
  }
  await restarted.control("enable", false);
  await restarted.call("saveTemplateContent", ["tpl-default", { rawText: "仅本机" }]);
  const previous = S.stable(remote.state);
  await restarted.control();
  assert.equal(S.stable(remote.state), previous);
});
test("worker serializes page writes, preserves stale deleted edits and restricts page access", async () => {
  const d = device(area({}));
  const first = await d.call("loadTemplateState");
  const t = first.templates[0], bases = { [t.id]: { ...t._syncBase, template: t } };
  await Promise.all([d.call("createTemplate", ["一"]), d.call("createTemplate", ["二"])]);
  assert.equal((await d.call("loadTemplateState")).templates.length, 3);
  await d.call("deleteTemplate", [t.id]);
  await d.call("saveTemplateContent", [t.id, { profile: { name: "未保存" }, rawText: "保留" }], bases);
  const after = await d.call("loadTemplateState");
  assert.ok(after.templates.some(t => t.rawText === "保留" && t.name.includes("冲突副本")));
  await assert.rejects(d.request({ action: "resumeStorage", method: "loadTemplateState" }, { id: "test", url: "https://example.com" }), /不允许/);
  const backup = await d.call("exportTemplateData");
  assert.ok(backup.templates.every(t => !t._syncBase));
});

function pageClient(d) {
  const c = vm.createContext({ document: {}, console, window: { chrome: { runtime: {
    async sendMessage(message) {
      try { return { ok: true, value: await d.request(message) }; }
      catch (error) { return { ok: false, error: error.message }; }
    },
  } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/resume-storage.js"), "utf8"), c);
  return c.window.ResumeStorage;
}
test("page client advances its saved base without reloading and two stale pages conflict", async () => {
  const d = device(area({}));
  const a = pageClient(d), b = pageClient(d);
  await a.loadTemplateState(); await b.loadTemplateState();
  await a.saveTemplateContent("tpl-default", { rawText: "第一次" });
  await a.saveTemplateContent("tpl-default", { rawText: "第二次" });
  assert.equal((await d.call("loadTemplateState")).templates.length, 1);
  const saved = await b.saveTemplateContent("tpl-default", { rawText: "旧窗口" });
  assert.equal(saved._syncConflict, true);
  const exported = await a.exportTemplateData();
  assert.equal(exported.templates.length, 2);
  assert.deepEqual(Array.from(exported.templates, t => t.rawText).sort(), ["旧窗口", "第二次"].sort());
});
test("deleting final template creates a local placeholder, not a remote blank resume", async () => {
  const remote = area({}), a = device(remote), b = device(remote);
  await a.control("enable"); await b.control("enable");
  await a.call("deleteTemplate", ["tpl-default"]);
  await a.control(); await b.control();
  const state = await b.call("loadTemplateState");
  assert.equal(state.templates.length, 1);
  assert.equal(state.templates[0].name, "默认简历");
  assert.equal(state.templates[0].rawText, "");
  assert.equal(Object.keys(S.materialize(b.storage.local.state[S.STATE].records).templates).length, 0);
});
test("interrupted publication never applies partial data and recovers on retry", async () => {
  const remote = area({}), a = device(remote), b = device(remote);
  await a.control("enable"); await b.control("enable");
  await a.call("saveTemplateContent", ["tpl-default", { rawText: "完整新版本" }]);
  const set = remote.set;
  remote.set = async function (values) {
    if (Object.keys(values).some(k => k.startsWith(S.PREFIX + "head:"))) throw new Error("中断清单提交");
    return set.call(this, values);
  };
  assert.equal((await a.control()).pending, true);
  await b.control();
  assert.equal((await b.call("loadTemplateState")).templates[0].rawText, "原始简历");
  remote.set = set;
  await a.control(); await b.control();
  assert.equal((await b.call("loadTemplateState")).templates[0].rawText, "完整新版本");
});
test("quota failure keeps complete local resume and previous published generation", async () => {
  const remote = area({}), a = device(remote);
  await a.control("enable");
  const previousHeads = S.stable(Object.fromEntries(Object.entries(remote.state).filter(([k]) => k.includes("head:"))));
  const long = Array.from({length: 4000}, () => webcrypto.randomUUID()).join("");
  await a.call("saveTemplateContent", ["tpl-default", { rawText: long }]);
  const failed = await a.control();
  assert.match(failed.error, /容量不足/);
  assert.equal((await a.call("loadTemplateState")).templates[0].rawText, long);
  assert.equal(S.stable(Object.fromEntries(Object.entries(remote.state).filter(([k]) => k.includes("head:")))), previousHeads);
});
