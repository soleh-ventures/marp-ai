// KER-72: WhatsApp message splitting. Pure string utilities, deliberately
// free of any config/DB import so they can be unit-tested in isolation and
// reused anywhere an outbound body might exceed the per-message limit.

// Twilio caps WhatsApp bodies at 1600 chars. We split conservatively at
// 1500 so multi-byte chars and any provider-side framing have headroom.
export const MAX_WHATSAPP_CHARS = 1500;

// Greedily pack `units` into messages no longer than `limit`, rejoining
// consecutive units that share a message with `sep`. A unit that's itself
// over the limit is emitted as-is here; the caller descends to a finer
// split for those.
function pack(units: string[], sep: string, limit: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    const candidate = cur === "" ? u : cur + sep + u;
    if (candidate.length <= limit) {
      cur = candidate;
    } else {
      if (cur !== "") out.push(cur);
      cur = u;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

function hardSlice(s: string, limit: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += limit) out.push(s.slice(i, i + limit));
  return out;
}

/**
 * Split a message body into WhatsApp-sized parts WITHOUT truncating.
 *
 * Prefers coarse boundaries (blank-line paragraphs) and only descends to
 * finer ones — lines, sentences, words, then a hard slice for a
 * pathological single token like a long URL — when a piece is still over
 * the limit.
 */
export function splitForWhatsApp(
  body: string,
  limit: number = MAX_WHATSAPP_CHARS,
): string[] {
  if (body.length <= limit) return [body];

  // 1. Paragraphs first — plan summaries are paragraph-structured, so this
  //    keeps related lines together.
  let result = pack(body.split(/\n{2,}/), "\n\n", limit);

  // 2. Any message still over the limit is a single oversized paragraph.
  //    Descend: lines → sentences → words → hard slice.
  result = result.flatMap((m) =>
    m.length <= limit ? [m] : pack(m.split("\n"), "\n", limit),
  );
  result = result.flatMap((m) =>
    m.length <= limit ? [m] : pack(m.split(/(?<=[.!?])\s+/), " ", limit),
  );
  result = result.flatMap((m) =>
    m.length <= limit ? [m] : pack(m.split(/\s+/), " ", limit),
  );
  result = result.flatMap((m) => (m.length <= limit ? [m] : hardSlice(m, limit)));

  return result;
}
