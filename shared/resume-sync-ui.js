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
      <details><summary>同步详情</summary><p>模型配置与 API Key 仅保存在本机。</p><p id="resumeSyncDetails"></p></details></div>`;
    const toggle = document.getElementById("resumeSyncEnabled");
    const retry = document.getElementById("resumeSyncRetry");
    const message = document.getElementById("resumeSyncMessage");
    const details = document.getElementById("resumeSyncDetails");
    function render(state = {}) {
      toggle.checked = Boolean(state.enabled);
      retry.disabled = !state.enabled;
      message.textContent = state.message || "同步未开启";
      const parts = [];
      if (Number.isFinite(state.bytes)) parts.push(`同步存储占用 ${(state.bytes / 1024).toFixed(1)} / 100 KB（包含其他设备副本与版本记录）`);
      if (state.lastPublishedAt) parts.push(`最近写入：${new Date(state.lastPublishedAt).toLocaleString()}`);
      if (state.lastReceivedAt) parts.push(`最近接收：${new Date(state.lastReceivedAt).toLocaleString()}`);
      details.textContent = parts.join("；");
    }
    async function send(command) {
      toggle.disabled = true; retry.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ action: "resumeSync", command, enabled: toggle.checked });
        if (!response?.ok) throw new Error(response?.error || "同步后台未响应");
        render(response.value);
      } catch (error) { message.textContent = error.message; }
      finally { toggle.disabled = false; retry.disabled = !toggle.checked; }
    }
    toggle.addEventListener("change", () => send("enable"));
    retry.addEventListener("click", () => send("retry"));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.resumeSyncStatus) render(changes.resumeSyncStatus.newValue);
    });
    send("open");
  });
})();
