import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// 中心账本：游戏币的唯一记账处，归网关所有。每笔一行追加写入 jsonl，带自增 id。
// 余额由账本重放得出，不单独存储，避免与流水不一致。

export type LedgerKind = 'welcome' | 'system_order' | 'transfer' | 'fee' | 'reversal';

export interface LedgerEntry {
  id: number;
  kind: LedgerKind;
  // 付款方与收款方的身份键（如 agent-<id> 或访客昵称）。发行时 from 为 null，回收时 to 为 null。
  from: string | null;
  to: string | null;
  amount: number;
  at: number;
}

export interface Ledger {
  path: string;
  entries: LedgerEntry[];
}

// 手续费率 5%，向上取整（决策 8）。
export const FEE_RATE = 0.05;
// 每居民每游戏日系统订单上限（决策 8）。
export const DAILY_SYSTEM_CAP = 200;
// 欢迎金数额：决策 8 未给出数值，此处为占位，待用户确认。
export const WELCOME_GOLD = 100;

export function feeOf(amount: number): number {
  return Math.ceil(amount * FEE_RATE);
}

export async function loadLedger(path: string): Promise<Ledger> {
  const ledger: Ledger = { path, entries: [] };
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return ledger;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    ledger.entries.push(JSON.parse(line) as LedgerEntry);
  }
  return ledger;
}

function nextId(ledger: Ledger): number {
  return ledger.entries.length === 0 ? 1 : ledger.entries[ledger.entries.length - 1].id + 1;
}

export function balanceOf(ledger: Ledger, who: string): number {
  let total = 0;
  for (const e of ledger.entries) {
    if (e.to === who) total += e.amount;
    if (e.from === who) total -= e.amount;
  }
  return total;
}

// 同一笔转账：付款方扣 amount，收款方得 amount - fee，平台收入账户记 fee（计为回收）。
// 返回写入的所有分录，账本与文件同步更新。
export async function transfer(ledger: Ledger, from: string, to: string, amount: number, at = Date.now()): Promise<LedgerEntry[]> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer');
  if (balanceOf(ledger, from) < amount) throw new Error('insufficient_balance');
  const fee = feeOf(amount);
  const entries: LedgerEntry[] = [
    { id: nextId(ledger), kind: 'transfer', from, to, amount: amount - fee, at },
  ];
  if (fee > 0) entries.push({ id: entries[0].id + 1, kind: 'fee', from, to: null, amount: fee, at });
  return append(ledger, entries);
}

// 冲正一笔已完成的转账：收款方所得被收回，付款方全额退回，手续费一并撤销。账本只追加，不改旧分录。
// 收款方余额不足以被收回时抛错，由调用方决定处理方式。
export async function reverseTransfer(ledger: Ledger, from: string, to: string, amount: number, at = Date.now()): Promise<LedgerEntry[]> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer');
  const fee = feeOf(amount);
  const received = amount - fee;
  if (balanceOf(ledger, to) < received) throw new Error('payee_insufficient_to_reverse');
  const base = nextId(ledger);
  return append(ledger, [
    { id: base, kind: 'reversal', from: to, to: null, amount: received, at },
    { id: base + 1, kind: 'reversal', from: null, to: from, amount, at },
  ]);
}

// 发行：系统给居民加币（欢迎金、系统订单）。系统订单受每游戏日上限约束，由调用方传入已用额度。
export async function issue(ledger: Ledger, kind: 'welcome' | 'system_order', to: string, amount: number, at = Date.now()): Promise<LedgerEntry[]> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer');
  return append(ledger, [{ id: nextId(ledger), kind, from: null, to, amount, at }]);
}

async function append(ledger: Ledger, entries: LedgerEntry[]): Promise<LedgerEntry[]> {
  await mkdir(dirname(ledger.path), { recursive: true });
  await appendFile(ledger.path, entries.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
  ledger.entries.push(...entries);
  return entries;
}

// 检查点回滚：截断到 id 之前（不含 id）的所有分录，并重写文件。
export async function truncateFrom(ledger: Ledger, id: number): Promise<number> {
  const kept = ledger.entries.filter((e) => e.id < id);
  const removed = ledger.entries.length - kept.length;
  // 先写临时文件再改名，避免中途崩溃损坏账本。
  const tmp = ledger.path + '.tmp';
  await writeFile(tmp, kept.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
  await rename(tmp, ledger.path);
  ledger.entries = kept;
  return removed;
}
