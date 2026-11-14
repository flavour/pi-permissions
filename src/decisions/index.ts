/**
 * Decisions Model layer: pinned profiles and question text, request assembly
 * for both state representations, the endpoint client, aggregation, shadow
 * proposal orchestration, and the text-only profile comparison.
 *
 * Nothing in here grants authority. The gate in `src/handler.ts` remains the
 * only place a call is allowed to run, and model authority is shadow-only.
 */

export * from "./aggregate.js";
export * from "./choice.js";
export * from "./compare.js";
export * from "./corpus.js";
export * from "./floor.js";
export * from "./profile.js";
export * from "./propose.js";
export * from "./questions.js";
export * from "./state.js";
export * from "./systemone.js";
