# Predator Scrabble .io

An online multiplayer version of "Predator Scrabble" - the Bananagrams-style
donut/jungle anagram-steal game. Built with Node.js, Express, and Socket.IO
on the backend and a plain HTML/CSS/JS client (no build step).

## Rules implemented

- Standard 100-tile Scrabble letter distribution minus the 2 blanks (98
  letter tiles), per rule 1.
- Tiles flip face-up into the jungle automatically on a shared countdown -
  there are no turns. The first 3 tiles flip in quick succession at the
  start (nothing's playable with fewer than 4 letters down anyway), then
  the countdown proper kicks in from the 4th flip onward: 5s ramping
  linearly up to 15s by the second-to-last tile.
- Each player has a charge meter (max 3s, refilling at ~0.33s of charge per
  real second - about 9s to fill). At any time they can discharge their
  *entire* current charge (even if not full) into the shared flip countdown,
  either adding that many seconds (stalling the next flip) or subtracting
  them (rushing it, possibly triggering it immediately). A future update may
  refill a player's meter to full on a steal or cuckold - not implemented yet.
- One unified action: type a word and play it. The server auto-detects
  what you meant, in priority order:
  1. **Cuck/Fortify** - extends any word in play (yours or someone else's)
     using extra jungle tiles to spell a longer valid word. Targeting
     someone else's word steals it ("cuckold"); your own just grows it
     ("fortify"). A best-effort filter blocks the "just added a common
     prefix/suffix" case (e.g. `VAGINA` -> `VAGINAL`), matching rule 6.
  2. **Steal** - a pure anagram of a word in someone else's nest.
  3. **Defend** - a pure anagram of your own word. This doesn't change your
     word's displayed spelling or grant it blanket immunity - it just
     permanently burns that one specific anagram. E.g. if you hold `POST`
     and defend with `SPOT`, an opponent can still steal it with `STOP`
     unless that gets burned too.
  4. **Claim** - a brand new word (4+ letters, or the house-rule exception
     `JIT`) straight from the jungle.
- `JIT` can be claimed but never stolen or cuckolded away.
- Every exact spelling, once used for any action by anyone, is retired
  forever - it can never be claimed, stolen, defended, or cuckolded with
  again by any player, regardless of which word or player it was originally
  tied to.
- Playing a word that isn't in the dictionary bans you for that turn plus
  the next two (3 flips total) - you can't claim/steal/cuck/defend while
  banned.
- When the bag empties, a 2-minute "meatwatching" countdown starts; steals,
  cuckolds, and defends are still allowed until it ends. The player with the
  most tiles in their nest wins.
- The final scoreboard also hands out three joke awards (ties share the
  award): **Retard Alert** (banned the most times), **Cuck Chair** (had
  the most tiles stolen from them - cuckolds only count the victim's
  original tiles, not the extra ones the thief added from the jungle), and
  **Deeply Unserious** (ended with the fewest tiles).

## Interface

- The game screen always fits the browser window exactly - no page
  scrolling, on any window size or aspect ratio. The donut is sized in JS
  to fit whatever room is actually available; only the player list and the
  feed scroll internally, and only once they genuinely have more content
  than fits.
- Every player's nest is always visible as tiles in "The Table" panel next
  to the donut - no need to dig through the feed to see who has what.
- Actions animate: tiles physically fly from the jungle/donut into a nest,
  or from one player's nest to another's, with an ease-in/ease-out flight
  instead of just popping into place. Defending pulses the word; getting
  banned shakes your nest card.
- Jungle tiles have simple physics: they're gently pulled toward the center
  and repel each other, so a newly-flipped tile visibly slides in and the
  others shift to make room, instead of the whole layout re-flowing at
  once. The simulation settles and stops once things stop moving, rather
  than jittering constantly.
- Each player's charge bar (shown in "The Table") displays the exact
  seconds available as a live number, and a banned player's nest card shows
  exactly how many more tiles need to flip before they can speak again.
- The Rush/Stall buttons live under "Play Word", large and easy to hit,
  even though the charge bars they draw from stay in "The Table" for
  everyone to see.
- Hold **TAB** to bring up a temporary overlay listing every word used so
  far this game, for quick reference; release to close it.
- **+**/**-** are hotkeys for discharging your charge meter (stall/rush the
  flip timer), same as the on-screen buttons.
- **Enter** plays the word in the input box, same as the "Play Word" button.
- **Spacebar** scatters and re-settles the jungle tiles' positions - for you
  only, purely cosmetic, to help you spot anagrams from a new angle. It
  doesn't touch the actual game state, and never types a space into the
  word box, even while it's focused.
- A red pop-up only appears for claim/steal/cuck/defend results that get
  you banned; everything else (rush/stall, lobby errors) shows up in the
  feed or inline text instead of interrupting you with a pop-up.

The dictionary is the public-domain **ENABLE1** word list (a common stand-in
for the North American Scrabble Dictionary, which is proprietary and can't
be redistributed).

## Running locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open http://localhost:3000 in a browser tab per player (or share your
LAN IP). One player creates a room and shares the 4-character room code;
everyone else joins with it. The host starts the game once at least 2
players are in the room.

`PORT` env var overrides the default port 3000.

## Notes on this build

- This machine didn't have Node.js or Homebrew installed, so a local copy of
  Node was downloaded just to develop and test this project - it isn't part
  of the repo. Install Node.js normally (nodejs.org, nvm, or your package
  manager) to run this on your own machine.
- Game state lives in memory per room and resets if the server restarts.
  Fine for casual play; if you need persistence across restarts, that'd be
  a follow-up (e.g. Redis-backed room state).
- Reconnects (refresh, dropped wifi) are handled via a persistent client ID
  stored in the browser's `localStorage`, so rejoining the same room
  restores your nest instead of creating a duplicate player.

## Deploying

This is a stateful Socket.IO app (in-memory rooms), so it needs a host that
runs a persistent Node process (not a serverless/edge platform). Good fits:

- **Render** (Web Service): build command `npm install`, start command
  `npm start`. Works out of the box.
- **Fly.io**: `fly launch`, it'll detect the Node app; make sure the app
  listens on `process.env.PORT` (it already does).
- **Railway**: connect the repo, it auto-detects `npm start`.

If you run multiple server instances/replicas behind a load balancer, you'll
need sticky sessions (Socket.IO connections aren't shareable across
instances without a shared adapter like `socket.io-redis`) - for a casual
game among friends, a single instance is simplest and sufficient.
