(function (root) {
  "use strict";

  function daysInMonth(year, month) {
    if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  function parse(value) {
    const match = String(value || "").match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
    if (!match || Number(match[1]) < 1) return null;
    const [, year, month = "", day = ""] = match;
    if (month && (Number(month) < 1 || Number(month) > 12)) return null;
    if (day && (Number(day) < 1 || Number(day) > daysInMonth(Number(year), Number(month)))) return null;
    return { year, month, day };
  }

  function create(document, field, value, path, onChange) {
    const host = document.createElement("div");
    host.className = "resume-date-control";
    host.dataset.resumePath = path;
    host.value = String(value || "");
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", field.label || "日期");
    const parts = parse(value);
    const selectors = {};

    function fillOptions(select, values, placeholder, selected) {
      select.replaceChildren();
      for (const entry of ["", ...values]) {
        const option = document.createElement("option");
        option.value = entry;
        option.textContent = entry || placeholder;
        select.appendChild(option);
      }
      select.value = values.includes(selected) ? selected : "";
    }

    for (const [part, label] of [["year", "年"], ["month", "月"], ["day", "日"]]) {
      const select = document.createElement("select");
      select.className = "resume-select";
      select.setAttribute("aria-label", `${field.label || "日期"}：${label}`);
      selectors[part] = select;
      host.appendChild(select);
    }
    const { year, month, day } = selectors;
    const years = Array.from({ length: new Date().getFullYear() + 20 - 1900 + 1 }, (_, i) => String(i + 1900));
    if (parts && !years.includes(parts.year)) years.push(parts.year);
    years.sort((a, b) => Number(b) - Number(a));
    fillOptions(year, years, "年", parts?.year || "");
    fillOptions(month, Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")), "月（可选）", parts?.month || "");

    function refreshDays(selected) {
      month.disabled = !year.value;
      if (!year.value) month.value = "";
      day.disabled = !year.value || !month.value;
      const count = day.disabled ? 0 : daysInMonth(Number(year.value), Number(month.value));
      fillOptions(day, Array.from({ length: count }, (_, i) => String(i + 1).padStart(2, "0")), "日（可选）", selected);
    }
    refreshDays(parts?.day || "");

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "btn-text resume-date-clear";
    clear.textContent = "清空";
    clear.setAttribute("aria-label", `清空${field.label || "日期"}`);
    host.appendChild(clear);
    const legacy = document.createElement("span");
    legacy.className = "resume-date-legacy";
    legacy.textContent = !parts && value ? `原值：${value}；请选择日期以替换` : "";
    legacy.hidden = !legacy.textContent;
    host.appendChild(legacy);

    function update() {
      refreshDays(day.value);
      host.value = [year.value, month.value, day.value].filter(Boolean).join("-");
      legacy.hidden = true;
      onChange();
    }
    for (const select of Object.values(selectors)) select.addEventListener("change", update);
    clear.addEventListener("click", () => {
      year.value = "";
      update();
    });
    host.focus = () => year.focus();
    return host;
  }

  root.ResumeDateControl = { create, parse, daysInMonth };
})(typeof globalThis !== "undefined" ? globalThis : this);
