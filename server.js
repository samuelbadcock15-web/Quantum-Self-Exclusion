const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const INTERMISSION_SECONDS = 15;
const TICK_MS = 1000;

const MAPS = [
  { id: "quantum_high_street", name: "Quantum High Street" },
  { id: "neon_wasteland_strip", name: "Neon Wasteland Strip" },
  { id: "penumbra_vault_yard", name: "Penumbra Vault Yard" }
];

const DURATION_OPTIONS_SEC = [180, 300, 600]; // 3m, 5m, 10m

function createLobby(id, mode, defaultDurationSec = 300) {
  return {
    id,
    mode, // "ffa" | "tdm"
    phase: "in_match", // "in_match" | "voting"
    mapId: MAPS[0].id,
    durationSec: defaultDurationSec,
    timeRemaining: defaultDurationSec,
    teams: {
      ALPHA: 0,
      BRAVO: 0
    },
    players: new Map(), // socket -> playerState
    votes: {
      map: new Map(), // playerId -> mapId
      duration: new Map() // playerId -> durationSec
    }
  };
}

const lobbies = {
  ffa: createLobby("ffa", "ffa", 300),
  tdm: createLobby("tdm", "tdm", 300)
};

function assignTdmTeam(lobby) {
  let alphaCount = 0;
  let bravoCount = 0;
  for (const p of lobby.players.values()) {
    if (p.team === "ALPHA") alphaCount++;
    else if (p.team === "BRAVO") bravoCount++;
  }
  return alphaCount <= bravoCount ? "ALPHA" : "BRAVO";
}

function sendJson(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastLobby(lobby, payload) {
  const raw = JSON.stringify(payload);
  for (const ws of lobby.players.keys()) {
    if (ws.readyState === 1) {
      ws.send(raw);
    }
  }
}

function getVoteTallies(lobby) {
  const mapCounts = {};
  for (const m of MAPS) mapCounts[m.id] = 0;
  for (const mapId of lobby.votes.map.values()) {
    if (mapCounts[mapId] !== undefined) mapCounts[mapId]++;
  }

  const durationCounts = {};
  for (const d of DURATION_OPTIONS_SEC) durationCounts[d] = 0;
  for (const dur of lobby.votes.duration.values()) {
    if (durationCounts[dur] !== undefined) durationCounts[dur]++;
  }

  return { mapCounts, durationCounts };
}

function pickWinningKey(countsMap, fallback) {
  let bestKey = fallback;
  let bestVotes = -1;
  for (const [key, count] of Object.entries(countsMap)) {
    if (count > bestVotes) {
      bestVotes = count;
      bestKey = key;
    }
  }
  return bestKey;
}

function getLobbySnapshot(lobby) {
  const players = [];
  for (const p of lobby.players.values()) {
    players.push({
      id: p.id,
      name: p.name,
      team: p.team,
      mode: p.mode,
      score: p.score,
      kills: p.kills,
      deaths: p.deaths,
      pos: p.pos,
      rotY: p.rotY
    });
  }

  players.sort((a, b) => b.score - a.score);

  return {
    lobbyId: lobby.id,
    mode: lobby.mode,
    phase: lobby.phase,
    mapId: lobby.mapId,
    maps: MAPS,
    durationSec: lobby.durationSec,
    durationOptionsSec: DURATION_OPTIONS_SEC,
    timeRemaining: lobby.timeRemaining,
    teams: lobby.teams,
    players,
    tallies: getVoteTallies(lobby)
  };
}

function startIntermissionVote(lobby) {
  lobby.phase = "voting";
  lobby.timeRemaining = INTERMISSION_SECONDS;
  lobby.votes.map.clear();
  lobby.votes.duration.clear();

  broadcastLobby(lobby, {
    type: "lobby_phase_changed",
    lobby: getLobbySnapshot(lobby)
  });
}

function startNextRound(lobby) {
  const { mapCounts, durationCounts } = getVoteTallies(lobby);
  lobby.mapId = pickWinningKey(mapCounts, lobby.mapId);
  lobby.durationSec = Number(pickWinningKey(durationCounts, lobby.durationSec)) || 300;
  lobby.phase = "in_match";
  lobby.timeRemaining = lobby.durationSec;
  lobby.teams.ALPHA = 0;
  lobby.teams.BRAVO = 0;

  for (const p of lobby.players.values()) {
    p.score = 0;
    p.kills = 0;
    p.deaths = 0;
  }

  broadcastLobby(lobby, {
    type: "round_started",
    lobby: getLobbySnapshot(lobby)
  });
}

function removePlayerFromCurrentLobby(ws) {
  for (const lobby of Object.values(lobbies)) {
    if (lobby.players.has(ws)) {
      const leaving = lobby.players.get(ws);
      lobby.players.delete(ws);
      lobby.votes.map.delete(leaving.id);
      lobby.votes.duration.delete(leaving.id);

      broadcastLobby(lobby, {
        type: "player_left",
        playerId: leaving.id,
        lobby: getLobbySnapshot(lobby)
      });
    }
  }
}

function joinLobby(ws, lobbyId, playerName) {
  const targetLobby = lobbies[lobbyId === "tdm" ? "tdm" : "ffa"];
  removePlayerFromCurrentLobby(ws);

  const playerId = "plr_" + Math.random().toString(36).slice(2, 9);
  const cleanName =
    typeof playerName === "string" && playerName.trim()
      ? playerName.trim().slice(0, 20)
      : `Operative_${playerId.slice(-4)}`;

  const playerState = {
    id: playerId,
    name: cleanName,
    team: targetLobby.mode === "tdm" ? assignTdmTeam(targetLobby) : null,
    mode: "vehicle",
    score: 0,
    kills: 0,
    deaths: 0,
    pos: { x: 0, y: 0, z: -145 },
    rotY: 0
  };

  targetLobby.players.set(ws, playerState);
  ws.playerId = playerId;
  ws.lobbyId = targetLobby.id;

  sendJson(ws, {
    type: "joined_lobby",
    playerId,
    lobby: getLobbySnapshot(targetLobby)
  });

  broadcastLobby(targetLobby, {
    type: "player_joined",
    player: {
      id: playerState.id,
      name: playerState.name,
      team: playerState.team,
      mode: playerState.mode,
      score: playerState.score,
      kills: playerState.kills,
      deaths: playerState.deaths,
      pos: playerState.pos,
      rotY: playerState.rotY
    },
    lobby: getLobbySnapshot(targetLobby)
  });
}

// Serve static files (index.html) when hosted on a Node Web Service
const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, lobbies: ["ffa", "tdm"] }));
    return;
  }

  const candidatePaths = [
    path.join(__dirname, urlPath === "/" ? "index.html" : urlPath),
    path.join(__dirname, "public", urlPath === "/" ? "index.html" : urlPath),
    path.join(__dirname, "index.html")
  ];

  const filePath = candidatePaths.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };

  res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // Default players into Free-For-All lobby on connect; they can switch to TDM anytime
  joinLobby(ws, "ffa");

  ws.on("message", (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      return;
    }

    const lobby = lobbies[ws.lobbyId] || lobbies.ffa;
    const player = lobby.players.get(ws);
    if (!player) return;

    switch (msg.type) {
      case "switch_lobby": {
        const nextLobbyId = msg.lobbyId === "tdm" ? "tdm" : "ffa";
        joinLobby(ws, nextLobbyId, msg.name || player.name);
        break;
      }

      case "set_name": {
        if (typeof msg.name === "string" && msg.name.trim()) {
          player.name = msg.name.trim().slice(0, 20);
          broadcastLobby(lobby, {
            type: "roster_update",
            lobby: getLobbySnapshot(lobby)
          });
        }
        break;
      }

      case "state_update": {
        if (lobby.phase !== "in_match") return;
        if (msg.pos && typeof msg.pos.x === "number" && typeof msg.pos.y === "number" && typeof msg.pos.z === "number") {
          player.pos = { x: msg.pos.x, y: msg.pos.y, z: msg.pos.z };
        }
        if (typeof msg.rotY === "number") {
          player.rotY = msg.rotY;
        }
        if (typeof msg.mode === "string") {
          player.mode = msg.mode;
        }
        broadcastLobby(lobby, {
          type: "peer_state",
          playerId: player.id,
          pos: player.pos,
          rotY: player.rotY,
          mode: player.mode
        });
        break;
      }

      case "fire_event": {
        if (lobby.phase !== "in_match") return;
        broadcastLobby(lobby, {
          type: "peer_fire",
          playerId: player.id,
          origin: msg.origin,
          aim: msg.aim,
          isRocket: Boolean(msg.isRocket)
        });
        break;
      }

      case "report_kill": {
        if (lobby.phase !== "in_match") return;
        player.kills += 1;
        player.score += 100;
        if (lobby.mode === "tdm" && player.team && lobby.teams[player.team] !== undefined) {
          lobby.teams[player.team] += 100;
        }
        if (msg.victimId) {
          for (const other of lobby.players.values()) {
            if (other.id === msg.victimId) {
              other.deaths += 1;
              break;
            }
          }
        }
        broadcastLobby(lobby, {
          type: "kill_feed",
          killerId: player.id,
          killerName: player.name,
          victimName: msg.victimName || "Target",
          team: player.team,
          lobby: getLobbySnapshot(lobby)
        });
        break;
      }

      case "cast_vote": {
        if (lobby.phase !== "voting") return;
        if (msg.mapId && MAPS.some((m) => m.id === msg.mapId)) {
          lobby.votes.map.set(player.id, msg.mapId);
        }
        if (msg.durationSec && DURATION_OPTIONS_SEC.includes(Number(msg.durationSec))) {
          lobby.votes.duration.set(player.id, Number(msg.durationSec));
        }
        broadcastLobby(lobby, {
          type: "vote_updated",
          lobby: getLobbySnapshot(lobby)
        });
        break;
      }

      case "ping": {
        sendJson(ws, { type: "pong", t: Date.now() });
        break;
      }
    }
  });

  ws.on("close", () => {
    removePlayerFromCurrentLobby(ws);
  });
});

// Authoritative 1-second match & intermission timer for both lobbies
setInterval(() => {
  for (const lobby of Object.values(lobbies)) {
    if (lobby.players.size === 0) {
      lobby.timeRemaining = lobby.durationSec;
      lobby.phase = "in_match";
      continue;
    }

    lobby.timeRemaining -= 1;

    if (lobby.timeRemaining <= 0) {
      if (lobby.phase === "in_match") {
        startIntermissionVote(lobby);
      } else {
        startNextRound(lobby);
      }
    } else {
      broadcastLobby(lobby, {
        type: "timer_tick",
        lobbyId: lobby.id,
        phase: lobby.phase,
        timeRemaining: lobby.timeRemaining,
        teams: lobby.teams
      });
    }
  }
}, TICK_MS);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Call Of Self-Exclusion server running on port ${PORT}`);
});
