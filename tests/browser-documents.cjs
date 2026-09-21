// Real Chromium DOM smoke test with isolated browser profile and mocked extension/AI APIs.
// Run: node tests/browser-documents.cjs [path-to-chromium]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const scripts = ["shared/resume-schema.js", "shared/diagnostics.js", "shared/field-text.js", "shared/field-semantics.js", "shared/fill-runtime.js", "shared/content-bridge.js", "shared/ai-client.js", "shared/page-requirements.js", "content.js"];
const fixture = `<!doctype html><title>Recruitment requirements</title><form><h2>教育经历</h2><label>学校<input name="school" value="PRIVATE_SCHOOL" readonly required maxlength="100" aria-describedby="school-help"></label><p id="school-help">请填写学校全称</p><label>邮箱<input type="email" name="email" value="PRIVATE_EMAIL" disabled pattern=".+@.+"></label><label>学历<select><option>本科</option><option selected>硕士</option></select></label></form><form><h2>项目经历</h2><label>项目说明<textarea minlength="20" maxlength="500">PRIVATE_PROJECT</textarea></label><label>附件<input type="file" accept=".pdf"></label><label>多选<select multiple><option selected value="a">A</option><option selected value="b">B</option></select></label><fieldset><legend>技能</legend><label><input type="checkbox" name="skill" value="js" checked>JavaScript</label><label><input type="checkbox" name="skill" value="py">Python</label></fieldset><fieldset><legend>是否到岗</legend><label><input type="radio" name="ready" value="yes" checked>是</label><label><input type="radio" name="ready" value="no">否</label></fieldset><div contenteditable="true" aria-label="个人简介">PRIVATE_EDITABLE</div><input type="hidden" value="PRIVATE_TOKEN"><input type="password" value="PRIVATE_PASSWORD"></form>${scripts.map(p => `<script src="/${p}"></script>`).join("")}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, message) { for (let n = 0; n < 100; n++) { const value = await fn(); if (value) return value; await sleep(100); } throw new Error(message); }
async function connect(url) {
  const socket = new WebSocket(url), pending = new Map(); let seq = 0;
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const data = JSON.parse(event.data); if (pending.has(data.id)) { const { resolve, reject, timer } = pending.get(data.id); clearTimeout(timer); pending.delete(data.id); data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result); } };
  socket.onclose = () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error("Browser connection closed")); } pending.clear(); };
  return { socket, send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); } };
}
async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
(async () => {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://localhost").pathname;
    if (p === "/fixture") { res.setHeader("Content-Type", "text/html;charset=utf-8"); return res.end(fixture); }
    const file = path.resolve(root, "." + p);
    if (!file.startsWith(root + path.sep) || !/\.(js|css|html)$/.test(file) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript;charset=utf-8" : file.endsWith(".css") ? "text/css;charset=utf-8" : "text/html;charset=utf-8");
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "resume-docs-smoke-"));
  const browser = spawn(process.argv[2] || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
  let browserCdp;
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    await waitFor(() => fs.existsSync(portFile), "Browser did not start");
    const [port, endpoint] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    browserCdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const cdp = await connect(targets.find(t => t.type === "page").webSocketDebuggerUrl);
    const errors = [];
    cdp.socket.addEventListener("message", event => { const m = JSON.parse(event.data); if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails); });
    await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const initial = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__listeners=[];window.chrome={runtime:{id:'test',onMessage:{addListener:fn=>__listeners.push(fn)}}};` });
    await cdp.send("Page.navigate", { url: origin + "/fixture?token=PRIVATE_URL#secret" });
    await waitFor(() => evaluate(cdp, "Boolean(window.ResumePageRequirements && window.__listeners?.length)"), "Scanner did not load");
    const page = await evaluate(cdp, "new Promise(resolve => __listeners[0]({action:'captureRequirements'}, {id:'test'}, resolve))");
    assert.equal(page.success, true); assert.equal(page.page.fields.length, 9);
    assert.ok(page.page.fields.some(f => f.value === "PRIVATE_SCHOOL")); assert.ok(page.page.fields.some(f => f.value === "PRIVATE_EMAIL")); assert.ok(page.page.fields.some(f => f.value === "PRIVATE_PROJECT")); assert.ok(page.page.fields.some(f => f.value === "硕士")); for (const secret of ["PRIVATE_TOKEN", "PRIVATE_PASSWORD", "PRIVATE_URL"]) assert.ok(!JSON.stringify(page).includes(secret)); assert.ok(!page.page.url.includes("?"));
    assert.ok(page.page.fields.some(f => f.constraints.maxlength === "500"));
    assert.ok(page.page.fields.some(f => f.constraints.accept === ".pdf"));
    assert.ok(page.page.fields.some(f => f.instructions.includes("学校全称")));
    assert.ok(page.page.fields.some(f => f.section === "项目经历"));
    for (const value of ["A\nB", "JavaScript", "是", "PRIVATE_EDITABLE"]) assert.ok(page.page.fields.some(f => f.value === value), value);
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: initial.identifier });
    const shim = `
      window.__data = JSON.parse(sessionStorage.getItem('mockStorage') || '{}');
      window.__page = ${JSON.stringify(page.page)};
      const area = {async get(keys) { if(keys==null)return structuredClone(__data);return Object.fromEntries([].concat(keys).filter(k=>k in __data).map(k=>[k,structuredClone(__data[k])]));},async set(v){Object.assign(__data,structuredClone(v));sessionStorage.setItem('mockStorage',JSON.stringify(__data));},async remove(keys){for(const k of keys)delete __data[k];}};
      window.chrome={storage:{local:area,sync:{async get(){return {};},async remove(){}}},scripting:{async executeScript(){}},tabs:{async query(){return [{id:1,title:'Recruitment',url:__page.url}]},async sendMessage(){return {success:true,page:structuredClone(__page)}}},runtime:{sendMessage(request,callback){const promise=(async()=>{
        if(request.action==='resumeDocuments')return {ok:true,value:await ResumeDocuments.dispatch(request,area)};
        if(request.action==='resumeStorage'){if(!__data.resumeTemplates)await area.set({resumeTemplates:{resume:{id:'resume',name:'Test resume',profile:ResumeSchema.normalizeResumeProfile({personal:{summary:'Original summary'},educations:[{school:'Original school'}]}),updatedAt:'2026-01-01'}}});return {ok:true,value:{templates:Object.values(__data.resumeTemplates),activeTemplateId:'resume'}};}
        if(request.action==='callAI'){if(window.__failAI)return {success:false,error:'Simulated AI failure'};const p=JSON.parse(request.prompt);return {success:true,data:'以下是分析结果：'+JSON.stringify({summary:'Requirements analyzed',requirements:p.pages.flatMap(page=>page.fields.map(f=>({section:f.section,requirement:f.label,evidence:[page.id+'/'+f.id],resumePath:'',status:'missing',suggestion:'Complete '+f.label}))),suggestions:[{kind:'set_value',sectionKey:'personal',fieldKey:'summary',recordIndex:null,value:'PRIVATE_EDITABLE',reason:'Captured profile',evidence:[p.pages[0].id+'/'+p.pages[0].fields.find(f=>f.value==='PRIVATE_EDITABLE').id]},{kind:'set_value',sectionKey:'educations',fieldKey:'school',recordIndex:0,value:'PRIVATE_SCHOOL',reason:'Captured school',evidence:[p.pages[0].id+'/'+p.pages[0].fields[0].id]},{kind:'add_field',sectionKey:'personal',recordIndex:null,value:'Known note',field:{label:'申请备注',input:'textarea'},reason:'Additional captured information',evidence:[p.pages[0].id+'/'+p.pages[0].fields[0].id]},{kind:'edit_field',sectionKey:'educations',fieldKey:'school',recordIndex:null,field:{label:'学校选项',input:'select',options:['Replacement school']},reason:'Options changed',evidence:[p.pages[0].id+'/'+p.pages[0].fields[0].id]}]})};}
      })();if(callback){promise.then(callback);return;}return promise;}}};`;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: shim });
    await cdp.send("Page.navigate", { url: origin + "/resume-documents.html?sourceTabId=1" });
    await waitFor(() => evaluate(cdp, "document.getElementById('documentStatus')?.textContent.includes('采集完成')"), "Initial capture failed");
    await evaluate(cdp, "document.getElementById('capturePage').click()");
    await waitFor(() => evaluate(cdp, "document.getElementById('duplicatePage').open"), "Duplicate dialog absent");
    await evaluate(cdp, "document.getElementById('appendDuplicate').click()");
    await waitFor(() => evaluate(cdp, "document.querySelectorAll('.page-card').length===2"), "Append failed");
    await evaluate(cdp, "document.getElementById('analyzeDocument').click()");
    await waitFor(() => evaluate(cdp, "document.getElementById('documentStatus').textContent.includes('分析完成')"), "Analysis failed");
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.requirement-card').length"), 8);
    assert.equal(await evaluate(cdp, "document.getElementById('pageSources').open || document.getElementById('analysisDetails').open"), false);
    await evaluate(cdp, "document.getElementById('saveDocument').click()");
    await waitFor(() => evaluate(cdp, "document.getElementById('documentStatus').textContent.includes('已保存')"), "Save failed");
    await evaluate(cdp, "window.__failAI=true;document.getElementById('analyzeDocument').click()");
    await waitFor(() => evaluate(cdp, "document.getElementById('documentStatus').textContent.includes('Simulated')"), "Failure not shown");
    assert.equal(await evaluate(cdp, "__data.resumeRequirementDocumentsV1[0].pages.length"), 2);
    await cdp.send("Page.navigate", { url: origin + "/resume-documents.html" });
    await waitFor(() => evaluate(cdp, "document.getElementById('documentList')?.options.length===1 && !document.getElementById('saveDocument').disabled"), "Reload failed");
    await evaluate(cdp, "const list=document.getElementById('documentList');list.selectedIndex=0;list.dispatchEvent(new Event('change'))");
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.page-card').length"), 2);
    const markdown = await evaluate(cdp, "ResumeDocuments.markdown(__data.resumeRequirementDocumentsV1[0])");
    assert.ok(markdown.includes("Requirements analyzed"));
    await evaluate(cdp, "document.getElementById('capturePage').click()");
    await waitFor(() => evaluate(cdp, "document.getElementById('duplicatePage').open"), "Replacement dialog absent");
    await evaluate(cdp, "document.getElementById('replaceDuplicate').click()");
    await waitFor(() => evaluate(cdp, "!document.getElementById('saveDocument').disabled && !document.getElementById('duplicatePage').open"), "Replacement did not finish");
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.page-card').length"), 2);
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.requirement-card').length"), 0);
    await evaluate(cdp, "document.getElementById('analyzeDocument').click()");
    await waitFor(() => evaluate(cdp, "document.getElementById('documentStatus').textContent.includes('分析完成')"), "Reanalysis failed");
    await evaluate(cdp, "document.getElementById('saveDocument').click()");
    await waitFor(() => evaluate(cdp, "document.getElementById('documentStatus').textContent.includes('已保存')"), "Replacement save failed");
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.suggestion-card').length"), 4);
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.suggestion-select:checked').length"), 0);
    assert.equal(await evaluate(cdp, "__data.resumeTemplates.resume.profile.personal.summary"), "Original summary");
    assert.equal(await evaluate(cdp, "document.getElementById('applySuggestions').disabled"), true);
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.suggestion-select')[3].disabled"), true);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate(cdp, "document.documentElement.scrollWidth <= window.innerWidth"), true, "Approval form overflows on mobile");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(cdp, "document.querySelector('.suggestion-body').open=true;const value=document.querySelector('.suggestion-value');value.value='Approved summary';value.dispatchEvent(new Event('input'));document.querySelector('.suggestion-select').click()");
    await evaluate(cdp, "document.querySelectorAll('.suggestion-select')[2].click()");
    assert.equal(await evaluate(cdp, "document.getElementById('applySuggestions').disabled"), false);
    await evaluate(cdp, "document.getElementById('applySuggestions').click()");
    await waitFor(() => evaluate(cdp, "document.getElementById('documentStatus').textContent.includes('已批准并应用')"), "Approval failed");
    assert.equal(await evaluate(cdp, "__data.resumeTemplates.resume.profile.personal.summary"), "Approved summary");
    assert.equal(await evaluate(cdp, "__data.resumeTemplates.resume.profile.educations[0].school"), "Original school");
    assert.equal(await evaluate(cdp, "Object.entries(__data.resumeTemplates.resume.profile.personal).some(([k,v])=>k.startsWith('custom_') && v==='Known note')"), true);
    assert.equal(await evaluate(cdp, "__data.resumeRequirementDocumentsV1[0].approvals.length"), 1);
    assert.equal(await evaluate(cdp, "document.getElementById('applySuggestions')===null"), true);
    await evaluate(cdp, `window.__approvalTest=structuredClone(__data.resumeRequirementDocumentsV1[0]);__approvalTest.approvals=[];
      __approvalTest.review.items=Array.from({length:14},(_,i)=>({id:'test-'+i,kind:'add_field',sectionKey:'personal',fieldKey:'',recordIndex:null,value:null,field:{label:'测试字段'+i,input:'text',placeholder:''},replacements:{},reason:'测试分页',evidence:[__approvalTest.pages[0].id+'/'+__approvalTest.pages[0].fields[0].id]}));
      ResumeSuggestionsUI.render(document.getElementById('suggestionReview'),__approvalTest,{onChange(){},onApply(ids){window.__approvedIds=ids}});`);
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.suggestion-card:not([hidden])').length"), 6);
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.suggestion-body[open]').length"), 0);
    await evaluate(cdp, "document.querySelector('.suggestion-card:not([hidden]) .suggestion-select').click();document.querySelector('#suggestionReview .review-pagination button:last-child').click();document.querySelector('.suggestion-card:not([hidden]) .suggestion-select').click()");
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.suggestion-select:checked').length"), 2);
    await evaluate(cdp, "{const search=document.querySelector('#suggestionReview .review-filters input');search.value='测试字段13';search.dispatchEvent(new Event('input'));document.getElementById('applySuggestions').click()}");
    assert.deepEqual(await evaluate(cdp, "window.__approvedIds"), ["test-0", "test-6"]);
    assert.equal(await evaluate(cdp, "document.querySelectorAll('.suggestion-card:not([hidden])').length"), 1);
    await evaluate(cdp, "{const search=document.querySelector('#suggestionReview .review-filters input');search.value='';search.dispatchEvent(new Event('input'))}");
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    fs.mkdirSync(path.join(root, "output"), { recursive: true });
    fs.writeFileSync(path.join(root, "output/documents-smoke.png"), Buffer.from(shot.data, "base64"));
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate(cdp, "document.documentElement.scrollWidth <= window.innerWidth"), true, "Mobile layout overflows");
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log("PASS: real DOM scan reads filled/disabled/readonly values and excludes passwords/hidden fields; two-page capture, duplicate handling, AI preview, save, failure retention, reload, Markdown export, edited approvals and atomic partial application.");
    cdp.socket.close();
  } finally {
    if (browserCdp) { await browserCdp.send("Browser.close").catch(() => {}); browserCdp.socket.close(); }
    else browser.kill();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
