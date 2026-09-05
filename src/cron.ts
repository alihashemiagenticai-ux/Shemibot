import type { Env } from "./index";
import { refreshLongLivedToken, sendTextMessage } from "./instagram/api";

const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // هر توکنی که قدیمی‌تر از ۷ روز باشه رفرش می‌شه

/** فاز ۳: رفرش توکن هر پیجی که مدتیه رفرش نشده. یک اکانت خراب، بقیه رو متوقف نمی‌کنه. */
async function refreshAgingTokens(env: Env): Promise<void> {
  const cutoff = Date.now() - REFRESH_AFTER_MS;
  const { results } = await env.DB.prepare(
    "SELECT id, access_token FROM ig_accounts WHERE is_active = 1 AND token_last_refreshed_at < ?"
  )
    .bind(cutoff)
    .all<{ id: number; access_token: string }>();

  for (const acc of results) {
    try {
      const refreshed = await refreshLongLivedToken(acc.access_token);
      const now = Date.now();
      await env.DB.prepare(
        "UPDATE ig_accounts SET access_token = ?, token_last_refreshed_at = ?, token_expires_at = ? WHERE id = ?"
      )
        .bind(refreshed.access_token, now, now + refreshed.expires_in * 1000, acc.id)
        .run();
    } catch (err) {
      console.error(`رفرش توکن اکانت ${acc.id} ناموفق بود:`, (err as Error).message);
    }
  }
}

/** فاز ۶: ارسال هر فالوآپی که سررسیدش رسیده. */
async function processFollowupQueue(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT fq.id, fq.ig_account_id, fq.recipient_scoped_id, f.message_content, ia.access_token, ia.ig_user_id
     FROM followup_queue fq
     JOIN followups f ON f.id = fq.followup_id
     JOIN ig_accounts ia ON ia.id = fq.ig_account_id
     WHERE fq.status = 'pending' AND fq.scheduled_for <= ? AND ia.is_active = 1`
  )
    .bind(Date.now())
    .all<{
      id: number;
      ig_account_id: number;
      recipient_scoped_id: string;
      message_content: string;
      access_token: string;
      ig_user_id: string;
    }>();

  for (const row of results) {
    try {
      await sendTextMessage(
        env.IG_API_VERSION,
        row.access_token,
        row.ig_user_id,
        { id: row.recipient_scoped_id },
        row.message_content
      );
      await env.DB.prepare("UPDATE followup_queue SET status = 'sent', sent_at = ? WHERE id = ?")
        .bind(Date.now(), row.id)
        .run();
    } catch (err) {
      // معمولاً یعنی پنجره‌ی مجاز پیام‌رسانی (۲۴ ساعت/۷ روز) بسته شده؛ دیگه تلاش نمی‌کنیم.
      console.error(`ارسال فالوآپ ${row.id} ناموفق بود:`, (err as Error).message);
      await env.DB.prepare("UPDATE followup_queue SET status = 'failed' WHERE id = ?").bind(row.id).run();
    }
  }
}

export async function runDailyCron(env: Env): Promise<void> {
  await refreshAgingTokens(env);
  await processFollowupQueue(env);
}
