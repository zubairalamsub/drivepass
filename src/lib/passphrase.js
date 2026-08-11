// passphrase.js — EFF memorable word passphrase generator.
// Generates secure, memorable passphrases like "correct-horse-battery-staple-42".

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

export function generatePassphrase(wordCount = 4, separator = "-", includeNumber = true) {
  const rnd = crypto.getRandomValues(new Uint32Array(wordCount));
  const words = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(WORDLIST[rnd[i] % WORDLIST.length]);
  }

  if (includeNumber) {
    const numRnd = crypto.getRandomValues(new Uint32Array(1))[0] % 100;
    words.push(numRnd.toString().padStart(2, "0"));
  }

  return words.join(separator);
}
