-- دایرکت هوشمند اینستاگرام — طرح پایگاه داده (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS admins (
  telegram_user_id TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ig_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id TEXT NOT NULL UNIQUE,
  ig_username TEXT,
  access_token TEXT NOT NULL,
  token_last_refreshed_at INTEGER NOT NULL,
  token_expires_at INTEGER NOT NULL,
  connected_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  follow_gate_enabled INTEGER NOT NULL DEFAULT 0,  -- فالو اجباری (اختیاری، پیش‌فرض خاموش)
  follow_gate_message TEXT                          -- متن دلخواه صاحب پیج برای درخواست فالو
);

-- کسانی که یک‌بار روی دکمه‌ی «فالو کردم» زدن، برای هر پیج جدا — تا فالو اجباری
-- دوباره از اول برای همون شخص تکرار نشه
CREATE TABLE IF NOT EXISTS follow_gate_confirmations (
  ig_account_id INTEGER NOT NULL REFERENCES ig_accounts(id),
  recipient_scoped_id TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (ig_account_id, recipient_scoped_id)
);

-- پاسخ هوشمند + کامنت/لایو هوشمند (یک جدول، چون هر دو کلمه‌کلیدی‌محورن)
CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_account_id INTEGER NOT NULL REFERENCES ig_accounts(id),
  trigger_word TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains',   -- exact | contains
  source TEXT NOT NULL DEFAULT 'both',           -- dm | comment | both
  response_type TEXT NOT NULL DEFAULT 'text',    -- text | voice | image | video | showcase
  response_content TEXT NOT NULL,
  public_reply_text TEXT,                        -- فقط برای source=comment، پاسخ عمومی زیر کامنت
  is_active INTEGER NOT NULL DEFAULT 1
);

-- ویترین‌ساز
CREATE TABLE IF NOT EXISTS showcase_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_account_id INTEGER NOT NULL REFERENCES ig_accounts(id),
  title TEXT NOT NULL,
  price_label TEXT,
  image_url TEXT,
  link_url TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- تعریف قانون‌های فالوآپ
CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_account_id INTEGER NOT NULL REFERENCES ig_accounts(id),
  trigger_event TEXT NOT NULL,     -- مثلا first_message یا keyword:<id>
  delay_hours INTEGER NOT NULL,
  message_content TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- صف واقعی اجرای فالوآپ‌ها؛ Cron روزانه این جدول رو پردازش می‌کنه
CREATE TABLE IF NOT EXISTS followup_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_account_id INTEGER NOT NULL REFERENCES ig_accounts(id),
  followup_id INTEGER NOT NULL REFERENCES followups(id),
  recipient_scoped_id TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  sent_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'   -- pending | sent | failed | skipped_window_closed
);

-- تنظیمات عمومی این نمونه از ربات (مثلاً آیدی کانال رسانه)
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- وضعیت موقت مکالمه‌ی هر ادمین در ربات (برای فلوهای چندمرحله‌ای دکمه‌ای، به‌جای دستورات اسلش)
CREATE TABLE IF NOT EXISTS bot_state (
  telegram_user_id TEXT PRIMARY KEY,
  pending_action TEXT,
  pending_data TEXT,   -- JSON
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_keywords_ig_account ON keywords(ig_account_id);
CREATE INDEX IF NOT EXISTS idx_showcase_ig_account ON showcase_products(ig_account_id);
CREATE INDEX IF NOT EXISTS idx_followup_queue_due ON followup_queue(status, scheduled_for);
