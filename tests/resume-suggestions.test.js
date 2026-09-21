const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
function setup() {
  const c = vm.createContext({ structuredClone, URL, crypto: webcrypto });
  for (const file of ["resume-schema", "resume-suggestions", "resume-documents"]) vm.runInContext(fs.readFileSync(path.join(__dirname, `../shared/${file}.js`), "utf8"), c);
  const profile = c.ResumeSchema.normalizeResumeProfile({ personal: { fullName: "Original" }, educations: [{ school: "School A" }, { school: "School B" }] });
  const template = { id: "resume", name: "My resume", profile, rawText: "original source", schemaVersion: c.ResumeSchema.version, updatedAt: "2026-01-01" };
  const data = { resumeTemplates: { resume: structuredClone(template) } };
  let writes = 0, fail = false;
  const local = { async get(keys) { return structuredClone(Object.fromEntries([].concat(keys).filter(k => k in data).map(k => [k, data[k]]))); }, async set(values) { if (fail) throw new Error("QUOTA"); writes++; Object.assign(data, structuredClone(values)); } };
  const pages = [{ id: "p1", title: "Page", url: "https://example.com", fields: [{ id: "f1", label: "Name", valueCaptured: true, value: "Suggested" }] }];
  const item = overrides => c.ResumeSuggestions.normalize([{ kind: "set_value", sectionKey: "personal", fieldKey: "fullName", value: "Suggested", reason: "Page value", evidence: ["p1/f1"], ...overrides }], pages)[0];
  const document = items => ({ version: 1, id: "doc", title: "Requirements", pages, review: { id: "review1", baseTemplate: c.ResumeSuggestions.snapshot(template), items } });
  return { S: c.ResumeSuggestions, D: c.ResumeDocuments, schema: c.ResumeSchema, profile, template, data, local, pages, item, document, writes: () => writes, fail: () => { fail = true; } };
}
test("saving and reloading editable suggestions never changes resume or implies approval", async () => {
  const t = setup(), original = JSON.stringify(t.data.resumeTemplates), doc = t.document([t.item()]);
  await t.D.dispatch({ method: "save", document: doc }, t.local);
  const exported = await t.D.dispatch({ method: "export" }, t.local);
  assert.equal(exported.documents[0].review.items[0].value, "Suggested");
  assert.equal(exported.documents[0].approvals.length, 0);
  assert.equal(JSON.stringify(t.data.resumeTemplates), original);
});
test("only explicitly selected edited suggestions apply, atomically with audit; duplicate request is idempotent", async () => {
  const t = setup(), chosen = t.item({ value: "User edited" }), ignored = t.item({ fieldKey: "phoneNumber", value: "123" });
  const request = { method: "applySuggestions", document: t.document([chosen, ignored]), selectedIds: [chosen.id] };
  const result = await t.D.dispatch(request, t.local);
  assert.equal(t.data.resumeTemplates.resume.profile.personal.fullName, "User edited");
  assert.equal(t.data.resumeTemplates.resume.profile.personal.phoneNumber, "");
  assert.equal(t.data.resumeTemplates.resume.rawText, "original source");
  assert.equal(result.document.approvals[0].changes[0].changes[0].before, "Original");
  assert.equal(result.document.approvals[0].changes[0].changes[0].after, "User edited");
  assert.equal(t.writes(), 1);
  assert.equal((await t.D.dispatch(request, t.local)).alreadyApplied, true);
  assert.equal(t.writes(), 1);
});
test("stale, renamed or deleted target prevents all changes rather than creating a conflict copy", async () => {
  for (const action of [data => { data.resumeTemplates.resume.profile.personal.fullName = "New edit"; }, data => { data.resumeTemplates.resume.name = "Renamed"; }, data => { delete data.resumeTemplates.resume; }]) {
    const t = setup(), item = t.item(), doc = t.document([item]); action(t.data);
    const before = JSON.stringify(t.data);
    await assert.rejects(t.D.dispatch({ method: "applySuggestions", document: doc, selectedIds: [item.id] }, t.local), /已改变或删除/);
    assert.equal(JSON.stringify(t.data), before); assert.equal(t.writes(), 0);
  }
});
test("stale document and reanalysis invalidate previous approval batch", async () => {
  const t = setup(), item = t.item(), doc = t.document([item]);
  const saved = await t.D.dispatch({ method: "save", document: doc }, t.local);
  await t.D.dispatch({ method: "save", document: { ...saved, review: { ...saved.review, id: "new-analysis" } }, baseUpdatedAt: saved.updatedAt }, t.local);
  const before = JSON.stringify(t.data);
  await assert.rejects(t.D.dispatch({ method: "applySuggestions", document: saved, selectedIds: [item.id], baseUpdatedAt: saved.updatedAt }, t.local), /文档已改变/);
  assert.equal(JSON.stringify(t.data), before);
});
test("new field and initial value apply together with a locally generated key", async () => {
  const t = setup(), added = t.item({ kind: "add_field", fieldKey: "model_supplied_key", field: { label: "导师备注", input: "text" }, sectionKey: "educations", recordIndex: 1, value: "Known advisor" });
  assert.equal(added.fieldKey, "");
  const result = t.S.buildChanges(t.profile, [added]);
  const key = result.applied[0].fieldKey;
  assert.match(key, /^custom_[a-f0-9]+$/);
  assert.equal(result.profile.educations[1][key], "Known advisor");
  assert.equal(result.profile.educations[0][key], "");
  assert.equal(result.profile.educations[0].school, "School A");
});
test("ambiguous repeated record cannot be approved before selecting a real record", () => {
  const t = setup(), item = t.item({ sectionKey: "educations", fieldKey: "school", recordIndex: null, value: "Changed" });
  assert.match(t.S.preview(t.profile, item).errors.join(), /请选择/);
  assert.throws(() => t.S.buildChanges(t.profile, [item]), /请选择/);
  item.recordIndex = 1;
  const result = t.S.buildChanges(t.profile, [item]);
  assert.equal(result.profile.educations[0].school, "School A");
  assert.equal(result.profile.educations[1].school, "Changed");
  item.recordIndex = 99; assert.throws(() => t.S.buildChanges(t.profile, [item]), /请选择/);
});
test("field type changes expose every affected row and reject silent clearing until replacements are valid", () => {
  const t = setup(), item = t.item({ kind: "edit_field", sectionKey: "educations", fieldKey: "school", value: null, field: { label: "院校", input: "select", options: ["School A", "Replacement B"] } });
  const preview = t.S.preview(t.profile, item);
  assert.equal(preview.changes.length, 2); assert.equal(preview.errors.length, 1);
  assert.throws(() => t.S.buildChanges(t.profile, [item]), /不兼容/);
  item.replacements = { "1": "" }; assert.throws(() => t.S.buildChanges(t.profile, [item]), /不能清空/);
  item.replacements = { "1": "Replacement B" };
  const result = t.S.buildChanges(t.profile, [item]);
  assert.equal(result.profile.educations[0].school, "School A");
  assert.equal(result.profile.educations[1].school, "Replacement B");
  assert.equal(t.schema.getSectionDefinition("educations", result.profile).fields.find(f => f.key === "school").label, "院校");
});
test("conflicting suggestions and malformed operations cannot be applied", () => {
  const t = setup(), item = t.item();
  assert.throws(() => t.S.buildChanges(t.profile, [item, t.item({ value: "Alternative" })]), /同一字段/);
  for (const patch of [{ kind: "delete_field" }, { sectionKey: "newSection" }, { fieldKey: "__proto__" }, { evidence: ["fake"] }, { recordIndex: 0 }]) assert.throws(() => t.item(patch));
  const struct = t.item({ kind: "edit_field", field: { label: "Name", input: "text" } });
  assert.throws(() => t.S.buildChanges(t.profile, [item, struct]), /同一字段/);
});
test("preview uses normalized text and avoids collisions with existing custom preview keys", () => {
  const t = setup(), item = t.item({ value: "  Approved name  " });
  assert.equal(t.S.preview(t.profile, item).changes[0].after, "Approved name");
  assert.equal(t.S.buildChanges(t.profile, [item]).profile.personal.fullName, "Approved name");
  const p = t.schema.updateSectionFields(t.profile, "personal", [...t.schema.getSectionDefinition("personal", t.profile).fields, { key: "custom_approval_preview", label: "Existing custom", input: "text" }]);
  const added = t.item({ kind: "add_field", field: { label: "New custom", input: "text" }, value: null });
  assert.equal(t.S.preview(p, added).errors.length, 0);
});
test("compact suggestions remove existing fields and no-op edits while retaining distinct records and alternatives", () => {
  const t = setup();
  const sameValue = t.item({ value: " Original " });
  const existingField = t.item({ kind: "add_field", field: { label: " 姓名： ", input: "text" }, value: null });
  const definition = t.schema.getSectionDefinition("personal", t.profile).fields.find(f => f.key === "fullName");
  const sameDefinition = t.item({ kind: "edit_field", field: definition, value: null });
  const a = t.item({ sectionKey: "educations", fieldKey: "school", recordIndex: 0, value: "New school" });
  const duplicate = t.item({ ...a, id: "duplicate", reason: "Other wording", value: " New school " });
  const secondRecord = t.item({ ...a, id: "record2", recordIndex: 1 });
  const alternative = t.item({ ...a, id: "alternative", value: "Another school" });
  const result = t.S.compact([sameValue, existingField, sameDefinition, a, duplicate, secondRecord, alternative], t.profile);
  assert.equal(result.length, 3);
  assert.deepEqual(Array.from(result, s => s.id), [a.id, secondRecord.id, alternative.id]);
});
test("invalid selected item or quota error leaves both resume and approval log unchanged", async () => {
  const t = setup(), a = t.item(), invalid = t.item({ fieldKey: "email", value: "not an email" });
  const request = { method: "applySuggestions", document: t.document([a, invalid]), selectedIds: [a.id, invalid.id] };
  const before = JSON.stringify(t.data);
  await assert.rejects(t.D.dispatch(request, t.local), /不兼容/);
  assert.equal(JSON.stringify(t.data), before);
  request.selectedIds = [a.id]; t.fail();
  await assert.rejects(t.D.dispatch(request, t.local), /QUOTA/);
  assert.equal(JSON.stringify(t.data), before);
});
test("invalid unselected draft does not block selected valid changes; audit survives export/import", async () => {
  const t = setup(), valid = t.item(), invalid = t.item({ kind: "add_field", value: null, field: { label: "", input: "select", options: [] } });
  const doc = t.document([valid, invalid]);
  assert.ok(t.S.preview(t.profile, invalid).errors.length);
  const result = await t.D.dispatch({ method: "applySuggestions", document: doc, selectedIds: [valid.id] }, t.local);
  const exported = await t.D.dispatch({ method: "export" }, t.local);
  await t.D.dispatch({ method: "import", data: JSON.parse(JSON.stringify(exported)) }, t.local);
  const docs = await t.D.dispatch({ method: "list" }, t.local);
  assert.equal(docs[1].approvals.length, 1);
  assert.ok(t.D.markdown(result.document).includes("已应用审批记录"));
  assert.equal(t.data.resumeTemplates.resume.profile.personal.fullName, "Suggested");
});
test("analyze preserves executable suggestions, deduplicates identical changes and keeps alternatives", async () => {
  const t = setup(), doc = t.document([]);
  doc.pages.push({ ...structuredClone(doc.pages[0]), id: "p2" });
  const result = await t.D.analyze(doc, [], async prompt => {
    const p = JSON.parse(prompt).pages[0];
    const evidence = [p.id + "/f1"];
    return JSON.stringify({ summary: "Analysis", requirements: [{ requirement: "Name", evidence, status: "review" }], suggestions: [{ kind: "set_value", sectionKey: "personal", fieldKey: "fullName", value: "Suggested", reason: "Evidence", evidence }] });
  });
  assert.equal(result.suggestions.length, 1); assert.equal(result.suggestions[0].evidence.length, 2);
  assert.equal(t.data.resumeTemplates.resume.profile.personal.fullName, "Original");
});
