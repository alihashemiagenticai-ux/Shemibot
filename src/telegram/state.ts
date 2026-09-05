// مدیریت وضعیت موقت مکالمه‌ی هر ادمین (برای فلوهای چندمرحله‌ای مثل «افزودن کلمه‌ی کلیدی»).
// چون Cloudflare Workers بین درخواست‌ها حافظه‌ای نگه نمی‌داره، این وضعیت رو در D1 ذخیره می‌کنیم.

export interface PendingState {
  action: string;
  data: Record<string, unknown>;
}

export async function getState(db: D1Database, telegramUserId: string): Promise<PendingState | null> {
  const row = await db
    .prepare("SELECT pending_action, pending_data FROM bot_state WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<{ pending_action: string | null; pending_data: string | null }>();

  if (!row?.pending_action) return null;
  return {
    action: row.pending_action,
    data: row.pending_data ? JSON.parse(row.pending_data) : {},
  };
}

export async function setState(
  db: D1Database,
  telegramUserId: string,
  action: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bot_state (telegram_user_id, pending_action, pending_data, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET
         pending_action = excluded.pending_action,
         pending_data = excluded.pending_data,
         updated_at = excluded.updated_at`
    )
    .bind(telegramUserId, action, JSON.stringify(data), Date.now())
    .run();
}

export async function clearState(db: D1Database, telegramUserId: string): Promise<void> {
  await db
    .prepare("UPDATE bot_state SET pending_action = NULL, pending_data = NULL WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .run();
}
