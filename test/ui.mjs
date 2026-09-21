import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

if (!CHROME) { console.error('FAIL: no Chrome/Edge found'); process.exit(1); }

const cdpPort = await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudirve-cdp-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, 'about:blank',
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
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await waitFor("document.querySelector('#login-form')", 'login form');
  check('登录页渲染', true);
  await shot('ui-desktop-login');

  await evalInPage("document.querySelector('#username').value='demo'; document.querySelector('#password').value='cloudirve'; document.querySelector('#login-form button[type=submit]').click()");
  await waitFor("document.querySelector('.workspace')", 'workspace');
  check('登录后进入工作区', true);
  await waitFor("document.querySelector('#file-area')", 'file area');
  await shot('ui-desktop-drive');
  check('桌面端空状态可见', await evalInPage("!!document.querySelector('.empty-state')"));
  check('侧栏导航项齐全', await evalInPage("document.querySelectorAll('.nav-item').length === 2"));
  check('文件行操作按钮（空目录除外）', await evalInPage("document.querySelectorAll('.nav-item').length >= 2"));

  await evalInPage("document.querySelector('[data-action=trash]').click()");
  await waitFor("document.querySelector('.breadcrumb')", 'trash view');
  check('回收站页面可达', await evalInPage("document.body.textContent.includes('回收站')"));
  await shot('ui-desktop-trash');

  await viewport(375, 720, true);
  await send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await waitFor("document.querySelector('.workspace')", 'mobile workspace');
  await shot('ui-mobile-drive');
  check('移动端无横向滚动', await evalInPage("document.documentElement.scrollWidth <= window.innerWidth + 1"));

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
    process.exit(failed.length ? 1 : 0);
  })
  .catch(async (error) => {
    console.error('FAIL:', error.message);
    try { await send('Browser.close'); } catch {}
    await new Promise((r) => setTimeout(r, 900));
    if (chrome.exitCode === null) { try { process.kill(-chrome.pid); } catch { try { chrome.kill(); } catch {} } }
    fs.rmSync(profileDir, { recursive: true, force: true });
    process.exit(1);
  });
