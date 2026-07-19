// Optional "职业" (Role) system. A game may enable a fixed pool of roles
// (one per player) that admin assigns during prep. Purely additive to the
// core game state — nothing here is read unless state.rolesEnabled is true.
const ROLES = [
  {
    id: "wealthy",
    name: "富豪",
    nameEn: "Tycoon (富豪)",
    skill: "腰缠万贯",
    skillEn: "Loaded (腰缠万贯)",
    description: "你的金条不占负重。\n\n金库中的2张和大仓库中的1张金条归你初始所有。",
    descriptionEn: "Your Gold Bars (金条) don't take Capacity.\n\nYou start owning the 2 Gold Bars in the Vault (金库) and the 1 Gold Bar in the Grand Warehouse (大仓库).",
    image: "/assets/role/富豪.png",
  },
  {
    id: "shadow_envoy",
    name: "暗影使者",
    nameEn: "Shadow Envoy (暗影使者)",
    skill: "暗影共鸣",
    skillEn: "Shadow Resonance (暗影共鸣)",
    description: "免疫暗影吸取生命。\n\n存活状态下，每当其他暗影吸取生命，你恢复1点生命。",
    descriptionEn: "Immune to Health being absorbed by Shadows (暗影).\n\nWhile alive, whenever another Shadow absorbs Health, you recover 1 Health.",
    image: "/assets/role/暗影使者.png",
  },
  {
    id: "mercenary",
    name: "雇佣兵",
    nameEn: "Mercenary (雇佣兵)",
    skill: "武器精通",
    skillEn: "Weapon Mastery (武器精通)",
    description: "你的武器（刀、手枪、散弹枪）不占负重。\n\n你的刀与手枪具备相同效果，武力不变。",
    descriptionEn: "Your weapons (Knife, Pistol, Shotgun) don't take Capacity.\n\nYour Knife also gains the Pistol's effect (skip Power comparison if the opponent has no gun), while its own Power bonus is unchanged.",
    image: "/assets/role/雇佣兵.png",
  },
  {
    id: "beast_tamer",
    name: "驯兽师",
    nameEn: "Beast Tamer (驯兽师)",
    skill: "巡回猎犬",
    skillEn: "Roaming Hound (巡回猎犬)",
    description: "你的武力和负重永久+1。\n\n移动阶段，可派遣巡回猎犬，至距离5以内其他有储存的房间（包括停机坪）随机抽取1张道具获得（不可超过负重）。\n\n整场对局只能使用4次。\n\n若猎犬前往的房间无法抽取道具或没有库存，则无功而返，且不能在本轮中再次前往其他房间。\n\n巡回猎犬无法使用房间效果（如传送门、垃圾房、密道）。",
    descriptionEn: "Your Power and Capacity are permanently +1.\n\nDuring the Action Phase, you may send out your Roaming Hound to any other room with a stock (including the Helipad) within distance 5, randomly drawing 1 item card (cannot exceed your Capacity).\n\nUsable 4 times total per game.\n\nIf the room the hound visits can't be drawn from or has no stock, it returns empty-handed, and cannot try another room that round.\n\nThe Roaming Hound cannot trigger room effects (such as the Teleport Room, Junkyard, or hidden passages).",
    image: "/assets/role/驯兽师.png",
  },
  {
    id: "hypnotist",
    name: "催眠师",
    nameEn: "Hypnotist (催眠师)",
    skill: "催眠治疗",
    skillEn: "Hypnotic Cure (催眠治疗)",
    description: "移动阶段，催眠1名存活勇士（含自己）强化其前往你指定的房间。\n\n若被催眠勇士无法在5步之内到达该房间（无视被催眠勇士的速度，不能使用捷径），催眠失败，对方恢复自由行动。\n\n若成功，被催眠勇士强制前往该房间，可正常触发房间效果和抽取道具。\n\n结算阶段恢复1点生命。\n\n整场对局可能使用4次，每名勇士只能被催眠1次。\n\n被催眠勇士之间不能停留在同一个房间。",
    descriptionEn: "During the Action Phase, hypnotize 1 living player (yourself included) and compel them toward a room you designate.\n\nIf the target can't reach that room within 5 steps (ignoring their actual Speed, no shortcuts allowed), the hypnosis fails and they regain free movement.\n\nIf it succeeds, the target is forced into that room, and can normally trigger room effects and draw items.\n\nYou recover 1 Health at the Settlement Phase.\n\nUsable 4 times total per game; each player can only be hypnotized once.\n\nHypnotized players cannot end up in the same room as each other.",
    image: "/assets/role/催眠师.png",
  },
  {
    id: "hacker",
    name: "黑客",
    nameEn: "Hacker (黑客)",
    skill: "入侵系统",
    skillEn: "System Intrusion (入侵系统)",
    description: "移动前阶段，秘密关闭1个房间功能，本轮进入该房间的勇士无法触发房间效果，无法抽取道具。\n\n移动阶段，执行1次基因室、控制室、操作室功能（3选1）。\n\n整场对局，每种行动只能使用1次。",
    descriptionEn: "Before the Action Phase, secretly disable one room's function; any player entering that room this round cannot trigger its effect or draw items.\n\nDuring the Action Phase, perform one of the Gene Bank (基因库), Control Room (控制室), or Ops Room (操作室) functions (choose 1 of 3).\n\nEach of these two actions can only be used once per game.",
    image: "/assets/role/黑客.png",
  },
  {
    id: "bartender",
    name: "饮品师",
    nameEn: "Bartender (饮品师)",
    skill: "举杯共饮",
    skillEn: "Raise a Glass (举杯共饮)",
    description: "你的果汁不占负重。\n\n果汁营中的2张果汁归你初始所有。\n\n你的果汁可对其他勇士使用，使用前，你可选择3张效果卡再抽取。",
    descriptionEn: "Your Juice (果汁) cards don't take Capacity.\n\nYou start owning the 2 Juice cards in the Juice Camp (果汁营).\n\nYour Juice can be used on other players; before using it, you may look at 3 effect cards and draw from them.",
    image: "/assets/role/饮品师.png",
  },
  {
    id: "undertaker",
    name: "入殓师",
    nameEn: "Undertaker (入殓师)",
    skill: "置棺感应",
    skillEn: "Coffin Sense (置棺感应)",
    description: "每当有勇士变成暗影，你的负重永久+1。\n\n道具放入停尸间前，你可随机获得1张，每轮最多获得1张。",
    descriptionEn: "Whenever a player becomes a Shadow (暗影), your Capacity permanently +1.\n\nBefore an item card is placed into the Morgue (停尸间), you may randomly claim one, up to once per round.",
    image: "/assets/role/入殓师.png",
  },
  {
    id: "detective",
    name: "私家侦探",
    nameEn: "Private Detective (私家侦探)",
    skill: "秘密跟踪",
    skillEn: "Secret Tail (秘密跟踪)",
    description: "移动阶段，可以放弃移动，跟踪1名勇士。\n\n你移动到该勇士所处房间，可正常触发房间效果和抽取道具。\n\n整场对局只能使用3次，每名勇士只能被跟踪1次（被催眠时无法使用该技能）。",
    descriptionEn: "During the Action Phase, you may forgo your own move to tail 1 player instead; you move into that player's room, and can normally trigger room effects and draw items.\n\nUsable 3 times total per game; each player can only be tailed once (unusable while you're hypnotized).",
    image: "/assets/role/私家侦探.png",
  },
  {
    id: "prophet",
    name: "预言家",
    nameEn: "Prophet (预言家)",
    skill: "死亡预告",
    skillEn: "Death Foretold (死亡预告)",
    description: "移动阶段，可秘密选择其他勇士做出死亡预告，人数不限。\n\n每名被预告勇士在本轮变成暗影时，你获得2点自由基因点数（公开分配），恢复1点生命。\n\n整场对局只能使用6次。",
    descriptionEn: "During the Action Phase, secretly mark any number of other players with a death foretelling.\n\nFor each marked player who becomes a Shadow (暗影) that round, you gain 2 free Gene Points (基因点数) (allocated openly) and recover 1 Health.\n\nUsable 6 times total per game.",
    image: "/assets/role/预言家.png",
  },
  {
    id: "opinion_leader",
    name: "意见领袖",
    nameEn: "Opinion Leader (意见领袖)",
    skill: "一言九鼎",
    skillEn: "Final Word (一言九鼎)",
    description: "你决定顺位。\n\n你有额外 N × 2（N为其他勇士数）张票用于毒气投票。",
    descriptionEn: "You decide the turn order (顺位).\n\nYou get N x 2 extra votes for the Poison Gas (毒气) vote, where N is the number of other players.",
    image: "/assets/role/意见领袖.png",
  },
  {
    id: "virus_carrier",
    name: "病毒携带者",
    nameEn: "Virus Carrier (病毒携带者)",
    skill: "交叉感染",
    skillEn: "Cross Infection (交叉感染)",
    description: "和你在同房间的其他存活勇士额外扣N点生命（N为其他存活勇士数），与战斗同时结算，并叠加1层感染标记（标记公开）。\n\n感染者变成暗影时，你（存活状态）恢复等于其感染层数的生命。感染者感染标记消失。\n\n初始轮仅叠加标记，无伤害。",
    descriptionEn: "Every other living player sharing your room loses extra Health equal to N (the number of other living players there), settled alongside combat, and gains 1 stack of Infection (marked openly).\n\nWhen an infected player becomes a Shadow (暗影), you (if alive) recover Health equal to their infection stack count, and their Infection stacks are cleared.\n\nIn the very first round, only stacks are applied, with no damage.",
    image: "/assets/role/病毒携带者.png",
  },
  {
    id: "philanthropist",
    name: "慈善家",
    nameEn: "Philanthropist (慈善家)",
    skill: "乐善好施",
    skillEn: "Generous Giving (乐善好施)",
    description: "结算阶段，将1张道具强制赠予其他1名存活勇士（可短暂超出负重）。\n\n被赠予勇士必须公开1点基因（由该勇士选择），永久转移给你（无法转移数值为0的基因）。\n\n整场对局1名勇士只能被赠予1次。",
    descriptionEn: "At the Settlement Phase, force-gift 1 item card to another living player (briefly exceeding their Capacity is allowed).\n\nThe receiving player must openly give up 1 Gene Point (基因) of their choice, permanently transferred to you (a stat already at 0 cannot be chosen).\n\nEach player can only be gifted to once per game.",
    image: "/assets/role/慈善家.png",
  },
  {
    id: "chemist",
    name: "化学家",
    nameEn: "Chemist (化学家)",
    skill: "毒性调和",
    skillEn: "Toxin Tuning (毒性调和)",
    description: "移动阶段，执行以下行动（2选1）：\n\n指定1个已经充满毒气的房间，该房间本轮毒气伤害-2（最低为0）；\n\n本轮产生的毒气楼层伤害+2。",
    descriptionEn: "During the Action Phase, choose one of the following (1 of 2):\n\ndesignate 1 room already filled with Poison Gas (毒气) so its damage this round is -2 (floor of 0);\n\nor make this round's newly poisoned floor's damage +2.",
    image: "/assets/role/化学家.png",
  },
];

const ROLE_ID_SET = new Set(ROLES.map((r) => r.id));

function getRole(roleId) {
  return ROLES.find((r) => r.id === roleId) || null;
}

// Total-use budgets for the subset of role skills that are a player/admin-
// invoked action worth counting (as opposed to a passive/reactive effect
// like 暗影使者/入殓师, or a pure item-card mechanic the app has no model
// for at all, like 富豪/雇佣兵/饮品师). null = no total-game cap (usable
// every round, only naturally bounded by the 6-round game length) — shown
// as "unlimited" rather than an x/n count. Roles not listed here have
// nothing here worth tracking as a simple counter.
//
// hacker's 1 here is its SECOND ability (基因室/控制室/操作室 一次性三选一)
// -- its room-disable ability is a separate, already-implemented per-round
// mechanic (state.hackerRoomMark), not part of this counter.
const ROLE_SKILL_LIMITS = {
  beast_tamer: 4,   // 驯兽师 · 巡回猎犬
  hypnotist: 4,     // 催眠师 · 催眠治疗
  detective: 3,     // 私家侦探 · 秘密跟踪
  prophet: 6,       // 预言家 · 死亡预告
  chemist: null,    // 化学家 · 毒性调和
  hacker: 1,        // 黑客 · 基因室/控制室/操作室功能（三选一）
};

if (typeof module !== "undefined") {
  module.exports = { ROLES, ROLE_ID_SET, getRole, ROLE_SKILL_LIMITS };
}
