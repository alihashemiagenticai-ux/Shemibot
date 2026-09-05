import { Bot } from "grammy";
import type { Env } from "../index";
import { MENU, mainMenuKeyboard, CANCEL_DATA, SKIP_DATA } from "./ui";
import { getState, clearState } from "./state";

import { renderPagesList, handlePagesCallback, handlePagesWizardText } from "./flows/pages";
import {
  handleKeywordsMenuEntry,
  handleKeywordsCallback,
  handleKeywordsWizardText,
  handleKeywordsWizardMedia,
  handleKeywordsSkip,
} from "./flows/keywords";
import {
  handleShowcaseMenuEntry,
  handleShowcaseCallback,
  handleShowcaseWizardText,
  handleShowcaseWizardMedia,
  handleShowcaseSkip,
} from "./flows/showcase";
import {
  handleFollowupMenuEntry,
  handleFollowupCallback,
  handleFollowupWizardText,
} from "./flows/followup";
import { renderSettings, handleSettingsCallback, handleSettingsChannelForward } from "./flows/settings";
import { renderKeywordsList } from "./flows/keywords";
import { renderShowcaseList } from "./flows/showcase";
import { renderFollowupList } from "./flows/followup";

const HELP_TEXT =
  "این ربات پنل مدیریت «دایرکت هوشمند» شماست.\n\n" +
  `${MENU.PAGES} — وصل‌کردن/مدیریت پیج‌های اینستاگرام\n` +
  `${MENU.SMART_REPLY} — پاسخ خودکار به کلمه‌ی کلیدی در دایرکت/کامنت\n` +
  `${MENU.SHOWCASE} — نمایش محصولات در دایرکت\n` +
  `${MENU.FOLLOWUP} — پیام پیگیری خودکار بعد از مدتی\n` +
  `${MENU.SETTINGS} — اتصال کانال رسانه (برای پاسخ‌های عکس/ویدیو/صدا)\n\n` +
  "هر پیامی که این ربات براتون بفرسته دقیقاً همونیه که خودتون در همین بخش‌ها تنظیم کردید — " +
  "محتوا و مسئولیت محتوای پاسخ‌ها کاملاً با خودتونه.";

export function createBot(env: Env) {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // فقط ادمین(های) مجاز اجازه‌ی استفاده از این ربات رو دارن.
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const isAllowed = await env.DB.prepare("SELECT 1 FROM admins WHERE telegram_user_id = ?").bind(userId).first();
    if (!isAllowed && userId !== env.ADMIN_TELEGRAM_ID) {
      return ctx.reply("این ربات خصوصیه و شما دسترسی ندارید.");
    }
    if (!isAllowed) {
      await env.DB.prepare("INSERT OR IGNORE INTO admins (telegram_user_id, added_at) VALUES (?, ?)")
        .bind(userId, Date.now())
        .run();
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await clearState(env.DB, ctx.from!.id.toString());
    await ctx.reply("خوش اومدید 👋 از دکمه‌های پایین صفحه استفاده کنید:", {
      reply_markup: mainMenuKeyboard(),
    });
  });

  // --- کیبورد پایین صفحه (منوی اصلی) ---
  bot.hears(MENU.PAGES, (ctx) => renderPagesList(ctx, env));
  bot.hears(MENU.SMART_REPLY, (ctx) => handleKeywordsMenuEntry(ctx, env));
  bot.hears(MENU.SHOWCASE, (ctx) => handleShowcaseMenuEntry(ctx, env));
  bot.hears(MENU.FOLLOWUP, (ctx) => handleFollowupMenuEntry(ctx, env));
  bot.hears(MENU.SETTINGS, (ctx) => renderSettings(ctx, env));
  bot.hears(MENU.HELP, (ctx) => ctx.reply(HELP_TEXT, { reply_markup: mainMenuKeyboard() }));

  // --- دکمه‌های شیشه‌ای (callback_query) ---
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id.toString();
    await ctx.answerCallbackQuery(); // برداشتن حالت لودینگ روی دکمه

    if (data === CANCEL_DATA) {
      await clearState(env.DB, userId);
      await ctx.reply("لغو شد.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (data === SKIP_DATA) {
      const state = await getState(env.DB, userId);
      if (!state) return;
      if (state.action.startsWith("kw_")) return handleKeywordsSkip(ctx, env, state);
      if (state.action.startsWith("sc_")) return handleShowcaseSkip(ctx, env, state);
      return;
    }

    if (data.startsWith("pgsel:")) {
      const [, flow, idStr] = data.split(":");
      const id = Number(idStr);
      if (flow === "kwlist") return renderKeywordsList(ctx, env, id);
      if (flow === "sclist") return renderShowcaseList(ctx, env, id);
      if (flow === "fulist") return renderFollowupList(ctx, env, id);
      return;
    }

    if (data.startsWith("pages:")) return handlePagesCallback(ctx, env, data);
    if (data.startsWith("kw:")) return handleKeywordsCallback(ctx, env, data);
    if (data.startsWith("sc:")) return handleShowcaseCallback(ctx, env, data);
    if (data.startsWith("fu:")) return handleFollowupCallback(ctx, env, data);
    if (data.startsWith("settings:")) return handleSettingsCallback(ctx, env, data);
  });

  // --- بررسی زودهنگام: آیا این یک پیامِ فوروارد‌شده برای اتصال کانال رسانه‌ست؟ ---
  // اگه بله، همینجا رسیدگی می‌شه و به هندلرهای بعدی نمی‌رسه؛ وگرنه next() یعنی «به من مربوط نبود».
  bot.on("message", async (ctx, next) => {
    const handled = await handleSettingsChannelForward(ctx, env);
    if (!handled) await next();
  });

  // --- پیام متنی معمولی: یا ورودیِ یکی از فلوهای چندمرحله‌ایه، یا هیچی ---
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from.id.toString();
    const state = await getState(env.DB, userId);
    if (!state) return; // نه فلوی بازی هست، نه یکی از دکمه‌های منو (که با hears هندل شدن)

    const text = ctx.message.text;
    if (state.action.startsWith("pages_")) return handlePagesWizardText(ctx, env, state, text);
    if (state.action.startsWith("kw_")) return handleKeywordsWizardText(ctx, env, state, text);
    if (state.action.startsWith("sc_")) return handleShowcaseWizardText(ctx, env, state, text);
    if (state.action.startsWith("fu_")) return handleFollowupWizardText(ctx, env, state, text);
  });

  // --- عکس/ویدیو/ویس: فقط وقتی منتظرشیم (فلوی پاسخ هوشمند یا ویترین) ---
  bot.on(["message:photo", "message:video", "message:voice"], async (ctx) => {
    const userId = ctx.from.id.toString();
    const state = await getState(env.DB, userId);
    if (!state) return;

    const hasMedia = ctx.message.photo || ctx.message.video || ctx.message.voice;
    if (!hasMedia) return;

    if (state.action === "kw_content_media") {
      return handleKeywordsWizardMedia(ctx, env, state, ctx.chat.id, ctx.message.message_id);
    }
    if (state.action === "sc_photo") {
      return handleShowcaseWizardMedia(ctx, env, state, ctx.chat.id, ctx.message.message_id);
    }
  });

  return bot;
}
