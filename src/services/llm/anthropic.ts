import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private client: Anthropic;

  constructor(apiKey: string = config.llm.anthropicApiKey) {
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — add it to .env or switch LLM_PROVIDER=mock",
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async callText(req: LlmRequest): Promise<LlmResponse> {
    // Long, static system prompts (domain personas, synthesizer rubric) get
    // cache_control so we pay full input tokens once, then 10% on every
    // subsequent call. Short / per-user-varying prompts skip it.
    const systemBlock = req.cacheSystem
      ? [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }]
      : req.system;

    // Multimodal: when image/PDF blocks are attached, the user turn becomes a
    // content array (media blocks first, then the text instruction). Plain text
    // otherwise — the common path, unchanged.
    const userContent: Anthropic.MessageParam["content"] =
      req.media && req.media.length > 0
        ? [
            ...req.media.map((m): Anthropic.ContentBlockParam =>
              m.kind === "image"
                ? {
                    type: "image",
                    source: { type: "base64", media_type: m.mediaType, data: m.dataBase64 },
                  }
                : {
                    type: "document",
                    source: { type: "base64", media_type: "application/pdf", data: m.dataBase64 },
                  },
            ),
            { type: "text", text: req.user },
          ]
        : req.user;

    const t0 = Date.now();
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0,
      system: systemBlock,
      messages: [{ role: "user", content: userContent }],
    });
    const latencyMs = Date.now() - t0;

    // Anthropic returns content as an array of blocks. For a plain text
    // completion the first block is text; concatenate any subsequent text
    // blocks defensively.
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const usage = res.usage;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheCreateTokens = usage.cache_creation_input_tokens ?? 0;
    // Anthropic's `input_tokens` excludes both cache_read and
    // cache_creation from the headline figure. Sum them all back for
    // a "total input volume" view; pricing.ts splits them back out
    // for cost math.
    const tokensIn = usage.input_tokens + cacheReadTokens + cacheCreateTokens;
    const cacheHit = cacheReadTokens > cacheCreateTokens;

    return {
      text,
      tokensIn,
      tokensOut: usage.output_tokens,
      cacheReadTokens,
      cacheCreateTokens,
      latencyMs,
      cacheHit,
    };
  }
}
