const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const {
  FLOORS, STAT_DEFS, STAT_POINTS_TOTAL, DEFAULT_HEALTH, SPAWN_ROOM_IDS, STOPPABLE_ROOM_IDS, DEFAULT_POISON_DAMAGE_TABLE, DEFAULT_REVIVE_THRESHOLD,
  UNIQUE_ITEM_KEYS, STACKABLE_ITEM_KEYS, defaultPlayerItems, weaponPowerBonus, hasGun,
} = require("./public/map-data.js");
const { ROLE_ID_SET, ROLE_SKILL_LIMITS, ROLE_ASSIGN_BONUSES } = require("./public/roles-data.js");

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
    // How much Health a Shadow must absorb (cumulative) before reviving --
    // admin-editable during setup, like the poison damage table. Also what
    // a newly-dead player's Health gets forced to (as -reviveThreshold),
    // regardless of how much overkill damage they actually took -- see
    // admin:finishSettlement.
    reviveThreshold: DEFAULT_REVIVE_THRESHOLD,
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
    // Per-player audit trail of every REAL (committed, applied-to-public)
    // health/stat change: { [playerId]: LogEntry[] }, appended to only from
    // admin:finishSettlement (one entry per section that actually affected
    // that player) and admin:commitEdits (manual admin overrides) — never
    // touched by uncommitted/undone settlement work, so it's a true record
    // of what happened, not what was tried. Persists for the whole game
    // (only admin:restartGame/createGame resets it). See addPlayerLog().
    playerLogs: {},
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

// Items live on the real state.players (not the settlement draft) since
// admin doesn't edit inventory mid-settlement -- combat/poison math just
// reads them directly by id.
function playerItems(state, playerId) {
  const p = state.players.find((pp) => pp.id === playerId);
  return (p && p.items) || defaultPlayerItems();
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

// 意见领袖's "你有额外 N×2（N为其他勇士数）张票用于毒气投票" -- everyone
// else gets exactly 1 poison-floor vote; this role's total budget is 1 (the
// same baseline everyone has) plus 2x the number of OTHER players.
function floorVoteCapFor(player, state) {
  if (player.roleId !== "opinion_leader") return 1;
  const others = Math.max(0, (state.playerCount || 0) - 1);
  return 1 + others * 2;
}

// Round-0-only: any player whose assigned role grants a one-time permanent
// stat bonus (see ROLE_ASSIGN_BONUSES) gets it recorded here so it settles
// into Round 1 alongside that round's spawn-room fights, instead of the
// bonus silently never being applied anywhere.
function computeRoleAssignBonuses(working) {
  const out = [];
  for (const p of working) {
    const bonus = p.roleId && ROLE_ASSIGN_BONUSES[p.roleId];
    if (bonus) out.push({ playerId: p.id, roleId: p.roleId, stats: { ...bonus } });
  }
  return out;
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
      const data = { events: computeRoomEvents(working) };
      // Round 0 (still Prep, before Round 1) has no real combat yet — this
      // section instead carries spawn-room fights (players who secretly
      // chose the same spawn room, already covered by computeRoomEvents
      // above) plus one-time role-assignment bonuses like 驯兽师's.
      if (state.round === 0) data.roleBonuses = computeRoleAssignBonuses(working);
      return data;
    }
    case "poison": {
      const tally = {};
      // Each player's entry is an array of floor votes (not a single floor) --
      // everyone else casts at most 1, but 意见领袖 can cast several (see
      // floorVoteCapFor), each one counting toward the tally in full.
      for (const [playerId, floors] of Object.entries(state.floorVotes || {})) {
        const voter = working.find((p) => p.id === Number(playerId));
        if (!voter || voter.health <= 0) continue; // shadows don't vote
        for (const floor of floors) tally[floor] = (tally[floor] || 0) + 1;
      }
      const counts = Object.values(tally);
      const max = counts.length ? Math.max(...counts) : 0;
      const newFloors = max > 0 ? Object.keys(tally).filter((f) => tally[f] === max) : [];
      // "毒气" never dissipates -- every floor poisoned in an earlier round
      // keeps dealing damage every round after, on top of whichever floor(s)
      // this round's vote newly adds. `floors` (all currently-active poison
      // floors) is what actually deals damage below; `newFloors` is kept
      // separately just so the accordion can show what THIS round's vote
      // picked, distinct from floors that were already poisoned coming in.
      const floors = [...new Set([...state.poisonFloors, ...newFloors])];
      return { floors, newFloors, tally };
    }
    case "hunger": {
      const toggles = {};
      for (const p of working) {
        if (p.health <= 0) continue; // shadows don't hand in water/food
        // Opt-in: admin actively checks a player off as having handed
        // water/food in, rather than un-checking those who didn't. A B204
        // player is exempt either way, so their toggles start (and stay) true
        // -- same for anyone who revived last round ("复活后的第一轮...不需
        // 上交水粮").
        const realPlayer = state.players.find((pp) => pp.id === p.id);
        const justRevived = !!(realPlayer && realPlayer.revivedProtectedRound === state.round);
        const exempt = p.room === "B204" || justRevived;
        toggles[p.id] = { water: exempt, food: exempt, exempt, reason: p.room === "B204" ? "B204" : justRevived ? "revived" : null };
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
      // The Shadow's actual absorption gain is applied by "combat"'s
      // shadow-meet event (see commitSectionEffect), not here -- this
      // section's job is purely to notice, from CURRENT working health
      // (already reflecting combat's gain if it's been committed), who's
      // now crossed back to >=0 and finalize their revival. Comparing
      // against state.players (untouched until finishSettlement, so it's
      // still this round's starting health) gives "how much they've
      // absorbed so far this round" for the "本轮吸取" display, independent
      // of whether combat has actually been committed yet.
      const preview = {};
      for (const p of working) {
        const realPlayer = state.players.find((pp) => pp.id === p.id);
        if (!realPlayer || realPlayer.health > 0) continue; // wasn't a Shadow entering this round
        const absorbed = p.health - realPlayer.health;
        if (absorbed > 0) preview[p.id] = absorbed;
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
  let combatAutoLoss = null;
  let combatRoleBonusDeltas = null;

  if (section === "surgery") {
    if (data.outcome === "success") {
      for (const id of data.playerIds) bump(id, 4);
    }
  } else if (section === "combat") {
    combatAutoLoss = {};
    // Round-0-only permanent role bonuses (see computeRoleAssignBonuses) --
    // applied to `working` right away, BEFORE this round's spawn-room fights
    // are evaluated below, so e.g. 驯兽师's +1 power already counts toward
    // their own fight. Tracked separately from `statDeltas` and merged in
    // further down (after the generic statDeltas-apply loop already ran for
    // every OTHER section) so this mutation is never applied a second time.
    if (data.roleBonuses) {
      combatRoleBonusDeltas = {};
      for (const rb of data.roleBonuses) {
        const p = find(rb.playerId);
        if (!p) continue;
        for (const k of Object.keys(rb.stats)) p.stats[k] = (p.stats[k] || 0) + rb.stats[k];
        combatRoleBonusDeltas[rb.playerId] = { ...combatRoleBonusDeltas[rb.playerId], ...rb.stats };
      }
    }
    for (const ev of data.events) {
      if (ev.kind === "single") {
        // 8/9's "若交战时对方无枪，则无需比较武力，对方直接扣除等同己方武力
        // 的生命值" rule only has a clean 1-attacker/1-defender reading for a
        // 2-player duel -- see the "multi" branch below for why a 3+ brawl
        // just uses effective power in the normal comparison instead.
        const [aId, bId] = ev.playerIds;
        const a = find(aId), b = find(bId);
        if (!a || !b) continue;
        const aItems = playerItems(state, aId);
        const bItems = playerItems(state, bId);
        const aPower = a.stats.power + weaponPowerBonus(aItems);
        const bPower = b.stats.power + weaponPowerBonus(bItems);
        const aGun = hasGun(aItems);
        const bGun = hasGun(bItems);
        if (aGun && !bGun) {
          bump(bId, -aPower);
          combatAutoLoss[bId] = true;
        } else if (bGun && !aGun) {
          bump(aId, -bPower);
          combatAutoLoss[aId] = true;
        } else {
          if (aPower > bPower) bump(bId, -(aPower - bPower));
          else if (bPower > aPower) bump(aId, -(bPower - aPower));
        }
      } else if (ev.kind === "multi") {
        const players = ev.playerIds.map(find).filter(Boolean);
        const powers = players.map((p) => ({ id: p.id, power: p.stats.power + weaponPowerBonus(playerItems(state, p.id)) }));
        const maxPower = Math.max(...powers.map((x) => x.power));
        for (const { id, power } of powers) {
          const dmg = maxPower - power;
          if (dmg > 0) bump(id, -dmg);
        }
      } else if (ev.kind === "shadow") {
        // "若'暗影'玩家和存活玩家同处一室，每个存活玩家均会被每个暗影吸取1
        // 点生命值" -- one drain, two sides: living players lose 1 per
        // Shadow present, and each Shadow gains 1 per living player present
        // (this IS the absorption revival is based on, applied here rather
        // than in "revival" so it's visible in this accordion too).
        const shadowCount = ev.playerIds.map(find).filter((p) => p && p.health <= 0).length;
        const livingCount = ev.playerIds.map(find).filter((p) => p && p.health > 0).length;
        for (const p of ev.playerIds.map(find).filter((p) => p && p.health > 0)) {
          bump(p.id, -shadowCount);
        }
        for (const p of ev.playerIds.map(find).filter((p) => p && p.health <= 0)) {
          bump(p.id, livingCount);
        }
      }
    }
  } else if (section === "poison") {
    const damage = poisonDamageForRound(state.poisonDamageTable, state.round);
    for (const p of working) {
      if (p.health <= 0) continue;
      // 11's 防毒面具 (gas mask) holder is immune to poison-gas damage entirely
      // -- so is anyone who revived last round, for their first round back.
      const realPlayer = state.players.find((pp) => pp.id === p.id);
      const justRevived = realPlayer && realPlayer.revivedProtectedRound === state.round;
      if (justRevived) continue;
      if (data.floors.includes(roomFloor(p.room)) && !playerItems(state, p.id).gasMask) bump(p.id, -damage);
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
  }
  // "revival" applies no bump of its own -- the actual absorption already
  // happened via "combat"'s shadow-meet event; see the health>=0 finalize
  // block below instead.

  for (const [id, dh] of Object.entries(healthDeltas)) {
    const p = find(Number(id));
    if (!p) continue;
    const realPlayer = state.players.find((pp) => pp.id === Number(id));
    // 肾上腺素's "next round can't die" protection -- floors this section's
    // damage at 1 health for whoever used it last round. The recorded delta
    // is corrected to the actual (possibly clamped) change so undo/logs stay
    // accurate regardless of what the raw math would have done.
    const protectedNow = realPlayer && realPlayer.adrenalineProtectedRound === state.round;
    const before = p.health;
    let after = before + dh;
    if (protectedNow && after < 1) after = 1;
    p.health = after;
    healthDeltas[id] = after - before;
  }
  for (const [id, ds] of Object.entries(statDeltas)) {
    const p = find(Number(id));
    if (p) for (const k of Object.keys(ds)) p.stats[k] = (p.stats[k] || 0) + ds[k];
  }
  // Merged in AFTER the loop above (not before) -- combatRoleBonusDeltas was
  // already applied to `working` directly earlier in the "combat" branch, so
  // folding it into `statDeltas` only here (for the log/undo record) avoids
  // applying it to player stats twice.
  if (combatRoleBonusDeltas) {
    for (const [id, ds] of Object.entries(combatRoleBonusDeltas)) {
      statDeltas[id] = { ...statDeltas[id], ...ds };
    }
  }

  // Revival is the one section where crossing the health>=0 threshold is a
  // state transition, not just a number: whoever's working health reaches
  // >=0 this round revives with health equal to the TOTAL amount they've
  // absorbed since dying (at least 1, since 0 still reads as a shadow
  // everywhere else) -- not just "however close to 0 the debt math landed".
  // Death always sets health to exactly -reviveThreshold (see
  // admin:finishSettlement), and a Shadow's health only ever moves via
  // absorption while dead, so (current health + reviveThreshold) IS that
  // running total, however many rounds and however many living players it
  // took. The adjustment is folded into healthDeltas so it's part of the
  // recorded delta -- otherwise undo/logs would only reverse the absorption
  // and silently leave the rest behind, permanently drifting their health
  // every commit/undo cycle.
  const revivedIds = [];
  if (section === "revival") {
    const threshold = state.reviveThreshold || DEFAULT_REVIVE_THRESHOLD;
    for (const [playerId] of Object.entries(data.absorbedThisRound)) {
      const id = Number(playerId);
      const p = find(id);
      if (p && p.health >= 0) {
        const beforeClamp = p.health;
        p.health = Math.max(1, p.health + threshold);
        if (p.health !== beforeClamp) healthDeltas[id] = (healthDeltas[id] || 0) + (p.health - beforeClamp);
        revivedIds.push(id);
      }
    }
  }

  const extra = {};
  if (section === "poison") {
    extra.previousPoisonFloors = [...state.poisonFloors];
    // data.floors is already the full cumulative set (see
    // computeSectionDefault's "poison" case) -- no further union needed.
    state.poisonFloors = [...data.floors];
  }
  if (section === "combat" && combatAutoLoss && Object.keys(combatAutoLoss).length) {
    extra.autoLoss = combatAutoLoss;
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
  // Round 0 (still Prep, before Round 1) has nothing yet for surgery/poison/
  // hunger/rocket/items/revival to describe — their computed defaults are
  // already a strict no-op this early (e.g. hunger only bites from Round 2,
  // B202 isn't a valid spawn room). Auto-commit them so admin only ever has
  // to look at "combat" (spawn-room fights + role-assignment bonuses).
  if (state.round === 0) {
    for (const name of ["surgery", "poison", "hunger", "rocket", "items", "revival"]) {
      const sec = sections[name];
      sec.applied = commitSectionEffect(name, sec.data, working, state);
      sec.committed = true;
    }
  }
  state.settlementDraft = { round: state.round, baseline: snapshot, working, sections };
}

// Appends one audit-trail entry for a player. Called only for REAL, applied
// effects (from finishSettlement or a manual admin edit) — never for
// in-progress/undone settlement work, so admin:settlementUndoSection and a
// discarded 取消结算 simply never produce an entry here.
function addPlayerLog(state, playerId, entry) {
  const key = String(playerId);
  (state.playerLogs[key] = state.playerLogs[key] || []).push(entry);
}

// Walks the 7 settlement sections in their fixed accordion order (1-7),
// turning each committed section's applied effect into one log entry per
// affected player. Order only matters for the running health-before/after
// shown in the log (so it reads top-to-bottom like the accordion the admin
// just worked through) — the actual final health is order-independent since
// every section effect is a pure additive delta. Only called once
// admin:finishSettlement has confirmed every section is committed.
function buildSettlementLogEntries(state, draft) {
  const runningHealth = {};
  for (const wp of draft.baseline) runningHealth[wp.id] = wp.health;

  for (const key of ["surgery", "combat", "poison", "hunger", "rocket", "items", "revival"]) {
    const sec = draft.sections[key];
    if (!sec.applied) continue;

    if (key === "items") {
      // One entry per active toggle (not per commitSectionEffect's combined
      // delta) so e.g. adrenaline still shows up even though it currently
      // contributes 0 to healthDeltas/statDeltas (it's a forward-looking
      // flag, not an immediate effect).
      for (const [idStr, t] of Object.entries(sec.data.toggles)) {
        if (!t.pill && !t.wine && !t.adrenaline) continue;
        const id = Number(idStr);
        const hDelta = (sec.applied.healthDeltas && sec.applied.healthDeltas[id]) || 0;
        const sDelta = sec.applied.statDeltas && sec.applied.statDeltas[id];
        const before = runningHealth[id];
        const after = before + hDelta;
        runningHealth[id] = after;
        addPlayerLog(state, id, {
          round: draft.round,
          source: "items",
          detail: { pill: t.pill, wine: t.wine, wineResult: t.wineResult, adrenaline: t.adrenaline },
          room: null,
          healthBefore: before,
          healthAfter: after,
          healthDelta: hDelta,
          statDeltas: sDelta || null,
        });
      }
      continue;
    }

    const { healthDeltas, statDeltas, revivedIds } = sec.applied;
    const ids = new Set([...Object.keys(healthDeltas || {}), ...Object.keys(statDeltas || {})]);
    for (const idStr of ids) {
      const id = Number(idStr);
      const hDelta = (healthDeltas && healthDeltas[id]) || 0;
      const sDelta = statDeltas && statDeltas[id];
      if (!hDelta && !sDelta) continue; // no real effect on this player — nothing to log
      const before = runningHealth[id];
      const after = before + hDelta;
      runningHealth[id] = after;

      let detail = {};
      let room = null;
      if (key === "surgery") {
        room = "B202";
      } else if (key === "combat") {
        const ev = sec.data.events.find((e) => e.playerIds.includes(id));
        const autoLoss = !!(sec.applied.extra && sec.applied.extra.autoLoss && sec.applied.extra.autoLoss[id]);
        const roleBonus = sec.data.roleBonuses && sec.data.roleBonuses.find((rb) => rb.playerId === id);
        detail = { kind: ev ? ev.kind : null, autoLoss, roleBonus: roleBonus ? { roleId: roleBonus.roleId, stats: roleBonus.stats } : null };
        room = ev ? ev.room : null;
      } else if (key === "poison") {
        const wp = draft.working.find((p) => p.id === id);
        room = wp ? wp.room : null;
        detail = { floor: room ? roomFloor(room) : null };
      } else if (key === "hunger") {
        const t = sec.data.toggles[id];
        detail = { missingWater: t ? !t.water : false, missingFood: t ? !t.food : false };
      } else if (key === "rocket") {
        room = sec.data.room;
      } else if (key === "revival") {
        detail = { absorbed: sec.data.absorbedThisRound[id], revived: revivedIds.includes(id) };
      }

      addPlayerLog(state, id, {
        round: draft.round,
        source: key,
        detail,
        room,
        healthBefore: before,
        healthAfter: after,
        healthDelta: hDelta,
        statDeltas: sDelta || null,
      });
    }
  }
}

const app = express();
app.disable("x-powered-by");
app.use(express.json());
// extensions lets e.g. /simulator resolve to /simulator.html without a redirect.
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Lightweight target for external uptime pings (e.g. cron-job.org) — avoids
// the static-file/game-state overhead of hitting "/" just to keep the
// Render free-tier instance from spinning down on inactivity.
app.get("/healthz", (req, res) => {
  res.status(200).end();
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
            skillUses: 0,
            items: defaultPlayerItems(),
            // Set by admin:finishSettlement when 肾上腺素 was used this round --
            // the round number during which that player can't drop below 1
            // health, checked as `=== state.round` (see the clamp in the
            // healthDeltas-apply loop inside commitSectionEffect).
            adrenalineProtectedRound: null,
            // Set by admin:finishSettlement for whoever revived THIS round --
            // the following round they're still immune to poison and don't
            // need to hand in water/food ("复活后的第一轮依然不受'毒气'伤害，
            // 不需上交水粮"), checked the same way as adrenalineProtectedRound.
            revivedProtectedRound: null,
          })),
          round: 0,
          poisonFloors: [],
          poisonDamageTable: state.poisonDamageTable,
          reviveThreshold: state.reviveThreshold,
          rolesEnabled: state.rolesEnabled,
          selectedRoles: state.selectedRoles,
          rolesVisibleToPlayers: state.rolesVisibleToPlayers,
          hackerRoomMark: null,
          floorVotes: {},
          rocketTargetRoom: null,
          settlementDraft: null,
          playerLogs: {},
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
        player.skillUses = 0; // a reassigned role starts its own count fresh
        break;
      }
      // Admin ticks a role's invokable-skill usage up/down by 1, clamped to
      // ROLE_SKILL_LIMITS[roleId] (or unclamped above 0 if that role has no
      // total-use cap). Purely a bookkeeping counter, visible to the player
      // themselves too (read-only) -- no game effect is computed or applied
      // here.
      case "admin:adjustSkillUses": {
        if (state.phase !== "in_progress") return;
        const player = state.players.find((p) => p.id === Math.round(Number(msg.playerId)));
        if (!player || !player.roleId || !(player.roleId in ROLE_SKILL_LIMITS)) return;
        const cap = ROLE_SKILL_LIMITS[player.roleId];
        const next = (player.skillUses || 0) + (Number(msg.delta) > 0 ? 1 : -1);
        player.skillUses = cap === null ? Math.max(0, next) : Math.max(0, Math.min(cap, next));
        break;
      }
      // Admin edits one player's item-card inventory (道具卡 7-14) from the
      // bag-icon modal. Knife/pistol/shotgun are stackable counts; the other
      // five exist as exactly ONE copy in the whole game, so setting one to
      // true here vacates it from whoever else was holding it.
      case "admin:setPlayerItems": {
        if (state.phase !== "prep" && state.phase !== "in_progress") return;
        const player = state.players.find((p) => p.id === Math.round(Number(msg.playerId)));
        if (!player || typeof msg.items !== "object" || !msg.items) return;
        const next = { ...defaultPlayerItems() };
        for (const key of STACKABLE_ITEM_KEYS) {
          next[key] = Math.max(0, Math.round(Number(msg.items[key]) || 0));
        }
        for (const key of UNIQUE_ITEM_KEYS) {
          next[key] = !!msg.items[key];
        }
        for (const key of UNIQUE_ITEM_KEYS) {
          if (next[key]) {
            for (const other of state.players) {
              if (other.id !== player.id) other.items[key] = false;
            }
          }
        }
        player.items = next;
        break;
      }
      case "admin:setPoisonDamageTable": {
        if (state.phase !== "setup") return;
        const clean = clampPoisonDamageTable(msg.table);
        if (!clean) return;
        state.poisonDamageTable = clean;
        break;
      }
      case "admin:setReviveThreshold": {
        if (state.phase !== "setup") return;
        const n = Math.round(Number(msg.threshold));
        if (!Number.isFinite(n) || n < 1) return;
        state.reviveThreshold = n;
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
            const newStats = clampAdminStats(pu.stats);
            const newHealth = clampHealth(pu.health);
            // The draft the admin edits always holds every player, whether or
            // not admin actually touched their row, so only a real diff (not
            // "resubmitted the same values") is worth an audit-log entry —
            // and only once the game is actually running (prep-phase edits
            // are just initial setup, not a round event to validate later).
            if (state.phase === "in_progress") {
              const healthDelta = newHealth - player.health;
              const statDeltas = {};
              for (const k of ["power", "speed", "weight"]) {
                if (newStats[k] !== player.stats[k]) statDeltas[k] = newStats[k] - player.stats[k];
              }
              if (healthDelta !== 0 || Object.keys(statDeltas).length) {
                addPlayerLog(state, player.id, {
                  round: state.round,
                  source: "manual",
                  detail: {},
                  room: player.room,
                  healthBefore: player.health,
                  healthAfter: newHealth,
                  healthDelta,
                  statDeltas: Object.keys(statDeltas).length ? statDeltas : null,
                });
              }
            }
            player.stats = newStats;
            player.health = newHealth;
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
      // Each player's votes are an array (not a single floor): everyone else
      // is capped at 1 (a fresh drag just reassigns it, same as before), but
      // 意见领袖's "额外N×2张票" (N = other players) lets them cast several
      // -- each additional drag onto a floor label appends one more vote
      // instead of replacing, up to their cap; msg.action:"remove" (used by
      // clicking a vote dot) takes exactly one matching vote back off.
      case "admin:setFloorVote": {
        if (state.phase !== "in_progress") return;
        const playerId = Math.round(Number(msg.playerId));
        const player = state.players.find((p) => p.id === playerId);
        if (!player) return;
        if (player.health <= 0) return; // a Shadow (暗影) doesn't get to vote on poison gas
        const votes = state.floorVotes[playerId] || [];
        if (msg.action === "remove") {
          if (!FLOOR_IDS.has(msg.floor)) return;
          const idx = votes.indexOf(msg.floor);
          if (idx === -1) return;
          const next = [...votes.slice(0, idx), ...votes.slice(idx + 1)];
          if (next.length) state.floorVotes[playerId] = next;
          else delete state.floorVotes[playerId];
        } else if (msg.floor === null) {
          delete state.floorVotes[playerId];
        } else {
          if (!FLOOR_IDS.has(msg.floor)) return;
          const cap = floorVoteCapFor(player, state);
          if (cap <= 1) {
            state.floorVotes[playerId] = [msg.floor];
          } else {
            if (votes.length >= cap) return; // 意见领袖's bonus votes are exhausted
            state.floorVotes[playerId] = [...votes, msg.floor];
          }
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
        // Round 0's settlement (spawn-room fights + role-assignment bonuses)
        // runs during Prep, before the game has actually "started" — see
        // admin:finishSettlement, which is what flips phase to in_progress.
        const isRoundZeroPrep = state.phase === "prep" && state.round === 0;
        if (state.phase !== "in_progress" && !isRoundZeroPrep) return;
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
        // Snapshot every player's health right before/after this section's
        // own effect, so admin.html can always show THIS section's true
        // before/after -- draft.working keeps getting mutated by whichever
        // sections commit after this one, so recomputing "before" later from
        // the (by-then-further-reduced) live health would retroactively
        // shift what an already-committed section displays.
        const healthBefore = {};
        for (const p of draft.working) healthBefore[p.id] = p.health;
        sec.applied = commitSectionEffect(msg.section, sec.data, draft.working, state);
        const healthAfter = {};
        for (const p of draft.working) healthAfter[p.id] = p.health;
        sec.applied.healthBefore = healthBefore;
        sec.applied.healthAfter = healthAfter;
        sec.committed = true;
        // Every section's `data` is computed once, at draft creation, from
        // whatever working looked like before anything was committed --
        // "revival" is the one section whose own data (absorbedThisRound)
        // is actually ABOUT the health changes other sections just made (see
        // computeSectionDefault's "revival" case), so it needs refreshing
        // against the current working state after every other commit, or it
        // would keep showing 0 absorption forever, however many sections
        // (particularly "combat") have already run.
        if (msg.section !== "revival" && !draft.sections.revival.committed) {
          draft.sections.revival.data = computeSectionDefault("revival", draft.working, state);
        }
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
        // Same reasoning as the commit handler -- undoing e.g. "combat"
        // reverses the Shadow absorption "revival" was showing, so its data
        // needs refreshing against working's now-reverted state too.
        if (msg.section !== "revival" && !draft.sections.revival.committed) {
          draft.sections.revival.data = computeSectionDefault("revival", draft.working, state);
        }
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
      // Discards the whole draft outright -- unlike a per-section undo, this
      // throws away every committed section too. Re-clicking 结算 calls
      // startSettlementDraft() again, which (finding no draft for this round)
      // builds a brand new one from scratch rather than resuming.
      case "admin:cancelSettlement": {
        const draft = state.settlementDraft;
        if (!draft || draft.round !== state.round) return;
        state.settlementDraft = null;
        break;
      }
      // Pushes the draft's working health/stats to the real (public)
      // players, advances the round or ends the game past MAX_ROUND, and
      // clears this round's trackers. Requires every section committed.
      case "admin:finishSettlement": {
        const draft = state.settlementDraft;
        if (!draft || draft.round !== state.round) return;
        if (!Object.values(draft.sections).every((s) => s.committed)) return;
        buildSettlementLogEntries(state, draft);
        for (const wp of draft.working) {
          const p = state.players.find((pp) => pp.id === wp.id);
          if (!p) continue;
          // Just became a Shadow (暗影) this round -- their settled Health is
          // forced to exactly -reviveThreshold (not whatever the raw combined
          // damage added up to), so revival always needs exactly that much
          // absorption regardless of how much overkill damage they took, and
          // they move straight to the Morgue (B701 停尸间). The per-section
          // audit log above still shows the real (unclamped) numbers, since
          // this override is a rules step that happens after the fact, not a
          // correction to what actually happened each section.
          if (p.health > 0 && wp.health <= 0) {
            p.health = -(state.reviveThreshold || DEFAULT_REVIVE_THRESHOLD);
            p.room = "B701";
          } else {
            p.health = wp.health;
          }
          p.stats = { ...wp.stats };
        }
        // 肾上腺素 used THIS round protects the player during the NEXT one --
        // set the flag before advancing state.round below (irrelevant if
        // this was the final round, since there is no next one to protect).
        if (state.round < MAX_ROUND) {
          const nextRound = state.round + 1;
          for (const [idStr, t] of Object.entries(draft.sections.items.data.toggles)) {
            if (!t.adrenaline) continue;
            const p = state.players.find((pp) => pp.id === Number(idStr));
            if (p) p.adrenalineProtectedRound = nextRound;
          }
          // Same idea for anyone who revived THIS round -- immune to poison
          // and exempt from water/food next round only.
          const revivalApplied = draft.sections.revival.applied;
          for (const id of (revivalApplied && revivalApplied.revivedIds) || []) {
            const p = state.players.find((pp) => pp.id === id);
            if (p) p.revivedProtectedRound = nextRound;
          }
        }
        state.settlementDraft = null;
        state.floorVotes = {};
        state.rocketTargetRoom = null;
        // Round 0's settlement is what actually starts the game -- there's
        // no separate admin:startGame anymore, so finishing it here both
        // applies its one-off effects and flips Prep -> in_progress, right
        // before advancing to Round 1 below (0 < MAX_ROUND always holds).
        if (state.phase === "prep" && draft.round === 0) {
          state.phase = "in_progress";
        }
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
