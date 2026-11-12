# 🔪 Mafia Night

Play Mafia online with friends. One person creates a room and shares the link, everyone joins with just a name, and the game deals secret roles, runs the night and day phases, and counts the votes. No accounts, no downloads, works on phones.

## How to play

1. **Create a room.** Open the site, type your name, click **Create a room**. You are the host 👑.
2. **Invite friends.** Click **🔗 Invite** and send the link. Friends open it, type a name, and they're in.
3. **Start.** When everyone has joined, the host presses **🎲 Start game**. The room then locks: nobody new can join until the game ends.
4. **Night 🌙.** Town chat closes. Mafia pick a victim, the Doctor protects someone, Police investigate someone.
5. **Day ☀️.** Everyone learns who died and whether they were Mafia. Discuss in the chat and vote (the host sets 1–10 minutes). Most votes is out.
6. Repeat until one side wins. The host can press **⏹ Stop** at any time: the game ends, the chat is deleted, and the room closes for everyone (the code stops working). To play again, create a new room.

Tap the **ⓘ** next to any role in the game to see what it does.

**Never miss your turn.** A 👇 hint, glowing player cards and a "Tap here" banner show exactly what to do when it is your move. A sound and vibration play when night falls, when it's your turn to act, when voting starts and 30 seconds before it closes, and the tab title blinks if you're in another tab. Tap 🔔 to mute.

**End-of-game recap.** When the game ends, everyone sees a night-by-night timeline: who the Mafia targeted, who the Doctor protected, who the Police checked, and how everyone voted each day.

## Roles

| Players | Mafia 🔪 | Police 🕵️ | Doctor 🩺 | Villagers 🧑‍🌾 |
|---|---|---|---|---|
| 4 | 1 | – | – | 3 |
| 5 | 1 | 1 | – | 3 |
| 6–7 | 1 | 1 | 1 | rest |
| 8–9 | 2 | 1 | 1 | rest |
| 10–13 | 2–3 | 2 | 1 | rest |
| 14+ | 1 per 4 players | 2 | 2 | rest |

- **Villager:** no night power. Find the Mafia by talking and voting.
- **Mafia:** each night, choose someone to kill together. Most Mafia votes wins; a tie is broken at random. Blend in during the day.
- **Police:** each night, check one player and privately learn if they are Mafia. With 2 Police, each checks a different person and both see both results.
- **Doctor:** each night, protect one player from the Mafia. You can protect yourself, but not the same person two nights in a row.

## Rules

- **Secrecy:** you only know your own role. Mafia know each other. When there are 2 Police (or 2 Doctors), those two know each other.
- **Private chats:** Mafia always have one. Police and Doctors get one only when there are 2 of them.
- **Reveals:** when someone dies or is voted out, everyone learns only whether they were **Mafia or not**, never their exact role. All roles are shown when the game ends.
- **Voting:** votes are public and can be changed until time runs out. A tie, or more "skip" votes than the top player got, means nobody is out. If everyone has voted, the vote closes after 15 more seconds.
- **Chat like WhatsApp:** type `@` to pick someone to mention, or tap a name in the chat. Tap a message (or hover on desktop) for reactions and **↩️ Reply**, which quotes it; tapping a quote jumps to the original. You get a notice when someone mentions you or replies to you. **😊** opens an emoji picker.
- **Voice notes:** tap 🎤 to record (up to 30 seconds), tap ⏹ to send, ✕ to discard. They follow the same rules as text: team notes stay in the team chat, nobody can post in Town at night, and out players only post in the Graveyard. The browser asks once for microphone access.
- **Out players** can't vote or talk in Town chat. They talk to each other in the 👻 Graveyard chat.
- **Winning:** the Town wins when every Mafia is out. The Mafia win when they equal or outnumber everyone else.
- **Leaving** mid-game counts as being out.
- **Refreshing is safe:** refreshing, closing the tab or losing connection keeps you in your room. Open the site again and you're back where you were, with the same room code.
- **One game at a time:** you can't create or join another room while you're in one. Press 🚪 Leave first.
- **Rejoining after leaving:** after pressing 🚪 Leave, a **↩️ Rejoin room** button appears. In the lobby you simply join again. Mid-game you come back as an out player who can watch and use the Graveyard chat, because leaving counted as being out.
- **One player per browser:** a second tab is the same player. A different browser or a private window counts as a new player.

<img width="1344" height="1190" alt="image" src="https://github.com/user-attachments/assets/d858b614-ea9f-42ce-87ca-9da802735c2a" />

<img width="2994" height="1634" alt="image" src="https://github.com/user-attachments/assets/ea6b85c6-ec27-44ed-a81d-180aa4cda9a1" />

<img width="2146" height="1542" alt="image" src="https://github.com/user-attachments/assets/cc75e4b7-0573-404b-bde9-6936b7534d34" />



## Run it on your computer

Needs [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000.

## Tests

```bash
npm test
```

This runs 60 checks covering roles, secrecy, night actions, every vote outcome, win conditions, chat rules, replies, voice notes, the end-of-game recap, leaving and the host controls. To test with real connections, start the server on port 3999 (`PORT=3999 npm start`) and run `npm run e2e` in a second terminal. It checks the served files, the one-room-per-browser rule, secret chats over real connections, voice notes, Stop and the request limits.

Both run automatically on GitHub after every upload (`.github/workflows/test.yml`); see the ✅ or ❌ next to each commit. In Render, set **Settings → Auto-Deploy** to **After CI checks pass** so a broken upload never goes live.

## Free hosting on Render

1. On https://render.com, click **New → Web Service** (not Static Site: the game needs a running server).
2. Pick this repository and set **Language** Node, **Build Command** `npm install`, **Start Command** `npm start`, **Instance Type** Free.
3. Click **Deploy**, then share the `https://<name>.onrender.com` link.

The free plan sleeps after 15 minutes with no visitors; the first visit after that takes about 50 seconds to load. Rooms are kept in memory, so a redeploy or restart ends any game in progress.

## How it works

```
 browser (public/)                      server (Node.js)
┌──────────────────────┐  Socket.IO   ┌───────────────────────────────┐
│ index.html  layout   │ ───────────▶ │ server.js                     │
│ style.css   look     │   actions    │  · serves the 3 page files    │
│ app.js      renders  │              │  · one socket = one player    │
│   state, sends taps  │ ◀─────────── │  · request limits, JSON logs  │
└──────────────────────┘ state, chat, │            │                  │
                         announcements│            ▼                  │
                                      │ game.js  (Room)               │
                                      │  · all rules, timers, votes   │
                                      │  · decides who may see what   │
                                      └───────────────────────────────┘
```

- **The server is the only source of truth.** `game.js` holds the full game; each player is sent a personal `view` with only what they are allowed to know (your role, your teammates, dead players as Mafia / not Mafia). Secret roles never reach other browsers, so they can't be found with developer tools.
- **Identity without accounts.** Each browser keeps a random secret token. The server maps token → player, so a refresh or second tab is the same player, and players are only ever shown each other's public ids.
- **Everything is in memory.** Rooms, chat and voice notes live in the server process and disappear when a room closes or the server restarts. Rooms nobody has been connected to for 30 minutes are cleaned up automatically.
- **Limits:** 20 new rooms per network per 10 minutes, 20 join attempts per minute and 40 actions per 10 seconds per connection, 30-second voice notes (only the newest 40 per room keep their audio).
- **Logs:** one JSON line per event (`room_created`, `game_start`, `game_over`, `room_closed`, `error`…) in Render's **Logs** tab. No names, messages or IP addresses are logged.

### Do we need a database?

Not for this game. A match lasts minutes, nothing needs to be kept afterwards, and there are no accounts. A database would only help a game survive a server restart or redeploy, and Render's free plan has no persistent database to put it in. If that ever matters, store each `Room` in Redis and load it on startup; nothing else in the code needs to change.

## Project layout

| File | What it does |
|---|---|
| `game.js` | All game rules: roles, phases, votes, recap, chat permissions |
| `server.js` | Web server, live connections (Socket.IO), limits and logging |
| `public/index.html` | Page layout |
| `public/style.css` | Look and feel |
| `public/app.js` | Everything the browser does: rendering, chat, voice notes, alerts |
| `test.js` | Rule checks (`npm test`) |
| `e2e.js` | Real-connection test (`npm run e2e`) |
| `.github/workflows/test.yml` | Runs both tests on GitHub after every upload |
| `render.yaml` | Render settings |
