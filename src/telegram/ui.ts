// کمک‌کننده‌های رابط کاربری: دکمه‌های شیشه‌ای (inline) رنگی + کیبورد پایین صفحه (reply keyboard).
//
// از Bot API 9.4 (۹ فوریه‌ی ۲۰۲۶) تلگرام یک فیلد "style" به دکمه‌ها اضافه کرده که اجازه می‌ده
// رنگ دکمه رو مشخص کنیم: "primary" (آبی)، "success" (سبز)، "danger" (قرمز).
// این ماژول به‌جای تکیه به متدهای کمکی کتابخانه (که ممکنه هنوز این فیلد جدید رو نداشته باشن)،
// مستقیم همون ساختار JSON مستندشده‌ی Bot API رو می‌سازه — تا مطمئن باشیم همیشه کار می‌کنه.

export type ButtonStyle = "primary" | "success" | "danger";

export interface InlineBtn {
  text: string;
  callback_data: string;
  style?: ButtonStyle;
}

/** ساخت یک دکمه‌ی شیشه‌ای، با رنگ اختیاری. */
export function btn(text: string, callback_data: string, style?: ButtonStyle): InlineBtn {
  return style ? { text, callback_data, style } : { text, callback_data };
}

/** ساخت reply_markup برای کیبورد شیشه‌ای از روی چند ردیف دکمه. */
export function inlineKeyboard(rows: InlineBtn[][]) {
  return { inline_keyboard: rows };
}

/** ساخت reply_markup برای کیبورد پایین صفحه (منوی همیشه‌دیده) از روی چند ردیف برچسب متنی. */
export function replyKeyboard(rows: string[][]) {
  return {
    keyboard: rows.map((row) => row.map((text) => ({ text }))),
    resize_keyboard: true,
    is_persistent: true,
  };
}

// برچسب‌های منوی اصلی — همه‌جا از همین ثابت‌ها استفاده می‌کنیم تا تطبیق متن دقیق بمونه
export const MENU = {
  PAGES: "🔗 پیج‌های من",
  SMART_REPLY: "💬 پاسخ هوشمند",
  SHOWCASE: "🛍 ویترین",
  FOLLOWUP: "🔁 فالوآپ",
  SETTINGS: "⚙️ تنظیمات",
  HELP: "ℹ️ راهنما",
} as const;

export function mainMenuKeyboard() {
  return replyKeyboard([
    [MENU.PAGES, MENU.SMART_REPLY],
    [MENU.SHOWCASE, MENU.FOLLOWUP],
    [MENU.SETTINGS, MENU.HELP],
  ]);
}

export const SKIP_DATA = "wizard:skip";
export const CANCEL_DATA = "wizard:cancel";

export function skipCancelRow(includeSkip: boolean): InlineBtn[] {
  const row: InlineBtn[] = [];
  if (includeSkip) row.push(btn("رد کردن این مرحله", SKIP_DATA));
  row.push(btn("❌ انصراف", CANCEL_DATA, "danger"));
  return row;
}
