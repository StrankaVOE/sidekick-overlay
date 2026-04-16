// ============================================================
// Sidekick — Champ Select JS v48
// ✅ Riot compliance: anonymizace jmen (Spoluhráč 1-4 / Enemy 1-5)
// ✅ Live polling: aktualizace při každém picku/hoveru
// ✅ AP/AD bar týmové kompozice
// ✅ WR vs enemy laner nebo basic WR champa
// ============================================================

const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const DDRAGON_VER  = "14.10.1";
const DDRAGON      = "https://ddragon.leagueoflegends.com/cdn/" + DDRAGON_VER;

var champMap       = {};   // id → name (string key for DDragon)
var champMapByName = {};   // lowercase name/id → numeric id
var champTagMap    = {};   // id → ["Fighter","Mage",...] (pro AP/AD)
var pendingRunes   = null;
var pendingSpells  = null;
var aiHistory      = [];
var myChampName    = "";
var myLane         = "";
var myChampId      = 0;
var enemyLanerChampId = 0;
var myCell         = -1;
var myPuuid        = "";
var partyPuuids    = [];   // puuid spoluhráčů ve stejné partě

// Polling
var pollTimer      = null;
var lastSnapshot   = "";   // JSON snapshot session pro change detection

function getBg() { return overwolf.windows.getMainWindow(); }

function setLoading(show, text) {
  var el = document.getElementById("loading");
  el.className = show ? "" : "hidden";
  if (text) document.getElementById("loading-text").textContent = text;
}

function lcuReq(method, endpoint, body) {
  return new Promise(function(resolve, reject) {
    var bg = getBg();
    if (!bg || !bg.lcuPort) { reject("LCU off"); return; }
    overwolf.web.sendHttpRequest(
      "https://127.0.0.1:" + bg.lcuPort + endpoint,
      overwolf.web.enums.HttpRequestMethods[method],
      [
        { key: "Authorization", value: "Basic " + bg.lcuToken },
        { key: "Accept",        value: "application/json" },
        { key: "Content-Type",  value: "application/json" },
      ],
      body !== undefined ? JSON.stringify(body) : "",
      function(r) {
        if (!r.success) { reject(r); return; }
        try { resolve(JSON.parse(r.data || "{}")); } catch(e) { reject(e); }
      }
    );
  });
}

// ── DDragon ───────────────────────────────────────────────────
function loadChampMap() {
  return fetch(DDRAGON + "/data/en_US/champion.json")
    .then(function(r) { return r.json(); })
    .then(function(data) {
      Object.values(data.data).forEach(function(c) {
        var id = parseInt(c.key);
        champMap[id]   = c.id;
        champTagMap[id]= c.tags || [];
        champMapByName[c.id.toLowerCase()]   = id;
        champMapByName[c.name.toLowerCase()] = id;
      });
    });
}

function champImg(id) {
  var n = champMap[id];
  return n ? DDRAGON + "/img/champion/" + n + ".png" : "";
}
function champN(id) { return champMap[id] || ""; }

// ── AP/AD team composition bar ─────────────────────────────────
// AP tags: Mage, Support (mostly)
// AD tags: Marksman, Fighter, Assassin, Tank
var AP_TAGS  = { Mage:true, Support:true };
var AD_TAGS  = { Marksman:true, Fighter:true, Assassin:true, Tank:true };

function calcTeamComposition(players) {
  var ap = 0, ad = 0;
  players.forEach(function(p) {
    var tags = champTagMap[p.championId] || [];
    var isAP = tags.some(function(t){ return AP_TAGS[t]; });
    var isAD = tags.some(function(t){ return AD_TAGS[t]; });
    if (isAP) ap++;
    else if (isAD) ad++;
  });
  return { ap: ap, ad: ad, total: players.length };
}

function renderAPADBar(ally, enemy) {
  var a = calcTeamComposition(ally);
  var e = calcTeamComposition(enemy);
  var el = document.getElementById("apad-bar");
  if (!el) return;
  var apPct = a.total > 0 ? Math.round((a.ap / a.total) * 100) : 50;
  el.innerHTML =
    '<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--sub);margin-bottom:4px">' +
      '<span style="color:#85b7eb">AP ' + a.ap + '</span>' +
      '<span style="font-size:9px;color:var(--sub);letter-spacing:1px">KOMPOZICE</span>' +
      '<span style="color:var(--gold)">AD ' + a.ad + '</span>' +
    '</div>' +
    '<div style="height:4px;background:rgba(250,199,117,0.2);border-radius:2px;overflow:hidden">' +
      '<div style="height:100%;width:' + apPct + '%;background:#85b7eb;border-radius:2px;transition:width .5s"></div>' +
    '</div>';
}

// ── Load session ───────────────────────────────────────────────
async function loadSession(isUpdate) {
  if (!isUpdate) setLoading(true, "Načítám champ select...");
  try {
    var session = await lcuReq("GET", "/lol-champ-select/v1/session");

    // Change detection — nespouštěj AI znovu pokud se nic nezměnilo
    var snap = JSON.stringify((session.myTeam||[]).map(function(p){ return p.championId; })
      .concat((session.theirTeam||[]).map(function(p){ return p.championId; })));
    var changed = snap !== lastSnapshot;
    lastSnapshot = snap;

    myCell = session.localPlayerCellId;
    var ally   = session.myTeam    || [];
    var enemy  = session.theirTeam || [];
    var actions= session.actions   || [];
    var isRanked = false;

    // Zjisti ranked pro anonymizaci
    try {
      var lobby = await lcuReq("GET", "/lol-lobby/v2/lobby");
      var qid   = lobby.gameConfig && (lobby.gameConfig.queueId || 0);
      // Ranked Solo/Duo = 420, Flex = 440
      isRanked  = (qid === 420 || qid === 440);
      // Party members — sdílejí partyId
      var myPartyId = null;
      (lobby.members || []).forEach(function(m) {
        if (m.puuid === myPuuid) myPartyId = m.partyId;
      });
      partyPuuids = [];
      if (myPartyId) {
        (lobby.members || []).forEach(function(m) {
          if (m.partyId === myPartyId && m.puuid !== myPuuid) partyPuuids.push(m.puuid);
        });
      }
    } catch(e2) { isRanked = true; } // defaultně anonymizuj

    renderBans(actions, ally, enemy);

    var myPick  = ally.find(function(p) { return p.cellId === myCell; }) || {};
    myChampId   = myPick.championId || myPick.championPickIntent || 0;
    myLane      = ((myPick.assignedPosition) || "mid").toUpperCase();
    myChampName = myChampId ? champN(myChampId) : "";

    document.getElementById("my-lane-label").textContent = myLane;
    document.getElementById("sp-lane").textContent       = myLane;
    document.getElementById("rec-label").textContent     = "Doporučené champy — " + myLane;

    if (!isUpdate) setLoading(true, "Načítám statistiky hráčů...");

    var [enrichedAlly, enrichedEnemy] = await Promise.all([
      enrichTeam(ally, myCell, false, isRanked),
      enrichTeam(enemy, null, true, isRanked),
    ]);

    renderAllyTeam(enrichedAlly);
    renderEnemyTeam(enrichedEnemy);
    renderAPADBar(enrichedAlly, enrichedEnemy);

    var enemyLaner = enrichedEnemy.find(function(p) {
      return (p.assignedPosition || "").toUpperCase() === myLane;
    }) || enrichedEnemy[0] || {};
    enemyLanerChampId = enemyLaner.championId || 0;

    if (myChampId) document.getElementById("my-port").src = champImg(myChampId);
    if (enemyLanerChampId) document.getElementById("en-port").src = champImg(enemyLanerChampId);

    setLoading(false);
    if (changed) runAIAnalysis(enrichedAlly, enrichedEnemy);

  } catch(e) {
    console.error("[SK CS]", e);
    setLoading(false);
    document.getElementById("ai-response").textContent = "Nepodařilo se načíst champ select data.";
  }
}

// ── Live polling — každé 3s ────────────────────────────────────
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(function() {
    loadSession(true).catch(function(){});
  }, 3000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  lastSnapshot = "";
}

// ── Bans ───────────────────────────────────────────────────────
function renderBans(actions, ally, enemy) {
  var allyIds = [], enemyIds = [];
  (actions || []).forEach(function(group) {
    (group || []).forEach(function(act) {
      if (act.type !== "ban" || !act.completed || !act.championId) return;
      var isAlly = ally.some(function(p) { return p.cellId === act.actorCellId; });
      if (isAlly) allyIds.push(act.championId);
      else enemyIds.push(act.championId);
    });
  });
  fillBanSlots("ally-bans",  allyIds);
  fillBanSlots("enemy-bans", enemyIds);
}

function fillBanSlots(containerId, ids) {
  var container = document.getElementById(containerId);
  var slots = container.querySelectorAll(".ban-slot");
  slots.forEach(function(slot, i) {
    slot.innerHTML = "";
    var champId = ids[i];
    if (champId) {
      var url = champImg(champId);
      if (url) {
        var img = document.createElement("img");
        img.src = url;
        img.onerror = function() { slot.textContent = "?"; };
        slot.appendChild(img);
        slot.title = champN(champId);
      } else {
        slot.textContent = "?";
      }
    } else {
      slot.textContent = "·";
      slot.style.opacity = "0.3";
    }
  });
}

// ── Enrich team ────────────────────────────────────────────────
// ✅ Riot compliance: isRanked → anonymizuj jména
async function enrichTeam(players, myCellId, isEnemy, isRanked) {
  var counter = 0;
  return Promise.all(players.map(async function(p) {
    var isMe    = (myCellId !== null && p.cellId === myCellId);
    var isParty = !isMe && partyPuuids.indexOf(p.puuid) !== -1;

    // ── Anonymizace ── (Riot compliance)
    // Vlastní jméno zobrazíme vždy
    // Partyčlenové vidí navzájem
    // Všichni ostatní → Spoluhráč X / Enemy X
    var displayName;
    if (isMe) {
      // Moje jméno — načti ze sumonera
      try {
        var mySumm = await lcuReq("GET", "/lol-summoner/v1/current-summoner");
        myPuuid    = mySumm.puuid || "";
        displayName = mySumm.gameName || mySumm.displayName || "Ty";
      } catch(e) { displayName = "Ty"; }
    } else if (isParty && !isRanked) {
      // Partyčlenové — jméno ok mimo ranked
      try {
        if (p.summonerId) {
          var s = await lcuReq("GET", "/lol-summoner/v1/summoners/" + p.summonerId);
          displayName = s.gameName || s.displayName || "Spoluhráč";
        } else { displayName = "Spoluhráč"; }
      } catch(e) { displayName = "Spoluhráč"; }
    } else if (isEnemy) {
      counter++;
      displayName = "Enemy " + counter;
    } else if (!isMe) {
      counter++;
      // V partě v ranked taky anonymizujeme
      displayName = isParty ? (isRanked ? "Spoluhráč " + counter : null) : "Spoluhráč " + counter;
      if (!displayName) {
        try {
          var s2 = await lcuReq("GET", "/lol-summoner/v1/summoners/" + p.summonerId);
          displayName = s2.gameName || s2.displayName || "Spoluhráč";
        } catch(e) { displayName = "Spoluhráč " + counter; }
      }
    } else {
      displayName = "Hráč";
    }

    var rank = "", wr = null;
    var spell1 = p.spell1Id || 0, spell2 = p.spell2Id || 0;
    try {
      if (isMe && myPuuid) {
        var stats = await lcuReq("GET", "/lol-ranked/v1/ranked-stats/" + myPuuid);
        var solo  = (stats.queues || []).find(function(q) { return q.queueType === "RANKED_SOLO_5x5"; });
        if (solo && solo.tier && solo.tier !== "NONE") {
          var total = (solo.wins || 0) + (solo.losses || 0);
          wr   = total > 0 ? Math.round(solo.wins / total * 100) : null;
          rank = solo.tier[0] + solo.tier.slice(1).toLowerCase() + " " + solo.division;
        }
      }
      // Pro ostatní: WR zobrazujeme pouze hráče samotného (né cizí)
      // Tím splníme Riot požadavek — neukazujeme cizí osobní data
    } catch(e) {}

    return Object.assign({}, p, {
      name: displayName,
      rank: rank,
      wr:   wr,
      spell1: spell1,
      spell2: spell2,
      isMe:   isMe,
    });
  }));
}

// ── Render helpers ─────────────────────────────────────────────
function wrClass(wr) {
  if (wr === null) return "wr-mid";
  return wr >= 54 ? "wr-good" : wr < 48 ? "wr-bad" : "wr-mid";
}

var SPELL_NAMES = {4:"F",14:"I",12:"TP",7:"H",3:"E",11:"S",21:"B",6:"G",1:"C",32:"M"};

function makePlayerRow(p, isEnemy) {
  var row = document.createElement("div");
  row.className = "player-row" + (p.isMe ? " is-me" : "") + (isEnemy ? " is-enemy" : "");

  // Champ icon
  var url = p.championId ? champImg(p.championId) : "";
  var portrait;
  if (url) {
    portrait = document.createElement("img");
    portrait.className = "champ-icon"; portrait.src = url;
    portrait.onerror = function() {
      var ph = document.createElement("div");
      ph.className = "champ-icon-ph"; ph.textContent = "?";
      portrait.parentNode && portrait.parentNode.replaceChild(ph, portrait);
    };
  } else {
    portrait = document.createElement("div");
    portrait.className = "champ-icon-ph";
    // Placeholder: první písmeno jména
    portrait.textContent = p.name ? p.name[0].toUpperCase() : "?";
  }

  // Player info
  var champName = champN(p.championId) || "";
  var tags      = (champTagMap[p.championId] || []).join(", ");
  var info = document.createElement("div");
  info.className = "player-info";
  info.innerHTML =
    '<div class="player-name">' + esc(p.name) + '</div>' +
    '<div class="player-sub">' +
      (champName ? esc(champName) : "") +
      (p.isMe && p.rank ? '<span style="margin-left:5px;color:var(--gold)">' + esc(p.rank) + '</span>' : "") +
    '</div>';

  // WR badge — jen pro sebe nebo pokud zná WR
  var badge = null;
  if (p.wr !== null) {
    badge = document.createElement("span");
    badge.className = "wr-badge " + wrClass(p.wr);
    badge.textContent = p.wr + "%";
  }

  // Summoner spelly mini
  var spellEl = null;
  if (p.spell1 || p.spell2) {
    spellEl = document.createElement("div");
    spellEl.className = "spell-mini";
    [p.spell1, p.spell2].forEach(function(sid) {
      var box = document.createElement("div");
      box.className = "spell-mini-box";
      box.textContent = SPELL_NAMES[sid] || "?";
      spellEl.appendChild(box);
    });
  }

  // AP/AD tag badge
  var apBadge = null;
  if (p.championId && champTagMap[p.championId]) {
    var t = champTagMap[p.championId][0];
    if (t) {
      apBadge = document.createElement("span");
      apBadge.style.cssText = "font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(255,255,255,0.06);color:#666;white-space:nowrap";
      apBadge.textContent = t;
    }
  }

  if (isEnemy) {
    var isLaner = (p.assignedPosition || "").toUpperCase() === myLane;
    if (isLaner) {
      var tag = document.createElement("span");
      tag.className = "laner-tag"; tag.textContent = "LANER";
      if (badge) row.appendChild(badge);
      if (spellEl) row.appendChild(spellEl);
      row.appendChild(tag); row.appendChild(info); row.appendChild(portrait);
    } else {
      if (badge) row.appendChild(badge);
      if (spellEl) row.appendChild(spellEl);
      row.appendChild(info); row.appendChild(portrait);
    }
  } else {
    row.appendChild(portrait); row.appendChild(info);
    if (spellEl) row.appendChild(spellEl);
    if (apBadge) row.appendChild(apBadge);
    if (badge) row.appendChild(badge);
  }
  return row;
}

function renderAllyTeam(players) {
  var list = document.getElementById("ally-list");
  list.innerHTML = "";
  players.forEach(function(p) { list.appendChild(makePlayerRow(p, false)); });
}

function renderEnemyTeam(players) {
  var list = document.getElementById("enemy-list");
  list.innerHTML = "";
  players.forEach(function(p) { list.appendChild(makePlayerRow(p, true)); });
}

function renderWinChance(pct) {
  document.getElementById("ally-win").textContent  = pct + "%";
  document.getElementById("enemy-win").textContent = (100 - pct) + "%";
  document.getElementById("winbar-fill").style.width = pct + "%";
  document.getElementById("winbar-fill").style.background = pct >= 50 ? "var(--green)" : "var(--red)";
}

function renderMatchupWR(wr, games, tip) {
  if (wr !== null) {
    var el  = document.getElementById("matchup-wr");
    var fEl = document.getElementById("matchup-fill");
    el.textContent   = wr + "%";
    el.style.color   = wr >= 50 ? "var(--green)" : wr >= 45 ? "var(--gold)" : "var(--red)";
    fEl.style.width  = wr + "%";
    fEl.style.background = wr >= 50 ? "var(--green)" : wr >= 45 ? "var(--gold)" : "var(--red)";
  }
  if (games) document.getElementById("matchup-games").textContent = "z " + games + " her";
  if (tip)   document.getElementById("matchup-tip").textContent   = tip;
}

function renderRecs(recs) {
  var list = document.getElementById("rec-list");
  list.innerHTML = "";
  document.getElementById("rec-count").textContent = recs.length + " champů";
  (recs || []).forEach(function(r, i) {
    var idByName = champMapByName[(r.name || "").toLowerCase()];
    var iconUrl  = idByName ? champImg(idByName) : "";
    var tagCls   = (r.tag || "").includes("silný") ? "tag-good"
                 : (r.tag || "").includes("slabší") ? "tag-hard" : "tag-neutral";
    var el = document.createElement("div");
    el.className = "rec-item" + (i === 0 ? " top" : "");
    el.innerHTML =
      (iconUrl ? '<img class="rec-icon" src="' + iconUrl + '">' : '<div class="rec-icon"></div>') +
      '<div style="flex:1;min-width:0">' +
        '<div class="rec-name">' + esc(r.name) + '</div>' +
        '<div class="rec-reason">' + esc(r.reason || "") + '</div>' +
        '<span class="rec-tag ' + tagCls + '">' + esc(r.tag || "") + '</span>' +
      '</div>' +
      '<div class="rec-wr-col"><div class="rec-wr-big">' + (r.wr ? r.wr + "%" : "—") + '</div><div class="rec-wr-sub">WR</div></div>';
    list.appendChild(el);
  });
}

function renderRunes(runes) {
  document.getElementById("rune-keystone").textContent = runes.keystone || "—";
  document.getElementById("rune-path").textContent     =
    (runes.path || "—") + (runes.secondary ? " + " + runes.secondary : "");
  var btn = document.getElementById("rune-import-btn");
  btn.disabled = !runes.page;
  if (runes.page) pendingRunes = runes.page;
}

function renderSpells(spells) {
  if (!spells || !spells.length) return;
  var s1 = spells[0] || {}, s2 = spells[1] || {};
  document.getElementById("spell1-name").textContent = s1.name || "Flash";
  document.getElementById("spell1-cd").textContent   = "CD: " + (s1.cd || "—") + "s";
  document.getElementById("spell1-box").textContent  = SPELL_NAMES[s1.id] || (s1.name && s1.name[0]) || "F";
  document.getElementById("spell2-name").textContent = s2.name || "Ignite";
  document.getElementById("spell2-cd").textContent   = "CD: " + (s2.cd || "—") + "s";
  document.getElementById("spell2-box").textContent  = SPELL_NAMES[s2.id] || (s2.name && s2.name[0]) || "I";
  if (s2.note) document.getElementById("spell-note").textContent = s2.note;
  if (s1.id && s2.id) {
    pendingSpells = { spell1Id: s1.id, spell2Id: s2.id };
    document.getElementById("spell-import-btn").disabled = false;
  }
}

function renderMetaPicks(picks) {
  var el = document.getElementById("sp-meta");
  el.innerHTML = "";
  (picks || []).forEach(function(p, i) {
    var row = document.createElement("div");
    row.className = "sp-item";
    row.innerHTML =
      '<div class="sp-num">' + (i+1) + '.</div>' +
      '<div><div class="sp-champ">' + esc(p.name) + '</div><div class="sp-sub">' + esc(p.sub || "") + '</div></div>' +
      '<div class="sp-wr">' + (p.wr ? p.wr + "%" : "") + '</div>';
    el.appendChild(row);
  });
}

function renderSynergies(syns) {
  var el = document.getElementById("sp-syn");
  el.innerHTML = "";
  (syns || []).forEach(function(s) {
    var row = document.createElement("div");
    row.className = "sp-item";
    row.innerHTML =
      '<span class="sp-bullet' + (s.warn ? " warn" : "") + '">' + (s.warn ? "!" : "·") + '</span>' +
      '<span class="sp-tip">' + esc(s.text) + '</span>';
    el.appendChild(row);
  });
}

function renderCounterTips(tips) {
  var el = document.getElementById("sp-counter");
  el.innerHTML = "";
  (tips || []).forEach(function(t, i) {
    var row = document.createElement("div");
    row.className = "sp-item";
    row.innerHTML = '<div class="sp-num red">' + (i+1) + '.</div><span class="sp-tip">' + esc(t) + '</span>';
    el.appendChild(row);
  });
}

function renderThreats(threats) {
  var el = document.getElementById("sp-threats");
  el.innerHTML = "";
  (threats || []).forEach(function(t, i) {
    var row = document.createElement("div");
    row.className = "sp-item";
    row.innerHTML =
      '<div class="sp-num red">' + (i+1) + '.</div>' +
      '<div><div class="sp-champ">' + esc(t.name) + '</div><div class="sp-sub">' + esc(t.desc) + '</div></div>';
    el.appendChild(row);
  });
}

// ── AI Analysis ────────────────────────────────────────────────
async function runAIAnalysis(ally, enemy) {
  // Použij champ ID/jméno, ne skutečné summoner jméno
  var allyStr  = ally.map(function(p) {
    var cname = champN(p.championId) || "?";
    var label = p.isMe ? "TY" : (p.name || "Spoluhráč");
    return label + "(" + cname + ")";
  }).join(", ");
  var enemyStr = enemy.map(function(p) { return champN(p.championId) || "?"; }).join(", ");
  var myChamp  = myChampName || "neznámý";
  var lane     = myLane || "MID";
  var enemyLaner = champN(enemyLanerChampId) || "neznámý";

  var aiEl = document.getElementById("ai-response");
  aiEl.className   = "ai-response loading";
  aiEl.textContent = "⚡ Analyzuji tým a matchup...";

  var prompt =
    "Hráč hraje " + myChamp + " na " + lane + ".\n" +
    "Ally: " + allyStr + "\nEnemy: " + enemyStr + "\n" +
    "Enemy laner: " + enemyLaner + "\n\n" +
    "Vrať POUZE čistý JSON (žádný markdown, žádný text mimo JSON):\n" +
    "{\n" +
    "  \"winChance\": <0-100>,\n" +
    "  \"matchupWR\": <0-100 — WR champa " + myChamp + " vs " + enemyLaner + ">,\n" +
    "  \"matchupGames\": <přibližný počet her v meta>,\n" +
    "  \"matchupTip\": \"konkrétní tip vs " + enemyLaner + " česky (max 1 věta)\",\n" +
    "  \"recommendations\": [\n" +
    "    {\"name\":\"ChampName\",\"reason\":\"krátce česky\",\"tag\":\"silný matchup\"|\"neutrální matchup\"|\"slabší matchup\",\"wr\":53},\n" +
    "    ... (7-10 champů pro " + lane + ")\n" +
    "  ],\n" +
    "  \"runes\": {\"keystone\":\"...\",\"path\":\"...\",\"secondary\":\"...\",\"page\":null},\n" +
    "  \"spells\": [{\"name\":\"Flash\",\"id\":4,\"cd\":300},{\"name\":\"Ignite\",\"id\":14,\"cd\":180,\"note\":\"agresivní\"}],\n" +
    "  \"metaPicks\": [{\"name\":\"LeBlanc\",\"sub\":\"burst · roam\",\"wr\":54}],\n" +
    "  \"synergies\": [{\"text\":\"...\",\"warn\":false}],\n" +
    "  \"counterTips\": [\"tip1 česky\",\"tip2\",\"tip3\",\"tip4\",\"tip5\"],\n" +
    "  \"threats\": [{\"name\":\"...\",\"desc\":\"...\"}],\n" +
    "  \"summary\": \"1-2 věty česky\"\n" +
    "}";

  try {
    var resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1400,
        system: "Jsi LoL asistent. Odpovídej VŽDY POUZE čistým JSON bez markdownu.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    var data  = await resp.json();
    var text  = (data.content && data.content[0] && data.content[0].text) || "{}";
    var clean = text.replace(/```json|```/g, "").trim();
    var ai    = JSON.parse(clean);

    if (ai.winChance !== undefined)  renderWinChance(ai.winChance);
    if (ai.matchupWR !== undefined)  renderMatchupWR(ai.matchupWR, ai.matchupGames, ai.matchupTip);
    if (ai.recommendations)          renderRecs(ai.recommendations);
    if (ai.runes)                    renderRunes(ai.runes);
    if (ai.spells)                   renderSpells(ai.spells);
    if (ai.metaPicks)                renderMetaPicks(ai.metaPicks);
    if (ai.synergies)                renderSynergies(ai.synergies);
    if (ai.counterTips)              renderCounterTips(ai.counterTips);
    if (ai.threats)                  renderThreats(ai.threats);

    aiEl.className   = "ai-response";
    aiEl.textContent = ai.summary || "Analýza dokončena.";
    aiHistory = [{ role: "assistant", content: ai.summary || "" }];

  } catch(e) {
    console.error("[SK CS] AI error:", e);
    aiEl.className   = "ai-response";
    aiEl.textContent = "AI analýza selhala. Zkus otázku ručně.";
  }
}

// ── AI chat ────────────────────────────────────────────────────
async function askAI(q) {
  var inputEl  = document.getElementById("ai-input");
  var question = q || (inputEl && inputEl.value.trim());
  if (!question) return;
  if (inputEl) inputEl.value = "";
  var aiEl = document.getElementById("ai-response");
  aiEl.className   = "ai-response loading";
  aiEl.textContent = "Přemýšlím...";
  var ctx = myChampName ? "[" + myChampName + " " + myLane + "] " : "";
  aiHistory.push({ role: "user", content: ctx + question });
  try {
    var resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 400,
        system: "Jsi LoL asistent. Odpovídej stručně česky, max 3 věty. Bez markdownu.",
        messages: aiHistory.slice(-8),
      }),
    });
    var data = await resp.json();
    var text = (data.content && data.content[0] && data.content[0].text) || "—";
    aiHistory.push({ role: "assistant", content: text });
    aiEl.className   = "ai-response";
    aiEl.textContent = text;
  } catch(e) {
    aiEl.className   = "ai-response";
    aiEl.textContent = "AI dočasně nedostupná.";
  }
}
function quickAsk(q) { askAI(q); }

// ── Rune import ────────────────────────────────────────────────
async function importRunes() {
  if (!pendingRunes) return;
  var btn = document.getElementById("rune-import-btn");
  btn.disabled = true; btn.textContent = "Importuji...";
  try {
    var pages = await lcuReq("GET", "/lol-perks/v1/pages");
    var inv   = await lcuReq("GET", "/lol-perks/v1/inventory");
    var maxP  = inv.ownedPageCount || 2;
    var del   = (pages || []).filter(function(p) { return p.isDeletable; });
    if (del.length >= maxP) {
      var bg = getBg();
      await new Promise(function(res, rej) {
        overwolf.web.sendHttpRequest(
          "https://127.0.0.1:" + bg.lcuPort + "/lol-perks/v1/pages/" + del[0].id,
          overwolf.web.enums.HttpRequestMethods.DELETE,
          [{ key: "Authorization", value: "Basic " + bg.lcuToken }],
          "", function(r) { r.success ? res() : rej(); }
        );
      });
    }
    await lcuReq("POST", "/lol-perks/v1/pages", pendingRunes);
    btn.textContent = "✓ Importováno!";
    setTimeout(function() { btn.textContent = "Importovat runy"; btn.disabled = false; }, 3000);
  } catch(e) {
    btn.textContent = "Chyba";
    setTimeout(function() { btn.textContent = "Importovat runy"; btn.disabled = false; }, 2000);
  }
}

// ── Spell import ───────────────────────────────────────────────
async function importSpells() {
  if (!pendingSpells) return;
  var btn = document.getElementById("spell-import-btn");
  btn.textContent = "Nastavuji...";
  try {
    await lcuReq("PATCH", "/lol-champ-select/v1/session/my-selection", {
      spell1Id: pendingSpells.spell1Id,
      spell2Id: pendingSpells.spell2Id,
    });
    btn.textContent = "✓ Nastaveno!";
    setTimeout(function() { btn.textContent = "Nastavit spelly"; }, 3000);
  } catch(e) {
    btn.textContent = "Chyba";
    setTimeout(function() { btn.textContent = "Nastavit spelly"; }, 2000);
  }
}

// ── Window controls ────────────────────────────────────────────
function closeMe() {
  stopPolling();
  var bg = getBg();
  if (bg && bg.closeChampSelect) bg.closeChampSelect();
}
function minimizeMe() {
  overwolf.windows.getCurrentWindow(function(r) {
    if (r.success) overwolf.windows.minimize(r.window.id);
  });
}
function esc(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Messages from background ───────────────────────────────────
overwolf.windows.onMessageReceived.addListener(function(msg) {
  if (msg.id === "load") {
    stopPolling();
    aiHistory = []; pendingRunes = null; pendingSpells = null;
    loadChampMap().then(function() {
      return loadSession(false);
    }).then(function() {
      startPolling();
    });
  }
});

// ── Init ───────────────────────────────────────────────────────
(async function init() {
  setLoading(true, "Načítám data championů...");
  await loadChampMap();
  setLoading(true, "Čekám na champ select...");
})();
