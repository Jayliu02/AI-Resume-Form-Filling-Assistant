(function (root) {
  "use strict";
  const schema = () => root.ResumeSchema;
  const clone = value => structuredClone(value);
  const safeKey = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(value) && !["constructor", "prototype"].includes(value);
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
    return value;
  }
  const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const labelKey = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s:：*＊()（）]/g, "");
  function redundant(profile, item) {
    const section = schema().getSections(profile).find(s => s.key === item.sectionKey);
    if (item.kind === "add_field") return Boolean(item.field?.label && section?.fields.some(f => labelKey(f.label) === labelKey(item.field.label) || labelKey(f.key) === labelKey(item.field.label)));
    const p = preview(profile, item);
    if (p.errors.length) return false;
    if (item.kind === "set_value") return p.changes.every(c => c.before === c.after);
    const definition = field => ({ label: field.label.trim(), input: field.input, placeholder: field.placeholder || "", options: field.input === "select" ? [...new Set(field.options || [])].filter(Boolean).sort() : [] });
    return same(definition(p.current), definition(p.field)) && p.changes.every(c => c.before === c.after);
  }
  function compact(items, profile) {
    const unique = new Map();
    for (const item of items) {
      if (profile && redundant(profile, item)) continue;
      const { id, reason, evidence, ...operation } = item;
      if (typeof operation.value === "string") operation.value = operation.value.trim();
      if (operation.kind === "edit_field") { operation.value = null; operation.recordIndex = null; }
      if (operation.field) {
        operation.field = { ...operation.field, label: labelKey(operation.field.label) };
        if (operation.field.input === "select") operation.field.options = [...new Set(operation.field.options || [])].filter(Boolean).sort();
      }
      const key = JSON.stringify(canonical(operation)), previous = unique.get(key);
      if (previous) previous.evidence = [...new Set([...previous.evidence, ...evidence])];
      else unique.set(key, item);
    }
    return [...unique.values()];
  }
  function snapshot(template) {
    if (!template || typeof template.id !== "string" || !template.profile || typeof template.profile !== "object") throw new Error("建议缺少有效简历快照，请重新分析");
    return { id: template.id, name: template.name || "简历", profile: schema().normalizeResumeProfile(template.profile), rawText: template.rawText || "", schemaVersion: schema().version, createdAt: template.createdAt || "", updatedAt: template.updatedAt || "" };
  }
  function normalize(items, pages) {
    if (!Array.isArray(items) || items.length > 1000) throw new Error("修改建议格式无效");
    const evidence = new Set(pages.flatMap(p => p.fields.map(f => `${p.id}/${f.id}`)));
    const ids = new Set();
    return items.map(item => {
      if (!item || !["set_value", "add_field", "edit_field"].includes(item.kind) || !safeKey(item.sectionKey)) throw new Error("建议操作或分区无效");
      if (!schema().getSections().some(s => s.key === item.sectionKey)) throw new Error("建议不能新增或修改隐藏分区");
      if (item.kind !== "add_field" && !safeKey(item.fieldKey)) throw new Error("建议字段标识无效");
      if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.some(e => !evidence.has(e))) throw new Error("修改建议缺少有效网页证据");
      const id = typeof item.id === "string" && item.id ? item.id : crypto.randomUUID();
      if (ids.has(id)) throw new Error("修改建议标识重复"); ids.add(id);
      const index = item.recordIndex ?? null;
      if (index !== null && (!Number.isInteger(index) || index < 0)) throw new Error("建议经历位置无效");
      if (schema().getSectionDefinition(item.sectionKey).type !== "list" && index !== null) throw new Error("分组字段不能指定经历索引");
      if (item.value != null && typeof item.value !== "string") throw new Error("建议内容必须为文本");
      let field = null;
      if (item.kind !== "set_value") {
        if (!item.field || typeof item.field.label !== "string" || !schema().FIELD_TYPES.includes(item.field.input)) throw new Error("建议字段名称或类型无效");
        field = { label: item.field.label.trim(), input: item.field.input, placeholder: typeof item.field.placeholder === "string" ? item.field.placeholder : "" };
        if (field.input === "select") {
          if (!Array.isArray(item.field.options) || item.field.options.some(v => typeof v !== "string")) throw new Error("下拉字段选项格式无效");
          field.options = ["", ...new Set(item.field.options.map(v => v.trim()).filter(Boolean))];
        }
      }
      const replacements = {};
      for (const [key, value] of Object.entries(item.replacements || {})) {
        if (!/^(?:group|0|[1-9]\d*)$/.test(key) || typeof value !== "string") throw new Error("字段替代内容无效");
        replacements[key] = value;
      }
      return { id, kind: item.kind, sectionKey: item.sectionKey, fieldKey: item.kind === "add_field" ? "" : item.fieldKey,
        recordIndex: index, value: item.value ?? null, field, replacements, reason: typeof item.reason === "string" ? item.reason : "", evidence: [...new Set(item.evidence)] };
    });
  }
  function review(input, pages) {
    if (!input) return null;
    if (typeof input.id !== "string" || !input.id) throw new Error("审批批次无效");
    return { id: input.id, baseTemplate: snapshot(input.baseTemplate), items: normalize(input.items, pages) };
  }
  function audit(input) {
    if (input == null) return [];
    if (!Array.isArray(input)) throw new Error("审批记录格式无效");
    for (const entry of input) {
      if (!entry || typeof entry.reviewId !== "string" || typeof entry.templateName !== "string" || typeof entry.appliedAt !== "string" || !Array.isArray(entry.changes)) throw new Error("审批记录格式无效");
      for (const change of entry.changes) {
        if (!change || !["set_value", "add_field", "edit_field"].includes(change.suggestion?.kind) || typeof change.afterDefinition?.label !== "string" || !Array.isArray(change.changes)) throw new Error("审批变更记录无效");
        if (change.changes.some(c => !c || [c.before, c.after, c.recordLabel].some(v => typeof v !== "string"))) throw new Error("审批内容记录无效");
      }
    }
    return clone(input);
  }
  function records(profile, section) {
    const values = section.type === "list" ? (profile[section.key] || []).map((value, index) => ({ index, key: String(index), value })) : [{ index: null, key: "group", value: profile[section.key] || {} }];
    return values.map(r => ({ ...r, label: section.type === "list" ? `${section.itemLabel || section.label} ${r.index + 1} · ${Object.values(r.value).filter(v => typeof v === "string" && v.trim()).slice(0, 2).join(" / ") || "空记录"}` : section.label }));
  }
  function prepare(profile, item, newKey = "custom_approval_preview") {
    const S = schema(), section = S.getSections(profile).find(s => s.key === item.sectionKey);
    if (!section) throw new Error("简历分区不存在");
    while (section.fields.some(f => f.key === newKey)) newKey += "_next";
    const rows = records(profile, section);
    const current = section.fields.find(f => f.key === item.fieldKey);
    if (item.kind !== "add_field" && !current) throw new Error("目标字段已不存在，请重新分析");
    const field = item.kind === "set_value" ? current : { ...current, ...item.field, key: item.kind === "add_field" ? newKey : current.key };
    const fields = item.kind === "add_field" ? [...section.fields, field] : section.fields.map(f => f.key === field.key ? field : f);
    if (item.kind !== "set_value") S.normalizeFieldConfig({ version: 1, sections: [{ key: section.key, fields }] });
    const changes = [], errors = [];
    const hasValue = item.kind === "set_value" || (item.kind === "add_field" && item.value !== null);
    const target = section.type === "list" ? rows.find(r => r.index === item.recordIndex) : rows[0];
    if (hasValue && !target) errors.push("请选择要修改的具体经历记录");
    if (item.kind === "set_value" && item.value === null) errors.push("请填写建议内容");
    for (const row of rows) {
      const before = String(row.value[field.key] ?? "");
      const replacement = Object.prototype.hasOwnProperty.call(item.replacements, row.key);
      let desired = before;
      if (item.kind === "edit_field" && replacement) {
        desired = item.replacements[row.key];
        if (before.trim() && !desired.trim()) errors.push(`${row.label}：替代值不能清空已有内容`);
      }
      if (hasValue && row === target) desired = item.value ?? "";
      const converted = S.convertFieldValue(field, desired.trim());
      if (!converted.compatible) errors.push(`${row.label}：内容与建议类型或选项不兼容，请填写有效替代值`);
      changes.push({ recordKey: row.key, recordIndex: row.index, recordLabel: row.label, before, after: converted.compatible ? converted.value : desired, compatible: converted.compatible });
    }
    if (item.kind !== "edit_field" && Object.keys(item.replacements).length) errors.push("此操作不接受批量替代值");
    if (Object.keys(item.replacements).some(key => !rows.some(r => r.key === key))) errors.push("替代值指向不存在的经历");
    return { section, current, field, fields, changes, errors };
  }
  function preview(profile, item) {
    try { return prepare(profile, item); } catch (error) { return { errors: [error.message], changes: [] }; }
  }
  function buildChanges(profile, items) {
    if (!items.length) throw new Error("请至少勾选一项修改建议");
    for (let i = 0; i < items.length; i++) for (let j = 0; j < i; j++) {
      const a = items[i], b = items[j];
      if (a.sectionKey !== b.sectionKey) continue;
      const sameField = a.kind === "add_field" || b.kind === "add_field" ? a.kind === b.kind && a.field.label === b.field.label : a.fieldKey === b.fieldKey;
      if (sameField && (a.kind !== "set_value" || b.kind !== "set_value" || a.recordIndex === b.recordIndex)) throw new Error("多条建议修改同一字段，请只勾选一个版本（定义修改不能与该字段的内容修改同时应用）");
    }
    let next = clone(profile); const applied = [];
    for (const item of items) {
      const key = `custom_${crypto.randomUUID().replaceAll("-", "")}`;
      const p = prepare(next, item, key);
      if (p.errors.length) throw new Error(p.errors.join("；"));
      for (const change of p.changes) {
        if (item.kind === "set_value" && p.section.type === "list" && change.recordIndex !== item.recordIndex) continue;
        const row = p.section.type === "list" ? next[item.sectionKey][change.recordIndex] : next[item.sectionKey];
        row[p.field.key] = change.after;
      }
      if (item.kind !== "set_value") {
        const config = clone(next.fieldConfig || { version: 1, sections: [] });
        config.sections = config.sections.filter(s => s.key !== item.sectionKey);
        config.sections.push({ key: item.sectionKey, fields: p.fields });
        next.fieldConfig = schema().normalizeFieldConfig(config);
      }
      applied.push({ suggestion: clone(item), fieldKey: p.field.key, beforeDefinition: p.current ? clone(p.current) : null, afterDefinition: clone(p.field), changes: p.changes.filter(c => item.kind !== "set_value" || p.section.type !== "list" || c.recordIndex === item.recordIndex) });
    }
    const normalized = schema().normalizeResumeProfile(next);
    // Normalization must never silently discard or rewrite an approved field value.
    for (const item of applied) for (const change of item.changes) {
      const row = change.recordIndex === null ? normalized[item.suggestion.sectionKey] : normalized[item.suggestion.sectionKey]?.[change.recordIndex];
      if (!row || String(row[item.fieldKey] ?? "") !== change.after) throw new Error("应用会改变经历结构或字段内容，请在简历编辑页调整后重新分析");
    }
    return { profile: normalized, applied };
  }
  async function apply(request, local, docs, documentKey) {
    const doc = root.ResumeDocuments.document(request.document);
    if (!doc.review) throw new Error("历史文档没有可审批建议，请重新分析");
    const old = docs.find(d => d.id === doc.id);
    if (old?.approvals?.some(a => a.reviewId === doc.review.id)) return { document: old, alreadyApplied: true };
    if ((old && old.updatedAt !== request.baseUpdatedAt) || (!old && request.baseUpdatedAt)) throw new Error("文档已改变或删除，请重新打开并审批");
    const ids = request.selectedIds;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !doc.review.items.some(s => s.id === id))) throw new Error("审批选择无效");
    const data = await local.get("resumeTemplates"), templates = data.resumeTemplates || {};
    const target = templates[doc.review.baseTemplate.id];
    if (!target || !same(snapshot(target), doc.review.baseTemplate)) throw new Error("目标简历已改变或删除，本次未应用任何修改。请重新分析并审批");
    const result = buildChanges(doc.review.baseTemplate.profile, doc.review.items.filter(item => ids.includes(item.id)));
    const now = new Date(Math.max(Date.now(), Date.parse(target.updatedAt || "") + 1 || 0)).toISOString();
    const saved = { ...target, profile: result.profile, schemaVersion: schema().version, updatedAt: now };
    doc.updatedAt = new Date(Math.max(Date.now(), Date.parse(old?.updatedAt || "") + 1 || 0)).toISOString();
    doc.approvals = [...(old?.approvals || []), { reviewId: doc.review.id, templateId: saved.id, templateName: saved.name, appliedAt: now, changes: result.applied }];
    const nextDocs = docs.filter(d => d.id !== doc.id); nextDocs.push(doc);
    await local.set({ resumeTemplates: { ...templates, [saved.id]: saved }, [documentKey]: nextDocs });
    return { document: doc, template: saved, alreadyApplied: false };
  }
  root.ResumeSuggestions = Object.freeze({ snapshot, same, normalize, review, audit, records, preview, buildChanges, apply, compact, redundant });
})(globalThis);
