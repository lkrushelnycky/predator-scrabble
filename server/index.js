const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

const rooms = new Map(); // roomCode -> Game
const meatwatchingTimers = new Map(); // roomCode -> Timeout
const flipTimers = new Map(); // roomCode -> Timeout

// Nobody can do anything until 4 tiles are down (words need 4+ letters, JIT
// aside), so the first few flips wait out the normal ramped countdown for
// nothing. Fire the first 3 in quick succession instead, then hand off to
// the normal timer starting at the 4th flip.
const OPENING_FLIP_COUNT = 3;
const OPENING_FLIP_DELAY_MS = 500;

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function broadcastState(roomCode) {
  const game = rooms.get(roomCode);
  if (!game) return;
  io.to(roomCode).emit('state', game.toPublicState());
}

function scheduleMeatwatchingEnd(roomCode, game) {
  if (meatwatchingTimers.has(roomCode)) return;
  const delay = Math.max(0, game.meatwatchingEndsAt - Date.now());
  const timer = setTimeout(() => {
    meatwatchingTimers.delete(roomCode);
    if (game.phase === 'meatwatching') {
      game.finishGame();
      broadcastState(roomCode);
    }
  }, delay);
  meatwatchingTimers.set(roomCode, timer);
}

// The auto-flip timer is owned here (not inside Game) so it can be freely
// cancelled and rescheduled whenever a player discharges their meter.
function scheduleAutoFlip(roomCode, game, delayMs) {
  const existing = flipTimers.get(roomCode);
  if (existing) clearTimeout(existing);

  game.nextFlipAt = Date.now() + delayMs;
  const timer = setTimeout(() => {
    flipTimers.delete(roomCode);
    const result = game.autoFlip();
    // Reschedule (which sets the new nextFlipAt) before broadcasting, so
    // clients never receive a stale/already-past countdown timestamp.
    if (result.ok && result.scheduleNextMs != null) {
      scheduleAutoFlip(roomCode, game, result.scheduleNextMs);
    } else {
      game.nextFlipAt = null;
    }
    broadcastState(roomCode);
  }, delayMs);
  flipTimers.set(roomCode, timer);
}

// Fires `flipsRemaining` flips back-to-back at a fixed short interval, then
// falls through to the normal ramped cadence for whatever comes after.
function scheduleOpeningFlip(roomCode, game, flipsRemaining) {
  const existing = flipTimers.get(roomCode);
  if (existing) clearTimeout(existing);

  game.nextFlipAt = Date.now() + OPENING_FLIP_DELAY_MS;
  const timer = setTimeout(() => {
    flipTimers.delete(roomCode);
    const result = game.autoFlip();
    if (result.ok && result.scheduleNextMs != null) {
      if (flipsRemaining > 1) {
        scheduleOpeningFlip(roomCode, game, flipsRemaining - 1);
      } else {
        scheduleAutoFlip(roomCode, game, game.flipDurationMs(game.flipCount + 1));
      }
    } else {
      game.nextFlipAt = null;
    }
    broadcastState(roomCode);
  }, OPENING_FLIP_DELAY_MS);
  flipTimers.set(roomCode, timer);
}

function handleResult(socket, roomCode, result) {
  const game = rooms.get(roomCode);
  if (!result.ok) {
    socket.emit('actionError', { error: result.error, banned: !!result.banned });
  }
  if (game) {
    if (game.phase === 'meatwatching') scheduleMeatwatchingEnd(roomCode, game);
    broadcastState(roomCode);
  }
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.playerId = null;

  // clientId is a persistent id the browser stores in localStorage, so a
  // page refresh or dropped connection reconnects to the same nest instead
  // of spawning a fresh player.
  socket.on('createRoom', ({ name, clientId }, cb) => {
    const roomCode = makeRoomCode();
    const game = new Game(roomCode);
    rooms.set(roomCode, game);
    const player = game.addPlayer(clientId, (name || 'Player').slice(0, 20));
    game.markReconnected(clientId);
    socket.data.roomCode = roomCode;
    socket.data.playerId = player.id;
    socket.join(roomCode);
    cb({ ok: true, roomCode, playerId: player.id });
    broadcastState(roomCode);
  });

  socket.on('joinRoom', ({ roomCode, name, clientId }, cb) => {
    const code = (roomCode || '').trim().toUpperCase();
    const game = rooms.get(code);
    if (!game) {
      cb({ ok: false, error: 'Room not found.' });
      return;
    }
    const player = game.addPlayer(clientId, (name || 'Player').slice(0, 20));
    game.markReconnected(clientId);
    socket.data.roomCode = code;
    socket.data.playerId = player.id;
    socket.join(code);
    cb({ ok: true, roomCode: code, playerId: player.id });
    broadcastState(code);
  });

  socket.on('startGame', (_payload, cb) => {
    const game = rooms.get(socket.data.roomCode);
    if (!game) return cb?.({ ok: false, error: 'No room.' });
    const result = game.startGame(socket.data.playerId);
    if (result.ok) scheduleOpeningFlip(socket.data.roomCode, game, OPENING_FLIP_COUNT);
    handleResult(socket, socket.data.roomCode, result);
    cb?.(result);
  });

  socket.on('playWord', ({ word }, cb) => {
    const game = rooms.get(socket.data.roomCode);
    if (!game) return cb?.({ ok: false, error: 'No room.' });
    const result = game.playWord(socket.data.playerId, word);
    handleResult(socket, socket.data.roomCode, result);
    cb?.(result);
  });

  socket.on('dischargeCharge', ({ direction }, cb) => {
    const game = rooms.get(socket.data.roomCode);
    if (!game) return cb?.({ ok: false, error: 'No room.' });
    const result = game.dischargeCharge(socket.data.playerId, direction);
    if (result.ok && result.newDelayMs != null) {
      scheduleAutoFlip(socket.data.roomCode, game, result.newDelayMs);
    }
    handleResult(socket, socket.data.roomCode, result);
    cb?.(result);
  });

  socket.on('disconnect', () => {
    const game = rooms.get(socket.data.roomCode);
    if (!game) return;
    game.markDisconnected(socket.data.playerId);
    broadcastState(socket.data.roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`Predator Scrabble server listening on port ${PORT}`);
});
