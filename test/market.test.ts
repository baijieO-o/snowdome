import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { balanceOf, issue, loadLedger } from '../src/gateway/ledger.ts';
import { cancelOrder, expireOrders, fillOrder, newMarket, postOrder, type ItemPort } from '../src/gateway/market.ts';

function fakePort(ok = true, log: string[] = [], tag = ''): ItemPort {
  return {
    async move(actorId, item, amount, op) {
      log.push(`${tag}${op}:${actorId}:${item}x${amount}`);
      return ok;
    },
  };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'snowdome-market-'));
  const ledger = await loadLedger(join(dir, 'ledger.jsonl'));
  await issue(ledger, 'welcome', 'buyer', 500);
  const market = newMarket();
  const order = postOrder(market, { seller: 'seller', item: 'wood', amount: 3, price: 100, expiresDay: 10 });
  return { dir, ledger, market, order };
}

test('成交：买方扣全额，卖方得到扣费后金额，买方收到物品', async () => {
  const { dir, ledger, market, order } = await setup();
  try {
    const log: string[] = [];
    const r = await fillOrder(market, ledger, { seller: fakePort(true, log, 's:'), buyer: fakePort(true, log, 'b:') }, order.id, { key: 'buyer', actorId: 'b1' }, { actorId: 's1' });
    assert.equal(r.ok, true);
    assert.equal(balanceOf(ledger, 'buyer'), 400);
    assert.equal(balanceOf(ledger, 'seller'), 95);
    assert.deepEqual(log, ['s:take:s1:woodx3', 'b:grant:b1:woodx3']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('买方收货失败：冲正付款，卖方物品退回，订单仍挂单', async () => {
  const { dir, ledger, market, order } = await setup();
  try {
    const log: string[] = [];
    const r = await fillOrder(market, ledger, { seller: fakePort(true, log, 's:'), buyer: fakePort(false, log, 'b:') }, order.id, { key: 'buyer', actorId: 'b1' }, { actorId: 's1' });
    assert.deepEqual(r, { ok: false, reason: 'item_failed' });
    assert.equal(balanceOf(ledger, 'buyer'), 500);
    assert.equal(balanceOf(ledger, 'seller'), 0);
    assert.equal(order.status, 'open');
    assert.deepEqual(log, ['s:take:s1:woodx3', 'b:grant:b1:woodx3', 's:grant:s1:woodx3']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('卖方交付失败：不动账本，订单仍挂单', async () => {
  const { dir, ledger, market, order } = await setup();
  try {
    const r = await fillOrder(market, ledger, { seller: fakePort(false), buyer: fakePort(true) }, order.id, { key: 'buyer', actorId: 'b1' }, { actorId: 's1' });
    assert.deepEqual(r, { ok: false, reason: 'item_failed' });
    assert.equal(balanceOf(ledger, 'buyer'), 500);
    assert.equal(order.status, 'open');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('余额不足、自买、撤单后不可成交', async () => {
  const { dir, ledger, market, order } = await setup();
  try {
    const p = { seller: fakePort(), buyer: fakePort() };
    assert.deepEqual(await fillOrder(market, ledger, p, order.id, { key: 'poor', actorId: 'x' }, { actorId: 's1' }), { ok: false, reason: 'insufficient_balance' });
    assert.deepEqual(await fillOrder(market, ledger, p, order.id, { key: 'seller', actorId: 's1' }, { actorId: 's1' }), { ok: false, reason: 'self_trade' });
    assert.equal(cancelOrder(market, order.id, 'buyer'), false);
    assert.equal(cancelOrder(market, order.id, 'seller'), true);
    assert.deepEqual(await fillOrder(market, ledger, p, order.id, { key: 'buyer', actorId: 'b1' }, { actorId: 's1' }), { ok: false, reason: 'not_open' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('过期：游戏日超过 expiresDay 才失效', () => {
  const market = newMarket();
  const o = postOrder(market, { seller: 's', item: 'wood', amount: 1, price: 1, expiresDay: 10 });
  assert.equal(expireOrders(market, 10), 0);
  assert.equal(expireOrders(market, 11), 1);
  assert.equal(o.status, 'expired');
});