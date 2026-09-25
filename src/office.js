import crypto from 'node:crypto';

function base64urlEncode(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return input.toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(String(value), 'base64url');
}

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function signOfficeToken(payload, secret, ttlSeconds = 300) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode({ alg: 'HS256', typ: 'JWT' });
  const body = base64urlEncode({ ...payload, iat: now, exp: now + ttlSeconds });
  const unsigned = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

export function verifyOfficeToken(token, secret, expectedPurpose) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('OFFICE_TOKEN_INVALID');
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  if (!timingSafeStringEqual(parts[2], expected)) throw new Error('OFFICE_TOKEN_INVALID');
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  } catch {
    throw new Error('OFFICE_TOKEN_INVALID');
  }
  if (payload.exp <= Math.floor(Date.now() / 1000) || (expectedPurpose && payload.purpose !== expectedPurpose)) throw new Error('OFFICE_TOKEN_INVALID');
  return payload;
}

export function officeFileType(name) {
  const extension = String(name || '').split('.').pop()?.toLowerCase() || '';
  const types = {
    doc: 'text', docx: 'text', docm: 'text', dot: 'text', dotx: 'text', odt: 'text', rtf: 'text', txt: 'text',
    xls: 'spreadsheet', xlsx: 'spreadsheet', xlsm: 'spreadsheet', xlsb: 'spreadsheet', ods: 'spreadsheet', csv: 'spreadsheet',
    ppt: 'presentation', pptx: 'presentation', pptm: 'presentation', ppsx: 'presentation', odp: 'presentation',
  };
  const documentType = types[extension];
  return documentType ? { extension, documentType } : null;
}

export function officeConfigToken(config, secret) {
  const { token: ignoredToken, ...unsignedConfig } = config;
  // OnlyOffice 官方约定：浏览器配置令牌的 payload 必须是 { payload: <完整配置> }，
  // DS 7.2+ 启用 JWT 后以令牌内的 payload 为权威配置来源（含 callbackUrl/document.url）
  return signOfficeToken({ payload: unsignedConfig }, secret, 10 * 60);
}
