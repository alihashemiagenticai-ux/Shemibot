import type { Context } from "grammy";
import type { Env } from "../../index";
import { btn, inlineKeyboard } from "../ui";

/**
 * اگه فقط یک پیج وصل باشه، همون رو برمی‌گردونه (بدون سوال اضافه).
 * اگه چندتا باشه، لیستی برای انتخاب نشون می‌ده و null برمی‌گردونه (یعنی «صبر کن تا کاربر انتخاب کنه»).
 * اگه هیچی وصل نباشه، راهنمایی می‌کنه و null برمی‌گردونه.
 */
export async function resolveOrAskPage(
  ctx: Context,
  env: Env,
  flowPrefix: string
): Promise<number | null> {
  const { results } = await env.DB.prepare(
    "SELECT id, ig_username FROM ig_accounts WHERE is_active = 1"
  ).all<{ id: number; ig_username: string }>();

  if (results.length === 0) {
    await ctx.reply("اول باید یک پیج وصل کنید (از منوی «🔗 پیج‌های من»).");
    return null;
  }
  if (results.length === 1) return results[0].id;

  await ctx.reply(
    "این برای کدوم پیجه؟",
    { reply_markup: inlineKeyboard(results.map((r) => [btn(`@${r.ig_username}`, `pgsel:${flowPrefix}:${r.id}`)])) }
  );
  return null;
}
