import type { Context } from "grammy";
import type { Env } from "../../index";
import { btn, inlineKeyboard, skipCancelRow } from "../ui";
import { setState, clearState, getState, type PendingState } from "../state";
import { resolveOrAskPage } from "./pageselect";

type FuRow = { id: number; trigger_event: string; delay_hours: number; is_active: number };

function triggerLabel(t: string) {
  return t === "first_message" ? "بعد از اولین پیام" : `بعد از کلمه‌ی کلیدی`;
}

async function renderFollowupList(ctx: Context, env: Env, igAccountId: number) {
  const { results } = await env.DB.prepare(
    "SELECT id, trigger_event, delay_hours, is_active FROM followups WHERE ig_account_id = ? ORDER BY id DESC"
  )
    .bind(igAccountId)
    .all<FuRow>();

  const rows = results.map((f) => [
    btn(`${f.is_active ? "🟢" : "⚪️"} ${triggerLabel(f.trigger_event)} + ${f.delay_hours} ساعت`, `fu:view:${f.id}`),
  ]);
  rows.push([btn("➕ افزودن فالوآپ", `fu:add:${igAccountId}`, "primary")]);

  await ctx.reply(results.length ? "قوانین فالوآپ این پیج:" : "هنوز فالوآپی تعریف نشده.\n\n⚠️ توجه: اینستاگرام فقط تا ۲۴ ساعت بعد از آخرین پیام کاربر (یا حداکثر ۷ روز با شرایط خاص) اجازه‌ی پیام آزاد می‌ده، پس تأخیر رو منطقی انتخاب کنید.", {
    reply_markup: inlineKeyboard(rows),
  });
}

async function renderFollowupDetail(ctx: Context, env: Env, id: number) {
  const row = await env.DB.prepare(
    "SELECT id, ig_account_id, trigger_event, delay_hours, is_active FROM followups WHERE id = ?"
  )
    .bind(id)
    .first<FuRow & { ig_account_id: number }>();
  if (!row) return ctx.reply("این مورد دیگه پیدا نشد.");

  await ctx.reply(`${triggerLabel(row.trigger_event)}\nتأخیر: ${row.delay_hours} ساعت`, {
    reply_markup: inlineKeyboard([
      [
        row.is_active
          ? btn("⚪️ غیرفعال کردن", `fu:toggle:${row.id}`)
          : btn("🟢 فعال کردن", `fu:toggle:${row.id}`, "success"),
      ],
      [btn("🗑 حذف", `fu:delcfm:${row.id}`, "danger")],
      [btn("‹ بازگشت به لیست", `fu:list:${row.ig_account_id}`)],
    ]),
  });
}

export async function handleFollowupMenuEntry(ctx: Context, env: Env) {
  const id = await resolveOrAskPage(ctx, env, "fulist");
  if (id) await renderFollowupList(ctx, env, id);
}

export async function handleFollowupCallback(ctx: Context, env: Env, data: string) {
  const parts = data.split(":");
  const action = parts[1];
  const userId = ctx.from!.id.toString();

  if (action === "list") return renderFollowupList(ctx, env, Number(parts[2]));
  if (action === "view") return renderFollowupDetail(ctx, env, Number(parts[2]));

  if (action === "toggle") {
    await env.DB.prepare("UPDATE followups SET is_active = 1 - is_active WHERE id = ?").bind(Number(parts[2])).run();
    await ctx.answerCallbackQuery({ text: "به‌روزرسانی شد." });
    return renderFollowupDetail(ctx, env, Number(parts[2]));
  }

  if (action === "delcfm") {
    const id = Number(parts[2]);
    return ctx.editMessageText("مطمئنید حذف بشه؟", {
      reply_markup: inlineKeyboard([[btn("بله، حذف کن", `fu:delyes:${id}`, "danger"), btn("انصراف", `fu:view:${id}`)]]),
    });
  }

  if (action === "delyes") {
    const id = Number(parts[2]);
    const row = await env.DB.prepare("SELECT ig_account_id FROM followups WHERE id = ?").bind(id).first<{ ig_account_id: number }>();
    await env.DB.prepare("DELETE FROM followups WHERE id = ?").bind(id).run();
    await ctx.answerCallbackQuery({ text: "حذف شد." });
    if (row) return renderFollowupList(ctx, env, row.ig_account_id);
    return;
  }

  if (action === "add") {
    const igAccountId = Number(parts[2]);
    const { results: keywords } = await env.DB.prepare(
      "SELECT id, trigger_word FROM keywords WHERE ig_account_id = ? AND is_active = 1"
    )
      .bind(igAccountId)
      .all<{ id: number; trigger_word: string }>();

    const rows = [[btn("بعد از اولین پیام", "fu:trg:first_message", "primary")]];
    for (const k of keywords) rows.push([btn(`بعد از «${k.trigger_word}»`, `fu:trg:kw${k.id}`, "primary")]);
    rows.push(skipCancelRow(false));

    await setState(env.DB, userId, "fu_trigger_pick", { ig_account_id: igAccountId });
    return ctx.reply("این فالوآپ کِی شروع بشه؟", { reply_markup: inlineKeyboard(rows) });
  }

  if (action === "trg") {
    const state = await getState(env.DB, userId);
    if (!state) return;
    state.data.trigger_event = parts[2];
    await setState(env.DB, userId, "fu_delay", state.data);
    return ctx.reply("چند ساعت بعد ارسال بشه؟ فقط عدد بفرستید (مثلاً 3):", {
      reply_markup: inlineKeyboard([skipCancelRow(false)]),
    });
  }
}

async function saveFollowup(ctx: Context, env: Env, userId: string, data: Record<string, unknown>) {
  await env.DB.prepare(
    `INSERT INTO followups (ig_account_id, trigger_event, delay_hours, message_content, is_active)
     VALUES (?, ?, ?, ?, 1)`
  )
    .bind(data.ig_account_id, data.trigger_event, data.delay_hours, data.message_content)
    .run();
  await clearState(env.DB, userId);
  await ctx.reply("✅ فالوآپ ذخیره شد.");
  await renderFollowupList(ctx, env, data.ig_account_id as number);
}

export async function handleFollowupWizardText(ctx: Context, env: Env, state: PendingState, text: string) {
  const userId = ctx.from!.id.toString();

  if (state.action === "fu_delay") {
    const hours = Number(text.trim());
    if (!Number.isFinite(hours) || hours <= 0) {
      return ctx.reply("لطفاً فقط یک عدد مثبت بفرستید (مثلاً 3):");
    }
    state.data.delay_hours = hours;
    await setState(env.DB, userId, "fu_message", state.data);
    return ctx.reply("متن پیام فالوآپ رو بفرستید:", { reply_markup: inlineKeyboard([skipCancelRow(false)]) });
  }

  if (state.action === "fu_message") {
    state.data.message_content = text.trim();
    return saveFollowup(ctx, env, userId, state.data);
  }
}

export { renderFollowupList };
