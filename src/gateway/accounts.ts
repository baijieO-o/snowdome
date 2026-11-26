import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// 账号库：访客的“昵称 + 密码”和持久绑定。归网关所有，各小镇不读写它。
const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LEN = 32;

export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 64;

export interface Account {
  name: string;
  salt: string;
  hash: string;
  boundAgentId?: string;
  created_at: number;
}

export interface AccountStore {
  path: string;
  accounts: Map<string, Account>;
}

export type AuthResult =
  | { ok: true; account: Account; created: boolean }
  | { ok: false; reason: 'password_required' | 'password_too_short' | 'password_too_long' | 'wrong_password' };

export async function loadAccounts(path: string): Promise<AccountStore> {
  const store: AccountStore = { path, accounts: new Map() };
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return store;
  }
  const parsed = JSON.parse(text) as { accounts?: Account[] };
  for (const account of parsed.accounts ?? []) store.accounts.set(account.name, account);
  return store;
}

// 先写临时文件再替换，避免写到一半崩溃导致账号库损坏。
async function saveAccounts(store: AccountStore): Promise<void> {
  await mkdir(dirname(store.path), { recursive: true });
  const tmp = `${store.path}.tmp`;
  await writeFile(tmp, JSON.stringify({ accounts: [...store.accounts.values()] }, null, 2), 'utf8');
  await rename(tmp, store.path);
}

async function hashPassword(password: string, salt: string): Promise<string> {
  return (await scrypt(password, Buffer.from(salt, 'hex'), KEY_LEN)).toString('hex');
}

async function passwordMatches(account: Account, password: string): Promise<boolean> {
  const actual = Buffer.from(await hashPassword(password, account.salt), 'hex');
  const expected = Buffer.from(account.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// 同一昵称：第一次登录即注册（需要密码），之后必须输入同一密码。
export async function authenticate(store: AccountStore, name: string, password: unknown): Promise<AuthResult> {
  if (typeof password !== 'string' || password.length === 0) return { ok: false, reason: 'password_required' };
  if (password.length < PASSWORD_MIN) return { ok: false, reason: 'password_too_short' };
  if (password.length > PASSWORD_MAX) return { ok: false, reason: 'password_too_long' };
  const existing = store.accounts.get(name);
  if (existing) {
    return (await passwordMatches(existing, password))
      ? { ok: true, account: existing, created: false }
      : { ok: false, reason: 'wrong_password' };
  }
  const salt = randomBytes(16).toString('hex');
  const account: Account = { name, salt, hash: await hashPassword(password, salt), created_at: Date.now() };
  store.accounts.set(name, account);
  await saveAccounts(store);
  return { ok: true, account, created: true };
}

// 改密码：必须先通过旧密码验证。新密码沿用同样的长度规则。
export async function changePassword(store: AccountStore, name: string, oldPassword: unknown, newPassword: unknown): Promise<AuthResult> {
  const account = store.accounts.get(name);
  if (!account) return { ok: false, reason: 'wrong_password' };
  const checked = await authenticate(store, name, oldPassword);
  if (!checked.ok) return checked;
  if (typeof newPassword !== 'string' || newPassword.length === 0) return { ok: false, reason: 'password_required' };
  if (newPassword.length < PASSWORD_MIN) return { ok: false, reason: 'password_too_short' };
  if (newPassword.length > PASSWORD_MAX) return { ok: false, reason: 'password_too_long' };
  const salt = randomBytes(16).toString('hex');
  account.salt = salt;
  account.hash = await hashPassword(newPassword, salt);
  await saveAccounts(store);
  return { ok: true, account, created: false };
}

export async function setBinding(store: AccountStore, name: string, agentId: string): Promise<void> {
  const account = store.accounts.get(name);
  if (!account || account.boundAgentId === agentId) return;
  account.boundAgentId = agentId;
  await saveAccounts(store);
}
