(function (root) {
  "use strict";
  function staticText(node) {
    if (!node || node.matches?.('input,textarea,select,[contenteditable],script,style,[hidden],[aria-hidden="true"]')) return "";
    const copy = node.cloneNode(true);
    copy.querySelectorAll('input,textarea,select,[contenteditable],script,style,[hidden],[aria-hidden="true"]').forEach(n => n.remove());
    return (copy.textContent || "").replace(/\s+/g, " ").trim().slice(0, 2000);
  }
  function references(el, attr) {
    return (el.getAttribute(attr) || "").split(/\s+/).filter(Boolean).map(id => staticText(el.ownerDocument.getElementById(id))).filter(Boolean).join(" ");
  }
  function readValue(el, runtime) {
    const type = String(el.getAttribute("type") || "").toLowerCase();
    if (["password", "hidden", "file"].includes(type)) return { valueCaptured: false };
    if (runtime.options) return { valueCaptured: true, value: runtime.options.filter(o => o.el.checked).map(o => Array.from(o.el.labels || []).map(staticText).filter(Boolean).join(" ") || o.label || o.el.value || "已勾选").join("\n") };
    if (el.tagName.toLowerCase() === "select") return { valueCaptured: true, value: Array.from(el.selectedOptions || []).filter(o => o.value !== "").map(o => o.textContent || o.value).join("\n") };
    return { valueCaptured: true, value: el.isContentEditable ? (el.innerText || el.textContent || "") : String(el.value ?? "") };
  }
  function capture(scan, doc = document, location = root.location) {
    const runtime = new Map(scan.runtime.map(r => [r.fieldId, r]));
    const fields = scan.fields.map(f => {
      const r = runtime.get(f.fieldId), el = r?.el || r?.options?.[0]?.el;
      if (!el) return null;
      const nearby = el.closest('fieldset,section,[class*="form-item"],[class*="formItem"],[class*="field"]');
      const nearbyLabel = nearby?.querySelector('legend,label,[class*="label"]');
      const label = references(el, "aria-labelledby") || el.getAttribute("aria-label") || Array.from(el.labels || []).map(staticText).filter(Boolean).join(" ") || staticText(nearbyLabel) || el.getAttribute("placeholder") || el.getAttribute("name") || "未命名字段";
      const section = staticText(el.closest("fieldset,section,form")?.querySelector('legend,h1,h2,h3,h4,[role="heading"]')) || f.sectionLabel || "未分区";
      const instructions = references(el, "aria-describedby") || Array.from(nearby?.querySelectorAll('[class*="help"],[class*="hint"],[class*="description"]') || []).map(staticText).filter(Boolean).join(" ");
      const constraints = {};
      for (const key of ["minlength", "maxlength", "min", "max", "step", "pattern", "accept"]) {
        const value = el.getAttribute(key); if (value !== null) constraints[key] = value;
      }
      // Read the current control state, never raw HTML, passwords or file contents.
      const options = el.tagName.toLowerCase() === "select" ? Array.from(el.options || []).map(o => o.textContent || "") : (r.options || []).map(o => Array.from(o.el.labels || []).map(staticText).join(" ")).filter(Boolean);
      return { id: f.fieldId, label, section, type: f.inputType || f.kind, required: f.required,
        options, placeholder: el.getAttribute("placeholder") || "", instructions, constraints, ...readValue(el, r) };
    }).filter(Boolean);
    const parsed = new URL(location.href);
    return { id: crypto.randomUUID(), title: doc.title, url: parsed.origin + parsed.pathname, capturedAt: new Date().toISOString(), fields,
      limitations: "采集当前已加载主页面控件的要求和已填值（含只读、禁用控件）；不读取密码、隐藏项或附件内容。未展开、尚未加载、iframe 内及扫描器不支持的控件可能未覆盖；请手动切换步骤后继续采集。" };
  }
  root.ResumePageRequirements = { capture };
})(globalThis);
