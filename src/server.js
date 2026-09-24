import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const maxUploadBytes = 25 * 1024 * 1024;
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createServer({ dataRoot = path.join(__dirname, '..') } = {}) {
  const store = new Store(dataRoot);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) await handleApi(req, res, store);
      else await serveStatic(req, res);
    } catch (error) {
      const known = { AUTH_REQUIRED: [401, '请先登录'], INVALID_CREDENTIALS: [401, '用户名或密码错误'], INVALID_JSON: [400, '请求格式错误'], INVALID_NAME: [400, '名称不合法'], INVALID_PASSWORD: [400, '新密码需为 6-128 位'], DUPLICATE_NAME: [409, '当前目录已存在同名项目'], PARENT_NOT_FOUND: [404, '目标目录不存在'], FILE_NOT_FOUND: [404, '文件不存在或已被删除'], FILE_TOO_LARGE: [413, '文件超过 25 MB 限制'], QUOTA_EXCEEDED: [413, '存储空间不足，请清理后再试'], UPLOAD_REQUIRED: [400, '请选择要上传的文件'] }[error.message];
      if (known) return sendJson(res, known[0], { error: { code: error.message, message: known[1] } });
      console.error(error);
      sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' } });
    }
  });
  server.store = store;
  return server;
}

async function handleApi(req, res, store) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(req);
    const result = store.authenticate(body.username, body.password);
    if (!result) throw new Error('INVALID_CREDENTIALS');
    res.setHeader('Set-Cookie', `cloudirve_session=${result.token}; HttpOnly; Path=/; SameSite=Strict`);
    return sendJson(res, 200, { user: result.user });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    store.logout(parseCookies(req.headers.cookie).cloudirve_session);
    res.setHeader('Set-Cookie', 'cloudirve_session=; Max-Age=0; HttpOnly; Path=/; SameSite=Strict');
    return sendJson(res, 200, { ok: true });
  }
  const user = store.userFromToken(parseCookies(req.headers.cookie).cloudirve_session);
  if (req.method === 'GET' && url.pathname === '/api/auth/me') return user ? sendJson(res, 200, { user: { id: user.id, username: user.username } }) : sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } });
  if (!user) throw new Error('AUTH_REQUIRED');

  if (req.method === 'GET' && url.pathname === '/api/storage') return sendJson(res, 200, store.storageStats(user.id));
  if (req.method === 'PATCH' && url.pathname === '/api/auth/password') {
    const body = await readJson(req);
    await store.changePassword(user.id, body.currentPassword, body.newPassword);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/files') {
    const parentId = url.searchParams.get('parentId') || null;
    return sendJson(res, 200, { files: store.listFiles(user.id, parentId) });
  }
  if (req.method === 'GET' && url.pathname === '/api/files/breadcrumbs') {
    const ids = (url.searchParams.get('parentId') || '').split(',').filter(Boolean);
    return sendJson(res, 200, { breadcrumbs: ids.map((id) => store.findFile(user.id, id)).filter(Boolean).map(({ id, name }) => ({ id, name })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/files/folders') {
    const body = await readJson(req);
    return sendJson(res, 201, { file: await store.createFolder(user.id, body.name, body.parentId || null) });
  }
  if (req.method === 'POST' && url.pathname === '/api/files/upload') {
    const { fields, file } = await readMultipart(req);
    if (!file) throw new Error('UPLOAD_REQUIRED');
    const parentId = fields.parentId || null;
    return sendJson(res, 201, { file: await store.createFile(user.id, file.filename, parentId, file.data, file.contentType) });
  }
  const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)(?:\/download)?$/);
  if (fileMatch && req.method === 'PATCH') {
    const body = await readJson(req);
    return sendJson(res, 200, { file: await store.rename(user.id, fileMatch[1], body.name) });
  }
  const downloadMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/download$/);
  if (downloadMatch && req.method === 'GET') {
    const file = store.findFile(user.id, downloadMatch[1]);
    if (!file || file.isDirectory) throw new Error('FILE_NOT_FOUND');
    res.writeHead(200, { 'Content-Type': file.mimeType || 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
    return createReadStream(store.pathFor(file)).pipe(res);
  }
  if (fileMatch && req.method === 'DELETE') {
    await store.softDelete(user.id, fileMatch[1]);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/trash') return sendJson(res, 200, { files: store.data.files.filter((file) => file.userId === user.id && file.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)) });
  const restoreMatch = url.pathname.match(/^\/api\/trash\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === 'POST') return sendJson(res, 200, { file: await store.restore(user.id, restoreMatch[1]) });
  const permanentMatch = url.pathname.match(/^\/api\/trash\/([^/]+)\/permanent$/);
  if (permanentMatch && req.method === 'DELETE') { await store.permanentDelete(user.id, permanentMatch[1]); return sendJson(res, 200, { ok: true }); }
  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
}

async function serveStatic(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '禁止访问' } });
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch { sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } }); }
}

function parseCookies(value = '') { return Object.fromEntries(value.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key]) => key)); }
function sendJson(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
async function readJson(req) { try { return JSON.parse(await readBody(req, 1024 * 1024)); } catch { throw new Error('INVALID_JSON'); } }
function readBody(req, limit) { return new Promise((resolve, reject) => { let size = 0; const chunks = []; req.on('data', (chunk) => { size += chunk.length; if (size > limit) { reject(new Error('FILE_TOO_LARGE')); req.destroy(); return; } chunks.push(chunk); }); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); }); }
async function readMultipart(req) {
  const type = req.headers['content-type'] || ''; const match = type.match(/boundary=(?:"([^"]+)"|([^;]+))/i); if (!match) throw new Error('INVALID_JSON');
  const body = Buffer.from(await readBody(req, maxUploadBytes + 1024 * 1024)); const boundary = Buffer.from(`--${match[1] || match[2]}`); const fields = {}; let file = null; let cursor = 0;
  while (true) { const start = body.indexOf(boundary, cursor); if (start < 0) break; const partStart = start + boundary.length + 2; const next = body.indexOf(boundary, partStart); if (next < 0) break; const part = body.subarray(partStart, next - 2); const headerEnd = part.indexOf(Buffer.from('\r\n\r\n')); if (headerEnd < 0) break; const headers = part.subarray(0, headerEnd).toString('utf8'); const data = part.subarray(headerEnd + 4); const disposition = headers.match(/name="([^"]+)"(?:; filename="([^"]*)")?/i); if (disposition) { if (disposition[2] !== undefined) { if (data.length > maxUploadBytes) throw new Error('FILE_TOO_LARGE'); file = { filename: path.basename(disposition[2]), contentType: headers.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] || 'application/octet-stream', data }; } else fields[disposition[1]] = data.toString('utf8'); } cursor = next; }
  return { fields, file };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer();
  await server.store.init();
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Cloudirve running at http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`));
}
