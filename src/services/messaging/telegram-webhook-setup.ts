// Register the Telegram webhook on boot so there's no manual setWebhook curl.
// Best-effort: logs and returns on any failure, never throws (must not block
// server startup). No-op unless the Telegram channel is active and configured.

import { config } from "../../config.js";

export async function registerTelegramWebhook(): Promise<void> {
  const ch = config.messaging.channel;
  if (ch !== "telegram" && ch !== "both") return;

  const token = config.telegram.botToken;
  const base = config.telegram.publicWebhookBase;
  if (!token || !base) {
    console.log(
      "[telegram] webhook NOT registered — set TELEGRAM_BOT_TOKEN and TELEGRAM_PUBLIC_WEBHOOK_BASE",
    );
    return;
  }

  const url = `${base.replace(/\/$/, "")}/webhooks/telegram`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        // Only send us message updates (not edits/reactions/etc).
        allowed_updates: ["message"],
        ...(config.telegram.webhookSecret
          ? { secret_token: config.telegram.webhookSecret }
          : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (res.ok && data.ok) {
      console.log(`[telegram] webhook registered → ${url}`);
    } else {
      console.error(
        `[telegram] setWebhook failed: ${res.status} ${data.description ?? ""}`.trim(),
      );
    }
  } catch (err) {
    console.error(`[telegram] setWebhook threw: ${(err as Error).message}`);
  }
}
