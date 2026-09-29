import { z } from "zod";

/** Owner-written Q&A pairs ("Fix this answer"): see answer_fixes in db/migrations/009_answer_fixes.sql. */
export const MAX_FIXES = 500;

export const fixBody = z.object({
  question: z.string().trim().min(3, "Write the customer's question").max(500),
  answer: z.string().trim().min(1, "Write the answer").max(4000),
});
