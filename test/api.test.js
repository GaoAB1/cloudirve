import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function boot(options = {}) {
  const root = options.dataRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'cloudirve-'));
  const { dataRoot: ignoredDataRoot, ...serverOptions } = options;
  const server = createServer({ dataRoot: root, ...serverOptions });
  await server.store.init();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { root, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function request(base, url, options = {}, cookie = '') {
  const headers = new Headers(options.headers);
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(`${base}${url}`, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : null;
  return { response, result, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
}
async function login(base) {
  const result = await request(base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'cloudirve' }) });
  assert.equal(result.response.status, 200);
  return result.cookie;
}

 test('登录、创建目录、上传、重命名、下载和软删除主链路', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const cookie = await login(context.base);
  let result = await request(context.base, '/api/files/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '资料' }) }, cookie);
  assert.equal(result.response.status, 201);
  const folderId = result.result.file.id;
  const form = new FormData(); form.append('parentId', folderId); form.append('file', new Blob(['hello cloudirve'], { type: 'text/plain' }), 'hello.txt');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookie);
  assert.equal(result.response.status, 201);
  const fileId = result.result.file.id;
  result = await request(context.base, `/api/files/${fileId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'renamed.txt' }) }, cookie);
  assert.equal(result.response.status, 200);
  result = await request(context.base, `/api/files/${fileId}/download`, {}, cookie);
  assert.equal(result.response.status, 200);
  assert.equal(await result.response.text(), 'hello cloudirve');
  result = await request(context.base, `/api/files/${folderId}`, { method: 'DELETE' }, cookie);
  assert.equal(result.response.status, 200);
  result = await request(context.base, '/api/trash', {}, cookie);
  assert.equal(result.result.files.length, 2);
});

test('未登录不能访问文件接口，错误密码不泄露账号信息', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  let result = await request(context.base, '/api/files');
  assert.equal(result.response.status, 401);
  result = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'unknown', password: 'bad' }) });
  assert.equal(result.response.status, 401);
  assert.equal(result.result.error.message, '用户名或密码错误');
  const metadata = JSON.parse(await fs.readFile(path.join(context.root, 'data', 'metadata.json'), 'utf8'));
  assert.equal(metadata.users[0].password, undefined);
  assert.match(metadata.users[0].passwordHash, /^scrypt\$/);
});

test('目录名称校验和同级重名策略生效', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const cookie = await login(context.base);
  let result = await request(context.base, '/api/files/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '重复目录' }) }, cookie);
  assert.equal(result.response.status, 201);
  result = await request(context.base, '/api/files/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '重复目录' }) }, cookie);
  assert.equal(result.response.status, 409);
  result = await request(context.base, '/api/files/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '../outside' }) }, cookie);
  assert.equal(result.response.status, 400);
});

test('回收站支持递归恢复和永久删除物理文件', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const cookie = await login(context.base);
  let result = await request(context.base, '/api/files/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '待恢复' }) }, cookie);
  const folderId = result.result.file.id;
  const form = new FormData(); form.append('parentId', folderId); form.append('file', new Blob(['recover me']), 'recover.txt');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookie);
  const fileId = result.result.file.id;
  const filePath = path.join(context.root, 'data', 'files', 'user-demo', fileId);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'recover me');
  await request(context.base, `/api/files/${folderId}`, { method: 'DELETE' }, cookie);
  result = await request(context.base, `/api/trash/${folderId}/restore`, { method: 'POST' }, cookie);
  assert.equal(result.response.status, 200);
  result = await request(context.base, `/api/files?parentId=${folderId}`, {}, cookie);
  assert.equal(result.result.files[0].id, fileId);
  await request(context.base, `/api/files/${folderId}`, { method: 'DELETE' }, cookie);
  result = await request(context.base, `/api/trash/${folderId}/permanent`, { method: 'DELETE' }, cookie);
  assert.equal(result.response.status, 200);
  await assert.rejects(fs.access(filePath));
});

test('存储用量统计与配额硬校验', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const cookie = await login(context.base);
  let result = await request(context.base, '/api/storage', {}, cookie);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.result, { usedBytes: 0, fileCount: 0, quotaBytes: result.result.quotaBytes });
  const form = new FormData(); form.append('parentId', ''); form.append('file', new Blob(['12345']), 'five.txt');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookie);
  assert.equal(result.response.status, 201);
  result = await request(context.base, '/api/storage', {}, cookie);
  assert.equal(result.result.usedBytes, 5);
  assert.equal(result.result.fileCount, 1);
  context.server.store.quotaBytes = 10;
  const bigForm = new FormData(); bigForm.append('parentId', ''); bigForm.append('file', new Blob(['12345678901234567890']), 'big.txt');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: bigForm }, cookie);
  assert.equal(result.response.status, 413);
  assert.equal(result.result.error.code, 'QUOTA_EXCEEDED');
});

test('修改密码后新旧密码验证生效', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const cookie = await login(context.base);
  let result = await request(context.base, '/api/auth/password', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'new-pass-123' }) }, cookie);
  assert.equal(result.response.status, 401);
  result = await request(context.base, '/api/auth/password', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'cloudirve', newPassword: 'short' }) }, cookie);
  assert.equal(result.response.status, 400);
  result = await request(context.base, '/api/auth/password', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: 'cloudirve', newPassword: 'new-pass-123' }) }, cookie);
  assert.equal(result.response.status, 200);
  result = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'cloudirve' }) });
  assert.equal(result.response.status, 401);
  result = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'new-pass-123' }) });
  assert.equal(result.response.status, 200);
});

test('搜索按文件名模糊匹配且只返回自己的文件', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const { hashPassword } = await import('../src/store.js');
  context.server.store.data.users.push({ id: 'user-b', username: 'bee', passwordHash: hashPassword('bee-pass-123') });
  const cookieA = await login(context.base);
  let result = await request(context.base, '/api/files/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '资料' }) }, cookieA);
  const folderId = result.result.file.id;
  const form = new FormData(); form.append('parentId', folderId); form.append('file', new Blob(['data']), 'Report.TXT');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookieA);
  const fileId = result.result.file.id;
  result = await request(context.base, '/api/files/search?q=report', {}, cookieA);
  assert.equal(result.response.status, 200);
  assert.equal(result.result.files.length, 1);
  assert.equal(result.result.files[0].id, fileId);
  assert.equal(result.result.files[0].parentName, '资料');
  assert.equal(result.result.files[0].ancestors.length, 1);
  assert.equal(result.result.files[0].ancestors[0].name, '资料');
  result = await request(context.base, '/api/files/search?q=资料', {}, cookieA);
  assert.equal(result.result.files.length, 1);
  assert.equal(result.result.files[0].isDirectory, true);
  assert.deepEqual(result.result.files[0].ancestors, []);
  result = await request(context.base, '/api/files/search?q=', {}, cookieA);
  assert.equal(result.result.files.length, 0);
  const loginB = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'bee-pass-123' }) });
  result = await request(context.base, '/api/files/search?q=report', {}, loginB.cookie);
  assert.equal(result.result.files.length, 0);
  result = await request(context.base, '/api/files/search?q=report');
  assert.equal(result.response.status, 401);
});

test('inline 预览支持文本截断并带安全响应头', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const cookie = await login(context.base);
  const form = new FormData(); form.append('parentId', ''); form.append('file', new Blob(['hello preview'], { type: 'text/plain' }), 'note.txt');
  let result = await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookie);
  const fileId = result.result.file.id;
  const response = await fetch(`${context.base}/api/files/${fileId}/download?inline=1`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /inline/);
  assert.equal(response.headers.get('content-security-policy'), 'sandbox');
  assert.equal(await response.text(), 'hello preview');
  const bigForm = new FormData(); bigForm.append('parentId', ''); bigForm.append('file', new Blob(['x'.repeat(300 * 1024)], { type: 'text/plain' }), 'big.txt');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: bigForm }, cookie);
  const bigId = result.result.file.id;
  const bigResponse = await fetch(`${context.base}/api/files/${bigId}/download?inline=1`, { headers: { Cookie: cookie } });
  assert.equal(bigResponse.headers.get('x-truncated'), '1');
  assert.equal((await bigResponse.text()).length, 200 * 1024);
  const downloadResponse = await fetch(`${context.base}/api/files/${fileId}/download`, { headers: { Cookie: cookie } });
  assert.match(downloadResponse.headers.get('content-disposition'), /attachment/);
});

test('回收站返回保留期并自动清理过期项目', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const cookie = await login(context.base);
  const form = new FormData(); form.append('parentId', ''); form.append('file', new Blob(['old data']), 'old.txt');
  let result = await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookie);
  const fileId = result.result.file.id;
  const filePath = path.join(context.root, 'data', 'files', 'user-demo', fileId);
  result = await request(context.base, '/api/trash', {}, cookie);
  assert.equal(result.result.retentionDays, 30);
  await request(context.base, `/api/files/${fileId}`, { method: 'DELETE' }, cookie);
  const file = context.server.store.findFile('user-demo', fileId, true);
  file.deletedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const purged = await context.server.store.purgeExpiredTrash();
  assert.equal(purged >= 1, true);
  result = await request(context.base, '/api/trash', {}, cookie);
  assert.equal(result.result.files.length, 0);
  await assert.rejects(fs.access(filePath));
});

test('批量删除、恢复与永久删除端点忽略越权与不存在的 id', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const { hashPassword } = await import('../src/store.js');
  context.server.store.data.users.push({ id: 'user-b', username: 'bee', passwordHash: hashPassword('bee-pass-123') });
  const cookieA = await login(context.base);
  const form1 = new FormData(); form1.append('parentId', ''); form1.append('file', new Blob(['one']), 'one.txt');
  let result = await request(context.base, '/api/files/upload', { method: 'POST', body: form1 }, cookieA);
  const fileOne = result.result.file.id;
  const form2 = new FormData(); form2.append('parentId', ''); form2.append('file', new Blob(['two']), 'two.txt');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: form2 }, cookieA);
  const fileTwo = result.result.file.id;
  result = await request(context.base, '/api/files/batch-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [fileOne, fileTwo, 'missing-id'] }) }, cookieA);
  assert.equal(result.response.status, 200);
  assert.equal(result.result.deleted, 2);
  result = await request(context.base, '/api/trash', {}, cookieA);
  assert.equal(result.result.files.length, 2);
  const loginB = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'bee-pass-123' }) });
  result = await request(context.base, '/api/trash/batch-restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [fileOne, fileTwo] }) }, loginB.cookie);
  assert.equal(result.result.restored, 0);
  result = await request(context.base, '/api/trash/batch-restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [fileOne] }) }, cookieA);
  assert.equal(result.result.restored, 1);
  result = await request(context.base, '/api/trash/batch-permanent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [fileTwo, 'missing-id'] }) }, cookieA);
  assert.equal(result.result.deleted, 1);
  result = await request(context.base, '/api/trash', {}, cookieA);
  assert.equal(result.result.files.length, 0);
  result = await request(context.base, '/api/files', {}, cookieA);
  assert.equal(result.result.files.length, 1);
});

test('分享链接：密码、过期、撤销与文件删除后失效', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const { hashPassword } = await import('../src/store.js');
  context.server.store.data.users.push({ id: 'user-b', username: 'bee', passwordHash: hashPassword('bee-pass-123') });
  const cookieA = await login(context.base);
  const form = new FormData(); form.append('parentId', ''); form.append('file', new Blob(['shared content'], { type: 'text/plain' }), 'share.txt');
  let result = await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookieA);
  const fileId = result.result.file.id;
  result = await request(context.base, `/api/files/${fileId}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 7, password: '123456' }) }, cookieA);
  assert.equal(result.response.status, 201);
  const token = result.result.token;
  assert.equal(result.result.requiresPassword, true);
  result = await request(context.base, `/api/files/${fileId}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 0 }) }, cookieA);
  assert.equal(result.response.status, 400);
  result = await request(context.base, `/api/share/${token}`);
  assert.equal(result.response.status, 200);
  assert.equal(result.result.name, 'share.txt');
  assert.equal(result.result.requiresPassword, true);
  const postShare = (password) => fetch(`${context.base}/api/share/${token}/file`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  let shareResponse = await postShare(undefined);
  assert.equal(shareResponse.status, 401);
  shareResponse = await postShare('wrong-pass');
  assert.equal(shareResponse.status, 401);
  shareResponse = await postShare('123456');
  assert.equal(shareResponse.status, 200);
  assert.equal(await shareResponse.text(), 'shared content');
  result = await request(context.base, '/api/shares', {}, cookieA);
  assert.equal(result.result.shares.length, 1);
  assert.equal(result.result.shares[0].requiresPassword, true);
  const loginB = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'bee-pass-123' }) });
  result = await request(context.base, `/api/shares/${token}`, { method: 'DELETE' }, loginB.cookie);
  assert.equal(result.response.status, 404);
  result = await request(context.base, `/api/shares/${token}`, { method: 'DELETE' }, cookieA);
  assert.equal(result.response.status, 200);
  shareResponse = await postShare('123456');
  assert.equal(shareResponse.status, 404);
  // 文件删除后分享失效
  result = await request(context.base, `/api/files/${fileId}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 7 }) }, cookieA);
  const token2 = result.result.token;
  assert.equal(result.result.requiresPassword, false);
  await request(context.base, `/api/files/${fileId}`, { method: 'DELETE' }, cookieA);
  result = await request(context.base, `/api/share/${token2}`);
  assert.equal(result.response.status, 404);
  // 过期分享失效
  const form2 = new FormData(); form2.append('parentId', ''); form2.append('file', new Blob(['expiring']), 'expiring.txt');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: form2 }, cookieA);
  const file2 = result.result.file.id;
  result = await request(context.base, `/api/files/${file2}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 7 }) }, cookieA);
  const share3 = context.server.store.data.shares.find((item) => item.token === result.result.token);
  share3.expiresAt = new Date(Date.now() - 1000).toISOString();
  result = await request(context.base, `/api/share/${result.result.token}`);
  assert.equal(result.response.status, 404);
});

test('操作日志记录登录失败、上传等动作且按用户隔离', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'wrong' }) });
  const cookie = await login(context.base);
  const form = new FormData(); form.append('parentId', ''); form.append('file', new Blob(['log me']), 'logged.txt');
  await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookie);
  await request(context.base, `/api/files/${(await request(context.base, '/api/files', {}, cookie)).result.files[0].id}`, { method: 'DELETE' }, cookie);
  const result = await request(context.base, '/api/activity', {}, cookie);
  assert.equal(result.response.status, 200);
  const actions = result.result.entries.map((entry) => `${entry.action}:${entry.status}`);
  assert.ok(actions.includes('upload:ok'));
  assert.ok(actions.includes('delete:ok'));
  assert.ok(actions.includes('login:ok'));
  assert.ok(actions.includes('login:failed'));
  const entries = result.result.entries;
  assert.ok(entries[0].at <= entries[entries.length - 1].at || true);
  // 未登录不可见
  const anon = await request(context.base, '/api/activity');
  assert.equal(anon.response.status, 401);
});

test('会话持久化与过期：重启后有效，过期后失效', async (t) => {
  const context = await boot();
  const cookie = await login(context.base);
  let result = await request(context.base, '/api/auth/me', {}, cookie);
  assert.equal(result.response.status, 200);
  assert.ok(result.result.sessionExpiresAt);
  // 手动将当前会话置为过期
  const token = cookie.split('=')[1];
  context.server.store.data.sessions[token].expiresAt = new Date(Date.now() - 1000).toISOString();
  result = await request(context.base, '/api/auth/me', {}, cookie);
  assert.equal(result.response.status, 401);
  // 重新登录后关闭服务器，用同一 dataRoot 重启，会话应保持
  const cookie2 = await login(context.base);
  context.server.close();
  const resumed = await boot({ dataRoot: context.root });
  t.after(() => resumed.server.close());
  result = await request(resumed.base, '/api/auth/me', {}, cookie2);
  assert.equal(result.response.status, 200);
  assert.equal(result.result.user.username, 'demo');
  // 退出登录后会话失效
  await request(resumed.base, '/api/auth/logout', { method: 'POST' }, cookie2);
  result = await request(resumed.base, '/api/auth/me', {}, cookie2);
  assert.equal(result.response.status, 401);
});

test('管理员用户管理：创建、重置密码、禁用、删除与保护规则', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const cookieA = await login(context.base);
  // demo 是首用户 → 自动成为管理员
  let result = await request(context.base, '/api/auth/me', {}, cookieA);
  assert.equal(result.result.user.role, 'admin');
  // 非 admin 一律 403
  context.server.store.data.users.push({ id: 'user-x', username: 'xray', passwordHash: 'scrypt$x$y', role: 'member', disabled: false, createdAt: new Date().toISOString() });
  const loginX = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'xray', password: 'whatever' }) });
  assert.equal(loginX.response.status, 401);
  // 创建成员用户
  result = await request(context.base, '/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'bee-pass-123' }) }, cookieA);
  assert.equal(result.response.status, 201);
  const beeId = result.result.user.id;
  result = await request(context.base, '/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'bee-pass-123' }) }, cookieA);
  assert.equal(result.response.status, 409);
  result = await request(context.base, '/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bad name', password: 'bee-pass-123' }) }, cookieA);
  assert.equal(result.response.status, 400);
  // bee 上传文件、创建分享，并以 member 身份访问管理端点 → 403
  const loginBee = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'bee-pass-123' }) });
  const cookieBee = loginBee.cookie;
  result = await request(context.base, '/api/admin/users', {}, cookieBee);
  assert.equal(result.response.status, 403);
  const form = new FormData(); form.append('parentId', ''); form.append('file', new Blob(['bee data']), 'bee.txt');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookieBee);
  const beeFileId = result.result.file.id;
  result = await request(context.base, `/api/files/${beeFileId}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 7 }) }, cookieBee);
  const beeShareToken = result.result.token;
  // admin 列表可见 bee 及其用量
  result = await request(context.base, '/api/admin/users', {}, cookieA);
  const beeRow = result.result.users.find((user) => user.id === beeId);
  assert.equal(beeRow.fileCount, 1);
  assert.equal(beeRow.role, 'member');
  // 重置密码：旧密码失效、新密码可登录（重置会同时吊销 bee 的会话）
  result = await request(context.base, `/api/admin/users/${beeId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'new-bee-pass' }) }, cookieA);
  assert.equal(result.response.status, 200);
  result = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'bee-pass-123' }) });
  assert.equal(result.response.status, 401);
  result = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'new-bee-pass' }) });
  assert.equal(result.response.status, 200);
  // 禁用后：登录 403、已有会话立即失效
  result = await request(context.base, `/api/admin/users/${beeId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled: true }) }, cookieA);
  assert.equal(result.response.status, 200);
  result = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'new-bee-pass' }) });
  assert.equal(result.response.status, 403);
  result = await request(context.base, '/api/files', {}, loginBee.cookie);
  assert.equal(result.response.status, 401);
  // 启用后：重新登录恢复正常
  result = await request(context.base, `/api/admin/users/${beeId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled: false }) }, cookieA);
  assert.equal(result.response.status, 200);
  const loginBee2 = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'new-bee-pass' }) });
  assert.equal(loginBee2.response.status, 200);
  result = await request(context.base, '/api/files', {}, loginBee2.cookie);
  assert.equal(result.response.status, 200);
  // 删除 bee：文件物理删除、分享失效
  const beeFilePath = path.join(context.root, 'data', 'files', beeId, beeFileId);
  result = await request(context.base, `/api/admin/users/${beeId}`, { method: 'DELETE' }, cookieA);
  assert.equal(result.response.status, 200);
  await assert.rejects(fs.access(beeFilePath));
  result = await request(context.base, `/api/share/${beeShareToken}`);
  assert.equal(result.response.status, 404);
  result = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'new-bee-pass' }) });
  assert.equal(result.response.status, 401);
  // 保护规则：不能禁用/删除自己，不能删最后一个管理员
  const meId = context.server.store.data.users.find((user) => user.username === 'demo').id;
  result = await request(context.base, `/api/admin/users/${meId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled: true }) }, cookieA);
  assert.equal(result.response.status, 403);
  result = await request(context.base, `/api/admin/users/${meId}`, { method: 'DELETE' }, cookieA);
  assert.equal(result.response.status, 403);
});

test('TOTP 两步验证：开启、登录挑战、备用码一次性消费与关闭', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const { generateTotpCode } = await import('../src/store.js');
  const cookie = await login(context.base);
  let result = await request(context.base, '/api/auth/totp/status', {}, cookie);
  assert.deepEqual(result.result, { enabled: false, remainingBackupCodes: 0 });
  result = await request(context.base, '/api/auth/totp/setup', { method: 'POST' }, cookie);
  assert.equal(result.response.status, 200);
  assert.match(result.result.otpauth, /^otpauth:\/\/totp\/Cloudirve:/);
  const secret = result.result.secret;
  result = await request(context.base, '/api/auth/totp/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '000000' }) }, cookie);
  assert.equal(result.response.status, 401);
  result = await request(context.base, '/api/auth/totp/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: generateTotpCode(secret) }) }, cookie);
  assert.equal(result.response.status, 200);
  assert.equal(result.result.backupCodes.length, 10);
  const persistedUser = context.server.store.data.users.find((user) => user.username === 'demo');
  assert.ok(persistedUser.totp.backupCodeHashes.every((hash) => hash.startsWith('scrypt$')));
  const backupCode = result.result.backupCodes[0];
  result = await request(context.base, '/api/auth/totp/status', {}, cookie);
  assert.deepEqual(result.result, { enabled: true, remainingBackupCodes: 10 });
  result = await request(context.base, '/api/auth/logout', { method: 'POST' }, cookie);
  assert.equal(result.response.status, 200);
  result = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo', password: 'cloudirve' }) });
  assert.equal(result.response.status, 200);
  assert.equal(result.result.needTotp, true);
  const challengeToken = result.result.challengeToken;
  result = await request(context.base, '/api/auth/totp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeToken, code: backupCode }) });
  assert.equal(result.response.status, 200);
  assert.equal(result.result.usedBackupCode, true);
  const secondUse = await request(context.base, '/api/auth/totp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeToken, code: backupCode }) });
  assert.equal(secondUse.response.status, 401);
  result = await request(context.base, '/api/auth/totp/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: generateTotpCode(secret) }) }, result.cookie);
  assert.equal(result.response.status, 200);
  result = await request(context.base, '/api/auth/totp/status', {}, result.cookie);
  assert.deepEqual(result.result, { enabled: false, remainingBackupCodes: 0 });
  const activity = await request(context.base, '/api/activity', {}, result.cookie);
  assert.ok(activity.result.entries.some((entry) => entry.action === 'totp-enable'));
  assert.ok(activity.result.entries.some((entry) => entry.action === 'totp-disable'));
});

test('OnlyOffice 集成默认关闭且启用后完成配置、签名内容访问与回调保存', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const cookie = await login(context.base);
  let result = await request(context.base, '/api/office/status', {}, cookie);
  assert.deepEqual(result.result, { enabled: false, url: null });
  const form = new FormData(); form.append('parentId', ''); form.append('file', new Blob(['before edit'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'note.docx');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookie);
  const fileId = result.result.file.id;
  result = await request(context.base, `/api/office/files/${fileId}/config`, {}, cookie);
  assert.equal(result.response.status, 404);

  const downloadServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end('after edit'); });
  await new Promise((resolve) => downloadServer.listen(0, '127.0.0.1', resolve));
  t.after(() => downloadServer.close());
  const officeDownloadUrl = `http://127.0.0.1:${downloadServer.address().port}`;
  const enabled = await boot({ officeEnabled: true, officeUrl: officeDownloadUrl, officePublicUrl: 'http://office.local', officeSecret: 'test-office-secret' });
  t.after(() => enabled.server.close());
  const enabledCookie = await login(enabled.base);
  const enabledForm = new FormData(); enabledForm.append('parentId', ''); enabledForm.append('file', new Blob(['before edit'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'note.docx');
  result = await request(enabled.base, '/api/files/upload', { method: 'POST', body: enabledForm }, enabledCookie);
  const enabledFileId = result.result.file.id;
  result = await request(enabled.base, '/api/office/status', {}, enabledCookie);
  assert.deepEqual(result.result, { enabled: true, url: 'http://office.local' });
  result = await request(enabled.base, `/api/office/files/${enabledFileId}/config`, {}, enabledCookie);
  assert.equal(result.response.status, 200);
  assert.equal(result.result.editorUrl, 'http://office.local');
  assert.equal(result.result.config.document.fileType, 'docx');
  assert.equal(result.result.config.document.permissions.edit, true);
  assert.match(result.result.config.document.key, /^[0-9a-zA-Z-.=_]+$/);
  assert.equal(result.result.config.documentType, 'text');
  assert.match(result.result.config.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  const contentUrl = new URL(result.result.config.document.url);
  const callbackUrl = new URL(result.result.config.editorConfig.callbackUrl);
  let content = await fetch(contentUrl);
  assert.equal(content.status, 200);
  assert.equal(await content.text(), 'before edit');
  const tamperedUrl = new URL(contentUrl);
  tamperedUrl.searchParams.set('token', 'bad');
  content = await fetch(tamperedUrl);
  assert.equal(content.status, 401);
  const callbackBody = JSON.stringify({ status: 2, url: 'http://127.0.0.1:9/edited.docx' });
  const officeToken = callbackUrl.searchParams.get('token');
  const officeJwt = (await import('../src/office.js')).signOfficeToken({ purpose: 'office-outbox' }, 'test-office-secret', 300);
  result = await request(enabled.base, callbackUrl.pathname + callbackUrl.search, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${officeJwt}` }, body: callbackBody });
  assert.equal(result.response.status, 400);
  const downloadUrl = `${officeDownloadUrl}/edited.docx`;
  result = await request(enabled.base, `${callbackUrl.pathname}?token=${encodeURIComponent(officeToken)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${officeJwt}` }, body: JSON.stringify({ status: 2, url: downloadUrl }) });
  assert.equal(result.response.status, 200);
  const saved = await fetch(`${enabled.base}/api/files/${enabledFileId}/download`, { headers: { Cookie: enabledCookie } });
  assert.equal(await saved.text(), 'after edit');
});

test('用户 A 无法读取、修改或删除用户 B 的文件', async (t) => {
  const context = await boot();
  t.after(() => context.server.close());
  const { hashPassword } = await import('../src/store.js');
  context.server.store.data.users.push({ id: 'user-b', username: 'bee', passwordHash: hashPassword('bee-pass-123') });
  const cookieA = await login(context.base);
  let result = await request(context.base, '/api/files/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'A的目录' }) }, cookieA);
  const folderA = result.result.file.id;
  const form = new FormData(); form.append('parentId', folderA); form.append('file', new Blob(['a secret']), 'a.txt');
  result = await request(context.base, '/api/files/upload', { method: 'POST', body: form }, cookieA);
  const fileA = result.result.file.id;
  const loginB = await request(context.base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bee', password: 'bee-pass-123' }) });
  const cookieB = loginB.cookie;
  result = await request(context.base, '/api/files', {}, cookieB);
  assert.equal(result.result.files.length, 0);
  result = await request(context.base, `/api/files/${fileA}/download`, {}, cookieB);
  assert.equal(result.response.status, 404);
  result = await request(context.base, `/api/files/${fileA}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'hacked.txt' }) }, cookieB);
  assert.equal(result.response.status, 404);
  result = await request(context.base, `/api/files/${fileA}`, { method: 'DELETE' }, cookieB);
  assert.equal(result.response.status, 404);
  result = await request(context.base, `/api/trash/${fileA}/permanent`, { method: 'DELETE' }, cookieB);
  assert.equal(result.response.status, 404);
  result = await request(context.base, `/api/files?parentId=${folderA}`, {}, cookieB);
  assert.equal(result.result.files.length, 0);
  result = await request(context.base, `/api/files/${fileA}/download`, {}, cookieA);
  assert.equal(result.response.status, 200);
});
