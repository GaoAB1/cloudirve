import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { officeConfigToken, officeFileType, signOfficeToken, verifyOfficeToken } from './office.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const maxUploadBytes = 25 * 1024 * 1024;
const maxOfficeDownloadBytes = 100 * 1024 * 1024;
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createServer({ dataRoot = path.join(__dirname, '..'), officeEnabled = process.env.OFFICE_ENABLED === '1', officeUrl = process.env.OFFICE_URL || 'http://office/', officePublicUrl = process.env.OFFICE_PUBLIC_URL || '', officeCallbackOrigin = process.env.OFFICE_CALLBACK_ORIGIN || '', officeSecret = process.env.OFFICE_JWT_SECRET || '' } = {}) {
  const store = new Store(dataRoot);
  const office = { enabled: officeEnabled && !!officeSecret, url: officeUrl.replace(/\/$/, ''), publicUrl: officePublicUrl.replace(/\/$/, ''), callbackOrigin: officeCallbackOrigin.replace(/\/$/, ''), secret: officeSecret };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) await handleApi(req, res, store, office);
      else await serveStatic(req, res);
    } catch (error) {
      const known = { AUTH_REQUIRED: [401, '请先登录'], AUTH_DISABLED: [403, '账号已被禁用'], FORBIDDEN: [403, '无权限执行此操作'], LAST_ADMIN: [403, '至少需要保留一个可用的管理员'], INVALID_CREDENTIALS: [401, '用户名或密码错误'], INVALID_JSON: [400, '请求格式错误'], INVALID_NAME: [400, '名称不合法'], INVALID_USERNAME: [400, '用户名需为 1-32 位且不含空格'], INVALID_PASSWORD: [400, '密码需为 6-128 位'], INVALID_DAYS: [400, '有效期需为 1-365 天'], DUPLICATE_NAME: [409, '当前目录已存在同名项目'], PARENT_NOT_FOUND: [404, '目标目录不存在'], FILE_NOT_FOUND: [404, '文件不存在或已被删除'], FILE_TOO_LARGE: [413, '文件超过 25 MB 限制'], QUOTA_EXCEEDED: [413, '存储空间不足，请清理后再试'], UPLOAD_REQUIRED: [400, '请选择要上传的文件'], SHARE_NOT_FOUND: [404, '分享不存在或已失效'], SHARE_PASSWORD_REQUIRED: [401, '此分享需要密码'], SHARE_PASSWORD_INVALID: [401, '分享密码错误'], TOTP_INVALID: [401, '验证码或备用码错误'], TOTP_CHALLENGE_INVALID: [401, '验证已过期，请重新登录'], TOTP_ALREADY_ENABLED: [409, '两步验证已开启'], TOTP_SETUP_REQUIRED: [400, '请先开始两步验证设置'], TOTP_NOT_ENABLED: [400, '两步验证尚未开启'], OFFICE_DISABLED: [404, '在线编辑未启用'], OFFICE_UNSUPPORTED: [400, '该文件类型不支持在线编辑'], OFFICE_TOKEN_INVALID: [401, '在线编辑授权无效'], OFFICE_CALLBACK_INVALID: [400, '在线编辑保存回调无效'], OFFICE_DOWNLOAD_FAILED: [502, '在线编辑文件获取失败'] }[error.message];
      if (known) return sendJson(res, known[0], { error: { code: error.message, message: known[1] } });
      console.error(error);
      sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试' } });
    }
  });
  server.store = store;
  return server;
}

async function handleApi(req, res, store, office) {
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
    if (store.data.users.find((item) => item.id === result.user.id)?.disabled) {
      await store.logActivity(result.user.id, 'login', body.username, 'failed');
      throw new Error('AUTH_DISABLED');
    }
    if (result.requiresTotp) return sendJson(res, 200, { needTotp: true, challengeToken: result.challengeToken, user: result.user });
    await store.logActivity(result.user.id, 'login', body.username);
    res.setHeader('Set-Cookie', `cloudirve_session=${result.token}; HttpOnly; Path=/; SameSite=Strict`);
    return sendJson(res, 200, { user: result.user, sessionExpiresAt: result.sessionExpiresAt });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/totp/verify') {
    const body = await readJson(req);
    const result = store.verifyTotpChallenge(body.challengeToken, body.code);
    await store.persist();
    await store.logActivity(result.user.id, 'totp-verify', result.usedBackupCode ? '备用码' : '验证码');
    res.setHeader('Set-Cookie', `cloudirve_session=${result.token}; HttpOnly; Path=/; SameSite=Strict`);
    return sendJson(res, 200, { user: result.user, sessionExpiresAt: result.sessionExpiresAt, usedBackupCode: result.usedBackupCode });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const token = parseCookies(req.headers.cookie).cloudirve_session;
    const user = store.userFromToken(token);
    await store.logout(token);
    if (user) await store.logActivity(user.id, 'logout', user.username);
    res.setHeader('Set-Cookie', 'cloudirve_session=; Max-Age=0; HttpOnly; Path=/; SameSite=Strict');
    return sendJson(res, 200, { ok: true });
  }
  const officeContentMatch = url.pathname.match(/^\/api\/office\/files\/([^/]+)\/content$/);
  if (officeContentMatch && req.method === 'GET') {
    if (!office.enabled) throw new Error('OFFICE_DISABLED');
    const token = url.searchParams.get('token');
    const payload = verifyOfficeToken(token, office.secret, 'office-file');
    if (payload.fileId !== officeContentMatch[1]) throw new Error('OFFICE_TOKEN_INVALID');
    const file = store.findFile(payload.userId, payload.fileId);
    if (!file || file.isDirectory) throw new Error('FILE_NOT_FOUND');
    return streamFile(res, store, file, true);
  }
  const officeCallbackMatch = url.pathname.match(/^\/api\/office\/files\/([^/]+)\/callback$/);
  if (officeCallbackMatch && req.method === 'POST') {
    if (!office.enabled) throw new Error('OFFICE_DISABLED');
    const callbackToken = url.searchParams.get('token');
    const payload = verifyOfficeToken(callbackToken, office.secret, 'office-callback');
    if (payload.fileId !== officeCallbackMatch[1]) throw new Error('OFFICE_TOKEN_INVALID');
    const body = await readJson(req);
    const officeJwt = body.token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!officeJwt) throw new Error('OFFICE_CALLBACK_INVALID');
    verifyOfficeToken(officeJwt, office.secret, 'office-outbox');
    if (Number(body.status) === 2 || Number(body.status) === 6) {
      if (!body.url || !isAllowedOfficeUrl(body.url, office.url)) throw new Error('OFFICE_CALLBACK_INVALID');
      const fetchToken = signOfficeToken({ purpose: 'office-fetch', fileId: payload.fileId }, office.secret, 300);
      const response = await fetch(body.url, { headers: { Authorization: `Bearer ${fetchToken}` } });
      if (!response.ok || !response.body) throw new Error('OFFICE_DOWNLOAD_FAILED');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxOfficeDownloadBytes) throw new Error('FILE_TOO_LARGE');
      const file = store.findFile(payload.userId, payload.fileId);
      if (!file || file.isDirectory) throw new Error('FILE_NOT_FOUND');
      await store.replaceFileContent(file.id, buffer);
      await store.logActivity(payload.userId, 'office-save', file.name);
    }
    return sendJson(res, 200, { error: 0 });
  }

  const sessionToken = parseCookies(req.headers.cookie).cloudirve_session;
  const user = store.userFromToken(sessionToken);
  if (req.method === 'GET' && url.pathname === '/api/auth/me') return user ? sendJson(res, 200, { user: { id: user.id, username: user.username, role: user.role }, sessionExpiresAt: store.data.sessions[sessionToken]?.expiresAt || null }) : sendJson(res, 401, { error: { code: 'AUTH_REQUIRED', message: '请先登录' } });
  if (!user) throw new Error('AUTH_REQUIRED');

  if (req.method === 'GET' && url.pathname === '/api/office/status') return sendJson(res, 200, { enabled: office.enabled, url: office.enabled ? (office.publicUrl || office.url) : null });
  const officeConfigMatch = url.pathname.match(/^\/api\/office\/files\/([^/]+)\/config$/);
  if (officeConfigMatch && req.method === 'GET') {
    if (!office.enabled) throw new Error('OFFICE_DISABLED');
    const file = store.findFile(user.id, officeConfigMatch[1]);
    const type = file && officeFileType(file.name);
    if (!file || file.isDirectory) throw new Error('FILE_NOT_FOUND');
    if (!type) throw new Error('OFFICE_UNSUPPORTED');
    const fileToken = signOfficeToken({ purpose: 'office-file', fileId: file.id, userId: user.id }, office.secret, 10 * 60);
    const callbackToken = signOfficeToken({ purpose: 'office-callback', fileId: file.id, userId: user.id }, office.secret, 30 * 60);
    const config = {
      document: { fileType: type.extension, key: `${file.id}-${new Date(file.updatedAt).getTime()}`, title: file.name, url: `${office.callbackOrigin || originFor(req)}/api/office/files/${file.id}/content?token=${encodeURIComponent(fileToken)}`, permissions: { edit: true, download: true, print: true, copy: true } },
      documentType: type.documentType,
      editorConfig: { callbackUrl: `${office.callbackOrigin || originFor(req)}/api/office/files/${file.id}/callback?token=${encodeURIComponent(callbackToken)}`, mode: 'edit', lang: 'zh-CN', user: { id: user.id, name: user.username } },
      height: '100%',
      type: 'desktop',
      width: '100%',
    };
    config.token = officeConfigToken(config, office.secret);
    return sendJson(res, 200, { config, editorUrl: office.publicUrl || office.url });
  }
  if (url.pathname.startsWith('/api/admin/') && user.role !== 'admin') throw new Error('FORBIDDEN');
  if (req.method === 'GET' && url.pathname === '/api/admin/users') return sendJson(res, 200, { users: store.listUsers() });
  if (req.method === 'POST' && url.pathname === '/api/admin/users') {
    const body = await readJson(req);
    const created = store.createUser(body.username, body.password);
    await store.persist();
    await store.logActivity(user.id, 'user-create', created.username);
    return sendJson(res, 201, { user: created });
  }
  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && req.method === 'PATCH') {
    const body = await readJson(req);
    const updated = store.updateUser(adminUserMatch[1], { disabled: body.disabled, role: body.role, password: body.password }, user.id);
    await store.persist();
    if (body.password !== undefined) await store.logActivity(user.id, 'password-reset', updated.username);
    else if (typeof body.disabled === 'boolean') await store.logActivity(user.id, body.disabled ? 'user-disable' : 'user-enable', updated.username);
    else if (body.role) await store.logActivity(user.id, 'user-role', `${updated.username} → ${updated.role}`);
    return sendJson(res, 200, { user: updated });
  }
  if (adminUserMatch && req.method === 'DELETE') {
    const username = await store.deleteUser(adminUserMatch[1], user.id);
    await store.logActivity(user.id, 'user-delete', username);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/storage') return sendJson(res, 200, store.storageStats(user.id));
  if (req.method === 'GET' && url.pathname === '/api/activity') return sendJson(res, 200, { entries: store.listActivity(user.id) });
  if (req.method === 'GET' && url.pathname === '/api/auth/totp/status') return sendJson(res, 200, store.totpStatus(user.id));
  if (req.method === 'POST' && url.pathname === '/api/auth/totp/setup') {
    const result = store.setupTotp(user.id);
    await store.persist();
    await store.logActivity(user.id, 'totp-setup', '生成验证器配置');
    return sendJson(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/totp/confirm') {
    const body = await readJson(req);
    const result = store.confirmTotp(user.id, body.code);
    await store.persist();
    await store.logActivity(user.id, 'totp-enable', '开启两步验证');
    return sendJson(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/totp/disable') {
    const body = await readJson(req);
    store.disableTotp(user.id, body.code);
    await store.persist();
    await store.logActivity(user.id, 'totp-disable', '关闭两步验证');
    return sendJson(res, 200, { ok: true });
  }
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
function originFor(req) { const protocol = req.headers['x-forwarded-proto'] || 'http'; const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1'; return `${protocol}://${host}`; }
function isAllowedOfficeUrl(value, officeUrl) { try { const url = new URL(value); const base = new URL(officeUrl); return url.protocol === base.protocol && url.host === base.host; } catch { return false; } }
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
