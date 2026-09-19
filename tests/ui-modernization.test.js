const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

test("editor progress updates incrementally without per-control listeners", () => {
  const source = read("resume-editor.js");
  const controlStart = source.indexOf("function createFieldControl(");
  const controlEnd = source.indexOf("function markResumeDirty(", controlStart);
  const controlSnippet = source.slice(controlStart, controlEnd);

  assert.match(source, /function updateResumeNavProgressForControl\(control\)/);
  assert.match(source, /resumeProgressBySection = new Map\(\)/);
  assert.match(source, /resumeFormHost\.addEventListener\("input", handleFieldChange\)/);
  assert.match(source, /markResumeDirty\(path = "", control = null\)/);
  assert.doesNotMatch(controlSnippet, /control\.addEventListener\("input"/);
  assert.match(source, /resume-nav-count[^\n]+<\/span><\/span>/);
});

test("active model lookup reuses one model-state snapshot", () => {
  const source = read("popup.js");
  const start = source.indexOf("async function getActiveModel()");
  const end = source.indexOf("function getModelsFromState", start);
  const snippet = source.slice(start, end);
  assert.match(snippet, /modelStorage\.loadModelState\(\)/);
  assert.match(snippet, /getModelsFromState\(state\)/);
  assert.doesNotMatch(snippet, /getAllModels\(/);
});

test("dialogs expose accessible semantics and editor motion is minimal", () => {
  const popupHtml = read("popup.html");
  const editorHtml = read("resume-editor.html");
  const popupCss = read("popup.css");
  const editorCss = read("resume-editor.css");

  assert.match(popupHtml, /id="settingsModal"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(popupHtml, /id="editModelModal"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(editorHtml, /id="templateNameModal"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(editorHtml, /id="pageStatus"[^>]+hidden/);
  assert.ok(editorHtml.indexOf('id="pageStatus"') > editorHtml.indexOf('</main>'));
  assert.match(popupCss, /prefers-reduced-motion: reduce/);
  assert.match(editorCss, /\.editor-status\[data-status="success"\]/);
  assert.doesNotMatch(editorCss, /#pageStatus\[style\*=/);
  assert.match(editorCss, /\.resume-editor-page \*[^}]+transition: none !important/s);
  const headerCss = editorCss.slice(
    editorCss.indexOf(".editor-header {"),
    editorCss.indexOf(".editor-header-main", editorCss.indexOf(".editor-header {") + 1)
  );
  assert.doesNotMatch(headerCss, /position:\s*sticky/);
  assert.match(editorCss, /\.resume-nav-btn\.is-expanded\s*{[^}]+background:\s*transparent/s);
  assert.doesNotMatch(sourceForEditor(), /behavior: "smooth"/);
});

test("resume fields keep related date ranges aligned and stack on narrow screens", () => {
  const schemaSource = read("shared/resume-schema.js");
  const editorSource = read("resume-editor.js");
  const editorCss = read("resume-editor.css");

  assert.match(schemaSource, /key: "startDate", label: "入学时间", input: "date", rowStart: true/);
  assert.match(schemaSource, /key: "startDate", label: "入职时间", input: "date", rowStart: true/);
  assert.match(schemaSource, /key: "issueDate", label: "发证日期", input: "date", rowStart: true/);
  assert.match(editorSource, /field\.rowStart \? " resume-field-row-start"/);
  assert.match(editorCss, /\.resume-field-row-start\s*{[^}]+grid-column-start:\s*1/s);
  assert.match(editorCss, /@media \(max-width: 640px\)[\s\S]+\.resume-field-row-start\s*{[^}]+grid-column-start:\s*auto/s);
});

function sourceForEditor() {
  return read("resume-editor.js");
}
