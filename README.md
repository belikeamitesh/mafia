# 🔪 Mafia Night

Play Mafia online with friends. One person creates a room and shares the link, everyone joins with just a name, and the game deals secret roles, runs the night and day phases, and counts the votes. No accounts, no downloads, works on phones.

## How to play

1. **Create a room.** Open the site, type your name, click **Create a room**. You are the host 👑.
2. **Invite friends.** Click **🔗 Invite** and send the link. Friends open it, type a name, and they're in.
3. **Start.** When everyone has joined, the host presses **🎲 Start game**. The room then locks: nobody new can join until the game ends.
4. **Night 🌙.** Town chat closes. Mafia pick a victim, the Doctor protects someone, Police investigate someone.
5. **Day ☀️.** Everyone learns who died and whether they were Mafia. Discuss in the chat and vote (the host sets 1–10 minutes). Most votes is out.
6. Repeat until one side wins. The host can press **⏹ Stop** at any time to end the game.

Tap the **ⓘ** next to any role in the game to see what it does.

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
- **Out players** can't vote or talk in Town chat. They talk to each other in the 👻 Graveyard chat.
- **Winning:** the Town wins when every Mafia is out. The Mafia win when they equal or outnumber everyone else.
- **Leaving** mid-game counts as being out.
- **One player per browser:** refreshing or opening a second tab keeps you as the same player, so you can rejoin after a dropped connection. A different browser or a private window counts as a new player.

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

This runs 49 checks covering roles, secrecy, night actions, every vote outcome, win conditions, chat rules, leaving and the host controls. To test with real connections, start the server on port 3999 (`PORT=3999 npm start`) and run `npm run e2e` in a second terminal.

## Free hosting on Render

1. On https://render.com, click **New → Web Service** (not Static Site: the game needs a running server).
2. Pick this repository and set **Language** Node, **Build Command** `npm install`, **Start Command** `npm start`, **Instance Type** Free.
3. Click **Deploy**, then share the `https://<name>.onrender.com` link.

The free plan sleeps after 15 minutes with no visitors; the first visit after that takes about 50 seconds to load. Rooms are kept in memory, so a redeploy or restart ends any game in progress.

## Project layout

| File | What it does |
|---|---|
| `game.js` | All game rules: roles, phases, votes, chat permissions |
| `server.js` | Web server and live connections (Socket.IO) |
| `public/index.html` | The whole user interface |
| `test.js`, `e2e.js` | Rule checks and the real-connection test |
| `render.yaml` | Render settings |
