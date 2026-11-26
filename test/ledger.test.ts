import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { balanceOf, feeOf, issue, loadLedger, transfer, truncateFrom } from '../src/gateway/ledger.ts';

async function tempLedger() {
  const dir = await mkdtemp(join(tmpdir(), 'snowdome-ledger-'));
  return { dir, file: join(dir, 'ledger.jsonl') };
}

test('手续费 5% 向上取整', () => {
  assert.equal(feeOf(100), 5);
  assert.equal(feeOf(101), 6);
  assert.equal(feeOf(1), 1);
});

test('转账守恒：付款方减去全额，收款方得到扣费后金额，回收入账', async () => {
  const { dir, file } = await tempLedger();
  try {
    const ledger = await loadLedger(file);
    await issue(ledger, 'welcome', 'A', 200);
    await transfer(ledger, 'A', 'B', 101);
    assert.equal(balanceOf(ledger, 'A'), 200 - 101);
    assert.equal(balanceOf(ledger, 'B'), 101 - feeOf(101));
    const fee = ledger.entries.find((e) => e.kind === 'fee');
    assert.equal(fee?.amount, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('余额不足时拒绝转账且不写入账本', async () => {
  const { dir, file } = await tempLedger();
  try {
    const ledger = await loadLedger(file);
    await issue(ledger, 'welcome', 'A', 10);
    await assert.rejects(transfer(ledger, 'A', 'B', 11), /insufficient_balance/);
    assert.equal(ledger.entries.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('账本持久化：重新加载后余额与 id 一致', async () => {
  const { dir, file } = await tempLedger();
  try {
    const ledger = await loadLedger(file);
    await issue(ledger, 'welcome', 'A', 50);
    await transfer(ledger, 'A', 'B', 20);
    const again = await loadLedger(file);
    assert.equal(balanceOf(again, 'A'), balanceOf(ledger, 'A'));
    assert.equal(again.entries.at(-1)?.id, ledger.entries.at(-1)?.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('按 id 截断：截掉之后的分录，余额回到截断点', async () => {
  const { dir, file } = await tempLedger();
  try {
    const ledger = await loadLedger(file);
    await issue(ledger, 'welcome', 'A', 100);
    const [cut] = await transfer(ledger, 'A', 'B', 30);
    assert.equal(balanceOf(ledger, 'A'), 100 - 30);
    const removed = await truncateFrom(ledger, cut.id);
    assert.equal(removed, 2);
    assert.equal(balanceOf(ledger, 'A'), 100);
    assert.equal(balanceOf(ledger, 'B'), 0);
    const reloaded = await loadLedger(file);
    assert.equal(balanceOf(reloaded, 'A'), 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
