// توابع کمکی برای تعامل با Instagram Graph API
// مسیر انتخابی: "Business Login for Instagram" — بدون نیاز به پیج فیسبوک، host = graph.instagram.com
// مرجع رسمی: https://developers.facebook.com/docs/instagram-platform/overview/

const IG_HOST = "https://graph.instagram.com";

export interface TokenExchangeResult {
  access_token: string;
  token_type: string;
  expires_in: number; // ثانیه
}

/**
 * تبدیل توکن کوتاه‌مدت (۱ ساعته) به توکن بلندمدت (۶۰ روزه).
 * توکنی که مستقیم از App Dashboard یا Graph API Explorer می‌گیرید معمولاً کوتاه‌مدته،
 * پس همیشه این تابع رو صدا بزنید مگر مطمئن باشید توکن از قبل بلندمدته.
 */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
  appSecret: string
): Promise<TokenExchangeResult> {
  const url = new URL(`${IG_HOST}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("access_token", shortLivedToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`تبدیل توکن ناموفق بود (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * رفرش یک توکن بلندمدت که حداقل ۲۴ ساعت از صدورش گذشته.
 * ۶۰ روز دیگه به عمرش اضافه می‌کنه. این تابع رو Cron روزانه (فاز ۳) صدا می‌زنه.
 */
export async function refreshLongLivedToken(
  longLivedToken: string
): Promise<TokenExchangeResult> {
  const url = new URL(`${IG_HOST}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", longLivedToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`رفرش توکن ناموفق بود (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * یک کال سبک برای اعتبارسنجی توکن و گرفتن مشخصات پیج — برای دستور /connect در ربات.
 */
export async function fetchIgProfile(
  accessToken: string
): Promise<{ user_id: string; username: string }> {
  const url = new URL(`${IG_HOST}/me`);
  url.searchParams.set("fields", "user_id,username");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`توکن معتبر نیست (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * گیرنده‌ی پیام: یا شناسه‌ی کاربر (برای دایرکت معمولی)، یا شناسه‌ی کامنت
 * (برای «ریپلای خصوصی» به یک کامنت — که برخلاف دایرکت معمولی، به پیام قبلی کاربر نیاز نداره،
 * فقط تا ۷ روز بعد از ثبت کامنت معتبره).
 */
export type Recipient = { id: string } | { commentId: string };

function recipientPayload(r: Recipient): Record<string, string> {
  return "id" in r ? { id: r.id } : { comment_id: r.commentId };
}

/**
 * هسته‌ی مشترک همه‌ی توابع ارسال پیام زیر این تابع.
 *
 * مسیر endpoint طبق مستندات فعلی متا برای «Instagram API with Instagram Login»
 * (developers.facebook.com/docs/instagram-platform) همیشه /<IG_ID>/messages هست —
 * نه /me/messages (اون الگو مخصوص Facebook Login/graph.facebook.com بود و روی
 * graph.instagram.com مستند نشده). igUserId همون entry.id هست که در وبهوک ورودی می‌رسه.
 */
async function sendPayload(
  apiVersion: string,
  accessToken: string,
  igUserId: string,
  recipient: Recipient,
  message: Record<string, unknown>
): Promise<void> {
  // طبق مستندات فعلی متا برای «Instagram API with Instagram Login»، مسیر ارسال پیام
  // همیشه /<IG_ID>/messages هست (نه /me/messages که مخصوص Facebook Login/graph.facebook.com بود).
  const res = await fetch(
    `${IG_HOST}/${apiVersion}/${igUserId}/messages?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: recipientPayload(recipient), message }),
    }
  );
  if (!res.ok) {
    throw new Error(`ارسال پیام ناموفق بود (${res.status}): ${await res.text()}`);
  }
}

/** ارسال پیام متنی/لینک. */
export function sendTextMessage(
  apiVersion: string,
  accessToken: string,
  igUserId: string,
  recipient: Recipient,
  text: string
) {
  return sendPayload(apiVersion, accessToken, igUserId, recipient, { text });
}

/**
 * ارسال پیام رسانه‌ای (عکس/ویدیو/صدا) از طریق یک URL عمومی HTTPS.
 * محدودیت حجم فعلی متا: عکس ۸ مگابایت، ویدیو/صدا ۲۵ مگابایت.
 */
export function sendMediaMessage(
  apiVersion: string,
  accessToken: string,
  igUserId: string,
  recipient: Recipient,
  mediaType: "image" | "video" | "audio",
  mediaUrl: string
) {
  return sendPayload(apiVersion, accessToken, igUserId, recipient, {
    attachment: { type: mediaType, payload: { url: mediaUrl } },
  });
}

/**
 * پیام «فالو اجباری» رو با دو دکمه می‌فرسته: یکی لینک مستقیم به پروفایل پیج (برای فالو کردن)،
 * یکی دکمه‌ی «✅ فالو کردم» که با زده‌شدنش، یک رویداد postback با همون payload به وبهوک ما می‌رسه.
 * این مکانیزم («Button Template») دقیقاً برای همین مسیر (Instagram API with Instagram Login)
 * در مستندات رسمی متا مستند شده.
 */
export function sendFollowGateButtons(
  apiVersion: string,
  accessToken: string,
  igUserId: string,
  recipient: Recipient,
  gateMessage: string,
  pageUsername: string | null,
  keywordId: number
) {
  const buttons: Record<string, unknown>[] = [];
  if (pageUsername) {
    buttons.push({ type: "web_url", url: `https://instagram.com/${pageUsername}`, title: "رفتن به پیج" });
  }
  buttons.push({ type: "postback", title: "✅ فالو کردم", payload: `followgate:${keywordId}` });

  return sendPayload(apiVersion, accessToken, igUserId, recipient, {
    attachment: {
      type: "template",
      payload: { template_type: "button", text: gateMessage, buttons },
    },
  });
}

/**
 * تلاش برای چک‌کردن این‌که آیا این کاربر (IGSID) پیج رو فالو می‌کنه یا نه، از طریق فیلد رسمی
 * is_user_follow_business. صادقانه بگم: این فیلد در مستندات متا فقط زیر مسیر قدیمی‌تر
 * (Facebook Login / Page access token) به‌طور رسمی تأیید شده؛ روی مسیر ما (Instagram Login)
 * ممکنه کار کنه یا نکنه — برای همینه هر جای کد که این تابع رو صدا می‌زنیم، حتماً catch داره
 * و اگه خطا بده، به روش خوداظهاری (دکمه) برمی‌گردیم؛ هیچ‌جا فرض نمی‌کنیم حتماً کار می‌کنه.
 * پیش‌نیاز حتمی طبق مستندات متا: باید قبلش «رضایت کاربر» ثبت شده باشه (پیام فرستاده یا
 * دکمه‌ای زده باشه) — صرفاً کامنت‌گذاشتن کافی نیست و همیشه خطا می‌ده.
 */
export async function checkIsFollowingBusiness(
  apiVersion: string,
  accessToken: string,
  igsid: string
): Promise<boolean> {
  const url = new URL(`${IG_HOST}/${apiVersion}/${igsid}`);
  url.searchParams.set("fields", "is_user_follow_business");
  url.searchParams.set("access_token", accessToken);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`چک‌کردن فالو ناموفق بود (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { is_user_follow_business?: boolean };
  if (typeof json.is_user_follow_business !== "boolean") {
    throw new Error("فیلد is_user_follow_business در پاسخ نبود");
  }
  return json.is_user_follow_business;
}

export interface ShowcaseCard {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttonTitle?: string;
  buttonUrl?: string;
}

/**
 * ارسال ویترین (چند محصول به‌شکل کارت‌های قابل‌اسکرول) با استفاده از generic template —
 * همون قالب کارتی که پلتفرم پیام‌رسان متا برای کاتالوگ/کاروسل مستند کرده.
 * نکته: مثل سایر توابع ارسال پیام در این فایل، موقع تست فاز ۵ یک‌بار در برابر پاسخ واقعی API چک کنید.
 */
export function sendShowcase(
  apiVersion: string,
  accessToken: string,
  igUserId: string,
  recipient: Recipient,
  cards: ShowcaseCard[]
) {
  const elements = cards.slice(0, 10).map((c) => ({
    title: c.title,
    subtitle: c.subtitle,
    image_url: c.imageUrl,
    buttons: c.buttonUrl
      ? [{ type: "web_url", url: c.buttonUrl, title: c.buttonTitle || "مشاهده" }]
      : undefined,
  }));
  return sendPayload(apiVersion, accessToken, igUserId, recipient, {
    attachment: { type: "template", payload: { template_type: "generic", elements } },
  });
}

/** ثبت یک پاسخ عمومی، زیر خودِ کامنت (قابل‌دیدن برای همه) — این یکی endpoint جدایی داره، نه /me/messages. */
export async function postPublicCommentReply(
  apiVersion: string,
  accessToken: string,
  commentId: string,
  text: string
): Promise<void> {
  const res = await fetch(`${IG_HOST}/${apiVersion}/${commentId}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text, access_token: accessToken }),
  });
  if (!res.ok) {
    throw new Error(`ثبت پاسخ عمومی ناموفق بود (${res.status}): ${await res.text()}`);
  }
}

/**
 * تأیید امضای وبهوک متا (هدر X-Hub-Signature-256) با App Secret،
 * تا مطمئن بشیم درخواست واقعاً از متا اومده. با Web Crypto API چون در Workers هستیم.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expectedHex = signatureHeader.slice(7);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const computedHex = [...new Uint8Array(sigBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (computedHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}
