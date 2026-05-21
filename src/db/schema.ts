// Schema lives here. T2 fills this in with athletes, race_blocks, activities,
// active_flags, messages, processed_messages, llm_calls per the eng plan.
//
// Keeping the file present (even empty) so drizzle-kit has a target and
// downstream code can `import { ... } from "./schema"` without churn.

export {};
