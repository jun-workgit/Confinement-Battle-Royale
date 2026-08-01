const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const {
  FLOORS, STAT_DEFS, STAT_POINTS_TOTAL, DEFAULT_HEALTH, SPAWN_ROOM_IDS, STOPPABLE_ROOM_IDS, DEFAULT_POISON_DAMAGE_TABLE, DEFAULT_REVIVE_THRESHOLD, MULTI_FLOOR_ROOMS,
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
    // 化学家's "毒性调和" (1 of 2, admin sets before 结算 opens, same as
    // floorVotes/rocketTargetRoom above -- frozen into the poison section's
    // default the moment 结算 starts, then cleared at admin:finishSettlement):
    // { type: "boost" } (+2 to every floor that newly becomes poisoned THIS
    // round) or { type: "reduce", room } (-2, floor of 0, for a room whose
    // floor is ALREADY poisoned coming into this round).
    chemistAction: null,
    // 102 (激光室)'s "经过或停留在该房间将立即扣除1点生命值" isn't something
    // this app can detect on its own (it only knows a player's final room
    // for the round, not their real physical walking path) -- admin marks
    // it manually by dragging a player's token onto 102 itself (stopped
    // there) or the dedicated red zone next to it on the map (merely passed
    // through, final room unaffected). Unlike every other pre-结算 map
    // setting above, this is a REAL, immediate health change (see
    // admin:setLaserMark) rather than something deferred to 结算 -- { round,
    // healthBefore, roomBefore } per marked player id, kept only so
    // "cancel" can undo it exactly; cleared every round the same way.
    laserMarks: {},
    // 201 (基因库)'s "三项属性各永久+1" -- same manual-marking model as
    // laserMarks above (stop in the room, or pass through its dedicated
    // zone; see admin:setGeneMark), just stats instead of health/room:
    // { round, statsBefore } per marked player id.
    geneMarks: {},
    // B101 (控制室)'s function 2: "选择一个'毒气'房间永久'解毒'...从当轮开始，
    // 停留在该房间的玩家均不受'毒气'伤害" -- a room in this list is immune to
    // poison damage forever regardless of its floor's status (see
    // isRoomPoisoned), set via admin:setRoomDetox. Deliberately admin-only
    // and never surfaced to index.html/public.html -- "不会被公示" (never
    // publicly announced) is the room's own rule text, not just an app
    // convenience, so the client code for those two views must never read
    // or render this field even though (like hackerRoomMark) it's still
    // physically present in the broadcast state.
    detoxifiedRooms: [],
    // B101 (控制室)'s function 1: "在本轮'毒气'投票中1票视为10票" -- admin
    // drags the dedicated icon (like the Rocket Launcher's) onto a floor
    // label once per use; each entry here is one +10 to that floor's tally
    // (see computeSectionDefault's "poison" case), independent of anyone's
    // own personal floor vote. Reusable any number of times per round
    // (unlike detoxifiedRooms, this IS a per-round input -- cleared the same
    // way floorVotes/rocketTargetRoom are).
    b101VoteBoosts: [],
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
//
// Fixed 1-8 accordion order -- every section's default is computed FROM
// `working`, which earlier sections in this order have already mutated by
// the time a later one is (re)computed, so this list doubles as the actual
// calculation order (see refreshUncommittedSections/cascadeUndoFrom below).
const SETTLEMENT_SECTION_ORDER = ["surgery", "combat", "shadow_meet", "poison", "hunger", "rocket", "items", "revival"];

function roomFloor(roomId) {
  if (!roomId) return null;
  if (roomId[0] === "B") {
    const m = roomId.match(/^B(\d)/);
    return m ? "B" + m[1] : null;
  }
  if (roomId === "201" || roomId === "202") return "2";
  return "1"; // 101, 102, 103, 104
}

// Most rooms sit wholly within one floor band, so "poisoned" just means
// their one floor is poisoned. A room in MULTI_FLOOR_ROOMS (currently only
// B501) only counts as poisoned once EVERY floor it spans is -- players can
// otherwise retreat to whichever half of the room isn't gassed. A room in
// `detoxifiedRooms` (B101 控制室's function 2 -- see admin:setRoomDetox)
// overrides this entirely: permanently immune regardless of floor state.
function isRoomPoisoned(roomId, poisonedFloors, detoxifiedRooms) {
  if (detoxifiedRooms && detoxifiedRooms.includes(roomId)) return false;
  const floors = MULTI_FLOOR_ROOMS[roomId] || [roomFloor(roomId)];
  return floors.length > 0 && floors.every((f) => f && poisonedFloors.includes(f));
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
    if (living.length === 2 && room !== "B202") {
      events.push({ room, kind: "single", playerIds: living.map((p) => p.id) });
    } else if (living.length > 2) {
      events.push({ room, kind: "multi", playerIds: living.map((p) => p.id) });
    }
  }
  return events;
}

// Shadow-meet events are their own pass, computed AFTER this round's fights
// (see the "combat" vs "shadow_meet" settlement sections) -- a player killed
// by THIS round's own brawl doesn't instantly start draining life the same
// round, so "is this a Shadow" is checked against state.players (their real,
// still-untouched-until-finishSettlement health as of the start of the
// round), never against `working`. Whether they still count as "living" to
// be drained FROM, on the other hand, DOES need the current (possibly
// combat-reduced) working health.
function computeShadowMeetEvents(working, state) {
  const byRoom = {};
  for (const p of working) {
    if (!p.room) continue;
    (byRoom[p.room] = byRoom[p.room] || []).push(p);
  }
  const events = [];
  for (const room of Object.keys(byRoom)) {
    const group = byRoom[room];
    const shadows = group.filter((p) => {
      const real = state.players.find((pp) => pp.id === p.id);
      return real && real.health <= 0;
    });
    const living = group.filter((p) => p.health > 0);
    if (shadows.length && living.length) {
      events.push({ room, kind: "shadow", playerIds: [...shadows, ...living].map((p) => p.id) });
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
      // Single duels and brawls only -- shadow-meet events are their own
      // section (see "shadow_meet" below), resolved AFTER this one, so a
      // Shadow's absorption is based on who's actually still alive once
      // this round's fights are done, not who merely started the room alive.
      const data = { events: computeRoomEvents(working) };
      // Round 0 (still Prep, before Round 1) has no real combat yet — this
      // section instead carries spawn-room fights (players who secretly
      // chose the same spawn room, already covered by computeRoomEvents
      // above) plus one-time role-assignment bonuses like 驯兽师's.
      if (state.round === 0) data.roleBonuses = computeRoleAssignBonuses(working);
      return data;
    }
    case "shadow_meet": {
      // Computed fresh from CURRENT working (refreshed after "combat" commits
      // or undoes -- see admin:settlementCommitSection/UndoSection), so a
      // player killed in this round's brawl does NOT yet count as an extra
      // Shadow here (that starts next round); they simply stop counting as
      // one of the living players a pre-existing Shadow absorbs from. See
      // computeShadowMeetEvents for exactly how that distinction is drawn.
      return { events: computeShadowMeetEvents(working, state) };
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
      // B101 (控制室)'s function 1: "1票视为10票" -- each use (see
      // admin:addB101VoteBoost) adds +10 to that floor's tally, independent
      // of anyone's own personal vote above.
      for (const floor of state.b101VoteBoosts || []) {
        tally[floor] = (tally[floor] || 0) + 10;
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
      // 化学家's "毒性调和" (1 of 2, admin sets from the 地图 tab BEFORE 结算
      // opens -- see admin:setChemistAction) is frozen in here exactly like
      // state.floorVotes/rocketTargetRoom feed the sections above; re-picking
      // after 结算 has started is blocked at the source, so this is just
      // whatever was chosen going in.
      return { floors, newFloors, tally, chemistAction: state.chemistAction };
    }
    case "hunger": {
      const toggles = {};
      // Round 1's toggle has no effect either way (see commitSectionEffect's
      // "state.round >= 2" gate) -- defaulting everyone to "handed in" here
      // avoids a wall of red switches that reads as "10 players are about to
      // lose health" when none of them actually will this round.
      const noEffectYet = state.round < 2;
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
        const defaultOn = exempt || noEffectYet;
        toggles[p.id] = { water: defaultOn, food: defaultOn, exempt, reason: p.room === "B204" ? "B204" : justRevived ? "revived" : null };
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
  let poisonGasMaskImmune = null;
  let chemistAdjusted = null; // 化学家's "毒性调和" -- see the "poison" branch below
  let shadowEnvoyResonance = 0; // 暗影使者's "暗影共鸣" -- see the "shadow" event branch below

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
      }
    }
  } else if (section === "shadow_meet") {
    // "若'暗影'玩家和存活玩家同处一室，每个存活玩家均会被每个暗影吸取1点
    // 生命值" -- one drain, two sides: living players lose 1 per Shadow
    // present, and each Shadow gains 1 per living player present (this IS
    // the absorption revival is based on, applied here rather than in
    // "revival" so it's visible in this accordion too). Runs AFTER "combat"
    // (see computeShadowMeetEvents), so this reflects who actually survived
    // this round's fights, not who merely started the room alive.
    // 暗影使者's "暗影共鸣": "免疫暗影吸取生命" excludes them from the
    // drained side entirely (their presence still counts toward each
    // Shadow's own gain below -- only THEIR health is protected, not the
    // Shadow's take); "每当其他暗影吸取生命，你恢复1点生命" is ONE trigger per
    // Shadow that absorbs (this round, across the whole map), regardless of
    // how much health that Shadow actually absorbed -- a Shadow draining 3
    // living players in one room is still a single "吸取生命" instance, not
    // 3, so this counts Shadows, not the amount they took.
    for (const ev of data.events) {
      const shadowCount = ev.playerIds.map(find).filter((p) => p && p.health <= 0).length;
      const livingCount = ev.playerIds.map(find).filter((p) => p && p.health > 0).length;
      const drainedLiving = ev.playerIds.map(find).filter((p) => p && p.health > 0 && p.roleId !== "shadow_envoy");
      for (const p of drainedLiving) {
        bump(p.id, -shadowCount);
      }
      for (const p of ev.playerIds.map(find).filter((p) => p && p.health <= 0)) {
        bump(p.id, livingCount);
        shadowEnvoyResonance += 1;
      }
    }
    if (shadowEnvoyResonance > 0) {
      const envoy = working.find((p) => p.roleId === "shadow_envoy" && p.health > 0);
      if (envoy) bump(envoy.id, shadowEnvoyResonance);
    }
  } else if (section === "poison") {
    const baseDamage = poisonDamageForRound(state.poisonDamageTable, state.round);
    poisonGasMaskImmune = [];
    chemistAdjusted = {};
    const chemistAction = data.chemistAction;
    for (const p of working) {
      if (p.health <= 0) continue;
      // 11's 防毒面具 (gas mask) holder is immune to poison-gas damage entirely
      // -- so is anyone who revived last round, for their first round back.
      const realPlayer = state.players.find((pp) => pp.id === p.id);
      const justRevived = realPlayer && realPlayer.revivedProtectedRound === state.round;
      if (justRevived) continue;
      if (!isRoomPoisoned(p.room, data.floors, state.detoxifiedRooms)) continue;
      if (playerItems(state, p.id).gasMask) {
        poisonGasMaskImmune.push(p.id); // took no damage, but admin still wants a log record of why
        continue;
      }
      // 化学家's "毒性调和" (1 of 2, set from the 地图 tab before 结算 opened
      // -- see admin:setChemistAction/computeSectionDefault's "poison" case):
      // "reduce" targets a room whose floor(s) were ALREADY poisoned coming
      // INTO this round (checked against state.poisonFloors, which this
      // section's own commit only updates further down -- still the
      // pre-round set at this point), never one THIS round's vote just
      // added; "boost" applies to EVERY floor that newly becomes poisoned
      // this round (data.newFloors), no target needed. Re-validated here
      // (not just trusted from when admin picked it) since eligibility can
      // shift between then and when this section actually commits.
      let damage = baseDamage;
      if (chemistAction && chemistAction.type === "reduce" && chemistAction.room === p.room && isRoomPoisoned(chemistAction.room, state.poisonFloors, state.detoxifiedRooms)) {
        damage = Math.max(0, damage - 2);
        chemistAdjusted[p.id] = -2;
      } else if (chemistAction && chemistAction.type === "boost") {
        const roomFloors = MULTI_FLOOR_ROOMS[p.room] || [roomFloor(p.room)];
        if (roomFloors.some((f) => (data.newFloors || []).includes(f))) {
          damage = damage + 2;
          chemistAdjusted[p.id] = 2;
        }
      }
      if (damage > 0) bump(p.id, -damage);
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

  const newlyDead = [];
  const adrenalineSaved = [];
  // 入殓师's "每当有勇士变成暗影，你的负重永久+1" -- triggers on EVERY death
  // this section causes, from whichever section actually causes it (same
  // "generic, not section-specific" treatment as adrenalineSaved above).
  // Checked fresh per-death (not once for the whole section) so an
  // undertaker who themselves dies partway through a multi-death section
  // still gets credit for deaths that preceded their own, but not their own
  // or ones after -- "存活状态" is implicit in "if he is alive" per the role.
  const undertakerGains = {};
  for (const [id, dh] of Object.entries(healthDeltas)) {
    const p = find(Number(id));
    if (!p) continue;
    const realPlayer = state.players.find((pp) => pp.id === Number(id));
    // 肾上腺素's "next round can't die" protection -- floors this section's
    // damage at 1 health for whoever used it last round, taking precedence
    // over the death clamp below (they cannot die at all this round). The
    // recorded delta is corrected to the actual (possibly clamped) change so
    // undo/logs stay accurate regardless of what the raw math would have done.
    const protectedNow = realPlayer && realPlayer.adrenalineProtectedRound === state.round;
    const before = p.health;
    let after = before + dh;
    if (protectedNow) {
      // Recorded every time it actually mattered (i.e. this section's own
      // math would otherwise have killed them) so admin can see exactly
      // which section 肾上腺素 saved them from and isn't left guessing why
      // the number stopped short of the expected debt value.
      if (before > 0 && after <= 0) adrenalineSaved.push(Number(id));
      if (after < 1) after = 1;
    } else if (before > 0 && after <= 0) {
      // Crossing from alive to dead THIS section -- forced to exactly
      // -reviveThreshold immediately (not deferred to admin:finishSettlement
      // like before), so every accordion's own 结算后 already shows the
      // real debt value instead of whatever raw arithmetic the damage added
      // up to (e.g. never "1 -> -1", always "1 -> -2" for a threshold of 2).
      after = -(state.reviveThreshold || DEFAULT_REVIVE_THRESHOLD);
      newlyDead.push(Number(id));
      const undertaker = working.find((w) => w.roleId === "undertaker" && w.health > 0 && w.id !== Number(id));
      if (undertaker) {
        statDeltas[undertaker.id] = { ...statDeltas[undertaker.id], weight: ((statDeltas[undertaker.id] && statDeltas[undertaker.id].weight) || 0) + 1 };
        undertakerGains[undertaker.id] = (undertakerGains[undertaker.id] || 0) + 1;
      }
    }
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
    if (poisonGasMaskImmune && poisonGasMaskImmune.length) extra.gasMaskImmune = poisonGasMaskImmune;
    if (chemistAdjusted && Object.keys(chemistAdjusted).length) extra.chemistAdjusted = chemistAdjusted;
  }
  if (section === "combat" && combatAutoLoss && Object.keys(combatAutoLoss).length) {
    extra.autoLoss = combatAutoLoss;
  }
  if (newlyDead.length) extra.newlyDead = newlyDead;
  if (adrenalineSaved.length) extra.adrenalineSaved = adrenalineSaved;
  if (Object.keys(undertakerGains).length) extra.undertakerGains = undertakerGains;

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

// Every section's default is computed FROM `working` as of right now (who's
// still alive, what floors are poisoned, etc.) -- so any section that hasn't
// been committed yet is, by definition, stale the moment an earlier one
// commits or gets undone. Recomputing every uncommitted section in order
// (not just shadow_meet/revival, which merely made this most visible) is
// what makes a player who died in section 2 actually disappear from section
// 4/6's toggle rows instead of still being offered water/food/item actions
// after death. Harmless to call after a NORMAL top-to-bottom commit too,
// since admin hasn't touched anything after the section that just committed
// yet -- recomputing it fresh is identical to what first opening it would
// have produced anyway.
function refreshUncommittedSections(draft, state) {
  for (const name of SETTLEMENT_SECTION_ORDER) {
    const sec = draft.sections[name];
    if (!sec.committed) sec.data = computeSectionDefault(name, draft.working, state);
  }
}

// Undoing (or resetting) section N invalidates every section after it in
// the fixed order too -- they were computed and committed against a
// `working` snapshot that N's own commit has since changed (e.g. a player it
// killed was still "alive" as far as a later section's toggles were
// concerned). Reversed in LIFO order so each undo exactly cancels what its
// own commit recorded, ending with `working` back to exactly where it stood
// right before N ever committed; refreshUncommittedSections (called by
// every handler below, after this) then recomputes N..end fresh from there.
function cascadeUndoFrom(draft, state, sectionKey) {
  const startIdx = SETTLEMENT_SECTION_ORDER.indexOf(sectionKey);
  for (let i = SETTLEMENT_SECTION_ORDER.length - 1; i >= startIdx; i--) {
    const name = SETTLEMENT_SECTION_ORDER[i];
    const sec = draft.sections[name];
    if (sec.committed) {
      undoSectionEffect(name, sec.applied, draft.working, state);
      sec.applied = null;
      sec.committed = false;
    }
  }
}

function startSettlementDraft(state) {
  if (state.settlementDraft && state.settlementDraft.round === state.round) return; // already in progress — resume as-is
  const snapshot = draftPlayerSnapshot(state.players);
  const working = draftPlayerSnapshot(state.players);
  const sections = {};
  for (const name of SETTLEMENT_SECTION_ORDER) {
    sections[name] = { committed: false, data: computeSectionDefault(name, working, state), applied: null };
  }
  // Round 0 (still Prep, before Round 1) has nothing yet for surgery/
  // shadow_meet/poison/hunger/rocket/items/revival to describe -- their
  // computed defaults are already a strict no-op this early (e.g. hunger
  // only bites from Round 2, B202 isn't a valid spawn room, and nobody can
  // possibly be a Shadow yet). Auto-commit them so admin only ever has to
  // look at "combat" (spawn-room fights + role-assignment bonuses).
  if (state.round === 0) {
    for (const name of ["surgery", "shadow_meet", "poison", "hunger", "rocket", "items", "revival"]) {
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

  for (const key of SETTLEMENT_SECTION_ORDER) {
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
    const gasMaskImmuneIds = (key === "poison" && sec.applied.extra && sec.applied.extra.gasMaskImmune) || [];
    // 肾上腺素 can save someone in ANY section that deals damage, not just
    // poison -- tracked generically (see commitSectionEffect's clamp loop)
    // so admin can tell exactly which section it fired in, every time.
    const adrenalineSavedIds = (sec.applied.extra && sec.applied.extra.adrenalineSaved) || [];
    const chemistAdjustedIds = (key === "poison" && sec.applied.extra && sec.applied.extra.chemistAdjusted) || {};
    const ids = new Set([...Object.keys(healthDeltas || {}), ...Object.keys(statDeltas || {}), ...gasMaskImmuneIds.map(String), ...adrenalineSavedIds.map(String), ...Object.keys(chemistAdjustedIds)]);
    for (const idStr of ids) {
      const id = Number(idStr);
      const hDelta = (healthDeltas && healthDeltas[id]) || 0;
      const sDelta = statDeltas && statDeltas[id];
      const gasMaskImmune = gasMaskImmuneIds.includes(id);
      const adrenalineSaved = adrenalineSavedIds.includes(id);
      const chemistAdjust = chemistAdjustedIds[id];
      // 0 delta is normally "nothing happened, don't log it" -- except gas
      // mask immunity, an adrenaline save, or a chemist adjustment (e.g. a
      // -2 reduction that zeroed out otherwise-1 damage), which admin
      // explicitly wants recorded even when the numeric effect alone
      // wouldn't stand out.
      if (!hDelta && !sDelta && !gasMaskImmune && !adrenalineSaved && chemistAdjust === undefined) continue;
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
      } else if (key === "shadow_meet") {
        const ev = sec.data.events.find((e) => e.playerIds.includes(id));
        detail = { kind: "shadow" };
        room = ev ? ev.room : null;
      } else if (key === "poison") {
        const wp = draft.working.find((p) => p.id === id);
        room = wp ? wp.room : null;
        detail = { floor: room ? roomFloor(room) : null, gasMaskImmune, chemistAdjust: chemistAdjust ?? null };
      } else if (key === "hunger") {
        const t = sec.data.toggles[id];
        detail = { missingWater: t ? !t.water : false, missingFood: t ? !t.food : false };
      } else if (key === "rocket") {
        room = sec.data.room;
      } else if (key === "revival") {
        detail = { absorbed: sec.data.absorbedThisRound[id], revived: revivedIds.includes(id) };
      }
      if (adrenalineSaved) detail.adrenalineSaved = true;

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
      // Connection-liveness ping (admin.html/public.html only -- see their
      // own comments) -- replied to directly, never broadcast, so it never
      // touches game state or other clients.
      case "ping": {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        break;
      }
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
          chemistAction: null,
          laserMarks: {},
          geneMarks: {},
          detoxifiedRooms: [],
          b101VoteBoosts: [],
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
            // Manual override for 肾上腺素's "next round can't die" clamp --
            // lets admin grant/revoke it for THIS round as if it had
            // actually been used last round, without an item-card trail.
            if (state.phase === "in_progress" && typeof pu.adrenaline === "boolean") {
              player.adrenalineProtectedRound = pu.adrenaline ? state.round : null;
            }
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
              state.chemistAction = null;
              state.laserMarks = {};
              state.geneMarks = {};
              state.b101VoteBoosts = [];
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
        // Positions are locked for the whole round once 结算 is open --
        // every section's math was computed from `working`, a snapshot
        // taken when the draft was created, so a room change here could
        // never actually reach it without recomputing section data out
        // from under whatever admin's already reviewed or submitted (see
        // 取消结算 for the intended way to fix a placement mid-settlement:
        // discard the draft, correct the room, start fresh).
        if (state.settlementDraft && state.settlementDraft.round === state.round) return;
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
        // Same reasoning as admin:setPlayerRoom -- poison's tally/floors were
        // already frozen into the draft when 结算 opened; changing votes
        // after that wouldn't reach the accordion at all. 取消结算 first.
        if (state.settlementDraft && state.settlementDraft.round === state.round) return;
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
          // "毒气" never dissipates once a floor is poisoned (see
          // isRoomPoisoned) -- a vote for it this round can only ever be
          // wasted, so it's rejected outright instead of silently tallying
          // toward a floor that's already maxed out.
          if (state.poisonFloors.includes(msg.floor)) return;
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
        // Same reasoning as admin:setPlayerRoom -- rocket's target/playerIds
        // were already frozen into the draft when 结算 opened. 取消结算 first.
        if (state.settlementDraft && state.settlementDraft.round === state.round) return;
        if (msg.room === null) {
          state.rocketTargetRoom = null;
        } else {
          if (!ROOM_IDS.has(msg.room)) return;
          state.rocketTargetRoom = msg.room;
        }
        break;
      }
      // Admin right-clicks a room on the 地图 tab to toggle B101 (控制室)'s
      // function 2 -- unlike every other manual mark in this app, this one
      // is PERMANENT (no per-round reset) and admin-only by design (see
      // detoxifiedRooms' own comment), so it's just a plain add/remove on
      // that list, no round/health/room bookkeeping needed. Locked the same
      // way as the other map controls once 结算 has opened for the round.
      case "admin:setRoomDetox": {
        if (state.phase !== "in_progress") return;
        if (state.settlementDraft && state.settlementDraft.round === state.round) return;
        if (!ROOM_IDS.has(msg.room)) return;
        const idx = state.detoxifiedRooms.indexOf(msg.room);
        if (msg.detoxified) {
          if (idx === -1) state.detoxifiedRooms.push(msg.room);
        } else if (idx !== -1) {
          state.detoxifiedRooms.splice(idx, 1);
        }
        break;
      }
      // B101 (控制室)'s function 1: admin drags a dedicated icon (like the
      // Rocket Launcher's) onto a floor label once per use -- reusable any
      // number of times per round (each entry is independent, unlike
      // rocketTargetRoom's single value), cleared the same way
      // floorVotes/rocketTargetRoom are.
      case "admin:addB101VoteBoost": {
        if (state.phase !== "in_progress") return;
        if (state.settlementDraft && state.settlementDraft.round === state.round) return;
        if (!FLOOR_IDS.has(msg.floor)) return;
        state.b101VoteBoosts.push(msg.floor);
        break;
      }
      case "admin:removeB101VoteBoost": {
        if (state.phase !== "in_progress") return;
        if (state.settlementDraft && state.settlementDraft.round === state.round) return;
        const idx = state.b101VoteBoosts.lastIndexOf(msg.floor);
        if (idx !== -1) state.b101VoteBoosts.splice(idx, 1);
        break;
      }
      // Admin sets/clears 化学家's "毒性调和" for this round from the 地图 tab
      // (same pre-结算 timing as floorVotes/setRocketTarget above -- frozen
      // into the poison section's default once 结算 opens, see
      // computeSectionDefault's "poison" case). Requires the role to actually
      // be in play and its holder alive -- past that point the pick itself
      // isn't re-checked again (same precedent as rocketTargetRoom not caring
      // whether its target room is still valid by the time 结算 runs).
      case "admin:setChemistAction": {
        if (state.phase !== "in_progress") return;
        if (state.settlementDraft && state.settlementDraft.round === state.round) return;
        const chemist = state.players.find((p) => p.roleId === "chemist");
        if (!state.rolesEnabled || !chemist || chemist.health <= 0) return;
        if (msg.action === null) {
          state.chemistAction = null;
        } else if (msg.action && msg.action.type === "boost") {
          state.chemistAction = { type: "boost" };
        } else if (msg.action && msg.action.type === "reduce") {
          if (!ROOM_IDS.has(msg.action.room)) return;
          if (!isRoomPoisoned(msg.action.room, state.poisonFloors, state.detoxifiedRooms)) return; // must already be poisoned
          state.chemistAction = { type: "reduce", room: msg.action.room };
        } else {
          return;
        }
        break;
      }
      // Admin manually flags 102 (激光室)'s "经过或停留...扣1点生命" -- a
      // REAL, immediate health change (not deferred to 结算, unlike every
      // other pre-结算 map setting above), since the app has no way to
      // detect this on its own. "add" applies the same death-clamp/Morgue
      // relocation as any other source of death (see commitSectionEffect's
      // clamp loop) so it stays consistent whether the fatal -1 happens here
      // or during 结算; "remove" is an exact undo using what was recorded at
      // mark time, plus dropping the log entry it created (as if it never
      // happened, not "corrected").
      case "admin:setLaserMark": {
        if (state.phase !== "in_progress") return;
        if (state.settlementDraft && state.settlementDraft.round === state.round) return;
        const playerId = Math.round(Number(msg.playerId));
        const player = state.players.find((p) => p.id === playerId);
        if (!player) return;
        if (msg.action === "add") {
          const existing = state.laserMarks[playerId];
          if (existing && existing.round === state.round) return; // already marked this round
          if (player.health <= 0) return; // a Shadow doesn't take this
          const healthBefore = player.health;
          const roomBefore = player.room;
          let after = healthBefore - 1;
          let becameShadow = false;
          if (after <= 0) {
            after = -(state.reviveThreshold || DEFAULT_REVIVE_THRESHOLD);
            becameShadow = true;
          }
          player.health = after;
          if (becameShadow) player.room = "B701";
          // roomBefore is only ever restored on "remove" if THIS mark is what
          // moved them (i.e. it killed them) -- a non-fatal mark never
          // touches room at all, so undoing it must not either, even if
          // admin has since moved them somewhere else entirely.
          state.laserMarks[playerId] = { round: state.round, healthBefore, roomBefore, becameShadow };
          addPlayerLog(state, playerId, {
            round: state.round,
            source: "laser102",
            detail: {},
            room: "102",
            healthBefore,
            healthAfter: after,
            healthDelta: after - healthBefore,
            statDeltas: null,
          });
        } else if (msg.action === "remove") {
          const mark = state.laserMarks[playerId];
          if (!mark || mark.round !== state.round) return;
          player.health = mark.healthBefore;
          if (mark.becameShadow) player.room = mark.roomBefore;
          delete state.laserMarks[playerId];
          const logs = state.playerLogs[String(playerId)];
          if (logs) {
            const idx = logs.findIndex((e) => e.round === state.round && e.source === "laser102");
            if (idx !== -1) logs.splice(idx, 1);
          }
        } else {
          return;
        }
        break;
      }
      // Admin manually flags 201 (基因库)'s "三项属性各永久+1" -- same model
      // as admin:setLaserMark above (a REAL, immediate stat change, not
      // deferred to 结算), just stats instead of health/room. "remove" is an
      // exact undo using the pre-mark stats snapshot, plus dropping the log
      // entry it created.
      case "admin:setGeneMark": {
        if (state.phase !== "in_progress") return;
        if (state.settlementDraft && state.settlementDraft.round === state.round) return;
        const playerId = Math.round(Number(msg.playerId));
        const player = state.players.find((p) => p.id === playerId);
        if (!player) return;
        if (msg.action === "add") {
          const existing = state.geneMarks[playerId];
          if (existing && existing.round === state.round) return; // already marked this round
          if (player.health <= 0) return; // a Shadow gains nothing here either
          const statsBefore = { ...player.stats };
          player.stats.power = (player.stats.power || 0) + 1;
          player.stats.speed = (player.stats.speed || 0) + 1;
          player.stats.weight = (player.stats.weight || 0) + 1;
          state.geneMarks[playerId] = { round: state.round, statsBefore };
          addPlayerLog(state, playerId, {
            round: state.round,
            source: "gene201",
            detail: {},
            room: "201",
            healthBefore: player.health,
            healthAfter: player.health,
            healthDelta: 0,
            statDeltas: { power: 1, speed: 1, weight: 1 },
          });
        } else if (msg.action === "remove") {
          const mark = state.geneMarks[playerId];
          if (!mark || mark.round !== state.round) return;
          player.stats = { ...mark.statsBefore };
          delete state.geneMarks[playerId];
          const logs = state.playerLogs[String(playerId)];
          if (logs) {
            const idx = logs.findIndex((e) => e.round === state.round && e.source === "gene201");
            if (idx !== -1) logs.splice(idx, 1);
          }
        } else {
          return;
        }
        break;
      }
      // B304 (操作室)'s "可立即重新分配自己的基因点数" -- same fixed 10-point
      // pool as the player's own initial allocation (see
      // clampPlayerStats/user:setStats), just triggered mid-game via admin
      // dragging them into the room, since user:setStats itself only
      // accepts edits during prep. A full reallocation, not a delta, so
      // there's no "undo" state to track like laserMarks/geneMarks above --
      // just logged (as whatever the net stat deltas end up being) for the
      // audit trail.
      case "admin:reallocatePlayerStats": {
        if (state.phase !== "in_progress") return;
        if (state.settlementDraft && state.settlementDraft.round === state.round) return;
        const playerId = Math.round(Number(msg.playerId));
        const player = state.players.find((p) => p.id === playerId);
        if (!player) return;
        if (player.health <= 0) return; // a Shadow has no gene points left to reallocate
        // Unlike the player's own initial allocation (clampPlayerStats),
        // B304's reallocation isn't bound by the normal 10-point pool --
        // only non-negative integers are enforced here.
        const newStats = clampAdminStats(msg.stats);
        const statDeltas = {};
        for (const id of STAT_IDS) {
          if (newStats[id] !== player.stats[id]) statDeltas[id] = newStats[id] - player.stats[id];
        }
        if (Object.keys(statDeltas).length) {
          addPlayerLog(state, playerId, {
            round: state.round,
            source: "b304",
            detail: {},
            room: "B304",
            healthBefore: player.health,
            healthAfter: player.health,
            healthDelta: 0,
            statDeltas,
          });
        }
        player.stats = newStats;
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
        refreshUncommittedSections(draft, state);
        break;
      }
      // Undoing section N also un-commits everything after it (see
      // cascadeUndoFrom) -- their commits were computed against a `working`
      // snapshot N's own commit has now changed, so leaving them standing
      // would silently drift from what admin actually undid.
      case "admin:settlementUndoSection": {
        const draft = state.settlementDraft;
        if (!draft || draft.round !== state.round) return;
        const sec = draft.sections[msg.section];
        if (!sec || !sec.committed) return;
        cascadeUndoFrom(draft, state, msg.section);
        refreshUncommittedSections(draft, state);
        break;
      }
      // Resets this section back to its freshly-auto-computed state — undoes
      // the commit first if needed (cascading through anything after it, same
      // as settlementUndoSection), then discards any manual overrides.
      case "admin:settlementResetSection": {
        const draft = state.settlementDraft;
        if (!draft || draft.round !== state.round) return;
        const sec = draft.sections[msg.section];
        if (!sec) return;
        if (sec.committed) cascadeUndoFrom(draft, state, msg.section);
        refreshUncommittedSections(draft, state);
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
          // Whichever section actually pushed them below 0 already clamped
          // wp.health to exactly -reviveThreshold immediately (see the
          // healthDeltas-apply loop in commitSectionEffect) -- this is now
          // just a defensive re-assert of that same value, plus the one
          // thing that's still finishSettlement-only: moving them to the
          // Morgue (B701 停尸间), since mid-settlement sections may still
          // need their real room (e.g. a rocket target check).
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
        state.chemistAction = null;
        state.laserMarks = {};
        state.geneMarks = {};
        state.b101VoteBoosts = [];
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
