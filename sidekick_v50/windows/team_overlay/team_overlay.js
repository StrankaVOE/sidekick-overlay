// ============================================================
// Sidekick — Team Overlay (Alt+T)
// Data: Live Client API + LCU API
// ============================================================

const LIVE      = "http://127.0.0.1:2999/liveclientdata";
const DDRAGON   = "https://ddragon.leagueoflegends.com/cdn/14.10.1";
const CLAUDE_M  = "claude-sonnet-4-20250514";

var champMap = {};  // id → name  (DDragon)
var champById = {}; // name.lower → id

// ── Helpers ───────────────────────────────────────────────────
function getBg() { return overwolf.windows.getMainWindow(); }

function lcuGet(endpoint) {
  return new Promise(function(resolve, reject) {
    var bg = getBg();
    if (!bg || !bg.lcuPort || !bg.lcuAuthB64) { reject("LCU not connected"); return; }
    var url = "https://127.0.0.1:" + bg.lcuPort + endpoint;
    var hdrs = [
      { key: "Authorization", value: "Basic " + bg.lcuAuthB64 },
      { key: "Accept",        value: "application/json" },
    ];
    overwolf.web.sendHttpRequest(url,
      overwolf.web.enums.HttpRequestMethods.GET, hdrs, "",
      function(r) {
        if (!r.success || !r.data) { reject(r); return; }
        try { resolve(JSON.parse(r.data)); } catch(e) { reject(e); }
      }
    );
  });
}

async function liveGet(ep) {
  var r = await fetch(LIVE + ep);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function loadChampMap() {
  try {
    var r = await fetch(DDRAGON + "/data/en_US/champion.json");
    var d = await r.json();
    Object.values(d.data).forEach(function(c) {
      champMap[parseInt(c.key)] = c.id;
      champById[c.id.toLowerCase()] = parseInt(c.key);
      champById[c.name.toLowerCase()] = parseInt(c.key);
    });
  } catch(e) { console.warn("champMap fail:", e); }
}

function champImg(nameOrId) {
  var name = typeof nameOrId === "number" ? champMap[nameOrId] : nameOrId;
  if (!name) return "";
  // DDragon jméno — odstraň mezery/apostrofy
  var safe = name.replace(/[ '\.]/g, "").replace("&", "");
  return DDRAGON + "/img/champion/" + safe + ".png";
}

function rankBadge(queue) {
  if (!queue || !queue.tier || queue.tier === "NONE")
    return '<span class="rank-badge r-UNRANKED">Unranked</span>';
  var tier = queue.tier;
  var div  = queue.division !== "NA" ? " " + queue.division : "";
  var lp   = " · " + (queue.leaguePoints || 0) + " LP";
  return '<span class="rank-badge r-' + tier + '">' + tier.charAt(0) + tier.slice(1).toLowerCase() + div + lp + '</span>';
}

function wrHtml(wins, losses) {
  var total = wins + losses;
  if (!total) return '<span class="wr-line">—</span>';
  var wr = Math.round(wins / total * 100);
  var cls = wr >= 55 ? "wr-g" : wr < 45 ? "wr-b" : "";
  return '<span class="wr-line ' + cls + '">' + wins + 'V ' + losses + 'P <b>(' + wr + '%)</b></span>';
}

// ── Role ordering ─────────────────────────────────────────────
var ROLE_ORDER = { TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4, "": 5 };
var ROLE_ICONS = { TOP: "🗡", JUNGLE: "🌲", MIDDLE: "✨", BOTTOM: "🏹", UTILITY: "🛡", "": "?" };

function roleIcon(pos) { return ROLE_ICONS[pos] || ROLE_ICONS[""]; }
function roleSort(a, b) { return (ROLE_ORDER[a.role] || 5) - (ROLE_ORDER[b.role] || 5); }

// ── Main load ─────────────────────────────────────────────────
async function load() {
  setStatus("ally-list",   "Načítám...");
  setStatus("enemy-list",  "Načítám...");
  setStatus("matchup-list","Počítám matchupy...");
  document.getElementById("ai-box").innerHTML = '<span class="spinner"></span>Analyzuji...';

  var liveData, sessionData, myPuuid;
  var useLive = false;

  // 1. Zkus live client (in-game)
  try {
    liveData = await liveGet("/allgamedata");
    useLive = true;
  } catch(e) {}

  // 2. Zkus LCU champ select session (pre-game)
  try {
    sessionData = await lcuGet("/lol-champ-select/v1/session");
  } catch(e) {}

  // 3. Můj PUUID
  try {
    var me = await lcuGet("/lol-summoner/v1/current-summoner");
    myPuuid = me.puuid;
  } catch(e) {}

  var allyPlayers = [], enemyPlayers = [];

  if (useLive && liveData) {
    // In-game: rozdělíme přes tým
    var myTeam = null;
    (liveData.allPlayers || []).forEach(function(p) {
      if (p.summonerName === (liveData.activePlayer || {}).summonerName) myTeam = p.team;
    });
    (liveData.allPlayers || []).forEach(function(p) {
      var obj = {
        name: p.summonerName, champName: p.championName,
        role: p.position || "", scores: p.scores,
        isMe: p.summonerName === (liveData.activePlayer || {}).summonerName,
        team: p.team,
      };
      if (p.team === myTeam) allyPlayers.push(obj);
      else enemyPlayers.push(obj);
    });
  } else if (sessionData) {
    // Champ select
    var buildPlayers = function(arr, isAlly) {
      return (arr || []).map(function(p) {
        return {
          name: p.summonerName || "Hráč",
          champId: p.championId,
          champName: champMap[p.championId] || "",
          role: (p.assignedPosition || "").toUpperCase(),
          puuid: p.puuid,
          summonerId: p.summonerId,
          isMe: isAlly && p.puuid === myPuuid,
        };
      });
    };
    allyPlayers  = buildPlayers(sessionData.myTeam,    true);
    enemyPlayers = buildPlayers(sessionData.theirTeam, false);
  }

  // Sort by role
  allyPlayers.sort(roleSort);
  enemyPlayers.sort(roleSort);

  // Enrich with LCU rank data
  async function enrich(players) {
    return Promise.all(players.map(async function(p) {
      try {
        var puuid = p.puuid;
        if (!puuid && p.summonerId) {
          var s = await lcuGet("/lol-summoner/v1/summoners/" + p.summonerId);
          puuid = s.puuid; p.name = s.displayName || p.name;
        }
        if (!puuid && p.name) {
          var s2 = await lcuGet("/lol-summoner/v1/summoners?name=" + encodeURIComponent(p.name));
          if (s2 && s2.puuid) puuid = s2.puuid;
        }
        if (!puuid) return p;

        p.puuid = puuid;
        var stats = await lcuGet("/lol-ranked/v1/ranked-stats/" + puuid);
        p.soloQ  = (stats.queues || []).find(function(q) { return q.queueType === "RANKED_SOLO_5x5"; });
        p.champStats = null; // filled later from match history
      } catch(e) {}
      return p;
    }));
  }

  var [enrichedAlly, enrichedEnemy] = await Promise.all([enrich(allyPlayers), enrich(enemyPlayers)]);

  renderTeam("ally-list",  enrichedAlly,  true);
  renderTeam("enemy-list", enrichedEnemy, false);
  renderWinBar(50);
  renderMatchups(enrichedAlly, enrichedEnemy);
  runAI(enrichedAlly, enrichedEnemy);
}

// ── Render team ───────────────────────────────────────────────
function renderTeam(containerId, players, isAlly) {
  var list = document.getElementById(containerId);
  list.innerHTML = "";
  if (!players.length) { list.innerHTML = '<p class="loading-txt">Žádní hráči</p>'; return; }

  players.forEach(function(p) {
    var soloQ = p.soloQ;
    var img   = p.champName ? champImg(p.champName) : "";

    var div = document.createElement("div");
    div.className = "pcard" + (p.isMe ? " is-me" : "");
    div.innerHTML =
      '<span class="role-icon">' + roleIcon(p.role) + '</span>' +
      (img ? '<img class="champ-icon" src="' + img + '" onerror="this.style.display=\'none\'">' : '<div class="champ-icon-ph">?</div>') +
      '<div class="pinfo">' +
        '<div class="pname">' + escHtml(p.name) + (p.isMe ? ' <span style="color:var(--purple-lt);font-size:9px">(ty)</span>' : '') + '</div>' +
        '<div class="psub">' + (p.champName || "—") + '</div>' +
      '</div>' +
      '<div class="pstats">' +
        rankBadge(soloQ) +
        (soloQ ? wrHtml(soloQ.wins || 0, soloQ.losses || 0) : '') +
      '</div>';

    // Click → profile
    div.addEventListener("click", function() { openProfile(p); });
    list.appendChild(div);
  });
}

// ── Win bar ───────────────────────────────────────────────────
function renderWinBar(allyPct) {
  allyPct = Math.max(5, Math.min(95, Math.round(allyPct)));
  document.getElementById("w-ally").textContent  = allyPct + "%";
  document.getElementById("w-enemy").textContent = (100-allyPct) + "%";
  document.getElementById("w-fill").style.width  = allyPct + "%";
}

// ── Matchup rows ──────────────────────────────────────────────
function renderMatchups(ally, enemy) {
  var list = document.getElementById("matchup-list");
  list.innerHTML = "";
  var len = Math.max(ally.length, enemy.length);
  for (var i = 0; i < len; i++) {
    var a = ally[i],  e = enemy[i];
    var aName = a ? a.champName : "?";
    var eName = e ? e.champName : "?";
    var aImg  = aName !== "?" ? champImg(aName) : "";
    var eImg  = eName !== "?" ? champImg(eName) : "";

    var row = document.createElement("div");
    row.className = "matchup-row";
    row.innerHTML =
      '<div class="matchup-champ">' +
        (aImg ? '<img src="'+aImg+'" onerror="this.style.display=\'none\'">' : '') +
        '<span>' + aName + '</span>' +
      '</div>' +
      '<span class="vs-sep">vs</span>' +
      '<div class="matchup-champ" style="justify-content:flex-end">' +
        '<span>' + eName + '</span>' +
        (eImg ? '<img src="'+eImg+'" onerror="this.style.display=\'none\'">' : '') +
      '</div>' +
      '<span class="matchup-wr wr-neu" id="mwr-' + i + '">—</span>';

    list.appendChild(row);
  }
  // Dopoč matchup WR přes AI
  updateMatchupWinRates(ally, enemy);
}

async function updateMatchupWinRates(ally, enemy) {
  var len = Math.max(ally.length, enemy.length);
  for (var i = 0; i < len; i++) {
    var a = ally[i], e = enemy[i];
    if (!a || !e) continue;
    var el = document.getElementById("mwr-" + i);
    if (!el) continue;
    // Jednoduchý odhad přes Claude (batch)
    // Vrátí se přes runAI()
    el.textContent = "—";
  }
}

// ── AI analýza ────────────────────────────────────────────────
async function runAI(ally, enemy) {
  var allyStr  = ally.map(function(p)  { return (p.champName||"?") + "(" + (p.role||"?") + ")"; }).join(", ");
  var enemyStr = enemy.map(function(p) { return (p.champName||"?") + "(" + (p.role||"?") + ")"; }).join(", ");

  var prompt =
    "Ally team: " + allyStr + "\nEnemy team: " + enemyStr +
    "\nVrať JSON bez markdownu:\n" +
    "{\"winChance\":52,\"matchups\":[{\"index\":0,\"allyWr\":55},...],\"analysis\":\"2-3 věty česky o kompu, co hrát\"}";

  try {
    var r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CLAUDE_M, max_tokens: 500,
        system: "Jsi LoL analytik. Odpovídej POUZE JSON.",
        messages: [{ role: "user", content: prompt }]
      })
    });
    var d = await r.json();
    var text = ((d.content || [{}])[0].text || "").replace(/```json|```/g, "").trim();
    var ai = JSON.parse(text);

    if (ai.winChance) renderWinBar(ai.winChance);
    (ai.matchups || []).forEach(function(m) {
      var el = document.getElementById("mwr-" + m.index);
      if (!el) return;
      var wr = m.allyWr || 50;
      var cls = wr >= 55 ? "wr-adv" : wr < 45 ? "wr-dis" : "wr-neu";
      el.className = "matchup-wr " + cls;
      el.textContent = wr + "%";
    });
    document.getElementById("ai-box").textContent = ai.analysis || "";
  } catch(e) {
    document.getElementById("ai-box").textContent = "AI analýza se nezdařila.";
  }
}

// ── Profile panel ─────────────────────────────────────────────
var currentProfile = null;

async function openProfile(player) {
  var panel  = document.getElementById("profile-panel");
  var scroll = document.getElementById("profile-scroll");

  document.getElementById("profile-name").textContent = player.name;
  document.getElementById("profile-rank").textContent =
    player.soloQ && player.soloQ.tier !== "NONE"
      ? player.soloQ.tier + " " + player.soloQ.division + " · " + player.soloQ.leaguePoints + " LP"
      : "Unranked";

  scroll.innerHTML = '<p class="loading-txt"><span class="spinner"></span>Načítám profil...</p>';
  panel.classList.add("open");

  if (!player.puuid) {
    scroll.innerHTML = '<p class="loading-txt">PUUID nenalezeno.</p>';
    return;
  }

  try {
    // Match history
    var hist = await lcuGet("/lol-match-history/v1/products/lol/" + player.puuid + "/matches?begIndex=0&endIndex=20");
    var matches = (hist.games && hist.games.games) || hist.games || [];

    // Most played champs (aggregate)
    var champAgg = {};
    matches.forEach(function(m) {
      var p = (m.participants || [{}])[0];
      if (!p || !p.championId) return;
      var cid = p.championId;
      if (!champAgg[cid]) champAgg[cid] = { wins: 0, total: 0 };
      champAgg[cid].total++;
      if (m.stats && m.stats.win) champAgg[cid].wins++;
    });

    var sorted = Object.keys(champAgg).sort(function(a,b) { return champAgg[b].total - champAgg[a].total; }).slice(0, 6);

    // Render most played
    var mpHtml = '<div class="most-played"><div class="sec-label" style="margin-bottom:6px">nejhranější champiové</div><div class="mp-grid">';
    sorted.forEach(function(cid) {
      var a = champAgg[cid];
      var wr = Math.round(a.wins / a.total * 100);
      var img = champImg(champMap[parseInt(cid)] || "");
      mpHtml +=
        '<div class="mp-item">' +
        (img ? '<img src="' + img + '" onerror="this.style.display=\'none\'">' : '') +
        '<div class="mp-name">' + (champMap[parseInt(cid)] || "?") + '</div>' +
        '<div class="mp-stats">' + a.total + ' her · ' + wr + '%</div>' +
        '</div>';
    });
    mpHtml += '</div></div>';

    // Render match history
    var histHtml = '<div class="sec-label" style="margin-bottom:6px">posledních ' + Math.min(matches.length,20) + ' zápasů</div>';
    matches.slice(0, 20).forEach(function(m) {
      var stats   = m.participants && m.participants[0] ? m.participants[0].stats : (m.stats || {});
      var champId = m.participants && m.participants[0] ? m.participants[0].championId : m.championId;
      var win     = stats && stats.win;
      var kills   = stats ? (stats.kills || 0) : 0;
      var deaths  = stats ? (stats.deaths || 0) : 0;
      var assists = stats ? (stats.assists || 0) : 0;
      var img     = champImg(champMap[champId] || "");
      var queueName = getQueueName(m.queueId);

      histHtml +=
        '<div class="match-row ' + (win ? "win" : "loss") + '">' +
        '<div class="match-champ">' + (img ? '<img src="' + img + '">' : '') + '</div>' +
        '<div class="match-info">' +
          '<div class="match-kda">' + kills + '/' + deaths + '/' + assists + '</div>' +
          '<div class="match-meta">' + queueName + '</div>' +
        '</div>' +
        '<span class="match-wr-badge ' + (win ? "badge-win" : "badge-loss") + '">' + (win ? "Výhra" : "Prohra") + '</span>' +
        '</div>';
    });

    scroll.innerHTML = mpHtml + histHtml;
  } catch(e) {
    scroll.innerHTML = '<p class="loading-txt">Nepodařilo se načíst historii.</p>';
  }
}

function closeProfile() {
  document.getElementById("profile-panel").classList.remove("open");
}

function getQueueName(id) {
  var map = { 420:"Ranked Solo",440:"Ranked Flex",450:"ARAM",400:"Normal Draft",430:"Normal Blind",900:"ARURF",1020:"OFA",1090:"TFT",1100:"TFT Ranked" };
  return map[id] || "Hra #" + id;
}

// ── Misc ──────────────────────────────────────────────────────
function setStatus(id, msg) {
  document.getElementById(id).innerHTML = '<p class="loading-txt"><span class="spinner"></span>' + msg + '</p>';
}

function escHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function closeMe() {
  overwolf.windows.getCurrentWindow(function(r) {
    overwolf.windows.hide(r.window.id, function() {});
  });
}

// ── Messages ──────────────────────────────────────────────────
overwolf.windows.onMessageReceived.addListener(function(msg) {
  if (msg.id === "load") load();
});

// ── Init ──────────────────────────────────────────────────────
loadChampMap().then(function() {
  // Okno se otevřelo → načti ihned
  load();
});
