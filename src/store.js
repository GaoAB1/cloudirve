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

export class Store {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.dataDir = path.join(rootDir, 'data');
    this.filesDir = path.join(this.dataDir, 'files');
    this.metaPath = path.join(this.dataDir, 'metadata.json');
    this.sessions = new Map();
    this.data = { users: [], files: [] };
    this.quotaBytes = Number(process.env.STORAGE_QUOTA_BYTES || 1024 * 1024 * 1024);
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
    let migrated = false;
    for (const user of this.data.users) {
      if (user.password && !user.passwordHash) {
        user.passwordHash = hashPassword(user.password);
        delete user.password;
        migrated = true;
      }
    }
    if (migrated) await this.persist();
  }

  async persist() {
    await fs.writeFile(this.metaPath, JSON.stringify(this.data, null, 2));
  }

  authenticate(username, password) {
    const user = this.data.users.find((item) => item.username === username && verifyPassword(password, item.passwordHash));
    if (!user) return null;
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, user.id);
    return { token, user: { id: user.id, username: user.username } };
  }

  userFromToken(token) {
    const userId = token ? this.sessions.get(token) : null;
    return this.data.users.find((user) => user.id === userId) || null;
  }

  logout(token) {
    this.sessions.delete(token);
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
}
