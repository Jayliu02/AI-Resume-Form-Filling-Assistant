/* Explicit recovery only: save a durable local backup before removing any
 * remote resume keys. A generation fence prevents updated offline peers from
 * republishing their old snapshots until the user accepts the rebuilt data.
 * Older extension versions do not understand the fence and must be disabled.
 */
(function (root) {
  "use strict";
  const S = root.ResumeSync, R = root.ResumeStorage;
  const resumeEntries = data => Object.fromEntries(Object.entries(data).filter(([k]) => k.startsWith(S.PREFIX)));
  const otherEntries = data => Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith(S.PREFIX)));
  async function measuredBytes() {
    try { return await chrome.storage.sync.getBytesInUse(null); } catch (_) { return null; }
  }
  function backup(local, remote, token, purpose) {
    return { app: "ai-resume-form-filling-assistant", kind: "resume-templates", version: 1,
      exportedAt: new Date().toISOString(), activeTemplateId: local[R.keys.activeTemplateId],
      templates: Object.values(local[R.keys.templates]).map(({ _syncBase, ...t }) => t),
      recovery: { token, purpose, state: structuredClone(local[S.STATE]), remote: resumeEntries(remote) } };
  }
  async function publication(state, id) {
    const packed = await S.pack(state.records);
    const headKey = S.PREFIX + "head:" + state.device;
    const prefix = S.PREFIX + "part:" + state.device + ":" + id + ":" + packed.digest + ":";
    return { headKey, head: { version: 1, generation: id, digest: packed.digest, count: packed.parts.length, prefix },
      chunks: Object.fromEntries(packed.parts.map((part, i) => [prefix + i, part])) };
  }
  function create({ initialize, project, status, stopTimers }) {
    async function pause(local) {
      local[S.STATE].enabled = false;
      await chrome.storage.local.set({ [S.STATE]: local[S.STATE] });
      await stopTimers();
    }
    async function prepare() {
      const local = await initialize(), state = local[S.STATE];
      await pause(local);
      const remote = await chrome.storage.sync.get(null);
      const existing = (await chrome.storage.local.get(S.RECOVERY_BACKUP))[S.RECOVERY_BACKUP];
      if (state.recovery && existing?.recovery.token === state.recovery.id) {
        return { token: state.recovery.id, backup: existing };
      }
      const id = crypto.randomUUID();
      // Invalid/missing parts may be backed up verbatim: recovery must not
      // require successfully merging the very data it is meant to repair.
      const previousGeneration = remote[S.GENERATION]?.id || "";
      const pub = await publication(state, id);
      await S.unpack(pub.head, pub.chunks);
      const marker = { version: 1, id, phase: "ready" };
      const bytes = S.quota({ ...otherEntries(remote), ...pub.chunks, [pub.headKey]: pub.head, [S.GENERATION]: marker });
      const saved = backup(local, remote, id, "rebuild");
      state.recovery = { id, previousGeneration, phase: "prepared" };
      state.quotaBlocked = false;
      await chrome.storage.local.set({ [S.RECOVERY_BACKUP]: saved, [S.STATE]: state });
      await status({ enabled: false, pending: true, rebuildPending: true, canAdopt: false,
        message: "恢复备份已保存在本机，等待确认重建同步" });
      return { token: id, backup: saved, bytes };
    }
    async function finish(local, id) {
      const state = local[S.STATE];
      state.generation = id; state.recovery = null; state.quotaBlocked = false;
      state.enabled = true; state.pending = false; state.failures = 0;
      await chrome.storage.local.set({ [S.STATE]: state });
      await status({ enabled: true, pending: false, rebuildPending: false, canAdopt: false,
        generationChanged: false, capacity: null, error: null, errorCode: null,
        bytes: await measuredBytes(), lastPublishedAt: new Date().toISOString(),
        message: "已用本机简历重建同步；其他设备需更新扩展并备份后接收重建版本" });
    }
    async function rebuild(token) {
      const local = await initialize(), state = local[S.STATE], job = state.recovery;
      const saved = (await chrome.storage.local.get(S.RECOVERY_BACKUP))[S.RECOVERY_BACKUP];
      if (!job || token !== job.id || saved?.recovery.token !== token) throw new Error("请先生成恢复备份，再确认重建");
      await pause(local);
      try {
        let remote = await chrome.storage.sync.get(null);
        const marker = remote[S.GENERATION];
        if (marker?.id === job.id && marker.phase === "ready") {
          // The last remote write succeeded before the worker stopped. Do not
          // wipe it again: another device may already have edited this epoch.
          await S.readRecords(remote);
          await finish(local, job.id);
          return;
        }
        if ((marker?.id || "") !== job.id &&
            ((marker?.id || "") !== job.previousGeneration || job.phase === "publishing")) {
          throw new Error("另一设备已重建同步；请保留备份并接收它的重建版本");
        }
        const pub = await publication(state, job.id);
        await S.unpack(pub.head, pub.chunks);
        const busy = { version: 1, id: job.id, phase: "rebuilding" };
        const ready = { ...busy, phase: "ready" };
        // Preflight the final data BEFORE touching remote keys. Full local
        // records (including tombstones) are retained, not reseeded or pruned.
        S.quota({ ...otherEntries(remote), ...pub.chunks, [pub.headKey]: pub.head, [S.GENERATION]: busy });
        saved.recovery.latestRemote = resumeEntries(remote);
        job.phase = "clearing";
        await chrome.storage.local.set({ [S.RECOVERY_BACKUP]: saved, [S.STATE]: state });
        // Reserve a small fence even if sync is completely full. Only resume
        // keys already in the durable backup may be evicted to make room.
        const reserved = { ...remote, [S.GENERATION]: busy }, evict = [];
        for (const key of Object.keys(resumeEntries(remote)).filter(k => k !== S.GENERATION)) {
          const usage = S.storageUsage(reserved);
          if (usage.bytes <= 102400 && usage.items <= 512 && usage.largestItemBytes <= 8192) break;
          delete reserved[key]; evict.push(key);
        }
        S.quota(reserved);
        if (evict.length) await chrome.storage.sync.remove(evict);
        await chrome.storage.sync.set({ [S.GENERATION]: busy });
        remote = await chrome.storage.sync.get(null);
        if (remote[S.GENERATION]?.id !== job.id) throw new Error("同步重建标记已变化，请勿在多台设备同时重建");
        // Back up late-arriving keys too, before deleting them.
        saved.recovery.latestRemote = resumeEntries(remote);
        job.phase = "publishing";
        await chrome.storage.local.set({ [S.RECOVERY_BACKUP]: saved, [S.STATE]: state });
        const keys = Object.keys(resumeEntries(remote)).filter(k => k !== S.GENERATION);
        if (keys.length) await chrome.storage.sync.remove(keys);
        await chrome.storage.sync.set(pub.chunks);
        await chrome.storage.sync.set({ [pub.headKey]: pub.head });
        const check = await chrome.storage.sync.get(null);
        if (check[S.GENERATION]?.id !== job.id) throw new Error("另一设备正在重建，请保留本机备份后重试");
        await S.unpack(check[pub.headKey], check);
        await chrome.storage.sync.set({ [S.GENERATION]: ready });
        await finish(local, job.id);
      } catch (error) {
        state.enabled = false;
        await chrome.storage.local.set({ [S.STATE]: state });
        await stopTimers();
        let bytes = null;
        try { bytes = await chrome.storage.sync.getBytesInUse(null); } catch (_) {}
        await status({ enabled: false, pending: true, rebuildPending: Boolean(state.recovery), bytes,
          error: error.message, message: `重建未完成：${error.message}。本机简历与恢复备份仍保留，可点击“继续重建同步”` });
        throw error;
      }
    }
    async function prepareAdopt() {
      const local = await initialize();
      await pause(local);
      const remote = await chrome.storage.sync.get(null), current = S.generation(remote);
      if (!current.id || current.phase !== "ready") throw new Error("远端重建尚未完成，请稍后接收");
      await S.readRecords(remote);
      const token = crypto.randomUUID(), saved = backup(local, remote, token, "adopt");
      saved.recovery.generation = current.id;
      await chrome.storage.local.set({ [S.ADOPTION_BACKUP]: saved });
      return { token, backup: saved };
    }
    async function adopt(token) {
      const local = await initialize(), state = local[S.STATE];
      const saved = (await chrome.storage.local.get(S.ADOPTION_BACKUP))[S.ADOPTION_BACKUP];
      if (!saved || saved.recovery.token !== token) throw new Error("请先备份本机简历");
      if (S.stable(state.records) !== S.stable(saved.recovery.state.records)) throw new Error("备份后本机内容已变化，请重新备份再接收");
      const remote = await chrome.storage.sync.get(null), current = S.generation(remote);
      if (current.id !== saved.recovery.generation || current.phase !== "ready") throw new Error("远端重建版本已变化，请重新备份再接收");
      if (!Object.entries(remote).some(([k, h]) => k.startsWith(S.PREFIX + "head:") && h?.generation === current.id)) throw new Error("重建数据尚未到齐，请稍后接收");
      state.records = await S.readRecords(remote);
      state.generation = current.id; state.enabled = true; state.pending = false;
      state.recovery = null; state.quotaBlocked = false; state.failures = 0;
      project(state, local);
      await chrome.storage.local.set({ [S.STATE]: state, [R.keys.templates]: local[R.keys.templates], [R.keys.activeTemplateId]: local[R.keys.activeTemplateId] });
      await status({ enabled: true, pending: false, rebuildPending: false, canAdopt: false,
        generationChanged: false, capacity: null, error: null, errorCode: null,
        bytes: await measuredBytes(), lastReceivedAt: new Date().toISOString(),
        message: "已接收重建版本；接收前的本机简历保留在恢复备份中" });
    }
    return { prepare, rebuild, prepareAdopt, adopt };
  }
  root.ResumeSyncRecovery = { create };
})(globalThis);
