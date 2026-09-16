const resumeNavEl = document.getElementById("resumeNav");
const resumeFormHost = document.getElementById("resumeFormHost");
const saveResumeBtn = document.getElementById("saveResumeBtn");
const reloadResumeBtn = document.getElementById("reloadResumeBtn");
const resumeImportTextEl = document.getElementById("resumeImportText");
const importResumeBtn = document.getElementById("importResumeBtn");
const uploadPdfBtn = document.getElementById("uploadPdfBtn");
const resumePdfFileEl = document.getElementById("resumePdfFile");
const pageStatusEl = document.getElementById("pageStatus");

const resumeTemplateSelect = document.getElementById("resumeTemplateSelect");
const newTemplateBtn = document.getElementById("newTemplateBtn");
const duplicateTemplateBtn = document.getElementById("duplicateTemplateBtn");
const renameTemplateBtn = document.getElementById("renameTemplateBtn");
const deleteTemplateBtn = document.getElementById("deleteTemplateBtn");
const exportTemplatesBtn = document.getElementById("exportTemplatesBtn");
const importTemplatesBtn = document.getElementById("importTemplatesBtn");
const importTemplatesFileEl = document.getElementById("importTemplatesFile");

const templateNameModal = document.getElementById("templateNameModal");
const templateNameModalTitle = document.getElementById("templateNameModalTitle");
const templateNameInput = document.getElementById("templateNameInput");
const templateNameStatus = document.getElementById("templateNameStatus");
const saveTemplateNameBtn = document.getElementById("saveTemplateNameBtn");
const closeTemplateNameBtn = document.getElementById("closeTemplateNameBtn");
const closeTemplateNameBackdrop = document.getElementById("closeTemplateNameBackdrop");

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

const resumePrompts = window.ResumePrompts;
if (!resumePrompts) {
  throw new Error("Resume prompts are not available");
}

const RESUME_TEMPLATES_KEY = resumeStorage.keys.templates;
const RESUME_ACTIVE_TEMPLATE_KEY = resumeStorage.keys.activeTemplateId;
const RESUME_LEGACY_PROFILE_KEY = resumeStorage.keys.profile;
const RESUME_LEGACY_RAW_TEXT_KEY = resumeStorage.keys.rawText;

const BUILTIN_MODEL = modelStorage.DEFAULT_MODEL;

let isImporting = false;
let isResumeDirty = false;
let resumeProfile = schema.createEmptyResumeProfile();
let templates = [];
let activeTemplateId = null;
let isLoadingResume = false;
let templateNameMode = null;
const collapsedResumeSections = new Set();

document.addEventListener("DOMContentLoaded", async () => {
  initResumeEditorEvents();
  initTemplateEvents();
  resumeImportTextEl.addEventListener("input", markResumeDirty);
  await initModels();
  await loadResumeProfile();
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

  if (isResumeDirty || isImporting) {
    updatePageStatus("info", "简历存储有更新；当前编辑已保留，保存时如有冲突将保留副本。完成编辑后可重新加载查看。");
    return;
  }

  loadResumeProfile().catch((error) => {
    console.error("[resume-editor] 同步简历配置失败:", error);
  });
});

function initResumeEditorEvents() {
  resumeNavEl.addEventListener("click", (event) => {
    const navBtn = event.target.closest("[data-resume-nav]");
    if (!navBtn) return;
    openResumeSection(navBtn.dataset.resumeNav, { scrollIntoView: true });
  });

  resumeFormHost.addEventListener("click", (event) => {
    const toggleBtn = event.target.closest("[data-section-toggle]");
    if (toggleBtn) {
      toggleResumeSection(toggleBtn.dataset.sectionToggle);
      return;
    }

    const addBtn = event.target.closest("[data-section-add]");
    if (addBtn) {
      addResumeListItem(addBtn.dataset.sectionAdd);
      return;
    }

    const removeBtn = event.target.closest("[data-section-remove]");
    if (removeBtn) {
      removeResumeListItem(
        removeBtn.dataset.sectionRemove,
        Number(removeBtn.dataset.itemIndex)
      );
    }
  });
}

function initTemplateEvents() {
  resumeTemplateSelect.addEventListener("change", () => {
    switchActiveTemplate(resumeTemplateSelect.value);
  });

  newTemplateBtn.addEventListener("click", () => openTemplateNameModal("create"));
  duplicateTemplateBtn.addEventListener("click", handleDuplicateTemplate);
  renameTemplateBtn.addEventListener("click", () => openTemplateNameModal("rename"));
  deleteTemplateBtn.addEventListener("click", handleDeleteTemplate);

  exportTemplatesBtn.addEventListener("click", handleExportTemplates);
  importTemplatesBtn.addEventListener("click", () => {
    importTemplatesFileEl.value = "";
    importTemplatesFileEl.click();
  });
  importTemplatesFileEl.addEventListener("change", handleImportTemplates);
  closeTemplateNameBtn.addEventListener("click", closeTemplateNameModal);
  closeTemplateNameBackdrop.addEventListener("click", closeTemplateNameModal);
  saveTemplateNameBtn.addEventListener("click", handleSaveTemplateName);
  templateNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      handleSaveTemplateName();
    }
  });
}

function renderTemplateSelectors() {
  resumeTemplateSelect.innerHTML = templates
    .map(
      (template) =>
        `<option value="${escapeHtml(template.id)}">${escapeHtml(
          template.name
        )}</option>`
    )
    .join("");
  resumeTemplateSelect.value = activeTemplateId;
}

async function switchActiveTemplate(id) {
  if (!id || id === activeTemplateId) return;

  if (isResumeDirty) {
    await persistResumeProfile({ silent: true });
  }

  await resumeStorage.setActiveTemplateId(id);
  await loadResumeProfile();
}

function openTemplateNameModal(mode) {
  templateNameMode = mode;

  if (mode === "rename") {
    const current = templates.find((template) => template.id === activeTemplateId);
    templateNameInput.value = current?.name || "";
    templateNameModalTitle.textContent = "重命名模板";
  } else {
    templateNameInput.value = "";
    templateNameModalTitle.textContent = "新建模板";
  }

  templateNameStatus.textContent = "";
  templateNameStatus.className = "config-status";
  templateNameModal.classList.add("open");
  setTimeout(() => templateNameInput.focus(), 50);
}

function closeTemplateNameModal() {
  templateNameModal.classList.remove("open");
  templateNameMode = null;
}

async function handleSaveTemplateName() {
  const name = templateNameInput.value.trim();
  if (!name) {
    templateNameStatus.textContent = "名称不能为空";
    templateNameStatus.className = "config-status error";
    return;
  }

  saveTemplateNameBtn.disabled = true;
  try {
    if (templateNameMode === "rename") {
      await resumeStorage.renameTemplate(activeTemplateId, name);
      templates = templates.map((template) =>
        template.id === activeTemplateId ? { ...template, name } : template
      );
      renderTemplateSelectors();
      updatePageStatus("success", "已重命名模板");
    } else {
      if (isResumeDirty) {
        await persistResumeProfile({ silent: true });
      }
      const template = await resumeStorage.createTemplate(name);
      await resumeStorage.setActiveTemplateId(template.id);
      await loadResumeProfile();
      updatePageStatus("success", `已新建模板：${template.name}`);
    }
    closeTemplateNameModal();
  } catch (error) {
    templateNameStatus.textContent = error.message;
    templateNameStatus.className = "config-status error";
  } finally {
    saveTemplateNameBtn.disabled = false;
  }
}

async function handleExportTemplates() {
  try {
    if (isResumeDirty) await persistResumeProfile({ silent: true });
    const payload = await resumeStorage.exportTemplateData();
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `简历模板备份-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    updatePageStatus("success", `已导出 ${payload.templates.length} 份简历`);
  } catch (error) {
    updatePageStatus("error", `导出失败：${error.message}`);
  }
}

async function handleImportTemplates() {
  const file = importTemplatesFileEl.files?.[0];
  if (!file) return;

  if (!window.confirm("导入会覆盖当前所有简历模板，确定继续吗？")) {
    importTemplatesFileEl.value = "";
    return;
  }

  try {
    const text = await readFileAsText(file);
    const data = JSON.parse(text);
    const result = await resumeStorage.importTemplateData(data);
    await loadResumeProfile();
    updatePageStatus("success", `已导入 ${result.templates.length} 份简历`);
  } catch (error) {
    updatePageStatus("error", `导入失败：${error.message}`);
  } finally {
    importTemplatesFileEl.value = "";
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsText(file);
  });
}

async function handleDuplicateTemplate() {
  if (isResumeDirty) {
    await persistResumeProfile({ silent: true });
  }

  try {
    const template = await resumeStorage.duplicateTemplate(activeTemplateId);
    await resumeStorage.setActiveTemplateId(template.id);
    await loadResumeProfile();
    updatePageStatus("success", `已复制为模板：${template.name}`);
  } catch (error) {
    updatePageStatus("error", `复制失败：${error.message}`);
  }
}

async function handleDeleteTemplate() {
  if (templates.length <= 1) {
    updatePageStatus("warning", "至少保留一个模板");
    return;
  }

  const current = templates.find((template) => template.id === activeTemplateId);
  if (!window.confirm(`确定删除模板「${current?.name || ""}」吗？此操作不可恢复。`)) {
    return;
  }

  activeTemplateId = await resumeStorage.deleteTemplate(activeTemplateId);
  await loadResumeProfile();
  updatePageStatus("success", "已删除模板");
}

async function initModels() {
  await modelStorage.loadModelState();
}

async function getAllModels() {
  const state = await modelStorage.loadModelState();
  return [modelStorage.buildBuiltinModel(state.builtinOverride), ...state.models];
}

async function getActiveModel() {
  const state = await modelStorage.loadModelState();
  const models = await getAllModels();
  const activeId = state.activeModelId || BUILTIN_MODEL.id;
  return models.find((model) => model.id === activeId) || BUILTIN_MODEL;
}

function isModelConfigured(model) {
  return Boolean(model?.baseUrl && model?.apiKey && model?.model);
}

function resetCollapsedResumeSections() {
  collapsedResumeSections.clear();
  getEditorSections().forEach((section) => collapsedResumeSections.add(section.key));
  collapsedResumeSections.delete("personal");
}

async function loadResumeProfile() {
  if (isLoadingResume) return;
  isLoadingResume = true;

  try {
    const state = await resumeStorage.loadTemplateState();
    templates = state.templates;
    activeTemplateId = state.activeTemplateId;
    renderTemplateSelectors();

    const active = state.templates.find(
      (template) => template.id === state.activeTemplateId
    );
    resumeProfile = schema.normalizeResumeProfile(active?.profile || {});
    resumeImportTextEl.value = active?.rawText || "";
    resetCollapsedResumeSections();
    renderResumeEditor(resumeProfile);
    isResumeDirty = false;
    saveResumeBtn.disabled = true;
    updatePageStatus(
      "info",
      `已加载「${active?.name || "未命名"}」`
    );
  } finally {
    isLoadingResume = false;
  }
}

function getEditorSections() {
  return schema.sections.filter((section) => !["certificates", "languages"].includes(section.key)).map((section) =>
    section.key === "skills"
      ? { ...section, label: "技能证书", children: [section, schema.getSectionDefinition("certificates"), schema.getSectionDefinition("languages")] }
      : { ...section, children: [section] }
  );
}

function editorSectionKey(key) {
  return ["certificates", "languages"].includes(key) ? "skills" : key;
}

function getResumeProgress(filledFields, totalFields) {
  const filled = Math.max(0, Number(filledFields) || 0);
  const total = Math.max(0, Number(totalFields) || 0);
  const percentage = total ? Math.min(100, Math.round((filled / total) * 100)) : 0;
  const level = percentage <= 33 ? "low" : percentage <= 66 ? "medium" : "high";
  return { filled, total, percentage, level };
}

function updateResumeNavProgress(sectionKey, filledFields, totalFields) {
  const nav = resumeNavEl.querySelector(`[data-resume-nav="${sectionKey}"]`);
  if (!nav) return;

  const progress = getResumeProgress(filledFields, totalFields);
  nav.classList.toggle("has-value", progress.filled > 0);
  nav.dataset.progressLevel = progress.level;
  nav.querySelector(".resume-nav-count").textContent = `${progress.filled}/${progress.total}`;
  nav.querySelector(".resume-nav-percent").textContent = `${progress.percentage}%`;
  nav.querySelector(".resume-nav-progress-fill").style.width = `${progress.percentage}%`;
  nav.querySelector(".resume-nav-progress").setAttribute("aria-valuenow", String(progress.percentage));
}

function updateResumeNavProgressFromForm() {
  const progressBySection = new Map();
  for (const control of resumeFormHost.querySelectorAll("[data-resume-path]")) {
    const sectionKey = editorSectionKey(String(control.dataset.resumePath || "").split(".")[0]);
    const progress = progressBySection.get(sectionKey) || { filled: 0, total: 0 };
    progress.total += 1;
    if (hasMeaningfulResumeValue(control.value)) progress.filled += 1;
    progressBySection.set(sectionKey, progress);
  }

  for (const section of getEditorSections()) {
    const progress = progressBySection.get(section.key) || { filled: 0, total: 0 };
    updateResumeNavProgress(section.key, progress.filled, progress.total);
  }
}

function renderResumeEditor(profile) {
  const stats = buildResumeSectionStats(profile);
  resumeNavEl.replaceChildren();
  resumeFormHost.replaceChildren();
  for (const section of getEditorSections()) {
    const isCollapsed = collapsedResumeSections.has(section.key);
    const filled = section.children.reduce((count, child) => count + (stats.get(child.key)?.filledFields || 0), 0);
    const total = section.children.reduce((count, child) => count + (stats.get(child.key)?.totalFields || 0), 0);
    const progress = getResumeProgress(filled, total);
    const nav = document.createElement("button");
    nav.type = "button";
    nav.className = `resume-nav-btn${filled ? " has-value" : ""}${isCollapsed ? "" : " is-expanded"}`;
    nav.dataset.resumeNav = section.key;
    nav.dataset.progressLevel = progress.level;
    nav.innerHTML = `<span class="resume-nav-title-row">
      <span class="resume-nav-label">${escapeHtml(section.label)}</span>
      <span class="resume-nav-percent">${progress.percentage}%</span>
    </span>
    <span class="resume-nav-meta"><span class="resume-nav-count">${progress.filled}/${progress.total}
    <span class="resume-nav-progress" role="progressbar" aria-label="${escapeHtml(section.label)}填充进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percentage}">
      <span class="resume-nav-progress-fill" style="width: ${progress.percentage}%"></span>
    </span>`;
    resumeNavEl.appendChild(nav);

    const panel = document.createElement("section");
    panel.className = `resume-section${isCollapsed ? " is-collapsed" : ""}`;
    panel.dataset.sectionKey = section.key;
    panel.id = `resume-section-${section.key}`;
    const head = document.createElement("div");
    head.className = "resume-section-head";
    head.innerHTML = `<button type="button" class="resume-section-toggle" data-section-toggle="${section.key}" aria-expanded="${!isCollapsed}">
      <span class="resume-section-toggle-icon">▸</span>
      <span class="resume-section-title">${escapeHtml(section.label)}</span>
      <span class="resume-section-summary">${filled ? `${filled} 项` : ""}</span>
    </button>`;
    panel.appendChild(head);
    const body = document.createElement("div");
    body.className = "resume-section-body";
    for (const child of section.children) {
      const group = document.createElement("div");
      group.className = "resume-subsection";
      if (section.children.length > 1) {
        const title = document.createElement("h3");
        title.className = "resume-subsection-title";
        title.textContent = child.key === "skills" ? "技能" : child.label;
        group.appendChild(title);
      }
      if (child.type === "group") group.appendChild(renderFieldGrid(child.fields, profile, child.key));
      else {
        const items = profile[child.key] || [];
        items.forEach((item, index) => {
          const slot = document.createElement("div");
          slot.className = "resume-slot";
          const slotHead = document.createElement("div");
          slotHead.className = "resume-slot-head-main";
          slotHead.innerHTML = `<span class="resume-slot-title">${escapeHtml(child.itemLabel)} ${index + 1}</span>
            ${items.length > 1 ? `<button type="button" class="btn-text" data-section-remove="${child.key}" data-item-index="${index}">删除</button>` : ""}`;
          slot.appendChild(slotHead);
          slot.appendChild(renderFieldGrid(child.fields, profile, `${child.key}.${index}`));
          group.appendChild(slot);
        });
        const add = document.createElement("button");
        add.type = "button";
        add.className = "btn btn-outline btn-sm";
        add.dataset.sectionAdd = child.key;
        add.disabled = items.length >= child.slots;
        add.textContent = `新增${child.itemLabel}`;
        group.appendChild(add);
      }
      body.appendChild(group);
    }
    panel.appendChild(body);
    resumeFormHost.appendChild(panel);
  }
}

function renderFieldGrid(fields, profile, prefix) {
  const grid = document.createElement("div");
  grid.className = "resume-fields-grid";
  for (const field of fields) {
    const path = `${prefix}.${field.key}`;
    const wrapper = document.createElement("div");
    wrapper.className = `resume-field${prefix === "skills" && field.key !== "notableAchievements" ? " resume-field-compact" : ""}`;
    const label = document.createElement("label");
    label.className = "resume-field-label";
    label.textContent = field.label;
    const control = createFieldControl(field, schema.getValueByPath(profile, path), path);
    control.id = `field-${path}`;
    if (field.input !== "date") label.htmlFor = control.id;
    wrapper.appendChild(label);
    wrapper.appendChild(control);
    grid.appendChild(wrapper);
  }
  return grid;
}

function createFieldControl(field, value, path) {
  if (field.input === "date") return ResumeDateControl.create(document, field, value, path, markResumeDirty);
  let control;

  if (field.input === "textarea") {
    control = document.createElement("textarea");
    control.className = "resume-textarea";
  } else if (field.input === "select") {
    control = document.createElement("select");
    control.className = "resume-select";
    for (const optionValue of field.options || []) {
      const optionEl = document.createElement("option");
      optionEl.value = optionValue;
      optionEl.textContent = optionValue || "请选择";
      control.appendChild(optionEl);
    }
  } else {
    control = document.createElement("input");
    control.className = "resume-input";
    control.type = field.input || "text";
  }

  control.dataset.resumePath = path;
  control.value = value == null ? "" : String(value);
  if (field.placeholder) {
    control.placeholder = field.placeholder;
  }

  control.addEventListener("input", markResumeDirty);
  control.addEventListener("change", markResumeDirty);
  return control;
}

function markResumeDirty() {
  isResumeDirty = true;
  saveResumeBtn.disabled = false;
  updateResumeNavProgressFromForm();
  updatePageStatus("warning", "未保存");
}

function hasMeaningfulResumeValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return true;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulResumeValue(item));
  if (typeof value === "object") {
    return Object.values(value).some((item) => hasMeaningfulResumeValue(item));
  }
  return false;
}

function buildResumeSectionStats(profile) {
  const statsBySection = new Map();
  const catalog = schema.getCatalogWithValues(profile);

  for (const section of schema.sections) {
    const items = Array.isArray(profile[section.key]) ? profile[section.key] : [];
    statsBySection.set(section.key, {
      totalFields: 0,
      filledFields: 0,
      itemCount: items.length,
      filledItems: items.filter((item) => hasMeaningfulResumeValue(item)).length,
    });
  }

  for (const field of catalog) {
    const stats = statsBySection.get(field.sectionKey);
    if (!stats) continue;
    stats.totalFields += 1;
    if (field.hasValue) {
      stats.filledFields += 1;
    }
  }

  return statsBySection;
}

function collectResumeProfileFromForm() {
  const nextProfile = schema.clone(resumeProfile);
  const controls = resumeFormHost.querySelectorAll("[data-resume-path]");

  controls.forEach((control) => {
    schema.setValueByPath(
      nextProfile,
      control.dataset.resumePath,
      String(control.value || "").trim()
    );
  });

  return schema.normalizeResumeProfile(nextProfile);
}

function syncResumeProfileFromForm() {
  resumeProfile = collectResumeProfileFromForm();
  return resumeProfile;
}

function applyResumeSectionState(sectionKey) {
  const sectionEl = resumeFormHost.querySelector(`[data-section-key="${sectionKey}"]`);
  const navBtn = resumeNavEl.querySelector(`[data-resume-nav="${sectionKey}"]`);
  const isCollapsed = collapsedResumeSections.has(sectionKey);

  if (sectionEl) {
    sectionEl.classList.toggle("is-collapsed", isCollapsed);
    const toggleBtn = sectionEl.querySelector("[data-section-toggle]");
    if (toggleBtn) {
      toggleBtn.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    }
  }

  if (navBtn) {
    navBtn.classList.toggle("is-expanded", !isCollapsed);
  }
}

function toggleResumeSection(sectionKey) {
  if (!sectionKey) return;

  if (collapsedResumeSections.has(sectionKey)) {
    collapsedResumeSections.delete(sectionKey);
  } else {
    collapsedResumeSections.add(sectionKey);
  }

  applyResumeSectionState(sectionKey);
}

function openResumeSection(sectionKey, { scrollIntoView = false } = {}) {
  sectionKey = editorSectionKey(sectionKey);
  if (!sectionKey) return;

  collapsedResumeSections.delete(sectionKey);
  applyResumeSectionState(sectionKey);

  if (scrollIntoView) {
    const sectionEl = document.getElementById(`resume-section-${sectionKey}`);
    sectionEl?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function focusResumeField(path) {
  const control = resumeFormHost.querySelector(`[data-resume-path="${path}"]`);
  if (!control) return;

  control.focus();
  if (typeof control.select === "function") {
    control.select();
  }
}

function addResumeListItem(sectionKey) {
  const section = schema.getSectionDefinition(sectionKey);
  if (!section || section.type !== "list") return;

  const nextProfile = syncResumeProfileFromForm();
  const items = Array.isArray(nextProfile[sectionKey]) ? [...nextProfile[sectionKey]] : [];
  if (items.length >= section.slots) return;

  items.push(schema.createEmptyListItem(sectionKey));
  // The profile is already normalized; keep the new empty final slot editable.
  resumeProfile = {
    ...nextProfile,
    [sectionKey]: items,
  };

  collapsedResumeSections.delete(editorSectionKey(sectionKey));
  renderResumeEditor(resumeProfile);
  markResumeDirty();

  const nextPath = `${sectionKey}.${items.length - 1}.${section.fields[0]?.key || ""}`;
  openResumeSection(sectionKey, { scrollIntoView: true });
  if (section.fields[0]?.key) {
    focusResumeField(nextPath);
  }
}

function removeResumeListItem(sectionKey, itemIndex) {
  const section = schema.getSectionDefinition(sectionKey);
  if (!section || section.type !== "list") return;

  const minItems = Math.max(1, Number(section.initialItems) || 1);
  const nextProfile = syncResumeProfileFromForm();
  const items = Array.isArray(nextProfile[sectionKey]) ? [...nextProfile[sectionKey]] : [];

  if (items.length <= minItems) return;
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= items.length) return;

  items.splice(itemIndex, 1);
  resumeProfile = schema.normalizeResumeProfile({
    ...nextProfile,
    [sectionKey]: items,
  });

  collapsedResumeSections.delete(editorSectionKey(sectionKey));
  renderResumeEditor(resumeProfile);
  markResumeDirty();
  openResumeSection(sectionKey);
}

async function persistResumeProfile({ silent = false } = {}) {
  const nextProfile = collectResumeProfileFromForm();

  resumeProfile = nextProfile;
  const savedTemplate = await resumeStorage.saveTemplateContent(activeTemplateId, {
    profile: nextProfile,
    schemaVersion: schema.version,
    rawText: resumeImportTextEl.value.trim(),
  });

  isResumeDirty = false;
  saveResumeBtn.disabled = true;
  if (savedTemplate?._syncConflict) {
    await loadResumeProfile();
    updatePageStatus("info", "已保存；检测到并发修改，已保留冲突副本，请在模板列表中检查整理。");
    return;
  }
  updatePageStatus("success", "已保存");

  if (!silent) {
    document.title = "简历配置 - AI 简历填表助手";
  }
}

saveResumeBtn.addEventListener("click", async () => {
  try { await persistResumeProfile(); }
  catch (error) { updatePageStatus("error", `保存失败：${error.message}`); }
});

reloadResumeBtn.addEventListener("click", async () => {
  if (isResumeDirty && !window.confirm("重新加载会放弃未保存的修改，继续吗？")) return;
  await loadResumeProfile();
  updatePageStatus("info", "已从扩展存储重新加载标准简历。");
});

importResumeBtn.addEventListener("click", async () => {
  await importResumeToSchema(resumeImportTextEl.value.trim());
});

uploadPdfBtn.addEventListener("click", () => {
  resumePdfFileEl.value = "";
  resumePdfFileEl.click();
});

resumePdfFileEl.addEventListener("change", async () => {
  const file = resumePdfFileEl.files?.[0];
  if (!file) return;

  if (file.type && file.type !== "application/pdf") {
    updatePageStatus("error", "请选择 PDF 文件。");
    return;
  }

  uploadPdfBtn.disabled = true;
  importResumeBtn.disabled = true;
  updatePageStatus("info", `正在提取 PDF 文本：${file.name}`);

  try {
    const text = await extractTextFromPdf(file);
    if (!text) {
      throw new Error("未提取到文本：如果是扫描版 PDF，请先转为可复制文字或使用 OCR");
    }

    resumeImportTextEl.value = text;
    markResumeDirty();

    updatePageStatus("success", "PDF 文本提取完成，开始导入到标准简历...");
    await importResumeToSchema(text);
  } catch (error) {
    updatePageStatus("error", `PDF 导入失败：${error.message}`);
  } finally {
    uploadPdfBtn.disabled = false;
    importResumeBtn.disabled = false;
  }
});

async function importResumeToSchema(rawText) {
  if (isImporting) return;

  const text = String(rawText || "").trim();
  if (!text) {
    updatePageStatus("warning", "请先粘贴原始简历文本，或上传 PDF。");
    return;
  }

  const activeModel = await getActiveModel();
  if (!isModelConfigured(activeModel)) {
    updatePageStatus("error", "请先在侧边栏的模型设置中配置可用模型。");
    return;
  }

  isImporting = true;
  importResumeBtn.disabled = true;
  uploadPdfBtn.disabled = true;
  importResumeBtn.textContent = "导入中...";
  updatePageStatus("info", "正在调用 AI 预填...");

  try {
    const prompt = resumePrompts.buildResumeImportPrompt(
      schema,
      limitTextForPrompt(text)
    );
    const aiText = await aiClient.callAI(activeModel.id, prompt, "resume_import");
    const parsed = parseJsonFromAiText(aiText);
    // Keep archived data out of AI extraction, but preserve it when replacing visible fields.
    const source = { ...parsed, additional: { ...parsed.additional } };
    if (resumeProfile.identityAndAuthorization) source.identityAndAuthorization = resumeProfile.identityAndAuthorization;
    else delete source.identityAndAuthorization;
    for (const key of ["publications", "patents"]) {
      if (resumeProfile.additional?.[key]) source.additional[key] = resumeProfile.additional[key];
    }
    const normalized = schema.normalizeResumeProfile(source);
    resumeProfile = normalized;
    resumeImportTextEl.value = text;
    resetCollapsedResumeSections();
    renderResumeEditor(normalized);
    markResumeDirty();

    updatePageStatus("success", "已预填，请检查后保存。");
  } catch (error) {
    updatePageStatus("error", `导入失败：${error.message}`);
  } finally {
    isImporting = false;
    importResumeBtn.disabled = false;
    uploadPdfBtn.disabled = false;
    importResumeBtn.textContent = "AI 预填";
  }
}

function limitTextForPrompt(text) {
  const maxChars = 60000;
  if (text.length <= maxChars) return text;

  updatePageStatus(
    "warning",
    `文本过长（${text.length} 字），已截断前 ${maxChars} 字用于导入。`
  );
  return text.slice(0, maxChars);
}

async function extractTextFromPdf(file) {
  const pdfjs = getPdfJsLib();
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
      "libs/pdfjs/pdf.worker.min.js"
    );
  } catch (_) {
    // ignore
  }

  const data = await file.arrayBuffer();
  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;

  const total = pdf.numPages || 0;
  const parts = [];

  for (let pageNo = 1; pageNo <= total; pageNo += 1) {
    updatePageStatus("info", `正在解析 PDF (${pageNo}/${total})...`);
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();

    for (const item of content.items || []) {
      parts.push(item.str || "");
      parts.push(item.hasEOL ? "\n" : " ");
    }

    parts.push("\n\n");
  }

  return parts
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getPdfJsLib() {
  const lib = globalThis.pdfjsLib;
  if (!lib) {
    throw new Error("PDF 解析库未加载，请刷新页面后重试");
  }
  return lib;
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

function updatePageStatus(type, text) {
  if (!pageStatusEl) return;
  pageStatusEl.textContent = text;
  pageStatusEl.style.borderColor =
    type === "error"
      ? "rgba(239,68,68,0.28)"
      : type === "success"
        ? "rgba(16,185,129,0.28)"
        : type === "warning"
          ? "rgba(245,158,11,0.28)"
          : "var(--border)";
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
