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

    const t0 = Date.now();
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0,
      system: systemBlock,
      messages: [{ role: "user", content: req.user }],
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
    const cacheHit =
      (usage.cache_read_input_tokens ?? 0) >
      (usage.cache_creation_input_tokens ?? 0);

    return {
      text,
      // input_tokens excludes cached tokens in the response, but we want
      // total input volume for cost math. Add cache_read back in — those
      // are still billed (at 10%).
      tokensIn:
        usage.input_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0),
      tokensOut: usage.output_tokens,
      latencyMs,
      cacheHit,
    };
  }
}
