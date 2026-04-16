// ============================================================
// Sidekick — Background v37
// LoL/TFT → LCU (launcher events)   — ZCELA nezávislé
// Valorant → Riot lockfile → PD API — ZCELA nezávislé
// ============================================================

const GAME_IDS = {
  5426:  { name:"League of Legends", short:"lol"  },
  21640: { name:"Valorant",          short:"valo" },
};
var TFT_QUEUES = [1090,1100,1130,1160,1180,6000,1400];

// ── Shared state ──────────────────────────────────────────────
window.lcuPort      = null;
window.lcuToken     = null;
window.lcuStatus    = "Čekám na League Client...";
window.currentPhase = null;
window.activeGame   = null;
window.debugLogs    = [];
window.lolInGame    = false;
window.isTftMode    = false;
window.valoAuth     = null;
window.riotId       = null;
window.riotIconUrl  = null;
window.riotPuuid    = null;

window.state = {
  autoAccept:   localStorage.getItem("autoAccept") !== "false",
  mainWindowId: null,
  detectedGames: [],
  // Spam Queue settings
  spamRankedLol:   localStorage.getItem("spamRankedLol") === "true",
  spamFlexLol:     localStorage.getItem("spamFlexLol") === "true",
  spamRankedTft:   localStorage.getItem("spamRankedTft") === "true",
  spamDoubleUpTft: localStorage.getItem("spamDoubleUpTft") === "true",
  ingameOverlay:   localStorage.getItem("ingameOverlay") !== "false",
  // Spam Queue status info
  spamStatus: {
    lolRanked: null,   // null, "lobby", "queue", "waiting"
    lolFlex: null,
    tftRanked: null,
    tftDoubleUp: null,
    lobbyMembers: 0,
    lobbyMaxSize: 0
  }
};

// Queue IDs
var QUEUE_IDS = {
  rankedSolo:  420,
  rankedFlex:  440,
  tftRanked:   1100,
  tftDoubleUp: 1160,
};

// ── Log ───────────────────────────────────────────────────────
function log(msg) {
  var t = new Date().toLocaleTimeString("cs-CZ");
  console.log("[SK]", msg);
  window.debugLogs.push("[" + t + "] " + msg);
  if (window.debugLogs.length > 200) window.debugLogs.shift();
  safeNotifyMain("stateUpdate", buildState());
}

// ══════════════════════════════════════════════════════════════
// ── LCU (LoL + TFT) — ZCELA nezávislé na Valo ────────────────
// ══════════════════════════════════════════════════════════════

function lcuRequest(method, endpoint, body, cb) {
  if (!window.lcuPort || !window.lcuToken) { cb(null); return; }
  var headers = [
    { key:"Authorization", value:"Basic " + window.lcuToken },
    { key:"Accept",        value:"application/json" },
    { key:"Content-Type",  value:"application/json" },
  ];
  overwolf.web.sendHttpRequest(
    "https://127.0.0.1:" + window.lcuPort + endpoint,
    overwolf.web.enums.HttpRequestMethods[method],
    headers, body ? String(body) : "",
    function(r) {
      if (!r.success || r.status === 404 || r.status === 0) { cb(null); return; }
      if (!r.data || r.data === "") { cb({}); return; }
      try { cb(JSON.parse(r.data)); } catch(ex) { cb(null); }
    }
  );
}
window.lcuRequest = lcuRequest;

var lcuUpdateInterval  = null;
var lcuValid           = false;
var featuresRegistered = false;

function startLcuPolling() {
  if (lcuUpdateInterval) return;
  log("LCU polling start");
  updateLcuState();
  lcuUpdateInterval = setInterval(updateLcuState, 12000);
  overwolf.games.launchers.onLaunched.addListener(function(info) {
    if (info && info.classId === 10902) setTimeout(updateLcuState, 2000);
  });
  overwolf.games.launchers.onTerminated.addListener(function(info) {
    if (info && info.classId === 10902) onLcuDisconnected();
  });
}

function updateLcuState() {
  setTimeout(function() {
    overwolf.games.launchers.events.getInfo(10902, function(e) {
      if (!e || !e.success || !e.res) { if (lcuValid) onLcuDisconnected(); return; }
      var res   = e.res;
      var creds = res.credentials;
      if (creds && creds.port && creds.token) {
        applyLcu(String(creds.port), String(creds.token));
        return;
      }
      var lcu = res.lcu_info;
      if (lcu) {
        var port = lcu["app-port"] || lcu.port;
        var pw   = lcu["remoting-auth-token"] || lcu.token;
        if (port && pw) { applyLcu(String(port), btoa("riot:" + String(pw))); return; }
      }
      if (lcuValid) onLcuDisconnected();
    });
  }, 1000);
}

function applyLcu(port, token) {
  if (port === window.lcuPort && token === window.lcuToken && lcuValid) return;
  window.lcuPort  = port;
  window.lcuToken = token;
  lcuValid        = true;
  window.lcuStatus = "LoL připojeno · port " + port;
  log("✓ LCU port=" + port);
  if (!window.state.detectedGames.includes(5426)) window.state.detectedGames.push(5426);
  window.activeGame = { id:5426, name:"League of Legends", short:"lol" };
  if (!featuresRegistered) registerLauncherFeatures();
  startGameflowPolling();
  if (window.state.autoAccept) scheduleAutoAccept();
  fetchRiotIdFromLcu();
  broadcastState();
  
  // Pokud je spam queue zapnutý, spusť queue po připojení
  setTimeout(function() {
    if (!window.lolInGame) {
      if (window.state.spamRankedLol) startSpamQueue(QUEUE_IDS.rankedSolo);
      else if (window.state.spamFlexLol) startSpamQueue(QUEUE_IDS.rankedFlex);
      else if (window.state.spamRankedTft) startSpamQueue(QUEUE_IDS.tftRanked);
      else if (window.state.spamDoubleUpTft) startSpamQueue(QUEUE_IDS.tftDoubleUp);
    }
  }, 3000);
}

function fetchRiotIdFromLcu() {
  lcuRequest("GET", "/lol-summoner/v1/current-summoner", null, function(s) {
    if (!s || !s.puuid) return;
    var name = s.gameName || s.displayName || null;
    var tag  = s.tagLine  || null;
    var rid  = name ? (tag ? name + "#" + tag : name) : null;
    var icon = s.profileIconId
      ? "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/" + s.profileIconId + ".jpg"
      : null;
    if (rid && rid !== window.riotId) {
      window.riotId      = rid;
      window.riotIconUrl = icon;
      window.riotPuuid   = s.puuid;
      log("✓ Riot ID: " + rid);
      safeNotifyMain("riotIdReady", { riotId:rid, iconUrl:icon, puuid:s.puuid });
    }
  });
}

function registerLauncherFeatures() {
  overwolf.games.launchers.events.setRequiredFeatures(10902, ["game_flow","champ_select","summoner_info"], function(r) {
    if (!r.success) { setTimeout(registerLauncherFeatures, 1500); return; }
    featuresRegistered = true;
  });
  overwolf.games.launchers.events.onInfoUpdates.addListener(function(e) {
    if (e.launcherClassId !== 10902) return;
    if (e.feature === "game_flow") {
      var gf = e.info && e.info.game_flow, ph = gf && gf.phase;
      if (gf && !ph) { try { ph = JSON.parse(String(gf)).phase; } catch(ex){} }
      if (ph) handlePhase(ph);
    }
    if (e.feature === "champ_select" && e.info && e.info.champ_select && e.info.champ_select.raw) {
      try { window._lastChampSelectSession = JSON.parse(e.info.champ_select.raw); } catch(ex){}
    }
    if (e.feature === "summoner_info") setTimeout(fetchRiotIdFromLcu, 500);
  });
}

function checkTftMode() {
  lcuRequest("GET", "/lol-gameflow/v1/session", null, function(session) {
    if (!session || !session.gameData) return;
    var q     = session.gameData.queue;
    var isTft = q && (q.gameMode === "TFT" || TFT_QUEUES.indexOf(q.id) !== -1);
    var short = isTft ? "tft" : "lol";
    if (!!isTft !== window.isTftMode) {
      window.isTftMode  = !!isTft;
      window.activeGame = { id:5426, name:(isTft ? "TFT" : "League of Legends"), short:short };
      broadcastState();
    }
  });
}

var gameflowTimer = null;
function startGameflowPolling() {
  if (gameflowTimer) return;
  pollPhase(); gameflowTimer = setInterval(pollPhase, 3000);
}
function stopGameflowPolling() { if (gameflowTimer) { clearInterval(gameflowTimer); gameflowTimer = null; } }
function pollPhase() {
  if (!window.lcuPort) return;
  lcuRequest("GET", "/lol-gameflow/v1/gameflow-phase", null, function(phase) {
    if (typeof phase === "string") {
      handlePhase(phase);
      if (phase !== "None" && phase !== "WaitingForStats" && phase !== "EndOfGame") checkTftMode();
    }
  });
}

var autoAcceptDone = false, aaTimer = null;
function handlePhase(phase) {
  if (phase === window.currentPhase) return;
  log("Fáze: " + (window.currentPhase||"None") + " → " + phase);
  var prevPhase = window.currentPhase;
  window.currentPhase = phase;
  if (phase !== "ReadyCheck") autoAcceptDone = false;
  broadcastState();
  if (phase === "ChampSelect") {
    openWin("champ_select", function(id) { setTimeout(function(){ overwolf.windows.sendMessage(id,"load",{},function(){}); },500); });
    closeWin("ingame_overlay"); closeWin("team_overlay");
  } else if (phase === "ReadyCheck") {
    closeWin("champ_select"); if (window.state.autoAccept) scheduleAutoAccept();
  } else if (phase === "None" || phase === "Lobby") {
    closeWin("champ_select");
    // Po skončení hry (EndOfGame/WaitingForStats → None) spusť spam queue
    if (prevPhase === "EndOfGame" || prevPhase === "WaitingForStats" || prevPhase === "PreEndOfGame") {
      checkAndTriggerSpamQueue();
    }
  } else {
    closeWin("champ_select");
  }
}
function scheduleAutoAccept() { clearInterval(aaTimer); aaTimer=setInterval(doAutoAccept,1500); doAutoAccept(); }
function doAutoAccept() {
  if (!window.state.autoAccept || autoAcceptDone || window.currentPhase !== "ReadyCheck") { clearInterval(aaTimer); return; }
  lcuRequest("GET","/lol-matchmaking/v1/ready-check",null,function(data) {
    if (!data) return;
    var resp = data.localPlayerResponse || data.playerResponse;
    if (data.state === "InProgress" && resp === "None" && !autoAcceptDone) {
      lcuRequest("POST","/lol-matchmaking/v1/ready-check/accept","",function(res) {
        if (res !== null) { autoAcceptDone=true; clearInterval(aaTimer); safeNotifyMain("autoAccepted",{}); }
      });
    }
  });
}
function onLcuDisconnected() {
  lcuValid=false; featuresRegistered=false;
  window.lcuPort=null; window.lcuToken=null;
  window.lcuStatus="Čekám na League Client..."; window.currentPhase=null;
  window.isTftMode=false;
  window.state.detectedGames = window.state.detectedGames.filter(function(id){return id!==5426;});
  if (!window.state.detectedGames.includes(21640)) window.activeGame = null;
  stopGameflowPolling(); clearInterval(aaTimer); closeWin("champ_select"); broadcastState();
}

// ══════════════════════════════════════════════════════════════
// ── VALORANT — lockfile → entitlements → PD API ───────────────
// ZCELA nezávislé na LCU/LoL
// ══════════════════════════════════════════════════════════════

var VALO_LOCKFILE_PATHS = [
  "C:\\Riot Games\\Riot Client\\Config\\lockfile",
  "D:\\Riot Games\\Riot Client\\Config\\lockfile",
  "E:\\Riot Games\\Riot Client\\Config\\lockfile",
  "C:\\Program Files\\Riot Games\\Riot Client\\Config\\lockfile",
  "C:\\Program Files (x86)\\Riot Games\\Riot Client\\Config\\lockfile",
];
var REGION_TO_SHARD = {
  "na1":"na","na":"na",
  "euw1":"eu","eun1":"eu","eu":"eu","eune":"eu",
  "kr":"ap","jp1":"ap","jp":"ap","sg2":"ap","ap":"ap",
  "br1":"br","br":"br",
  "latam":"latam","la1":"latam","la2":"latam",
};
var DEFAULT_CV = "release-09.10-shipping-9-2665644";
var valoLockIdx  = 0;
var valoConnected = false;
var valoInterval  = null;

function startValoPolling() {
  if (valoInterval) return;
  log("Valo polling start");
  valoLockIdx = 0;
  tryLockfile();
  valoInterval = setInterval(function() {
    if (!valoConnected) { valoLockIdx=0; tryLockfile(); }
  }, 15000);
}

function tryLockfile() {
  if (valoLockIdx >= VALO_LOCKFILE_PATHS.length) { return; }
  var path = VALO_LOCKFILE_PATHS[valoLockIdx++];
  overwolf.io.readTextFile(path, { encoding:"UTF8" }, function(r) {
    if (r && r.success && r.content) parseLockfile(r.content);
    else tryLockfile();
  });
}

function parseLockfile(content) {
  var parts = content.trim().split(":");
  if (parts.length < 5) return;
  var port  = parts[2];
  var pass  = parts[3];
  var token = btoa("riot:" + pass);
  log("✓ Valo lockfile port=" + port);
  connectValo(port, token);
}

function connectValo(port, rawToken) {
  var base    = "https://127.0.0.1:" + port;
  var headers = [
    { key:"Authorization", value:"Basic " + rawToken },
    { key:"Accept",        value:"application/json" },
  ];
  overwolf.web.sendHttpRequest(
    base + "/entitlements/v1/token",
    overwolf.web.enums.HttpRequestMethods["GET"],
    headers, "",
    function(r) {
      if (!r.success || !r.data) { log("Valo: entitlements fail " + (r&&r.status)); return; }
      var d; try { d = JSON.parse(r.data); } catch(ex) { return; }
      var at   = d.accessToken, et = d.token, puuid = d.subject;
      if (!at || !puuid) { log("Valo: chybí token/puuid"); return; }
      log("✓ Valo entitlements puuid=" + puuid.slice(0,8));
      // Region z riotclient
      overwolf.web.sendHttpRequest(
        base + "/riotclient/get_region_locale",
        overwolf.web.enums.HttpRequestMethods["GET"],
        headers, "",
        function(r2) {
          var shard = "eu";
          if (r2.success && r2.data) {
            try { var rl=JSON.parse(r2.data); shard=REGION_TO_SHARD[(rl.region||"eu").toLowerCase()]||"eu"; } catch(ex){}
          }
          // Client version z valorant-api.com
          overwolf.web.sendHttpRequest(
            "https://valorant-api.com/v1/version",
            overwolf.web.enums.HttpRequestMethods["GET"],
            [{key:"Accept",value:"application/json"}], "",
            function(rv) {
              var cv = DEFAULT_CV;
              if (rv&&rv.success&&rv.data) { try { cv=JSON.parse(rv.data).data.riotClientVersion||cv; } catch(ex){} }
              finalizeValo(at, et, puuid, shard, cv);
            }
          );
        }
      );
    }
  );
}

function finalizeValo(at, et, puuid, shard, cv) {
  window.valoAuth = {
    accessToken:at, entitlementToken:et,
    puuid:puuid, shard:shard,
    pdBase:"https://pd." + shard + ".a.pvp.net",
    clientVersion:cv,
  };
  valoConnected = true;
  log("✓ Valo auth ready shard=" + shard);
  if (!window.state.detectedGames.includes(21640)) window.state.detectedGames.push(21640);
  broadcastState();
  safeNotifyMain("valoAuthReady", { puuid:puuid, shard:shard });
}

// PD API (volaná z main okna)
window.valoRequest = function(endpoint, cb) {
  var auth = window.valoAuth;
  if (!auth) { cb(null); return; }
  var headers = [
    { key:"Authorization",           value:"Bearer " + auth.accessToken },
    { key:"X-Riot-Entitlements-JWT", value:auth.entitlementToken },
    { key:"X-Riot-ClientPlatform",   value:"ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9" },
    { key:"X-Riot-ClientVersion",    value:auth.clientVersion },
    { key:"Accept",                  value:"application/json" },
  ];
  overwolf.web.sendHttpRequest(
    auth.pdBase + endpoint,
    overwolf.web.enums.HttpRequestMethods["GET"],
    headers, "",
    function(r) {
      if (!r.success || !r.data) { log("valoReq fail: " + endpoint + " status=" + (r&&r.status)); cb(null); return; }
      try { cb(JSON.parse(r.data)); } catch(ex) { cb(null); }
    }
  );
};

// ══════════════════════════════════════════════════════════════
// ── Game Events ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

function initGameEvents() {
  overwolf.games.getRunningGameInfo(function(info) {
    if (info && info.isRunning && info.classId) onGameStarted(info.classId);
  });
  overwolf.games.onGameInfoUpdated.addListener(function(info) {
    if (!info || !info.gameInfo || !info.runningChanged) return;
    var gi  = info.gameInfo;
    var gid = gi.classId || Math.floor((gi.id||0)/10);
    if (!gid) return;
    if (gi.isRunning) onGameStarted(gid); else onGameStopped(gid);
  });
}
function onGameStarted(gameId) {
  var game = GAME_IDS[gameId];
  if (!game) return;
  window.activeGame = { id:gameId, name:game.name, short:game.short };
  if (!window.state.detectedGames.includes(gameId)) window.state.detectedGames.push(gameId);
  if (gameId === 5426) {
    window.lolInGame = true; checkTftMode();
    // Otevři ingame overlay pouze pokud je povolený
    if (window.state.ingameOverlay) {
      setTimeout(function(){
        openWin("ingame_overlay", function(id){ setTimeout(function(){ overwolf.windows.sendMessage(id,"gameStarted",{},function(){}); },500); });
      }, 5000);
    }
  }
  if (gameId === 21640 && !valoConnected) { valoConnected=false; valoLockIdx=0; setTimeout(tryLockfile,3000); }
  broadcastState();
}
function onGameStopped(gameId) {
  if (window.activeGame && window.activeGame.id === gameId) window.activeGame = null;
  window.state.detectedGames = window.state.detectedGames.filter(function(id){return id!==gameId;});
  if (gameId === 5426) { window.lolInGame=false; window.isTftMode=false; closeWin("ingame_overlay"); closeWin("team_overlay"); }
  if (gameId === 21640) { valoConnected=false; window.valoAuth=null; }
  broadcastState();
}

// ══════════════════════════════════════════════════════════════
// ── Windows ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

var wins = {};
function getWin(name, cb) {
  if (wins[name] && wins[name].id) { cb(wins[name].id); return; }
  overwolf.windows.obtainDeclaredWindow(name, function(r) {
    if (r.success) { wins[name]={id:r.window.id,visible:false}; cb(wins[name].id); }
    else log("obtainDeclaredWindow FAIL " + name + ": " + JSON.stringify(r));
  });
}
function openWin(name, onOpen) {
  if (wins[name] && wins[name].visible) { if (onOpen && wins[name].id) onOpen(wins[name].id); return; }
  getWin(name, function(id) {
    overwolf.windows.restore(id, function() { wins[name].visible=true; if (onOpen) onOpen(id); });
  });
}
function closeWin(name) {
  if (!wins[name]||!wins[name].id||!wins[name].visible) return;
  overwolf.windows.hide(wins[name].id, function(){ wins[name].visible=false; });
}
function toggleWin(name, onOpen) {
  if (wins[name] && wins[name].visible) closeWin(name); else openWin(name, onOpen);
}
window.closeChampSelect = function(){ closeWin("champ_select"); };
window.openChampSelect  = function(){
  openWin("champ_select", function(id){ setTimeout(function(){ overwolf.windows.sendMessage(id,"load",{},function(){}); },300); });
};
overwolf.settings.hotkeys.onPressed.addListener(function(ev) {
  if (ev.name === "toggle_overlay") toggleWin("team_overlay", function(id){
    setTimeout(function(){ overwolf.windows.sendMessage(id,"load",{},function(){}); },300);
  });
});

// ══════════════════════════════════════════════════════════════
// ── Comms ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════

function buildState() {
  return {
    lcuStatus:     window.lcuStatus,
    lcuPort:       window.lcuPort,
    currentPhase:  window.currentPhase,
    autoAccept:    window.state.autoAccept,
    activeGame:    window.activeGame,
    detectedGames: window.state.detectedGames,
    lolInGame:     window.lolInGame,
    isTftMode:     window.isTftMode,
    valoConnected: !!window.valoAuth,
    riotId:        window.riotId,
    riotIconUrl:   window.riotIconUrl,
    riotPuuid:     window.riotPuuid,
    debugLogs:     window.debugLogs.slice(-30),
    // Spam Queue states
    spamRankedLol:   window.state.spamRankedLol,
    spamFlexLol:     window.state.spamFlexLol,
    spamRankedTft:   window.state.spamRankedTft,
    spamDoubleUpTft: window.state.spamDoubleUpTft,
    ingameOverlay:   window.state.ingameOverlay,
    // Spam Queue status info
    spamStatus:      window.state.spamStatus,
  };
}

function broadcastState() { safeNotifyMain("stateUpdate", buildState()); }

function safeNotifyMain(type, data) {
  if (!window.state.mainWindowId) return;
  try { overwolf.windows.sendMessage(window.state.mainWindowId, type, data, function(){}); } catch(ex){}
}

function openMain() {
  overwolf.windows.obtainDeclaredWindow("main", function(r) {
    if (!r.success) { setTimeout(openMain, 1000); return; }
    window.state.mainWindowId = r.window.id;
    wins["main"] = { id:r.window.id, visible:true };
    overwolf.windows.restore(r.window.id, function(){
      // Hned po otevření pošleme full state
      setTimeout(broadcastState, 300);
    });
  });
}

window.setAutoAccept = function(v) {
  window.state.autoAccept=v; localStorage.setItem("autoAccept",String(v)); broadcastState();
};

// ── Spam Queue setters ────────────────────────────────────────
window.setSpamRankedLol = function(v) {
  window.state.spamRankedLol=v; localStorage.setItem("spamRankedLol",String(v));
  if (v) { 
    window.state.spamFlexLol = false; 
    localStorage.setItem("spamFlexLol","false"); 
    // Pokud jsme v queue na flex, stopni ho a přepni na ranked
    stopCurrentQueueAndSwitch(QUEUE_IDS.rankedSolo);
  } else {
    stopSpamStatusPolling();
    updateSpamStatus("lolRanked", null);
  }
  broadcastState();
};
window.setSpamFlexLol = function(v) {
  window.state.spamFlexLol=v; localStorage.setItem("spamFlexLol",String(v));
  if (v) { 
    window.state.spamRankedLol = false; 
    localStorage.setItem("spamRankedLol","false"); 
    // Pokud jsme v queue na ranked, stopni ho a přepni na flex
    stopCurrentQueueAndSwitch(QUEUE_IDS.rankedFlex);
  } else {
    stopSpamStatusPolling();
    updateSpamStatus("lolFlex", null);
  }
  broadcastState();
};
window.setSpamRankedTft = function(v) {
  window.state.spamRankedTft=v; localStorage.setItem("spamRankedTft",String(v));
  if (v) { 
    // Vyčisti starý status z DoubleUp
    updateSpamStatus("tftDoubleUp", null);
    window.state.spamDoubleUpTft = false; 
    localStorage.setItem("spamDoubleUpTft","false"); 
    // Stopni polling, pak přepni
    stopSpamStatusPolling();
    stopCurrentQueueAndSwitch(QUEUE_IDS.tftRanked);
  } else {
    stopSpamStatusPolling();
    updateSpamStatus("tftRanked", null);
  }
  broadcastState();
};
window.setSpamDoubleUpTft = function(v) {
  window.state.spamDoubleUpTft=v; localStorage.setItem("spamDoubleUpTft",String(v));
  if (v) { 
    // Vyčisti starý status z Ranked
    updateSpamStatus("tftRanked", null);
    window.state.spamRankedTft = false; 
    localStorage.setItem("spamRankedTft","false"); 
    // Stopni polling, pak přepni
    stopSpamStatusPolling();
    stopCurrentQueueAndSwitch(QUEUE_IDS.tftDoubleUp);
  } else {
    stopSpamStatusPolling();
    updateSpamStatus("tftDoubleUp", null);
  }
  broadcastState();
};
window.setIngameOverlay = function(v) {
  window.state.ingameOverlay=v; localStorage.setItem("ingameOverlay",String(v)); broadcastState();
};

// ── Spam Queue Logic ──────────────────────────────────────────
var spamQueueDelay = null;
var spamStatusInterval = null;

// Helper pro aktualizaci spam statusu
function updateSpamStatus(key, status, lobbyMembers, lobbyMaxSize) {
  window.state.spamStatus[key] = status;
  if (lobbyMembers !== undefined) window.state.spamStatus.lobbyMembers = lobbyMembers;
  if (lobbyMaxSize !== undefined) window.state.spamStatus.lobbyMaxSize = lobbyMaxSize;
  broadcastState();
}

// Získej klíč pro aktuální spam mód
function getActiveSpamKey() {
  if (window.state.spamRankedLol) return "lolRanked";
  if (window.state.spamFlexLol) return "lolFlex";
  if (window.state.spamRankedTft) return "tftRanked";
  if (window.state.spamDoubleUpTft) return "tftDoubleUp";
  return null;
}

// Zastavení queue a přepnutí na nový
function stopCurrentQueueAndSwitch(newQueueId) {
  if (!window.lcuPort || !window.lcuToken) return;
  
  // Nejprve zkus zastavit aktuální matchmaking search
  lcuRequest("DELETE", "/lol-lobby/v2/lobby/matchmaking/search", null, function(res) {
    log("Spam Queue: Zastavuji aktuální queue pro přepnutí...");
    // Po zastavení spusť nový queue
    setTimeout(function() {
      if (!window.lolInGame) startSpamQueue(newQueueId);
    }, 500);
  });
}

// Polling pro stav lobby/queue - každé 2 sekundy
function startSpamStatusPolling() {
  if (spamStatusInterval) return;
  pollSpamStatus();
  spamStatusInterval = setInterval(pollSpamStatus, 2000);
}

function stopSpamStatusPolling() {
  if (spamStatusInterval) {
    clearInterval(spamStatusInterval);
    spamStatusInterval = null;
  }
}

function pollSpamStatus() {
  if (!window.lcuPort || !window.lcuToken) return;
  var activeKey = getActiveSpamKey();
  if (!activeKey) { stopSpamStatusPolling(); return; }
  
  // Zkontroluj stav lobby
  lcuRequest("GET", "/lol-lobby/v2/lobby", null, function(lobby) {
    if (!lobby) {
      updateSpamStatus(activeKey, "waiting", 0, 0);
      return;
    }
    
    var members = (lobby.members || []).length;
    var maxSize = (lobby.gameConfig && lobby.gameConfig.maxLobbySize) || 5;
    
    // Zkontroluj stav matchmaking
    lcuRequest("GET", "/lol-lobby/v2/lobby/matchmaking/search-state", null, function(searchState) {
      if (searchState && (searchState.searchState === "Searching" || searchState.searchState === "Found")) {
        updateSpamStatus(activeKey, "queue", members, maxSize);
      } else if (lobby) {
        updateSpamStatus(activeKey, "lobby", members, maxSize);
        // Pokud jsme v lobby ale ne v queue, zkus spustit matchmaking
        tryStartMatchmaking();
      } else {
        updateSpamStatus(activeKey, "waiting", 0, 0);
      }
    });
  });
}

function tryStartMatchmaking() {
  if (!window.lcuPort || !window.lcuToken || window.lolInGame) return;
  
  lcuRequest("POST", "/lol-lobby/v2/lobby/matchmaking/search", "", function(searchRes) {
    if (searchRes === null) {
      // Zkus alternativní endpoint
      lcuRequest("POST", "/lol-lobby-team-builder/v1/matchmaking/search", "", function(altRes) {
        if (altRes !== null) log("Spam Queue: Matchmaking spuštěn (retry)");
      });
    }
  });
}

function startSpamQueue(queueId) {
  if (!window.lcuPort || !window.lcuToken) return;
  var activeKey = getActiveSpamKey();
  log("Spam Queue: Spouštím lobby queueId=" + queueId);
  
  if (activeKey) updateSpamStatus(activeKey, "waiting", 0, 0);
  
  // 1. Vytvoř lobby
  lcuRequest("POST", "/lol-lobby/v2/lobby", JSON.stringify({ queueId: queueId }), function(lobbyRes) {
    if (!lobbyRes) { 
      log("Spam Queue: Nepodařilo se vytvořit lobby"); 
      if (activeKey) updateSpamStatus(activeKey, "waiting", 0, 0);
      // Zkusíme znovu za 2 sekundy
      startSpamStatusPolling();
      return; 
    }
    
    var members = (lobbyRes.members || []).length;
    var maxSize = (lobbyRes.gameConfig && lobbyRes.gameConfig.maxLobbySize) || 5;
    if (activeKey) updateSpamStatus(activeKey, "lobby", members, maxSize);
    
    log("Spam Queue: Lobby vytvořeno, startuji matchmaking...");
    
    // 2. Počkej chvíli a spusť matchmaking
    setTimeout(function() {
      lcuRequest("POST", "/lol-lobby/v2/lobby/matchmaking/search", "", function(searchRes) {
        if (searchRes === null) {
          // Zkus alternativní endpoint
          lcuRequest("POST", "/lol-lobby-team-builder/v1/matchmaking/search", "", function(altRes) {
            if (altRes !== null) {
              log("Spam Queue: Matchmaking spuštěn (alt endpoint)");
              if (activeKey) updateSpamStatus(activeKey, "queue", members, maxSize);
            } else {
              log("Spam Queue: Nepodařilo se spustit matchmaking");
            }
            // Spusť polling pro sledování stavu
            startSpamStatusPolling();
          });
        } else {
          log("Spam Queue: Matchmaking spuštěn");
          if (activeKey) updateSpamStatus(activeKey, "queue", members, maxSize);
          startSpamStatusPolling();
        }
      });
    }, 1500);
  });
}

function checkAndTriggerSpamQueue() {
  if (spamQueueDelay) { clearTimeout(spamQueueDelay); spamQueueDelay = null; }
  
  // Zjisti, který spam je aktivní (podle posledního módu hry)
  var queueId = null;
  if (window.isTftMode) {
    if (window.state.spamRankedTft) queueId = QUEUE_IDS.tftRanked;
    else if (window.state.spamDoubleUpTft) queueId = QUEUE_IDS.tftDoubleUp;
  } else {
    if (window.state.spamRankedLol) queueId = QUEUE_IDS.rankedSolo;
    else if (window.state.spamFlexLol) queueId = QUEUE_IDS.rankedFlex;
  }
  
  if (!queueId) return;
  
  var activeKey = getActiveSpamKey();
  if (activeKey) updateSpamStatus(activeKey, "waiting", 0, 0);
  
  // Delay před spuštěním nové queue - změněno na 2s
  log("Spam Queue: Hra skončila, čekám 2s před další queue...");
  spamQueueDelay = setTimeout(function() {
    startSpamQueue(queueId);
  }, 2000);
}
overwolf.windows.onMessageReceived.addListener(function(msg) {
  if (msg.id === "getState") broadcastState();
});

// ══════════════════════════════════════════════════════════════
// ── Init ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function init() {
  log("=== Sidekick v37 start ===");
  openMain();
  initGameEvents();
  setTimeout(startLcuPolling,  600);   // LCU — nezávisle
  setTimeout(startValoPolling, 1200);  // Valo — nezávisle
}
init();
