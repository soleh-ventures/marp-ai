import { afterEach, describe, expect, test } from "bun:test";
import { config } from "../../config.js";
import { resolveChannel } from "./deliver.js";

const original = config.messaging.channel;
function setMode(mode: "whatsapp" | "telegram" | "both") {
  (config.messaging as { channel: string }).channel = mode;
}
afterEach(() => setMode(original));

const phoneOnly = { phone: "+4917628950549", telegramChatId: null };
const tgOnly = { phone: null, telegramChatId: "12345" };
const both = { phone: "+4917628950549", telegramChatId: "12345" };
const neither = { phone: null, telegramChatId: null };

describe("resolveChannel", () => {
  test("whatsapp mode routes to WhatsApp, or null with no phone", () => {
    setMode("whatsapp");
    expect(resolveChannel(phoneOnly)).toBe("whatsapp");
    expect(resolveChannel(both)).toBe("whatsapp");
    expect(resolveChannel(tgOnly)).toBeNull();
  });

  test("telegram mode routes to Telegram, or null with no chat id", () => {
    setMode("telegram");
    expect(resolveChannel(tgOnly)).toBe("telegram");
    expect(resolveChannel(both)).toBe("telegram");
    expect(resolveChannel(phoneOnly)).toBeNull(); // WhatsApp is off in this mode
  });

  test("both mode prefers Telegram, falls back to WhatsApp", () => {
    setMode("both");
    expect(resolveChannel(both)).toBe("telegram");
    expect(resolveChannel(tgOnly)).toBe("telegram");
    expect(resolveChannel(phoneOnly)).toBe("whatsapp");
    expect(resolveChannel(neither)).toBeNull();
  });
});
