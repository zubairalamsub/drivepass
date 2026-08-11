// passphrase.js — memorable word passphrase generator.
// Produces passphrases like "correct-horse-battery-staple-42".
//
// STRENGTH, HONESTLY: a passphrase is only as strong as log2(listSize) per
// word, and this list is small. Each word is worth ~6.6 bits, so a 4-word
// passphrase is ~26 bits — guessable offline in seconds by anyone who knows
// the list, which is public in this file. That is why the default is higher
// than 4 and why the UI shows entropy computed from the real list size instead
// of a flattering constant.
//
// TO MAKE THIS COMPETITIVE: swap WORDLIST for the EFF long list (7776 words,
// 12.9 bits/word), which makes 4 words worth ~52 bits. Until then, prefer the
// random generator for anything that matters, and treat passphrases as the
// option for secrets a human has to type from memory.

import { randomInt } from "./crypto.js";

const WORDLIST = [
  "apple", "anchor", "badge", "banana", "beacon", "breeze", "bridge", "cabin", "cactus",
  "camera", "candle", "canyon", "castle", "cedar", "clover", "comet", "coral", "crater",
  "crystal", "desert", "dolphin", "dragon", "eagle", "echo", "ember", "falcon", "feather",
  "forest", "fossil", "galaxy", "garden", "glacier", "harbor", "haven", "hawk", "island",
  "jungle", "lagoon", "lantern", "legend", "lotus", "meadow", "meteor", "mirror", "mountain",
  "nebula", "oasis", "ocean", "orchid", "palace", "panther", "pebble", "phoenix", "planet",
  "prism", "pyramid", "radar", "river", "rocket", "sailor", "shadow", "shield", "sierra",
  "silver", "solar", "spark", "spectrum", "sphere", "spiral", "spring", "star", "statue",
  "stream", "summit", "sunflower", "sunset", "temple", "thunder", "tiger", "timber", "titan",
  "topaz", "torrent", "tower", "valley", "velvet", "vortex", "voyage", "walnut", "wave",
  "willow", "winter", "wisdom", "wizard", "wonder", "zebra", "zenith"
];

// Exposed so the UI can report real entropy rather than a hardcoded guess.
export const WORDLIST_SIZE = WORDLIST.length;

// Below this, a passphrase is not a serious defence against offline cracking.
export const WEAK_ENTROPY_BITS = 60;

// Exact entropy of a generated passphrase. The trailing number contributes
// log2(100) bits, not a rounded-off 6.
export function passphraseEntropyBits(wordCount, includeNumber = true) {
  const bits = wordCount * Math.log2(WORDLIST_SIZE);
  return bits + (includeNumber ? Math.log2(100) : 0);
}

// How many words this list needs to reach a given strength.
export function wordsNeededFor(bits, includeNumber = true) {
  const budget = bits - (includeNumber ? Math.log2(100) : 0);
  return Math.max(1, Math.ceil(budget / Math.log2(WORDLIST_SIZE)));
}

// The default word count is derived from the strength target rather than fixed,
// so it stays correct if WORDLIST ever changes size.
export const DEFAULT_WORD_COUNT = wordsNeededFor(WEAK_ENTROPY_BITS, true);

export function generatePassphrase(
  wordCount = DEFAULT_WORD_COUNT,
  separator = "-",
  includeNumber = true
) {
  const words = [];
  // randomInt rejection-samples; `% WORDLIST.length` would bias toward the
  // front of the list, shaving entropy off an already short list.
  for (let i = 0; i < wordCount; i++) {
    words.push(WORDLIST[randomInt(WORDLIST_SIZE)]);
  }
  if (includeNumber) {
    words.push(String(randomInt(100)).padStart(2, "0"));
  }
  return words.join(separator);
}
