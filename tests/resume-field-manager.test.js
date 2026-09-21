const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function setup(profileFactory) {
  let dialog, applied, closed = false, confirmResult = true;
  const confirmations = [];
  const document = { activeElement: { focus() {} }, body: { appendChild(node) { dialog = node; } }, createElement: element };
  function element(tag) {
    return {
      tagName: tag, value: "", children: [], listeners: {}, nodes: {},
      set innerHTML(html) {
        for (const match of html.matchAll(/<(\w+)[^>]*\sdata-([\w-]+)(?:\s|>)/g)) this.nodes[match[2]] = element(match[1]);
      },
      querySelector(selector) { return this.nodes[selector.slice(6, -1)]; },
      appendChild(child) { this.children.push(child); if (tag === "select" && this.children.length === 1) this.value = child.value; },
      append(...nodes) { nodes.forEach(node => this.appendChild(node)); },
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute() {}, focus() {}, remove() {}, showModal() {},
      close() { this.listeners.close?.(); },
      addEventListener(event, listener) { this.listeners[event] = listener; },
    };
  }
  const context = vm.createContext({ document, structuredClone, URL, crypto: webcrypto, confirm(message) { confirmations.push(message); return confirmResult; } });
  context.window = context;
  for (const file of ["resume-schema", "resume-field-manager"]) vm.runInContext(fs.readFileSync(path.join(__dirname, `../shared/${file}.js`), "utf8"), context);
  const profile = profileFactory(context.ResumeSchema);
  context.ResumeFieldManager.open(profile, result => { applied = result; }, () => { closed = true; });
  const el = name => dialog.nodes[name];
  return { profile, el, confirmations, get applied() { return applied; }, get closed() { return closed; },
    setConfirm(value) { confirmResult = value; },
    click(name) { el(name).listeners.click(); },
    submit() { el("form").listeners.submit({ preventDefault() {} }); },
    section(key) { el("section").value = key; el("section").listeners.change(); },
  };
}

test("field manager applies additions only on completion and cancellation leaves original untouched", () => {
  for (const finish of ["apply", "cancel"]) {
    const ui = setup(s => s.createEmptyResumeProfile());
    ui.el("label").value = "Custom note";
    ui.el("type").value = "textarea";
    ui.submit();
    assert.equal(ui.el("error").textContent, "");
    assert.equal(ui.profile.fieldConfig, undefined);
    assert.equal(ui.applied, undefined);
    ui.click(finish);
    assert.equal(ui.closed, true);
    assert.equal(Boolean(ui.applied), finish === "apply");
    if (ui.applied) assert.equal(ui.applied.fieldConfig.sections[0].fields.at(-1).label, "Custom note");
  }
});

test("type change counts incompatible records and only clears after confirmation", () => {
  const ui = setup(s => s.normalizeResumeProfile({ educations: [{ school: "A" }, { school: "B" }] }));
  ui.section("educations");
  ui.el("list").children[0].children[1].listeners.click();
  ui.el("type").value = "select"; ui.el("options").value = "A";
  ui.setConfirm(false); ui.submit();
  assert.match(ui.confirmations.at(-1), /1/);
  assert.equal(ui.el("heading").textContent, "编辑字段");
  ui.setConfirm(true); ui.submit(); ui.click("apply");
  assert.equal(ui.applied.educations[0].school, "A");
  assert.equal(ui.applied.educations[1].school, "");
  assert.equal(ui.profile.educations[1].school, "B");
});

test("deleting a repeated field confirms its scope and removes all values", () => {
  const ui = setup(s => s.normalizeResumeProfile({ educations: [{ school: "A" }, { school: "B" }] }));
  ui.section("educations");
  ui.setConfirm(false); ui.el("list").children[0].children[2].listeners.click();
  assert.match(ui.confirmations.at(-1), /全部经历/);
  assert.ok(ui.el("list").children[0].children[0].textContent.includes("学校名称"));
  ui.setConfirm(true); ui.el("list").children[0].children[2].listeners.click();
  ui.click("apply");
  assert.ok(ui.applied.educations.every(item => !("school" in item)));
});
