// Best-effort automated guard for rule 6: cuckolds/fortifies must be
// "sufficiently changed" from the original word - simple prefix/suffix
// extensions (like VAGINA -> VAGINAL) are generally disallowed. This can't
// fully capture "changed in meaning", so it only catches the mechanical,
// unambiguous case: the old word appears intact at the very start or end of
// the new word, and the added letters match a common English affix. Bigger
// tile additions that don't reduce to a bare affix (like ENABLE -> DENIABLE,
// where the extra D lands in the middle of the reordered word) are allowed
// through, matching rule 6's own example.
const COMMON_SUFFIXES = [
  'S', 'ES', 'ED', 'ING', 'ER', 'EST', 'LY', 'ION', 'TION', 'ATION',
  'MENT', 'NESS', 'FUL', 'LESS', 'ABLE', 'IBLE', 'AL', 'IC', 'OUS', 'IVE',
];
const COMMON_PREFIXES = [
  'RE', 'UN', 'DIS', 'NON', 'PRE', 'MIS', 'OVER', 'UNDER', 'SUB', 'IN', 'IM',
];

// A stem "covers" the old word if it's either the old word verbatim, or the
// old word with its last letter dropped - this handles cases like
// VAGINA -> VAGINAL, where the suffix "-AL" swallows the base word's final
// letter instead of appending cleanly after it.
function stemCoversOldWord(stem, a) {
  return stem === a || (stem.length === a.length - 1 && a.startsWith(stem));
}

function isBareAffixExtension(oldWord, newWord) {
  const a = oldWord.toUpperCase();
  const b = newWord.toUpperCase();
  if (b.length <= a.length) return false;

  for (const suffix of COMMON_SUFFIXES) {
    if (b.endsWith(suffix)) {
      const stem = b.slice(0, b.length - suffix.length);
      if (stemCoversOldWord(stem, a)) return true;
    }
  }
  for (const prefix of COMMON_PREFIXES) {
    if (b.startsWith(prefix)) {
      const stem = b.slice(prefix.length);
      if (stemCoversOldWord(stem, a)) return true;
    }
  }
  return false;
}

module.exports = { isBareAffixExtension };
