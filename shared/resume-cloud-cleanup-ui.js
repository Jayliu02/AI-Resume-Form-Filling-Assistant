(function () {
  document.addEventListener("DOMContentLoaded", () => {
    const host = document.getElementById("resumeCloudCleanup");
    const message = document.createElement("p"); message.setAttribute("role", "status");
    const retry = document.createElement("button"); retry.className = "btn btn-outline btn-sm"; retry.textContent = "重试清理历史云端简历";
    host.append(message, retry);
    async function run() {
      retry.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ action: "resumeCloudCleanup" });
        if (!response?.ok) throw new Error(response?.error || "后台未响应");
        message.textContent = response.value.message; retry.hidden = response.value.complete;
      } catch (error) { message.textContent = error.message; }
      finally { retry.disabled = false; }
    }
    retry.addEventListener("click", run); run();
  });
})();
