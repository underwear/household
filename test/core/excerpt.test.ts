import { expect, test } from "bun:test";
import { HEAD_AND_TAIL_MAX, headAndTail, oneLine } from "../../src/core/excerpt";

const graphemes = (text: string) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), ({ segment }) => segment);

// A flag (two regional indicators), a skin tone (a modifier), a keycap (digit, variation selector, keycap mark),
// a family (people joined by ZWJ): each is one grapheme cluster of several code points.
const CLUSTERS = ["🇺🇦", "👍🏽", "1️⃣", "👨‍👩‍👧"];

test("one line, cut to 60 grapheme clusters with … — a flag, a skin tone, a keycap is never split", () => {
  expect(oneLine("  Buy an\n\telephant \u0007 ")).toBe("Buy an elephant");
  expect(oneLine("x".repeat(60))).toBe("x".repeat(60));
  expect(oneLine("x".repeat(61))).toBe(`${"x".repeat(59)}…`);
  for (const cluster of CLUSTERS) {
    const cut = oneLine(cluster.repeat(70));
    expect(graphemes(cut)).toHaveLength(60);
    expect(cut).toBe(`${cluster.repeat(59)}…`);
  }
});

test("head and tail: short text whole; long text its first 60 grapheme clusters, ` … `, and its end, 200 at most", () => {
  expect(headAndTail("Buy an elephant?\nYes or no")).toBe("Buy an elephant? Yes or no");
  expect(headAndTail("x".repeat(200))).toBe("x".repeat(200));
  const question = `${"A long preamble about elephants. ".repeat(20)}So, buy an elephant for 300?`;
  const shown = headAndTail(question);
  expect(shown).toStartWith("A long preamble about elephants. A long preamble");
  expect(shown).toContain(" … ");
  expect(shown).toEndWith("So, buy an elephant for 300?");
  expect(graphemes(shown).length).toBeLessThanOrEqual(HEAD_AND_TAIL_MAX);
  // Clusters stay whole at both cuts.
  for (const [head, tail] of [["🇺🇦", "👍🏽"], ["1️⃣", "👨‍👩‍👧"]] as const) {
    const cut = headAndTail(`${head.repeat(150)}${tail.repeat(150)}`);
    expect(cut).toBe(`${head.repeat(60)} … ${tail.repeat(137)}`);
    expect(graphemes(cut)).toHaveLength(HEAD_AND_TAIL_MAX);
  }
});
