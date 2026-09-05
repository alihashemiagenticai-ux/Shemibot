import type { Context } from "grammy";
import type { Env } from "../../index";
import { btn, inlineKeyboard, skipCancelRow } from "../ui";
import { setState, clearState, getState, type PendingState } from "../state";
import { resolveOrAskPage } from "./pageselect";
import { forwardMediaToChannel } from "../../instagram/media";
import { getMediaChannelId } from "./settings";

type KwRow = {
  id: number;
  trigger_word: string;
  source: string;
  response_type: string;
  is_active: number;
};

const SOURCE_LABEL: Record<string, string> = { dm: "دایرکت", comment: "کامنت", both: "دایرکت + کامنت" };
const TYPE_LABEL: Record<string, string> = {
  text: "📝 متن",
  image: "🖼 عکس",
  video: "🎬 ویدیو",
  voice: "🎤 صدا",
  showcase: "🛍 ویترین محصولات",
};

async function renderKeywordsList(ctx: Context, env: Env, igAccountId: number) {
  const { results } = await env.DB.prepare(
    "SELECT id, trigger_word, source, response_type, is_active FROM keywords WHERE ig_account_id = ? ORDER BY id DESC"
  )
    .bind(igAccountId)
    .all<KwRow>();

  const rows = results.map((k) => [
    btn(
      `${k.is_active ? "🟢" : "⚪️"} «${k.trigger_word}» — ${SOURCE_LABEL[k.source]} — ${TYPE_LABEL[k.response_type]}`,
      `kw:view:${k.id}`
    ),
  ]);
  rows.push([btn("➕ افزودن کلمه‌ی جدید", `kw:add:${igAccountId}`, "primary")]);

  await ctx.reply(
    results.length ? "پاسخ‌های هوشمند این پیج:" : "هنوز کلمه‌ی کلیدی‌ای برای این پیج تعریف نشده.",
    { reply_markup: inlineKeyboard(rows) }
  );
}

async function renderKeywordDetail(ctx: Context, env: Env, id: number) {
  const row = await env.DB.prepare(
    "SELECT id, ig_account_id, trigger_word, source, response_type, is_active FROM keywords WHERE id = ?"
  )
    .bind(id)
    .first<KwRow & { ig_account_id: number }>();
  if (!row) return ctx.reply("این مورد دیگه پیدا نشد.");

  await ctx.reply(
    `کلمه‌ی کلیدی: «${row.trigger_word}»\nمنبع: ${SOURCE_LABEL[row.source]}\nنوع پاسخ: ${TYPE_LABEL[row.response_type]}\nوضعیت: ${row.is_active ? "🟢 فعال" : "⚪️ غیرفعال"}`,
    {
      reply_markup: inlineKeyboard([
        [
          row.is_active
            ? btn("⚪️ غیرفعال کردن", `kw:toggle:${row.id}`)
            : btn("🟢 فعال کردن", `kw:toggle:${row.id}`, "success"),
        ],
        [btn("🗑 حذف", `kw:delcfm:${row.id}`, "danger")],
        [btn("‹ بازگشت به لیست", `kw:list:${row.ig_account_id}`)],
      ]),
    }
  );
}

export async function handleKeywordsMenuEntry(ctx: Context, env: Env) {
  const id = await resolveOrAskPage(ctx, env, "kwlist");
  if (id) await renderKeywordsList(ctx, env, id);
}

export async function handleKeywordsCallback(ctx: Context, env: Env, data: string) {
  const parts = data.split(":");
  const action = parts[1];
  const userId = ctx.from!.id.toString();

  if (action === "list") return renderKeywordsList(ctx, env, Number(parts[2]));
  if (action === "view") return renderKeywordDetail(ctx, env, Number(parts[2]));

  if (action === "toggle") {
    await env.DB.prepare("UPDATE keywords SET is_active = 1 - is_active WHERE id = ?").bind(Number(parts[2])).run();
    await ctx.answerCallbackQuery({ text: "به‌روزرسانی شد." });
    return renderKeywordDetail(ctx, env, Number(parts[2]));
  }

  if (action === "delcfm") {
    const kwId = Number(parts[2]);
    return ctx.editMessageText("مطمئنید حذف بشه؟", {
      reply_markup: inlineKeyboard([[btn("بله، حذف کن", `kw:delyes:${kwId}`, "danger"), btn("انصراف", `kw:view:${kwId}`)]]),
    });
  }

  if (action === "delyes") {
    const kwId = Number(parts[2]);
    const row = await env.DB.prepare("SELECT ig_account_id FROM keywords WHERE id = ?").bind(kwId).first<{ ig_account_id: number }>();
    await env.DB.prepare("DELETE FROM keywords WHERE id = ?").bind(kwId).run();
    await ctx.answerCallbackQuery({ text: "حذف شد." });
    if (row) return renderKeywordsList(ctx, env, row.ig_account_id);
    return;
  }

  if (action === "add") {
    const igAccountId = Number(parts[2]);
    await setState(env.DB, userId, "kw_trigger", { ig_account_id: igAccountId });
    return ctx.reply("کلمه یا عبارت کلیدی رو بفرستید (مثلاً «قیمت» یا «هزینه ارسال»):", {
      reply_markup: inlineKeyboard([skipCancelRow(false)]),
    });
  }

  if (action === "source") {
    const state = await getState(env.DB, userId);
    if (!state) return;
    state.data.source = parts[2];
    await setState(env.DB, userId, "kw_type", state.data);
    return ctx.reply("نوع پاسخ چیه؟", {
      reply_markup: inlineKeyboard([
        [btn(TYPE_LABEL.text, "kw:type:text", "primary")],
        [btn(TYPE_LABEL.image, "kw:type:image", "primary")],
        [btn(TYPE_LABEL.video, "kw:type:video", "primary")],
        [btn(TYPE_LABEL.voice, "kw:type:voice", "primary")],
        [btn(TYPE_LABEL.showcase, "kw:type:showcase", "primary")],
        skipCancelRow(false),
      ]),
    });
  }

  if (action === "type") {
    const state = await getState(env.DB, userId);
    if (!state) return;
    state.data.response_type = parts[2];

    if (parts[2] === "text") {
      await setState(env.DB, userId, "kw_content_text", state.data);
      return ctx.reply("متن پاسخ رو بفرستید:", { reply_markup: inlineKeyboard([skipCancelRow(false)]) });
    }
    if (parts[2] === "showcase") {
      state.data.response_content = ""; // برای ویترین محتوایی لازم نیست، لیست محصولات فعالِ همون پیج فرستاده می‌شه
      return maybeAskPublicReply(ctx, env, userId, state.data);
    }
    const channelId = await getMediaChannelId(env.DB);
    if (!channelId) {
      return ctx.reply("اول باید کانال رسانه رو وصل کنید — از منوی «⚙️ تنظیمات».");
    }
    await setState(env.DB, userId, "kw_content_media", state.data);
    return ctx.reply(
      `${TYPE_LABEL[parts[2]]} مربوطه رو همینجا بفرستید (به‌عنوان عکس/ویدیو/ویس، نه فایل):`,
      { reply_markup: inlineKeyboard([skipCancelRow(false)]) }
    );
  }
}

async function maybeAskPublicReply(ctx: Context, env: Env, userId: string, data: Record<string, unknown>) {
  if (data.source === "comment" || data.source === "both") {
    await setState(env.DB, userId, "kw_public_reply", data);
    return ctx.reply("متن پاسخ عمومی که زیر کامنت نمایش داده بشه رو هم بفرستید (یا رد کنید):", {
      reply_markup: inlineKeyboard([skipCancelRow(true)]),
    });
  }
  return saveKeyword(ctx, env, userId, data);
}

async function saveKeyword(ctx: Context, env: Env, userId: string, data: Record<string, unknown>) {
  await env.DB.prepare(
    `INSERT INTO keywords (ig_account_id, trigger_word, match_type, source, response_type, response_content, public_reply_text, is_active)
     VALUES (?, ?, 'contains', ?, ?, ?, ?, 1)`
  )
    .bind(
      data.ig_account_id,
      data.trigger_word,
      data.source,
      data.response_type,
      data.response_content,
      data.public_reply_text || null
    )
    .run();
  await clearState(env.DB, userId);
  await ctx.reply("✅ ذخیره شد.");
  await renderKeywordsList(ctx, env, data.ig_account_id as number);
}

/** ورودی متنی، وقتی یک pending_action مربوط به این فلو باشه. */
export async function handleKeywordsWizardText(ctx: Context, env: Env, state: PendingState, text: string) {
  const userId = ctx.from!.id.toString();

  if (state.action === "kw_trigger") {
    state.data.trigger_word = text.trim();
    await setState(env.DB, userId, "kw_source", state.data);
    return ctx.reply("این پاسخ برای دایرکت باشه، کامنت، یا هردو؟", {
      reply_markup: inlineKeyboard([
        [btn("دایرکت", "kw:source:dm", "primary")],
        [btn("کامنت", "kw:source:comment", "primary")],
        [btn("هردو", "kw:source:both", "primary")],
        skipCancelRow(false),
      ]),
    });
  }

  if (state.action === "kw_content_text") {
    state.data.response_content = text.trim();
    return maybeAskPublicReply(ctx, env, userId, state.data);
  }

  if (state.action === "kw_public_reply") {
    state.data.public_reply_text = text.trim();
    return saveKeyword(ctx, env, userId, state.data);
  }

  if (state.action === "kw_content_media") {
    return ctx.reply("این مرحله منتظر یک فایل عکس/ویدیو/ویسه، نه متن. لطفاً فایل رو بفرستید (یا «❌ انصراف» رو بزنید).");
  }
}

/** ورودی رسانه‌ای (عکس/ویدیو/ویس)، وقتی pending_action == 'kw_content_media' باشه. */
export async function handleKeywordsWizardMedia(
  ctx: Context,
  env: Env,
  state: PendingState,
  fromChatId: number,
  messageId: number
) {
  const userId = ctx.from!.id.toString();
  const channelId = await getMediaChannelId(env.DB);
  if (!channelId) return ctx.reply("اول باید کانال رسانه رو وصل کنید — از منوی «⚙️ تنظیمات».");

  await ctx.reply("در حال بایگانی در کانال رسانه...");
  try {
    const forwarded = await forwardMediaToChannel(env.TELEGRAM_BOT_TOKEN, channelId, fromChatId.toString(), messageId);
    state.data.response_content = forwarded.fileId; // فقط file_id ذخیره می‌شه؛ لینک واقعی موقع ارسال ساخته می‌شه
    await maybeAskPublicReply(ctx, env, userId, state.data);
  } catch (err) {
    await ctx.reply(`❌ ناموفق بود: ${(err as Error).message}`);
  }
}

/** وقتی کاربر «رد کردن» رو بزنه (فقط برای مرحله‌ی اختیاری public_reply معنا داره). */
export async function handleKeywordsSkip(ctx: Context, env: Env, state: PendingState) {
  const userId = ctx.from!.id.toString();
  if (state.action === "kw_public_reply") {
    return saveKeyword(ctx, env, userId, state.data);
  }
}

export { renderKeywordsList };
