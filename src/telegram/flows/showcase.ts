import type { Context } from "grammy";
import type { Env } from "../../index";
import { btn, inlineKeyboard, skipCancelRow } from "../ui";
import { setState, clearState, getState, type PendingState } from "../state";
import { resolveOrAskPage } from "./pageselect";
import { forwardMediaToChannel } from "../../instagram/media";
import { getMediaChannelId } from "./settings";

type ScRow = { id: number; title: string; price_label: string | null; is_active: number };

async function renderShowcaseList(ctx: Context, env: Env, igAccountId: number) {
  const { results } = await env.DB.prepare(
    "SELECT id, title, price_label, is_active FROM showcase_products WHERE ig_account_id = ? ORDER BY display_order, id"
  )
    .bind(igAccountId)
    .all<ScRow>();

  const rows = results.map((p) => [
    btn(`${p.is_active ? "🟢" : "⚪️"} ${p.title}${p.price_label ? " — " + p.price_label : ""}`, `sc:view:${p.id}`),
  ]);
  rows.push([btn("➕ افزودن محصول", `sc:add:${igAccountId}`, "primary")]);

  await ctx.reply(results.length ? "محصولات ویترین این پیج:" : "هنوز محصولی اضافه نشده.", {
    reply_markup: inlineKeyboard(rows),
  });
}

async function renderShowcaseDetail(ctx: Context, env: Env, id: number) {
  const row = await env.DB.prepare(
    "SELECT id, ig_account_id, title, price_label, is_active FROM showcase_products WHERE id = ?"
  )
    .bind(id)
    .first<ScRow & { ig_account_id: number }>();
  if (!row) return ctx.reply("این محصول دیگه پیدا نشد.");

  await ctx.reply(`${row.title}${row.price_label ? "\nقیمت: " + row.price_label : ""}`, {
    reply_markup: inlineKeyboard([
      [
        row.is_active
          ? btn("⚪️ غیرفعال کردن", `sc:toggle:${row.id}`)
          : btn("🟢 فعال کردن", `sc:toggle:${row.id}`, "success"),
      ],
      [btn("🗑 حذف", `sc:delcfm:${row.id}`, "danger")],
      [btn("‹ بازگشت به لیست", `sc:list:${row.ig_account_id}`)],
    ]),
  });
}

export async function handleShowcaseMenuEntry(ctx: Context, env: Env) {
  const id = await resolveOrAskPage(ctx, env, "sclist");
  if (id) await renderShowcaseList(ctx, env, id);
}

export async function handleShowcaseCallback(ctx: Context, env: Env, data: string) {
  const parts = data.split(":");
  const action = parts[1];
  const userId = ctx.from!.id.toString();

  if (action === "list") return renderShowcaseList(ctx, env, Number(parts[2]));
  if (action === "view") return renderShowcaseDetail(ctx, env, Number(parts[2]));

  if (action === "toggle") {
    await env.DB.prepare("UPDATE showcase_products SET is_active = 1 - is_active WHERE id = ?").bind(Number(parts[2])).run();
    await ctx.answerCallbackQuery({ text: "به‌روزرسانی شد." });
    return renderShowcaseDetail(ctx, env, Number(parts[2]));
  }

  if (action === "delcfm") {
    const id = Number(parts[2]);
    return ctx.editMessageText("مطمئنید حذف بشه؟", {
      reply_markup: inlineKeyboard([[btn("بله، حذف کن", `sc:delyes:${id}`, "danger"), btn("انصراف", `sc:view:${id}`)]]),
    });
  }

  if (action === "delyes") {
    const id = Number(parts[2]);
    const row = await env.DB.prepare("SELECT ig_account_id FROM showcase_products WHERE id = ?").bind(id).first<{ ig_account_id: number }>();
    await env.DB.prepare("DELETE FROM showcase_products WHERE id = ?").bind(id).run();
    await ctx.answerCallbackQuery({ text: "حذف شد." });
    if (row) return renderShowcaseList(ctx, env, row.ig_account_id);
    return;
  }

  if (action === "add") {
    await setState(env.DB, userId, "sc_title", { ig_account_id: Number(parts[2]) });
    return ctx.reply("عنوان محصول رو بفرستید:", { reply_markup: inlineKeyboard([skipCancelRow(false)]) });
  }
}

async function saveProduct(ctx: Context, env: Env, userId: string, data: Record<string, unknown>) {
  await env.DB.prepare(
    `INSERT INTO showcase_products (ig_account_id, title, price_label, image_url, link_url, display_order, is_active)
     VALUES (?, ?, ?, ?, ?, 0, 1)`
  )
    .bind(data.ig_account_id, data.title, data.price_label || null, data.image_url || null, data.link_url || null)
    .run();
  await clearState(env.DB, userId);
  await ctx.reply("✅ محصول اضافه شد.");
  await renderShowcaseList(ctx, env, data.ig_account_id as number);
}

export async function handleShowcaseWizardText(ctx: Context, env: Env, state: PendingState, text: string) {
  const userId = ctx.from!.id.toString();
  const trimmed = text.trim();

  if (state.action === "sc_title") {
    state.data.title = trimmed;
    await setState(env.DB, userId, "sc_price", state.data);
    return ctx.reply("قیمت رو بفرستید (یا رد کنید):", { reply_markup: inlineKeyboard([skipCancelRow(true)]) });
  }
  if (state.action === "sc_price") {
    state.data.price_label = trimmed;
    await setState(env.DB, userId, "sc_photo", state.data);
    return ctx.reply("یک عکس از محصول بفرستید (یا رد کنید):", { reply_markup: inlineKeyboard([skipCancelRow(true)]) });
  }
  if (state.action === "sc_link") {
    state.data.link_url = trimmed;
    return saveProduct(ctx, env, userId, state.data);
  }
  if (state.action === "sc_photo") {
    return ctx.reply("این مرحله منتظر یک عکسه، نه متن. لطفاً عکس رو بفرستید یا «رد کردن این مرحله» رو بزنید.");
  }
}

export async function handleShowcaseWizardMedia(
  ctx: Context,
  env: Env,
  state: PendingState,
  fromChatId: number,
  messageId: number
) {
  if (state.action !== "sc_photo") return;
  const userId = ctx.from!.id.toString();

  const channelId = await getMediaChannelId(env.DB);
  if (!channelId) {
    return ctx.reply("اول باید کانال رسانه رو وصل کنید — از منوی «⚙️ تنظیمات» — سپس دوباره عکس رو بفرستید.");
  }

  await ctx.reply("در حال بایگانی در کانال رسانه...");
  try {
    const forwarded = await forwardMediaToChannel(env.TELEGRAM_BOT_TOKEN, channelId, fromChatId.toString(), messageId);
    state.data.image_url = forwarded.fileId; // فقط file_id ذخیره می‌شه؛ لینک واقعی موقع ارسال ساخته می‌شه
    await setState(env.DB, userId, "sc_link", state.data);
    await ctx.reply("لینک (مثلاً صفحه‌ی خرید) رو بفرستید (یا رد کنید):", {
      reply_markup: inlineKeyboard([skipCancelRow(true)]),
    });
  } catch (err) {
    await ctx.reply(`❌ ناموفق بود: ${(err as Error).message}`);
  }
}

export async function handleShowcaseSkip(ctx: Context, env: Env, state: PendingState) {
  const userId = ctx.from!.id.toString();
  if (state.action === "sc_price") {
    await setState(env.DB, userId, "sc_photo", state.data);
    return ctx.reply("یک عکس از محصول بفرستید (یا رد کنید):", { reply_markup: inlineKeyboard([skipCancelRow(true)]) });
  }
  if (state.action === "sc_photo") {
    await setState(env.DB, userId, "sc_link", state.data);
    return ctx.reply("لینک رو بفرستید (یا رد کنید):", { reply_markup: inlineKeyboard([skipCancelRow(true)]) });
  }
  if (state.action === "sc_link") {
    return saveProduct(ctx, env, userId, state.data);
  }
}

export { renderShowcaseList };
