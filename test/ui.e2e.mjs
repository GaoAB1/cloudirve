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
async function setInputFiles(selector, filePath) {
  await send('DOM.enable');
  const doc = await send('DOM.getDocument', { depth: -1 });
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  await send('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId });
  await evalInPage(`document.querySelector('${selector}').dispatchEvent(new Event('change', { bubbles: true }))`);
}

const checks = [];
function check(name, ok) { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`); }
const rowVisible = (name) => `[...document.querySelectorAll('.file-name button')].some((b) => b.textContent === '${name}')`;

const main = async () => {
  const chromeStderr = [];
  chrome.stderr.on('data', (chunk) => chromeStderr.push(String(chunk)));
  chrome.on('exit', (code) => { if (code !== null && code !== 0) console.log(`chrome exited early: code=${code}\n${chromeStderr.join('').slice(-2000)}`); });
  let page = null;
  // CI 上 Chrome 冷启动较慢，最多等 30 秒
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      page = (list || []).find((t) => t.type === 'page');
      if (page) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!page) throw new Error(`CDP /json/list 未就绪。chrome stderr:\n${chromeStderr.join('').slice(-2000)}`);
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
  await waitFor("document.querySelector('#storage-text').textContent.includes('个文件')", 'sidebar storage');
  await shot('ui-desktop-drive');

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
  await waitFor("document.body.textContent.includes('剩余')", 'retention label');
  check('回收站显示保留期限', true);
  await evalInPage("document.querySelector('[data-action=restore]').click()");
  await waitFor("document.querySelector('.empty-state')", 'trash empty after restore');
  await evalInPage("document.querySelector('[data-action=drive]').click()");
  await waitFor(rowVisible('测试目录'), 'restored row');
  check('恢复后回到我的文件', true);

  // 搜索：输入关键词，点击结果跳转目录
  await evalInPage("const si = document.querySelector('#search-input'); si.value = '测试'; si.dispatchEvent(new Event('input', { bubbles: true }))");
  await waitFor("document.querySelector('#search-input') && [...document.querySelectorAll('.file-name button')].some((b) => b.textContent === '测试目录')", 'search results');
  check('搜索命中目标目录', true);
  await evalInPage("document.querySelector('[data-action=open]').click()");
  await waitFor("document.querySelector('.breadcrumb') && [...document.querySelectorAll('.breadcrumb button')].some((b) => b.textContent === '测试目录')", 'search jump breadcrumb');
  check('搜索结果跳转到所在目录', true);

  // 上传面板：CDP 设置真实文件，观察进度面板
  const samplePath = path.join(dataRoot, 'sample-upload.txt');
  fs.writeFileSync(samplePath, 'hello upload panel');
  await evalInPage("document.querySelector('[data-action=upload]').click()");
  await setInputFiles('#file-input', samplePath);
  await waitFor("document.querySelector('.upload-item.done')", 'upload done');
  check('上传面板显示完成状态', true);
  await waitFor(rowVisible('sample-upload.txt'), 'uploaded row');
  check('上传后列表刷新', true);
  await waitFor("document.querySelector('#storage-text').textContent.includes('1 个文件')", 'storage update');
  check('上传后存储用量更新', true);

  // 文本预览：模态弹窗显示文件内容
  await evalInPage("document.querySelector('[data-action=preview]').click()");
  await waitFor("document.querySelector('#preview-dialog').open && (document.querySelector('.preview-text') || { textContent: '' }).textContent.includes('hello upload panel')", 'preview text');
  check('文本预览内容正确', true);
  await evalInPage("document.querySelector('#preview-close').click()");
  await waitFor("!document.querySelector('#preview-dialog').open", 'preview closed');
  check('预览弹窗可关闭', true);

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

  // 批量操作：批量删除 → 批量恢复 → 批量永久删除
  await evalInPage("document.querySelector('[data-action=drive]').click()");
  await waitFor("document.querySelector('.empty-state') || document.querySelector('.file-table')", 'drive ready');
  await evalInPage("document.querySelector('[data-action=new-folder]').click()");
  await waitFor("document.querySelector('#input-dialog').open", 'batch folder a dialog');
  await evalInPage("document.querySelector('#input-value').value='批量A'; document.querySelector('#input-confirm').click()");
  await waitFor(rowVisible('批量A'), 'batch folder a');
  await evalInPage("document.querySelector('[data-action=new-folder]').click()");
  await waitFor("document.querySelector('#input-dialog').open", 'batch folder b dialog');
  await evalInPage("document.querySelector('#input-value').value='批量B'; document.querySelector('#input-confirm').click()");
  await waitFor(rowVisible('批量B'), 'batch folder b');
  await evalInPage("document.querySelector('[data-action=select-all]').click()");
  await waitFor("!document.querySelector('#batch-bar').hidden", 'batch bar visible');
  check('多选后批量条出现', await evalInPage("document.body.textContent.includes('已选 2 项')"));
  await evalInPage("document.querySelector('[data-action=batch-delete]').click()");
  await waitFor("document.querySelector('#confirm-dialog').open", 'batch delete confirm');
  await evalInPage("document.querySelector('#confirm-action').click()");
  await waitFor("document.querySelector('.empty-state')", 'drive empty after batch delete');
  check('批量删除生效', true);
  await evalInPage("document.querySelector('[data-action=trash]').click()");
  await waitFor("document.querySelector('.file-table')", 'trash table');
  await evalInPage("document.querySelector('[data-action=select-all]').click()");
  await waitFor("!document.querySelector('#batch-bar').hidden", 'trash batch bar');
  await evalInPage("document.querySelector('[data-action=batch-restore]').click()");
  await waitFor("document.querySelector('.empty-state')", 'trash empty after batch restore');
  check('批量恢复生效', true);
  await evalInPage("document.querySelector('[data-action=drive]').click()");
  await waitFor(rowVisible('批量A'), 'restored batch folder a');
  await evalInPage("document.querySelector('[data-action=select-all]').click()");
  await waitFor("!document.querySelector('#batch-bar').hidden", 'batch bar again');
  await evalInPage("document.querySelector('[data-action=batch-delete]').click()");
  await waitFor("document.querySelector('#confirm-dialog').open", 'batch delete confirm again');
  await evalInPage("document.querySelector('#confirm-action').click()");
  await evalInPage("document.querySelector('[data-action=trash]').click()");
  await waitFor("document.querySelector('.file-table')", 'trash table again');
  await evalInPage("document.querySelector('[data-action=select-all]').click()");
  await waitFor("!document.querySelector('#batch-bar').hidden", 'trash batch bar again');
  await evalInPage("document.querySelector('[data-action=batch-permanent]').click()");
  await waitFor("document.querySelector('#confirm-dialog').open", 'batch permanent confirm');
  await evalInPage("document.querySelector('#confirm-action').click()");
  await waitFor("document.querySelector('.empty-state')", 'trash empty after batch permanent');
  check('批量永久删除生效', true);

  // 设置页：账户信息、存储用量与修改密码
  await evalInPage("document.querySelector('[data-action=settings]').click()");
  await waitFor("document.querySelector('#password-form')", 'settings page');
  check('设置页可达', await evalInPage("document.body.textContent.includes('账户信息')"));
  await waitFor("document.querySelector('#settings-storage-text').textContent.includes('个文件')", 'storage stats');
  check('设置页存储用量已渲染', true);
  await evalInPage("document.querySelector('#current-password').value='cloudirve'; document.querySelector('#new-password').value='cloudirve2'; document.querySelector('#confirm-password').value='cloudirve2'; document.querySelector('#password-form button[type=submit]').click()");
  await waitFor("[...document.querySelectorAll('.toast')].some((el) => el.textContent.includes('密码已更新'))", 'password toast');
  check('修改密码成功反馈', true);
  await evalInPage("document.querySelector('.user-menu [data-action=logout]').click()");
  await waitFor("document.querySelector('#login-form')", 'back to login');
  await evalInPage("document.querySelector('#username').value='demo'; document.querySelector('#password').value='cloudirve2'; document.querySelector('#login-form button[type=submit]').click()");
  await waitFor("document.querySelector('.workspace')", 'relogin with new password');
  check('新密码可重新登录', true);

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
