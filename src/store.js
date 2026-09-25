import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_USER = {
  id: 'user-demo',
  username: 'demo',
  passwordHash: hashPassword('cloudirve'),
};

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

function verifyPassword(password, encoded) {
  const [, salt, expected] = String(encoded || '').split('$');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value) {
  const normalized = String(value || '').toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let current = 0;
  const output = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('INVALID_TOTP_SECRET');
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function totpCode(secret, counter) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1_000_000).padStart(6, '0');
}

function normalizeTotpCode(code) {
  return String(code || '').trim().replace(/\s+/g, '');
}

function verifyTotpCode(secret, code, now = Date.now()) {
  const normalized = normalizeTotpCode(code);
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(now / 1000 / 30);
  for (const offset of [-1, 0, 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, counter + offset)), Buffer.from(normalized))) return true;
  }
  return false;
}

function generateBackupCodes() {
  return Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase());
}

function hashBackupCode(code) {
  return hashPassword(String(code));
}

export function createTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function verifyTotp(secret, code, now) {
  return verifyTotpCode(secret, code, now);
}

export function generateTotpCode(secret, now = Date.now()) {
  return totpCode(secret, Math.floor(now / 1000 / 30));
}

export class Store {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.dataDir = path.join(rootDir, 'data');
    this.filesDir = path.join(this.dataDir, 'files');
    this.metaPath = path.join(this.dataDir, 'metadata.json');
    this.data = { users: [], files: [] };
    this.quotaBytes = Number(process.env.STORAGE_QUOTA_BYTES || 1024 * 1024 * 1024);
    this.trashRetentionDays = Number(process.env.TRASH_RETENTION_DAYS || 30);
    this.sessionTtlDays = Number(process.env.SESSION_TTL_DAYS || 30);
    this.activityLogLimit = Number(process.env.ACTIVITY_LOG_LIMIT || 500);
  }

  async init() {
    await fs.mkdir(this.filesDir, { recursive: true });
    try {
      this.data = JSON.parse(await fs.readFile(this.metaPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = { users: [{ ...DEFAULT_USER }], files: [] };
      await this.persist();
    }
    if (!this.data.users?.length) {
      this.data.users = [{ ...DEFAULT_USER }];
      await this.persist();
    }
    if (!Array.isArray(this.data.shares)) this.data.shares = [];
    if (!this.data.sessions || typeof this.data.sessions !== 'object') this.data.sessions = {};
    if (!Array.isArray(this.data.activityLog)) this.data.activityLog = [];
    if (!this.totpChallenges) this.totpChallenges = new Map();
    if (!this.data.users.some((user) => user.role === 'admin')) this.data.users[0].role = 'admin';
    for (const user of this.data.users) {
      if (!user.role) user.role = 'member';
      if (user.disabled === undefined) user.disabled = false;
      if (!user.createdAt) user.createdAt = new Date().toISOString();
    }
    let migrated = false;
    for (const user of this.data.users) {
      if (user.password && !user.passwordHash) {
        user.passwordHash = hashPassword(user.password);
        delete user.password;
        migrated = true;
      }
    }
    if (migrated) await this.persist();
    await this.purgeExpiredTrash();
    if (this.purgeExpiredSessions()) await this.persist();
  }

  async purgeExpiredTrash() {
    this.purgeExpiredSessions();
    const cutoff = Date.now() - this.trashRetentionDays * 24 * 60 * 60 * 1000;
    const expired = this.data.files.filter((file) => file.deletedAt && new Date(file.deletedAt).getTime() <= cutoff);
    if (!expired.length) return 0;
    const ids = new Set(expired.map((file) => file.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of this.data.files) {
        if (child.parentId && ids.has(child.parentId) && !ids.has(child.id)) { ids.add(child.id); changed = true; }
      }
    }
    for (const item of this.data.files) {
      if (ids.has(item.id) && !item.isDirectory) await fs.rm(this.pathFor(item), { force: true });
    }
    this.data.files = this.data.files.filter((file) => !ids.has(file.id));
    await this.persist();
    return ids.size;
  }

  async persist() {
    await fs.writeFile(this.metaPath, JSON.stringify(this.data, null, 2));
  }

  authenticate(username, password) {
    const user = this.data.users.find((item) => item.username === username && verifyPassword(password, item.passwordHash));
    if (!user) return null;
    if (user.totp?.enabled) {
      const challengeToken = crypto.randomBytes(24).toString('hex');
      this.totpChallenges.set(challengeToken, { userId: user.id, expiresAt: Date.now() + 5 * 60 * 1000 });
      return { requiresTotp: true, challengeToken, user: { id: user.id, username: user.username, role: user.role } };
    }
    return this.createSession(user);
  }

  createSession(user) {
    const token = crypto.randomBytes(24).toString('hex');
    this.data.sessions[token] = { userId: user.id, expiresAt: new Date(Date.now() + this.sessionTtlDays * 24 * 60 * 60 * 1000).toISOString() };
    return { token, user: { id: user.id, username: user.username, role: user.role }, sessionExpiresAt: this.data.sessions[token].expiresAt };
  }

  verifyTotpChallenge(challengeToken, code) {
    const challenge = this.totpChallenges.get(challengeToken);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      this.totpChallenges.delete(challengeToken);
      throw new Error('TOTP_CHALLENGE_INVALID');
    }
    const user = this.data.users.find((item) => item.id === challenge.userId);
    if (!user || user.disabled || !user.totp?.enabled) throw new Error('INVALID_CREDENTIALS');
    let valid = verifyTotpCode(user.totp.secret, code);
    let backupIndex = -1;
    if (!valid) {
      backupIndex = (user.totp.backupCodeHashes || []).findIndex((hash) => verifyPassword(normalizeTotpCode(code).toUpperCase(), hash));
      valid = backupIndex >= 0;
    }
    if (!valid) throw new Error('TOTP_INVALID');
    if (backupIndex >= 0) user.totp.backupCodeHashes.splice(backupIndex, 1);
    this.totpChallenges.delete(challengeToken);
    return { ...this.createSession(user), usedBackupCode: backupIndex >= 0 };
  }

  setupTotp(userId) {
    const user = this.data.users.find((item) => item.id === userId);
    if (!user) throw new Error('AUTH_REQUIRED');
    if (user.totp?.enabled) throw new Error('TOTP_ALREADY_ENABLED');
    const secret = createTotpSecret();
    user.totp = { secret, enabled: false, confirmed: false, backupCodeHashes: [] };
    return { secret, otpauth: `otpauth://totp/Cloudirve:${encodeURIComponent(user.username)}?secret=${secret}&issuer=Cloudirve` };
  }

  confirmTotp(userId, code) {
    const user = this.data.users.find((item) => item.id === userId);
    if (!user?.totp?.secret || user.totp.enabled) throw new Error('TOTP_SETUP_REQUIRED');
    if (!verifyTotpCode(user.totp.secret, code)) throw new Error('TOTP_INVALID');
    const backupCodes = generateBackupCodes();
    user.totp.enabled = true;
    user.totp.confirmed = true;
    user.totp.backupCodeHashes = backupCodes.map(hashBackupCode);
    return { backupCodes };
  }

  disableTotp(userId, code) {
    const user = this.data.users.find((item) => item.id === userId);
    if (!user?.totp?.enabled) throw new Error('TOTP_NOT_ENABLED');
    if (!verifyTotpCode(user.totp.secret, code)) throw new Error('TOTP_INVALID');
    delete user.totp;
  }

  totpStatus(userId) {
    const user = this.data.users.find((item) => item.id === userId);
    return { enabled: !!user?.totp?.enabled, remainingBackupCodes: user?.totp?.backupCodeHashes?.length || 0 };
  }

  userFromToken(token) {
    const session = token ? this.data.sessions[token] : null;
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      delete this.data.sessions[token];
      return null;
    }
    const user = this.data.users.find((item) => item.id === session.userId) || null;
    if (user && user.disabled) return null;
    return user;
  }

  logout(token) {
    delete this.data.sessions[token];
    return this.persist();
  }

  logActivity(userId, action, detail = '', status = 'ok') {
    this.data.activityLog.unshift({ id: crypto.randomUUID(), userId, action, detail: String(detail).slice(0, 200), status, at: new Date().toISOString() });
    if (this.data.activityLog.length > this.activityLogLimit) this.data.activityLog.length = this.activityLogLimit;
    return this.persist();
  }

  listActivity(userId) {
    return this.data.activityLog.filter((entry) => entry.userId === userId).slice(0, 100);
  }

  validateUsername(username) {
    if (typeof username !== 'string' || !username.trim() || username.length > 32 || /\s/.test(username)) throw new Error('INVALID_USERNAME');
  }

  createUser(username, password) {
    this.validateUsername(username);
    if (typeof password !== 'string' || password.length < 6 || password.length > 128) throw new Error('INVALID_PASSWORD');
    if (this.data.users.some((item) => item.username === username)) throw new Error('DUPLICATE_NAME');
    const user = { id: crypto.randomUUID(), username, passwordHash: hashPassword(password), role: 'member', disabled: false, createdAt: new Date().toISOString() };
    this.data.users.push(user);
    return { id: user.id, username: user.username, role: user.role, disabled: user.disabled, createdAt: user.createdAt };
  }

  adminCount() {
    return this.data.users.filter((user) => user.role === 'admin' && !user.disabled).length;
  }

  updateUser(userId, patch = {}, actorId = null) {
    const user = this.data.users.find((item) => item.id === userId);
    if (!user) throw new Error('FILE_NOT_FOUND');
    if (typeof patch.disabled === 'boolean' || patch.role) {
      if (actorId === userId) throw new Error('FORBIDDEN');
      if ((patch.disabled === true || patch.role === 'member') && user.role === 'admin' && this.adminCount() <= 1) throw new Error('LAST_ADMIN');
    }
    if (typeof patch.disabled === 'boolean') user.disabled = patch.disabled;
    if (patch.role === 'admin' || patch.role === 'member') user.role = patch.role;
    if (patch.password !== undefined) {
      if (typeof patch.password !== 'string' || patch.password.length < 6 || patch.password.length > 128) throw new Error('INVALID_PASSWORD');
      user.passwordHash = hashPassword(patch.password);
      for (const [token, session] of Object.entries(this.data.sessions)) {
        if (session.userId === userId) delete this.data.sessions[token];
      }
    }
    return { id: user.id, username: user.username, role: user.role, disabled: user.disabled, createdAt: user.createdAt };
  }

  async deleteUser(userId, actorId = null) {
    if (userId === actorId) throw new Error('FORBIDDEN');
    const user = this.data.users.find((item) => item.id === userId);
    if (!user) throw new Error('FILE_NOT_FOUND');
    if (user.role === 'admin' && this.adminCount() <= 1) throw new Error('LAST_ADMIN');
    for (const item of this.data.files.filter((file) => file.userId === userId && !file.isDirectory)) {
      await fs.rm(this.pathFor(item), { force: true });
    }
    this.data.files = this.data.files.filter((file) => file.userId !== userId);
    this.data.shares = this.data.shares.filter((share) => share.userId !== userId);
    this.data.users = this.data.users.filter((item) => item.id !== userId);
    for (const [token, session] of Object.entries(this.data.sessions)) {
      if (session.userId === userId) delete this.data.sessions[token];
    }
    await this.persist();
    return user.username;
  }

  listUsers() {
    return this.data.users.map((user) => {
      const stats = this.storageStats(user.id);
      return { id: user.id, username: user.username, role: user.role, disabled: !!user.disabled, createdAt: user.createdAt, usedBytes: stats.usedBytes, fileCount: stats.fileCount };
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  purgeExpiredSessions() {
    const now = Date.now();
    let removed = 0;
    for (const [token, session] of Object.entries(this.data.sessions)) {
      if (new Date(session.expiresAt).getTime() <= now) {
        delete this.data.sessions[token];
        removed += 1;
      }
    }
    return removed;
  }

  storageStats(userId) {
    const files = this.data.files.filter((file) => file.userId === userId && !file.deletedAt && !file.isDirectory);
    return {
      usedBytes: files.reduce((sum, file) => sum + (file.size || 0), 0),
      fileCount: files.length,
      quotaBytes: this.quotaBytes,
    };
  }

  async changePassword(userId, currentPassword, newPassword) {
    const user = this.data.users.find((item) => item.id === userId);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) throw new Error('INVALID_CREDENTIALS');
    if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) throw new Error('INVALID_PASSWORD');
    user.passwordHash = hashPassword(newPassword);
    await this.persist();
  }

  listFiles(userId, parentId = null, includeDeleted = false) {
    return this.data.files
      .filter((file) => file.userId === userId && file.parentId === parentId && (includeDeleted ? file.deletedAt : !file.deletedAt))
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  }

  findFile(userId, id, includeDeleted = false) {
    return this.data.files.find((file) => file.id === id && file.userId === userId && (includeDeleted || !file.deletedAt)) || null;
  }

  ancestorsFor(userId, parentId) {
    const chain = [];
    let cursor = parentId;
    while (cursor) {
      const parent = this.data.files.find((file) => file.id === cursor && file.userId === userId);
      if (!parent) break;
      chain.unshift({ id: parent.id, name: parent.name });
      cursor = parent.parentId;
    }
    return chain;
  }

  searchFiles(userId, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return this.data.files
      .filter((file) => file.userId === userId && !file.deletedAt && file.name.toLowerCase().includes(q))
      .slice(0, 100)
      .map((file) => ({ ...file, parentName: file.parentId ? (this.data.files.find((p) => p.id === file.parentId)?.name || null) : null, ancestors: this.ancestorsFor(userId, file.parentId) }))
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  }

  pathFor(file) {
    return path.join(this.filesDir, file.userId, file.id);
  }

  findFileById(id, includeDeleted = false) {
    return this.data.files.find((file) => file.id === id && (includeDeleted || !file.deletedAt)) || null;
  }

  async replaceFileContent(fileId, buffer) {
    const file = this.findFileById(fileId);
    if (!file || file.isDirectory) throw new Error('FILE_NOT_FOUND');
    const filePath = this.pathFor(file);
    const tempPath = `${filePath}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, filePath);
    file.size = buffer.length;
    file.updatedAt = new Date().toISOString();
    await this.persist();
    return file;
  }

  async createFolder(userId, name, parentId = null) {
    this.validateName(name);
    this.assertParent(userId, parentId);
    this.assertUnique(userId, parentId, name);
    const now = new Date().toISOString();
    const file = { id: crypto.randomUUID(), userId, parentId, name, type: 'folder', size: 0, mimeType: null, isDirectory: true, deletedAt: null, createdAt: now, updatedAt: now };
    this.data.files.push(file);
    await this.persist();
    return file;
  }

  async createFile(userId, name, parentId, buffer, mimeType = 'application/octet-stream') {
    this.validateName(name);
    this.assertParent(userId, parentId);
    this.assertUnique(userId, parentId, name);
    if (this.storageStats(userId).usedBytes + buffer.length > this.quotaBytes) throw new Error('QUOTA_EXCEEDED');
    const now = new Date().toISOString();
    const file = { id: crypto.randomUUID(), userId, parentId: parentId || null, name, type: path.extname(name).slice(1).toUpperCase() || 'FILE', size: buffer.length, mimeType, isDirectory: false, deletedAt: null, createdAt: now, updatedAt: now };
    await fs.mkdir(path.dirname(this.pathFor(file)), { recursive: true });
    await fs.writeFile(this.pathFor(file), buffer);
    this.data.files.push(file);
    await this.persist();
    return file;
  }

  async rename(userId, id, name) {
    const file = this.findFile(userId, id);
    if (!file) throw new Error('FILE_NOT_FOUND');
    this.validateName(name);
    this.assertUnique(userId, file.parentId, name, id);
    file.name = name;
    file.updatedAt = new Date().toISOString();
    await this.persist();
    return file;
  }

  async softDelete(userId, id) {
    const file = this.findFile(userId, id);
    if (!file) throw new Error('FILE_NOT_FOUND');
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of this.data.files) {
        if (child.userId === userId && child.parentId && ids.has(child.parentId) && !ids.has(child.id)) {
          ids.add(child.id);
          changed = true;
        }
      }
    }
    const deletedAt = new Date().toISOString();
    this.data.files.forEach((item) => { if (ids.has(item.id)) item.deletedAt = deletedAt; });
    await this.persist();
  }

  async softDeleteMany(userId, ids) {
    let deleted = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      if (!this.findFile(userId, id)) continue;
      await this.softDelete(userId, id);
      deleted += 1;
    }
    return deleted;
  }

  async restoreMany(userId, ids) {
    let restored = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      try { await this.restore(userId, id); restored += 1; } catch {}
    }
    return restored;
  }

  async permanentDeleteMany(userId, ids) {
    let deleted = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      try { await this.permanentDelete(userId, id); deleted += 1; } catch {}
    }
    return deleted;
  }

  async restore(userId, id) {
    const file = this.findFile(userId, id, true);
    if (!file || !file.deletedAt) throw new Error('FILE_NOT_FOUND');
    const parent = file.parentId ? this.findFile(userId, file.parentId) : null;
    file.parentId = parent ? parent.id : null;
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of this.data.files) {
        if (child.userId === userId && child.parentId && ids.has(child.parentId) && child.deletedAt && !ids.has(child.id)) {
          ids.add(child.id);
          changed = true;
        }
      }
    }
    this.data.files.forEach((item) => { if (ids.has(item.id)) item.deletedAt = null; });
    await this.persist();
    return file;
  }

  async permanentDelete(userId, id) {
    const file = this.findFile(userId, id, true);
    if (!file || !file.deletedAt) throw new Error('FILE_NOT_FOUND');
    const ids = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of this.data.files) {
        if (child.userId === userId && child.parentId && ids.has(child.parentId) && !ids.has(child.id)) { ids.add(child.id); changed = true; }
      }
    }
    for (const item of this.data.files.filter((entry) => ids.has(entry.id) && !entry.isDirectory)) await fs.rm(this.pathFor(item), { force: true });
    this.data.files = this.data.files.filter((item) => !ids.has(item.id));
    await this.persist();
  }

  assertParent(userId, parentId) {
    if (parentId && !this.findFile(userId, parentId)) throw new Error('PARENT_NOT_FOUND');
  }

  assertUnique(userId, parentId, name, ignoreId = null) {
    if (this.data.files.some((file) => file.userId === userId && file.parentId === (parentId || null) && !file.deletedAt && file.name === name && file.id !== ignoreId)) throw new Error('DUPLICATE_NAME');
  }

  validateName(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 180 || /[\\/\u0000-\u001f]/.test(name)) throw new Error('INVALID_NAME');
  }

  async createShare(userId, fileId, days, password) {
    const file = this.findFile(userId, fileId);
    if (!file || file.isDirectory) throw new Error('FILE_NOT_FOUND');
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('INVALID_DAYS');
    const share = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('hex'),
      userId,
      fileId,
      expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
      passwordHash: password ? hashPassword(String(password)) : null,
      revoked: false,
      createdAt: new Date().toISOString(),
    };
    this.data.shares.push(share);
    await this.persist();
    return { token: share.token, expiresAt: share.expiresAt, requiresPassword: !!password };
  }

  resolveShare(token) {
    const share = (this.data.shares || []).find((item) => item.token === token);
    if (!share || share.revoked || new Date(share.expiresAt).getTime() <= Date.now()) return null;
    const file = this.findFile(share.userId, share.fileId);
    if (!file || file.isDirectory) return null;
    return { share, file };
  }

  openShare(token, password) {
    const resolved = this.resolveShare(token);
    if (!resolved) throw new Error('SHARE_NOT_FOUND');
    const { share, file } = resolved;
    if (share.passwordHash) {
      if (!password) throw new Error('SHARE_PASSWORD_REQUIRED');
      if (!verifyPassword(String(password), share.passwordHash)) throw new Error('SHARE_PASSWORD_INVALID');
    }
    return file;
  }

  listShares(userId) {
    return (this.data.shares || [])
      .filter((share) => share.userId === userId)
      .map((share) => {
        const file = this.data.files.find((item) => item.id === share.fileId && item.userId === userId);
        return {
          token: share.token,
          fileName: file ? file.name : null,
          size: file ? file.size : 0,
          mimeType: file ? file.mimeType : null,
          fileDeleted: !file || !!file.deletedAt,
          expiresAt: share.expiresAt,
          revoked: !!share.revoked,
          requiresPassword: !!share.passwordHash,
          createdAt: share.createdAt,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revokeShare(userId, token) {
    const share = (this.data.shares || []).find((item) => item.token === token && item.userId === userId);
    if (!share) throw new Error('SHARE_NOT_FOUND');
    share.revoked = true;
    await this.persist();
  }
}
