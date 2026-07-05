// Standard Scrabble letter distribution, 100 tiles minus the 2 blanks
// (rule 1 removes blank tiles), leaving 98 letter tiles.
const LETTER_DISTRIBUTION = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1,
  K: 1, L: 4, M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6,
  U: 4, V: 2, W: 2, X: 1, Y: 2, Z: 1,
};

function buildTileBag() {
  const bag = [];
  for (const [letter, count] of Object.entries(LETTER_DISTRIBUTION)) {
    for (let i = 0; i < count; i++) bag.push(letter);
  }
  // Fisher-Yates shuffle
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

function lettersToCounter(letters) {
  const counter = {};
  for (const ch of letters) {
    counter[ch] = (counter[ch] || 0) + 1;
  }
  return counter;
}

function wordToSignature(word) {
  const counter = lettersToCounter(word.toUpperCase());
  return Object.keys(counter)
    .sort()
    .map((k) => `${k}${counter[k]}`)
    .join('');
}

// Returns the counter of letters that `word` needs beyond what `baseLetters`
// already supplies, or null if word does not actually contain baseLetters
// as a sub-multiset (i.e. it isn't a valid extension of the base word).
function extraLettersNeeded(word, baseLetters) {
  const need = lettersToCounter(word.toUpperCase());
  const have = lettersToCounter(baseLetters.join('').toUpperCase());
  const extra = {};
  for (const [letter, count] of Object.entries(need)) {
    const remaining = count - (have[letter] || 0);
    if (remaining > 0) extra[letter] = remaining;
  }
  // Confirm base letters are fully consumed as a subset (every base letter
  // must be used in the new word - you can't drop tiles from your own nest).
  for (const [letter, count] of Object.entries(have)) {
    if ((need[letter] || 0) < count) return null;
  }
  return extra;
}

// Attempts to remove the letters of `word` from the `pool` array (e.g. the
// jungle). Returns the new pool with those letters removed, or null if the
// pool doesn't contain enough of each letter.
function removeLettersFromPool(word, pool) {
  const need = lettersToCounter(word.toUpperCase());
  const poolCopy = [...pool];
  for (const [letter, count] of Object.entries(need)) {
    for (let i = 0; i < count; i++) {
      const idx = poolCopy.indexOf(letter);
      if (idx === -1) return null;
      poolCopy.splice(idx, 1);
    }
  }
  return poolCopy;
}

function counterToLetters(counter) {
  const letters = [];
  for (const [letter, count] of Object.entries(counter)) {
    for (let i = 0; i < count; i++) letters.push(letter);
  }
  return letters;
}

module.exports = {
  LETTER_DISTRIBUTION,
  buildTileBag,
  lettersToCounter,
  wordToSignature,
  extraLettersNeeded,
  removeLettersFromPool,
  counterToLetters,
};
