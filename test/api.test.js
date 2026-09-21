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
