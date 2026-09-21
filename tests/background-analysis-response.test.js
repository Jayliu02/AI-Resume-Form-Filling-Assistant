const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function load(choice) {
  const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
  const c = vm.createContext({ URL, console, setTimeout, clearTimeout, AbortController,
    ResumeModelStorage: { async getModelConfig() { return { baseUrl: 'https://example.com/v1', apiKey: 'mock', model: 'mock' }; } },
    async fetch() { return { ok: true, async json() { return { choices: [choice] }; } }; },
  });
  vm.runInContext(source.slice(source.indexOf('async function callAI(')), c);
  return c.callAI;
}
test('requirements analysis identifies model truncation before JSON parsing', async () => {
  await assert.rejects(load({ finish_reason: 'length', message: { content: '{"summary":' } })('mock', '{}', 'page_requirements'), /AI_OUTPUT_TRUNCATED/);
});
test('AI content text parts are normalized while reasoning parts are excluded', async () => {
  const result = await load({ finish_reason: 'stop', message: { content: [{ type: 'reasoning', text: 'not output' }, { type: 'text', text: '{"summary":"ok",' }, { type: 'text', text: '"requirements":[]}' }] } })('mock', '{}', 'page_requirements');
  assert.equal(JSON.parse(result).summary, 'ok');
});
