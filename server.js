const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { FLOORS, STAT_DEFS, STAT_POINTS_TOTAL, DEFAULT_HEALTH, SPAWN_ROOM_IDS, STOPPABLE_ROOM_IDS, DEFAULT_POISON_DAMAGE_TABLE } = require("./public/map-data.js");
const { ROLE_ID_SET } = require("./public/roles-data.js");

const STATE_FILE = path.join(__dirname, "game-state.json");
const FLOOR_IDS = new Set(FLOORS.map((f) => f.id));
// Bridge/Tunnel are excluded — meeples may only stop in an actual room.
const ROOM_IDS = new Set(STOPPABLE_ROOM_IDS);
const SPAWN_ROOM_ID_SET = new Set(SPAWN_ROOM_IDS);
const STAT_IDS = STAT_DEFS.map((s) => s.id);
const PORT = process.env.PORT || 8000;
const ADMIN_PASSWORD = "0000";

// phase: "setup" -> "prep" -> "in_progress" -> "ended" -> ("setup" via restart)
function defaultState() {
  return {
    phase: "setup",
    playerCount: 0,
    players: [],
    round: 0,
    poisonFloors: [],
    poisonDamageTable: DEFAULT_POISON_DAMAGE_TABLE.map((r) => ({ ...r })),
    // Optional per-game role assignment — off by default. `selectedRoles` is
    // the fixed pool (one entry per player, chosen before createGame);
    // `rolesVisibleToPlayers` controls only whether index.html shows a
    // player their own role — public/admin views always show assignments.
    rolesEnabled: false,
    selectedRoles: [],
    rolesVisibleToPlayers: true,
  };
}

// Only known role ids survive, de-duplicated, in the given order.
function clampSelectedRoles(roleIds) {
  if (!Array.isArray(roleIds)) return [];
  const clean = [];
  const seen = new Set();
  for (const id of roleIds) {
    if (typeof id === "string" && ROLE_ID_SET.has(id) && !seen.has(id)) {
      seen.add(id);
      clean.push(id);
    }
  }
  return clean;
}

function clampPoisonDamageTable(table) {
  if (!Array.isArray(table)) return null;
  const clean = table
    .map((row) => ({
      round: Math.max(1, Math.round(Number(row && row.round) || 0)),
      damage: Math.max(0, Math.round(Number(row && row.damage) || 0)),
    }))
    .filter((row) => row.round > 0)
    .sort((a, b) => a.round - b.round);
  return clean.length ? clean : null;
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

let state = loadState();
let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {});
  }, 150);
}

// Player-driven edits share a fixed 10-point pool across power/speed/weight.
function clampPlayerStats(stats) {
  const clean = {};
  let sum = 0;
  for (const id of STAT_IDS) {
    let v = Number(stats && stats[id]);
    if (!Number.isFinite(v)) v = 0;
    v = Math.max(0, Math.min(STAT_POINTS_TOTAL, Math.round(v)));
    clean[id] = v;
    sum += v;
  }
  if (sum > STAT_POINTS_TOTAL) {
    let over = sum - STAT_POINTS_TOTAL;
    for (const id of STAT_IDS) {
      if (over <= 0) break;
      const cut = Math.min(clean[id], over);
      clean[id] -= cut;
      over -= cut;
    }
  }
  return clean;
}

// Admin overwrites are exempt from the 10-point pool, only clamped to non-negative integers.
function clampAdminStats(stats) {
  const clean = {};
  for (const id of STAT_IDS) {
    let v = Number(stats && stats[id]);
    if (!Number.isFinite(v)) v = 0;
    clean[id] = Math.max(0, Math.round(v));
  }
  return clean;
}

function clampNonNegativeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

// Health may go negative: <=0 means the player is a "shadow" (暗影), and the
// negative value doubles as remaining absorption debt (-2 = needs 2 more).
function clampHealth(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Lightweight target for external uptime pings (e.g. cron-job.org) — avoids
// the static-file/game-state overhead of hitting "/" just to keep the
// Render free-tier instance from spinning down on inactivity.
app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

// Extension-less aliases so links can read "/admin" / "/public" instead of
// "/admin.html" / "/public.html". The .html paths still work via the static
// middleware below — these are just friendlier URLs on top of it.
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get("/public", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "public.html"));
});

app.post("/api/admin-login", (req, res) => {
  if (req.body && req.body.password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast() {
  const payload = JSON.stringify({ type: "state", state });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "state", state }));

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    const isAdminAction = typeof msg.type === "string" && msg.type.startsWith("admin:");
    if (isAdminAction && msg.password !== ADMIN_PASSWORD) return;

    switch (msg.type) {
      case "admin:createGame": {
        if (state.phase !== "setup") return;
        const n = Math.max(1, Math.min(200, Math.round(Number(msg.playerCount) || 0)));
        if (!n) return;
        // Role pool (if enabled) is chosen up front and must exactly cover
        // every player — otherwise assignment later couldn't be 1:1.
        if (state.rolesEnabled && state.selectedRoles.length !== n) return;
        state = {
          phase: "prep",
          playerCount: n,
          players: Array.from({ length: n }, (_, i) => ({
            id: i + 1,
            stats: { power: 0, speed: 0, weight: 0 },
            health: DEFAULT_HEALTH,
            room: null,
            roleId: null,
          })),
          round: 0,
          poisonFloors: [],
          poisonDamageTable: state.poisonDamageTable,
          rolesEnabled: state.rolesEnabled,
          selectedRoles: state.selectedRoles,
          rolesVisibleToPlayers: state.rolesVisibleToPlayers,
        };
        break;
      }
      case "admin:setRoleConfig": {
        if (state.phase !== "setup") return;
        state.rolesEnabled = !!msg.enabled;
        state.selectedRoles = clampSelectedRoles(msg.roleIds);
        break;
      }
      case "admin:assignPlayerRole": {
        if (state.phase !== "prep" && state.phase !== "in_progress") return;
        if (!state.rolesEnabled) return;
        const playerId = Math.round(Number(msg.playerId));
        const player = state.players.find((p) => p.id === playerId);
        if (!player) return;
        const roleId = msg.roleId === null || msg.roleId === undefined ? null : String(msg.roleId);
        if (roleId !== null && !state.selectedRoles.includes(roleId)) return;
        // Each role in the pool belongs to at most one player — reassigning
        // it elsewhere vacates it from whoever held it before.
        if (roleId !== null) {
          for (const p of state.players) {
            if (p.id !== player.id && p.roleId === roleId) p.roleId = null;
          }
        }
        player.roleId = roleId;
        break;
      }
      case "admin:setRolesVisibleToPlayers": {
        if (state.phase !== "prep" && state.phase !== "in_progress") return;
        state.rolesVisibleToPlayers = !!msg.visible;
        break;
      }
      case "admin:setPoisonDamageTable": {
        if (state.phase !== "setup") return;
        const clean = clampPoisonDamageTable(msg.table);
        if (!clean) return;
        state.poisonDamageTable = clean;
        break;
      }
      case "admin:startGame": {
        if (state.phase !== "prep") return;
        state.phase = "in_progress";
        state.round = 1;
        break;
      }
      case "admin:endGame": {
        if (state.phase !== "in_progress") return;
        state.phase = "ended";
        break;
      }
      case "admin:restartGame": {
        state = defaultState();
        break;
      }
      // Single atomic commit for everything the admin edits together (per-player
      // stats/health, round, poison floors) so all of it reflects to other
      // clients in one go rather than field-by-field.
      case "admin:commitEdits": {
        if (state.phase !== "prep" && state.phase !== "in_progress") return;
        if (Array.isArray(msg.players)) {
          for (const pu of msg.players) {
            const player = state.players.find((p) => p.id === Number(pu.id));
            if (!player) continue;
            player.stats = clampAdminStats(pu.stats);
            player.health = clampHealth(pu.health);
          }
        }
        if (state.phase === "in_progress") {
          if (msg.round !== undefined) state.round = clampNonNegativeInt(msg.round);
          if (Array.isArray(msg.poisonFloors)) {
            state.poisonFloors = msg.poisonFloors.filter((f) => FLOOR_IDS.has(f));
          }
        }
        break;
      }
      // Drag-and-drop token placement is a direct-manipulation gesture, so it
      // applies immediately rather than going through the batched edit/confirm.
      case "admin:setPlayerRoom": {
        if (state.phase !== "in_progress") return;
        const playerId = Math.round(Number(msg.playerId));
        const player = state.players.find((p) => p.id === playerId);
        if (!player) return;
        if (msg.room === null) {
          player.room = null;
        } else {
          if (!ROOM_IDS.has(msg.room)) return;
          player.room = msg.room;
        }
        break;
      }
      case "user:setSpawn": {
        if (state.phase !== "prep") return;
        if (!SPAWN_ROOM_ID_SET.has(msg.room)) return;
        const playerId = Math.round(Number(msg.playerId));
        const player = state.players.find((p) => p.id === playerId);
        if (!player) return;
        player.room = msg.room;
        break;
      }
      case "user:setStats": {
        if (state.phase !== "prep") return;
        const playerId = Math.round(Number(msg.playerId));
        const player = state.players.find((p) => p.id === playerId);
        if (!player) return;
        player.stats = clampPlayerStats(msg.stats);
        break;
      }
      default:
        return;
    }

    saveState();
    broadcast();
  });
});

server.listen(PORT, () => {
  console.log(`禁闭逃杀 game server listening on http://localhost:${PORT}`);
});
