import type { Context } from "grammy";
import type { Env } from "../../index";
import { btn, inlineKeyboard } from "../ui";
import { setState, clearState, getState } from "../state";

export async function getMediaChannelId(db: D1Database): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM bot_settings WHERE key = 'media_channel_id'").first<{ value: string }>();
  return row?.value ?? null;
}

async function saveMediaChannelId(db: D1Database, channelId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bot_settings (key, value) VALUES ('media_channel_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(channelId)
    .run();
}

export async function renderSettings(ctx: Context, env: Env) {
  const channelId = await getMediaChannelId(env.DB);
  const status = channelId ? `🟢 وصله` : "⚪️ هنوز وصل نشده — برای پاسخ‌های تصویری/ویدیویی/صوتی لازمه";

  await ctx.reply(`⚙️ تنظیمات\n\nکانال رسانه: ${status}`, {
    reply_markup: inlineKeyboard([
      [btn(channelId ? "🔁 تغییر کانال رسانه" : "🔗 اتصال کانال رسانه", "settings:connect", "primary")],
    ]),
  });
}

export async function handleSettingsCallback(ctx: Context, env: Env, data: string) {
  if (data !== "settings:connect") return;

  const userId = ctx.from!.id.toString();
  await setState(env.DB, userId, "settings_awaiting_channel_forward");
  const me = await ctx.api.getMe();

  await ctx.reply(
    "این کار رو انجام بدید:\n\n" +
      "۱. یک کانال خصوصی تازه در تلگرام بسازید (یا از یکی که دارید استفاده کنید — فقط برای بایگانی رسانه، نیازی نیست کسی دیگه‌ای عضوش باشه)\n" +
      `۲. ربات (@${me.username}) رو به‌عنوان ادمین به اون کانال اضافه کنید — کافیه اجازه‌ی «ارسال پیام» روشن باشه\n` +
      "۳. هر پیامی (مثلاً یک نقطه) توی همون کانال بفرستید\n" +
      "۴. همون پیام رو نگه دارید و لمس کنید، «Forward» رو بزنید، و همینجا (به همین چت با من) بفرستیدش\n\n" +
      "منتظر پیام فوروادی‌تون می‌مونم.",
    { reply_markup: inlineKeyboard([[btn("❌ انصراف", "wizard:cancel", "danger")]]) }
  );
}

/**
 * وقتی pending_action == 'settings_awaiting_channel_forward' باشه و یک پیام فوروارد‌شده از
 * یک کانال برسه، آیدی همون کانال رو ذخیره می‌کنه. اگه این حالت برقرار نبود، false برمی‌گردونه
 * (یعنی «به من مربوط نبود، بقیه‌ی هندلرها رسیدگی کنن»).
 */
export async function handleSettingsChannelForward(ctx: Context, env: Env): Promise<boolean> {
  const userId = ctx.from!.id.toString();
  const state = await getState(env.DB, userId);
  if (state?.action !== "settings_awaiting_channel_forward") return false;

  const origin = ctx.message?.forward_origin;
  if (!origin || origin.type !== "channel") {
    await ctx.reply("این یک پیامِ فوروارد‌شده از یک کانال نبود. لطفاً طبق راهنما، پیام رو از خودِ کانال فوروارد کنید.");
    return true;
  }

  const channelId = origin.chat.id.toString();

  // یک پیام تستی به همون کانال می‌فرستیم تا مطمئن بشیم ربات واقعاً دسترسی ارسال داره
  try {
    await ctx.api.sendMessage(channelId, "✅ این کانال با موفقیت به ربات دایرکت هوشمند وصل شد.");
  } catch {
    await ctx.reply("پیام از این کانال دریافت شد، ولی ربات نتونست توش پیام بفرسته — مطمئن بشید ربات با اجازه‌ی «ارسال پیام» ادمین شده، بعد دوباره امتحان کنید.");
    return true;
  }

  await saveMediaChannelId(env.DB, channelId);
  await clearState(env.DB, userId);
  await ctx.reply("🎉 کانال رسانه با موفقیت وصل شد. حالا می‌تونید توی «پاسخ هوشمند» و «ویترین» از عکس/ویدیو/صدا استفاده کنید.");
  return true;
}
