// Player-view-only language toggle (Chinese <-> English). Not loaded by
// public.html or admin.html, so it has no effect on those views.
const LANG_KEY = "jbts_lang";

function getLang() {
  return localStorage.getItem(LANG_KEY) === "en" ? "en" : "zh";
}
function setLang(lang) {
  localStorage.setItem(LANG_KEY, lang === "en" ? "en" : "zh");
}
function toggleLang() {
  setLang(getLang() === "en" ? "zh" : "en");
}

// [zh, en] pairs. English keeps important game-specific terms bracketed in
// Chinese (e.g. "Shadow (暗影)") so players can still recognize them.
const UI_TEXT = {
  loading: ["加载中...", "Loading..."],
  gameTitle: ["禁闭逃杀", "Confinement Battle Royale (禁闭逃杀)"],
  gameNotStarted: ["游戏尚未开始", "Game hasn't started yet"],
  waitForAdmin: ["请等待管理员创建游戏", "Please wait for the admin to create the game"],
  chooseCharacter: ["选择你的角色", "Choose your character"],
  player: ["玩家", "Player"],
  round: ["回合", "Round"],
  tabMap: ["地图", "Map"],
  tabStats: ["属性", "Stats"],
  tabPoison: ["毒气伤害", "Poison Damage (毒气)"],
  tabRanking: ["排行榜", "Ranking"],
  tabRules: ["游戏规则", "Rules"],
  currentCharacter: ["当前角色：", "Current character: "],
  switchCharacter: ["切换角色", "Switch Character"],
  switchPasswordPrompt: ["需要管理员密码才能切换角色", "Admin password required to switch character"],
  ready: ["已准备", "Ready"],
  incomplete: ["待完成", "Incomplete"],
  needed: ["需：", "Needed: "],
  needStats: ["分配基因点数", "Allocate Gene Points (基因点数)"],
  needSpawn: ["选择出生点", "Choose Spawn (出生点)"],
  rankingTitle: ["排行榜（存活优先，其次比生命值）", "Ranking (Alive first, then by Health)"],
  poisonTableTitle: ["毒气伤害对照表", "Poison Damage (毒气) Table"],
  colRound: ["回合", "Round"],
  colHealthLoss: ["生命消耗", "Health Loss"],
  spawnLabel: ["出生点：", "Spawn (出生点): "],
  notChosen: ["未选择", "Not chosen"],
  cancelSelect: ["取消选择", "Cancel Selection"],
  reselectSpawn: ["重新选择出生点", "Reselect Spawn (出生点)"],
  chooseSpawn: ["选择出生点", "Choose Spawn (出生点)"],
  shadowAlt: ["暗影", "Shadow (暗影)"],
  aliveAlt: ["存活", "Alive"],
  needAbsorbPrefix: ["还需吸取 ", "Needs to absorb "],
  needAbsorbSuffix: [" 点生命值复活", " more Health to revive"],
  healthLabel: ["生命值: ", "Health: "],
  survivorGoalTag: ["存活目标", "Survivor Goal"],
  survivorGoalText: [
    "削减他人生命值、保护自身生命值，游戏结束时生命值最高者获胜。",
    "Reduce others' Health, protect your own — whoever has the most Health when the game ends wins.",
  ],
  shadowGoalTag: ["暗影目标", "Shadow (暗影) Goal"],
  shadowGoalText: [
    "与存活玩家同处一室以吸取其生命值，累计吸取满 2 点即可复活。",
    "Share a room with a living player to absorb their Health — revive once you've absorbed 2 points total.",
  ],
  pointsLeftPrefix: ["剩余可分配点数: ", "Points remaining: "],
  gameOverRanking: ["游戏结束 · 排行榜", "Game Over · Ranking"],
  close: ["关闭", "Close"],
};

function t(key) {
  const entry = UI_TEXT[key];
  if (!entry) return key;
  return entry[getLang() === "en" ? 1 : 0];
}

// Small header control for switching languages; caller wires up the click.
function langToggleHtml() {
  const lang = getLang();
  return `<button class="btn secondary lang-toggle" id="lang-toggle" style="padding:4px 10px;font-size:12px;">${lang === "en" ? "中文" : "EN"}</button>`;
}
