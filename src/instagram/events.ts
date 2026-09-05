import type { Env } from "../index";
import {
  sendTextMessage,
  sendMediaMessage,
  sendShowcase,
  sendFollowGateButtons,
  checkIsFollowingBusiness,
  postPublicCommentReply,
  type Recipient,
} from "./api";

type IgAccountRow = {
  id: number;
  access_token: string;
  ig_username: string | null;
  follow_gate_enabled: number;
  follow_gate_message: string | null;
};

type KeywordRow = {
  id: number;
  trigger_word: string;
  match_type: string;
  response_type: string;
  response_content: string;
  public_reply_text: string | null;
};

const ACCOUNT_FIELDS = "id, access_token, ig_username, follow_gate_enabled, follow_gate_message";
const KEYWORD_FIELDS = "id, trigger_word, match_type, response_type, response_content, public_reply_text";

function findMatch(text: string, keywords: KeywordRow[]): KeywordRow | undefined {
  const normalized = text.trim().toLowerCase();
  return keywords.find((k) => {
    const trigger = k.trigger_word.trim().toLowerCase();
    return k.match_type === "exact" ? normalized === trigger : normalized.includes(trigger);
  });
}

async function hasConfirmedFollow(env: Env, igAccountId: number, recipientScopedId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM follow_gate_confirmations WHERE ig_account_id = ? AND recipient_scoped_id = ?"
  )
    .bind(igAccountId, recipientScopedId)
    .first();
  return !!row;
}

async function recordFollowConfirmed(env: Env, igAccountId: number, recipientScopedId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO follow_gate_confirmations (ig_account_id, recipient_scoped_id, confirmed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(ig_account_id, recipient_scoped_id) DO NOTHING`
  )
    .bind(igAccountId, recipientScopedId, Date.now())
    .run();
}

/** پاسخ هوشمند رو طبق نوعش (متن/عکس/ویدیو/صدا/ویترین) می‌فرسته. */
async function sendKeywordResponse(
  env: Env,
  accessToken: string,
  igUserId: string,
  origin: string,
  recipient: Recipient,
  igAccountId: number,
  keyword: KeywordRow
) {
  if (keyword.response_type === "text") {
    return sendTextMessage(env.IG_API_VERSION, accessToken, igUserId, recipient, keyword.response_content);
  }

  if (keyword.response_type === "showcase") {
    const { results } = await env.DB.prepare(
      "SELECT id, title, price_label, link_url FROM showcase_products WHERE ig_account_id = ? AND is_active = 1 ORDER BY display_order, id"
    )
      .bind(igAccountId)
      .all<{ id: number; title: string; price_label: string | null; link_url: string | null }>();

    const cards = results.map((p) => ({
      title: p.title,
      subtitle: p.price_label || undefined,
      imageUrl: `${origin}/media/showcase/${p.id}`,
      buttonUrl: p.link_url || undefined,
    }));
    return sendShowcase(env.IG_API_VERSION, accessToken, igUserId, recipient, cards);
  }

  const mediaType = keyword.response_type === "voice" ? "audio" : (keyword.response_type as "image" | "video");
  const mediaUrl = `${origin}/media/keyword/${keyword.id}`;
  return sendMediaMessage(env.IG_API_VERSION, accessToken, igUserId, recipient, mediaType, mediaUrl);
}

async function sendGatePrompt(env: Env, account: IgAccountRow, igUserId: string, recipient: Recipient, keyword: KeywordRow) {
  const message =
    account.follow_gate_message ||
    `برای دریافت این محتوا، لطفاً ابتدا پیج ما رو فالو کنید${account.ig_username ? ` (@${account.ig_username})` : ""}، بعد روی دکمه‌ی زیر بزنید.`;
  return sendFollowGateButtons(env.IG_API_VERSION, account.access_token, igUserId, recipient, message, account.ig_username, keyword.id);
}

/**
 * قبل از فرستادنِ پاسخ واقعی، اگه «فالو اجباری» روشن باشه و این شخص هنوز تأیید نکرده باشه:
 *  - مسیر دایرکت (allowImmediateCheck=true): چون کاربر همین الان به ما پیام داده، طبق تعریف
 *    متا «رضایت» از قبل ثبته، پس همین‌جا یک تلاش واقعی برای چک‌کردن is_user_follow_business
 *    می‌کنیم — اگه واقعاً فالوئره، بدون هیچ مزاحمتی محتوا رو مستقیم می‌گیره.
 *  - مسیر کامنت (allowImmediateCheck=false): چون صرفِ کامنت‌گذاشتن رضایتی ثبت نمی‌کنه، طبق
 *    مستندات متا اصلاً مجاز به چک‌کردن پروفایل نیستیم؛ همیشه اول دکمه‌ها رو نشون می‌دیم، و
 *    چک واقعی فقط لحظه‌ی تپ‌کردن (پایین همین فایل) انجام می‌شه.
 * در هر دو حالت، اگه چک واقعی به هر دلیلی خطا بده، پیش‌فرض امن نشون‌دادن دکمه‌هاست.
 */
async function deliverWithOptionalGate(
  env: Env,
  account: IgAccountRow,
  igUserId: string,
  origin: string,
  recipient: Recipient,
  recipientScopedId: string,
  keyword: KeywordRow,
  allowImmediateCheck: boolean
) {
  const gateOn = account.follow_gate_enabled === 1;
  if (!gateOn || (await hasConfirmedFollow(env, account.id, recipientScopedId))) {
    return sendKeywordResponse(env, account.access_token, igUserId, origin, recipient, account.id, keyword);
  }

  if (allowImmediateCheck) {
    try {
      const following = await checkIsFollowingBusiness(env.IG_API_VERSION, account.access_token, recipientScopedId);
      if (following) {
        await recordFollowConfirmed(env, account.id, recipientScopedId);
        return sendKeywordResponse(env, account.access_token, igUserId, origin, recipient, account.id, keyword);
      }
    } catch (err) {
      console.error("چک فوریِ فالو ممکن نشد (نمایش دکمه به‌جای اون):", (err as Error).message);
    }
  }

  return sendGatePrompt(env, account, igUserId, recipient, keyword);
}

async function enqueueFollowupsIfAny(env: Env, igAccountId: number, recipientScopedId: string, triggerEvent: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, delay_hours FROM followups WHERE ig_account_id = ? AND trigger_event = ? AND is_active = 1"
  )
    .bind(igAccountId, triggerEvent)
    .all<{ id: number; delay_hours: number }>();

  for (const f of results) {
    const already = await env.DB.prepare(
      "SELECT 1 FROM followup_queue WHERE ig_account_id = ? AND followup_id = ? AND recipient_scoped_id = ?"
    )
      .bind(igAccountId, f.id, recipientScopedId)
      .first();
    if (already) continue;

    await env.DB.prepare(
      `INSERT INTO followup_queue (ig_account_id, followup_id, recipient_scoped_id, scheduled_for, status)
       VALUES (?, ?, ?, ?, 'pending')`
    )
      .bind(igAccountId, f.id, recipientScopedId, Date.now() + f.delay_hours * 60 * 60 * 1000)
      .run();
  }
}

/**
 * وقتی دکمه‌ی «✅ فالو کردم» زده می‌شه. الان که کاربر خودش تعامل کرده، «رضایت» طبق تعریف متا
 * ثبت شده، پس یک تلاش واقعی برای چک‌کردن is_user_follow_business می‌کنیم:
 *  - اگه true برگشت → محتوا ارسال و تأیید ذخیره می‌شه.
 *  - اگه صراحتاً false برگشت → مؤدبانه دوباره همون دکمه‌ها رو می‌فرستیم (واقعاً فالو نکرده).
 *  - اگه خودِ چک با خطا مواجه بشه (چون این فیلد رسمی فقط زیر مسیر قدیمی‌تر تأیید شده، ممکنه
 *    روی مسیر ما پشتیبانی نشه) → به تپ‌کردن کاربر اعتماد می‌کنیم (روش خوداظهاری، fallback امن).
 */
async function handleFollowGatePostbackTap(env: Env, igUserId: string, senderId: string, keywordId: number, origin: string) {
  const account = await env.DB.prepare(`SELECT ${ACCOUNT_FIELDS} FROM ig_accounts WHERE ig_user_id = ? AND is_active = 1`)
    .bind(igUserId)
    .first<IgAccountRow>();
  if (!account) return;

  const keyword = await env.DB.prepare(
    `SELECT ${KEYWORD_FIELDS} FROM keywords WHERE id = ? AND ig_account_id = ? AND is_active = 1`
  )
    .bind(keywordId, account.id)
    .first<KeywordRow>();
  if (!keyword) return;

  let shouldDeliver = true; // پیش‌فرض امن: اگه نتونستیم چک کنیم، به تپ کاربر اعتماد می‌کنیم
  try {
    shouldDeliver = await checkIsFollowingBusiness(env.IG_API_VERSION, account.access_token, senderId);
  } catch (err) {
    console.error("چک فالو ممکن نشد (fallback به روش خوداظهاری):", (err as Error).message);
  }

  if (!shouldDeliver) {
    await sendGatePrompt(env, account, igUserId, { id: senderId }, keyword);
    return;
  }

  await recordFollowConfirmed(env, account.id, senderId);
  await sendKeywordResponse(env, account.access_token, igUserId, origin, { id: senderId }, account.id, keyword);
  await enqueueFollowupsIfAny(env, account.id, senderId, `kw${keyword.id}`);
  await enqueueFollowupsIfAny(env, account.id, senderId, "first_message");
}

async function handleDirectMessage(env: Env, igUserId: string, senderId: string, text: string | undefined, origin: string) {
  if (!text) return;

  const account = await env.DB.prepare(`SELECT ${ACCOUNT_FIELDS} FROM ig_accounts WHERE ig_user_id = ? AND is_active = 1`)
    .bind(igUserId)
    .first<IgAccountRow>();
  if (!account) return;

  const { results: keywords } = await env.DB.prepare(
    `SELECT ${KEYWORD_FIELDS} FROM keywords WHERE ig_account_id = ? AND is_active = 1 AND (source = 'dm' OR source = 'both')`
  )
    .bind(account.id)
    .all<KeywordRow>();

  const match = findMatch(text, keywords);
  if (match) {
    await deliverWithOptionalGate(env, account, igUserId, origin, { id: senderId }, senderId, match, true);
    await enqueueFollowupsIfAny(env, account.id, senderId, `kw${match.id}`);
  }
  await enqueueFollowupsIfAny(env, account.id, senderId, "first_message");
}

async function handleComment(env: Env, igUserId: string, commentId: string, senderId: string, text: string | undefined, origin: string) {
  if (!text) return;

  const account = await env.DB.prepare(`SELECT ${ACCOUNT_FIELDS} FROM ig_accounts WHERE ig_user_id = ? AND is_active = 1`)
    .bind(igUserId)
    .first<IgAccountRow>();
  if (!account) return;

  const { results: keywords } = await env.DB.prepare(
    `SELECT ${KEYWORD_FIELDS} FROM keywords WHERE ig_account_id = ? AND is_active = 1 AND (source = 'comment' OR source = 'both')`
  )
    .bind(account.id)
    .all<KeywordRow>();

  const match = findMatch(text, keywords);
  if (!match) return;

  // با recipient={commentId} فرستاده می‌شه — این مکانیزم مخصوص پاسخ به کامنته و برخلاف
  // دایرکت معمولی، نیازی به پیام قبلیِ کاربر نداره (فقط تا ۷ روز بعد از ثبت کامنت).
  await deliverWithOptionalGate(env, account, igUserId, origin, { commentId }, senderId, match, false);
  if (match.public_reply_text) {
    await postPublicCommentReply(env.IG_API_VERSION, account.access_token, commentId, match.public_reply_text);
  }
  await enqueueFollowupsIfAny(env, account.id, senderId, `kw${match.id}`);
}

/**
 * نقطه‌ی ورود اصلی: یک payload خام وبهوک اینستاگرام رو می‌گیره، تشخیص می‌ده دایرکته، کامنت،
 * یا تپِ دکمه‌ی فالو اجباری، و پردازش می‌کنه. هیچ متن پیش‌فرض/اجباری‌ای اضافه نمی‌کنه (به‌جز
 * خودِ پیام فالو اجباری، که اونم اختیاریه و متنش رو خود ادمین می‌نویسه) — دقیقاً همون چیزی
 * فرستاده می‌شه که ادمین در ربات تلگرام تنظیم کرده؛ محتوا و مسئولیتش با خودشونه.
 */
export async function processInstagramWebhookEvent(payload: unknown, env: Env, origin: string): Promise<void> {
  const body = payload as {
    entry?: Array<{
      id: string;
      messaging?: Array<{
        sender: { id: string };
        message?: { text?: string; is_echo?: boolean };
        postback?: { payload?: string };
      }>;
      changes?: Array<{
        field: string;
        value: { id: string; text?: string; from?: { id: string } };
      }>;
    }>;
  };

  for (const entry of body.entry || []) {
    for (const m of entry.messaging || []) {
      const pbPayload = m.postback?.payload;
      if (pbPayload?.startsWith("followgate:")) {
        const keywordId = Number(pbPayload.split(":")[1]);
        if (keywordId) await handleFollowGatePostbackTap(env, entry.id, m.sender.id, keywordId, origin);
        continue;
      }

      if (m.message?.is_echo) continue; // پیامی که خودمون فرستادیم، نه پیام ورودی
      await handleDirectMessage(env, entry.id, m.sender.id, m.message?.text, origin);
    }
    for (const c of entry.changes || []) {
      // "comments" پست/ریلز و "live_comments" لایو، هر دو باید همینجا پردازش بشن.
      if (c.field !== "comments" && c.field !== "live_comments") continue;
      await handleComment(env, entry.id, c.value.id, c.value.from?.id || "", c.value.text, origin);
    }
  }
}
