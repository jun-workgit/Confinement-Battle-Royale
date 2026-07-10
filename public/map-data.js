// Floor bands (top/height are % of the map image), matching the source artwork's layout.
const FLOORS = [
  { id: "2", label: "2", top: 5.6, height: 13.0 },
  { id: "1", label: "1", top: 18.1, height: 10.0 },
  { id: "B1", label: "B1", top: 27.68, height: 10.3 },
  { id: "B2", label: "B2", top: 37.79, height: 9.9 },
  { id: "B3", label: "B3", top: 47.66, height: 9.9 },
  { id: "B4", label: "B4", top: 57.36, height: 9.9 },
  { id: "B5", label: "B5", top: 67.3, height: 9.9 },
  { id: "B6", label: "B6", top: 77.17, height: 9.55 },
  { id: "B7", label: "B7", top: 86.75, height: 10.47 },
];

const ROOM_LABELS = {
  "101": "101 水塔", "201": "201 基因库", "202": "202 停机坪", "102": "102 激光室",
  "103": "103", "104": "104", "B101": "B101 控制室", "B102": "B102", "B103": "B103",
  "B104": "B104", "B105": "B105 回收站", "B106": "B106", "B107": "B107 武器库",
  "B201": "B201", "B202": "B202 手术室", "B203": "B203", "B204": "B204 餐厅",
  "B205": "B205", "B206": "B206 金库", "B301": "B301 药房", "B302": "B302",
  "B303": "B303", "B304": "B304 操作室", "B305": "B305", "B306": "B306",
  "B307": "B307", "B308": "B308", "B501": "B501 大仓库", "B401": "B401",
  "B402": "B402", "B403": "B403 传送室", "B404": "B404", "B405": "B405 粮仓",
  "B502": "B502", "B503": "B503 垃圾场", "B504": "B504", "B505": "B505 粮仓",
  "B601": "B601 酒窖", "B602": "B602", "B603": "B603", "B604": "B604",
  "B701": "B701 停尸间", "Bridge": "廊桥", "Tunnel": "竖井",
};

// English room labels — only ever read when the player view is switched to
// English (getRoomLabel below). Untranslated numeric-only rooms keep their
// number as-is; named rooms keep the Chinese name bracketed as a keyword.
const ROOM_LABELS_EN = {
  "101": "101 Water Tower (水塔)", "201": "201 Gene Bank (基因库)", "202": "202 Helipad (停机坪)", "102": "102 Laser Room (激光室)",
  "103": "103", "104": "104", "B101": "B101 Control Room (控制室)", "B102": "B102", "B103": "B103",
  "B104": "B104", "B105": "B105 Recycling Station (回收站)", "B106": "B106", "B107": "B107 Armory (武器库)",
  "B201": "B201", "B202": "B202 Surgery Room (手术室)", "B203": "B203", "B204": "B204 Cafeteria (餐厅)",
  "B205": "B205", "B206": "B206 Vault (金库)", "B301": "B301 Pharmacy (药房)", "B302": "B302",
  "B303": "B303", "B304": "B304 Ops Room (操作室)", "B305": "B305", "B306": "B306",
  "B307": "B307", "B308": "B308", "B501": "B501 Grand Warehouse (大仓库)", "B401": "B401",
  "B402": "B402", "B403": "B403 Teleport Room (传送室)", "B404": "B404", "B405": "B405 Granary (粮仓)",
  "B502": "B502", "B503": "B503 Junkyard (垃圾场)", "B504": "B504", "B505": "B505 Granary (粮仓)",
  "B601": "B601 Wine Cellar (酒窖)", "B602": "B602", "B603": "B603", "B604": "B604",
  "B701": "B701 Morgue (停尸间)", "Bridge": "Bridge (廊桥)", "Tunnel": "Shaft (竖井)",
};

// Falls back to Chinese for any caller that doesn't pass a lang (public/admin
// views), so this is safe to use as a drop-in replacement for ROOM_LABELS[id].
function getRoomLabel(roomId, lang) {
  const labels = lang === "en" ? ROOM_LABELS_EN : ROOM_LABELS;
  return labels[roomId] || roomId;
}

// Room rules text shown in the info popup. Rooms not listed here just get a
// "no special effect" fallback.
const ROOM_INFO = {
  "201": "三项属性各永久+1，并可立即查看所有玩家当前的基因面板。",
  "202": `不受"毒气"伤害；下一轮可消耗1步搭乘直升机前往B101、101、B103、201、B105；
每轮会空投一次物资，物资会累积，玩家进入后可在当前所有物资中任选其一，先到先得；若此地有之前丢弃的道具卡，则玩家可额外从中选择任意数量获得，但不可超过自身负重。

第一轮空投物资：2刀
第二轮空投物资：2酒
第三轮空投物资：1水1粮
第四轮空投物资：1手枪
第五轮空投物资：1肾上腺素
第六轮空投物资：1药片`,
  "101": "抽取最多4张道具卡，初始库存：10水。",
  "102": "经过或停留在该房间将立即扣除1点生命值。",
  "B101": `可在以下两种功能中选择一个使用：
1. 在本轮"毒气"投票中1票视为10票。
2. 选择一个"毒气"房间永久"解毒"，"解毒"会立即生效且不会被公示，从当轮开始，停留在该房间的玩家均不受"毒气"伤害。`,
  "B105": "经过该房间的玩家，可消耗一步通过垃圾管道单向滑行至B503垃圾场。",
  "B107": "抽取最多2张道具卡，初始库存：5刀、2手枪、1霰弹枪。",
  "B202": "若有1人，则无事发生；若有2人，则会进行手术，结算阶段每人生命值+4；若有2人以上，则不会进行手术，直接触发乱斗。",
  "B204": "本轮结算阶段无需上交水粮。",
  "B206": "抽取最多2张道具卡，初始库存：4金条。",
  "B301": "抽取最多2张道具卡，初始库存：3药片、3肾上腺素。",
  "B304": "可立即重新分配自己的基因点数。",
  "B403": "经过该房间可消耗1步将自己传送至任意一个普通房间。",
  "B501": `抽取最多3张道具卡，初始库存：5水、5粗粮、3刀、2酒、2药片、2肾上腺素、1手枪、1金条、1霰弹枪。
当B4和B5都成为"毒气"楼层，该房间才会成为"毒气"区域。`,
  "B503": `抽取最多5张道具卡，且无法使用金条。若一次性抽到2张以上非垃圾道具卡，则只能从中挑选最多2张获得。
初始库存：20垃圾、1绳索、1防毒面具、1火箭筒、1次元口袋、1循环回收装置。`,
  "B505": "抽取最多4张道具卡，初始库存：10粮。",
  "B601": "抽取最多2张道具卡，初始库存：6酒。",
  "B701": "抽取最多3张道具卡，库存：本轮前所有\"死亡\"玩家的道具卡。",
};

// English room info — same keys as ROOM_INFO. Only read for the player view
// when switched to English; public/admin views always get the Chinese text.
const ROOM_INFO_EN = {
  "201": "All three stats each permanently +1, and you may immediately view every player's current gene panel (基因面板).",
  "202": `Immune to "Poison Gas (毒气)" damage; next round you may spend 1 step to take the helicopter to B101, 101, B103, 201, B105;
Each round an airdrop resupply occurs and accumulates. On entering, a player may pick any one item from all current supplies, first come first served; if there are previously discarded item cards here, the player may also take any number of them for free, up to their own Capacity (负重) limit.

Round 1 airdrop: 2x Knife
Round 2 airdrop: 2x Wine
Round 3 airdrop: 1x Water, 1x Food
Round 4 airdrop: 1x Pistol
Round 5 airdrop: 1x Adrenaline (肾上腺素)
Round 6 airdrop: 1x Pill`,
  "101": "Draw up to 4 item cards (道具卡); starting stock: 10x Water.",
  "102": "Passing through or stopping in this room immediately deducts 1 Health.",
  "B101": `Choose one of the following two effects:
1. In this round's "Poison Gas (毒气)" vote, your 1 vote counts as 10 votes.
2. Permanently "Detox (解毒)" one poison-gas room. Detox takes effect immediately and is not publicly announced. From this round on, players staying in that room are immune to poison-gas damage.`,
  "B105": "A player passing through this room may spend 1 step to slide one-way through the garbage chute to B503 Junkyard (垃圾场).",
  "B107": "Draw up to 2 item cards; starting stock: 5x Knife, 2x Pistol, 1x Shotgun.",
  "B202": "With 1 person, nothing happens. With 2 people, surgery is performed: both gain +4 Health at the settlement phase. With more than 2 people, no surgery occurs and it triggers a brawl (乱斗) instead.",
  "B204": "No need to hand in Water/Food this round's settlement phase.",
  "B206": "Draw up to 2 item cards; starting stock: 4x Gold Bar (金条).",
  "B301": "Draw up to 2 item cards; starting stock: 3x Pill, 3x Adrenaline (肾上腺素).",
  "B304": "May immediately reallocate your own gene points (基因点数).",
  "B403": "Passing through this room, you may spend 1 step to teleport yourself to any regular room.",
  "B501": `Draw up to 3 item cards; starting stock: 5x Water, 5x Coarse Grain, 3x Knife, 2x Wine, 2x Pill, 2x Adrenaline (肾上腺素), 1x Pistol, 1x Gold Bar (金条), 1x Shotgun.
This room only becomes a "Poison Gas (毒气)" zone once both B4 and B5 are poison-gas floors.`,
  "B503": `Draw up to 5 item cards, and Gold Bars (金条) cannot be used here. If you draw more than 2 non-junk item cards at once, you may keep at most 2 of them.
Starting stock: 20x Junk, 1x Rope, 1x Gas Mask, 1x Rocket Launcher, 1x Dimensional Pocket, 1x Recycler.`,
  "B505": "Draw up to 4 item cards; starting stock: 10x Food.",
  "B601": "Draw up to 2 item cards; starting stock: 6x Wine.",
  "B701": `Draw up to 3 item cards; stock: the item cards of all players who "died" (死亡) before this round.`,
};

// Shows a room's rules text in a modal. Shared by the player and public maps
// (not the admin map, where a room click is a drag-drop target instead).
// `lang` defaults to Chinese so public/admin callers are unaffected.
function showRoomInfo(roomId, lang) {
  const title = getRoomLabel(roomId, lang);
  const infoMap = lang === "en" ? ROOM_INFO_EN : ROOM_INFO;
  const body = infoMap[roomId] || (lang === "en" ? "No room description available yet." : "暂无房间说明。");
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-card room-info">
      <div class="modal-title">${title}</div>
      <div class="modal-body-text">${body}</div>
      <div class="modal-actions">
        <button class="btn room-info-close">${lang === "en" ? "Close" : "关闭"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  function close() { document.body.removeChild(overlay); }
  overlay.querySelector(".room-info-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

const ROOMS_RAW = [
  { id: "201", left: 27.42, top: 8.22, width: 18.67, height: 10.41 },
  { id: "102", left: 27.42, top: 18.63, width: 18.67, height: 9.05 },
  { id: "B104", left: 27.42, top: 27.68, width: 18.67, height: 10.23 },
  { id: "B103", left: 22.29, top: 28.21, width: 5.13, height: 9.7 },
  { id: "101", left: 16.21, top: 18.27, width: 6.08, height: 9.93 },
  { id: "B102", left: 16.21, top: 27.97, width: 6.08, height: 9.93 },
  { id: "B101", left: 8.92, top: 28.21, width: 7.29, height: 9.7 },
  { id: "B105", left: 46.08, top: 27.85, width: 11.29, height: 9.93 },
  { id: "103", left: 68.79, top: 18.15, width: 7.33, height: 9.82 },
  { id: "104", left: 76.13, top: 18.15, width: 14.75, height: 9.82 },
  { id: "B106", left: 72.29, top: 27.97, width: 7.58, height: 9.93 },
  { id: "B107", left: 79.88, top: 27.97, width: 11, height: 9.82 },
  { id: "202", left: 67.5, top: 10.11, width: 23.38, height: 8.16 },
  { id: "Bridge", left: 57.38, top: 27.85, width: 15, height: 10.05 },
  { id: "Tunnel", left: 54.21, top: 35.9, width: 2.21, height: 40.15 },
  { id: "Bridge", left: 53.5, top: 52.1, width: 15.21, height: 5.38 },
  { id: "B206", left: 68.58, top: 37.91, width: 22.29, height: 9.76 },
  { id: "B306", left: 68.63, top: 47.66, width: 5, height: 9.82 },
  { id: "B307", left: 73.63, top: 47.66, width: 9.96, height: 9.7 },
  { id: "B308", left: 83.5, top: 47.66, width: 7.38, height: 9.7 },
  { id: "B205", left: 46.08, top: 37.79, width: 7.54, height: 9.76 },
  { id: "B204", left: 38.58, top: 37.91, width: 7.5, height: 9.64 },
  { id: "B203", left: 27.42, top: 37.91, width: 11.08, height: 9.64 },
  { id: "B202", left: 19.88, top: 38.02, width: 7.5, height: 9.52 },
  { id: "B201", left: 8.88, top: 37.91, width: 11.04, height: 9.64 },
  { id: "B301", left: 8.92, top: 47.72, width: 7.38, height: 9.88 },
  { id: "B302", left: 16.29, top: 47.72, width: 7.42, height: 9.88 },
  { id: "B303", left: 23.79, top: 47.72, width: 7.33, height: 9.76 },
  { id: "B304", left: 31.13, top: 47.72, width: 7.58, height: 9.76 },
  { id: "B305", left: 38.71, top: 47.72, width: 14.92, height: 9.76 },
  { id: "B405", left: 83.5, top: 57.36, width: 7.38, height: 10.05 },
  { id: "B404", left: 76.08, top: 57.48, width: 7.42, height: 9.93 },
  { id: "B403", left: 68.63, top: 57.6, width: 7.46, height: 9.7 },
  { id: "B402", left: 46.08, top: 57.6, width: 7.42, height: 9.93 },
  { id: "B401", left: 31.13, top: 57.6, width: 14.88, height: 9.93 },
  { id: "B501", left: 8.88, top: 57.6, width: 22.33, height: 19.63 },
  { id: "B502", left: 31.21, top: 67.53, width: 11.21, height: 9.7 },
  { id: "B503", left: 42.38, top: 67.53, width: 14.83, height: 9.7 },
  { id: "B504", left: 68.63, top: 67.3, width: 11.29, height: 9.88 },
  { id: "B505", left: 79.92, top: 67.42, width: 10.96, height: 9.64 },
  { id: "B604", left: 68.71, top: 77.17, width: 11.08, height: 9.58 },
  { id: "B603", left: 57.21, top: 77.35, width: 11.5, height: 9.4 },
  { id: "B601", left: 27.71, top: 77.35, width: 18.5, height: 9.34 },
  { id: "B602", left: 46.13, top: 77.35, width: 11.17, height: 9.4 },
  { id: "B701", left: 46.13, top: 86.75, width: 11.17, height: 10.47 },
];

const ROOMS = ROOMS_RAW.map((r) => ({ ...r, label: ROOM_LABELS[r.id] || r.id }));

// Bridge and Tunnel are walkways, not rooms — no meeple may be placed there.
const TRANSIT_ROOM_IDS = ["Bridge", "Tunnel"];
const STOPPABLE_ROOM_IDS = [...new Set(ROOMS.map((r) => r.id))].filter((id) => !TRANSIT_ROOM_IDS.includes(id));

const STAT_DEFS = [
  { id: "power", label: "武力值", labelEn: "Power (武力)", valuePrefix: "武力: ", valuePrefixEn: "Power: ", icon: "💪" },
  { id: "speed", label: "速度值", labelEn: "Speed (速度)", valuePrefix: "剩余步数: ", valuePrefixEn: "Steps Left: ", icon: "🏃" },
  { id: "weight", label: "负重值", labelEn: "Capacity (负重)", valuePrefix: "负重: ", valuePrefixEn: "Capacity: ", icon: "💼" },
];
const STAT_POINTS_TOTAL = 10;
const DEFAULT_HEALTH = 10;

// A player's stats aren't "ready" until all gene points are allocated AND
// every stat has at least 1 point — an all-in build (e.g. 10/0/0) isn't
// allowed. Shared by the player view (readiness tag/tab dot) and the admin
// table (readiness column) so both agree on the same rule.
function isStatsReady(stats) {
  const sum = STAT_DEFS.reduce((s, d) => s + (stats[d.id] || 0), 0);
  return sum >= STAT_POINTS_TOTAL && STAT_DEFS.every((d) => (stats[d.id] || 0) >= 1);
}

// Rooms players may pick as their starting position during the prep phase.
const SPAWN_ROOM_IDS = ["B103", "B303", "B402", "B603", "103", "B307"];

// Reference-only table of poison damage per round, shown to players/public.
// Nothing in the app deducts this automatically — it's just informational,
// admin applies it manually via the stats editor. Editable by admin only
// during phase 1 (setup), before a game is created.
const DEFAULT_POISON_DAMAGE_TABLE = [
  { round: 1, damage: 1 },
  { round: 2, damage: 2 },
  { round: 3, damage: 2 },
  { round: 4, damage: 3 },
  { round: 5, damage: 3 },
  { round: 6, damage: 4 },
];

// Shared row markup for the poison damage table, used by the small public
// corner box and the larger dedicated tab views alike. `lang` defaults to
// Chinese so public/admin callers are unaffected.
function poisonDamageRows(table, currentRound, lang) {
  const en = lang === "en";
  return table
    .map((row) => `<tr class="${row.round === currentRound ? "current" : ""}"><td>${en ? `Round ${row.round}` : `第 ${row.round} 回合`}</td><td>-${row.damage} ${en ? "Health" : "生命"}</td></tr>`)
    .join("");
}

const GAME_RULES_SECTIONS = [
  {
    id: "bg",
    title: "(一) 背景与目标",
    titleEn: "(1) Background & Objective",
    text: `M星球气候异变，地表温度骤降，星球居民被迫转移到地下城生存，能源出现了供不应求的局面。地下城各个区域为了争取能源，每年都会派一名代表前往中心区进行一场虚拟战斗，获胜者可为本区赢得一整年的充足能源。
本场游戏，玩家作为地下城各个分区的代表，需在两栋建筑物中秘密移动，争夺物资，用各种策略削减他人的生命值，游戏结束时生命值最高的玩家获胜。`,
    textEn: `Planet M's climate has shifted violently: surface temperatures have plunged, forcing its people underground into subterranean cities, where energy is now in short supply. Each year, every district of the underground city sends one representative to the central zone for a virtual battle; the winner secures a full year of ample energy for their district.
In this game, players represent the various districts of the underground city and must move secretly between two buildings, competing for resources and using strategy to reduce other players' Health, until the player with the highest Health at the end wins.`,
  },
  {
    id: "init",
    title: "(二) 初始属性",
    titleEn: "(2) Starting Stats",
    text: `每位玩家初始有10点生命值。生命值上限为10，生命值为0时，可以暗影的身份继续游戏(详见暗影机制)。
每位玩家初始有10点基因。10点基因需分配至武力、速度和负重三项属性。

武力：决定攻击力及战斗结果(详见战斗机制)；速度：决定移动步数(详见移动机制)；负重：决定可携带的道具卡数量(详见负重机制)。
游戏开始前，玩家自行分配基因点数，组成自己的基因面板，点数需全部用完。然后每位玩家秘密选择自己的出生房间。

2.1 战斗机制
若有2名玩家停留在同一房间，将触发战斗；若大于2名玩家停留在同一房间，将触发乱斗。武力值最高的玩家生命值不变，其余玩家将扣除与该玩家武力之差的等量生命值。触发战斗或乱斗的房间会被公示。

2.2 移动机制
玩家以上一轮所在房间为起点，移动至步数范围内的其他房间，相邻的房间需消耗1步，不同楼层需要通过楼梯上下，不同楼栋需要通过廊桥或搭乘直升机前往。每轮每个玩家必须移动，步数可以不用完，未使用的步数不会累积至下一轮。

2.3 负重机制
所有道具卡都需要负重才能携带，1张道具卡占用1点负重，除自由阶段外，玩家不能携带超过自身负重的道具卡。`,
    textEn: `Each player starts with 10 Health. The Health cap is 10; at 0 Health, you may continue playing as a "Shadow (暗影)" (see the Shadow Mechanic below).
Each player starts with 10 Gene Points (基因), which must be allocated across three stats: Power (武力), Speed (速度), and Capacity (负重).

Power: determines attack strength and combat outcomes (see Combat Mechanic). Speed: determines movement steps (see Movement Mechanic). Capacity: determines how many item cards (道具卡) you may carry (see Capacity Mechanic).
Before the game starts, each player allocates their own gene points to build their gene panel; all points must be used. Then each player secretly chooses their spawn room.

2.1 Combat Mechanic
If 2 players end up in the same room, combat is triggered; if more than 2 players end up in the same room, a brawl (乱斗) is triggered. The player with the highest Power keeps their Health unchanged; every other player loses Health equal to the difference between their Power and the highest Power. Any room where combat or a brawl occurs is publicly announced.

2.2 Movement Mechanic
Each player starts from the room they were in last round and moves to another room within their step range. Moving to an adjacent room costs 1 step; moving between floors requires stairs; moving between the two buildings requires the bridge (廊桥) or the helicopter. Every player must move each round, though steps don't have to be fully used; unused steps do not carry over to the next round.

2.3 Capacity Mechanic
Every item card requires 1 Capacity to carry. Except during the Free Phase, a player may never carry more item cards than their Capacity allows.`,
  },
  {
    id: "flow",
    title: "(三) 游戏流程",
    titleEn: "(3) Game Flow",
    text: `游戏共{{TOTAL_ROUNDS}}轮，每轮分为自由阶段、行动阶段和结算阶段。

3.1 自由阶段
玩家将随机抽取一张顺位卡，决定当轮【行动阶段】的行动顺序，随后可分享信息、制定策略，并进行顺位卡和道具卡的交易，卡牌交易仅限在自由阶段进行，若持有的道具卡数量超过自身负重，则需要该阶段结束时调整至负重范围内。

3.2 行动阶段
玩家按照顺位卡的顺序依次进入行动室，以上一轮所在房间为起点，移动至步数范围内的其他房间。移动完毕后，可进行相应行动，如使用房间的特殊功能，抽取、使用和丢弃道具卡。不同道具卡的效果不同，抽取道具卡后，需将持有的道具卡数量调整至负重范围内，多出的道具卡将丢弃在该房间。玩家可自主丢弃任意数量的道具卡，但只能在可抽卡的房间进行。
随后，玩家需选择一个楼层投票，票数最高的楼层将成为"毒气"楼层，若平票最高，则均成为"毒气"楼层，若已成为"毒气"楼层，不能重复被投，"毒气"不会自行消散。每轮停留在"毒气"楼层的玩家将在结算阶段扣除相应的生命值，{{POISON_SCHEDULE}}
行动结束的玩家将进入会议室等候，无法与未行动的玩家交换信息。

3.3 结算阶段
每轮将按照以下流程，公示本轮行动信息，并对相关玩家的生命值进行秘密结算。
结算阶段公知信息：
1.手术室是否进行手术；
2.哪些房间发生战斗、乱斗或暗影与人相遇事件；
3.哪个楼层成为"毒气"楼层；
4.第二轮开始，为抵抗饥饿，玩家需上交1水1粮道具卡。若只上交其一，则会扣除1点生命值，都未上交则会扣除2点生命值。
5.火箭筒袭击了哪个房间；
6.是否有玩家要使用药片、酒、肾上腺素道具卡改变自身状态；
7.哪些暗影玩家复活？
最后，将公示所有玩家的当前生命值。

若在任意结算流程中，有玩家的生命值归0，则会公示其成为"暗影"。"暗影"玩家需立即上交所有道具卡，该道具卡将会自动进入停尸间。"暗影"玩家下一轮将会从停尸间出发继续游戏。`,
    textEn: `The game lasts {{TOTAL_ROUNDS}} rounds total; each round has a Free Phase, an Action Phase, and a Settlement Phase.

3.1 Free Phase
Each player randomly draws an order card (顺位卡), which determines their turn order in this round's Action Phase. Players may then share information, plan strategy, and trade order cards and item cards; trading is only allowed during the Free Phase. If you hold more item cards than your Capacity allows, you must adjust down to your Capacity limit by the end of this phase.

3.2 Action Phase
Players enter the action room one at a time in order-card sequence, starting from the room they were in last round and moving to another room within step range. After moving, they may take the room's relevant action, such as using the room's special function, or drawing, using, or discarding item cards. Different item cards have different effects; after drawing an item card, you must adjust your held item cards down to your Capacity limit; any excess is discarded in that room. Players may voluntarily discard any number of item cards, but only in a room where drawing is allowed.
Afterward, each player votes for one floor; the floor with the most votes becomes a "Poison Gas (毒气)" floor. In a tie for most votes, all tied floors become poison-gas floors. A floor already marked as poison gas cannot be voted again, and poison gas never dissipates on its own. Any player who stays on a poison-gas floor loses the corresponding Health at the Settlement Phase. {{POISON_SCHEDULE}}
Once a player finishes their action, they move to the meeting room to wait, and can no longer exchange information with players who haven't acted yet.

3.3 Settlement Phase
Each round follows this process: publicly announce this round's action information, then secretly settle the relevant players' Health.
Publicly known information at Settlement:
1. Whether surgery took place in the Surgery Room (手术室);
2. Which rooms had combat, a brawl, or a Shadow (暗影) encountering a living player;
3. Which floor became the "Poison Gas (毒气)" floor;
4. From round 2 onward, to fend off hunger, players must hand in 1 Water + 1 Food item card. Handing in only one of them costs 1 Health; handing in neither costs 2 Health;
5. Which room the Rocket Launcher struck;
6. Whether any player used a Pill, Wine, or Adrenaline (肾上腺素) item card to change their state;
7. Which Shadow players revived.
Finally, every player's current Health is publicly announced.

If any player's Health drops to 0 during any settlement step, they are publicly announced as a "Shadow (暗影)". A Shadow player must immediately hand over all their item cards, which are automatically sent to the Morgue (停尸间). A Shadow player continues the game from the Morgue starting next round.`,
  },
  {
    id: "shadow",
    title: "(四) 暗影机制",
    titleEn: "(4) Shadow (暗影) Mechanic",
    text: `"暗影"初始生命值为0，没有负重和武力，只会继承"死亡"时的速度，可不需楼梯上下楼，进入房间后无法使用房间功能和抽取道具卡，无法参与"毒气"投票。当然，也不计入房间人数，不参与战斗或乱斗，不受"毒气"伤害，不需上交水粮。若"暗影"玩家和存活玩家同处一室，每个存活玩家均会被每个暗影吸取1点生命值。当暗影玩家吸取累计大于等于2点生命值后，他将在当轮结算阶段最后复活，下一轮从复活房间继续游戏，基因面板恢复至生前状态，复活后的第一轮依然不受"毒气"伤害，不需上交水粮。`,
    textEn: `A "Shadow" starts with 0 Health, has no Capacity or Power, and only inherits the Speed they had at the moment of "death" (死亡). A Shadow doesn't need stairs to move between floors, cannot use room functions or draw item cards upon entering a room, and cannot vote on "Poison Gas (毒气)". A Shadow also doesn't count toward room occupancy, doesn't take part in combat or brawls, is immune to poison-gas damage, and doesn't need to hand in Water/Food. If a Shadow shares a room with a living player, every living player there loses 1 Health absorbed by each Shadow present. Once a Shadow has absorbed 2 or more Health in total, they revive at the end of that round's Settlement Phase, continuing next round from the room where they revived, with their gene panel restored to its pre-death state. In the first round after reviving, they are still immune to poison-gas damage and don't need to hand in Water/Food.`,
  },
  {
    id: "victory",
    title: "(五) 胜利条件",
    titleEn: "(5) Victory Conditions",
    text: `{{TOTAL_ROUNDS}}轮游戏结束后，首先结算玩家手中的金条，1金条可兑换1点生命值。最后，根据玩家的剩余生命值进行排名，"暗影"玩家排名在存活玩家之后。若存活玩家生命值相同，则比较武力；"暗影"玩家之间比较生前武力，武力高的玩家排名靠前。若任意轮次中只剩1名玩家存活，则该玩家直接获胜，游戏立即结束。若游戏中途所有玩家都成为"暗影"，则根据各自生前一轮的生命值进行排名。玩家按照排名先后分别获得9-1个金魔方积分！`,
    textEn: `After {{TOTAL_ROUNDS}} rounds, Gold Bars (金条) held by players are settled first: 1 Gold Bar converts to 1 Health. Finally, players are ranked by remaining Health, with "Shadow (暗影)" players ranked below living players. If living players are tied on Health, Power breaks the tie; among Shadow players, Power at the moment of death breaks the tie, with higher Power ranking higher. If at any point only 1 player remains alive, that player wins immediately and the game ends at once. If all players become Shadows at some point, ranking is based on each player's Health from the round before they became a Shadow. Players receive 9 down to 1 Gold Cube points (金魔方积分) based on final rank!`,
  },
  {
    id: "summary",
    title: "(六) 思路总结",
    titleEn: "(6) Strategy Summary",
    text: `提前规划行动路线，合理分配基因点数，根据公示信息推测其他玩家位置，预判其他玩家的行动。通过收集、交易关键物资确保自己生存，同时通过武力、"毒气"或道具等手段，削减其他玩家生命值。`,
    textEn: `Plan your movement route ahead of time, allocate gene points wisely, use publicly announced information to infer other players' locations, and anticipate their moves. Secure your own survival by collecting and trading key resources, while using Power, "Poison Gas (毒气)", or items to reduce other players' Health.`,
  },
  {
    id: "items",
    title: "(七) 道具卡介绍",
    titleEn: "(7) Item Cards (道具卡)",
    text: `1.水：消耗品，第二轮开始，结算阶段公开使用，可抵抗部分饥饿
2.粮食：消耗品，第二轮开始，结算阶段公开使用，可抵抗部分饥饿
3.药片：消耗品，结算阶段公开使用，生命值+2
4.肾上腺素：消耗品，结算阶段公开使用，下一轮速度变为10，且无论受到多少伤害，生命值最多扣除至1点不会死亡，下一轮结算阶段后恢复原速度
5.酒：消耗品，结算阶段公开使用，可获得一次投掷骰子的机会，根据点数立即执行相应结果。(1:丢弃所有道具卡。2:无事发生。3:武力永久+1。4:速度永久+1。5:负重永久+1。6:生命值+2)
6.金条：消耗品，抽取道具卡时使用，可直接检视所在房间当前所有道具卡并额外选择一张获得，但不可选择金条；最终结算时，1金条可兑换1点生命值，但兑换生命值不可超过上限
7.刀：持该道具卡的玩家武力+2
8.手枪：持该道具卡的玩家武力+2，若交战时对方无枪，则无需比较武力，对方直接扣除等同己方武力的生命值，若对方有枪，则按照普通战斗机制结算
9.霰弹枪：持该道具卡的玩家武力+4，若交战时对方无枪，则无需比较武力，对方直接扣除等同己方武力的生命值，若对方有枪，则按照普通战斗机制结算
10.绳索：持该道具卡的玩家可不需楼梯上下楼，但每层也需要消耗1步
11.防毒面具：持该道具卡的玩家不受"毒气"伤害
12.火箭筒：持该道具卡的玩家每轮行动阶段可选择一个房间发动袭击，结算时该房间内的每个玩家生命值-4
13.次元口袋：持该道具卡的玩家负重无上限
14.循环回收装置：每轮行动阶段，持该道具卡的玩家可从全场已消耗的道具卡中抽取一张获得，但不可超过负重
15.垃圾：没有任何效果
16.第一轮空投物资：该道具卡视为2刀，占1负重
17.第二轮空投物资：该道具卡视为2酒，占1负重
18.第三轮空投物资：该道具卡视为1水1粮，占1负重
19.第四轮空投物资：该道具卡视为1手枪
20.第五轮空投物资：该道具卡视为1肾上腺素
21.第六轮空投物资：该道具卡视为1药片`,
    textEn: `1. Water: consumable; from round 2 onward, used openly at the Settlement Phase to offset part of the hunger penalty
2. Food: consumable; from round 2 onward, used openly at the Settlement Phase to offset part of the hunger penalty
3. Pill: consumable; used openly at the Settlement Phase, +2 Health
4. Adrenaline (肾上腺素): consumable; used openly at the Settlement Phase; next round Speed becomes 10, and no matter how much damage is taken, Health cannot drop below 1 (won't die); Speed returns to normal after next round's Settlement Phase
5. Wine: consumable; used openly at the Settlement Phase for one dice roll, resolved immediately by the result (1: discard all item cards. 2: nothing happens. 3: Power permanently +1. 4: Speed permanently +1. 5: Capacity permanently +1. 6: Health +2)
6. Gold Bar (金条): consumable; used when drawing item cards to inspect all item cards currently in the room and take one extra (cannot choose another Gold Bar); at final settlement, 1 Gold Bar converts to 1 Health, but cannot exceed the Health cap
7. Knife: while held, Power +2
8. Pistol: while held, Power +2; if the opponent has no gun in combat, Power comparison is skipped and they lose Health equal to your Power directly; if they do have a gun, normal combat rules apply
9. Shotgun: while held, Power +4; if the opponent has no gun in combat, Power comparison is skipped and they lose Health equal to your Power directly; if they do have a gun, normal combat rules apply
10. Rope: while held, no stairs needed between floors, but each floor still costs 1 step
11. Gas Mask: while held, immune to "Poison Gas (毒气)" damage
12. Rocket Launcher: each round's Action Phase, may target one room for a strike; at settlement, every player in that room loses 4 Health
13. Dimensional Pocket: while held, no Capacity (负重) limit
14. Recycler: each round's Action Phase, may draw one item card from all item cards used up so far, up to your Capacity limit
15. Junk: no effect
16. Round 1 Airdrop Supply: counts as 2x Knife, takes 1 Capacity
17. Round 2 Airdrop Supply: counts as 2x Wine, takes 1 Capacity
18. Round 3 Airdrop Supply: counts as 1x Water + 1x Food, takes 1 Capacity
19. Round 4 Airdrop Supply: counts as 1x Pistol
20. Round 5 Airdrop Supply: counts as 1x Adrenaline (肾上腺素)
21. Round 6 Airdrop Supply: counts as 1x Pill`,
  },
  {
    // No text/textEn here — renderGameRules special-cases this id and calls
    // rolesReferenceListHtml() instead, which builds image+text cards at
    // render time from ROLES (roles-data.js), so this can't drift out of
    // sync with the actual role definitions.
    id: "roles",
    title: "(八) 职业介绍",
    titleEn: "(8) Roles (职业)",
  },
];

let activeRulesSection = GAME_RULES_SECTIONS[0].id;

const CN_NUMERALS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];
function toChineseNum(n) {
  return n >= 0 && n < CN_NUMERALS.length ? CN_NUMERALS[n] : String(n);
}

// Turns the admin's per-round poison table into the same prose style as the
// original rules text, e.g. "第一轮1点，第二、三轮2点，第四、五轮3点。"
function formatPoisonScheduleText(table) {
  const sorted = [...table].sort((a, b) => a.round - b.round);
  const groups = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.damage === row.damage && row.round === last.rounds[last.rounds.length - 1] + 1) {
      last.rounds.push(row.round);
    } else {
      groups.push({ damage: row.damage, rounds: [row.round] });
    }
  }
  const text = groups
    .map((g) => `第${g.rounds.map(toChineseNum).join("、")}轮${g.damage}点`)
    .join("，");
  return text ? text + "。" : "";
}

// English counterpart, e.g. "Round 1: 1pt; Rounds 2-3: 2pt."
function formatPoisonScheduleTextEn(table) {
  const sorted = [...table].sort((a, b) => a.round - b.round);
  const groups = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.damage === row.damage && row.round === last.rounds[last.rounds.length - 1] + 1) {
      last.rounds.push(row.round);
    } else {
      groups.push({ damage: row.damage, rounds: [row.round] });
    }
  }
  const text = groups
    .map((g) => {
      const label = g.rounds.length > 1 ? `Rounds ${g.rounds[0]}-${g.rounds[g.rounds.length - 1]}` : `Round ${g.rounds[0]}`;
      return `${label}: ${g.damage}pt`;
    })
    .join("; ");
  return text ? text + "." : "";
}

// A role description may have several blank-line-separated clauses in the
// source data; rendering that raw (white-space:pre-line) stacks up visible
// gaps. Splitting on any run of newlines and re-joining as individually
// tight lines gives consistent, compact spacing regardless of how many
// blank lines happen to be in the source string.
function roleDescLinesHtml(desc, lineClass) {
  return desc
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<div class="${lineClass}">${line}</div>`)
    .join("");
}

// Renders the "(八) 职业介绍" reference list as image-left/text-right cards,
// one per role actually in play this game (`roleIds` = state.selectedRoles)
// rather than the full roster — a 6-player game with 6 chosen roles only
// references those 6. Reads the global ROLES (roles-data.js); only ever
// called in-browser (never from server.js), so that's safe.
function rolesReferenceListHtml(lang, roleIds) {
  const en = lang === "en";
  const roles = (Array.isArray(roleIds) ? roleIds : []).map((id) => getRole(id)).filter(Boolean);
  if (!roles.length) {
    return `<div class="rules-box">${en ? "No roles are in play this game." : "本局未启用任何职业。"}</div>`;
  }
  return `
    <div class="rules-box role-rules-list">
      ${roles.map((r) => {
        const name = en ? r.nameEn : r.name;
        const skill = en ? r.skillEn : r.skill;
        const desc = en ? r.descriptionEn : r.description;
        return `
          <div class="role-rules-card">
            <img class="role-rules-img" src="${r.image}" alt="${name}">
            <div class="role-rules-body">
              <div class="role-rules-name">${name}</div>
              <div class="role-rules-skill">${skill}</div>
              ${roleDescLinesHtml(desc, "role-rules-desc-line")}
            </div>
          </div>`;
      }).join("")}
    </div>`;
}

// `state` is optional so the rules can still render before a game exists;
// falls back to the default table/round count in that case. `lang` defaults
// to Chinese so public/admin callers are unaffected. The "(八) 职业介绍" tab
// only appears at all when this game has roles enabled (same rule for every
// view — nothing to reference otherwise); `opts.hideRolesSection` drops it
// further, used only by the player view when the admin has turned off role
// visibility for players specifically.
function renderGameRules(container, state, lang, opts) {
  opts = opts || {};
  const en = lang === "en";
  const table = state && state.poisonDamageTable && state.poisonDamageTable.length ? state.poisonDamageTable : DEFAULT_POISON_DAMAGE_TABLE;
  const totalRounds = table.length ? Math.max(...table.map((r) => r.round)) : 6;
  const poisonSchedule = en ? formatPoisonScheduleTextEn(table) : formatPoisonScheduleText(table);

  const rolesActive = !!(state && state.rolesEnabled) && !opts.hideRolesSection;
  const sections = rolesActive ? GAME_RULES_SECTIONS : GAME_RULES_SECTIONS.filter((s) => s.id !== "roles");
  const current = sections.find((s) => s.id === activeRulesSection) || sections[0];

  const bodyHtml = current.id === "roles"
    ? rolesReferenceListHtml(en ? "en" : "zh", state.selectedRoles)
    : `<div class="rules-box">${(en ? current.textEn : current.text)
        .split("{{TOTAL_ROUNDS}}").join(String(totalRounds))
        .split("{{POISON_SCHEDULE}}").join(poisonSchedule)}</div>`;

  container.innerHTML = `
    <div class="card rules-card">
      <div class="rules-tabs">
        ${sections.map((s) => `<div class="rules-tab ${s.id === current.id ? "active" : ""}" data-rules-section="${s.id}">${en ? s.titleEn : s.title}</div>`).join("")}
      </div>
      ${bodyHtml}
    </div>
  `;
  container.querySelectorAll("[data-rules-section]").forEach((el) => {
    el.addEventListener("click", () => {
      activeRulesSection = el.dataset.rulesSection;
      renderGameRules(container, state, lang, opts);
    });
  });
}

// Alive players first, then by health descending within each group.
// Alive players rank above dead ones. Among the alive, sort by health, then
// power, then speed, then weight as tiebreakers. A dead player's "health" is
// really absorption debt, not a life total, so dead-vs-dead skips straight
// to power/speed/weight instead of comparing that number.
function rankPlayers(players) {
  return [...players].sort((a, b) => {
    const aDead = a.health <= 0, bDead = b.health <= 0;
    if (aDead !== bDead) return aDead ? 1 : -1;
    if (!aDead && a.health !== b.health) return b.health - a.health;
    if (a.stats.power !== b.stats.power) return b.stats.power - a.stats.power;
    if (a.stats.speed !== b.stats.speed) return b.stats.speed - a.stats.speed;
    return b.stats.weight - a.stats.weight;
  });
}

// Shared ranking table — used for both the live "排行榜" tab and the
// end-of-game result screen. `opts.lang` defaults to Chinese so public/admin
// callers are unaffected. `opts.showRoles` (pass `state.rolesEnabled`) adds a
// role column with each player's assigned role thumbnail + name.
//
// `opts.restricted` is the live (non-ended) player/public view: no rank
// order (players listed 1..N as-is, not by health), and Power/Speed/Capacity
// blanked out for every row except the viewer's own (`opts.meId`) — only
// Health is public knowledge mid-game. Admin callers never pass this, and
// no caller passes it for the end-of-game result screen, so both always see
// the full ranked/all-stats table.
function rankingTableHtml(players, opts) {
  opts = opts || {};
  const en = opts.lang === "en";
  const showRoles = !!opts.showRoles;
  const restricted = !!opts.restricted;
  const list = restricted ? players : rankPlayers(players);
  const rows = list.map((p, i) => {
    const dead = p.health <= 0;
    const img = dead ? "/assets/player-dead.png" : "/assets/player-alive.png";
    const healthText = dead ? `${en ? "Needs" : "需吸取"} ${Math.max(0, -p.health)}` : p.health;
    const isMe = opts.meId === p.id;
    const canSeeStats = !restricted || isMe;
    const statText = (v) => canSeeStats ? v : `<span class="stat-hidden">-</span>`;
    const role = showRoles ? getRole(p.roleId) : null;
    const roleCell = showRoles
      ? `<td>${role
          ? `<span class="ranking-role"><img src="${role.image}" alt="${en ? role.nameEn : role.name}">${en ? role.nameEn : role.name}</span>`
          : `<span class="ranking-role-none">${en ? "Unassigned" : "未分配"}</span>`}</td>`
      : "";
    return `
      <tr class="${isMe ? "me-row" : ""}">
        ${restricted ? "" : `<td class="leader-rank ${i === 0 && !dead ? "gold" : ""}">${i + 1}</td>`}
        <td><img class="ranking-avatar" src="${img}" alt="${dead ? (en ? "Shadow (暗影)" : "暗影") : (en ? "Alive" : "存活")}"></td>
        <td class="ranking-player-cell">${en ? "Player" : "玩家"} ${p.id}${isMe ? (en ? " (You)" : "（你）") : ""}</td>
        <td>${healthText}</td>
        <td>${statText(p.stats.power)}</td>
        <td>${statText(p.stats.speed)}</td>
        <td>${statText(p.stats.weight)}</td>
        ${roleCell}
      </tr>`;
  }).join("");
  const headers = [
    ...(restricted ? [] : [{ text: en ? "Rank" : "排名" }]),
    { text: "" }, // avatar column, header-less
    { text: en ? "Player" : "玩家", cellClass: "ranking-player-cell" },
    { text: en ? "Health" : "生命" },
    { text: en ? "Power" : "武力" },
    { text: en ? "Speed" : "速度" },
    { text: en ? "Capacity" : "负重" },
  ];
  if (showRoles) headers.push({ text: en ? "Role" : "职业" });
  return `
    <table class="stats-table ranking-table">
      <thead><tr>${headers.map((h) => `<th class="${h.cellClass || ""}">${h.text}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Assigns a stable, distinct color per room that has more than one player in
// it, so admin can visually match up which players are colliding where.
function assignRoomConflictColors(roomCounts) {
  const conflicted = Object.keys(roomCounts).filter((r) => roomCounts[r] > 1).sort();
  const colors = {};
  conflicted.forEach((room, i) => { colors[room] = meepleColor(i + 1); });
  return colors;
}

// Compact health/absorb bar for dense contexts like the admin table — same
// visual language as the player portrait bar but without the caption/margins.
function miniHealthBarHtml(health) {
  const dead = health <= 0;
  if (dead) {
    const need = Math.max(0, -health);
    const pct = Math.max(0, Math.min(100, ((2 - need) / 2) * 100));
    return `
      <div class="mini-bar-track absorb"><div class="mini-bar-thumb" style="left:${pct}%;"></div></div>
      <div class="mini-bar-caption dead">需吸取 ${need}</div>`;
  }
  const pct = Math.max(0, Math.min(100, (health / DEFAULT_HEALTH) * 100));
  return `<div class="mini-bar-track"><div class="mini-bar-thumb" style="left:${pct}%;"></div></div>`;
}

// Renders the map + floor labels + per-floor poison overlay into `container`.
// `poisonFloors` is an array of floor ids currently poisoned.
// `interactive: true` marks the floor chips as clickable (used by the admin poison control).
// `lang` defaults to Chinese so public/admin callers are unaffected.
function renderMap(container, poisonFloors, interactive, lang) {
  const poisoned = new Set(poisonFloors || []);
  container.innerHTML = `
    <div class="map-scroll">
    <div class="map-wrap ${interactive ? "interactive" : ""}">
      <div class="floor-col">
        ${FLOORS.map(
          (f) => `<div class="floor-chip ${poisoned.has(f.id) ? "poisoned" : ""}" data-floor="${f.id}" style="top:${f.top}%;height:${f.height}%;">
            <span>${f.label}</span>${poisoned.has(f.id) ? '<span class="skull">☠</span>' : ""}
          </div>`
        ).join("")}
      </div>
      <div class="map-img-wrap">
        <img class="map-img" src="/assets/map.png" alt="${lang === "en" ? "Confinement Battle Royale (禁闭逃杀) Map" : "禁闭逃杀 地图"}">
        ${FLOORS.map(
          (f) => `<div class="floor-overlay ${poisoned.has(f.id) ? "poisoned" : ""}" style="top:${f.top}%;height:${f.height}%;"></div>`
        ).join("")}
        ${ROOMS.map(
          (r) => `<div class="room" data-room-id="${r.id}" title="${getRoomLabel(r.id, lang)}" style="left:${r.left}%;top:${r.top}%;width:${r.width}%;height:${r.height}%;"></div>`
        ).join("")}
      </div>
    </div>
    </div>
  `;
}

const MEEPLE_COLORS = ["#d62839", "#2b8a3e", "#1971c2", "#e8590c", "#9c36b5", "#0c8599", "#f08c00", "#495057", "#e64980", "#5c940d"];
function meepleColor(playerId) {
  return MEEPLE_COLORS[(playerId - 1) % MEEPLE_COLORS.length];
}

// Draws one token per placed player on top of an already-rendered map. `wrapEl`
// is the `.map-img-wrap` element (from a container previously passed to
// renderMap). Players with no `room` are skipped — they belong in a tray, not
// on the board.
function renderMeeples(wrapEl, players) {
  if (!wrapEl) return;
  const old = wrapEl.querySelector(".meeple-layer");
  if (old) old.remove();

  const byRoom = {};
  for (const p of players) {
    if (!p.room) continue;
    (byRoom[p.room] = byRoom[p.room] || []).push(p);
  }

  const tokens = [];
  for (const roomId of Object.keys(byRoom)) {
    const room = ROOMS.find((r) => r.id === roomId);
    if (!room) continue;
    const cx = room.left + room.width / 2;
    const cy = room.top + room.height / 2;
    const group = byRoom[roomId];
    group.forEach((p, i) => {
      const dist = group.length > 1 ? 15 : 0;
      const angle = (i / group.length) * Math.PI * 2 - Math.PI / 2;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      tokens.push(`<div class="meeple" data-player-id="${p.id}" style="left:calc(${cx}% + ${dx}px);top:calc(${cy}% + ${dy}px);background:${meepleColor(p.id)};">${p.id}</div>`);
    });
  }

  const layer = document.createElement("div");
  layer.className = "meeple-layer";
  layer.innerHTML = tokens.join("");
  wrapEl.appendChild(layer);
  return layer;
}

if (typeof module !== "undefined") {
  module.exports = { FLOORS, ROOMS, ROOM_LABELS, STAT_DEFS, STAT_POINTS_TOTAL, DEFAULT_HEALTH, SPAWN_ROOM_IDS, TRANSIT_ROOM_IDS, STOPPABLE_ROOM_IDS, DEFAULT_POISON_DAMAGE_TABLE, meepleColor };
}
