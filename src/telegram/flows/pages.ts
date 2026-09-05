import type { Context } from "grammy";
import type { Env } from "../../index";
import { btn, inlineKeyboard, CANCEL_DATA } from "../ui";
import { setState, clearState, type PendingState } from "../state";
import { exchangeForLongLivedToken, fetchIgProfile } from "../../instagram/api";

type Row = {
  id: number;
  ig_username: string;
  is_active: number;
  token_expires_at: number;
  follow_gate_enabled: number;
  follow_gate_message: string | null;
};

export async function renderPagesList(ctx: Context, env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT id, ig_username, is_active, token_expires_at, follow_gate_enabled, follow_gate_message FROM ig_accounts ORDER BY connected_at DESC"
  ).all<Row>();

  const rows = results.map((r) => [
    btn(
      `${r.is_active ? "🟢" : "⚪️"} @${r.ig_username}`,
      `pages:view:${r.id}`
    ),
  ]);
  rows.push([btn("➕ افزودن پیج جدید", "pages:add", "primary")]);

  const text = results.length
    ? "پیج‌های وصل‌شده — برای مدیریت هرکدوم روش بزنید:"
    : "هنوز هیچ پیجی وصل نشده. یکی اضافه کنید:";

  await ctx.reply(text, { reply_markup: inlineKeyboard(rows) });
}

async function renderPageDetail(ctx: Context, env: Env, id: number) {
  const row = await env.DB.prepare(
    "SELECT id, ig_username, is_active, token_expires_at, follow_gate_enabled, follow_gate_message FROM ig_accounts WHERE id = ?"
  )
    .bind(id)
    .first<Row>();
  if (!row) return ctx.reply("این پیج دیگه پیدا نشد.");

  const expDate = new Date(row.token_expires_at).toLocaleDateString("fa-IR");
  const gateStatus = row.follow_gate_enabled ? "🟢 فعال" : "⚪️ غیرفعال";
  const text =
    `@${row.ig_username}\nوضعیت: ${row.is_active ? "🟢 فعال" : "⚪️ غیرفعال"}\nانقضای توکن: ${expDate}\n\n` +
    `فالو اجباری: ${gateStatus}` +
    (row.follow_gate_enabled && row.follow_gate_message ? `\nمتن فعلی: «${row.follow_gate_message}»` : "");

  await ctx.reply(text, {
    reply_markup: inlineKeyboard([
      [
        row.is_active
          ? btn("⚪️ غیرفعال کردن", `pages:toggle:${row.id}`)
          : btn("🟢 فعال کردن", `pages:toggle:${row.id}`, "success"),
      ],
      [
        row.follow_gate_enabled
          ? btn("⚪️ خاموش‌کردن فالو اجباری", `pages:fgoff:${row.id}`)
          : btn("🟢 روشن‌کردن فالو اجباری", `pages:fgon:${row.id}`, "success"),
      ],
      [btn("✏️ متن درخواست فالو", `pages:fgedit:${row.id}`)],
      [btn("🗑 حذف این پیج", `pages:delcfm:${row.id}`, "danger")],
      [btn("‹ بازگشت به لیست", "pages:list")],
    ]),
  });
}

export async function handlePagesCallback(ctx: Context, env: Env, data: string) {
  const [, action, idStr] = data.split(":");
  const id = idStr ? Number(idStr) : undefined;

  if (action === "list") return renderPagesList(ctx, env);
  if (action === "view" && id) return renderPageDetail(ctx, env, id);

  if (action === "toggle" && id) {
    await env.DB.prepare("UPDATE ig_accounts SET is_active = 1 - is_active WHERE id = ?")
      .bind(id)
      .run();
    await ctx.answerCallbackQuery({ text: "به‌روزرسانی شد." });
    return renderPageDetail(ctx, env, id);
  }

  if (action === "fgon" && id) {
    await env.DB.prepare("UPDATE ig_accounts SET follow_gate_enabled = 1 WHERE id = ?").bind(id).run();
    await ctx.answerCallbackQuery({ text: "فالو اجباری روشن شد." });
    return renderPageDetail(ctx, env, id);
  }

  if (action === "fgoff" && id) {
    await env.DB.prepare("UPDATE ig_accounts SET follow_gate_enabled = 0 WHERE id = ?").bind(id).run();
    await ctx.answerCallbackQuery({ text: "فالو اجباری خاموش شد." });
    return renderPageDetail(ctx, env, id);
  }

  if (action === "fgedit" && id) {
    const userId = ctx.from!.id.toString();
    await setState(env.DB, userId, "pages_fg_message", { ig_account_id: id });
    return ctx.reply(
      "متنی که قبل از باز‌کردن قفل محتوا به کاربر نشون داده بشه رو بفرستید — مثلاً:\n" +
        "«برای دریافت این محتوا، لطفاً ابتدا پیج ما رو فالو کنید، بعد روی دکمه‌ی زیر بزنید»\n\n" +
        "⚠️ نکته: ربات بعد از زده‌شدن دکمه سعی می‌کنه واقعاً از اینستاگرام بپرسه که آیا فالو کرده یا نه؛ " +
        "اگه این بررسی به هر دلیلی (مثلاً محدودیت‌های پلتفرم) ممکن نشه، به‌جای گیرکردن کاربر، به‌طور خودکار " +
        "همون تپ‌کردن دکمه رو به‌عنوان تأیید در نظر می‌گیره.",
      { reply_markup: inlineKeyboard([[btn("❌ انصراف", CANCEL_DATA, "danger")]]) }
    );
  }

  if (action === "delcfm" && id) {
    return ctx.editMessageText("مطمئنید می‌خواید این پیج و همه‌ی کلمات کلیدی/ویترین/فالوآپ‌های وابسته‌ش حذف بشه؟", {
      reply_markup: inlineKeyboard([
        [btn("بله، حذف کن", `pages:delyes:${id}`, "danger"), btn("انصراف", `pages:view:${id}`)],
      ]),
    });
  }

  if (action === "delyes" && id) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM keywords WHERE ig_account_id = ?").bind(id),
      env.DB.prepare("DELETE FROM showcase_products WHERE ig_account_id = ?").bind(id),
      env.DB.prepare("DELETE FROM followup_queue WHERE ig_account_id = ?").bind(id),
      env.DB.prepare("DELETE FROM followups WHERE ig_account_id = ?").bind(id),
      env.DB.prepare("DELETE FROM ig_accounts WHERE id = ?").bind(id),
    ]);
    await ctx.answerCallbackQuery({ text: "حذف شد." });
    return renderPagesList(ctx, env);
  }

  if (action === "add") {
    const userId = ctx.from!.id.toString();
    await setState(env.DB, userId, "pages_awaiting_token");
    return ctx.reply(
      "خب! طبق راهنمای فاز صفر یک توکن از App Dashboard متا بگیرید و همینجا برام بفرستید.\n\n" +
        "(فقط پیام حاوی توکن رو بفرستید — چیز دیگه‌ای لازم نیست بنویسید.)",
      { reply_markup: inlineKeyboard([[btn("❌ انصراف", CANCEL_DATA, "danger")]]) }
    );
  }
}

/** ورودی متنی برای فلوهای این بخش: اتصال پیج (توکن) یا تنظیم متن فالو اجباری. */
export async function handlePagesWizardText(ctx: Context, env: Env, state: PendingState, text: string) {
  if (state.action === "pages_fg_message") {
    const userId = ctx.from!.id.toString();
    const igAccountId = state.data.ig_account_id as number;
    await env.DB.prepare("UPDATE ig_accounts SET follow_gate_message = ?, follow_gate_enabled = 1 WHERE id = ?")
      .bind(text.trim(), igAccountId)
      .run();
    await clearState(env.DB, userId);
    await ctx.reply("✅ ذخیره شد و فالو اجباری روشن شد.");
    return renderPageDetail(ctx, env, igAccountId);
  }

  return handleTokenConnect(ctx, env, text);
}

/** مرحله‌ی دریافت توکن، وقتی pending_action == 'pages_awaiting_token' باشه. */
async function handleTokenConnect(ctx: Context, env: Env, text: string) {
  const userId = ctx.from!.id.toString();
  await ctx.reply("در حال بررسی توکن...");

  try {
    let longLivedToken = text.trim();
    let expiresInSeconds = 60 * 24 * 60 * 60;
    try {
      const exchanged = await exchangeForLongLivedToken(longLivedToken, env.FACEBOOK_APP_SECRET);
      longLivedToken = exchanged.access_token;
      expiresInSeconds = exchanged.expires_in;
    } catch {
      // شاید از قبل بلندمدت بوده؛ با همون توکن اصلی ادامه می‌دیم
    }

    const profile = await fetchIgProfile(longLivedToken);
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO ig_accounts
         (ig_user_id, ig_username, access_token, token_last_refreshed_at, token_expires_at, connected_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(ig_user_id) DO UPDATE SET
         access_token = excluded.access_token,
         token_last_refreshed_at = excluded.token_last_refreshed_at,
         token_expires_at = excluded.token_expires_at,
         is_active = 1`
    )
      .bind(profile.user_id, profile.username, longLivedToken, now, now + expiresInSeconds * 1000, now)
      .run();

    await clearState(env.DB, userId);
    await ctx.reply(`✅ پیج @${profile.username} با موفقیت وصل شد.`);
    await renderPagesList(ctx, env);
  } catch (err) {
    await ctx.reply(
      `❌ اتصال ناموفق بود: ${(err as Error).message}\n\nدوباره امتحان کنید یا انصراف بدید.`,
      { reply_markup: inlineKeyboard([[btn("❌ انصراف", CANCEL_DATA, "danger")]]) }
    );
  }
}
