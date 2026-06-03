import type { LlmProvider, LlmRequest, LlmResponse } from "./types.js";

// Deterministic in-process provider for tests and offline dev. Tests
// register canned responses keyed by a substring match against the user
// message, so a test can say: "when the user message contains 'knee', the
// classifier should return this routing JSON". The harness uses substring
// match rather than full equality so tests stay readable when the prompt
// includes wrapping boilerplate.

export type MockResponse = {
  // Substring matched against `LlmRequest.user`. First match wins.
  match: string | RegExp;
  // What to return as the text body.
  text: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
};

export class MockProvider implements LlmProvider {
  readonly name = "mock" as const;
  private responses: MockResponse[] = [];
  // Captured calls — tests assert on this to verify which models were hit
  // and in what order.
  public readonly calls: LlmRequest[] = [];

  setResponses(responses: MockResponse[]): void {
    this.responses = responses;
  }

  reset(): void {
    this.responses = [];
    this.calls.length = 0;
  }

  async callText(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const match = this.responses.find((r) =>
      typeof r.match === "string"
        ? req.user.includes(r.match)
        : r.match.test(req.user),
    );
    if (!match) {
      throw new Error(
        `MockProvider has no canned response for user message starting with: ${req.user.slice(0, 80)}`,
      );
    }
    // Default token counts roughly proportional to text length so cost
    // estimates are non-zero in tests but stay tiny.
    const tokensIn = match.tokensIn ?? Math.ceil(req.user.length / 4);
    const tokensOut = match.tokensOut ?? Math.ceil(match.text.length / 4);
    return {
      text: match.text,
      tokensIn,
      tokensOut,
      // Mock provider doesn't simulate caching — T6's cache_hit telemetry
      // is verified end-to-end via a small unit test that pre-builds the
      // expected LlmResponse shape rather than the mock provider chain.
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      latencyMs: match.latencyMs ?? 1,
      cacheHit: false,
    };
  }
}

// Singleton mock so the router and tests share the same instance via the
// provider factory.
export const mockProvider = new MockProvider();
