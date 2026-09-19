/* All resume mutations and incoming merges run in one service-worker queue.
 * Each device owns its head: simultaneous publishers never overwrite each other.
 * Records use vector clocks; tombstones are retained for offline devices.
 */
(function (root) {
  "use strict";
  const S = root.ResumeSync, R = root.ResumeStorage;
  const ALARM = "resume-sync-retry";
  const methods = new Set(["loadTemplateState", "saveTemplateContent", "createTemplate", "duplicateTemplate", "renameTemplate", "deleteTemplate", "setActiveTemplateId", "exportTemplateData", "importTemplateData", "exportActiveTemplateData", "importActiveTemplateData"]);
  let tail = Promise.resolve(), timer;
  function enqueue(fn) {
    const next = tail.then(fn); tail = next.catch(() => {}); return next;
  }
  async function initialize() {
    const localKeys = [S.STATE, R.keys.templates, R.keys.activeTemplateId];
    let data = await chrome.storage.local.get(localKeys);
    if (!data[S.STATE]) {
      await R.loadTemplateState(chrome.storage);
      data = await chrome.storage.local.get(localKeys);
      data[S.STATE] = { device: crypto.randomUUID(), counter: 0, enabled: false,
        records: await S.seed(data[R.keys.templates]), pending: false, failures: 0 };
      project(data[S.STATE], data);
      await chrome.storage.local.set({ [S.STATE]: data[S.STATE], [R.keys.templates]: data[R.keys.templates], [R.keys.activeTemplateId]: data[R.keys.activeTemplateId] });
    }
    return data;
  }
  function project(state, data) {
    const templates = S.materialize(state.records).templates;
    // A local empty placeholder is not a synchronizable resume.
    if (!Object.keys(templates).length) {
      templates["tpl-default"] = { id: "tpl-default", name: "默认简历", profile: {}, rawText: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
    data[R.keys.templates] = templates;
    if (!templates[data[R.keys.activeTemplateId]]) data[R.keys.activeTemplateId] = Object.keys(templates)[0];
  }
  async function status(patch) {
    const data = await chrome.storage.local.get(S.STATUS);
    await chrome.storage.local.set({ [S.STATUS]: { ...data[S.STATUS], ...patch } });
  }
  async function schedule() {
    clearTimeout(timer);
    // Alarm survives worker suspension; timeout only accelerates active workers.
    await chrome.alarms.create(ALARM, { delayInMinutes: 1 });
    timer = setTimeout(() => enqueue(sync).catch(console.error), 2000);
  }
  async function transact(method, args, bases, observedActiveId) {
    if (!methods.has(method)) throw new Error("不支持的简历操作");
    const data = await initialize();
    const state = data[S.STATE];
    const previousCounter = state.counter;
    const before = data[R.keys.templates] || {};
    const draft = structuredClone(data);
    if (method === "importActiveTemplateData" && bases[observedActiveId]?.template) {
      draft[R.keys.activeTemplateId] = observedActiveId;
      if (!draft[R.keys.templates][observedActiveId]) draft[R.keys.templates][observedActiveId] = structuredClone(bases[observedActiveId].template);
    }
    if (method === "saveTemplateContent" && !draft[R.keys.templates][args[0]] && bases[args[0]]?.template) {
      draft[R.keys.templates][args[0]] = structuredClone(bases[args[0]].template);
    }
    const local = {
      async get(keys) {
        if (keys == null) return structuredClone(draft);
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in draft).map(k => [k, structuredClone(draft[k])]));
      },
      async set(values) { Object.assign(draft, structuredClone(values)); },
      async remove(keys) { for (const k of [].concat(keys)) delete draft[k]; },
    };
    const parameters = args.slice(0, R[method].length - 1);
    while (parameters.length < R[method].length - 1) parameters.push(undefined);
    // initialize already migrated old keys. Avoid quota-consuming legacy
    // removals on every editor read and write.
    const syncStorage = { get: keys => chrome.storage.sync.get(keys), async remove() {} };
    let result = await R[method](...parameters, { local, sync: syncStorage });
    const changed = S.stable(before) !== S.stable(draft[R.keys.templates]);
    if (changed) {
      await S.capture(state, before, draft[R.keys.templates], bases);
      state.pending = true;
      project(state, draft);
      if (result?.id) {
        const origin = bases[result.id]?.origin || before[result.id]?._syncBase?.origin || result.id;
        const written = (state.records[origin] || []).filter(v => v.rev.startsWith(state.device + "-") && Number(v.rev.slice(state.device.length + 1)) > previousCounter);
        const saved = Object.values(draft[R.keys.templates]).find(t => t._syncBase?.origin === origin && written.some(v => Object.entries(v.clock).every(([actor, count]) => (t._syncBase.clock[actor] || 0) >= count)));
        if (saved) {
          result = { ...saved, _syncConflict: Object.values(draft[R.keys.templates]).filter(t => t._syncBase?.origin === origin).length > 1 || saved.id.includes("~conflict~") };
          if (["saveTemplateContent", "importActiveTemplateData"].includes(method)) draft[R.keys.activeTemplateId] = saved.id;
          if (method === "renameTemplate" && data[R.keys.activeTemplateId] === args[0]) draft[R.keys.activeTemplateId] = saved.id;
        }
      }
    }
    // Commit metadata and visible data together, so interrupted saves cannot lose a version.
    await chrome.storage.local.set({ [S.STATE]: state,
      [R.keys.templates]: draft[R.keys.templates], [R.keys.activeTemplateId]: draft[R.keys.activeTemplateId] });
    if (changed && state.enabled) {
      await status({ message: "已保存本机，等待写入浏览器同步存储", pending: true });
      await schedule();
    }
    return result;
  }
  async function sync() {
    const local = await initialize(), state = local[S.STATE];
    if (!state.enabled) return;
    let capacity = null;
    try {
      let remote = await chrome.storage.sync.get(null);
      let remoteRecords = {};
      for (const [key, head] of Object.entries(remote)) {
        if (!key.startsWith(S.PREFIX + "head:")) continue;
        if (typeof head?.prefix !== "string" || !head.prefix.startsWith(S.PREFIX + "part:")) throw new Error("同步清单格式错误");
        remoteRecords = S.merge(remoteRecords, await S.unpack(head, remote));
      }
      const records = S.merge(state.records, remoteRecords);
      const received = S.stable(records) !== S.stable(state.records);
      state.records = records;
      if (received) {
        state.pending = true;
        project(state, local);
        await chrome.storage.local.set({ [S.STATE]: state, [R.keys.templates]: local[R.keys.templates], [R.keys.activeTemplateId]: local[R.keys.activeTemplateId] });
        await status({ lastReceivedAt: new Date().toISOString() });
      }
      const headKey = S.PREFIX + "head:" + state.device;
      const oldHead = remote[headKey];
      const ownerPrefix = S.PREFIX + "part:" + state.device + ":";
      // Only this device's orphan staging chunks may be collected.
      const orphans = Object.keys(remote).filter(k => k.startsWith(ownerPrefix) && (!oldHead || !k.startsWith(oldHead.prefix)));
      if (orphans.length) {
        await chrome.storage.sync.remove(orphans);
        remote = await chrome.storage.sync.get(null);
      }
      let wrote = false;
      // The union of validated remote heads already represents these records.
      // Receiving a version must not create another full device snapshot.
      // Keep existing published heads: deleting a peer's data or dropping
      // tombstones here could lose concurrent edits or revive deleted resumes.
      if (S.stable(records) !== S.stable(remoteRecords)) {
        const packed = await S.pack(records);
        const prefix = ownerPrefix + packed.digest + ":";
        const head = { version: 1, digest: packed.digest, count: packed.parts.length, prefix };
        const chunks = Object.fromEntries(packed.parts.map((part, i) => [prefix + i, part]));
        const staged = { ...remote, ...chunks };
        const committed = { ...staged, [headKey]: head };
        const oldKeys = oldHead ? Object.keys(remote).filter(k => k.startsWith(ownerPrefix) && k.startsWith(oldHead.prefix) && !k.startsWith(prefix)) : [];
        const final = { ...committed };
        for (const key of oldKeys) delete final[key];
        const stagedUsage = S.storageUsage(staged), committedUsage = S.storageUsage(committed);
        capacity = { currentBytes: S.storageUsage(remote).bytes,
          versionBytes: S.storageUsage({ ...chunks, [headKey]: head }).bytes,
          peakBytes: Math.max(stagedUsage.bytes, committedUsage.bytes),
          finalBytes: S.storageUsage(final).bytes,
          peakItems: Math.max(stagedUsage.items, committedUsage.items),
          largestItemBytes: Math.max(stagedUsage.largestItemBytes, committedUsage.largestItemBytes) };
        // Both writes must fit, including the old head while staging chunks.
        S.quota(staged);
        S.quota(committed);
        await chrome.storage.sync.set(chunks);
        await chrome.storage.sync.set({ [headKey]: head });
        wrote = true;
        if (oldKeys.length) await chrome.storage.sync.remove(oldKeys);
      }
      state.pending = false; state.failures = 0;
      await chrome.storage.local.set({ [S.STATE]: state });
      await chrome.alarms.clear(ALARM);
      const bytes = await chrome.storage.sync.getBytesInUse(null);
      await status({ enabled: true, pending: false, bytes, capacity: null, error: null, errorCode: null,
        ...(wrote ? { lastPublishedAt: new Date().toISOString() } : {}),
        message: wrote ? "已写入浏览器同步存储；其他设备的到达时间由浏览器决定" : "本机简历已与浏览器同步存储一致；其他设备的到达时间由浏览器决定" });
    } catch (error) {
      state.pending = true; state.failures = Math.min((state.failures || 0) + 1, 6);
      await chrome.storage.local.set({ [S.STATE]: state });
      // Refresh on failure too. Never present the last successful reading as
      // current usage; if the browser cannot measure it, explicitly hide it.
      let bytes = null;
      try { bytes = await chrome.storage.sync.getBytesInUse(null); } catch (_) {}
      await status({ enabled: true, pending: true, bytes, capacity,
        errorCode: error.code || null, error: error.message, message: error.message });
      await chrome.alarms.create(ALARM, { delayInMinutes: Math.min(2 ** state.failures, 60) });
    }
  }
  async function control(request) {
    const data = await initialize(), state = data[S.STATE];
    if (request.command === "enable") {
      state.enabled = Boolean(request.enabled);
      await chrome.storage.local.set({ [S.STATE]: state });
      await status({ enabled: state.enabled, message: state.enabled ? "正在同步" : "同步已关闭，数据保留本机" });
      if (!state.enabled) { clearTimeout(timer); await chrome.alarms.clear(ALARM); }
    }
    if (state.enabled && ["enable", "retry", "open"].includes(request.command)) await sync();
    return (await chrome.storage.local.get(S.STATUS))[S.STATUS] || { enabled: false, message: "同步未开启" };
  }
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (!["resumeStorage", "resumeSync"].includes(request?.action)) return;
    // Content scripts share the extension ID; only our two extension pages may access resumes.
    if (sender.id !== chrome.runtime.id || !["popup.html", "resume-editor.html"].some(page => sender.url === chrome.runtime.getURL(page))) {
      respond({ ok: false, error: "不允许访问简历存储" }); return;
    }
    enqueue(() => request.action === "resumeStorage"
      ? transact(request.method, request.args || [], request.bases || {}, request.observedActiveId) : control(request))
      .then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && Object.keys(changes).some(k => k.startsWith(S.PREFIX))) {
      enqueue(async () => { if ((await initialize())[S.STATE].enabled) await schedule(); }).catch(console.error);
    }
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) enqueue(sync).catch(console.error);
  });
  chrome.runtime.onStartup.addListener(() => enqueue(sync).catch(console.error));
  enqueue(async () => {
    const state = (await initialize())[S.STATE];
    if (state.enabled) await schedule();
  }).catch(console.error);
})(globalThis);
