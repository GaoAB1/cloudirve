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
      const known = { AUTH_REQUIRED: [401, '请先登录'], INVALID_CREDENTIALS: [401, '用户名或密码错误'], INVALID_JSON: [400, '请求格式错误'], INVALID_NAME: [400, '名称不合法'], INVALID_PASSWORD: [400, '新密码需为 6-128 位'], INVALID_DAYS: [400, '有效期需为 1-365 天'], DUPLICATE_NAME: [409, '当前目录已存在同名项目'], PARENT_NOT_FOUND: [404, '目标目录不存在'], FILE_NOT_FOUND: [404, '文件不存在或已被删除'], FILE_TOO_LARGE: [413, '文件超过 25 MB 限制'], QUOTA_EXCEEDED: [413, '存储空间不足，请清理后再试'], UPLOAD_REQUIRED: [400, '请选择要上传的文件'], SHARE_NOT_FOUND: [404, '分享不存在或已失效'], SHARE_PASSWORD_REQUIRED: [401, '此分享需要密码'], SHARE_PASSWORD_INVALID: [401, '分享密码错误'] }[error.message];
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
  const shareInfoMatch = url.pathname.match(/^\/api\/share\/([0-9a-f]+)$/);
  const shareFileMatch = url.pathname.match(/^\/api\/share\/([0-9a-f]+)\/file$/);
  if (shareInfoMatch && req.method === 'GET') {
    // 匿名分享端点：无需登录态
    const resolved = store.resolveShare(shareInfoMatch[1]);
    if (!resolved) throw new Error('SHARE_NOT_FOUND');
    const { share, file } = resolved;
    return sendJson(res, 200, { name: file.name, size: file.size, mimeType: file.mimeType, requiresPassword: !!share.passwordHash, expiresAt: share.expiresAt });
  }
  if (shareFileMatch && req.method === 'POST') {
    const raw = await readBody(req, 64 * 1024);
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    const file = store.openShare(shareFileMatch[1], body.password ? String(body.password) : undefined);
    streamFile(res, store, file, body.inline === true);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(req);
    const knownUser = store.data.users.find((item) => item.username === body.username);
    const result = store.authenticate(body.username, body.password);
    if (!result) {
      await store.logActivity(knownUser ? knownUser.id : null, 'login', String(body.username || ''), 'failed');
      throw new Error('INVALID_CREDENTIALS');
    }
    await store.logActivity(result.user.id, 'login', body.username);
    res.setHeader('Set-Cookie', `cloudirve_session=${result.token}; HttpOnly; Path=/; SameSite=Strict`);
    return sendJson(res, 200, { user: result.user, sessionExpiresAt: result.sessionExpiresAt });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = parseCookies(req.headers.cookie).cloudirve_session;
    const user = store.userFromToken(token);
    await store.logout(token);
    if (user) await store.logActivity(user.id, 'logout', user.username);
    res.setHeader('Set-Cookie', 'cloudirve_session=; Max-Age=0; HttpOnly; Path=/; SameSite=Strict');
    return sendJson(res, 200, { ok: true });
  }
  const sessionToken = parseCookies(req.headers.cookie).cloudirve_session;
  const user = store.userFromToken(sessionToken);
  if (req.method === 'GET' && url.pathname === '/api/auth/me') return user ? sendJson(res, 200, { user: { id: user.id, username: user.username }, sessionExpiresAt: store.data.sessions[sessionToken]?.expiresAt || null }) : sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } });
  if (!user) throw new Error('AUTH_REQUIRED');

  if (req.method === 'GET' && url.pathname === '/api/storage') return sendJson(res, 200, store.storageStats(user.id));
  if (req.method === 'GET' && url.pathname === '/api/activity') return sendJson(res, 200, { entries: store.listActivity(user.id) });
  if (req.method === 'PATCH' && url.pathname === '/api/auth/password') {
    const body = await readJson(req);
    await store.changePassword(user.id, body.currentPassword, body.newPassword);
    await store.logActivity(user.id, 'password-change', user.username);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/files') {
    const parentId = url.searchParams.get('parentId') || null;
    return sendJson(res, 200, { files: store.listFiles(user.id, parentId) });
  }
  if (req.method === 'GET' && url.pathname === '/api/files/search') {
    return sendJson(res, 200, { files: store.searchFiles(user.id, url.searchParams.get('q')) });
  }
  if (req.method === 'GET' && url.pathname === '/api/files/breadcrumbs') {
    const ids = (url.searchParams.get('parentId') || '').split(',').filter(Boolean);
    return sendJson(res, 200, { breadcrumbs: ids.map((id) => store.findFile(user.id, id)).filter(Boolean).map(({ id, name }) => ({ id, name })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/files/folders') {
    const body = await readJson(req);
    const file = await store.createFolder(user.id, body.name, body.parentId || null);
    await store.logActivity(user.id, 'folder-create', file.name);
    return sendJson(res, 201, { file });
  }
  if (req.method === 'POST' && url.pathname === '/api/files/upload') {
    const { fields, file } = await readMultipart(req);
    if (!file) throw new Error('UPLOAD_REQUIRED');
    const parentId = fields.parentId || null;
    const created = await store.createFile(user.id, file.filename, parentId, file.data, file.contentType);
    await store.logActivity(user.id, 'upload', created.name);
    return sendJson(res, 201, { file: created });
  }
  const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)(?:\/download)?$/);
  if (fileMatch && req.method === 'PATCH') {
    const body = await readJson(req);
    const renamed = await store.rename(user.id, fileMatch[1], body.name);
    await store.logActivity(user.id, 'rename', renamed.name);
    return sendJson(res, 200, { file: renamed });
  }
  const downloadMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/download$/);
  if (downloadMatch && req.method === 'GET') {
    const file = store.findFile(user.id, downloadMatch[1]);
    if (!file || file.isDirectory) throw new Error('FILE_NOT_FOUND');
    streamFile(res, store, file, url.searchParams.get('inline') === '1');
    return;
  }
  const shareCreateMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/share$/);
  if (shareCreateMatch && req.method === 'POST') {
    const body = await readJson(req);
    const share = await store.createShare(user.id, shareCreateMatch[1], Number(body.days), body.password ? String(body.password) : null);
    const sharedFile = store.findFile(user.id, shareCreateMatch[1]);
    await store.logActivity(user.id, 'share-create', sharedFile ? sharedFile.name : '');
    return sendJson(res, 201, share);
  }
  if (req.method === 'GET' && url.pathname === '/api/shares') return sendJson(res, 200, { shares: store.listShares(user.id) });
  const shareRevokeMatch = url.pathname.match(/^\/api\/shares\/([0-9a-f]+)$/);
  if (shareRevokeMatch && req.method === 'DELETE') {
    await store.revokeShare(user.id, shareRevokeMatch[1]);
    await store.logActivity(user.id, 'share-revoke', shareRevokeMatch[1].slice(0, 8));
    return sendJson(res, 200, { ok: true });
  }
  if (fileMatch && req.method === 'DELETE') {
    const deleted = store.findFile(user.id, fileMatch[1]);
    await store.softDelete(user.id, fileMatch[1]);
    if (deleted) await store.logActivity(user.id, 'delete', deleted.name);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/files/batch-delete') {
    const body = await readJson(req);
    const deleted = await store.softDeleteMany(user.id, body.ids);
    await store.logActivity(user.id, 'batch-delete', `${deleted} 项`);
    return sendJson(res, 200, { deleted });
  }
  if (req.method === 'POST' && url.pathname === '/api/trash/batch-restore') {
    const body = await readJson(req);
    const restored = await store.restoreMany(user.id, body.ids);
    await store.logActivity(user.id, 'batch-restore', `${restored} 项`);
    return sendJson(res, 200, { restored });
  }
  if (req.method === 'POST' && url.pathname === '/api/trash/batch-permanent') {
    const body = await readJson(req);
    const deleted = await store.permanentDeleteMany(user.id, body.ids);
    await store.logActivity(user.id, 'batch-permanent', `${deleted} 项`);
    return sendJson(res, 200, { deleted });
  }
  if (req.method === 'GET' && url.pathname === '/api/trash') return sendJson(res, 200, { files: store.data.files.filter((file) => file.userId === user.id && file.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)), retentionDays: store.trashRetentionDays });
  const restoreMatch = url.pathname.match(/^\/api\/trash\/([^/]+)\/restore$/);
  if (restoreMatch && req.method === 'POST') {
    const file = await store.restore(user.id, restoreMatch[1]);
    await store.logActivity(user.id, 'restore', file.name);
    return sendJson(res, 200, { file });
  }
  const permanentMatch = url.pathname.match(/^\/api\/trash\/([^/]+)\/permanent$/);
  if (permanentMatch && req.method === 'DELETE') {
    await store.permanentDelete(user.id, permanentMatch[1]);
    await store.logActivity(user.id, 'permanent-delete', '选定项目');
    return sendJson(res, 200, { ok: true });
  }
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
  } catch {
    // 无扩展名路径（如 /share/:token）回退到 SPA 入口
    if (req.method === 'GET' && !path.extname(requested)) {
      try {
        const index = await fs.readFile(path.join(publicDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': mimeTypes['.html'], 'Cache-Control': 'no-cache' });
        return res.end(index);
      } catch {}
    }
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } });
  }
}

function parseCookies(value = '') { return Object.fromEntries(value.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key]) => key)); }
const textExtensions = new Set(['txt', 'md', 'json', 'js', 'mjs', 'css', 'csv', 'log', 'xml', 'yml', 'yaml', 'html', 'htm', 'svg', 'sh', 'py', 'ini', 'conf']);
function isTextFile(file) {
  const mime = (file.mimeType || '').toLowerCase();
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript') || mime.includes('xml')) return true;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return textExtensions.has(ext);
}

// 统一的文件内容响应：inline 用于预览（文本截断 200KB + CSP sandbox 防内联脚本），否则 attachment
function streamFile(res, store, file, inline) {
  const headers = { 'Content-Type': file.mimeType || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
  if (inline) {
    headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`;
    headers['Content-Security-Policy'] = 'sandbox';
    if (isTextFile(file)) {
      return fs.readFile(store.pathFor(file)).then((buffer) => {
        const content = buffer.subarray(0, 200 * 1024);
        headers['Content-Length'] = content.length;
        headers['X-Truncated'] = buffer.length > content.length ? '1' : '0';
        res.writeHead(200, headers);
        res.end(content);
      });
    }
  }
  headers['Content-Disposition'] = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`;
  headers['Content-Length'] = file.size;
  res.writeHead(200, headers);
  createReadStream(store.pathFor(file)).pipe(res);
}
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
  const dailyPurge = setInterval(() => { server.store.purgeExpiredTrash().catch((error) => console.error('trash purge failed:', error.message)); }, 24 * 60 * 60 * 1000);
  dailyPurge.unref();
}
