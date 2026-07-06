const { isClaimableWord, isValidDictionaryWord, JIT } = require('./dictionary');
const {
  buildTileBag,
  wordToSignature,
  extraLettersNeeded,
  removeLettersFromPool,
  counterToLetters,
} = require('./tiles');
const { isBareAffixExtension } = require('./affix');

const BAN_FLIP_WINDOW = 3; // "that turn and two turns after"
const MEATWATCHING_MS = 2 * 60 * 1000;

const FLIP_MIN_MS = 5000; // first flip's countdown
const FLIP_MAX_MS = 15000; // countdown by the second-to-last flip (and onward)
const METER_MAX = 3; // seconds of charge a player can hold
const METER_RATE = 1 / 3; // seconds of charge gained per real second

let wordIdCounter = 1;

class Game {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.phase = 'lobby'; // lobby | playing | meatwatching | ended
    this.players = new Map(); // id -> player
    this.playerOrder = []; // join order, for host selection
    this.bag = [];
    this.jungle = [];
    this.totalTiles = 0;
    this.words = new Map(); // wordId -> word entity
    this.signatureIndex = new Map(); // signature -> wordId (active entities only)
    this.usedSignatures = new Set(); // every signature ever claimed, permanently retired from fresh jungle claims
    this.allSpellingsEverUsed = new Set(); // every exact spelling ever played, for the word-history reference panel
    this.flipCount = 0;
    this.nextFlipAt = null; // timestamp; owned by the caller's scheduler, mirrored here for broadcasting
    this.meatwatchingEndsAt = null;
    this.log = [];
    this.winnerIds = null;
    this.leastTilesIds = null;
    this.leastTilesCount = null;
    this.mostBannedIds = null;
    this.mostBannedCount = null;
    this.biggestCuckIds = null;
    this.biggestCuckCount = null;
    this.eventSeq = 0;
    this.lastEvent = null;
  }

  emitEvent(event) {
    this.eventSeq += 1;
    this.lastEvent = { seq: this.eventSeq, ...event };
  }

  addPlayer(id, name) {
    if (this.players.has(id)) return this.players.get(id);
    const player = {
      id,
      name,
      connected: true,
      banned: false,
      banUntilFlipCount: 0,
      banCount: 0,
      tilesStolenFromThem: 0,
      wordIds: [],
      charge: 0,
      chargeUpdatedAt: Date.now(),
    };
    this.players.set(id, player);
    this.playerOrder.push(id);
    return player;
  }

  markDisconnected(id) {
    const p = this.players.get(id);
    if (p) p.connected = false;
  }

  markReconnected(id) {
    const p = this.players.get(id);
    if (p) p.connected = true;
  }

  get hostId() {
    return this.playerOrder.find((id) => this.players.has(id));
  }

  pushLog(message) {
    this.log.push({ ts: Date.now(), message });
    if (this.log.length > 100) this.log.shift();
  }

  // --- Lifecycle -----------------------------------------------------

  startGame(requesterId) {
    if (this.phase !== 'lobby') return { ok: false, error: 'Game already started.' };
    if (requesterId !== this.hostId) return { ok: false, error: 'Only the host can start the game.' };
    const connectedPlayers = this.playerOrder.filter((id) => this.players.get(id)?.connected);
    if (connectedPlayers.length < 2) return { ok: false, error: 'Need at least 2 players to start.' };

    this.bag = buildTileBag();
    this.totalTiles = this.bag.length;
    this.jungle = [];
    this.words.clear();
    this.signatureIndex.clear();
    this.usedSignatures.clear();
    this.allSpellingsEverUsed.clear();
    for (const p of this.players.values()) {
      p.wordIds = [];
      p.banned = false;
      p.banUntilFlipCount = 0;
      p.banCount = 0;
      p.tilesStolenFromThem = 0;
      p.charge = 0;
      p.chargeUpdatedAt = Date.now();
    }
    this.flipCount = 0;
    this.phase = 'playing';
    this.meatwatchingEndsAt = null;
    this.log = [];
    this.pushLog('The game has begun. Tiles are flipped face down in a donut around the jungle.');
    return { ok: true };
  }

  // Countdown duration for the flip numbered `flipNumber` (1-based): ramps
  // linearly from FLIP_MIN_MS at flip 1 to FLIP_MAX_MS by the second-to-last
  // flip, and stays capped at FLIP_MAX_MS for the final flip.
  flipDurationMs(flipNumber) {
    const rampEndFlip = Math.max(1, this.totalTiles - 1);
    const t = Math.min(1, (flipNumber - 1) / Math.max(1, rampEndFlip - 1));
    return FLIP_MIN_MS + (FLIP_MAX_MS - FLIP_MIN_MS) * t;
  }

  // Pops one tile into the jungle. Returns how long (ms) the caller should
  // wait before the next auto-flip, or null if there's no next flip to
  // schedule (bag empty / game not playing). The caller owns the actual
  // timer and is responsible for keeping `nextFlipAt` in sync.
  autoFlip() {
    if (this.phase !== 'playing' || this.bag.length === 0) {
      return { ok: false, scheduleNextMs: null };
    }
    const tile = this.bag.pop();
    this.jungle.push(tile);
    this.flipCount += 1;
    this.emitEvent({ kind: 'flip', letter: tile });
    this.checkBanExpirations();

    if (this.bag.length === 0) {
      this.enterMeatwatching();
      return { ok: true, scheduleNextMs: null };
    }
    return { ok: true, scheduleNextMs: this.flipDurationMs(this.flipCount + 1) };
  }

  // --- Charge meter ------------------------------------------------------

  getCurrentCharge(player) {
    const elapsedSec = (Date.now() - player.chargeUpdatedAt) / 1000;
    return Math.min(METER_MAX, player.charge + elapsedSec * METER_RATE);
  }

  // Discharges a player's entire current charge into the shared flip
  // countdown, either adding or subtracting that many seconds. Returns the
  // new remaining delay (ms) so the caller can reschedule its timer.
  dischargeCharge(playerId, direction) {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, error: 'Unknown player.' };
    if (this.phase !== 'playing' || this.nextFlipAt == null) {
      return { ok: false, error: 'The flip timer is not active.' };
    }
    if (direction !== 'add' && direction !== 'subtract') {
      return { ok: false, error: 'Invalid discharge direction.' };
    }
    const charge = this.getCurrentCharge(player);
    if (charge <= 0.05) return { ok: false, error: 'No charge to discharge.' };

    const deltaMs = charge * 1000 * (direction === 'add' ? 1 : -1);
    const remainingMs = this.nextFlipAt - Date.now();
    const newRemainingMs = Math.max(0, remainingMs + deltaMs);
    player.charge = 0;
    player.chargeUpdatedAt = Date.now();
    this.pushLog(
      `${player.name} discharged ${charge.toFixed(1)}s to ${direction === 'add' ? 'ADD TIME TO' : 'SUBTRACT TIME FROM'} the flip timer!`
    );
    this.emitEvent({ kind: 'discharge', playerId, direction, amount: Math.round(charge * 10) / 10 });
    return { ok: true, newDelayMs: newRemainingMs };
  }

  checkBanExpirations() {
    for (const p of this.players.values()) {
      if (p.banned && this.flipCount >= p.banUntilFlipCount) {
        p.banned = false;
        this.pushLog(`${p.name} is no longer banned.`);
      }
    }
  }

  enterMeatwatching() {
    this.phase = 'meatwatching';
    this.meatwatchingEndsAt = Date.now() + MEATWATCHING_MS;
    this.pushLog('All tiles have been flipped. Meatwatching has begun - 2 minutes remain!');
  }

  finishGame() {
    this.phase = 'ended';
    const players = [...this.players.values()];

    let max = -1;
    for (const p of players) max = Math.max(max, this.tileCountFor(p.id));
    this.winnerIds = players.filter((p) => this.tileCountFor(p.id) === max).map((p) => p.id);

    let min = Infinity;
    for (const p of players) min = Math.min(min, this.tileCountFor(p.id));
    this.leastTilesIds = players.filter((p) => this.tileCountFor(p.id) === min).map((p) => p.id);
    this.leastTilesCount = min;

    const maxBans = Math.max(0, ...players.map((p) => p.banCount));
    this.mostBannedIds = maxBans > 0 ? players.filter((p) => p.banCount === maxBans).map((p) => p.id) : [];
    this.mostBannedCount = maxBans;

    const maxStolen = Math.max(0, ...players.map((p) => p.tilesStolenFromThem));
    this.biggestCuckIds = maxStolen > 0 ? players.filter((p) => p.tilesStolenFromThem === maxStolen).map((p) => p.id) : [];
    this.biggestCuckCount = maxStolen;

    this.pushLog('Meatwatching is over. Final nests are locked in.');
  }

  tileCountFor(playerId) {
    const player = this.players.get(playerId);
    if (!player) return 0;
    return player.wordIds.reduce((sum, wid) => sum + this.words.get(wid).spelling.length, 0);
  }

  // --- Ban helper ------------------------------------------------------

  banPlayer(player, reason) {
    player.banned = true;
    player.banUntilFlipCount = this.flipCount + BAN_FLIP_WINDOW;
    player.banCount += 1;
    this.pushLog(`${player.name} played an invalid word (${reason}) and is BANNED for 3 flips!`);
    this.emitEvent({ kind: 'ban', playerId: player.id, word: reason });
  }

  assertLive() {
    return this.phase === 'playing' || this.phase === 'meatwatching';
  }

  // --- Unified action resolution ------------------------------------------

  // Figures out which of the four actions a typed word maps to, in priority
  // order cuck/fortify -> steal -> defend -> claim from jungle, and delegates
  // to that action's implementation. Read-only until a branch is chosen, so
  // it's safe to probe all four without side effects.
  playWord(playerId, rawWord) {
    const player = this.players.get(playerId);
    const word = (rawWord || '').trim().toUpperCase();
    if (!player) return { ok: false, error: 'Unknown player.' };
    if (!this.assertLive()) return { ok: false, error: 'The game is not currently active.' };
    if (player.banned) return { ok: false, error: 'You are banned and cannot speak.' };
    if (!word) return { ok: false, error: 'Enter a word.' };

    const actionType = this.resolveActionType(playerId, word);
    if (actionType === 'extend') return this.extendWord(playerId, word);
    if (actionType === 'steal') return this.stealWord(playerId, word);
    if (actionType === 'defend') return this.defendWord(playerId, word);
    if (actionType === 'claim') return this.claimWord(playerId, word);
    return { ok: false, error: `No valid action found for "${word}" right now.` };
  }

  resolveActionType(playerId, word) {
    // Every exact spelling can only ever be used once, for any action,
    // regardless of which word entity it's tied to - so once it's been
    // said, nothing below can match it.
    if (this.allSpellingsEverUsed.has(word)) return null;

    // 1. Cuck/fortify: some active word's letters are a strict sub-multiset
    // of `word`, with the difference sitting in the jungle right now.
    for (const entity of this.words.values()) {
      if (entity.spelling.length >= word.length) continue;
      if (entity.jitImmune && entity.ownerId !== playerId) continue;
      if (isBareAffixExtension(entity.spelling, word)) continue;
      const extra = extraLettersNeeded(word, entity.spelling.split(''));
      if (!extra) continue;
      const extraLetters = counterToLetters(extra);
      if (!removeLettersFromPool(extraLetters.join(''), this.jungle)) continue;
      return 'extend';
    }

    // 2/3. Steal or defend: exact anagram of an already-active word. Route
    // to the real method even for edge cases (JIT-immune) so the player
    // gets that method's specific error rather than a generic one.
    const signature = wordToSignature(word);
    const existingWordId = this.signatureIndex.get(signature);
    if (existingWordId) {
      const entity = this.words.get(existingWordId);
      return entity.ownerId === playerId ? 'defend' : 'steal';
    }

    // 4. Claim: a signature that's never been in play, spellable from the jungle.
    if (!this.usedSignatures.has(signature) && removeLettersFromPool(word, this.jungle)) {
      return 'claim';
    }
    return null;
  }

  // --- Rule 3: claim from jungle ---------------------------------------

  claimWord(playerId, rawWord) {
    const player = this.players.get(playerId);
    const word = (rawWord || '').trim().toUpperCase();
    if (!player) return { ok: false, error: 'Unknown player.' };
    if (!this.assertLive()) return { ok: false, error: 'The game is not currently active.' };
    if (player.banned) return { ok: false, error: 'You are banned and cannot speak.' };
    if (!word) return { ok: false, error: 'Enter a word.' };
    if (word !== JIT && word.length < 4) {
      return { ok: false, error: 'Words must be at least 4 letters (except JIT).' };
    }

    const signature = wordToSignature(word);
    if (this.usedSignatures.has(signature)) {
      return { ok: false, error: 'That word (or an anagram of it) has already been used this game.' };
    }

    const newJungle = removeLettersFromPool(word, this.jungle);
    if (!newJungle) {
      return { ok: false, error: 'The jungle does not contain those letters.' };
    }

    if (!isClaimableWord(word)) {
      this.banPlayer(player, word);
      return { ok: false, error: `"${word}" is not in the dictionary. You are banned!`, banned: true };
    }

    this.jungle = newJungle;
    const wordId = `w${wordIdCounter++}`;
    this.words.set(wordId, {
      id: wordId,
      signature,
      spelling: word,
      ownerId: playerId,
      jitImmune: word === JIT,
    });
    this.signatureIndex.set(signature, wordId);
    this.usedSignatures.add(signature);
    this.allSpellingsEverUsed.add(word);
    player.wordIds.push(wordId);
    this.pushLog(`${player.name} claimed "${word}" from the jungle!`);
    this.emitEvent({ kind: 'claim', playerId, word, wordId, letters: word.split('') });
    return { ok: true, wordId };
  }

  // --- Rule 4/5: steal & defend (pure anagram, same tiles) --------------

  stealWord(playerId, rawWord) {
    const player = this.players.get(playerId);
    const word = (rawWord || '').trim().toUpperCase();
    if (!player) return { ok: false, error: 'Unknown player.' };
    if (!this.assertLive()) return { ok: false, error: 'The game is not currently active.' };
    if (player.banned) return { ok: false, error: 'You are banned and cannot speak.' };
    if (!word) return { ok: false, error: 'Enter a word.' };

    const signature = wordToSignature(word);
    const wordId = this.signatureIndex.get(signature);
    if (!wordId) return { ok: false, error: 'No word with those letters is in play.' };
    const entity = this.words.get(wordId);

    if (entity.ownerId === playerId) {
      return { ok: false, error: 'That word is already in your nest. Did you mean to defend it?' };
    }
    if (entity.jitImmune) return { ok: false, error: 'JIT can never be stolen.' };
    if (this.allSpellingsEverUsed.has(word)) {
      return { ok: false, error: 'That exact spelling has already been used this game.' };
    }

    if (!isValidDictionaryWord(word)) {
      this.banPlayer(player, word);
      return { ok: false, error: `"${word}" is not in the dictionary. You are banned!`, banned: true };
    }

    const oldOwner = this.players.get(entity.ownerId);
    oldOwner.wordIds = oldOwner.wordIds.filter((id) => id !== wordId);
    player.wordIds.push(wordId);
    entity.ownerId = playerId;
    const oldSpelling = entity.spelling;
    oldOwner.tilesStolenFromThem += oldSpelling.length;
    entity.spelling = word;
    this.allSpellingsEverUsed.add(word);
    this.pushLog(`${player.name} stole "${word}" from ${oldOwner.name}!`);
    this.emitEvent({
      kind: 'steal',
      word,
      wordId,
      oldSpelling,
      fromPlayerId: oldOwner.id,
      toPlayerId: playerId,
    });
    return { ok: true, wordId };
  }

  // Defending doesn't take over the word's display spelling or grant
  // blanket immunity - it just permanently burns the one anagram you
  // shouted, the same as if it had been claimed or stolen. E.g. if you hold
  // POST and defend with SPOT, an opponent can still steal it with STOP
  // unless that gets burned too (by them, or by you defending again).
  defendWord(playerId, rawWord) {
    const player = this.players.get(playerId);
    const word = (rawWord || '').trim().toUpperCase();
    if (!player) return { ok: false, error: 'Unknown player.' };
    if (!this.assertLive()) return { ok: false, error: 'The game is not currently active.' };
    if (player.banned) return { ok: false, error: 'You are banned and cannot speak.' };
    if (!word) return { ok: false, error: 'Enter a word.' };

    const signature = wordToSignature(word);
    const wordId = this.signatureIndex.get(signature);
    if (!wordId) return { ok: false, error: 'No word with those letters is in play.' };
    const entity = this.words.get(wordId);

    if (entity.ownerId !== playerId) {
      return { ok: false, error: 'You can only defend words in your own nest.' };
    }
    if (this.allSpellingsEverUsed.has(word)) {
      return { ok: false, error: 'That exact spelling has already been used this game.' };
    }

    if (!isValidDictionaryWord(word)) {
      this.banPlayer(player, word);
      return { ok: false, error: `"${word}" is not in the dictionary. You are banned!`, banned: true };
    }

    this.allSpellingsEverUsed.add(word);
    this.pushLog(`${player.name} fortified "${entity.spelling}" by burning the anagram "${word}" - it can no longer be used!`);
    this.emitEvent({ kind: 'defend', word, wordId, playerId });
    return { ok: true, wordId };
  }

  // --- Rule 6/7: cuckold (steal + jungle tiles) & fortify (self-extend) -

  extendWord(playerId, rawWord) {
    const player = this.players.get(playerId);
    const word = (rawWord || '').trim().toUpperCase();
    if (!player) return { ok: false, error: 'Unknown player.' };
    if (!this.assertLive()) return { ok: false, error: 'The game is not currently active.' };
    if (player.banned) return { ok: false, error: 'You are banned and cannot speak.' };
    if (!word) return { ok: false, error: 'Enter a word.' };

    // Find a base word entity whose letters are fully contained in `word`.
    let match = null;
    for (const entity of this.words.values()) {
      if (entity.spelling.length >= word.length) continue;
      if (entity.jitImmune && entity.ownerId !== playerId) continue;
      const extra = extraLettersNeeded(word, entity.spelling.split(''));
      if (extra) {
        match = { entity, extra };
        break;
      }
    }
    if (!match) {
      return { ok: false, error: 'No word in play can be extended into that word.' };
    }
    const { entity, extra } = match;

    if (this.allSpellingsEverUsed.has(word)) {
      return { ok: false, error: 'That exact spelling has already been used this game.' };
    }
    if (isBareAffixExtension(entity.spelling, word)) {
      return {
        ok: false,
        error: `"${word}" is just a prefix/suffix on "${entity.spelling}" - not sufficiently changed to cuck/fortify.`,
      };
    }

    const extraLetters = counterToLetters(extra);
    const newJungle = removeLettersFromPool(extraLetters.join(''), this.jungle);
    if (!newJungle) {
      return { ok: false, error: 'The jungle does not contain the extra letters needed.' };
    }

    if (!isValidDictionaryWord(word)) {
      this.banPlayer(player, word);
      return { ok: false, error: `"${word}" is not in the dictionary. You are banned!`, banned: true };
    }

    const newSignature = wordToSignature(word);
    const oldSpelling = entity.spelling;
    const fromPlayerId = entity.ownerId;

    this.jungle = newJungle;
    this.signatureIndex.delete(entity.signature);
    const isFortify = entity.ownerId === playerId;

    if (!isFortify) {
      const oldOwner = this.players.get(entity.ownerId);
      oldOwner.wordIds = oldOwner.wordIds.filter((id) => id !== entity.id);
      player.wordIds.push(entity.id);
      entity.ownerId = playerId;
      // Only the tiles the victim actually had are "stolen" - the extra
      // jungle letters that grew the word into something new were never
      // theirs to lose.
      oldOwner.tilesStolenFromThem += oldSpelling.length;
    }
    entity.signature = newSignature;
    entity.spelling = word;
    this.usedSignatures.add(newSignature);
    this.allSpellingsEverUsed.add(word);
    this.signatureIndex.set(newSignature, entity.id);

    this.pushLog(
      isFortify
        ? `${player.name} fortified "${oldSpelling}" into "${word}"!`
        : `${player.name} cuckolded "${oldSpelling}" into "${word}" and stole it!`
    );
    this.emitEvent({
      kind: 'extend',
      word,
      wordId: entity.id,
      oldSpelling,
      extraLetters,
      fromPlayerId,
      toPlayerId: playerId,
      fortify: isFortify,
    });
    return { ok: true, wordId: entity.id, fortify: isFortify };
  }

  // --- Serialization -----------------------------------------------------

  toPublicState() {
    const players = this.playerOrder
      .filter((id) => this.players.has(id))
      .map((id) => {
        const p = this.players.get(id);
        return {
          id: p.id,
          name: p.name,
          connected: p.connected,
          banned: p.banned,
          banUntilFlipCount: p.banUntilFlipCount,
          isHost: id === this.hostId,
          tileCount: this.tileCountFor(p.id),
          charge: this.getCurrentCharge(p),
          chargeUpdatedAt: p.chargeUpdatedAt,
          words: p.wordIds.map((wid) => {
            const w = this.words.get(wid);
            return { id: w.id, spelling: w.spelling };
          }),
        };
      });

    return {
      roomCode: this.roomCode,
      phase: this.phase,
      players,
      jungle: this.jungle,
      bagCount: this.bag.length,
      nextFlipAt: this.nextFlipAt,
      meterMax: METER_MAX,
      meterRate: METER_RATE,
      flipCount: this.flipCount,
      meatwatchingEndsAt: this.meatwatchingEndsAt,
      winnerIds: this.winnerIds,
      leastTilesIds: this.leastTilesIds,
      leastTilesCount: this.leastTilesCount,
      mostBannedIds: this.mostBannedIds,
      mostBannedCount: this.mostBannedCount,
      biggestCuckIds: this.biggestCuckIds,
      biggestCuckCount: this.biggestCuckCount,
      log: this.log.slice(-30),
      lastEvent: this.lastEvent,
      allWordsUsed: [...this.allSpellingsEverUsed].sort(),
    };
  }
}

module.exports = { Game, MEATWATCHING_MS, BAN_FLIP_WINDOW, FLIP_MIN_MS, FLIP_MAX_MS, METER_MAX, METER_RATE };
