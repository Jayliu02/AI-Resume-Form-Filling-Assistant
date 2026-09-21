(function () {
  "use strict";
  const D = ResumeDocuments, $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let docs = [], templates = [], draft, baseUpdatedAt, dirty = false, busy = false, reviewView;
  const status = text => { $("documentStatus").textContent = text; };
  const node = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
  async function request(method, extra = {}) {
    const response = await chrome.runtime.sendMessage({ action: "resumeDocuments", method, ...extra });
    if (!response?.ok) throw new Error(response?.error || "文档后台未响应");
    return response.value;
  }
  async function task(fn) {
    if (busy) return;
    busy = true;
    const controls = [...document.querySelectorAll("button,input,select,textarea")].filter(el => !el.closest("dialog"));
    const disabledBefore = new Map(controls.map(el => [el, el.disabled]));
    controls.forEach(el => { el.disabled = true; });
    try { await fn(); } catch (error) { status(error.message); }
    finally { busy = false; controls.forEach(el => { el.disabled = disabledBefore.get(el); }); reviewView?.refresh(); }
  }
  function newDraft() {
    draft = { version: 1, id: crypto.randomUUID(), title: "", createdAt: new Date().toISOString(), updatedAt: "", pages: [], analysis: null, comparedResume: null, review: null, approvals: [] };
    baseUpdatedAt = undefined; dirty = false; render();
  }
  function renderList() {
    $("documentList").replaceChildren(...docs.map(doc => { const option = node("option", doc.title); option.value = doc.id; return option; }));
    $("documentList").value = draft?.id || "";
  }
  function render() {
    reviewView = ResumeSuggestionsUI.render($("suggestionReview"), draft, {
      onChange: () => { dirty = true; },
      onApply: selectedIds => task(async () => {
        const result = await request("applySuggestions", { document: draft, baseUpdatedAt, selectedIds });
        draft = result.document; baseUpdatedAt = draft.updatedAt; dirty = false;
        if (result.template) templates = templates.map(t => t.id === result.template.id ? result.template : t);
        docs = await request("list"); render();
        status(result.alreadyApplied ? "本批次已经应用，未重复修改。" : `已批准并应用 ${selectedIds.length} 项修改到「${draft.review.baseTemplate.name}」。未选建议未写入。`);
      }),
    });
    $("documentTitle").value = draft.title;
    renderList();
    $("pages").replaceChildren();
    $("pageSourceCount").textContent = `（${draft.pages.length} 页）`;
    draft.pages.forEach((page, index) => {
      const card = node("details", "", "page-card");
      card.append(node("summary", `${index + 1}. ${page.title} · ${page.fields.length} 个字段`), node("p", page.url), node("p", `采集时间：${page.capturedAt}`), node("p", page.limitations));
      const details = node("details", ""); details.append(node("summary", "查看字段与已填内容"));
      for (const field of page.fields) details.append(node("pre", `${field.id} · ${field.section} / ${field.label}\n${field.required ? "明确必填" : "未发现必填标记"} · ${field.type}\n限制：${JSON.stringify(field.constraints)}\n选项：${field.options.join("、")}\n提示：${field.placeholder}\n说明：${field.instructions}\n网页已填内容：${field.valueCaptured ? (field.value || "（空）") : "未采集，请重新读取"}`));
      card.append(details); $("pages").append(card);
    });
    const preview = $("analysisPreview"); preview.replaceChildren();
    $("analysisCount").textContent = "";
    if (!draft.analysis) { preview.append(node("p", "尚未分析。可先保存采集草稿，稍后重试分析。")); return; }
    const overview = node("details", ""); overview.append(node("summary", "查看 AI 总结"), node("p", draft.analysis.summary));
    preview.append(overview, node("p", `对照：${draft.comparedResume?.name || "未知"} · 分析时间：${draft.comparedResume?.analyzedAt || "未知"}`));
    const current = templates.find(t => t.id === draft.comparedResume?.id);
    if (!current || current.updatedAt !== draft.comparedResume.updatedAt) preview.append(node("p", "对照简历已变化或不存在，建议重新分析。"));
    const statuses = { missing: "资料缺失", review: "需要核对", available: "已有资料", unknown: "未知" };
    const requirements = D.compactRequirements(draft.analysis.requirements, draft.pages);
    const existingCount = requirements.filter(r => r.status === "available").length;
    $("analysisCount").textContent = `（${requirements.length - existingCount} 项待处理）`;
    const includeExisting = document.createElement("input"); includeExisting.type = "checkbox";
    const toggle = node("label", "", "analysis-toggle"); toggle.append(includeExisting, node("span", `包含已有资料（${existingCount} 项）`)); preview.append(toggle);
    const controls = node("div", "", "review-pagination");
    const previous = node("button", "上一页", "btn btn-outline"), next = node("button", "下一页", "btn btn-outline"), info = node("span", "");
    controls.append(previous, info, next); preview.append(controls);
    const list = node("div", ""); preview.append(list); let pageIndex = 0;
    function renderRequirements() {
      const filtered = requirements.filter(r => includeExisting.checked || r.status !== "available");
      const count = Math.max(1, Math.ceil(filtered.length / 8)); pageIndex = Math.min(pageIndex, count - 1);
      previous.disabled = pageIndex === 0; next.disabled = pageIndex >= count - 1;
      info.textContent = filtered.length ? `第 ${pageIndex + 1}/${count} 页 · ${filtered.length} 项` : "没有待处理的资料缺口";
      list.replaceChildren();
      for (const r of filtered.slice(pageIndex * 8, (pageIndex + 1) * 8)) {
      const card = node("details", "", "requirement-card");
      card.append(node("summary", `${r.section} · ${statuses[r.status]} · ${r.requirement}`), node("p", `对应简历字段：${r.resumePath || "未匹配"}`), node("p", `补充建议：${r.suggestion || "无"}`));
      const evidence = r.evidence.map(id => {
        for (const [index, p] of draft.pages.entries()) { const f = p.fields.find(f => `${p.id}/${f.id}` === id); if (f) return `第 ${index + 1} 页 ${p.title} / ${f.label}`; }
        return id;
      });
      card.append(node("p", `来源证据：${evidence.join("；")}`)); list.append(card);
      }
    }
    previous.onclick = () => { if (pageIndex > 0) { pageIndex--; renderRequirements(); } };
    next.onclick = () => { if (!next.disabled) { pageIndex++; renderRequirements(); } };
    includeExisting.onchange = () => { pageIndex = 0; renderRequirements(); };
    renderRequirements();
  }
  async function refreshTabs() {
    const selected = $("sourceTab").value || params.get("sourceTabId");
    const tabs = (await chrome.tabs.query({})).filter(tab => /^https?:\/\//.test(tab.url || ""));
    $("sourceTab").replaceChildren(...tabs.map(tab => { const option = node("option", tab.title || new URL(tab.url).host); option.value = tab.id; return option; }));
    if (tabs.some(t => String(t.id) === selected)) $("sourceTab").value = selected;
  }
  function duplicateChoice(matches) {
    return new Promise(resolve => {
      const dialog = $("duplicatePage");
      $("replacePage").replaceChildren(...matches.map(p => { const option = node("option", `${draft.pages.indexOf(p) + 1}. ${p.title} (${p.capturedAt})`); option.value = p.id; return option; }));
      dialog.returnValue = "";
      const close = () => { dialog.removeEventListener("close", close); resolve(dialog.returnValue); };
      dialog.addEventListener("close", close);
      $("replaceDuplicate").onclick = () => dialog.close($("replacePage").value);
      $("appendDuplicate").onclick = () => dialog.close("append");
      $("cancelDuplicate").onclick = () => dialog.close("");
      dialog.showModal();
    });
  }
  async function capture() {
    const tabId = Number($("sourceTab").value);
    if (!tabId) throw new Error("请先打开招聘网页，再刷新网页列表");
    status("正在读取页面字段要求…");
    await chrome.scripting.executeScript({ target: { tabId }, files: ["shared/resume-schema.js", "shared/diagnostics.js", "shared/field-text.js", "shared/field-semantics.js", "shared/fill-runtime.js", "shared/content-bridge.js", "shared/ai-client.js", "shared/page-requirements.js", "content.js"] });
    const result = await chrome.tabs.sendMessage(tabId, { action: "captureRequirements" });
    if (!result?.success) throw new Error(result?.error || "页面脚本不支持采集，请刷新招聘网页后重试");
    const page = D.page(result.page);
    if (!page.fields.length) throw new Error("没有发现可读取的字段，请展开表单或切换页面后重试");
    const matches = draft.pages.filter(p => p.url === page.url);
    const choice = matches.length ? await duplicateChoice(matches) : "append";
    if (!choice) { status("已取消采集"); return; }
    if (choice === "append") {
      if (draft.pages.length >= 50) throw new Error("每份文档最多 50 页，请新建文档");
      page.id = crypto.randomUUID();
      draft.pages.push(page);
    } else { page.id = choice; draft.pages[draft.pages.findIndex(p => p.id === choice)] = page; }
    if (!draft.title) draft.title = page.title || "填写要求文档";
    draft.analysis = null; draft.comparedResume = null; draft.review = null; dirty = true; render();
    status("采集完成。可继续追加页面、分析或保存草稿。内容尚未保存。");
  }
  async function analyze() {
    if (!draft.pages.length) throw new Error("请先采集页面");
    const state = await ResumeStorage.loadTemplateState(); templates = state.templates;
    const selected = templates.find(t => t.id === $("compareResume").value);
    if (!selected) throw new Error("所选简历已删除，请重新打开文档页");
    const catalog = ResumeSchema.getCatalogWithValues(selected.profile);
    const model = await ResumeModelStorage.loadModelState();
    status("AI 正在分析要求和资料缺口，采集草稿会保留以供重试…");
    const analysis = await D.analyze(draft, catalog,
      prompt => ResumeAiClient.callAI(model.activeModelId || ResumeModelStorage.DEFAULT_MODEL.id, prompt, "page_requirements"), status, selected.profile);
    draft.analysis = analysis;
    draft.review = { id: crypto.randomUUID(), baseTemplate: ResumeSuggestions.snapshot(selected), items: structuredClone(analysis.suggestions) };
    draft.comparedResume = { id: selected.id, name: selected.name, updatedAt: selected.updatedAt, analyzedAt: new Date().toISOString() };
    dirty = true; render(); status("分析完成。可保存分析文档，或检查下方修改建议后逐项勾选并批准。原简历尚未修改。");
  }
  function download(value, extension) {
    const text = extension === "md" ? value : JSON.stringify(value, null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: extension === "md" ? "text/markdown;charset=utf-8" : "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `${(draft.title || "填写要求文档").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}.${extension}`;
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function discard() { return !dirty || confirm("当前文档有未保存的修改，是否放弃？"); }
  $("documentTitle").addEventListener("input", () => { draft.title = $("documentTitle").value; dirty = true; });
  $("newDocument").onclick = () => { if (discard()) { newDraft(); status(""); } };
  $("documentList").onchange = () => {
    const selected = $("documentList").value;
    if (!discard()) { $("documentList").value = draft.id; return; }
    const found = docs.find(d => d.id === selected); if (!found) return;
    draft = structuredClone(found); baseUpdatedAt = found.updatedAt; dirty = false;
    if (draft.comparedResume) $("compareResume").value = draft.comparedResume.id;
    render(); status("");
  };
  $("refreshTabs").onclick = () => task(refreshTabs);
  $("capturePage").onclick = () => task(capture);
  $("analyzeDocument").onclick = () => task(analyze);
  $("saveDocument").onclick = () => task(async () => {
    draft = await request("save", { document: draft, baseUpdatedAt }); baseUpdatedAt = draft.updatedAt; dirty = false;
    docs = await request("list"); render(); status("文档已保存到本机。");
  });
  $("deleteDocument").onclick = () => task(async () => {
    if (!confirm("删除当前文档？此操作不修改简历。")) return;
    await request("delete", { id: draft.id, baseUpdatedAt }); docs = await request("list"); newDraft(); status("已删除文档");
  });
  $("exportMarkdown").onclick = () => download(D.markdown(draft), "md");
  $("exportDraft").onclick = () => {
    if (!draft.pages.length) { status("请先采集页面"); return; }
    download({ kind: "resume-requirement-documents", version: 1, documents: [draft] }, "json");
  };
  $("exportLibrary").onclick = () => task(async () => { download(await request("export"), "json"); status("已导出已保存文档；未保存内容请使用“导出当前 JSON”。"); });
  $("importLibrary").onclick = () => $("importFile").click();
  $("importFile").onchange = () => task(async () => {
    const file = $("importFile").files[0]; if (!file) return;
    try { docs = await request("import", { data: JSON.parse(await file.text()) }); renderList(); status("文档库已导入，标识冲突的文档保留为副本。"); }
    finally { $("importFile").value = ""; }
  });
  window.addEventListener("beforeunload", event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } });
  task(async () => {
    docs = await request("list"); const state = await ResumeStorage.loadTemplateState(); templates = state.templates;
    $("compareResume").replaceChildren(...templates.map(t => { const option = node("option", t.name); option.value = t.id; return option; }));
    $("compareResume").value = params.get("templateId") || state.activeTemplateId;
    newDraft(); await refreshTabs();
    if (params.has("sourceTabId")) await capture();
  });
})();
