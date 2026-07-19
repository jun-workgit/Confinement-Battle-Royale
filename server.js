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
// The game never runs past round 6 — settlement's finish action ends the
// game instead of advancing past this.
const MAX_ROUND = 6;
// Google Apps Script web app (bound to the stats-tracking spreadsheet's
// "API" sheet tab) that the admin import button pulls player data from.
const SHEET_API_URL = "https://script.google.com/macros/s/AKfycbwLvdoyuvtGCudYriJxVVqOzkeVgYvwjfvS57_Q53OLGeRT_C_R-6vxi4JNkTnpFftv/exec";

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
    // The Hacker role's "秘密关闭1个房间功能" pick for the current round —
    // { round, room } or null. Only meaningful when .round === state.round;
    // a mark from an earlier round is stale and no longer blocks a new pick.
    // Visible only to the Hacker player themselves and to admin (never to
    // other players or the public view) — see index.html/admin.html.
    hackerRoomMark: null,
    // Admin-tracked inputs for the current round, both purely informational
    // (never touch player.room) and reset whenever the round changes (see
    // admin:commitEdits): { [playerId]: floorId } poison-vote indicator, and
    // this round's Rocket Launcher blast target (or null).
    floorVotes: {},
    rocketTargetRoom: null,
    // Settlement-phase draft — null outside of settlement. See
    // startSettlementDraft() for the shape. `working` holds player
    // health/stats as sections get committed; this is broadcast to every
    // client like the rest of state, but only admin.html ever reads it —
    // the real public state.players is untouched until finishSettlement.
    settlementDraft: null,
    // Admin-controlled countdown shown on every view. `endsAt` is an absolute
    // ms-epoch timestamp so all clients (and a restarted server) agree on the
    // remaining time; `remainingSec` is only authoritative while not running.
    timer: defaultTimer(),
  };
}

function defaultTimer() {
  return { durationSec: 0, remainingSec: 0, running: false, endsAt: null };
}

const TIMER_MAX_SEC = 99 * 60 + 59;

// While the countdown runs, clients tick locally off endsAt; the server only
// needs to wake once at expiry to flip the state back to stopped so late
// joiners don't see a stale "running" timer.
let timerExpiryTimeout = null;
function armTimerExpiry() {
  clearTimeout(timerExpiryTimeout);
  if (!state.timer || !state.timer.running || !state.timer.endsAt) return;
  const delay = state.timer.endsAt - Date.now();
  if (delay <= 0) {
    state.timer = { ...state.timer, running: false, remainingSec: 0, endsAt: null };
    return;
  }
  timerExpiryTimeout = setTimeout(() => {
    if (state.timer && state.timer.running) {
      state.timer = { ...state.timer, running: false, remainingSec: 0, endsAt: null };
      broadcast();
      saveState();
    }
  }, delay + 50);
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
// A timer that was running when the server went down keeps its absolute
// endsAt, so it either resumes cleanly or gets finalized as expired here.
armTimerExpiry();
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

// ---------------------------------------------------------------------
// Settlement (结算阶段) — reconciles one round's health/stat changes across
// 7 sections before revealing anything publicly. `settlementDraft.working`
// holds the in-progress numbers; the real state.players is untouched until
// admin:finishSettlement copies working over. Every section commit mutates
// `working` and records exactly what it changed so admin:settlementUndoSection
// can reverse it precisely, regardless of what other sections have done
// since. Room-id -> floor-id: "2xx"/"Bxdd" style ids encode their floor in
// the leading digit(s).
function roomFloor(roomId) {
  if (!roomId) return null;
  if (roomId[0] === "B") {
    const m = roomId.match(/^B(\d)/);
    return m ? "B" + m[1] : null;
  }
  if (roomId === "201" || roomId === "202") return "2";
  return "1"; // 101, 102, 103, 104
}

function draftPlayerSnapshot(players) {
  return players.map((p) => ({
    id: p.id,
    health: p.health,
    stats: { ...p.stats },
    room: p.room,
    roleId: p.roleId,
  }));
}

// Rooms with 2 living players (single fight), 3+ (brawl), or a shadow
// sharing a room with any living player (shadow-meet) — a room can produce
// both a fight event AND a shadow-meet event at once. B202 (手术室) is a
// special case: exactly 2 living players there means surgery instead of a
// fight (handled by the "surgery" section), so it's excluded here — but 3+
// still triggers a brawl same as any other room, per B202's own rules.
function computeRoomEvents(working) {
  const byRoom = {};
  for (const p of working) {
    if (!p.room) continue;
    (byRoom[p.room] = byRoom[p.room] || []).push(p);
  }
  const events = [];
  for (const room of Object.keys(byRoom)) {
    const group = byRoom[room];
    const living = group.filter((p) => p.health > 0);
    const shadows = group.filter((p) => p.health <= 0);
    if (shadows.length && living.length) {
      events.push({ room, kind: "shadow", playerIds: group.map((p) => p.id) });
    }
    if (living.length === 2 && room !== "B202") {
      events.push({ room, kind: "single", playerIds: living.map((p) => p.id) });
    } else if (living.length > 2) {
      events.push({ room, kind: "multi", playerIds: living.map((p) => p.id) });
    }
  }
  return events;
}

function poisonDamageForRound(table, round) {
  const row = (table && table.length ? table : DEFAULT_POISON_DAMAGE_TABLE).find((r) => r.round === round);
  return row ? row.damage : 0;
}

// Auto-computed default data for each section, derived from `working` (the
// draft's current health/stats) plus whatever admin has tracked this round
// (floor votes, rocket target). Admin can override individual fields
// afterward via admin:settlementSetSectionData before committing.
function computeSectionDefault(section, working, state) {
  switch (section) {
    case "surgery": {
      const occupants = working.filter((p) => p.room === "B202" && p.health > 0);
      const outcome = occupants.length === 2 ? "success" : occupants.length >= 3 ? "fail" : "none";
      return { outcome, playerIds: occupants.map((p) => p.id) };
    }
    case "combat": {
      return { events: computeRoomEvents(working) };
    }
    case "poison": {
      const tally = {};
      for (const [playerId, floor] of Object.entries(state.floorVotes || {})) {
        const voter = working.find((p) => p.id === Number(playerId));
        if (!voter || voter.health <= 0) continue; // shadows don't vote
        tally[floor] = (tally[floor] || 0) + 1;
      }
      const counts = Object.values(tally);
      const max = counts.length ? Math.max(...counts) : 0;
      const floors = max > 0 ? Object.keys(tally).filter((f) => tally[f] === max) : [];
      return { floors, tally };
    }
    case "hunger": {
      const toggles = {};
      for (const p of working) {
        if (p.health <= 0) continue; // shadows don't hand in water/food
        const exempt = p.room === "B204";
        toggles[p.id] = { water: true, food: true, exempt };
      }
      return { toggles };
    }
    case "rocket": {
      const room = state.rocketTargetRoom || null;
      const playerIds = room ? working.filter((p) => p.room === room).map((p) => p.id) : [];
      return { room, playerIds };
    }
    case "items": {
      const toggles = {};
      for (const p of working) {
        if (p.health <= 0) continue;
        toggles[p.id] = { pill: false, wine: false, wineResult: null, adrenaline: false };
      }
      return { toggles };
    }
    case "revival": {
      const events = computeRoomEvents(working).filter((e) => e.kind === "shadow");
      const preview = {};
      for (const e of events) {
        const livingCount = working.filter((p) => e.playerIds.includes(p.id) && p.health > 0).length;
        for (const p of working) {
          if (!e.playerIds.includes(p.id) || p.health > 0) continue;
          preview[p.id] = (preview[p.id] || 0) + livingCount;
        }
      }
      return { absorbedThisRound: preview };
    }
    default:
      return {};
  }
}

// Applies a section's committed effect to `working` (mutating health/stats
// in place) and returns everything needed to undo it later: per-player
// health/stat deltas, plus any "extra" state this section touched outside
// player data (only poison touches state.poisonFloors).
function commitSectionEffect(section, data, working, state) {
  const healthDeltas = {};
  const statDeltas = {};
  const bump = (id, dh) => { healthDeltas[id] = (healthDeltas[id] || 0) + dh; };
  const find = (id) => working.find((p) => p.id === id);

  if (section === "surgery") {
    if (data.outcome === "success") {
      for (const id of data.playerIds) bump(id, 4);
    }
  } else if (section === "combat") {
    for (const ev of data.events) {
      if (ev.kind === "single" || ev.kind === "multi") {
        const players = ev.playerIds.map(find).filter(Boolean);
        const maxPower = Math.max(...players.map((p) => p.stats.power));
        for (const p of players) {
          const dmg = maxPower - p.stats.power;
          if (dmg > 0) bump(p.id, -dmg);
        }
      } else if (ev.kind === "shadow") {
        const shadowCount = ev.playerIds.map(find).filter((p) => p && p.health <= 0).length;
        for (const p of ev.playerIds.map(find).filter((p) => p && p.health > 0)) {
          bump(p.id, -shadowCount);
        }
      }
    }
  } else if (section === "poison") {
    const damage = poisonDamageForRound(state.poisonDamageTable, state.round);
    for (const p of working) {
      if (p.health > 0 && data.floors.includes(roomFloor(p.room))) bump(p.id, -damage);
    }
  } else if (section === "hunger") {
    if (state.round >= 2) {
      for (const [playerId, t] of Object.entries(data.toggles)) {
        if (t.exempt) continue;
        const missing = (t.water ? 0 : 1) + (t.food ? 0 : 1);
        if (missing > 0) bump(Number(playerId), -missing);
      }
    }
  } else if (section === "rocket") {
    if (data.room) {
      for (const id of data.playerIds) bump(id, -4);
    }
  } else if (section === "items") {
    for (const [playerId, t] of Object.entries(data.toggles)) {
      const id = Number(playerId);
      if (t.pill) bump(id, 2);
      if (t.wine) {
        if (t.wineResult === 3) statDeltas[id] = { ...statDeltas[id], power: 1 };
        else if (t.wineResult === 4) statDeltas[id] = { ...statDeltas[id], speed: 1 };
        else if (t.wineResult === 5) statDeltas[id] = { ...statDeltas[id], weight: 1 };
        else if (t.wineResult === 6) bump(id, 2);
      }
      // Adrenaline's protection (next-round speed 10 + health floor 1) is a
      // forward-looking flag, applied when settling THAT future round —
      // not a delta here.
    }
  } else if (section === "revival") {
    for (const [playerId, absorbed] of Object.entries(data.absorbedThisRound)) {
      bump(Number(playerId), absorbed);
    }
  }

  for (const [id, dh] of Object.entries(healthDeltas)) {
    const p = find(Number(id));
    if (p) p.health += dh;
  }
  for (const [id, ds] of Object.entries(statDeltas)) {
    const p = find(Number(id));
    if (p) for (const k of Object.keys(ds)) p.stats[k] = (p.stats[k] || 0) + ds[k];
  }

  // Revival is the one section where crossing the health>=0 threshold is a
  // state transition, not just a number: whoever's working health reaches
  // >=0 this round revives with health equal to whatever they actually
  // absorbed (at least 1, since 0 still reads as a shadow everywhere else).
  const revivedIds = [];
  if (section === "revival") {
    for (const [playerId] of Object.entries(data.absorbedThisRound)) {
      const p = find(Number(playerId));
      if (p && p.health >= 0) {
        p.health = Math.max(1, p.health);
        revivedIds.push(p.id);
      }
    }
  }

  const extra = {};
  if (section === "poison") {
    extra.previousPoisonFloors = [...state.poisonFloors];
    state.poisonFloors = [...new Set([...state.poisonFloors, ...data.floors])];
  }

  return { healthDeltas, statDeltas, revivedIds, extra };
}

function undoSectionEffect(section, applied, working, state) {
  const find = (id) => working.find((p) => p.id === id);
  for (const [id, dh] of Object.entries(applied.healthDeltas || {})) {
    const p = find(Number(id));
    if (p) p.health -= dh;
  }
  for (const [id, ds] of Object.entries(applied.statDeltas || {})) {
    const p = find(Number(id));
    if (p) for (const k of Object.keys(ds)) p.stats[k] = (p.stats[k] || 0) - ds[k];
  }
  if (section === "poison" && applied.extra && applied.extra.previousPoisonFloors) {
    state.poisonFloors = applied.extra.previousPoisonFloors;
  }
}

function startSettlementDraft(state) {
  if (state.settlementDraft && state.settlementDraft.round === state.round) return; // already in progress — resume as-is
  const snapshot = draftPlayerSnapshot(state.players);
  const working = draftPlayerSnapshot(state.players);
  const sections = {};
  for (const name of ["surgery", "combat", "poison", "hunger", "rocket", "items", "revival"]) {
    sections[name] = { committed: false, data: computeSectionDefault(name, working, state), applied: null };
  }
  state.settlementDraft = { round: state.round, baseline: snapshot, working, sections };
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

// Server-side proxy to the stats spreadsheet's Apps Script web app — avoids
// a cross-origin fetch from the browser and keeps the sheet URL out of
// client-side code. Password-gated like every other admin action, even
// though it's read-only, since it triggers an outbound call on request.
app.get("/api/import-players", async (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  try {
    const sheetRes = await fetch(SHEET_API_URL, { redirect: "follow" });
    if (!sheetRes.ok) {
      res.status(502).json({ ok: false, error: "sheet_fetch_failed" });
      return;
    }
    const data = await sheetRes.json();
    res.json({ ok: true, players: Array.isArray(data.players) ? data.players : [] });
  } catch {
    res.status(502).json({ ok: false, error: "sheet_fetch_error" });
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
          hackerRoomMark: null,
          floorVotes: {},
          rocketTargetRoom: null,
          settlementDraft: null,
          timer: state.timer,
        };
        break;
      }
      // Covers the whole "职业设置" block on the setup screen in one message:
      // enabled, the chosen pool, and whether players get to see their own
      // role card at all (public/admin views always show assignments either
      // way, so this only affects index.html).
      case "admin:setRoleConfig": {
        if (state.phase !== "setup") return;
        state.rolesEnabled = !!msg.enabled;
        state.selectedRoles = clampSelectedRoles(msg.roleIds);
        if (msg.visible !== undefined) state.rolesVisibleToPlayers = !!msg.visible;
        break;
      }
      // Assigned inline from the admin player table (like room/health), not
      // part of the batched edit/commit flow — takes effect immediately.
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
        armTimerExpiry();
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
          if (msg.round !== undefined) {
            const newRound = clampNonNegativeInt(msg.round);
            // Floor votes and the rocket target are inputs for THIS round's
            // settlement — stale once the round actually changes.
            if (newRound !== state.round) {
              state.floorVotes = {};
              state.rocketTargetRoom = null;
            }
            state.round = newRound;
          }
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
      // Admin drags a player token onto a floor-column label to record their
      // poison-vote indicator — purely informational, distinct from
      // player.room and never moves it. Auto-cleared when the round changes.
      case "admin:setFloorVote": {
        if (state.phase !== "in_progress") return;
        const playerId = Math.round(Number(msg.playerId));
        const player = state.players.find((p) => p.id === playerId);
        if (!player) return;
        if (msg.floor === null) {
          delete state.floorVotes[playerId];
        } else {
          if (!FLOOR_IDS.has(msg.floor)) return;
          state.floorVotes[playerId] = msg.floor;
        }
        break;
      }
      // Admin drags the Rocket Launcher icon onto a room to mark this
      // round's blast target; cancelable, auto-cleared on round change.
      case "admin:setRocketTarget": {
        if (state.phase !== "in_progress") return;
        if (msg.room === null) {
          state.rocketTargetRoom = null;
        } else {
          if (!ROOM_IDS.has(msg.room)) return;
          state.rocketTargetRoom = msg.room;
        }
        break;
      }
      // Idempotent: creates a fresh draft only if none exists for this round
      // yet, otherwise leaves whatever's already in progress untouched — so
      // re-entering settlement after "取消结算" (a client-side-only exit,
      // no server message) resumes exactly where admin left off.
      case "admin:startSettlement": {
        if (state.phase !== "in_progress") return;
        startSettlementDraft(state);
        break;
      }
      // Admin edits a section's inputs (toggles, wine result, etc.) before
      // committing — merges into the existing computed data.
      case "admin:settlementSetSectionData": {
        const draft = state.settlementDraft;
        if (!draft || draft.round !== state.round) return;
        const sec = draft.sections[msg.section];
        if (!sec || sec.committed) return;
        sec.data = { ...sec.data, ...msg.data };
        break;
      }
      case "admin:settlementCommitSection": {
        const draft = state.settlementDraft;
        if (!draft || draft.round !== state.round) return;
        const sec = draft.sections[msg.section];
        if (!sec || sec.committed) return;
        sec.applied = commitSectionEffect(msg.section, sec.data, draft.working, state);
        sec.committed = true;
        break;
      }
      case "admin:settlementUndoSection": {
        const draft = state.settlementDraft;
        if (!draft || draft.round !== state.round) return;
        const sec = draft.sections[msg.section];
        if (!sec || !sec.committed) return;
        undoSectionEffect(msg.section, sec.applied, draft.working, state);
        sec.applied = null;
        sec.committed = false;
        break;
      }
      // Resets this section back to its freshly-auto-computed state — undoes
      // the commit first if needed, then discards any manual overrides.
      case "admin:settlementResetSection": {
        const draft = state.settlementDraft;
        if (!draft || draft.round !== state.round) return;
        const sec = draft.sections[msg.section];
        if (!sec) return;
        if (sec.committed) {
          undoSectionEffect(msg.section, sec.applied, draft.working, state);
          sec.applied = null;
          sec.committed = false;
        }
        sec.data = computeSectionDefault(msg.section, draft.working, state);
        break;
      }
      // Pushes the draft's working health/stats to the real (public)
      // players, advances the round or ends the game past MAX_ROUND, and
      // clears this round's trackers. Requires every section committed.
      case "admin:finishSettlement": {
        const draft = state.settlementDraft;
        if (!draft || draft.round !== state.round) return;
        if (!Object.values(draft.sections).every((s) => s.committed)) return;
        for (const wp of draft.working) {
          const p = state.players.find((pp) => pp.id === wp.id);
          if (!p) continue;
          p.health = wp.health;
          p.stats = { ...wp.stats };
        }
        state.settlementDraft = null;
        state.floorVotes = {};
        state.rocketTargetRoom = null;
        if (state.round >= MAX_ROUND) {
          state.phase = "ended";
        } else {
          state.round += 1;
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
      // Hacker's "秘密关闭1个房间功能" — one pick per round, locked once set
      // for the current round (a mark left over from an earlier round is
      // stale and doesn't block a new one), and can't repeat whichever room
      // was picked in the immediately preceding round specifically (round-2
      // or earlier is fair game again, even if it was picked back then).
      case "user:setHackerRoomMark": {
        if (state.phase !== "in_progress") return;
        const playerId = Math.round(Number(msg.playerId));
        const player = state.players.find((p) => p.id === playerId);
        if (!player || player.roleId !== "hacker") return;
        if (!ROOM_IDS.has(msg.room)) return;
        if (state.hackerRoomMark && state.hackerRoomMark.round === state.round) return;
        if (state.hackerRoomMark && state.hackerRoomMark.round === state.round - 1 && state.hackerRoomMark.room === msg.room) return;
        state.hackerRoomMark = { round: state.round, room: msg.room };
        break;
      }
      // Countdown timer — deliberately phase-independent so the admin can run
      // it during prep, in-game, or between games.
      case "admin:setTimer": {
        const sec = Math.max(0, Math.min(TIMER_MAX_SEC, Math.round(Number(msg.durationSec) || 0)));
        state.timer = { durationSec: sec, remainingSec: sec, running: false, endsAt: null };
        armTimerExpiry();
        break;
      }
      case "admin:startTimer": {
        const tm = state.timer || defaultTimer();
        if (tm.running || tm.remainingSec <= 0) return;
        state.timer = { ...tm, running: true, endsAt: Date.now() + tm.remainingSec * 1000 };
        armTimerExpiry();
        break;
      }
      case "admin:pauseTimer": {
        const tm = state.timer;
        if (!tm || !tm.running || !tm.endsAt) return;
        const left = Math.max(0, Math.ceil((tm.endsAt - Date.now()) / 1000));
        state.timer = { ...tm, running: false, remainingSec: left, endsAt: null };
        armTimerExpiry();
        break;
      }
      case "admin:resetTimer": {
        const tm = state.timer || defaultTimer();
        state.timer = { durationSec: tm.durationSec, remainingSec: tm.durationSec, running: false, endsAt: null };
        armTimerExpiry();
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
