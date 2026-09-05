// اینستاگرام برای ارسال عکس/ویدیو/صدا در دایرکت به یک URL عمومی HTTPS نیاز داره.
// به‌جای Cloudflare R2 (که به ثبت کارت بانکی نیاز داره)، از یک کانال خصوصی تلگرام که
// خود کاربر می‌سازه به‌عنوان محل بایگانی رسانه استفاده می‌کنیم:
//   ۱. وقتی ادمین عکس/ویدیو/ویسی به ربات می‌ده، همون پیام رو به کانال رسانه فوروارد می‌کنیم
//      (forwardMessage، نه copyMessage — چون forwardMessage کل پیام تازه رو برمی‌گردونه
//      و از توش یک file_id مخصوص همون کپیِ داخل کانال می‌گیریم؛ این یعنی رسانه واقعاً
//      داخل کانال شما بایگانی می‌شه، نه فقط یک ارجاع موقت به چت با ربات)
//   ۲. آدرسی که به‌عنوان پاسخ ذخیره می‌کنیم، یک URL روی خودِ Worker شماست (نه تلگرام مستقیم)
//   ۳. وقتی اینستاگرام اون URL رو fetch کنه، Worker همون لحظه یک لینک دانلود تازه از
//      تلگرام می‌گیره (getFile) و بایت‌های فایل رو مستقیم پاس می‌ده — توکن ربات هیچ‌وقت
//      مستقیم در اختیار سرورهای متا قرار نمی‌گیره.

export interface ForwardedFile {
  fileId: string;
  kind: "image" | "video" | "voice";
}

/**
 * فوروارد‌کردن پیام رسانه‌ای ادمین به کانال رسانه، و استخراج file_id تازه از همون کپی.
 */
export async function forwardMediaToChannel(
  botToken: string,
  mediaChannelId: string,
  fromChatId: string,
  messageId: number
): Promise<ForwardedFile> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/forwardMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: mediaChannelId, from_chat_id: fromChatId, message_id: messageId }),
  });
  const json = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: {
      photo?: Array<{ file_id: string }>;
      video?: { file_id: string };
      voice?: { file_id: string };
    };
  };
  if (!res.ok || !json.ok) {
    throw new Error(
      `فوروارد به کانال رسانه ناموفق بود: ${json.description || res.status}. مطمئن بشید ربات ادمین کانال هست.`
    );
  }

  const r = json.result!;
  if (r.photo?.length) return { fileId: r.photo.at(-1)!.file_id, kind: "image" };
  if (r.video) return { fileId: r.video.file_id, kind: "video" };
  if (r.voice) return { fileId: r.voice.file_id, kind: "voice" };
  throw new Error("پیام فوروارد‌شده هیچ عکس/ویدیو/ویسی نداشت.");
}

/** گرفتن یک لینک دانلود تازه از تلگرام برای یک file_id (لینک قبلی ممکنه منقضی شده باشه). */
async function getFreshDownloadUrl(botToken: string, fileId: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const json = (await res.json()) as { ok: boolean; description?: string; result?: { file_path?: string } };
  if (!res.ok || !json.ok || !json.result?.file_path) {
    throw new Error(`گرفتن فایل از تلگرام ناموفق بود: ${json.description || res.status}`);
  }
  return `https://api.telegram.org/file/bot${botToken}/${json.result.file_path}`;
}

/**
 * پراکسی واقعی: بایت‌های فایل رو مستقیم از تلگرام می‌گیره و به‌عنوان Response برمی‌گردونه —
 * این تابع رو route زیر «/media/...» در index.ts صدا می‌زنه، وقتی اینستاگرام درخواست بده.
 */
export async function proxyTelegramFile(botToken: string, fileId: string): Promise<Response> {
  const downloadUrl = await getFreshDownloadUrl(botToken, fileId);
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    return new Response("فایل پیدا نشد", { status: 404 });
  }
  const extension = downloadUrl.split(".").pop() || "";
  return new Response(fileRes.body, {
    status: 200,
    headers: { "Content-Type": guessContentType(extension), "Cache-Control": "public, max-age=3600" },
  });
}

function guessContentType(extension: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    wav: "audio/wav",
  };
  return map[extension.toLowerCase()] || "application/octet-stream";
}
