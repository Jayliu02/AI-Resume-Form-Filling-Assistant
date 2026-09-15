(function (root) {
  "use strict";
  const PREFIX = "resumeSyncV1:";
  const STATE = "resumeSyncState";
  const STATUS = "resumeSyncStatus";
  const encoder = new TextEncoder();
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const stable = (v) => JSON.stringify(v, function (_, value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value;
  });
  async function hash(value) {
    const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  }
  function dominates(a, b) {
    return Object.keys(b).every(k => (a[k] || 0) >= b[k]) &&
      Object.keys(a).some(k => a[k] > (b[k] || 0));
  }
  function merge(left, right) {
    const result = Object.create(null);
    for (const id of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const unique = new Map([...(left[id] || []), ...(right[id] || [])].map(v => [v.rev, v]));
      const versions = [...unique.values()];
      result[id] = versions.filter(v => !versions.some(other => dominates(other.clock, v.clock)))
        .sort((a, b) => a.rev.localeCompare(b.rev));
    }
    return result;
  }
  function materialize(records) {
    const templates = Object.create(null), origins = Object.create(null);
    for (const [origin, versions] of Object.entries(records)) {
      const deleted = versions.some(v => v.value === null);
      let first = !deleted;
      const seen = new Set();
      for (const v of versions) {
        if (!v.value) continue;
        const signature = content(v.value);
        if (seen.has(signature)) continue;
        seen.add(signature);
        const id = first ? origin : `${origin}~conflict~${v.rev}`;
        const clock = {};
        for (const peer of versions.filter(peer => peer.value && content(peer.value) === signature)) {
          for (const [device, count] of Object.entries(peer.clock)) clock[device] = Math.max(clock[device] || 0, count);
        }
        templates[id] = { ...copy(v.value), id,
          name: v.value.name + (first ? "" : "（冲突副本）"),
          _syncBase: { origin, clock } };
        origins[id] = { origin, clock };
        first = false;
      }
    }
    return { templates, origins };
  }
  function content(t) {
    return stable({ name: t.name, profile: t.profile, rawText: t.rawText || "", schemaVersion: t.schemaVersion });
  }
  function blank(t) {
    const meaningful = v => v && (typeof v === "object" ? Object.values(v).some(meaningful) : String(v).trim());
    return t.id === "tpl-default" && t.name === "默认简历" && !meaningful(t.profile) && !t.rawText;
  }
  async function seed(templates) {
    const records = Object.create(null);
    for (const t of Object.values(templates || {})) {
      if (blank(t)) continue;
      const value = copy(t); delete value._syncBase;
      const rev = await hash(t.id + content(t));
      records[t.id] = [{ rev, clock: { [rev]: 1 }, value }];
    }
    return records;
  }
  async function capture(state, before, after, bases = {}) {
    const records = copy(state.records);
    const view = materialize(records);
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[id] && after[id] && content(before[id]) === content(after[id])) continue;
      if (!before[id] && after[id] && blank(after[id])) continue;
      const base = bases[id] || view.origins[id] || { origin: id, clock: {} };
      const origin = base.origin;
      state.counter++;
      // Two stale editors on the same device are concurrent too. A branch
      // actor prevents the monotonic device counter from erasing that fact.
      const staleLocal = (records[origin] || []).some(v => (v.clock[state.device] || 0) > (base.clock[state.device] || 0));
      const actor = staleLocal ? `${state.device}-branch-${state.counter}` : state.device;
      const clock = { ...base.clock, [actor]: state.counter };
      const value = after[id] && !blank(after[id]) ? copy(after[id]) : null;
      if (value) {
        delete value._syncBase; value.id = origin;
        if (id.includes("~conflict~") && value.name === before[id]?.name) value.name = value.name.replace(/（冲突副本）$/, "");
      }
      const rev = `${state.device}-${state.counter}`;
      const next = merge({ [origin]: records[origin] || [] }, { [origin]: [{ rev, clock, value }] });
      records[origin] = next[origin];
    }
    state.records = records;
    return state;
  }
  async function pack(records) {
    const json = stable({ version: 1, records });
    const compressed = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    let binary = "";
    for (const byte of compressed) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);
    return { digest: await hash(encoded), parts: encoded.match(/.{1,7000}/g) || [""] };
  }
  function validate(payload) {
    if (payload?.version !== 1 || !payload.records || typeof payload.records !== "object" || Array.isArray(payload.records)) throw new Error("同步数据版本或格式不受支持");
    for (const [id, versions] of Object.entries(payload.records)) {
      if (!id || !Array.isArray(versions) || !versions.length) throw new Error("同步版本格式错误");
      for (const v of versions) {
        if (!v || typeof v.rev !== "string" || !/^[a-zA-Z0-9-]+$/.test(v.rev) || !v.clock || typeof v.clock !== "object" || Array.isArray(v.clock) || !Object.values(v.clock).every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("同步版本格式错误");
        if (v.value !== null && (!v.value || typeof v.value.name !== "string" || !v.value.profile || typeof v.value.profile !== "object" || Array.isArray(v.value.profile) || typeof v.value.rawText !== "string")) throw new Error("同步简历格式错误");
      }
    }
    return payload.records;
  }
  async function unpack(head, data) {
    if (head?.version !== 1 || !Number.isInteger(head.count) || head.count < 1 || head.count > 512 || !/^[a-f0-9]{64}$/.test(head.digest)) throw new Error("同步清单格式错误");
    const parts = [];
    for (let i = 0; i < head.count; i++) {
      const part = data[`${head.prefix}${i}`];
      if (typeof part !== "string") throw new Error("同步分片尚未到齐，稍后重试");
      parts.push(part);
    }
    const encoded = parts.join("");
    if (await hash(encoded) !== head.digest) throw new Error("同步数据校验失败，稍后重试");
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error("解压后的简历过大"); }
      chunks.push(value);
    }
    return validate(JSON.parse(await new Blob(chunks).text()));
  }
  function quota(data) {
    const sizes = Object.entries(data).map(([key, value]) => encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length);
    const bytes = sizes.reduce((a, b) => a + b, 0);
    if (sizes.some(n => n > 8192) || bytes > 102400 || sizes.length > 512) throw new Error("浏览器同步容量不足（含更新临时空间）；完整简历已保留本机，请导出备份或减少内容后重试");
    return bytes;
  }
  root.ResumeSync = { PREFIX, STATE, STATUS, stable, hash, merge, materialize, seed, capture, pack, unpack, quota };
})(globalThis);
