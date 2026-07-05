(() => {
  const socket = io();

  function getClientId() {
    let id = localStorage.getItem('predatorScrabbleClientId');
    if (!id) {
      id = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('predatorScrabbleClientId', id);
    }
    return id;
  }
  const clientId = getClientId();

  const screens = {
    landing: document.getElementById('screen-landing'),
    lobby: document.getElementById('screen-lobby'),
    game: document.getElementById('screen-game'),
    end: document.getElementById('screen-end'),
  };

  function showScreen(name) {
    for (const key of Object.keys(screens)) {
      screens[key].classList.toggle('hidden', key !== name);
    }
  }

  let myPlayerId = null;
  let currentRoomCode = null;
  let meatwatchingInterval = null;
  let lastPhase = null;

  // --- Tile flight animation ---------------------------------------------

  const FLIGHT_MS = 650;
  const animatingWordIds = new Set(); // word ids currently mid-flight, hidden in their destination nest until landing
  let lastEventSeq = 0;
  let hasSeenFirstState = false;

  function rectValid(rect) {
    return !!rect && rect.width > 0 && rect.height > 0;
  }

  function positionGhost(el, rect) {
    el.style.position = 'fixed';
    el.style.left = rect.left + 'px';
    el.style.top = rect.top + 'px';
    el.style.width = rect.width + 'px';
    el.style.height = rect.height + 'px';
    el.style.margin = '0';
    el.style.zIndex = 999;
    el.style.pointerEvents = 'none';
    el.style.willChange = 'transform';
  }

  function spawnFlyingTile(letter, fromRect, toRect) {
    if (!rectValid(fromRect) || !rectValid(toRect)) return;
    const ghost = document.createElement('div');
    ghost.className = 'tile flying-tile';
    ghost.textContent = letter;
    positionGhost(ghost, fromRect);
    document.body.appendChild(ghost);
    ghost.getBoundingClientRect(); // force reflow so the transition below is picked up
    const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
    const dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
    ghost.style.transition = `transform ${FLIGHT_MS}ms cubic-bezier(0.45, 0, 0.55, 1)`;
    requestAnimationFrame(() => {
      ghost.style.transform = `translate(${dx}px, ${dy}px) scale(0.85)`;
    });
    setTimeout(() => ghost.remove(), FLIGHT_MS + 60);
  }

  function getNestCard(playerId) {
    return document.querySelector(`.nest-card[data-player-id="${CSS.escape(playerId)}"]`);
  }
  function getNestWordsContainer(playerId) {
    return document.querySelector(`.nest-words[data-player-id="${CSS.escape(playerId)}"]`);
  }
  function getWordEl(container, wordId) {
    return container ? container.querySelector(`.nest-word[data-word-id="${CSS.escape(wordId)}"]`) : null;
  }
  function consumeJungleTileEl(letter, consumedSet) {
    const tiles = document.querySelectorAll('#jungle .tile');
    for (const el of tiles) {
      if (!consumedSet.has(el) && el.textContent === letter) {
        consumedSet.add(el);
        return el;
      }
    }
    return null;
  }

  function scheduleReveal(wordId) {
    setTimeout(() => {
      animatingWordIds.delete(wordId);
      if (lastState) renderNests(lastState);
    }, FLIGHT_MS);
  }

  // Runs BEFORE the new state is rendered, so it can measure where things
  // currently are on screen (jungle tiles, nest words) and fly ghost copies
  // of them toward their destination while the real DOM catches up.
  function handleFlyingEvent(event) {
    if (screens.game.classList.contains('hidden')) return;
    const jungleEl = document.getElementById('jungle');

    // 'flip' (donut -> jungle) has no ghost animation of its own anymore -
    // the jungle physics simulation already shows the new tile sliding in
    // from the edge as it joins the cluster, so a separate flying ghost on
    // top of that just looked like two tiles arriving at once.
    if (event.kind === 'claim') {
      const destRect = getNestWordsContainer(event.playerId)?.getBoundingClientRect();
      const consumed = new Set();
      animatingWordIds.add(event.wordId);
      for (const letter of event.letters) {
        const tileEl = consumeJungleTileEl(letter, consumed);
        spawnFlyingTile(letter, tileEl?.getBoundingClientRect(), destRect);
      }
      scheduleReveal(event.wordId);
    } else if (event.kind === 'steal') {
      const fromContainer = getNestWordsContainer(event.fromPlayerId);
      const wordEl = getWordEl(fromContainer, event.wordId);
      const destRect = getNestWordsContainer(event.toPlayerId)?.getBoundingClientRect();
      animatingWordIds.add(event.wordId);
      if (wordEl) {
        wordEl.querySelectorAll('.tile').forEach((t) => spawnFlyingTile(t.textContent, t.getBoundingClientRect(), destRect));
      }
      scheduleReveal(event.wordId);
    } else if (event.kind === 'extend') {
      const fromContainer = getNestWordsContainer(event.fromPlayerId);
      const wordEl = getWordEl(fromContainer, event.wordId);
      const destRect = getNestWordsContainer(event.toPlayerId)?.getBoundingClientRect();
      animatingWordIds.add(event.wordId);
      if (wordEl) {
        wordEl.querySelectorAll('.tile').forEach((t) => spawnFlyingTile(t.textContent, t.getBoundingClientRect(), destRect));
      }
      const consumed = new Set();
      for (const letter of event.extraLetters) {
        const tileEl = consumeJungleTileEl(letter, consumed);
        spawnFlyingTile(letter, tileEl?.getBoundingClientRect(), destRect || jungleEl.getBoundingClientRect());
      }
      scheduleReveal(event.wordId);
    }
  }

  // Runs AFTER the new state is rendered, for effects that highlight
  // something already in its final resting place rather than moving it.
  function handlePostRenderEffect(event) {
    if (event.kind === 'defend') {
      const wordEl = getWordEl(getNestWordsContainer(event.playerId), event.wordId);
      if (wordEl) {
        wordEl.classList.add('pulse-defend');
        setTimeout(() => wordEl.classList.remove('pulse-defend'), 750);
      }
    } else if (event.kind === 'ban') {
      const card = getNestCard(event.playerId);
      if (card) {
        card.classList.add('shake-ban');
        setTimeout(() => card.classList.remove('shake-ban'), 550);
      }
    }
    // 'discharge' (rush/stall) is intentionally not toasted - it's already
    // in the feed via the server's log, and doesn't warrant a pop-up.
  }

  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  // --- Landing screen ----------------------------------------------------

  const inputName = document.getElementById('input-name');
  const inputRoomCode = document.getElementById('input-room-code');
  const landingError = document.getElementById('landing-error');

  document.getElementById('btn-create-room').addEventListener('click', () => {
    const name = inputName.value.trim() || 'Player';
    socket.emit('createRoom', { name, clientId }, (res) => {
      if (!res.ok) { landingError.textContent = res.error; return; }
      myPlayerId = res.playerId;
      currentRoomCode = res.roomCode;
      landingError.textContent = '';
    });
  });

  document.getElementById('btn-join-room').addEventListener('click', () => {
    const name = inputName.value.trim() || 'Player';
    const roomCode = inputRoomCode.value.trim().toUpperCase();
    if (!roomCode) { landingError.textContent = 'Enter a room code.'; return; }
    socket.emit('joinRoom', { name, roomCode, clientId }, (res) => {
      if (!res.ok) { landingError.textContent = res.error; return; }
      myPlayerId = res.playerId;
      currentRoomCode = res.roomCode;
      landingError.textContent = '';
    });
  });

  // --- Lobby screen --------------------------------------------------------

  document.getElementById('btn-start-game').addEventListener('click', () => {
    socket.emit('startGame', {}, () => {
      // Failure reasons (not enough players, etc.) are already shown
      // continuously via the lobby hint text - no need to also pop a toast.
    });
  });

  // --- Game screen: unified action ----------------------------------------

  const inputWord = document.getElementById('input-word');
  const actionError = document.getElementById('action-error');

  function playCurrentWord() {
    const word = inputWord.value.trim().toUpperCase();
    if (!word) { actionError.textContent = 'Type a word first.'; return; }
    socket.emit('playWord', { word }, (res) => {
      if (!res.ok) {
        actionError.textContent = res.error;
        if (res.banned) toast(`BANNED: ${res.error}`);
      } else {
        actionError.textContent = '';
        inputWord.value = '';
      }
    });
  }

  document.getElementById('btn-play').addEventListener('click', playCurrentWord);

  function dischargeCharge(direction) {
    socket.emit('dischargeCharge', { direction }, () => {
      // Errors here (e.g. no charge yet) are silent - the buttons are
      // already disabled at 0 charge, so this is just a rare race.
    });
  }

  document.getElementById('btn-rush').addEventListener('click', () => dischargeCharge('subtract'));
  document.getElementById('btn-stall').addEventListener('click', () => dischargeCharge('add'));

  document.getElementById('btn-play-again').addEventListener('click', () => {
    window.location.reload();
  });

  socket.on('actionError', ({ error, banned }) => {
    if (banned) toast(`BANNED: ${error}`);
  });

  // --- Rendering ---------------------------------------------------------

  // --- Jungle physics ------------------------------------------------------
  //
  // Jungle tiles are simulated as loose particles: a gentle pull toward the
  // center keeps them clustered, and mutual repulsion keeps them from
  // overlapping, so a newly-flipped tile visibly slides in from the edge and
  // nudges its neighbors aside to make room. The simulation only runs for a
  // brief burst after something actually changes (add/remove/shuffle) and
  // stops itself once everything settles, so nothing jitters at rest.
  //
  // This is local to each client - it's a personal, cosmetic arrangement
  // (spacebar reshuffles it for that player only) and never touches the
  // authoritative `state.jungle` letters array.

  let jungleTiles = []; // { id, letter, x, y, vx, vy } - x/y are offsets from the jungle's center, in px
  let jungleTileIdCounter = 1;
  let junglePhysicsRafId = null;

  const JUNGLE_CENTER_PULL = 0.015;
  const JUNGLE_MIN_DIST = 52; // comfortably past the tile's diagonal (~45px) so borders never touch, even corner-to-corner
  const JUNGLE_DAMPING = 0.78;
  const JUNGLE_SETTLE_EPS = 0.04;
  const JUNGLE_EDGE_MARGIN = 22;

  function jungleRadiusPx() {
    const jungleEl = document.getElementById('jungle');
    const size = jungleEl.clientWidth;
    return (size ? size / 2 : 150) - JUNGLE_EDGE_MARGIN;
  }

  function syncJungleTiles(serverLetters) {
    const remaining = [...serverLetters];
    const kept = [];
    for (const t of jungleTiles) {
      const idx = remaining.indexOf(t.letter);
      if (idx !== -1) {
        kept.push(t);
        remaining.splice(idx, 1);
      }
    }
    const removedAny = kept.length < jungleTiles.length;
    const addedAny = remaining.length > 0;

    const radius = jungleRadiusPx();
    for (const letter of remaining) {
      const angle = Math.random() * Math.PI * 2;
      kept.push({ id: jungleTileIdCounter++, letter, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 });
    }
    jungleTiles = kept;
    renderJungleTilePositions();
    if (addedAny || removedAny) startJunglePhysics();
  }

  function shuffleJungleTiles() {
    const radius = jungleRadiusPx();
    for (const t of jungleTiles) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.random() * radius;
      t.x = Math.cos(angle) * r;
      t.y = Math.sin(angle) * r;
    }
    startJunglePhysics();
  }

  function startJunglePhysics() {
    if (junglePhysicsRafId) return;
    junglePhysicsRafId = requestAnimationFrame(junglePhysicsTick);
  }

  function junglePhysicsTick() {
    const radius = jungleRadiusPx();

    for (const t of jungleTiles) {
      t.vx += -t.x * JUNGLE_CENTER_PULL;
      t.vy += -t.y * JUNGLE_CENTER_PULL;
    }

    for (let i = 0; i < jungleTiles.length; i++) {
      for (let j = i + 1; j < jungleTiles.length; j++) {
        const a = jungleTiles[i];
        const b = jungleTiles[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          dist = 0.01;
        }
        if (dist < JUNGLE_MIN_DIST) {
          const overlap = (JUNGLE_MIN_DIST - dist) / dist;
          const pushX = dx * overlap * 0.5;
          const pushY = dy * overlap * 0.5;
          a.vx -= pushX;
          a.vy -= pushY;
          b.vx += pushX;
          b.vy += pushY;
        }
      }
    }

    let maxSpeed = 0;
    for (const t of jungleTiles) {
      t.vx *= JUNGLE_DAMPING;
      t.vy *= JUNGLE_DAMPING;
      t.x += t.vx;
      t.y += t.vy;
      const d = Math.sqrt(t.x * t.x + t.y * t.y);
      if (d > radius) {
        t.x = (t.x / d) * radius;
        t.y = (t.y / d) * radius;
        t.vx *= 0.4;
        t.vy *= 0.4;
      }
      maxSpeed = Math.max(maxSpeed, Math.abs(t.vx), Math.abs(t.vy));
    }

    renderJungleTilePositions();

    junglePhysicsRafId = maxSpeed > JUNGLE_SETTLE_EPS ? requestAnimationFrame(junglePhysicsTick) : null;
  }

  function renderJungleTilePositions() {
    const jungleEl = document.getElementById('jungle');
    const existing = new Map();
    jungleEl.querySelectorAll('.jungle-tile').forEach((el) => existing.set(Number(el.dataset.tileId), el));

    const seen = new Set();
    for (const t of jungleTiles) {
      seen.add(t.id);
      let el = existing.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tile jungle-tile';
        el.dataset.tileId = t.id;
        el.textContent = t.letter;
        jungleEl.appendChild(el);
      }
      el.style.transform = `translate(${t.x}px, ${t.y}px)`;
    }
    for (const [id, el] of existing) {
      if (!seen.has(id)) el.remove();
    }
  }

  function renderDonut(state) {
    const donut = document.getElementById('donut');
    const jungleEl = document.getElementById('jungle');
    donut.querySelectorAll('.donut-tile').forEach((el) => el.remove());

    const count = Math.min(state.bagCount, 98);
    const radius = donut.clientWidth ? donut.clientWidth * 0.42 : 220;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * 360;
      const tile = document.createElement('div');
      tile.className = 'donut-tile';
      tile.style.transform = `rotate(${angle}deg) translate(${radius}px) rotate(${-angle}deg)`;
      donut.insertBefore(tile, jungleEl);
    }

    syncJungleTiles(state.jungle);

    document.getElementById('bag-count').textContent = `${state.bagCount} tiles left in the donut`;
  }

  function renderWordTiles(container, spelling, hide) {
    container.innerHTML = '';
    for (const letter of spelling) {
      const t = document.createElement('div');
      t.className = 'tile' + (hide ? ' tile-incoming' : '');
      t.textContent = letter;
      container.appendChild(t);
    }
  }

  function renderNests(state) {
    const nests = document.getElementById('nests');
    nests.querySelectorAll('.nest-card').forEach((el) => el.remove());
    for (const p of state.players) {
      const card = document.createElement('div');
      card.className = 'nest-card';
      card.dataset.playerId = p.id;
      if (p.id === myPlayerId) card.classList.add('is-me');
      if (p.banned) card.classList.add('is-banned');

      const head = document.createElement('div');
      head.className = 'nest-head';
      head.innerHTML = `
        <span class="nest-name">${escapeHtml(p.name)}${p.id === myPlayerId ? ' (you)' : ''}${p.isHost ? ' \u{1F451}' : ''}</span>
        <span class="nest-count">${p.tileCount} tiles</span>
      `;
      card.appendChild(head);

      if (p.banned) {
        const s = document.createElement('div');
        s.className = 'nest-status';
        const flipsLeft = Math.max(0, p.banUntilFlipCount - state.flipCount);
        s.textContent = `BANNED - cannot speak (${flipsLeft} flip${flipsLeft === 1 ? '' : 's'} left)`;
        card.appendChild(s);
      }
      if (!p.connected) {
        const s = document.createElement('div');
        s.className = 'nest-offline';
        s.textContent = 'disconnected';
        card.appendChild(s);
      }

      const wordsWrap = document.createElement('div');
      wordsWrap.className = 'nest-words';
      wordsWrap.dataset.playerId = p.id;
      for (const w of p.words) {
        const wordEl = document.createElement('div');
        wordEl.className = 'nest-word';
        wordEl.dataset.wordId = w.id;
        renderWordTiles(wordEl, w.spelling, animatingWordIds.has(w.id));
        wordsWrap.appendChild(wordEl);
      }
      card.appendChild(wordsWrap);

      const meter = document.createElement('div');
      meter.className = 'charge-meter';
      meter.dataset.charge = p.charge;
      meter.dataset.chargeUpdatedAt = p.chargeUpdatedAt;
      meter.dataset.meterMax = state.meterMax;
      meter.dataset.meterRate = state.meterRate;
      meter.innerHTML = `
        <div class="charge-bar-track"><div class="charge-bar"></div></div>
        <div class="charge-value">0.0s</div>
      `;
      card.appendChild(meter);

      nests.appendChild(card);
    }
    updateChargeBars();
  }

  // Charge bars fill continuously between server updates; recompute them
  // locally from each meter's last known baseline + elapsed time instead of
  // waiting for a fresh broadcast every tick. The rush/stall buttons live
  // outside "The Table" (under Play Word), so "my" meter also drives their
  // disabled state here.
  function updateChargeBars() {
    const now = Date.now();
    document.querySelectorAll('.charge-meter').forEach((meter) => {
      const baseCharge = parseFloat(meter.dataset.charge) || 0;
      const updatedAt = parseFloat(meter.dataset.chargeUpdatedAt) || now;
      const meterMax = parseFloat(meter.dataset.meterMax) || 3;
      const meterRate = parseFloat(meter.dataset.meterRate) || 1 / 3;
      const elapsedSec = (now - updatedAt) / 1000;
      const charge = Math.min(meterMax, baseCharge + elapsedSec * meterRate);
      const bar = meter.querySelector('.charge-bar');
      if (bar) bar.style.width = `${(charge / meterMax) * 100}%`;
      const valueLabel = meter.querySelector('.charge-value');
      if (valueLabel) valueLabel.textContent = `${charge.toFixed(1)}s`;

      if (meter.closest('.nest-card')?.classList.contains('is-me')) {
        const disabled = charge <= 0.05;
        document.getElementById('btn-rush').disabled = disabled;
        document.getElementById('btn-stall').disabled = disabled;
      }
    });
  }

  function renderLog(state) {
    const list = document.getElementById('log-list');
    list.innerHTML = '';
    for (const entry of [...state.log].reverse()) {
      const li = document.createElement('li');
      li.textContent = entry.message;
      list.appendChild(li);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderLobby(state) {
    document.getElementById('lobby-room-code').textContent = state.roomCode;
    const list = document.getElementById('lobby-players');
    list.innerHTML = '';
    for (const p of state.players) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(p.name)}${p.isHost ? ' \u{1F451}' : ''}${p.id === myPlayerId ? ' (you)' : ''}</span>${p.connected ? '' : '<span class="offline">offline</span>'}`;
      list.appendChild(li);
    }
    const isHost = state.players.find((p) => p.id === myPlayerId)?.isHost;
    const startBtn = document.getElementById('btn-start-game');
    const connectedCount = state.players.filter((p) => p.connected).length;
    startBtn.classList.toggle('hidden', !isHost);
    startBtn.disabled = connectedCount < 2;
    document.getElementById('lobby-hint').textContent = isHost
      ? (connectedCount < 2 ? 'Need at least 2 players to start.' : 'Ready when you are.')
      : 'Waiting for the host to start…';
  }

  function renderGameHeader(state) {
    document.getElementById('header-room-code').textContent = state.roomCode;
    const phaseBanner = document.getElementById('phase-banner');

    if (state.phase === 'playing') {
      phaseBanner.textContent = 'FLIPPING TILES';
      phaseBanner.style.color = 'var(--green)';
    } else if (state.phase === 'meatwatching') {
      phaseBanner.textContent = 'MEATWATCHING';
      phaseBanner.style.color = 'var(--accent2)';
    }

    document.querySelector('.flip-countdown').classList.toggle('hidden', state.phase !== 'playing');
  }

  function updateFlipCountdown(state) {
    if (!state || state.phase !== 'playing' || !state.nextFlipAt) return;
    const label = document.getElementById('flip-countdown-label');
    const bar = document.getElementById('flip-countdown-bar');
    const remainingMs = Math.max(0, state.nextFlipAt - Date.now());
    label.textContent = `Next flip in ${(remainingMs / 1000).toFixed(1)}s`;
    // The full duration isn't tracked client-side, so approximate the bar
    // against a rolling 15s window - it still reads clearly as "draining".
    const pct = Math.max(0, Math.min(100, (remainingMs / 15000) * 100));
    bar.style.width = `${pct}%`;
    bar.style.background = remainingMs < 2000 ? 'var(--accent2)' : 'var(--green)';
  }

  function startMeatwatchingCountdown(endsAt) {
    clearInterval(meatwatchingInterval);
    const turnBanner = document.getElementById('turn-banner');
    meatwatchingInterval = setInterval(() => {
      const remaining = Math.max(0, endsAt - Date.now());
      const secs = Math.ceil(remaining / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      turnBanner.textContent = `Final steals! ${m}:${s.toString().padStart(2, '0')} remaining`;
      if (remaining <= 0) clearInterval(meatwatchingInterval);
    }, 250);
  }

  function renderEnd(state) {
    const winners = state.players.filter((p) => state.winnerIds?.includes(p.id));
    const title = document.getElementById('end-title');
    title.textContent = winners.length > 1 ? "It's a tie!" : `${winners[0]?.name || '?'} wins!`;

    const results = document.getElementById('end-results');
    const sorted = [...state.players].sort((a, b) => b.tileCount - a.tileCount);
    results.innerHTML = sorted
      .map((p, i) => `<div>${i + 1}. <b>${escapeHtml(p.name)}</b> — ${p.tileCount} tiles (${p.words.map((w) => w.spelling).join(', ')})</div>`)
      .join('');
  }

  let lastState = null;

  function render(state) {
    lastState = state;
    if (state.phase === 'lobby') {
      showScreen('lobby');
      renderLobby(state);
    } else if (state.phase === 'playing' || state.phase === 'meatwatching') {
      showScreen('game');
      renderGameHeader(state);
      renderDonut(state);
      renderNests(state);
      renderLog(state);
      if (state.phase === 'meatwatching' && lastPhase !== 'meatwatching') {
        startMeatwatchingCountdown(state.meatwatchingEndsAt);
      }
      updateFlipCountdown(state);
      const myPlayer = state.players.find((p) => p.id === myPlayerId);
      document.getElementById('btn-play').disabled = !!myPlayer?.banned;
    } else if (state.phase === 'ended') {
      clearInterval(meatwatchingInterval);
      showScreen('end');
      renderEnd(state);
    }
    lastPhase = state.phase;
  }

  function onState(state) {
    const event = state.lastEvent;
    // The first state a client ever sees (right after connecting) just
    // establishes the baseline seq - it may already reflect actions that
    // happened before this client joined, so it's never animated. Every
    // state after that is compared against the baseline.
    if (!hasSeenFirstState) {
      hasSeenFirstState = true;
      lastEventSeq = event ? event.seq : 0;
      render(state);
      return;
    }
    const isNewEvent = !!event && event.seq > lastEventSeq;
    if (isNewEvent) handleFlyingEvent(event);
    render(state);
    if (isNewEvent) handlePostRenderEffect(event);
    lastEventSeq = event ? event.seq : lastEventSeq;
  }

  socket.on('state', onState);

  // Ticks the flip countdown and charge meters smoothly between server
  // broadcasts, since both are just derived from timestamps.
  setInterval(() => {
    if (!lastState) return;
    if (lastState.phase === 'playing') updateFlipCountdown(lastState);
    if (!screens.game.classList.contains('hidden')) updateChargeBars();
  }, 100);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastState && (lastState.phase === 'playing' || lastState.phase === 'meatwatching')) {
        renderDonut(lastState);
        startJunglePhysics(); // re-clamp tiles to the new radius
      }
    }, 150);
  });

  // --- Hold-TAB word history overlay --------------------------------------

  let tabHeld = false;
  const wordHistoryOverlay = document.getElementById('word-history-overlay');

  function renderWordHistory(state) {
    const list = document.getElementById('word-history-list');
    const words = state?.allWordsUsed || [];
    list.innerHTML = words.length
      ? words.map((w) => `<span class="word-history-chip">${escapeHtml(w)}</span>`).join('')
      : '<p class="hint">No words played yet.</p>';
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    if (!tabHeld) {
      tabHeld = true;
      renderWordHistory(lastState);
      wordHistoryOverlay.classList.remove('hidden');
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Tab') return;
    tabHeld = false;
    wordHistoryOverlay.classList.add('hidden');
  });
  window.addEventListener('blur', () => {
    tabHeld = false;
    wordHistoryOverlay.classList.add('hidden');
  });

  // --- +/- hotkeys for the charge meter ------------------------------------

  const heldDischargeKeys = new Set();
  document.addEventListener('keydown', (e) => {
    if (screens.game.classList.contains('hidden')) return;
    const isStall = e.key === '+' || e.key === '=';
    const isRush = e.key === '-' || e.key === '_';
    if (!isStall && !isRush) return;
    e.preventDefault();
    if (heldDischargeKeys.has(e.key)) return; // ignore OS key-repeat while held
    heldDischargeKeys.add(e.key);
    dischargeCharge(isStall ? 'add' : 'subtract');
  });
  document.addEventListener('keyup', (e) => {
    heldDischargeKeys.delete(e.key);
  });

  // --- Enter to play, Spacebar to shuffle the jungle (locally) -------------

  document.addEventListener('keydown', (e) => {
    if (screens.game.classList.contains('hidden')) return;

    if (e.key === 'Enter') {
      playCurrentWord();
      return;
    }

    if (e.code === 'Space' || e.key === ' ') {
      // Words never contain spaces, so spacebar is free to always mean
      // "shuffle" - no need to click out of the word box first.
      e.preventDefault();
      shuffleJungleTiles();
    }
  });
})();
