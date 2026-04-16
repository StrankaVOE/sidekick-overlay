// ============================================================
// Sidekick — In-Game Overlay
// ============================================================

const LIVE_API   = "http://127.0.0.1:2999/liveclientdata";
const DDRAGON    = "https://ddragon.leagueoflegends.com/cdn/14.10.1";
const CLAUDE_MDL = "claude-sonnet-4-20250514";

var pollTimer    = null;
var itemsLoaded  = false;
var gameData     = null;
var itemsData    = {};   // id → {name, description}

// ── Live Client API ───────────────────────────────────────────
async function liveGet(endpoint) {
  var r = await fetch(LIVE_API + endpoint);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// ── DDragon item data ─────────────────────────────────────────
async function loadItemData() {
  try {
    var r = await fetch(DDRAGON + "/data/en_US/item.json");
    var d = await r.json();
    Object.entries(d.data).forEach(function([id, item]) {
      itemsData[id] = { name: item.name, gold: item.gold.total };
    });
  } catch(e) { console.warn("Item data load failed:", e); }
}

// ── Render win chance ─────────────────────────────────────────
function renderWinChance(pct) {
  pct = Math.max(5, Math.min(95, Math.round(pct)));
  document.getElementById("pct-ally").textContent  = pct + "%";
  document.getElementById("pct-enemy").textContent = (100 - pct) + "%";
  document.getElementById("bar-fill").style.width  = pct + "%";
  document.getElementById("bar-fill").style.background =
    pct >= 60 ? "#4ade80" : pct <= 40 ? "#f87171" : "#60a5fa";
}

// ── Render items ──────────────────────────────────────────────
function renderItems(items) {
  // items = [{id, name, reason}]
  var grid = document.getElementById("items-grid");
  grid.innerHTML = "";
  var slots = items.slice(0, 6);
  while (slots.length < 6) slots.push(null);

  slots.forEach(function(item, i) {
    var div = document.createElement("div");
    div.className = "item-slot" + (item ? "" : " empty");
    if (item) {
      div.innerHTML =
        '<span class="item-order">' + (i+1) + '</span>' +
        '<img src="' + DDRAGON + '/img/item/' + item.id + '.png" onerror="this.src=\'\'">' +
        '<div class="item-tip">' + (item.name || "") + '</div>';
    } else {
      div.textContent = "·";
    }
    grid.appendChild(div);
  });
}

// ── Render tip ────────────────────────────────────────────────
function renderTip(text, loading) {
  var el = document.getElementById("tip-box");
  el.className = "tip-box" + (loading ? " loading" : "");
  el.innerHTML = loading
    ? '<span class="spinner"></span>' + text
    : text;
}

// ── Win chance calculation (local) ────────────────────────────
function calcWinChance(data) {
  var ally = 0, enemy = 0;
  (data.allPlayers || []).forEach(function(p) {
    var s = p.scores || {};
    var pts = (s.kills || 0) * 3 + (s.assists || 0) * 1.5 - (s.deaths || 0) * 2
            + (s.creepScore || 0) / 12;
    if (p.team === "ORDER") ally  += pts;
    else                     enemy += pts;
  });
  // Přidej pár bodů za události
  (((data.events || {}).Events) || []).forEach(function(ev) {
    if (ev.EventName === "TurretKilled") {
      if ((ev.KillerName || "").startsWith("T_T2_")) enemy += 8;
      else ally += 8;
    }
    if (ev.EventName === "DragonKill")  { if (ev.Assisters) ally  += 6; else enemy += 6; }
    if (ev.EventName === "BaronKill")   { if (ev.Assisters) ally  += 15; else enemy += 15; }
  });
  var total = Math.abs(ally) + Math.abs(enemy);
  if (total < 1) return 50;
  return Math.round((ally / total) * 100);
}

// ── AI item recommendations ───────────────────────────────────
async function getItemRecommendations(data) {
  var me = (data.allPlayers || []).find(function(p) { return p.summonerName === (data.activePlayer || {}).summonerName; });
  var myChamp = me ? me.championName : "Unknown";
  var myTeam  = (data.allPlayers || []).filter(function(p) { return p.team === (me ? me.team : "ORDER"); }).map(function(p) { return p.championName; }).join(", ");
  var enemies = (data.allPlayers || []).filter(function(p) { return p.team !== (me ? me.team : "ORDER"); }).map(function(p) { return p.championName; }).join(", ");
  var gameMin = Math.floor(((data.gameData || {}).gameTime || 0) / 60);

  var prompt = "Hráč hraje " + myChamp + ". Ally: " + myTeam + ". Enemy: " + enemies + ". " + gameMin + " minut ve hře.\n" +
    "Vrať JSON bez markdownu:\n{\"items\":[{\"id\":\"3153\",\"name\":\"Blade of the Ruined King\",\"reason\":\"důvod\"},{...}],\"tip\":\"1 věta doporučení\",\"winChance\":55}\n" +
    "Uveď 6 nejlepších itemů v pořadí pořízení. id = LoL item ID z data dragon.";

  var r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MDL, max_tokens: 600,
      system: "Jsi LoL asistent. Odpovídej POUZE čistý JSON.",
      messages: [{ role: "user", content: prompt }]
    })
  });
  var d = await r.json();
  var text = (d.content || [{}])[0].text || "";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ── Poll loop ─────────────────────────────────────────────────
async function poll() {
  try {
    var data = await liveGet("/allgamedata");
    gameData = data;

    // Win chance — lokální výpočet každý poll
    renderWinChance(calcWinChance(data));

    // Items + AI tip — jen jednou na začátku nebo po 5 minutách
    if (!itemsLoaded) {
      itemsLoaded = true;
      renderTip("Generuji doporučení...", true);
      try {
        var ai = await getItemRecommendations(data);
        renderItems(ai.items || []);
        renderTip(ai.tip || "Vše vypadá OK.", false);
        if (ai.winChance) renderWinChance(ai.winChance);
      } catch(e) {
        renderItems([]);
        renderTip("AI doporučení se nezdařilo.", false);
      }
    }
  } catch(e) {
    // Live API ještě není ready, zkusíme příště
  }
}

function startPolling() {
  if (pollTimer) return;
  poll();
  pollTimer = setInterval(poll, 8000);
}

// ── Messages z background ─────────────────────────────────────
overwolf.windows.onMessageReceived.addListener(function(msg) {
  if (msg.id === "gameStarted") {
    itemsLoaded = false;
    gameData    = null;
    loadItemData().then(startPolling);
  }
});

// ── Controls ──────────────────────────────────────────────────
function hideMe() {
  overwolf.windows.getCurrentWindow(function(r) {
    overwolf.windows.hide(r.window.id, function() {});
  });
}

// ── Init ──────────────────────────────────────────────────────
loadItemData();
// Zkus hned — může být otevřeno manuálně nebo hra už běží
setTimeout(startPolling, 2000);
