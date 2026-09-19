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
  else after["tpl-default"] = template(before["tpl-default"]?.name || "简历", value);
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
  assert.throws(() => S.quota({ a: "中".repeat(3000) }), { code: "SYNC_QUOTA_EXCEEDED", message: /单项上限 8192/ });
  assert.throws(() => S.quota(Object.fromEntries(Array.from({length: 16}, (_, i) => ["k" + i, "x".repeat(7000)]))), /总容量 100 KB/);
  assert.throws(() => S.quota(Object.fromEntries(Array.from({length: 513}, (_, i) => ["k" + i, ""]))), /数量上限 512/);
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
  for (const file of ["resume-storage.js", "resume-sync-recovery.js", "resume-sync-worker.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/" + file), "utf8"), c);
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

for (const deleted of [false, true]) {
  test(`conflict rename survives reload, edits and remote sync (deleted sibling: ${deleted})`, async () => {
    const base = await S.seed({ "tpl-default": template("默认简历") });
    const left = await edit(base, "a", deleted ? null : "原简历内容");
    const right = await edit(base, "b", "副本内容");
    const records = S.merge(left, right);
    const view = S.materialize(records).templates;
    const conflict = Object.values(view).find(t => t.id.includes("~conflict~"));
    assert.equal(conflict.name, "默认简历（冲突副本）");
    const state = { device: "z", counter: 0, enabled: false, records, pending: false };
    const remote = area({});
    const d = device(remote, { [S.STATE]: state, resumeTemplates: view, activeResumeTemplateId: conflict.id });
    const page = pageClient(d);
    await page.loadTemplateState();
    const renamed = await page.renameTemplate(conflict.id, "默认简历");
    assert.equal(renamed.name, "默认简历");
    assert.equal(renamed.rawText, "副本内容");
    assert.notEqual(renamed.id, conflict.id);
    const loaded = await page.loadTemplateState();
    assert.equal(loaded.activeTemplateId, renamed.id);
    assert.equal(loaded.templates.find(t => t.id === renamed.id).name, "默认简历");
    assert.equal(loaded.templates.length, deleted ? 1 : 2);
    const saved = await page.saveTemplateContent(renamed.id, { rawText: "副本继续编辑" });
    assert.equal(saved.name, "默认简历");
    await d.control("enable");
    const other = device(remote, { resumeTemplates: {}, activeResumeTemplateId: "" });
    await other.control("enable");
    const synced = await other.call("loadTemplateState");
    assert.equal(synced.templates.find(t => t.rawText === "副本继续编辑").name, "默认简历");
    assert.equal(synced.templates.length, deleted ? 1 : 2);
    if (!deleted) assert.ok(synced.templates.some(t => t.rawText === "原简历内容"));
    const restarted = device(remote, structuredClone(d.storage.local.state));
    const reloaded = await restarted.call("loadTemplateState");
    assert.equal(reloaded.templates.find(t => t.rawText === "副本继续编辑").name, "默认简历");
  });
}

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

test("receiving a large published resume does not upload a duplicate snapshot", async () => {
  const remote = area({}), a = device(remote);
  const long = Array.from({length: 2500}, () => webcrypto.randomUUID()).join("");
  await a.call("saveTemplateContent", ["tpl-default", { rawText: long }]);
  assert.equal((await a.control("enable")).pending, false);
  assert.ok(S.quota(remote.state) > 51200);
  const published = S.stable(remote.state);
  const b = device(remote, { resumeTemplates: {}, activeResumeTemplateId: "" });
  const received = await b.control("enable");
  assert.equal(received.pending, false);
  assert.ok(received.lastReceivedAt);
  assert.equal(received.lastPublishedAt, undefined);
  assert.equal((await b.call("loadTemplateState")).templates[0].rawText, long);
  assert.equal(S.stable(remote.state), published);
  await b.control();
  assert.equal(S.stable(remote.state), published);
});

test("a receiving device can later publish edits and deletion without reviving old content", async () => {
  const remote = area({}), a = device(remote);
  await a.control("enable");
  const b = device(remote, { resumeTemplates: {}, activeResumeTemplateId: "" });
  await b.control("enable");
  await b.call("saveTemplateContent", ["tpl-default", { rawText: "接收设备的新修改" }]);
  assert.equal((await b.control()).pending, false);
  await a.control();
  assert.equal((await a.call("loadTemplateState")).templates[0].rawText, "接收设备的新修改");
  await b.call("deleteTemplate", ["tpl-default"]);
  await b.control(); await a.control();
  const c = device(remote, { resumeTemplates: {}, activeResumeTemplateId: "" });
  await c.control("enable");
  assert.equal(Object.keys(S.materialize(c.storage.local.state[S.STATE].records).templates).length, 0);
});

test("remote union retains concurrent branches without another full snapshot", async () => {
  const left = area({}), a = device(left);
  await a.control("enable");
  const right = area(structuredClone(left.state));
  const b = device(right, { resumeTemplates: {}, activeResumeTemplateId: "" });
  await b.control("enable");
  await a.call("saveTemplateContent", ["tpl-default", { rawText: "并发甲" }]);
  await b.call("saveTemplateContent", ["tpl-default", { rawText: "并发乙" }]);
  await a.control(); await b.control();
  const bOwner = S.PREFIX + "head:" + b.storage.local.state[S.STATE].device;
  const bHead = right.state[bOwner];
  await left.set(Object.fromEntries(Object.entries(right.state).filter(([k]) => k === bOwner || k.startsWith(bHead.prefix))));
  const published = S.stable(left.state);
  await a.control();
  assert.deepEqual(Array.from((await a.call("loadTemplateState")).templates, t => t.rawText).sort(), ["并发乙", "并发甲"].sort());
  assert.equal(S.stable(left.state), published);
});

test("quota failure refreshes usage and reports temporary peak even when final data fits", async () => {
  const remote = area({}), a = device(remote);
  const randomText = () => Array.from({length: 1400}, () => webcrypto.randomUUID()).join("");
  await a.call("saveTemplateContent", ["tpl-default", { rawText: randomText() }]);
  const first = await a.control("enable");
  assert.equal(first.pending, false);
  const fillerKeys = [];
  while (S.quota(remote.state) < 75 * 1024) {
    const key = "unrelated-" + fillerKeys.length;
    fillerKeys.push(key);
    await remote.set({ [key]: "x".repeat(6000) });
  }
  const previous = S.stable(remote.state);
  const long = randomText();
  await a.call("saveTemplateContent", ["tpl-default", { rawText: long }]);
  const failed = await a.control();
  assert.equal(failed.errorCode, "SYNC_QUOTA_EXCEEDED");
  assert.equal(failed.bytes, await remote.getBytesInUse());
  assert.ok(failed.bytes > first.bytes);
  assert.ok(failed.capacity.peakBytes > 102400);
  assert.ok(failed.capacity.finalBytes < 102400);
  assert.equal(failed.capacity.currentBytes, failed.bytes);
  assert.equal(failed.lastPublishedAt, first.lastPublishedAt);
  assert.equal(S.stable(remote.state), previous);
  assert.equal((await a.call("loadTemplateState")).templates[0].rawText, long);
  await remote.remove(fillerKeys);
  const recovered = await a.control();
  assert.equal(recovered.pending, false);
  assert.equal(recovered.capacity, null);
  assert.equal(recovered.errorCode, null);
  assert.equal(recovered.bytes, await remote.getBytesInUse());
});

test("failed usage measurement hides stale successful reading and preserves sync error", async () => {
  const remote = area({}), a = device(remote);
  await a.control("enable");
  await a.call("saveTemplateContent", ["tpl-default", { rawText: "待上传" }]);
  remote.fail = true;
  remote.getBytesInUse = async () => { throw new Error("读取占用失败"); };
  const failed = await a.control();
  assert.equal(failed.bytes, null);
  assert.match(failed.message, /模拟断网写入失败/);
  assert.equal(failed.pending, true);
  remote.get = async () => { throw new Error("读取同步数据失败"); };
  const next = await a.control();
  assert.equal(next.capacity, null);
  assert.equal(next.bytes, null);
  assert.match(next.message, /读取同步数据失败/);
});

function boundedRemote(initial = {}) {
  const remote = area(initial), set = remote.set;
  remote.set = async function (values) {
    S.quota({ ...this.state, ...values });
    return set.call(this, values);
  };
  return remote;
}
const recoveryRequest = (d, command, token) => d.request({ action: "resumeSync", command, token });

test("quota exhaustion stops alarms and storage-change retry loops until an explicit retry or edit", async () => {
  const remote = boundedRemote(), a = device(remote);
  await a.control("enable");
  await a.call("saveTemplateContent", ["tpl-default", { rawText: Array.from({length: 4000}, () => webcrypto.randomUUID()).join("") }]);
  const failed = await a.control();
  assert.equal(a.storage.local.state[S.STATE].quotaBlocked, true);
  assert.equal(a.alarms.size, 0);
  for (const fn of a.c.chrome.storage.onChanged.handlers) fn({ [S.PREFIX + "head:peer"]: {} }, "sync");
  for (const fn of a.c.chrome.alarms.onAlarm.handlers) fn({ name: "resume-sync-retry" });
  await a.control("status");
  assert.equal(a.alarms.size, 0);
  assert.equal(a.storage.local.state[S.STATE].failures, 1);
  assert.match(failed.message, /暂停自动重试/);
  const restarted = device(remote, structuredClone(a.storage.local.state));
  await restarted.control("status");
  assert.equal(restarted.alarms.size, 0);
  await restarted.call("saveTemplateContent", ["tpl-default", { rawText: "缩短" }]);
  assert.equal(restarted.storage.local.state[S.STATE].quotaBlocked, false);
  assert.equal((await restarted.control()).pending, false);
});

test("explicit backed-up rebuild breaks the greater-than-half-full staging deadlock", async () => {
  const remote = boundedRemote({ unrelated: "keep" }), a = device(remote);
  const randomText = () => Array.from({length: 2200}, () => webcrypto.randomUUID()).join("");
  await a.call("saveTemplateContent", ["tpl-default", { rawText: randomText() }]);
  assert.equal((await a.control("enable")).pending, false);
  const before = S.stable(remote.state);
  assert.ok(S.quota(remote.state) > 51200);
  const current = randomText();
  await a.call("saveTemplateContent", ["tpl-default", { rawText: current }]);
  assert.equal((await a.control()).errorCode, "SYNC_QUOTA_EXCEEDED");
  await a.storage.local.set({ apiKey: "local-secret", modelConfigs: { private: true } });
  const prepared = await recoveryRequest(a, "prepareRebuild");
  assert.equal(S.stable(remote.state), before);
  assert.equal(prepared.backup.templates[0].rawText, current);
  assert.ok(!JSON.stringify(prepared.backup).includes("local-secret"));
  assert.equal(a.storage.local.state[S.STATE].enabled, false);
  await assert.rejects(recoveryRequest(a, "rebuild", "wrong-token"), /先生成恢复备份/);
  assert.equal(S.stable(remote.state), before);
  const done = await recoveryRequest(a, "rebuild", prepared.token);
  assert.equal(done.pending, false);
  assert.equal(a.storage.local.state[S.STATE].recovery, null);
  assert.equal(remote.state[S.GENERATION].phase, "ready");
  assert.equal(remote.state.unrelated, "keep");
  assert.equal(a.storage.local.state.apiKey, "local-secret");
  assert.equal(S.materialize(await S.readRecords(remote.state)).templates["tpl-default"].rawText, current);
  assert.ok(S.quota(remote.state) < 102400);
  const backedUpRemote = a.storage.local.state[S.RECOVERY_BACKUP].recovery.remote;
  assert.equal(S.stable(backedUpRemote), S.stable(Object.fromEntries(Object.entries(JSON.parse(before)).filter(([k]) => k.startsWith(S.PREFIX)))));
});

test("stale device pauses instead of restoring removed data and explicitly backs up before adoption", async () => {
  const remote = boundedRemote(), a = device(remote), b = device(remote);
  await a.control("enable"); await b.control("enable");
  await b.control("enable", false);
  await b.call("saveTemplateContent", ["tpl-default", { rawText: "乙离线未上传" }]);
  await a.call("saveTemplateContent", ["tpl-default", { rawText: "甲要保留的版本" }]);
  const prepared = await recoveryRequest(a, "prepareRebuild");
  await recoveryRequest(a, "rebuild", prepared.token);
  const rebuilt = S.stable(remote.state);
  const paused = await b.control("enable");
  assert.equal(paused.enabled, false);
  assert.equal(paused.canAdopt, true);
  assert.equal(S.stable(remote.state), rebuilt);
  assert.equal((await b.call("loadTemplateState")).templates[0].rawText, "乙离线未上传");
  const adoption = await recoveryRequest(b, "prepareAdopt");
  assert.equal(adoption.backup.templates[0].rawText, "乙离线未上传");
  await recoveryRequest(b, "adopt", adoption.token);
  assert.equal((await b.call("loadTemplateState")).templates[0].rawText, "甲要保留的版本");
  assert.equal(S.stable(remote.state), rebuilt);
  await b.call("saveTemplateContent", ["tpl-default", { rawText: "接收后继续编辑" }]);
  await b.control(); await a.control();
  assert.equal((await a.call("loadTemplateState")).templates[0].rawText, "接收后继续编辑");
});

test("rebuild works around corrupt remote chunks and keeps their raw backup", async () => {
  const remote = boundedRemote(), a = device(remote);
  await a.control("enable");
  const missing = Object.keys(remote.state).find(k => k.startsWith(S.PREFIX + "part:"));
  await remote.remove(missing);
  assert.match((await a.control()).error, /分片尚未到齐/);
  const before = S.stable(remote.state);
  const prepared = await recoveryRequest(a, "prepareRebuild");
  assert.equal(S.stable(prepared.backup.recovery.remote), before);
  await recoveryRequest(a, "rebuild", prepared.token);
  assert.equal((await a.control()).pending, false);
});

test("oversized final data or failed local backup never deletes remote data", async () => {
  const remote = boundedRemote(), a = device(remote);
  await a.control("enable");
  const before = S.stable(remote.state);
  await a.call("saveTemplateContent", ["tpl-default", { rawText: Array.from({length: 4000}, () => webcrypto.randomUUID()).join("") }]);
  await assert.rejects(recoveryRequest(a, "prepareRebuild"), /容量不足/);
  assert.equal(S.stable(remote.state), before);
  assert.equal(a.storage.local.state[S.STATE].recovery, undefined);
  await a.call("saveTemplateContent", ["tpl-default", { rawText: "能装下" }]);
  const set = a.storage.local.set;
  a.storage.local.set = async function (values) {
    if (values[S.RECOVERY_BACKUP]) throw new Error("本机备份空间不足");
    return set.call(this, values);
  };
  await assert.rejects(recoveryRequest(a, "prepareRebuild"), /本机备份空间不足/);
  assert.equal(S.stable(remote.state), before);
  assert.equal(a.storage.local.state[S.STATE].recovery, undefined);
});

test("interrupted rebuild survives restart and pauses peers until explicit completion", async () => {
  const remote = boundedRemote(), a = device(remote), b = device(remote);
  await a.control("enable"); await b.control("enable");
  await a.call("saveTemplateContent", ["tpl-default", { rawText: "重建途中不能丢" }]);
  const prepared = await recoveryRequest(a, "prepareRebuild"), set = remote.set;
  remote.set = async function (values) {
    if (Object.keys(values).some(k => k.startsWith(S.PREFIX + "part:"))) throw new Error("上传中断");
    return set.call(this, values);
  };
  await assert.rejects(recoveryRequest(a, "rebuild", prepared.token), /上传中断/);
  assert.equal(remote.state[S.GENERATION].phase, "rebuilding");
  assert.equal(a.storage.local.state[S.STATE].enabled, false);
  assert.equal(a.alarms.size, 0);
  const interrupted = S.stable(remote.state);
  const paused = await b.control();
  assert.equal(paused.enabled, false);
  assert.equal(paused.canAdopt, false);
  assert.equal(S.stable(remote.state), interrupted);
  const restarted = device(remote, structuredClone(a.storage.local.state));
  await restarted.control("status");
  assert.equal(restarted.alarms.size, 0);
  const again = await recoveryRequest(restarted, "prepareRebuild");
  assert.equal(again.token, prepared.token);
  remote.set = set;
  await recoveryRequest(restarted, "rebuild", again.token);
  assert.equal((await b.control("open")).canAdopt, true);
  const adoption = await recoveryRequest(b, "prepareAdopt");
  await recoveryRequest(b, "adopt", adoption.token);
  assert.equal((await b.call("loadTemplateState")).templates[0].rawText, "重建途中不能丢");
});

test("a full sync store can reserve the rebuild fence without clearing unrelated settings", async () => {
  const remote = boundedRemote({ unrelated: "keep" }), a = device(remote);
  await a.control("enable");
  let index = 0;
  while (S.quota(remote.state) < 102400) {
    const key = S.PREFIX + "part:retired:orphan:" + index++;
    const remaining = 102400 - S.quota(remote.state) - key.length - 2;
    if (remaining < 0) break;
    await remote.set({ [key]: "x".repeat(Math.min(7000, remaining)) });
  }
  assert.ok(S.quota(remote.state) > 102350);
  const prepared = await recoveryRequest(a, "prepareRebuild");
  await recoveryRequest(a, "rebuild", prepared.token);
  assert.equal(remote.state.unrelated, "keep");
  assert.ok(S.quota(remote.state) < 2048);
  assert.ok(Object.keys(a.storage.local.state[S.RECOVERY_BACKUP].recovery.remote).some(k => k.includes("retired")));
});

test("adoption rejects local edits or remote generation changes after the backup", async () => {
  const remote = boundedRemote(), a = device(remote), b = device(remote);
  await a.control("enable"); await b.control("enable");
  const first = await recoveryRequest(a, "prepareRebuild");
  await recoveryRequest(a, "rebuild", first.token);
  const adoption = await recoveryRequest(b, "prepareAdopt");
  await b.call("saveTemplateContent", ["tpl-default", { rawText: "备份后的新编辑" }]);
  await assert.rejects(recoveryRequest(b, "adopt", adoption.token), /本机内容已变化/);
  const secondAdoption = await recoveryRequest(b, "prepareAdopt");
  const second = await recoveryRequest(a, "prepareRebuild");
  await recoveryRequest(a, "rebuild", second.token);
  await assert.rejects(recoveryRequest(b, "adopt", secondAdoption.token), /远端重建版本已变化/);
  assert.equal((await b.call("loadTemplateState")).templates[0].rawText, "备份后的新编辑");
});

test("resuming after the ready marker preserves peer edits instead of clearing again", async () => {
  const remote = boundedRemote(), a = device(remote), b = device(remote);
  await a.control("enable"); await b.control("enable");
  const prepared = await recoveryRequest(a, "prepareRebuild");
  const set = a.storage.local.set;
  a.storage.local.set = async function (values) {
    if (values[S.STATE]?.generation === prepared.token && !values[S.STATE].recovery) throw new Error("本机提交中断");
    return set.call(this, values);
  };
  await assert.rejects(recoveryRequest(a, "rebuild", prepared.token), /本机提交中断/);
  assert.equal(remote.state[S.GENERATION].phase, "ready");
  const adoption = await recoveryRequest(b, "prepareAdopt");
  await recoveryRequest(b, "adopt", adoption.token);
  await b.call("saveTemplateContent", ["tpl-default", { rawText: "重建后乙的新编辑" }]);
  await b.control();
  const before = S.stable(remote.state);
  const restarted = device(remote, structuredClone(a.storage.local.state));
  const again = await recoveryRequest(restarted, "prepareRebuild");
  assert.equal(again.token, prepared.token);
  await recoveryRequest(restarted, "rebuild", again.token);
  assert.equal(S.stable(remote.state), before);
  assert.equal((await restarted.call("loadTemplateState")).templates[0].rawText, "重建后乙的新编辑");
});

test("superseded rebuild cannot clear a newer generation and can adopt it instead", async () => {
  const remote = boundedRemote(), a = device(remote), b = device(remote);
  await a.control("enable"); await b.control("enable");
  const stale = await recoveryRequest(a, "prepareRebuild");
  const current = await recoveryRequest(b, "prepareRebuild");
  await recoveryRequest(b, "rebuild", current.token);
  const before = S.stable(remote.state);
  await assert.rejects(recoveryRequest(a, "rebuild", stale.token), /另一设备已重建/);
  assert.equal(S.stable(remote.state), before);
  assert.equal((await a.control("open")).canAdopt, true);
  const adoption = await recoveryRequest(a, "prepareAdopt");
  await recoveryRequest(a, "adopt", adoption.token);
  assert.equal(a.storage.local.state[S.STATE].recovery, null);
  assert.equal(a.storage.local.state[S.STATE].generation, current.token);
});
