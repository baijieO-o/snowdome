import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authenticate, changePassword, loadAccounts, setBinding } from '../src/gateway/accounts.ts';

async function tempPath() {
  const dir = await mkdtemp(join(tmpdir(), 'snowdome-accounts-'));
  return { dir, file: join(dir, 'accounts.json') };
}

test('首次登录注册，之后必须输入同一密码', async () => {
  const { dir, file } = await tempPath();
  try {
    const store = await loadAccounts(file);
    const first = await authenticate(store, '小明', 'abcd');
    assert.equal(first.ok && first.created, true);
    assert.equal((await authenticate(store, '小明', 'abcd')).ok, true);
    assert.deepEqual(await authenticate(store, '小明', 'wrong1'), { ok: false, reason: 'wrong_password' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('密码不写入明文，且重新加载后仍可校验', async () => {
  const { dir, file } = await tempPath();
  try {
    await authenticate(await loadAccounts(file), '小红', 'secret-pass');
    const text = await readFile(file, 'utf8');
    assert.equal(text.includes('secret-pass'), false);
    const reloaded = await loadAccounts(file);
    assert.equal((await authenticate(reloaded, '小红', 'secret-pass')).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('密码缺失或长度不合法时拒绝', async () => {
  const { dir, file } = await tempPath();
  try {
    const store = await loadAccounts(file);
    assert.deepEqual(await authenticate(store, '小刚', undefined), { ok: false, reason: 'password_required' });
    assert.deepEqual(await authenticate(store, '小刚', 'abc'), { ok: false, reason: 'password_too_short' });
    assert.deepEqual(await authenticate(store, '小刚', 'x'.repeat(65)), { ok: false, reason: 'password_too_long' });
    assert.equal(store.accounts.has('小刚'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('绑定写入账号库，重新加载后仍在', async () => {
  const { dir, file } = await tempPath();
  try {
    const store = await loadAccounts(file);
    await authenticate(store, '小丽', 'abcd');
    await setBinding(store, '小丽', 'agent-hiero');
    const reloaded = await loadAccounts(file);
    assert.equal(reloaded.accounts.get('小丽')?.boundAgentId, 'agent-hiero');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('改密码必须先验证旧密码，成功后新密码生效且旧密码失效', async () => {
  const { dir, file } = await tempPath();
  try {
    const store = await loadAccounts(file);
    await authenticate(store, '小红', 'abcd');
    assert.deepEqual(await changePassword(store, '小红', 'wrong1', 'efgh'), { ok: false, reason: 'wrong_password' });
    assert.equal((await changePassword(store, '小红', 'abcd', 'efgh')).ok, true);
    assert.equal((await authenticate(store, '小红', 'abcd')).ok, false);
    assert.equal((await authenticate(store, '小红', 'efgh')).ok, true);
    assert.deepEqual(await changePassword(store, '小红', 'efgh', 'ab'), { ok: false, reason: 'password_too_short' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});