// Side panel: choose a resume and fill the current page.

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

const openResumeEditorBtn = document.getElementById("openResumeEditorBtn");

const fieldCountEl = document.getElementById("fieldCount");
const mappedCountEl = document.getElementById("mappedCount");
const filledCountEl = document.getElementById("filledCount");

const startFillBtn = document.getElementById("startFillBtn");
const startFillBtnText = document.getElementById("startFillBtnText");
const startIncrementalFillBtn = document.getElementById("startIncrementalFillBtn");
const startIncrementalFillBtnText = document.getElementById(
  "startIncrementalFillBtnText"
);
const startSelectionFillBtn = document.getElementById("startSelectionFillBtn");
const startSelectionFillBtnText = document.getElementById(
  "startSelectionFillBtnText"
);
const clearMappingCacheBtn = document.getElementById("clearMappingCacheBtn");
const fillTipEl = document.getElementById("fillTip");

const fillTemplateSelect = document.getElementById("fillTemplateSelect");

const logContent = document.getElementById("logContent");
const clearLogBtn = document.getElementById("clearLog");
const selectLogDirectoryBtn = document.getElementById("selectLogDirectoryBtn");
const logExportStatusEl = document.getElementById("logExportStatus");

const settingsModal = document.getElementById("settingsModal");
const openSettingsBtn = document.getElementById("openSettingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const closeSettingsBackdrop = document.getElementById("closeSettingsBackdrop");
const modelList = document.getElementById("modelList");
const addModelBtn = document.getElementById("addModelBtn");

const editModelModal = document.getElementById("editModelModal");
const closeEditBtn = document.getElementById("closeEditBtn");
const closeEditBackdrop = document.getElementById("closeEditBackdrop");
const editModalTitle = document.getElementById("editModalTitle");
const editNameInput = document.getElementById("editName");
const editBaseUrlInput = document.getElementById("editBaseUrl");
const editApiKeyInput = document.getElementById("editApiKey");
const editModelInput = document.getElementById("editModel");
const editStatus = document.getElementById("editStatus");
const saveModelBtn = document.getElementById("saveModelBtn");
const toggleEditApiKeyBtn = document.getElementById("toggleEditApiKey");

const schema = window.ResumeSchema;
if (!schema) {
  throw new Error("Resume schema is not available");
}

const resumeStorage = window.ResumeStorage;
if (!resumeStorage) {
  throw new Error("Resume storage is not available");
}

const modelStorage = window.ResumeModelStorage;
if (!modelStorage) {
  throw new Error("Model storage is not available");
}

const aiClient = window.ResumeAiClient;
if (!aiClient) {
  throw new Error("AI client is not available");
}

const logExport = window.ResumeLogExport;
if (!logExport) {
  throw new Error("Resume log export is not available");
}

const logVisibility = window.ResumeLogVisibility;
if (!logVisibility) {
  throw new Error("Resume log visibility is not available");
}

const contentBridge = window.ResumeContentBridge;
if (!contentBridge) {
  throw new Error("Resume content bridge is not available");
}

const RESUME_TEMPLATES_KEY = resumeStorage.keys.templates;
const RESUME_ACTIVE_TEMPLATE_KEY = resumeStorage.keys.activeTemplateId;
const RESUME_LEGACY_PROFILE_KEY = resumeStorage.keys.profile;
const RESUME_LEGACY_RAW_TEXT_KEY = resumeStorage.keys.rawText;
const MAPPING_CACHE_KEY = "fieldMappingCacheV3";

const BUILTIN_MODEL = modelStorage.DEFAULT_MODEL;

let editingModelId = null;
let isFilling = false;
let resumeProfile = schema.createEmptyResumeProfile();
let templates = [];
let activeTemplateId = null;
let isLoadingResume = false;
let resumeLoadRequestId = 0;
let logProjectRootHandle = null;
let activeFillSession = null;
const dialogTriggers = new WeakMap();

const FILL_ACTIONS = {
  overwritePage: {
    triggerText: "开始填充",
    runningText: "填充中...",
    statusText: "映射中...",
    startLog: "开始识别页面字段，准备进行 AI 字段映射...",
    doneLog: "填充完成",
    fillMode: "overwrite",
    scope: "page",
  },
  incrementalPage: {
    triggerText: "增量填入",
    runningText: "增量中...",
    statusText: "增量映射中...",
    startLog: "开始增量填入：已有内容的字段会自动跳过。",
    doneLog: "增量填入完成",
    fillMode: "incremental",
    scope: "page",
  },
  selection: {
    triggerText: "选区填入",
    runningText: "等待选区...",
    statusText: "等待选区...",
    startLog: "准备选区填入：请回到网页并拖拽框选要填写的区域。",
    doneLog: "选区填入完成",
    fillMode: "overwrite",
    scope: "selection",
  },
};

document.addEventListener("DOMContentLoaded", async () => {
  try {
    initModalEvents();
    initLogExportEvents();
    initTemplateEvents();
    await initModels();
    await refreshLogExportStatus();
    await loadResumeProfile();
    updateStartFillAvailability();
  } catch (error) {
    console.error("[popup] 初始化失败:", error);
    addLog("error", `初始化失败：${error.message}`);
    updateStatus("error", "初始化失败");
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" && areaName !== "sync") return;
  if (
    !changes[RESUME_TEMPLATES_KEY] &&
    !changes[RESUME_ACTIVE_TEMPLATE_KEY] &&
    !changes[RESUME_LEGACY_PROFILE_KEY] &&
    !changes[RESUME_LEGACY_RAW_TEXT_KEY]
  ) {
    return;
  }

  if (isFilling) {
    addLog("info", "简历已更新，本次填充结束后载入。");
    return;
  }

  loadResumeProfile().catch((error) => {
    console.error("[popup] 同步简历配置失败:", error);
  });
});

if (openResumeEditorBtn) {
  openResumeEditorBtn.addEventListener("click", async () => {
    const url = chrome.runtime.getURL("resume-editor.html");
    await chrome.tabs.create({ url });
  });
}

function initModalEvents() {
  openSettingsBtn.addEventListener("click", openModal);
  closeSettingsBtn.addEventListener("click", closeModal);
  closeSettingsBackdrop.addEventListener("click", closeModal);
  addModelBtn.addEventListener("click", () => openEditModal());
  closeEditBtn.addEventListener("click", closeEditModal);
  closeEditBackdrop.addEventListener("click", closeEditModal);
  modelList.addEventListener("click", handleModelListClick);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (editModelModal.classList.contains("open")) closeEditModal();
    else if (settingsModal.classList.contains("open")) closeModal();
  });

  toggleEditApiKeyBtn.addEventListener("click", () => {
    const nextType = editApiKeyInput.type === "password" ? "text" : "password";
    editApiKeyInput.type = nextType;
    const isVisible = nextType === "text";
    toggleEditApiKeyBtn.setAttribute("aria-pressed", String(isVisible));
    toggleEditApiKeyBtn.setAttribute("aria-label", isVisible ? "隐藏 API Key" : "显示 API Key");
  });
}

function initLogExportEvents() {
  selectLogDirectoryBtn.addEventListener("click", async () => {
    if (!logExport.supportsDirectoryPicker()) {
      addLog("error", "当前浏览器不支持项目目录写入");
      return;
    }

    selectLogDirectoryBtn.disabled = true;
    try {
      const rootHandle = await window.showDirectoryPicker({
        id: "resume-log-project-root",
        mode: "readwrite",
      });

      const permission = await logExport.getPermissionState(rootHandle, {
        request: true,
      });
      if (permission !== "granted") {
        throw new Error("目录写入权限未授予");
      }

      await logExport.ensureLogsDirectoryHandle(rootHandle);
      await logExport.saveProjectRootHandle(rootHandle);
      logProjectRootHandle = rootHandle;
      await refreshLogExportStatus();
      addLog(
        "success",
        `诊断日志将自动保存到 ${rootHandle.name}/${logExport.LOGS_DIR_NAME}/`
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        addLog("info", "已取消选择项目目录");
      } else {
        addLog("error", `设置日志目录失败：${error.message}`);
      }
    } finally {
      selectLogDirectoryBtn.disabled = false;
    }
  });
}

async function refreshLogExportStatus() {
  if (!logExport.supportsDirectoryPicker()) {
    logProjectRootHandle = null;
    selectLogDirectoryBtn.disabled = true;
    selectLogDirectoryBtn.textContent = "不支持目录写入";
    logExportStatusEl.textContent =
      "当前浏览器不支持项目目录自动写入。你仍然可以在侧边栏里查看运行日志。";
    return;
  }

  selectLogDirectoryBtn.disabled = false;

  let handle = null;
  try {
    handle = await logExport.loadProjectRootHandle();
  } catch (error) {
    logProjectRootHandle = null;
    selectLogDirectoryBtn.textContent = "选择项目目录";
    logExportStatusEl.textContent = `读取日志目录配置失败：${error.message}`;
    return;
  }

  if (!handle) {
    logProjectRootHandle = null;
    selectLogDirectoryBtn.textContent = "选择项目目录";
    logExportStatusEl.textContent =
      "选择目录可自动保存日志。";
    return;
  }

  const permission = await logExport.getPermissionState(handle);
  if (permission !== "granted") {
    logProjectRootHandle = null;
    selectLogDirectoryBtn.textContent = "重新选择项目目录";
    logExportStatusEl.textContent =
      "之前记住的项目目录权限已失效。点击“重新选择项目目录”后，将继续自动保存到 debug-logs/。";
    return;
  }

  logProjectRootHandle = handle;
  selectLogDirectoryBtn.textContent = "重新选择项目目录";
  logExportStatusEl.textContent = `已配置自动导出：${handle.name}/${logExport.LOGS_DIR_NAME}/`;
}

function createFillSession(tab) {
  return {
    id: `fill-${Date.now()}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "running",
    errorMessage: "",
    tab: {
      id: tab?.id ?? null,
      url: tab?.url || "",
      title: tab?.title || "",
    },
    stats: {
      fieldCount: 0,
      mappedCount: 0,
      filledCount: 0,
    },
    logs: [],
  };
}

function beginFillSession(tab) {
  activeFillSession = createFillSession(tab);
}

function recordSessionLog(level, message, timestamp) {
  if (!activeFillSession) return;
  activeFillSession.logs.push({
    level,
    message,
    timestamp,
  });
}

function recordFillSessionStats(fieldCount, mappedCount, filledCount) {
  if (!activeFillSession) return;
  activeFillSession.stats = {
    fieldCount: Number(fieldCount || 0),
    mappedCount: Number(mappedCount || 0),
    filledCount: Number(filledCount || 0),
  };
}

function getCurrentFillStats() {
  return {
    fieldCount: Number(fieldCountEl.textContent || 0),
    mappedCount: Number(mappedCountEl.textContent || 0),
    filledCount: Number(filledCountEl.textContent || 0),
  };
}

async function finalizeFillSession({ status, stats, errorMessage = "" } = {}) {
  if (!activeFillSession) return;

  const session = activeFillSession;
  activeFillSession = null;
  session.endedAt = new Date().toISOString();
  session.status = status || "unknown";
  session.errorMessage = errorMessage;
  session.stats = {
    ...session.stats,
    ...(stats || {}),
  };

  if (!logProjectRootHandle) {
    return;
  }

  try {
    const permission = await logExport.getPermissionState(logProjectRootHandle);
    if (permission !== "granted") {
      logProjectRootHandle = null;
      addLog(
        "warning",
        "项目目录授权已失效，本次未自动保存日志。请重新点击“选择项目目录”。"
      );
      await refreshLogExportStatus();
      return;
    }

    const saved = await logExport.writeSessionLogFile(logProjectRootHandle, session);
    addLog("info", `诊断日志已自动保存到 ${saved.relativePath}`);
  } catch (error) {
    addLog("error", `诊断日志保存失败：${error.message}`);
  }
}

function openModal() {
  openDialog(settingsModal, openSettingsBtn);
  renderModelList().catch((error) => addLog("error", `读取模型失败：${error.message}`));
}

function closeModal() {
  closeDialog(settingsModal);
}

function openEditModal(modelId = null) {
  editingModelId = modelId;
  settingsModal.setAttribute("aria-hidden", "true");
  openDialog(editModelModal, document.activeElement);

  if (modelId) {
    editModalTitle.textContent = "编辑模型";
    loadModelForEdit(modelId).catch((error) => {
      showEditStatus("error", `读取模型失败：${error.message}`);
    });
    return;
  }

  editModalTitle.textContent = "添加模型";
  editNameInput.value = "DeepSeek";
  editBaseUrlInput.value = "https://api.deepseek.com/v1";
  editApiKeyInput.value = "";
  editModelInput.value = "deepseek-chat";
}

function closeEditModal() {
  if (settingsModal.classList.contains("open")) {
    settingsModal.setAttribute("aria-hidden", "false");
  }
  closeDialog(editModelModal);
  editingModelId = null;
}

function openDialog(dialog, trigger) {
  dialogTriggers.set(dialog, trigger instanceof HTMLElement ? trigger : document.activeElement);
  dialog.classList.add("open");
  dialog.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    dialog.querySelector("input, select, textarea, button")?.focus();
  });
}

function closeDialog(dialog) {
  dialog.classList.remove("open");
  dialog.setAttribute("aria-hidden", "true");
  const trigger = dialogTriggers.get(dialog);
  dialogTriggers.delete(dialog);
  trigger?.focus?.();
}

async function initModels() {
  await modelStorage.loadModelState();
}

async function getAllModels() {
  const state = await modelStorage.loadModelState();
  return getModelsFromState(state);
}

async function getActiveModel() {
  const state = await modelStorage.loadModelState();
  const models = getModelsFromState(state);
  const activeId = state.activeModelId || BUILTIN_MODEL.id;
  return models.find((model) => model.id === activeId) || BUILTIN_MODEL;
}

function getModelsFromState(state) {
  return [modelStorage.buildBuiltinModel(state.builtinOverride), ...state.models];
}

async function renderModelList() {
  const state = await modelStorage.loadModelState();
  const models = getModelsFromState(state);
  const activeId = state.activeModelId || BUILTIN_MODEL.id;

  modelList.innerHTML = models
    .map(
      (model) => `
        <div class="model-item ${model.id === activeId ? "active" : ""}" data-model-id="${escapeHtml(model.id)}">
          <input type="radio" name="activeModel" class="model-radio" value="${escapeHtml(model.id)}" ${
            model.id === activeId ? "checked" : ""
          }>
          <div class="model-info">
            <div class="model-name">
              ${escapeHtml(model.name)}
              ${model.builtin ? '<span class="model-badge">内置</span>' : ""}
            </div>
            <div class="model-meta">${escapeHtml(model.model)}</div>
          </div>
          <div class="model-actions">
              <button class="icon-btn edit-model-btn" type="button" aria-label="编辑 ${escapeHtml(model.name)}" data-model-id="${escapeHtml(model.id)}">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
            ${
              model.builtin
                ? ""
                : `<button class="icon-btn delete-model-btn" type="button" aria-label="删除 ${escapeHtml(model.name)}" data-model-id="${escapeHtml(model.id)}">
                     <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                   </button>`
            }
          </div>
        </div>
      `
    )
    .join("");

}

async function handleModelListClick(event) {
  const editButton = event.target.closest(".edit-model-btn");
  if (editButton) {
    openEditModal(editButton.dataset.modelId);
    return;
  }

  const deleteButton = event.target.closest(".delete-model-btn");
  if (deleteButton) {
    const modelId = deleteButton.dataset.modelId;
    if (!confirm("确定要删除这个模型吗？")) return;
    try {
      const state = await modelStorage.loadModelState();
      await modelStorage.saveModelState({
        models: state.models.filter((model) => model.id !== modelId),
        builtinOverride: state.builtinOverride,
      });
      if (state.activeModelId === modelId) {
        await modelStorage.saveActiveModelId(BUILTIN_MODEL.id);
      }
      await renderModelList();
    } catch (error) {
      addLog("error", `删除模型失败：${error.message}`);
    }
    return;
  }

  const item = event.target.closest(".model-item");
  if (!item) return;
  try {
    await modelStorage.saveActiveModelId(item.dataset.modelId);
    const name = item.querySelector(".model-name")?.childNodes[0]?.textContent?.trim();
    addLog("success", `已切换模型：${name || item.dataset.modelId}`);
    closeModal();
  } catch (error) {
    addLog("error", `切换模型失败：${error.message}`);
  }
}

async function loadModelForEdit(modelId) {
  const models = await getAllModels();
  const model = models.find((item) => item.id === modelId);
  if (!model) return;

  editNameInput.value = model.name;
  editBaseUrlInput.value = model.baseUrl;
  editApiKeyInput.value = model.apiKey;
  editModelInput.value = model.model;
}

saveModelBtn.addEventListener("click", async () => {
  const name = editNameInput.value.trim();
  const baseUrl = editBaseUrlInput.value.trim();
  const apiKey = editApiKeyInput.value.trim();
  const model = editModelInput.value.trim();

  if (!name || !baseUrl || !apiKey || !model) {
    showEditStatus("error", "请填写所有配置项");
    return;
  }

  saveModelBtn.disabled = true;
  saveModelBtn.textContent = "保存中...";

  try {
    modelStorage.validateBaseUrl(baseUrl);
    const state = await modelStorage.loadModelState();
    const models = [...state.models];

    if (editingModelId === BUILTIN_MODEL.id) {
      await modelStorage.saveModelState({
        models,
        builtinOverride: { name, baseUrl, apiKey, model },
      });
    } else if (editingModelId) {
      const index = models.findIndex((item) => item.id === editingModelId);
      if (index !== -1) {
        models[index] = { ...models[index], name, baseUrl, apiKey, model };
      }
      await modelStorage.saveModelState({
        models,
        builtinOverride: state.builtinOverride,
      });
    } else {
      models.push({
        id: `custom-${Date.now()}`,
        name,
        baseUrl,
        apiKey,
        model,
        builtin: false,
      });
      await modelStorage.saveModelState({
        models,
        builtinOverride: state.builtinOverride,
      });
    }

    showEditStatus("success", "保存成功");
    setTimeout(() => {
      closeEditModal();
      renderModelList();
    }, 300);
  } catch (error) {
    console.error("[popup] 保存模型配置失败:", error);
    showEditStatus("error", `保存失败：${error.message}`);
  } finally {
    setTimeout(() => {
      saveModelBtn.disabled = false;
      saveModelBtn.textContent = "保存";
    }, 300);
  }
});

function showEditStatus(type, message) {
  editStatus.textContent = message;
  editStatus.className = `config-status ${type}`;
  setTimeout(() => {
    editStatus.textContent = "";
    editStatus.className = "config-status";
  }, 3000);
}

function isModelConfigured(model) {
  return Boolean(model?.baseUrl && model?.apiKey && model?.model);
}

function initTemplateEvents() {
  fillTemplateSelect.addEventListener("change", async () => {
    const previousId = activeTemplateId;
    fillTemplateSelect.disabled = true;
    try {
      await resumeStorage.setActiveTemplateId(fillTemplateSelect.value);
      await loadResumeProfile();
    } catch (error) {
      if (previousId) {
        await resumeStorage.setActiveTemplateId(previousId).catch(() => {});
      }
      fillTemplateSelect.value = previousId;
      addLog("error", `切换简历失败：${error.message}`);
    } finally {
      fillTemplateSelect.disabled = isFilling;
    }
  });
}

async function loadResumeProfile() {
  const requestId = ++resumeLoadRequestId;
  isLoadingResume = true;
  try {
    const state = await resumeStorage.loadTemplateState();
    if (requestId !== resumeLoadRequestId) return;
    templates = state.templates;
    activeTemplateId = state.activeTemplateId;
    fillTemplateSelect.replaceChildren();
    for (const template of templates) {
      const option = document.createElement("option");
      option.value = template.id;
      option.textContent = template.name;
      fillTemplateSelect.appendChild(option);
    }
    fillTemplateSelect.value = activeTemplateId;
    const active = templates.find((template) => template.id === activeTemplateId);
    resumeProfile = schema.getFillProfile(active?.profile || {});
    updateStartFillAvailability();
  } finally {
    if (requestId === resumeLoadRequestId) isLoadingResume = false;
  }
}

startFillBtn.addEventListener("click", async () => {
  await runFill("overwritePage");
});

startIncrementalFillBtn?.addEventListener("click", async () => {
  await runFill("incrementalPage");
});

startSelectionFillBtn?.addEventListener("click", async () => {
  await runFill("selection");
});

async function runFill(actionKey) {
  if (isFilling) return;

  const actionConfig = FILL_ACTIONS[actionKey];
  if (!actionConfig) {
    throw new Error(`未知填充动作：${actionKey}`);
  }

  if (!schema.hasAnyFilledField(resumeProfile)) {
    addLog("warning", "请点击“编辑简历”填写资料");
    openResumeEditorBtn.focus();
    return;
  }

  const activeModel = await getActiveModel();
  if (!isModelConfigured(activeModel)) {
    addLog("error", "请先在设置中配置模型");
    openModal();
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) {
    addLog("error", "无法获取当前标签页");
    return;
  }

  if (!tab.url) {
    addLog("error", "无法读取当前网页地址，请重新加载扩展后再试");
    updateStatus("error", "网页权限不可用");
    return;
  }

  if (!isSupportedWebPageUrl(tab.url)) {
    addLog("error", "请切换到要填写的网页（非系统页面）");
    updateStatus("error", "系统页面");
    return;
  }

  isFilling = true;
  updateFillActionButtons({ isRunning: true, runningActionKey: actionKey });
  fillTipEl.hidden = true;
  updateStatus("running", actionConfig.statusText);
  beginFillSession(tab);
  addLog("info", actionConfig.startLog);

  try {
    const injected = await ensureContentScriptInjected(tab.id);
    if (!injected) {
      throw new Error("当前页面仍在运行旧版插件脚本。这通常发生在刚重载扩展后；刷新当前页面一次后再重试即可");
    }

    const modelId = activeModel.id;
    const response = await sendTabMessage(tab.id, {
      action: "startFill",
      modelId,
      resumeProfile,
      fillMode: actionConfig.fillMode,
      scope: actionConfig.scope,
    });

    if (!response?.success) {
      if (response?.canceled) {
        addLog("info", response.message || "已取消本次操作");
        updateStatus("ready", "已取消");
        await finalizeFillSession({
          status: "canceled",
          stats: getCurrentFillStats(),
          errorMessage: response.message || "",
        });
        return;
      }
      throw new Error(response?.message || "填充失败");
    }

    updateFillStats(
      response.fieldCount || 0,
      response.mappedCount || 0,
      response.filledCount || 0
    );

    fillTipEl.textContent = buildFillTipText(actionKey, response.cacheHit);
    fillTipEl.hidden = false;

    addLog(
      "success",
      `${actionConfig.doneLog}：识别 ${response.fieldCount} 个字段，映射 ${response.mappedCount} 个，成功填充 ${response.filledCount} 个。`
    );
    updateStatus("ready", "完成");
    await finalizeFillSession({
      status: "success",
      stats: {
        fieldCount: response.fieldCount || 0,
        mappedCount: response.mappedCount || 0,
        filledCount: response.filledCount || 0,
      },
    });
  } catch (error) {
    addLog("error", `填充失败：${error.message}`);
    updateStatus("error", "失败");
    await finalizeFillSession({
      status: "error",
      stats: getCurrentFillStats(),
      errorMessage: error.message,
    });
  } finally {
    isFilling = false;
    updateStartFillAvailability();
    await loadResumeProfile();
  }
}

clearMappingCacheBtn.addEventListener("click", async () => {
  clearMappingCacheBtn.disabled = true;
  try {
    await chrome.storage.local.remove(MAPPING_CACHE_KEY);
    addLog("success", "字段映射缓存已清空");
    fillTipEl.hidden = true;
  } catch (error) {
    addLog("error", `清理缓存失败：${error.message}`);
  } finally {
    clearMappingCacheBtn.disabled = false;
  }
});

function updateFillStats(fieldCount, mappedCount, filledCount) {
  fieldCountEl.textContent = fieldCount;
  mappedCountEl.textContent = mappedCount;
  filledCountEl.textContent = filledCount;
  recordFillSessionStats(fieldCount, mappedCount, filledCount);
}

function updateStartFillAvailability() {
  const hasData = schema.hasAnyFilledField(resumeProfile);
  updateFillActionButtons({ hasData, isRunning: isFilling });
}

function updateFillActionButtons({
  hasData = schema.hasAnyFilledField(resumeProfile),
  isRunning = isFilling,
  runningActionKey = "",
} = {}) {
  fillTemplateSelect.disabled = isRunning;
  const buttonMap = [
    {
      key: "overwritePage",
      button: startFillBtn,
      labelEl: startFillBtnText,
    },
    {
      key: "incrementalPage",
      button: startIncrementalFillBtn,
      labelEl: startIncrementalFillBtnText,
    },
    {
      key: "selection",
      button: startSelectionFillBtn,
      labelEl: startSelectionFillBtnText,
    },
  ];

  for (const item of buttonMap) {
    if (!item.button || !item.labelEl) continue;
    const config = FILL_ACTIONS[item.key];
    const isCurrent = runningActionKey === item.key;
    item.button.disabled = !hasData || isRunning;
    if (isCurrent && isRunning) {
      item.labelEl.textContent = config.runningText;
    } else {
      item.labelEl.textContent = config.triggerText;
    }
  }
}

function buildFillTipText(actionKey, cacheHit) {
  const modeLabel =
    actionKey === "incrementalPage"
      ? "增量填入"
      : actionKey === "selection"
        ? "选区填入"
        : "本次填充";

  return cacheHit
    ? `${modeLabel}复用了本地字段映射缓存。`
    : `${modeLabel}已生成新的字段映射，并写入本地缓存。`;
}

function isSupportedWebPageUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch (_) {
    return false;
  }
}

document.getElementById("analyzePageRequirementsBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const query = new URLSearchParams();
  if (tab?.id && /^https?:\/\//.test(tab.url || "")) query.set("sourceTabId", tab.id);
  const templateId = document.getElementById("fillTemplateSelect").value;
  if (templateId) query.set("templateId", templateId);
  await chrome.tabs.create({ url: chrome.runtime.getURL("resume-documents.html") + "?" + query });
});

async function ensureContentScriptInjected(tabId) {
  let staleScriptDetected = false;

  try {
    const pong = await sendTabMessage(tabId, { action: "ping" });
    if (contentBridge.contentScriptHasDiagnosticsSupport(pong)) {
      return true;
    }

    if (pong?.success) {
      staleScriptDetected = true;
    }
  } catch (_) {
    // Ignore and inject below when there is no reachable content script.
  }

  if (staleScriptDetected) {
    return false;
  }

  return injectContentScript(tabId);
}

async function injectContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isSupportedWebPageUrl(tab.url)) {
      return false;
    }

    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "shared/resume-schema.js",
        "shared/diagnostics.js",
        "shared/field-text.js",
        "shared/field-semantics.js",
        "shared/fill-runtime.js",
        "shared/content-bridge.js",
        "shared/ai-client.js",
        "content.js",
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    const pong = await sendTabMessage(tabId, { action: "ping" });
    return Boolean(contentBridge.contentScriptHasDiagnosticsSupport(pong));
  } catch (error) {
    console.error("[popup] 注入 content script 失败:", error);
    return false;
  }
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function parseJsonFromAiText(text) {
  const trimmed = normalizeAiJsonInput(text);
  if (!trimmed) throw new Error("AI 返回为空");

  const direct = tryParseJsonVariants(trimmed);
  if (direct.ok) return direct.value;

  const noFences = trimmed
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const noFenceParsed = tryParseJsonVariants(noFences);
  if (noFenceParsed.ok) return noFenceParsed.value;

  for (const candidate of extractJsonCandidates(noFences)) {
    const parsed = tryParseJsonVariants(candidate);
    if (parsed.ok) return parsed.value;
  }

  throw new Error("无法解析 AI 返回的 JSON");
}

function normalizeAiJsonInput(text) {
  return String(text || "").replace(/^\uFEFF/, "").trim();
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (_) {
    return { ok: false };
  }
}

function tryParseJsonVariants(text) {
  const candidates = [String(text || "").trim(), sanitizeLikelyJson(text)];
  const seen = new Set();

  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    const parsed = tryParseJson(normalized);
    if (parsed.ok) return parsed;
  }

  return { ok: false };
}

function sanitizeLikelyJson(text) {
  return String(text || "")
    .trim()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

function extractJsonCandidates(text) {
  const candidates = [extractLikelyJson(text), extractBalancedJson(text)];
  return Array.from(
    new Set(candidates.map((item) => String(item || "").trim()).filter(Boolean))
  );
}

function extractLikelyJson(text) {
  const firstObj = text.indexOf("{");
  const lastObj = text.lastIndexOf("}");
  const firstArr = text.indexOf("[");
  const lastArr = text.lastIndexOf("]");

  const objCandidate =
    firstObj !== -1 && lastObj !== -1 && lastObj > firstObj
      ? text.slice(firstObj, lastObj + 1)
      : null;
  const arrCandidate =
    firstArr !== -1 && lastArr !== -1 && lastArr > firstArr
      ? text.slice(firstArr, lastArr + 1)
      : null;

  if (objCandidate && arrCandidate) {
    return firstObj < firstArr ? objCandidate : arrCandidate;
  }
  return objCandidate || arrCandidate || text;
}

function extractBalancedJson(text) {
  const source = String(text || "");
  let start = -1;
  let inString = false;
  let isEscaped = false;
  const stack = [];

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (start === -1) {
      if (char === "{" || char === "[") {
        start = index;
        stack.push(char);
      }
      continue;
    }

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === "}" || char === "]") {
      const last = stack[stack.length - 1];
      const matchesPair =
        (last === "{" && char === "}") || (last === "[" && char === "]");

      if (!matchesPair) return "";

      stack.pop();
      if (stack.length === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return "";
}

function updateStatus(type, text) {
  statusDot.className = `status-dot ${type}`;
  statusText.textContent = text;
}

function addLog(type, message) {
  if (type === "error" || type === "warning") document.getElementById("runLogs").open = true;
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

  recordSessionLog(type, message, now.toISOString());

  if (!logVisibility.shouldRenderLogInUi(type, message)) {
    return;
  }

  const item = document.createElement("div");
  item.className = `log-item log-${type}`;
  item.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-msg">${escapeHtml(message)}</span>
  `;
  logContent.appendChild(item);
  logContent.scrollTop = logContent.scrollHeight;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

clearLogBtn.addEventListener("click", () => {
  logContent.innerHTML = "";
  addLog("info", "日志已清空");
});

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "log":
      addLog(message.level || "info", message.text || "");
      break;
    case "updateStats":
      updateFillStats(
        message.fieldCount ?? 0,
        message.mappedCount ?? 0,
        message.filledCount ?? 0
      );
      break;
    case "error":
      updateStatus("error", "错误");
      addLog("error", message.text || "未知错误");
      break;
    default:
      break;
  }
});
