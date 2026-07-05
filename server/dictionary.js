const fs = require('fs');
const path = require('path');

const words = fs
  .readFileSync(path.join(__dirname, 'words.txt'), 'utf8')
  .split('\n')
  .map((w) => w.trim())
  .filter(Boolean);

const WORD_SET = new Set(words);

// House-rule exception: JIT is claimable from the jungle even though it
// isn't in the North American Scrabble Dictionary, but per rule 3 it can
// never be stolen/cuckolded away from whoever claims it.
const JIT = 'JIT';

function isValidDictionaryWord(word) {
  return WORD_SET.has(word.toUpperCase());
}

function isClaimableWord(word) {
  const w = word.toUpperCase();
  if (w === JIT) return true;
  return isValidDictionaryWord(w);
}

module.exports = { isValidDictionaryWord, isClaimableWord, JIT, WORD_SET };
