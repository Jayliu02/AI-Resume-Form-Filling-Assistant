const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
function load() {
  const c = vm.createContext({ structuredClone, URL, crypto: webcrypto, TextEncoder, Blob, Response, CompressionStream, DecompressionStream, btoa, atob });
  for (const file of ["resume-schema", "resume-prompts", "resume-storage"]) vm.runInContext(read(`shared/${file}.js`), c);
  return c;
}
const field = { key: "custom_advisor", label: "导师邮箱", input: "email", placeholder: "" };
function customized(schema) {
  return schema.updateSectionFields({ educations: [{ school: "A" }, { school: "B" }] }, "educations", [...schema.getSectionDefinition("educations").fields, field]);
}

test("custom fields survive normalization, share definitions across records and isolate templates", () => {
  const s = load().ResumeSchema;
  const profile = customized(s);
  profile.educations[0].custom_advisor = "a@example.com";
  profile.educations[1].custom_advisor = "b@example.com";
  const normalized = s.normalizeResumeProfile(profile);
  assert.equal(normalized.educations[0].custom_advisor, "a@example.com");
  assert.equal(normalized.educations[1].custom_advisor, "b@example.com");
  assert.equal(s.createEmptyListItem("educations", normalized).custom_advisor, "");
  assert.equal(s.createEmptyListItem("educations").custom_advisor, undefined);
  const renamed = s.updateSectionFields(normalized, "educations", s.getSectionDefinition("educations", normalized).fields.map(f => f.key === field.key ? { ...f, label: "指导教师邮箱" } : f));
  assert.equal(renamed.educations[0].custom_advisor, "a@example.com");
  assert.ok(s.getCatalogWithValues(renamed).some(f => f.path === "educations.1.custom_advisor" && f.label.includes("指导教师邮箱") && f.hasValue));
  assert.equal(s.getSectionDefinition("educations", normalized).fields.at(-1).label, "导师邮箱");
});

test("deletion clears every record and cannot resurrect through aliases, import or new records", () => {
  const s = load().ResumeSchema;
  let p = customized(s);
  p.educations[0].custom_advisor = "a@example.com";
  p = s.updateSectionFields(p, "educations", s.getSectionDefinition("educations", p).fields.filter(f => !["custom_advisor", "school"].includes(f.key)));
  assert.ok(p.educations.every(r => !("school" in r) && !("custom_advisor" in r)));
  p.educations[0].school = "AI injected";
  p.educations[0].custom_advisor = "AI injected";
  p = s.normalizeResumeProfile(p);
  assert.equal(p.educations[0].school, undefined);
  assert.equal(p.educations[0].custom_advisor, undefined);
  assert.equal(s.createEmptyListItem("educations", p).school, undefined);
  assert.ok(!s.getCatalogWithValues(p).some(f => f.path.endsWith(".school")));
  let personal = s.updateSectionFields({ personal: { summary: "old" }, additional: { coverLetterHighlights: "legacy" } }, "personal", []);
  assert.deepEqual(Object.keys(s.normalizeResumeProfile(personal).personal), []);
});

test("field configuration rejects unsafe keys, duplicate names and invalid enums", () => {
  const s = load().ResumeSchema;
  for (const fields of [[{ ...field, key: "__proto__" }], [{ ...field, key: "custom_a.b" }], [field, { ...field, key: "custom_other" }], [{ ...field, input: "select", options: [] }], [{ ...field, input: "html" }]]) {
    assert.throws(() => s.updateSectionFields({}, "educations", fields));
  }
  assert.throws(() => s.setValueByPath({}, "__proto__.polluted", "yes"));
  assert.equal({}.polluted, undefined);
});

test("type conversion preserves compatible values and identifies destructive changes", () => {
  const s = load().ResumeSchema;
  assert.equal(s.convertFieldValue({ input: "textarea" }, "first\nsecond").value, "first\nsecond");
  assert.equal(s.convertFieldValue({ input: "text" }, "first\nsecond").compatible, false);
  assert.equal(s.convertFieldValue({ input: "date" }, "2024/02/29").value, "2024-02-29");
  assert.equal(s.convertFieldValue({ input: "date" }, "2025-02-29").compatible, false);
  assert.equal(s.convertFieldValue({ input: "date" }, "至今").value, "至今");
  assert.equal(s.convertFieldValue({ input: "email" }, "wrong").compatible, false);
  assert.equal(s.convertFieldValue({ input: "url" }, "https://example.com").compatible, true);
  assert.equal(s.convertFieldValue({ input: "select", options: ["", "A"] }, "B").compatible, false);
});

test("AI import and mapping use current labels and accept custom paths only when configured", () => {
  const c = load(), s = c.ResumeSchema;
  let p = customized(s);
  p.educations[0].custom_advisor = "a@example.com";
  p = s.updateSectionFields(p, "personal", []);
  const prompt = c.ResumePrompts.buildResumeImportPrompt(s, "resume text", p);
  assert.ok(prompt.includes("导师邮箱"));
  assert.ok(prompt.includes("custom_advisor"));
  assert.ok(!prompt.includes('"fullName"'));
  const content = read("content.js");
  vm.runInContext(`const schema = ResumeSchema; ${content.slice(content.indexOf("  function normalizeMappings("), content.indexOf("  function normalizeTransform("))} function normalizeTransform() { return { type: 'none' }; }`, c);
  const mapping = [{ fieldId: "1", resumePath: "educations.0.custom_advisor" }, { fieldId: "2", resumePath: "personal.fullName" }];
  const output = c.normalizeMappings(mapping, [{ fieldId: "1" }, { fieldId: "2" }], p);
  assert.equal(output[0].resumePath, "educations.0.custom_advisor");
  assert.equal(output[1].resumePath, "");
  assert.equal(c.normalizeMappings(mapping, [{ fieldId: "1" }], {}).at(0).resumePath, "");
  assert.equal(s.getFillProfile(p).educations[0].custom_advisor, "a@example.com");
});

test("mapping cache changes with definitions, but not with resume values", () => {
  const c = load(), s = c.ResumeSchema;
  const content = read("content.js");
  vm.runInContext(`const location = { origin: 'https://test.com', pathname: '/', host: 'test.com' }; function hashString(v) { return v; } ${content.slice(content.indexOf("  function createMappingCacheKeyFromSignature("), content.indexOf("  function createStableCacheFieldSignature("))} `, c);
  const p = customized(s);
  const key = profile => c.createMappingCacheKeyFromSignature([], s.getFieldCatalog({ mode: "max", profile }));
  const original = key(p);
  p.educations[0].custom_advisor = "changed@example.com";
  assert.equal(key(p), original);
  assert.notEqual(key({}), original);
  p.fieldConfig.sections[0].fields.at(-1).label = "Renamed";
  assert.notEqual(key(p), original);
});

test("storage save, duplicate and backup round trip preserve config; invalid import is atomic", async () => {
  const c = load(), s = c.ResumeSchema, storage = c.ResumeStorage;
  const data = {};
  const area = { async get(keys) { return Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])])); }, async set(values) { Object.assign(data, structuredClone(values)); }, async remove(keys) { for (const k of keys) delete data[k]; } };
  const fake = { local: area, sync: { async get() { return {}; }, async remove() {} } };
  const state = await storage.loadTemplateState(fake);
  const p = customized(s); p.educations[0].custom_advisor = "a@example.com";
  await storage.saveTemplateContent(state.activeTemplateId, { profile: p }, fake);
  const copy = await storage.duplicateTemplate(state.activeTemplateId, fake);
  assert.equal(copy.profile.educations[0].custom_advisor, "a@example.com");
  const backup = await storage.exportTemplateData(fake);
  await storage.importTemplateData(JSON.parse(JSON.stringify(backup)), fake);
  const restored = await storage.loadTemplateState(fake);
  assert.equal(restored.templates.length, 2);
  assert.ok(restored.templates.every(t => t.profile.fieldConfig.sections[0].fields.at(-1).key === field.key));
  const before = JSON.stringify(data);
  backup.templates[0].profile.fieldConfig.version = 99;
  await assert.rejects(storage.importTemplateData(backup, fake));
  assert.equal(JSON.stringify(data), before);
});
