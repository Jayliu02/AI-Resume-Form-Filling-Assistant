const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../resume-editor.js"), "utf8");
const start = source.indexOf("function getResumeProgress(");
const end = source.indexOf("function updateResumeNavProgress(", start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);

test("resume progress calculates percentages and the three color levels", () => {
  assert.deepEqual({ ...context.getResumeProgress(0, 10) }, { filled: 0, total: 10, percentage: 0, level: "low" });
  assert.equal(context.getResumeProgress(1, 3).level, "low");
  assert.equal(context.getResumeProgress(2, 3).level, "high");
  assert.equal(context.getResumeProgress(33, 100).level, "low");
  assert.equal(context.getResumeProgress(34, 100).level, "medium");
  assert.equal(context.getResumeProgress(66, 100).level, "medium");
  assert.equal(context.getResumeProgress(67, 100).level, "high");
  assert.equal(context.getResumeProgress(100, 100).percentage, 100);
});

test("resume progress handles an empty category without division by zero", () => {
  assert.deepEqual({ ...context.getResumeProgress(0, 0) }, { filled: 0, total: 0, percentage: 0, level: "low" });
});

test("field progress only updates when empty state changes", () => {
  const start = source.indexOf("function updateResumeNavProgressForControl(");
  const end = source.indexOf("function renderResumeEditor(", start);
  const calls = [];
  const progressContext = vm.createContext({
    resumeProgressBySection: new Map([["personal", { filled: 0, total: 2 }]]),
    editorSectionKey: (key) => key,
    hasMeaningfulResumeValue: (value) => String(value || "").trim().length > 0,
    updateResumeNavProgress: (...args) => calls.push(args),
  });
  vm.runInContext(source.slice(start, end), progressContext);

  const control = {
    value: "Alice",
    dataset: { resumePath: "personal.fullName", resumeFilled: "false" },
  };
  progressContext.updateResumeNavProgressForControl(control);
  assert.equal(progressContext.resumeProgressBySection.get("personal").filled, 1);
  assert.equal(calls.length, 1);

  control.value = "Alice Chen";
  progressContext.updateResumeNavProgressForControl(control);
  assert.equal(calls.length, 1);

  control.value = "";
  progressContext.updateResumeNavProgressForControl(control);
  assert.equal(progressContext.resumeProgressBySection.get("personal").filled, 0);
  assert.equal(calls.length, 2);
});
