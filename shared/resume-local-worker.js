/* Local-only, serialized resume storage. Cloud access is confined to retirement. */
(function (root) {
  "use strict";
  const R = root.ResumeStorage;
  const allowed = new Set(Object.keys(R).filter(key => typeof R[key] === "function"));
  const cleanupKey = "resumeCloudCleanupV1";
  const legacy = ["resumeProfile", "resumeSchemaVersion", "resumeImportRawText", "resumeStructured", "resumeRawText", "resumeTemplates", "activeResumeTemplateId"];
  const isResumeKey = key => key.startsWith("resumeSyncV1:") || legacy.includes(key);
  let tail = Promise.resolve();
  function enqueue(fn) { const next = tail.then(fn); tail = next.catch(() => {}); return next; }
  async function cleanup() {
    const previous = (await chrome.storage.local.get(cleanupKey))[cleanupKey];
    if (previous?.complete) return previous;
    try {
      await chrome.alarms?.clear("resume-sync-retry");
      const remote = await chrome.storage.sync.get(null);
      const keys = Object.keys(remote).filter(isResumeKey);
      if (keys.length) await chrome.storage.sync.remove(keys);
      if (Object.keys(await chrome.storage.sync.get(null)).some(isResumeKey)) throw new Error("云端仍有简历数据，请停用其他设备的旧版扩展后重试");
      await chrome.storage.local.remove(["resumeSyncState", "resumeSyncStatus", "resumeSyncRecoveryBackup", "resumeSyncAdoptionBackup"]);
      const state = { complete: true, completedAt: new Date().toISOString(), message: "历史云端简历数据已清除；简历仅保存在本机。" };
      await chrome.storage.local.set({ [cleanupKey]: state });
      return state;
    } catch (error) {
      const state = { complete: false, message: `云端清理未完成：${error.message}` };
      await chrome.storage.local.set({ [cleanupKey]: state });
      return state;
    }
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function transact(request) {
    const { method, bases = {}, observedActiveId } = request;
    if (!allowed.has(method)) throw new Error("不支持的简历操作");
    const args = (request.args || []).slice(0, R[method].length - 1);
    const state = await R.loadTemplateState({ local: chrome.storage.local });
    let id = method === "importActiveTemplateData" ? observedActiveId : args[0];
    const base = bases[id]?.template;
    const current = state.templates.find(t => t.id === id);
    const edits = ["saveTemplateContent", "renameTemplate", "importActiveTemplateData"];
    let conflict = false;
    if (edits.includes(method)) {
      if (!base) throw new Error("请重新加载简历后再保存");
      if (!current || !same(base, current)) {
        const copy = { ...structuredClone(base), id: `tpl-${crypto.randomUUID()}`, name: `${base.name} 冲突副本`, updatedAt: new Date().toISOString() };
        state.templates.push(copy); id = copy.id; conflict = true;
      }
      if (method !== "importActiveTemplateData") args[0] = id;
      else state.activeTemplateId = id;
    }
    if (method === "deleteTemplate" && (!base || !same(base, current))) throw new Error("简历已在其他窗口修改，请重新加载后再删除");
    if (method === "importTemplateData" && !same(state.templates, Object.values(bases).map(b => b.template))) throw new Error("简历列表已改变，请重新加载后再导入");
    // Run the entire operation on a draft; quota failures cannot leave half a conflict copy.
    const draft = { resumeTemplates: Object.fromEntries(state.templates.map(t => [t.id, t])), activeResumeTemplateId: state.activeTemplateId };
    const local = {
      async get(keys) { return Object.fromEntries([].concat(keys).filter(k => k in draft).map(k => [k, structuredClone(draft[k])])); },
      async set(values) { Object.assign(draft, structuredClone(values)); },
      async remove(keys) { for (const key of keys) delete draft[key]; },
    };
    while (args.length < R[method].length - 1) args.push(undefined);
    let result = await R[method](...args, { local });
    if (result?.id && draft.resumeTemplates[result.id]) result = structuredClone(draft.resumeTemplates[result.id]);
    if (conflict && ["saveTemplateContent", "importActiveTemplateData"].includes(method)) draft.activeResumeTemplateId = id;
    if (!same(draft.resumeTemplates, Object.fromEntries((await R.loadTemplateState({ local: chrome.storage.local })).templates.map(t => [t.id, t]))) || draft.activeResumeTemplateId !== state.activeTemplateId || method === "setActiveTemplateId") {
      await chrome.storage.local.set(draft);
    }
    return conflict ? { ...result, _localConflict: true } : result;
  }
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (!["resumeStorage", "resumeCloudCleanup", "resumeDocuments"].includes(request?.action)) return;
    if (sender.id !== chrome.runtime.id || !["popup.html", "resume-editor.html", "resume-documents.html"].some(page => sender.url?.split("?")[0] === chrome.runtime.getURL(page))) {
      respond({ ok: false, error: "不允许访问本地资料" }); return;
    }
    enqueue(() => request.action === "resumeCloudCleanup" ? cleanup() : request.action === "resumeDocuments" ? root.ResumeDocuments.dispatch(request, chrome.storage.local) : transact(request))
      .then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message }));
    return true;
  });
  enqueue(cleanup).catch(console.error);
})(globalThis);
