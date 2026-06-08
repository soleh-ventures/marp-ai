import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DOMAINS, type Domain } from "./types.js";

// Resolve relative to the repo root, not the source file, so this works
// the same when run via `bun run dev` (src/) and `bun run start`
// (whatever Railway invokes).
const PROMPTS_ROOT = resolve(process.cwd(), "prompts");

export type PromptFile = {
  // Raw frontmatter (parsed minimally — see parseFrontmatter). Used by
  // tests + future content-licensing audits; the router only consumes
  // `body`.
  frontmatter: Record<string, unknown>;
  // The text the LLM sees as the system prompt. Everything after the
  // closing `---`, trimmed.
  body: string;
};

// Cache so we don't re-read from disk on every request. Loader is called
// lazily on first use; if a file is missing we throw with the absolute
// path so the failure is debuggable in 5 seconds.
const cache = new Map<string, PromptFile>();

function loadFile(relPath: string): PromptFile {
  const cached = cache.get(relPath);
  if (cached) return cached;

  const fullPath = resolve(PROMPTS_ROOT, relPath);
  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read prompt file at ${fullPath}: ${(err as Error).message}`,
    );
  }

  const parsed = parseFrontmatter(raw);
  cache.set(relPath, parsed);
  return parsed;
}

// Minimal YAML-ish frontmatter parser. We don't need full YAML — just
// key/value lines and list items at one level of nesting. Anything
// fancier and the .md file is doing too much; refactor instead.
export function parseFrontmatter(raw: string): PromptFile {
  const fenceStart = raw.indexOf("---");
  if (fenceStart !== 0) {
    // No frontmatter — treat the whole file as the body.
    return { frontmatter: {}, body: raw.trim() };
  }
  const fenceEnd = raw.indexOf("\n---", 3);
  if (fenceEnd === -1) {
    throw new Error("frontmatter opener `---` has no closer");
  }
  const fmText = raw.slice(3, fenceEnd).trim();
  const body = raw.slice(fenceEnd + 4).trim();

  const frontmatter: Record<string, unknown> = {};
  let currentListKey: string | null = null;
  let currentList: unknown[] = [];
  let currentObj: Record<string, unknown> | null = null;

  for (const line of fmText.split("\n")) {
    if (line.trim() === "") continue;

    // Indented list item: `  - title: "..."` or `  - foo`
    const listMatch = line.match(/^\s{2,}-\s+(.+)$/);
    if (listMatch && currentListKey) {
      const itemText = listMatch[1] ?? "";
      const kv = itemText.match(/^([a-zA-Z_]+):\s*(.+)$/);
      if (kv) {
        currentObj = { [kv[1] ?? ""]: stripQuotes(kv[2] ?? "") };
        currentList.push(currentObj);
      } else {
        currentObj = null;
        currentList.push(stripQuotes(itemText));
      }
      continue;
    }

    // Continuation key for current list item: `    type: paraphrase`
    const contMatch = line.match(/^\s{4,}([a-zA-Z_]+):\s*(.+)$/);
    if (contMatch && currentObj) {
      currentObj[contMatch[1] ?? ""] = stripQuotes(contMatch[2] ?? "");
      continue;
    }

    // Top-level key.
    const topMatch = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (topMatch) {
      const key = topMatch[1] ?? "";
      const value = (topMatch[2] ?? "").trim();
      if (value === "") {
        // Start of a list under this key.
        currentListKey = key;
        currentList = [];
        currentObj = null;
        frontmatter[key] = currentList;
      } else {
        frontmatter[key] = stripQuotes(value);
        currentListKey = null;
        currentObj = null;
      }
    }
  }

  return { frontmatter, body };
}

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ─── public accessors ─────────────────────────────────────────────────────

export function getDomainPrompt(domain: Domain): string {
  return loadFile(`domains/${domain}.md`).body;
}

export function getClassifierPrompt(): string {
  return loadFile("classifier.md").body;
}

export function getSynthesizerPrompt(): string {
  return loadFile("synthesizer.md").body;
}

export function getOnboardingPrompt(): string {
  return loadFile("onboarding.md").body;
}

export function getPlanGeneratorPrompt(): string {
  return loadFile("plan-generator.md").body;
}

export function getPlanIngestPrompt(): string {
  return loadFile("plan-ingest.md").body;
}

// v1.3 (A1): targeted-mutation prompt for editing an existing plan.
export function getPlanAdjustPrompt(): string {
  return loadFile("plan-adjust.md").body;
}

// M1 (T2): interprets a completed run into a short coach's read.
export function getPostRunAnalysisPrompt(): string {
  return loadFile("post-run-analysis.md").body;
}

// M1 (T4): extracts a structured RunFeeling from a runner's free-text reply.
export function getFeelingExtractPrompt(): string {
  return loadFile("feeling-extract.md").body;
}

// M1 (T5): decides whether the week warrants a plan adjustment and proposes one.
export function getRetroProposalPrompt(): string {
  return loadFile("retro-proposal.md").body;
}

// KER-79 (Phase 2): the end-of-week coach evaluation — results + what went
// well + what to improve, plus a holistic decision on adjusting next week.
export function getWeeklyEvaluationPrompt(): string {
  return loadFile("weekly-evaluation.md").body;
}

// S1 (KER-29): safety-triage classifier prompt, run before routing.
export function getSafetyTriagePrompt(): string {
  return loadFile("safety-triage.md").body;
}

export function getDomainPromptFile(domain: Domain): PromptFile {
  return loadFile(`domains/${domain}.md`);
}

// Eager load + validate every prompt file at boot so a missing file
// crashes the server immediately, not on the runner's first message.
// Call this from src/server.ts startup.
export function validateAllPrompts(): void {
  loadFile("classifier.md");
  loadFile("synthesizer.md");
  loadFile("onboarding.md");
  loadFile("plan-generator.md");
  loadFile("plan-ingest.md");
  loadFile("plan-adjust.md");
  loadFile("post-run-analysis.md");
  loadFile("feeling-extract.md");
  loadFile("retro-proposal.md");
  loadFile("weekly-evaluation.md");
  loadFile("safety-triage.md");
  for (const d of DOMAINS) {
    loadFile(`domains/${d}.md`);
  }
}

// Test-only: drop the cache so prompt edits during a watch session reload.
export function _resetPromptCache(): void {
  cache.clear();
}
