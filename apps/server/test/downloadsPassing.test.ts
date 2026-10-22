import { describe, expect, it } from "vitest";
import { PASSING } from "../src/downloads";

/**
 * The node pack's real last words (downloads.py run(), its openers failing as a source does, five tries), as downloads.ts
 * wraps them: a moment's rate limit, 5xx, reset or DNS blip of Hugging Face or Civitai once failed a pod's file for good,
 * and a job with it, while the pod stayed billed.
 */
const wrap = (why: string) => `The Afflatus node pack could not download it: ${why}`;

describe("which of the node pack's failures pass", () => {
  it.each([
    "the download failed 5 times in a row (the source answered 429)",
    "the download failed 5 times in a row (the source answered 503)",
    "the download failed 5 times in a row (the source answered 502)",
    "the download failed 5 times in a row (Afflatus answered 503)",
    "the download failed 5 times in a row (<urlopen error [Errno 104] Connection reset by peer>)",
    "the download failed 5 times in a row ([Errno 104] Connection reset by peer)",
    "the download failed 5 times in a row (<urlopen error [Errno -3] Temporary failure in name resolution>)",
    "the download failed 5 times in a row (timed out)",
    "the download failed 5 times in a row (Remote end closed connection without response)",
    "the download failed 5 times in a row (<urlopen error [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1006)>)",
  ])("asks again after %s", (why) => {
    expect(PASSING.test(wrap(why))).toBe(true);
  });

  it.each([
    "the source answered 404: the download is no longer there",
    "Afflatus answered 403: the download is no longer there",
    "the disk is full (No space left on device)",
    "the download link expired, and Afflatus sent no fresh one",
    "the source says 900 bytes, 800 were said",
  ])("still fails at once on %s", (why) => {
    expect(PASSING.test(wrap(why))).toBe(false);
  });
});
