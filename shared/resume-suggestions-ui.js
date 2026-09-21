(function (root) {
  "use strict";
  const S = root.ResumeSuggestions;
  const types = { text: "单行文本", textarea: "多行文本", date: "日期", select: "下拉选项", email: "邮箱", tel: "电话", url: "网址" };
  const kinds = { set_value: "修改内容", add_field: "新增字段", edit_field: "调整字段定义" };
  function node(tag, text, cls) { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; }
  function labeled(label, control, parent) {
    control.id = `suggestion-${crypto.randomUUID()}`;
    const title = node("label", label); title.htmlFor = control.id; parent.append(title, control); return control;
  }
  function render(host, doc, options) {
    host.replaceChildren();
    const selected = new Set(), cards = [], review = doc.review;
    const history = doc.approvals || [];
    if (history.length) {
      const details = node("details", ""); details.append(node("summary", `已应用记录（${history.length} 批）`));
      for (const entry of history) {
        details.append(node("p", `${entry.templateName} · ${entry.appliedAt} · ${entry.changes?.length || 0} 项修改`));
        for (const change of entry.changes || []) details.append(node("pre", `${kinds[change.suggestion?.kind] || "修改"} · ${change.afterDefinition?.label || "字段"}\n${(change.changes || []).map(c => `${c.recordLabel}：${c.before || "（空）"} → ${c.after || "（空）"}`).join("\n")}`));
      }
      host.append(details);
    }
    if (!review) {
      if (doc.analysis) host.append(node("p", "此分析没有可审批批次。请重新分析以生成结构化修改建议。"));
      return { refresh() {} };
    }
    host.append(node("h2", "审批简历修改建议"), node("p", `目标简历：${review.baseTemplate.name}。先检查或编辑建议，再勾选；仅在点击批准按钮后保存所选修改。`));
    if (history.some(a => a.reviewId === review.id)) {
      host.append(node("p", "本批次已应用。未选建议不会写入；如需继续修改，请重新分析并审批。"));
      return { refresh() {} };
    }
    const items = S.compact(review.items, review.baseTemplate.profile);
    if (!items.length) {
      host.append(node("p", "现有字段无需重复调整。本次没有新的可应用建议；资料缺口可展开分析依据查看。"));
      return { refresh() {} };
    }
    const error = node("p", "", "suggestion-error"); error.setAttribute("role", "status");
    const apply = node("button", "", "btn btn-primary"); apply.id = "applySuggestions";
    const footer = node("div", "", "document-actions approval-footer"); footer.append(apply); host.append(error, footer);
    let pageIndex = 0;
    const filters = node("div", "", "review-filters");
    const search = document.createElement("input"); search.placeholder = "搜索字段或修改理由"; search.setAttribute("aria-label", "搜索修改建议");
    const sectionFilter = document.createElement("select"); sectionFilter.setAttribute("aria-label", "筛选简历分区");
    const all = node("option", "全部分区"); all.value = ""; sectionFilter.append(all);
    for (const section of root.ResumeSchema.getSections(review.baseTemplate.profile)) if (items.some(item => item.sectionKey === section.key)) { const option = node("option", section.label); option.value = section.key; sectionFilter.append(option); }
    const previous = node("button", "上一页", "btn btn-outline"), next = node("button", "下一页", "btn btn-outline"), pageInfo = node("span", ""); pageInfo.setAttribute("role", "status");
    const pagination = node("div", "", "review-pagination"); pagination.append(previous, pageInfo, next);
    filters.append(search, sectionFilter); host.append(filters, pagination);
    function paintList() {
      const query = search.value.trim().toLowerCase();
      const visible = cards.filter(c => (!sectionFilter.value || c.item.sectionKey === sectionFilter.value) && (!query || [c.item.fieldKey, c.item.field?.label, c.item.reason, c.card.querySelector(".suggestion-choice").textContent].join(" ").toLowerCase().includes(query)));
      const count = Math.max(1, Math.ceil(visible.length / 6)); pageIndex = Math.min(pageIndex, count - 1);
      cards.forEach(c => { c.card.hidden = true; }); visible.slice(pageIndex * 6, (pageIndex + 1) * 6).forEach(c => { c.card.hidden = false; });
      pageInfo.textContent = visible.length ? `第 ${pageIndex + 1}/${count} 页 · ${visible.length} 项建议 · 已选 ${selected.size} 项` : "没有匹配的建议";
      previous.disabled = pageIndex === 0; next.disabled = pageIndex >= count - 1;
    }
    search.oninput = sectionFilter.onchange = () => { pageIndex = 0; paintList(); };
    previous.onclick = () => { if (pageIndex > 0) { pageIndex--; paintList(); } };
    next.onclick = () => { if (!next.disabled) { pageIndex++; paintList(); } };
    function refresh() {
      let invalid = false;
      for (const card of cards) {
        const p = S.preview(review.baseTemplate.profile, card.item);
        card.checkbox.disabled = p.errors.length > 0 || S.redundant(review.baseTemplate.profile, card.item);
        if (card.checkbox.disabled) { selected.delete(card.item.id); card.checkbox.checked = false; }
        card.errors.textContent = p.errors.join("；");
        const changedValues = (p.changes || []).filter(c => c.before !== c.after), first = changedValues[0];
        const short = value => value.length > 70 ? value.slice(0, 70) + "…" : value;
        card.brief.textContent = p.errors.length ? "需要补充信息，展开后处理" : first ? `${first.recordLabel}：${short(first.before || "（空）")} → ${short(first.after || "（空）")}${changedValues.length > 1 ? `，共 ${changedValues.length} 条记录` : ""}` : card.item.kind === "set_value" ? "内容已一致，无需修改" : `字段定义：${p.current?.label || "新增"} → ${p.field?.label || ""} / ${types[p.field?.input] || ""}`;
        card.values.textContent = (p.changes || []).filter(c => card.item.kind !== "set_value" || c.recordIndex === card.item.recordIndex || c.recordIndex === null)
          .map(c => `${c.recordLabel}\n当前：${c.before || "（空）"}\n应用后：${c.after || "（空）"}`).join("\n\n");
        if (selected.has(card.item.id) && p.errors.length) invalid = true;
      }
      error.textContent = "";
      if (selected.size && !invalid) {
        try { S.buildChanges(review.baseTemplate.profile, review.items.filter(item => selected.has(item.id))); }
        catch (e) { error.textContent = e.message; invalid = true; }
      }
      apply.textContent = `批准并应用到「${review.baseTemplate.name}」（${selected.size} 项）`;
      apply.disabled = !selected.size || invalid;
      paintList();
    }
    for (const item of items) {
      const card = node("section", "", "suggestion-card"); card.dataset.suggestionId = item.id;
      const section = root.ResumeSchema.getSections(review.baseTemplate.profile).find(s => s.key === item.sectionKey);
      const existing = section?.fields.find(f => f.key === item.fieldKey);
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.className = "suggestion-select";
      const choice = node("label", "", "suggestion-choice"); choice.append(checkbox, node("span", `${kinds[item.kind]} · ${section?.label || item.sectionKey} / ${existing?.label || item.field?.label || item.fieldKey}`)); card.append(choice);
      const brief = node("p", "", "suggestion-brief"); card.append(brief);
      const body = node("details", "", "suggestion-body"); body.append(node("summary", "查看差异与编辑"));
      body.append(node("p", `理由：${item.reason || "请核对页面证据后决定"}`));
      const evidence = item.evidence.map(id => {
        for (const [index, page] of doc.pages.entries()) { const f = page.fields.find(f => `${page.id}/${f.id}` === id); if (f) return `第 ${index + 1} 页 ${page.title} / ${f.label}；已填：${f.valueCaptured ? (f.value || "（空）") : "未采集"}`; }
        return id;
      });
      body.append(node("p", `来源：${evidence.join("；")}`));
      function changed() { selected.delete(item.id); checkbox.checked = false; options.onChange(); refresh(); }
      if (item.kind !== "set_value") {
        body.append(node("p", existing ? `当前定义：${existing.label} / ${types[existing.input]} / ${(existing.options || []).filter(Boolean).join("、")}` : "当前定义：不存在，将新增自定义字段"));
        const name = labeled("建议字段名称", document.createElement("input"), body); name.value = item.field.label;
        name.oninput = () => { item.field.label = name.value; changed(); };
        const type = labeled("建议字段类型", document.createElement("select"), body);
        for (const [value, label] of Object.entries(types)) { const option = node("option", label); option.value = value; type.append(option); }
        type.value = item.field.input;
        const placeholder = labeled("输入提示", document.createElement("input"), body); placeholder.value = item.field.placeholder;
        placeholder.oninput = () => { item.field.placeholder = placeholder.value; changed(); };
        const selectOptions = labeled("下拉选项（每行一个，仅下拉类型使用）", document.createElement("textarea"), body); selectOptions.value = (item.field.options || []).filter(Boolean).join("\n");
        selectOptions.oninput = () => { item.field.options = selectOptions.value.split("\n"); changed(); };
        type.onchange = () => { item.field.input = type.value; item.field.options = selectOptions.value.split("\n"); changed(); };
        body.append(node("p", "影响范围：此分区所有经历记录共用字段定义。"));
      }
      if (section?.type === "list" && item.kind !== "edit_field") {
        const target = labeled("目标经历（填写内容时必须明确选择）", document.createElement("select"), body);
        const empty = node("option", "请选择具体经历"); empty.value = ""; target.append(empty);
        for (const row of S.records(review.baseTemplate.profile, section)) { const option = node("option", row.label); option.value = String(row.index); target.append(option); }
        target.value = item.recordIndex === null ? "" : String(item.recordIndex);
        target.onchange = () => { item.recordIndex = target.value === "" ? null : Number(target.value); changed(); };
      }
      if (item.kind !== "edit_field") {
        const value = labeled(item.kind === "add_field" ? "初始内容（可留空，仅新增字段）" : "建议内容（可编辑）", document.createElement("textarea"), body);
        value.className = "suggestion-value"; value.value = item.value ?? "";
        value.oninput = () => { item.value = item.kind === "add_field" && !value.value ? null : value.value; changed(); };
      } else if (section) {
        for (const row of S.records(review.baseTemplate.profile, section)) {
          const replacement = labeled(`${row.label}：类型或选项调整后的内容`, document.createElement("textarea"), body);
          replacement.value = item.replacements[row.key] ?? String(row.value[item.fieldKey] ?? "");
          replacement.oninput = () => { item.replacements[row.key] = replacement.value; changed(); };
        }
      }
      const values = node("pre", "", "suggestion-diff"), errors = node("p", "", "suggestion-error"); errors.setAttribute("role", "status");
      body.append(values, errors); card.append(body); host.append(card); cards.push({ item, checkbox, values, errors, brief, card });
      checkbox.onchange = () => { if (checkbox.checked) selected.add(item.id); else selected.delete(item.id); refresh(); };
    }
    apply.onclick = () => { if (!apply.disabled) options.onApply([...selected]); };
    refresh(); return { refresh };
  }
  root.ResumeSuggestionsUI = { render };
})(globalThis);
