const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadScanner(forms, outside = []) {
  const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
  const start = source.indexOf("  function scanFields(");
  const end = source.indexOf("  function buildFieldSemanticMeta(", start);
  assert.ok(start >= 0 && end > start);
  const controls = [...forms.flatMap(form => form.controls), ...outside];
  const context = {
    document: { querySelectorAll: selector => selector === "form" ? forms : controls },
    getComputedStyle: el => el.style || {},
    // Labels and widget adapters have separate tests; exercise real scan,
    // filtering, identity, grouping and selection logic here.
    buildFieldSemanticMeta: el => ({ label: el.getAttribute("name") || "field" }),
    buildTextLikeRuntime: (fieldId, el, inputType) => ({ fieldId, el, inputType, kind: "text" }),
    getOptionLabel: el => el.value,
    getGroupLabel: () => "group",
  };
  vm.createContext(context);
  vm.runInContext(`
    const radioScopeIds = new WeakMap();
    let radioScopeSequence = 0;
    ${source.slice(start, end)}
    this.scan = scanFields;
  `, context);
  return context.scan;
}

function control({ tag = "input", attrs = {}, disabled = false, style = {}, top = 0, laidOut = true, value = "" } = {}) {
  const rect = { left: 0, right: 100, top, bottom: top + 20, width: 100, height: 20 };
  return {
    tagName: tag.toUpperCase(),
    id: "",
    disabled,
    style,
    value,
    options: tag === "select" ? [{ textContent: "option" }] : undefined,
    getAttribute: name => attrs[name] ?? null,
    getClientRects: () => laidOut ? [rect] : [],
    getBoundingClientRect: () => rect,
    closest() { return this.form || null; },
  };
}

function form(controls) {
  const node = {
    controls,
    querySelectorAll: () => controls,
    getClientRects: () => [{}],
  };
  controls.forEach(el => { el.form = node; });
  return node;
}

test("page scan covers all 96 controls across the BYD form distribution exactly once", () => {
  const counts = [15, 12, 9, 4, 4, 4, 4, 8, 8, 4, 6, 12, 2, 4, 0];
  const forms = counts.map(count => form(Array.from({ length: count }, () =>
    control({ attrs: { name: "repeated-name" } })
  )));
  const result = loadScanner(forms)();
  assert.equal(result.fields.length, 96);
  assert.equal(result.runtime.length, 96);
  assert.equal(new Set(result.fields.map(field => field.fieldId)).size, 96);
  assert.equal(new Set(result.runtime.map(item => item.el)).size, 96);
  assert.deepEqual(Array.from(result.runtime, item => item.el), forms.flatMap(item => item.controls));
  assert.deepEqual(Array.from(result.fields, item => item.fieldId), Array.from(result.runtime, item => item.fieldId));
});

test("page scan includes controls outside forms and preserves supported control types", () => {
  const inside = [control(), control()];
  const outside = [control({ tag: "textarea" }), control({ tag: "select" }),
    control({ tag: "div", attrs: { contenteditable: "true" } })];
  const result = loadScanner([form(inside)], outside)();
  assert.deepEqual(Array.from(result.runtime, item => item.el), [...inside, ...outside]);
  assert.deepEqual(Array.from(result.fields, item => item.kind), ["text", "text", "textarea", "select", "contenteditable"]);
});

test("page scan still excludes hidden, disabled and unsupported inputs across forms", () => {
  const excluded = [
    control({ style: { display: "none" } }),
    control({ style: { visibility: "hidden" } }),
    control({ laidOut: false }),
    control({ disabled: true }),
    control({ attrs: { "aria-disabled": "true" } }),
    ...["hidden", "password", "submit", "button", "reset", "image", "range", "color"]
      .map(type => control({ attrs: { type } })),
  ];
  const included = [control(), control(), control()];
  const result = loadScanner([form(included.slice(0, 2)), form([...excluded, included[2]])])();
  assert.deepEqual(Array.from(result.runtime, item => item.el), included);
});

for (const type of ["radio", "checkbox"]) {
  test(`same-name ${type} groups stay separate across forms`, () => {
    const forms = Array.from({ length: 3 }, () => form(["yes", "no"].map(value =>
      control({ attrs: { type, name: "same-name" }, value })
    )));
    const result = loadScanner(forms)();
    assert.equal(result.fields.length, 3);
    assert.equal(new Set(result.fields.map(field => field.fieldId)).size, 3);
    result.fields.forEach(field => {
      assert.equal(field.kind, `${type}_group`);
      assert.deepEqual(Array.from(field.options), ["yes", "no"]);
    });
    result.runtime.forEach((item, index) => {
      assert.deepEqual(Array.from(item.options, option => option.el), forms[index].controls);
    });
  });
}

test("selection scan spans multiple forms but only returns intersecting fields", () => {
  const first = [control({ top: 0 }), control({ top: 50 })];
  const second = [control({ top: 100 }), control({ top: 150 })];
  const outside = control({ top: 200 });
  const result = loadScanner([form(first), form(second)], [outside])({
    scope: "selection",
    selectionRect: { left: 0, right: 100, top: 45, bottom: 125 },
  });
  assert.deepEqual(Array.from(result.runtime, item => item.el), [first[1], second[0]]);
  assert.deepEqual(Array.from(result.fields, item => item.fieldId), Array.from(result.runtime, item => item.fieldId));
});

test("page scan supports a page without form elements", () => {
  const outside = [control(), control({ tag: "textarea" })];
  const result = loadScanner([], outside)();
  assert.deepEqual(Array.from(result.runtime, item => item.el), outside);
});
