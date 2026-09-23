import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createServer } from '../src/server.js';

const CHROME = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));

if (!CHROME) { console.error('FAIL: no Chrome/Edge found (set CHROME_PATH to override)'); process.exit(1); }

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudirve-ui-'));
const server = createServer({ dataRoot });
await server.store.init();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const cdpPort = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
});
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudirve-cdp-'));

// CI 容器（root 用户）必须 --no-sandbox，本地平台保持默认
const platformArgs = process.platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ...platformArgs,
], { stdio: ['ignore', 'ignore', 'pipe'] });

let idCounter = 0;
const pending = new Map();
let ws = null;
const consoleErrors = [];
const pageErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++idCounter;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 20000);
  });
}
async function evalInPage(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'page eval failed');
  return res.result?.value;
}
async function waitFor(expression, label, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evalInPage(`!!(${expression})`)) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`waitFor timeout: ${label}`);
}
async function shot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(import.meta.dirname, `${name}.png`), Buffer.from(res.data, 'base64'));
}
async function viewport(w, h, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile });
}

const checks = [];
function check(name, ok) { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`); }
const rowVisible = (name) => `[...document.querySelectorAll('.file-name button')].some((b) => b.textContent === '${name}')`;

const main = async () => {
  let list = null;
  for (let i = 0; i < 20; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); if (list?.length) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails?.exception?.description || 'page exception');
  };
  await send('Page.enable');
  await send('Runtime.enable');

  await viewport(1440, 900);
  await send('Page.navigate', { url: `${base}/` });
  await waitFor("document.querySelector('#login-form')", 'login form');
  check('登录页渲染', true);

  await evalInPage("document.querySelector('#username').value='demo'; document.querySelector('#password').value='cloudirve'; document.querySelector('#login-form button[type=submit]').click()");
  await waitFor("document.querySelector('.workspace')", 'workspace');
  check('登录后进入工作区', true);

  // 对话弹窗：新建文件夹
  await evalInPage("document.querySelector('[data-action=new-folder]').click()");
  await waitFor("document.querySelector('#input-dialog').open", 'input dialog open');
  check('新建文件夹弹窗可用', true);
  await evalInPage("document.querySelector('#input-value').value='测试文件夹'; document.querySelector('#input-confirm').click()");
  await waitFor(rowVisible('测试文件夹'), 'folder row');
  check('桌面表格渲染新文件夹', true);
  check('新建文件夹弹窗已关闭', await evalInPage("!document.querySelector('#input-dialog').open"));

  // 对话弹窗：重命名
  await evalInPage("document.querySelector('[data-action=rename]').click()");
  await waitFor("document.querySelector('#input-dialog').open", 'rename dialog open');
  check('重命名弹窗预填旧名称', await evalInPage("document.querySelector('#input-value').value === '测试文件夹'"));
  await evalInPage("document.querySelector('#input-value').value='测试目录'; document.querySelector('#input-confirm').click()");
  await waitFor(rowVisible('测试目录'), 'renamed row');
  check('重命名生效', true);

  // 确认弹窗：取消
  await evalInPage("document.querySelector('[data-action=delete]').click()");
  await waitFor("document.querySelector('#confirm-dialog').open", 'confirm open');
  await evalInPage("document.querySelector('#confirm-dialog button[value=cancel]').click()");
  await waitFor("!document.querySelector('#confirm-dialog').open", 'confirm closed');
  check('删除确认可取消', await evalInPage(rowVisible('测试目录')));

  // 确认弹窗：确认删除
  await evalInPage("document.querySelector('[data-action=delete]').click()");
  await waitFor("document.querySelector('#confirm-dialog').open", 'confirm open again');
  await evalInPage("document.querySelector('#confirm-action').click()");
  await waitFor("document.querySelector('.empty-state')", 'empty after delete');
  check('确认后移入回收站', true);
  await shot('ui-desktop-list');

  // 回收站：恢复
  await evalInPage("document.querySelector('[data-action=trash]').click()");
  await waitFor(rowVisible('测试目录'), 'trash row');
  check('回收站显示已删项目', true);
  await evalInPage("document.querySelector('[data-action=restore]').click()");
  await waitFor("document.querySelector('.empty-state')", 'trash empty after restore');
  await evalInPage("document.querySelector('[data-action=drive]').click()");
  await waitFor(rowVisible('测试目录'), 'restored row');
  check('恢复后回到我的文件', true);

  // 移动端卡片网格（此时目录中存在文件）
  await viewport(375, 720, true);
  await waitFor("getComputedStyle(document.querySelector('.file-grid')).display === 'grid'", 'mobile grid');
  check('移动端切换卡片网格', true);
  check('桌面表格在移动端隐藏', await evalInPage("getComputedStyle(document.querySelector('.file-table')).display === 'none'"));
  check('移动端无横向滚动', await evalInPage("document.documentElement.scrollWidth <= window.innerWidth + 1"));
  await shot('ui-mobile-cards');
  await viewport(1440, 900);

  // 回收站：永久删除
  await evalInPage("document.querySelector('[data-action=delete]').click()");
  await waitFor("document.querySelector('#confirm-dialog').open", 'confirm for permanent');
  await evalInPage("document.querySelector('#confirm-action').click()");
  await evalInPage("document.querySelector('[data-action=trash]').click()");
  await waitFor(rowVisible('测试目录'), 'trash row again');
  await evalInPage("document.querySelector('[data-action=permanent-delete]').click()");
  await waitFor("document.querySelector('#confirm-dialog').open", 'permanent confirm');
  await evalInPage("document.querySelector('#confirm-action').click()");
  await waitFor("document.querySelector('.empty-state')", 'trash empty after permanent');
  check('永久删除生效', true);

  check('无控制台错误', consoleErrors.length === 0);
  check('无未捕获页面异常', pageErrors.length === 0);
  if (consoleErrors.length || pageErrors.length) console.log({ consoleErrors, pageErrors });
};

main()
  .then(async () => {
    const failed = checks.filter((c) => !c.ok);
    console.log(failed.length ? `FAILED ${failed.length}/${checks.length}` : `ALL ${checks.length} CHECKS PASSED`);
    try { await send('Browser.close'); } catch {}
    await new Promise((r) => setTimeout(r, 900));
    if (chrome.exitCode === null) { try { process.kill(-chrome.pid); } catch { try { chrome.kill(); } catch {} } }
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
    server.close();
    process.exit(failed.length ? 1 : 0);
  })
  .catch(async (error) => {
    console.error('FAIL:', error.message);
    try { await send('Browser.close'); } catch {}
    await new Promise((r) => setTimeout(r, 900));
    if (chrome.exitCode === null) { try { process.kill(-chrome.pid); } catch { try { chrome.kill(); } catch {} } }
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
    server.close();
    process.exit(1);
  });
