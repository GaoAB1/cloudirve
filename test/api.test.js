import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function boot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudirve-'));
  const server = createServer({ dataRoot: root });
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
