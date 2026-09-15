const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element(tag) {
  return {
    tagName: tag.toUpperCase(), value: "", dataset: {}, children: [], attributes: {}, listeners: {},
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(event, fn) { this.listeners[event] = fn; },
    focus() {},
  };
}

function loadControls() {
  const context = vm.createContext({ document: { createElement: element }, changes: 0 });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/resume-date-control.js"), "utf8"), context);
  const source = fs.readFileSync(path.join(__dirname, "../resume-editor.js"), "utf8");
  const start = source.indexOf("function createFieldControl(");
  const end = source.indexOf("function markResumeDirty(", start);
  vm.runInContext(`function markResumeDirty() { changes += 1; } ${source.slice(start, end)}`, context);
  return context;
}

for (const value of ["", "2025", "2025-06", "2024-02-29", "1889-12-01", "2099"]) {
  test(`date picker preserves precision: ${value || "empty"}`, () => {
    const context = loadControls();
    const host = context.createFieldControl({ input: "date", label: "日期" }, value, "educations.0.startDate");
    assert.equal(host.value, value);
    assert.equal(host.dataset.resumePath, "educations.0.startDate");
    assert.equal(host.children[0].tagName, "SELECT");
    assert.equal(context.changes, 0);
    const parts = value.split("-");
    assert.equal(host.children[0].value, parts[0]);
    assert.equal(host.children[1].value, parts[1] || "");
    assert.equal(host.children[2].value, parts[2] || "");
  });
}

test("date picker updates precision, leap days, dependencies and clearing", () => {
  const context = loadControls();
  const host = context.createFieldControl({ input: "date", label: "日期" }, "2024-02-29", "personal.birthDate");
  const [year, month, day, clear] = host.children;
  year.value = "2023";
  year.listeners.change();
  assert.equal(host.value, "2023-02");
  assert.equal(day.value, "");
  month.value = "01"; day.value = "31"; day.listeners.change();
  assert.equal(host.value, "2023-01-31");
  month.value = "04"; month.listeners.change();
  assert.equal(host.value, "2023-04");
  month.value = ""; month.listeners.change();
  assert.equal(host.value, "2023");
  assert.equal(day.disabled, true);
  clear.listeners.click();
  assert.equal(host.value, "");
  assert.equal(month.disabled, true);
  assert.equal(context.changes, 5);
});

test("unparseable legacy dates survive until explicitly replaced or cleared", () => {
  const context = loadControls();
  for (const value of ["至今", "2023-02-29", "2025-13", "待定"]) {
    const host = context.createFieldControl({ input: "date" }, value, "projects.0.endDate");
    assert.equal(host.value, value);
    assert.equal(host.children[4].hidden, false);
    host.children[0].value = "2025";
    host.children[0].listeners.change();
    assert.equal(host.value, "2025");
    assert.equal(host.children[4].hidden, true);
  }
});

test("form collection keeps archived fields while applying visible edits", () => {
  const source = fs.readFileSync(path.join(__dirname, "../resume-editor.js"), "utf8");
  const context = vm.createContext({ window: {}, structuredClone });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/resume-schema.js"), "utf8"), context);
  context.schema = context.window.ResumeSchema;
  context.resumeProfile = context.schema.normalizeResumeProfile({ identityAndAuthorization: { personalIdNumber: "legacy" } });
  context.resumeFormHost = { querySelectorAll: () => [{ dataset: { resumePath: "personal.fullName" }, value: "新姓名" }] };
  vm.runInContext(source.slice(source.indexOf("function collectResumeProfileFromForm()"), source.indexOf("function syncResumeProfileFromForm()")), context);
  const result = context.collectResumeProfileFromForm();
  assert.equal(result.personal.fullName, "新姓名");
  assert.equal(result.identityAndAuthorization.personalIdNumber, "legacy");
});


test("adding the final achievement slot keeps it editable up to the limit", () => {
  const source = fs.readFileSync(path.join(__dirname, "../resume-editor.js"), "utf8");
  const context = vm.createContext({ window: {}, structuredClone, collapsedResumeSections: new Set() });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../shared/resume-schema.js"), "utf8"), context);
  context.schema = context.window.ResumeSchema;
  context.resumeProfile = context.schema.normalizeResumeProfile({personalAchievements: Array.from({length: 9}, (_, i) => ({name: `成果 ${i}`}))});
  context.syncResumeProfileFromForm = () => context.resumeProfile;
  context.editorSectionKey = key => key;
  context.renderResumeEditor = () => {};
  context.markResumeDirty = () => {};
  context.openResumeSection = () => {};
  context.focusResumeField = () => {};
  vm.runInContext(source.slice(source.indexOf("function addResumeListItem("), source.indexOf("function removeResumeListItem(")), context);
  context.addResumeListItem("personalAchievements");
  assert.equal(context.resumeProfile.personalAchievements.length, 10);
  assert.equal(context.resumeProfile.personalAchievements[9].name, "");
  context.addResumeListItem("personalAchievements");
  assert.equal(context.resumeProfile.personalAchievements.length, 10);
});
