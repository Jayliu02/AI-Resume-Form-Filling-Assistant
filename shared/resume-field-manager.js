(function (root) {
  "use strict";
  const typeLabels = { text: "单行文本", textarea: "多行文本", date: "日期", select: "下拉选择", email: "邮箱", tel: "电话", url: "网址" };

  function open(profile, onApply, onClose = () => {}) {
    const schema = root.ResumeSchema;
    let draft = schema.clone(profile);
    let selectedKey = "";
    const returnFocus = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "field-manager";
    dialog.setAttribute("aria-labelledby", "field-manager-title");
    dialog.innerHTML = `
      <h2 id="field-manager-title">管理字段</h2>
      <p>仅修改当前简历。同一分区的所有经历共用字段定义，内容分别填写。</p>
      <label>分区<select data-section></select></label>
      <div class="field-manager-list" data-list></div>
      <button type="button" class="btn btn-outline" data-new>新增字段</button>
      <form data-form>
        <h3 data-heading>新增字段</h3>
        <label>字段名称<input data-label required maxlength="100"></label>
        <label>类型<select data-type></select></label>
        <label>输入提示<input data-placeholder maxlength="500"></label>
        <label data-options-label hidden>下拉选项（每行一个）<textarea data-options rows="4"></textarea></label>
        <p data-error role="alert"></p>
        <button type="submit" class="btn btn-outline">应用此字段</button>
      </form>
      <p>完成后，请在简历页面点击“保存”。取消会放弃本次字段管理的全部修改。</p>
      <div class="action-row"><button type="button" class="btn btn-primary" data-apply>完成</button><button type="button" class="btn btn-outline" data-cancel>取消</button></div>`;
    const el = (name) => dialog.querySelector(`[data-${name}]`);
    for (const section of schema.getSections(draft)) {
      const option = document.createElement("option");
      option.value = section.key; option.textContent = section.label;
      el("section").appendChild(option);
    }
    for (const type of schema.FIELD_TYPES) {
      const option = document.createElement("option");
      option.value = type; option.textContent = typeLabels[type];
      el("type").appendChild(option);
    }
    function reset(field) {
      selectedKey = field?.key || "";
      el("heading").textContent = field ? "编辑字段" : "新增字段";
      el("label").value = field?.label || "";
      el("type").value = field?.input || "text";
      el("placeholder").value = field?.placeholder || "";
      el("options").value = (field?.options || []).filter(Boolean).join("\n");
      el("options-label").hidden = el("type").value !== "select";
      el("error").textContent = "";
    }
    function render() {
      const section = schema.getSectionDefinition(el("section").value, draft);
      el("list").replaceChildren();
      for (const field of section.fields) {
        const row = document.createElement("div"); row.className = "field-manager-row";
        const label = document.createElement("span"); label.textContent = `${field.label} · ${typeLabels[field.input]}`;
        const edit = document.createElement("button"); edit.type = "button"; edit.className = "btn-text"; edit.textContent = "编辑";
        edit.setAttribute("aria-label", `编辑${field.label}`);
        edit.addEventListener("click", () => { reset(field); el("label").focus(); });
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "btn-text"; remove.textContent = "删除";
        remove.setAttribute("aria-label", `删除${field.label}`);
        remove.addEventListener("click", () => {
          const scope = section.type === "list" ? "本分区全部经历" : "本分区";
          if (!root.confirm(`删除“${field.label}”？将彻底清除${scope}的该字段及内容，保存后无法恢复。`)) return;
          draft = schema.updateSectionFields(draft, section.key, section.fields.filter((f) => f.key !== field.key));
          reset(); render();
        });
        row.append(label, edit, remove); el("list").appendChild(row);
      }
    }
    el("type").addEventListener("change", () => { el("options-label").hidden = el("type").value !== "select"; });
    el("section").addEventListener("change", () => { reset(); render(); });
    el("new").addEventListener("click", () => { reset(); el("label").focus(); });
    el("form").addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const section = schema.getSectionDefinition(el("section").value, draft);
        const field = {
          key: selectedKey || `custom_${root.crypto.randomUUID().replaceAll("-", "")}`,
          label: el("label").value.trim(), input: el("type").value,
          placeholder: el("placeholder").value,
          ...(el("type").value === "select" ? { options: ["", ...el("options").value.split("\n").map((v) => v.trim()).filter(Boolean)] } : {}),
        };
        const fields = selectedKey ? section.fields.map((f) => f.key === selectedKey ? field : f) : [...section.fields, field];
        // Validate before asking to discard incompatible values.
        schema.normalizeFieldConfig({ version: 1, sections: [{ key: section.key, fields }] });
        const next = schema.clone(draft);
        const records = section.type === "list" ? next[section.key] : [next[section.key]];
        const previous = section.fields.find((f) => f.key === selectedKey);
        if (previous && (previous.input !== field.input || JSON.stringify(previous.options) !== JSON.stringify(field.options))) {
          const conversions = records.map((record) => schema.convertFieldValue(field, record[field.key]));
          const count = conversions.filter((result) => !result.compatible).length;
          if (count && !root.confirm(`有 ${count} 项已有内容不兼容新的字段类型或选项。确认清空这些内容并应用修改？`)) return;
          records.forEach((record, index) => { record[field.key] = conversions[index].value; });
        }
        draft = schema.updateSectionFields(next, section.key, fields);
        reset(); render();
      } catch (error) { el("error").textContent = error.message; }
    });
    el("apply").addEventListener("click", () => {
      if (el("label").value && !root.confirm("编辑区还有尚未应用的字段，是否放弃该字段编辑并完成？")) return;
      onApply(draft); dialog.close();
    });
    el("cancel").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { dialog.remove(); onClose(); returnFocus?.focus(); });
    document.body.appendChild(dialog);
    reset(); render(); dialog.showModal();
  }
  root.ResumeFieldManager = { open };
})(window);
