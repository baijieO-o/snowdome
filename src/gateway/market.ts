import { balanceOf, reverseTransfer, transfer, type Ledger } from './ledger.ts';

// 标准订单与即时交易（决策 8）。网关持有订单簿与账本；物品在小镇背包里，经注入的 ItemPort 读写。
// 结算顺序：卖方交出物品 -> 买方付款 -> 买方收货。任一步失败则逆向回滚已完成的步骤，订单保持挂单。

export interface ItemPort {
  // 增减背包物品。返回 false 表示小镇拒绝（库存不足或居民不在场）。
  move(actorId: string, item: string, amount: number, op: 'grant' | 'take'): Promise<boolean>;
}

export interface Order {
  id: number;
  // 挂单方的账本身份键（账号名或 agent-*）。
  seller: string;
  item: string;
  amount: number;
  price: number;
  // 过期的游戏日（含）之后订单失效。
  expiresDay: number;
  status: 'open' | 'filled' | 'cancelled' | 'expired';
}

export interface Market {
  orders: Order[];
  nextId: number;
}

export function newMarket(): Market {
  return { orders: [], nextId: 1 };
}

// 挂单只校验参数，不冻结库存。物品在成交时才扣减。
export function postOrder(market: Market, input: Omit<Order, 'id' | 'status'>): Order {
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw new Error('bad_amount');
  if (!Number.isInteger(input.price) || input.price <= 0) throw new Error('bad_price');
  const order: Order = { ...input, id: market.nextId++, status: 'open' };
  market.orders.push(order);
  return order;
}

export function cancelOrder(market: Market, id: number, seller: string): boolean {
  const order = market.orders.find((o) => o.id === id);
  if (!order || order.status !== 'open' || order.seller !== seller) return false;
  order.status = 'cancelled';
  return true;
}

// 过期：游戏日超过 expiresDay 的挂单置为 expired。
export function expireOrders(market: Market, day: number): number {
  let n = 0;
  for (const o of market.orders) {
    if (o.status === 'open' && day > o.expiresDay) {
      o.status = 'expired';
      n++;
    }
  }
  return n;
}

export type TradeReason = 'not_open' | 'self_trade' | 'insufficient_balance' | 'item_failed' | 'payment_failed';
export type TradeResult = { ok: true; order: Order } | { ok: false; reason: TradeReason };

// 即时成交。买方付 price 币（账本转账，手续费由账本扣），卖方交付物品。
// 任一步失败都会回滚，订单保持挂单。
export async function fillOrder(
  market: Market,
  ledger: Ledger,
  ports: { seller: ItemPort; buyer: ItemPort },
  orderId: number,
  buyer: { key: string; actorId: string },
  seller: { actorId: string },
  at = Date.now(),
): Promise<TradeResult> {
  const order = market.orders.find((o) => o.id === orderId);
  if (!order || order.status !== 'open') return { ok: false, reason: 'not_open' };
  if (order.seller === buyer.key) return { ok: false, reason: 'self_trade' };
  if (balanceOf(ledger, buyer.key) < order.price) return { ok: false, reason: 'insufficient_balance' };

  // 第一步：卖方交出物品。失败则什么都没动。
  if (!(await ports.seller.move(seller.actorId, order.item, order.amount, 'take'))) {
    return { ok: false, reason: 'item_failed' };
  }

  // 第二步：买方付款。失败则把物品还给卖方。
  try {
    await transfer(ledger, buyer.key, order.seller, order.price, at);
  } catch {
    await ports.seller.move(seller.actorId, order.item, order.amount, 'grant');
    return { ok: false, reason: 'payment_failed' };
  }

  // 第三步：买方收货。失败则冲正付款（退回买方全额）并把物品还给卖方。
  if (!(await ports.buyer.move(buyer.actorId, order.item, order.amount, 'grant'))) {
    await reverseTransfer(ledger, buyer.key, order.seller, order.price, at);
    await ports.seller.move(seller.actorId, order.item, order.amount, 'grant');
    return { ok: false, reason: 'item_failed' };
  }

  order.status = 'filled';
  return { ok: true, order };
}