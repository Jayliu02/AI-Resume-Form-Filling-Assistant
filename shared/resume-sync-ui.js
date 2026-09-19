(function () {
  "use strict";
  document.addEventListener("DOMContentLoaded", () => {
    const host = document.getElementById("resumeSyncPanel");
    if (!host) return;
    host.innerHTML = `<div><strong>全部简历同步</strong>
      <p>使用同一浏览器账号，同步全部简历与原文。</p>
      <label><input type="checkbox" id="resumeSyncEnabled"> 开启简历同步</label>
      <button type="button" class="btn btn-outline btn-sm" id="resumeSyncRetry">重试同步</button>
      <p role="status" aria-live="polite" id="resumeSyncMessage"></p>
      <details><summary>同步详情与修复</summary><p>模型配置与 API Key 仅保存在本机。</p><p id="resumeSyncDetails"></p>
        <p>无法更新时，可先备份再以本机简历重建同步。其他设备请先关闭简历同步并更新扩展。</p>
        <button type="button" class="btn btn-outline btn-sm" id="resumeSyncRebuild">备份并重建同步</button>
        <button type="button" class="btn btn-outline btn-sm" id="resumeSyncAdopt" hidden>备份本机并接收重建版本</button>
      </details></div>`;
    const toggle = document.getElementById("resumeSyncEnabled");
    const retry = document.getElementById("resumeSyncRetry");
    const message = document.getElementById("resumeSyncMessage");
    const details = document.getElementById("resumeSyncDetails");
    const rebuild = document.getElementById("resumeSyncRebuild");
    const adopt = document.getElementById("resumeSyncAdopt");
    let busy = false, latest = {};
    function controls() {
      toggle.disabled = busy || Boolean(latest.rebuildPending);
      retry.disabled = busy || (!latest.enabled && !latest.generationChanged);
      rebuild.disabled = busy;
      adopt.disabled = busy;
    }
    function render(state = {}) {
      latest = state;
      toggle.checked = Boolean(state.enabled);
      rebuild.textContent = state.rebuildPending ? "继续重建同步" : "备份并重建同步";
      adopt.hidden = !state.canAdopt;
      controls();
      message.textContent = state.message || "同步未开启";
      const parts = [];
      if (Number.isFinite(state.bytes)) parts.push(`同步存储占用 ${(state.bytes / 1024).toFixed(1)} / 100 KB（包含其他设备副本与版本记录）`);
      else if (state.bytes === null) parts.push("同步存储占用暂时无法读取");
      if (state.capacity) {
        const c = state.capacity;
        parts.push(`本次待写入版本 ${(c.versionBytes / 1024).toFixed(1)} KB`);
        parts.push(`更新峰值预计 ${(c.peakBytes / 1024).toFixed(1)} / 100 KB（新旧版本暂时共存）`);
        parts.push(`更新完成后预计 ${(c.finalBytes / 1024).toFixed(1)} / 100 KB`);
        parts.push(`峰值存储项 ${c.peakItems} / 512；最大单项 ${c.largestItemBytes} / 8192 字节`);
      }
      if (state.lastPublishedAt) parts.push(`最近写入：${new Date(state.lastPublishedAt).toLocaleString()}`);
      if (state.lastReceivedAt) parts.push(`最近接收：${new Date(state.lastReceivedAt).toLocaleString()}`);
      details.textContent = parts.join("；");
    }
    async function request(command, extra = {}) {
      const response = await chrome.runtime.sendMessage({ action: "resumeSync", command, enabled: toggle.checked, ...extra });
      if (!response?.ok) throw new Error(response?.error || "同步后台未响应");
      return response.value;
    }
    async function showError(error) {
      try { render(await request("status")); } catch (_) {}
      message.textContent = error.message;
    }
    async function send(command) {
      if (busy) return;
      busy = true; controls();
      try {
        render(await request(command));
      } catch (error) { await showError(error); }
      finally { busy = false; controls(); }
    }
    function downloadBackup(payload) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `简历同步恢复备份-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(link);
      try { link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
    async function recover(receive) {
      if (busy) return;
      const prompt = receive
        ? "将先保存并备份本机简历，再用重建版本替换本机简历。原本机内容可从备份恢复。是否继续？"
        : "将先保存并备份本机简历，再删除旧同步副本并上传本机版本；仅在其他设备上的内容不会自动合并。请先在其他设备导出备份、关闭简历同步并更新扩展。确认以本机为准重建？";
      if (!window.confirm(prompt)) return;
      busy = true; controls();
      let unlock;
      try {
        unlock = await window.ResumeEditorSyncRecovery.begin();
        const prepared = await request(receive ? "prepareAdopt" : "prepareRebuild");
        downloadBackup(prepared.backup);
        render(await request(receive ? "adopt" : "rebuild", { token: prepared.token }));
        await window.ResumeEditorSyncRecovery.reload();
      } catch (error) { await showError(error); }
      finally { if (unlock) unlock(); busy = false; controls(); }
    }
    toggle.addEventListener("change", () => send("enable"));
    retry.addEventListener("click", () => send("retry"));
    rebuild.addEventListener("click", () => recover(false));
    adopt.addEventListener("click", () => recover(true));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.resumeSyncStatus) render(changes.resumeSyncStatus.newValue);
    });
    send("open");
  });
})();
