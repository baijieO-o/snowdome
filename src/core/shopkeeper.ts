// 店主 NPC：固定脚本，不调用 LLM。只用正则匹配关键词，没有命中时回固定套话。
import { BASIC_FURNITURE, FURNITURE, type FurnitureKind } from './crafting.ts';

// 店主 id 前缀：与访客（visitor-）、稳定居民（agent-）区分，不计入访客上限。
export const SHOPKEEPER_PREFIX = 'npc-';

export function isShopkeeper(id: string): boolean {
  return id.startsWith(SHOPKEEPER_PREFIX);
}

// 店主免费提供的图纸：学习与赠送都由店主发放，不扣材料。
// 基础家具（椅子、石墙、花盆）不需要图纸，店主不发。
export const SHOP_BLUEPRINTS: FurnitureKind[] = (Object.keys(FURNITURE) as FurnitureKind[]).filter(
  (k) => !BASIC_FURNITURE.has(k),
);

const RULES: Array<{ pattern: RegExp; reply: string }> = [
  { pattern: /图纸|设计|blueprint/i, reply: '图纸是免费的，告诉我你想要哪件家具，我可以给你一份。' },
  { pattern: /桌|床|table|bed/i, reply: '桌子和床都需要图纸，先找我拿一份再制作。' },
  { pattern: /材料|木|石|纤维|泥|material/i, reply: '材料要自己去后院拆地形或收集，我这里不卖材料。' },
  { pattern: /价格|多少钱|卖|买|price/i, reply: '我这里的图纸是免费的，不收钱。' },
  { pattern: /你好|嗨|hello|hi/i, reply: '欢迎光临，需要什么家具图纸？' },
];

const FALLBACK = '抱歉，我只懂图纸和家具的事情。';

// 根据玩家的话返回店主的固定回复。
export function shopkeeperReply(text: string): string {
  for (const rule of RULES) if (rule.pattern.test(text)) return rule.reply;
  return FALLBACK;
}
