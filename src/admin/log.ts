import { copyFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 归档并清空事件日志：先复制到带时间戳的归档文件，再清空原文件。
// 返回归档文件名；原日志不存在时返回 null。
export async function archiveLog(dir: string): Promise<string | null> {
  const file = join(dir, 'events.jsonl');
  try {
    await stat(file);
  } catch {
    return null;
  }
  const archive = `events-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  await copyFile(file, join(dir, archive));
  await writeFile(file, '', 'utf8');
  return archive;
}
