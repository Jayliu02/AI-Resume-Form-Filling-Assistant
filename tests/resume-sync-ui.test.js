const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function panel({ confirm = true, saveError = false, downloadError = false } = {}) {
  const steps = [], elements = new Map(), listeners = {};
  const element = id => {
    if (!elements.has(id)) elements.set(id, { listeners: {}, checked: false,
      addEventListener(name, fn) { this.listeners[name] = fn; } });
    return elements.get(id);
  };
  const context = vm.createContext({ Blob,
    setTimeout(fn) { fn(); },
    URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
    window: {
      confirm() { steps.push("confirm"); return confirm; },
      ResumeEditorSyncRecovery: {
        async begin() {
          steps.push("save");
          if (saveError) throw new Error("保存失败");
          return () => steps.push("unlock");
        },
        async reload() { steps.push("reload"); },
      },
    },
    document: {
      body: { appendChild() {} },
      addEventListener(name, fn) { listeners[name] = fn; },
      getElementById: element,
      createElement() { return { click() { steps.push("download"); if (downloadError) throw new Error("下载失败"); }, remove() {} }; },
    },
    chrome: {
      storage: { onChanged: { addListener() {} } },
      runtime: { async sendMessage(request) {
        steps.push(request.command);
        if (request.command.startsWith("prepare")) return { ok: true, value: { token: "reviewed", backup: { templates: [] } } };
        if (["rebuild", "adopt"].includes(request.command)) assert.equal(request.token, "reviewed");
        return { ok: true, value: { enabled: true, message: "ready" } };
      } },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/resume-sync-ui.js"), "utf8"), context);
  listeners.DOMContentLoaded();
  // The initial status request/render is asynchronous.
  await new Promise(resolve => setImmediate(resolve));
  steps.length = 0;
  return { steps, elements, click: id => element(id).listeners.click() };
}

test("rebuild UI saves and downloads a backup before sending the destructive command", async () => {
  const ui = await panel();
  await ui.click("resumeSyncRebuild");
  assert.deepEqual(ui.steps, ["confirm", "save", "prepareRebuild", "download", "rebuild", "reload", "unlock"]);
  assert.equal(ui.elements.get("resumeSyncRebuild").disabled, false);
});

test("adoption UI backs up local edits before replacing them", async () => {
  const ui = await panel();
  await ui.click("resumeSyncAdopt");
  assert.deepEqual(ui.steps, ["confirm", "save", "prepareAdopt", "download", "adopt", "reload", "unlock"]);
});

test("cancelling recovery performs no writes", async () => {
  const ui = await panel({ confirm: false });
  await ui.click("resumeSyncRebuild");
  assert.deepEqual(ui.steps, ["confirm"]);
});

test("a failed form save never prepares or starts recovery", async () => {
  const ui = await panel({ saveError: true });
  await ui.click("resumeSyncRebuild");
  assert.deepEqual(ui.steps, ["confirm", "save", "status"]);
  assert.equal(ui.elements.get("resumeSyncMessage").textContent, "保存失败");
  assert.equal(ui.elements.get("resumeSyncRebuild").disabled, false);
});

test("a failed backup download does not start deletion and unlocks the editor", async () => {
  const ui = await panel({ downloadError: true });
  await ui.click("resumeSyncRebuild");
  assert.deepEqual(ui.steps, ["confirm", "save", "prepareRebuild", "download", "status", "unlock"]);
  assert.equal(ui.elements.get("resumeSyncMessage").textContent, "下载失败");
});
