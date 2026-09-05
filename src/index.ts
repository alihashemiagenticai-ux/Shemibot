import { webhookCallback } from "grammy";
import { createBot } from "./telegram/bot";
import { verifyWebhookSignature } from "./instagram/api";
import { processInstagramWebhookEvent } from "./instagram/events";
import { proxyTelegramFile } from "./instagram/media";
import { runDailyCron } from "./cron";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  FACEBOOK_APP_ID: string;
  FACEBOOK_APP_SECRET: string;
  ADMIN_TELEGRAM_ID: string;
  IG_WEBHOOK_VERIFY_TOKEN: string;
  IG_API_VERSION: string;
  // توجه: قبلاً یک WORKER_BASE_URL هم اینجا بود که باید دستی بعد از اولین دیپلوی ست می‌شد
  // (چون آدرس Worker فقط بعد از ساخته‌شدنش معلومه). حذف شد — الان همون‌جایی که استفاده
  // می‌شد (src/instagram/events.ts) از روی url.origin همین درخواست ورودی ساخته می‌شه.
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // --- وبهوک تلگرام: همون‌جایی که ادمین با ربات حرف می‌زنه ---
    if (url.pathname === "/webhook/telegram") {
      // "cloudflare-mod" چون این Worker با سینتکس ماژولی (export default { fetch }) نوشته شده؛
      // این آداپتور مستقیم روی grammy@1.46 نصب‌شده تأیید شد (نه فقط حدس).
      const bot = createBot(env);
      return webhookCallback(bot, "cloudflare-mod")(request);
    }

    // --- تأیید اولیه‌ی وبهوک اینستاگرام نزد متا (دست‌دادن hub.challenge) ---
    if (url.pathname === "/webhook/instagram" && request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token === env.IG_WEBHOOK_VERIFY_TOKEN && challenge) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // --- دریافت رویدادهای واقعی (کامنت جدید، دایرکت جدید) ---
    if (url.pathname === "/webhook/instagram" && request.method === "POST") {
      const rawBody = await request.text();
      const signature = request.headers.get("X-Hub-Signature-256");
      const isValid = await verifyWebhookSignature(rawBody, signature, env.FACEBOOK_APP_SECRET);
      if (!isValid) return new Response("Invalid signature", { status: 401 });

      // فوراً ۲۰۰ برمی‌گردونیم تا متا دوباره ریتری نکنه، و پردازش واقعی رو در پس‌زمینه ادامه می‌دیم.
      // url.origin یعنی همون آدرس عمومی Worker (چه روی *.workers.dev چه روی دامنه‌ی سفارشی)،
      // دقیقاً همونی که در این درخواست استفاده شده — نیازی به هیچ تنظیم دستی نیست.
      ctx.waitUntil(processInstagramWebhookEvent(JSON.parse(rawBody), env, url.origin));
      return new Response("OK", { status: 200 });
    }

    // --- سرو کردن رسانه‌ای که در کانال تلگرام بایگانی شده، برای اینستاگرام ---
    // مسیر: /media/keyword/<id> یا /media/showcase/<id>
    if (url.pathname.startsWith("/media/")) {
      const [, , kind, idStr] = url.pathname.split("/");
      const id = Number(idStr);
      if (!id || (kind !== "keyword" && kind !== "showcase")) {
        return new Response("Not found", { status: 404 });
      }
      const table = kind === "keyword" ? "keywords" : "showcase_products";
      const column = kind === "keyword" ? "response_content" : "image_url";
      const row = await env.DB.prepare(`SELECT ${column} AS file_id FROM ${table} WHERE id = ?`)
        .bind(id)
        .first<{ file_id: string | null }>();
      if (!row?.file_id) return new Response("Not found", { status: 404 });

      try {
        return await proxyTelegramFile(env.TELEGRAM_BOT_TOKEN, row.file_id);
      } catch (err) {
        console.error("خطا در سرو رسانه:", (err as Error).message);
        return new Response("خطا در بارگیری فایل", { status: 502 });
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyCron(env));
  },
};
