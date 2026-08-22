export const STATUS_DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AFK Pipeline Status</title><style>
    :root {
      color-scheme: light;
      --bg: #f2f4f6;
      --panel: #fff;
      --panel-2: #f7f9fa;
      --ink: #15212b;
      --muted: #63717d;
      --line: #cbd3da;
      --line-dark: #9da9b3;
      --nav: #17242e;
      --nav-2: #22333f;
      --done: #167047;
      --done-bg: #e4f3eb;
      --active: #1269a8;
      --active-bg: #e4f1fa;
      --queued: #6c7882;
      --queued-bg: #eef1f3;
      --blocked: #95630b;
      --blocked-bg: #fff2d2;
      --failed: #b42318;
      --failed-bg: #fde9e7;
      --planner: #5a4aa1;
      --planner-bg: #eeeafa;
      --generator: #086f83;
      --generator-bg: #e0f2f4;
      --radius: 6px;
      --mono: "Cascadia Code", Consolas, monospace;
      --sans: Inter, "Segoe UI", Arial, sans-serif;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      color: var(--ink);
      background: var(--bg);
      font-family: var(--sans);
      letter-spacing: 0;
    }
    button { font: inherit; letter-spacing: 0; cursor: pointer; }
    button:focus-visible {
      outline: 3px solid rgba(18, 105, 168, .28);
      outline-offset: 2px;
    }

    .app { min-height: 100vh; padding-bottom: 88px; }
    .topbar {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) auto;
      align-items: center;
      min-height: 62px;
      padding: 9px 22px;
      color: #fff;
      background: var(--nav);
      border-bottom: 1px solid #304350;
    }
    .brand { display: flex; align-items: center; min-width: 0; gap: 11px; }
    .mark {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border: 1px solid #617481;
      background: var(--nav-2);
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 800;
    }
    .brand h1 { margin: 0; font-size: 16px; }
    .brand p {
      margin: 3px 0 0;
      overflow: hidden;
      color: #aebbc5;
      font-family: var(--mono);
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .run-facts { display: flex; align-items: center; gap: 20px; }
    .fact span { display: block; color: #9eb0bd; font-size: 9px; text-transform: uppercase; }
    .fact strong { display: block; margin-top: 2px; font-family: var(--mono); font-size: 11px; }
    .live { color: #67d49a; }

    .wavebar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      align-items: stretch;
      min-height: 58px;
      padding: 0 22px;
      background: #fff;
      border-bottom: 1px solid var(--line);
    }
    .wave-tab {
      position: relative;
      display: grid;
      grid-template-columns: auto auto;
      align-content: center;
      gap: 2px 9px;
      min-width: 164px;
      padding: 8px 18px;
      border: 0;
      border-right: 1px solid #e1e5e8;
      color: var(--ink);
      background: transparent;
      text-align: left;
    }
    .wave-tab:first-child { border-left: 1px solid #e1e5e8; }
    .wave-tab.selected { background: #f1f6f9; }
    .wave-tab.selected::after {
      content: "";
      position: absolute;
      right: 0;
      bottom: 0;
      left: 0;
      height: 3px;
      background: var(--active);
    }
    .wave-tab strong { font-size: 12px; }
    .wave-tab small { grid-column: 1; color: var(--muted); font-size: 9px; }
    .wave-time {
      grid-row: 1 / 3;
      grid-column: 2;
      align-self: center;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 10px;
    }

    .dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      margin-right: 5px;
      border-radius: 50%;
      background: var(--state);
    }
    .status-done { --state: var(--done); --state-bg: var(--done-bg); }
    .status-active { --state: var(--active); --state-bg: var(--active-bg); }
    .status-queued { --state: var(--queued); --state-bg: var(--queued-bg); }
    .status-blocked { --state: var(--blocked); --state-bg: var(--blocked-bg); }
    .status-failed { --state: var(--failed); --state-bg: var(--failed-bg); }

    .workspace { max-width: 1600px; margin: 0 auto; padding: 18px 22px 30px; }
    .workspace-head {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 13px;
    }
    .workspace-head h2 { margin: 0; font-size: 19px; }
    .workspace-head p { margin: 4px 0 0; color: var(--muted); font-size: 11px; }
    .legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
    .legend span { color: var(--muted); font-size: 9px; font-weight: 700; text-transform: uppercase; }

    .wave-summary {
      display: grid;
      grid-template-columns: repeat(5, minmax(90px, 1fr));
      margin-bottom: 13px;
      border: 1px solid var(--line);
      background: var(--panel);
    }
    .summary-cell { padding: 9px 12px; border-right: 1px solid var(--line); }
    .summary-cell:last-child { border-right: 0; }
    .summary-cell span { display: block; color: var(--muted); font-size: 9px; text-transform: uppercase; }
    .summary-cell strong { display: block; margin-top: 3px; font-size: 14px; }

    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 19px;
      padding: 2px 6px;
      border: 1px solid color-mix(in srgb, var(--state) 45%, #fff);
      border-radius: 999px;
      color: var(--state);
      background: var(--state-bg);
      font-family: var(--mono);
      font-size: 8px;
      font-weight: 800;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .time {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 9px;
      white-space: nowrap;
    }
    .time.active { color: var(--active); font-weight: 800; }
    .lane-tag {
      display: inline-block;
      padding: 2px 5px;
      border: 1px solid #9caab4;
      border-radius: 3px;
      color: #46545f;
      background: #f3f5f6;
      font-family: var(--mono);
      font-size: 8px;
      font-weight: 800;
      text-transform: uppercase;
    }

    /* A: stage matrix with nested round strips */
    .stage-matrix-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      background: var(--panel);
    }
    .stage-matrix {
      display: grid;
      min-width: 1050px;
    }
    .matrix-cell {
      min-height: 58px;
      padding: 8px 10px;
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .matrix-head {
      min-height: 64px;
      color: #fff;
      background: #24343f;
    }
    .matrix-head small { display: block; margin-bottom: 3px; color: #9fb0bc; font-size: 8px; }
    .matrix-head strong { display: block; font-size: 11px; }
    .matrix-head .time { display: block; margin-top: 5px; color: #bdc9d1; }
    .row-label {
      display: flex;
      align-items: center;
      gap: 7px;
      color: #45535e;
      background: #f3f5f6;
      font-size: 10px;
      font-weight: 800;
    }
    .row-label .number { color: #87949e; font-family: var(--mono); font-size: 9px; }
    .step-cell { border-left: 3px solid var(--state); background: var(--state-bg); }
    .step-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .step-cell strong { font-size: 10px; }
    .step-cell p { margin: 5px 0 0; color: var(--muted); font-size: 8px; }
    .empty-cell { background: #fafbfb; color: #9aa5ad; font-size: 9px; }

    .round-strip { display: grid; grid-template-columns: repeat(3, minmax(80px, 1fr)); gap: 5px; }
    .round {
      min-height: 46px;
      padding: 5px;
      border: 1px solid color-mix(in srgb, var(--state) 45%, #cbd3da);
      border-radius: 4px;
      background: color-mix(in srgb, var(--state-bg) 72%, white);
    }
    .round.unused { border-style: dashed; color: #9aa5ad; background: #fafbfb; }
    .round-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
    .round-head strong { font-family: var(--mono); font-size: 8px; }
    .round-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-top: 5px; }
    .round-pair span { font-size: 7px; text-transform: uppercase; }
    .round-pair b { display: block; margin-top: 1px; font-family: var(--mono); font-size: 8px; }

    /* B: lane swimlanes with proportional phase bands */
    .gantt {
      overflow-x: auto;
      border: 1px solid var(--line);
      background: var(--panel);
    }
    .gantt-axis {
      display: grid;
      grid-template-columns: 205px repeat(8, minmax(105px, 1fr));
      min-width: 1100px;
      border-bottom: 1px solid var(--line-dark);
      background: #eef1f3;
    }
    .axis-cell { padding: 8px; border-right: 1px solid #d3dae0; color: var(--muted); font-size: 8px; text-align: center; text-transform: uppercase; }
    .axis-cell:first-child { text-align: left; }
    .gantt-lane { min-width: 1100px; border-bottom: 4px solid #dce2e6; }
    .gantt-lane:last-child { border-bottom: 0; }
    .lane-heading {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      padding: 7px 12px;
      background: #f7f9fa;
      border-bottom: 1px solid var(--line);
      font-size: 10px;
      font-weight: 800;
    }
    .timeline-row {
      display: grid;
      grid-template-columns: 205px repeat(8, minmax(105px, 1fr));
      min-height: 82px;
    }
    .slice-label {
      padding: 10px 12px;
      border-right: 1px solid var(--line);
      background: #fff;
    }
    .slice-label strong { display: block; font-size: 11px; }
    .slice-label small { display: block; margin: 4px 0 7px; color: var(--muted); font-size: 8px; }
    .phase-band {
      position: relative;
      padding: 8px 6px;
      border-right: 1px solid #dce2e6;
      border-left: 3px solid var(--state);
      background: var(--state-bg);
    }
    .phase-band strong { display: block; font-size: 9px; }
    .phase-band .time { display: block; margin-top: 4px; }
    .phase-band .round-mini { display: flex; gap: 3px; margin-top: 7px; }
    .phase-band .round-mini i {
      display: grid;
      place-items: center;
      width: 20px;
      height: 18px;
      border: 1px solid color-mix(in srgb, var(--state) 50%, #fff);
      border-radius: 2px;
      background: rgba(255,255,255,.55);
      font-family: var(--mono);
      font-size: 7px;
      font-style: normal;
      font-weight: 800;
    }

    /* C: review-first round ledger */
    .ledger-layout {
      display: grid;
      grid-template-columns: 230px minmax(0, 1fr);
      min-height: 590px;
      border: 1px solid var(--line);
      background: var(--panel);
    }
    .ledger-sidebar { background: #22313c; color: #fff; }
    .ledger-sidebar h3 { margin: 0; padding: 14px; color: #9eb0bc; font-size: 9px; text-transform: uppercase; }
    .slice-nav {
      width: 100%;
      padding: 11px 14px;
      border: 0;
      border-top: 1px solid #334550;
      color: #dce4e9;
      background: transparent;
      text-align: left;
    }
    .slice-nav.selected { border-left: 4px solid #58a8dd; background: #2c3e4a; }
    .slice-nav strong { display: block; font-size: 10px; }
    .slice-nav small { display: block; margin-top: 4px; color: #9eb0bc; font-size: 8px; }
    .sidebar-total { margin: 14px; padding: 10px; border: 1px solid #455965; background: #1b2933; }
    .sidebar-total span { display: block; color: #9eb0bc; font-size: 8px; text-transform: uppercase; }
    .sidebar-total strong { display: block; margin-top: 4px; font-family: var(--mono); font-size: 16px; }

    .ledger-main { min-width: 0; padding: 16px; }
    .ledger-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 13px; }
    .ledger-title h3 { margin: 0; font-size: 15px; }
    .ledger-title p { margin: 4px 0 0; color: var(--muted); font-size: 9px; }
    .review-section { margin-bottom: 18px; }
    .review-section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-bottom: 0;
      background: #f0f3f5;
    }
    .review-section-head strong { font-size: 10px; }
    .review-section-head span { color: var(--muted); font-size: 8px; }
    .round-ledger {
      display: grid;
      grid-template-columns: repeat(3, minmax(160px, 1fr));
      border-top: 1px solid var(--line);
      border-left: 1px solid var(--line);
    }
    .ledger-round {
      min-height: 132px;
      padding: 10px;
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      background: #fff;
    }
    .ledger-round.current { box-shadow: inset 0 0 0 3px var(--active); background: var(--active-bg); }
    .ledger-round.unused { color: #9ba6ae; background: #fafbfb; }
    .ledger-round-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .ledger-round-head strong { font-family: var(--mono); font-size: 10px; }
    .actor-row {
      display: grid;
      grid-template-columns: 75px 1fr auto;
      align-items: center;
      gap: 7px;
      padding: 7px 0;
      border-top: 1px solid #e5e9ec;
      font-size: 8px;
    }
    .actor-row b { font-size: 8px; }
    .verdict {
      margin-top: 9px;
      padding: 6px 7px;
      border-left: 3px solid var(--state);
      color: var(--state);
      background: var(--state-bg);
      font-size: 8px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .other-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .compact-step { padding: 9px; border: 1px solid var(--line); border-top: 3px solid var(--state); background: var(--state-bg); }
    .compact-step strong { display: block; font-size: 9px; }
    .compact-step .time { display: block; margin-top: 5px; }

    .switcher {
      position: fixed;
      bottom: 18px;
      left: 50%;
      z-index: 50;
      display: grid;
      grid-template-columns: 42px minmax(200px, auto) 42px;
      align-items: center;
      overflow: hidden;
      transform: translateX(-50%);
      border: 1px solid #465560;
      border-radius: 999px;
      color: #fff;
      background: #17232c;
      box-shadow: 0 8px 26px rgba(25, 36, 45, .24);
    }
    .switcher button { height: 46px; border: 0; color: #fff; background: transparent; font-size: 20px; }
    .switcher button:hover { background: #2a3a46; }
    .switch-name { padding: 0 14px; text-align: center; }
    .switch-name strong { display: block; font-size: 10px; }
    .switch-name span { display: block; margin-top: 2px; color: #9eb0bc; font-size: 8px; }

    @media (max-width: 850px) {
      .topbar { grid-template-columns: 1fr; gap: 8px; }
      .run-facts { display: none; }
      .wavebar { overflow-x: auto; padding: 0 12px; }
      .wave-tab { min-width: 145px; }
      .workspace { padding-right: 12px; padding-left: 12px; }
      .workspace-head { align-items: flex-start; flex-direction: column; }
      .legend { justify-content: flex-start; }
      .wave-summary { grid-template-columns: repeat(3, 1fr); }
      .ledger-layout { grid-template-columns: 1fr; }
      .ledger-sidebar { display: flex; overflow-x: auto; }
      .ledger-sidebar h3, .sidebar-total { display: none; }
      .slice-nav { min-width: 170px; border-top: 0; border-right: 1px solid #334550; }
    }

    @media (max-width: 520px) {
      .topbar { padding-right: 12px; padding-left: 12px; }
      .wave-summary { grid-template-columns: repeat(2, 1fr); }
      .round-ledger { grid-template-columns: 1fr; }
      .other-steps { grid-template-columns: 1fr; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; }
    }

    .connection.offline { color: #ff9a91; }
    .matrix-head.slice-select { width: 100%; border-top: 0; border-left: 0; text-align: left; cursor: pointer; }
    .matrix-head.slice-select:hover { background: #304552; }
    .matrix-head.slice-select:focus-visible { position: relative; z-index: 2; }
    .round-strip.dynamic { grid-template-columns: repeat(var(--round-count), minmax(80px, 1fr)); }
    .stage-matrix { min-width: max(1050px, calc(150px + var(--slice-count) * 280px)); }
    .phase-section { margin-top: 14px; }
    .phase-section h3 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; }
    .phase-rail { display: grid; grid-template-columns: repeat(4, minmax(170px, 1fr)); border: 1px solid var(--line); background: var(--panel); }
    .phase-card { min-height: 74px; padding: 10px 12px; border-right: 1px solid var(--line); border-top: 3px solid var(--state); background: var(--state-bg); }
    .phase-card:last-child { border-right: 0; }
    .phase-card strong { display: block; font-size: 10px; }
    .phase-card .time { display: block; margin-top: 6px; }
    .back { padding: 6px 9px; border: 1px solid var(--line-dark); border-radius: 3px; color: var(--ink); background: #fff; font-size: 9px; font-weight: 800; }
    .empty-state { padding: 70px 20px; border: 1px solid var(--line); color: var(--muted); background: #fff; text-align: center; }
    .warning { margin-top: 5px; color: var(--blocked); font-size: 8px; }
    @media (max-width: 850px) { .phase-rail { display: flex; overflow-x: auto; } .phase-card { min-width: 190px; } }
</style></head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <div class="mark">AFK</div>
        <div><h1>Feature Pipeline</h1><p id="runName">Loading run...</p></div>
      </div>
      <div class="run-facts">
        <div class="fact"><span>Run status</span><strong class="live" id="runStatus">UNKNOWN</strong></div>
        <div class="fact"><span>Total elapsed</span><strong id="runElapsed">—</strong></div>
        <div class="fact"><span>Progress</span><strong id="progress">—</strong></div>
        <div class="fact"><span>Connection</span><strong class="live connection" id="connection">LIVE</strong></div>
      </div>
    </header>
    <nav id="waveTabs" class="wavebar" aria-label="Pipeline waves"></nav>
    <main class="workspace">
      <header class="workspace-head">
        <div><h2 id="viewTitle">Expanded stage matrix</h2><p id="viewSubtitle">Lanes run in parallel; slices inside a lane remain in serial order.</p></div>
        <div class="legend">
          <span><i class="dot status-done"></i>Done</span><span><i class="dot status-active"></i>Active</span>
          <span><i class="dot status-queued"></i>Queued</span><span><i class="dot status-blocked"></i>Blocked</span>
          <span><i class="dot status-failed"></i>Failed</span>
        </div>
      </header>
      <section id="waveSummary" class="wave-summary"></section>
      <div id="viewRoot"></div>
      <section class="phase-section"><h3>Shipping stages</h3><div class="phase-rail" id="phaseRail"></div></section>
    </main>
  </div><script>
(function(){
  "use strict";
  var model=null, selectedWave=null, selectedSlice=null, failures=0;
  var esc=function(value){return String(value==null?"":value).replace(/[&<>"']/g,function(char){return({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]})};
  var formatTime=function(ms){if(ms==null)return "—";var total=Math.max(0,Math.round(ms/1000)),hours=Math.floor(total/3600),minutes=Math.floor((total%3600)/60),seconds=total%60;return [hours,minutes,seconds].map(function(value){return String(value).padStart(2,"0")}).join(":")};
  var label=function(state){return state==="done"?"Done":state==="active"?"Active":state==="blocked"?"Blocked":state==="failed"?"Failed":state==="unknown"?"Unknown":"Queued"};
  var badge=function(state,text){return '<span class="badge status-'+esc(state)+'">'+esc(text||label(state))+'</span>'};
  var invocationState=function(inv){return inv?inv.state:"queued"};
  var roundState=function(round){if(!round)return "queued";var states=[round.primary&&round.primary.state,round.evaluator&&round.evaluator.state];if(states.indexOf("active")>=0)return "active";if(states.indexOf("failed")>=0)return "failed";if(round.evaluator&&round.evaluator.state==="done")return "done";return round.primary?round.primary.state:"queued"};
  var roundVerdict=function(round){return round&&round.evaluator&&round.evaluator.verdict||round&&round.primary&&round.primary.verdict||null};
  function waveSlices(wave){var result=[];wave.lanes.forEach(function(lane){lane.slices.forEach(function(slice,index){result.push({slice:slice,lane:lane.lane,position:index+1,laneSize:lane.slices.length})})});return result}
  function allSlices(){var result=[];model.pipeline.waves.forEach(function(wave){waveSlices(wave).forEach(function(entry){result.push(entry.slice)})});return result}
  function currentWave(){return model.pipeline.waves.find(function(wave){return wave.wave===selectedWave})}
  function renderTabs(){
    document.getElementById("waveTabs").innerHTML=model.pipeline.waves.map(function(wave){
      var count=waveSlices(wave).length;
      return '<button class="wave-tab '+(wave.wave===selectedWave?"selected ":"")+'status-'+esc(wave.state)+'" data-wave="'+wave.wave+'" type="button"><strong><i class="dot"></i>Wave '+wave.wave+'</strong><small>'+count+' slice'+(count===1?"":"s")+' · '+wave.lanes.length+' lane'+(wave.lanes.length===1?"":"s")+(wave.projected?" · projected":"")+'</small><span class="wave-time">'+formatTime(wave.elapsedMs)+'</span></button>'
    }).join("")
  }
  function renderSummary(wave){
    var entries=waveSlices(wave),rounds=entries.reduce(function(sum,entry){return sum+entry.slice.contractRounds.length+entry.slice.implementationRounds.length},0),active=entries.find(function(entry){return entry.slice.state==="active"});
    document.getElementById("waveSummary").innerHTML=[["Wave status",label(wave.state)],["Wave elapsed",formatTime(wave.elapsedMs)],["Lanes",wave.lanes.length],["Review rounds",rounds],["Currently active",active?"#"+active.slice.ghIssue+" "+active.slice.title:"None"]].map(function(item){return '<div class="summary-cell"><span>'+esc(item[0])+'</span><strong>'+esc(item[1])+'</strong></div>'}).join("")
  }
  function roundStrip(rounds,limit,kind){
    var count=Math.max(limit||0,rounds.length);if(count===0)count=1;
    var labels=kind==="contract"?["Planner","Contract evaluator"]:["Generator","Implementation evaluator"];
    var cells=[];for(var index=0;index<count;index++){var round=rounds.find(function(item){return item.round===index+1});
      if(!round){cells.push('<div class="round unused"><div class="round-head"><strong>R'+(index+1)+'</strong><span>—</span></div></div>');continue}
      var state=roundState(round),verdict=roundVerdict(round);
      cells.push('<div class="round status-'+state+'"><div class="round-head"><strong>R'+round.round+'</strong>'+badge(state,verdict||label(state))+'</div><div class="round-pair"><span>'+labels[0]+'<b>'+formatTime(round.primary&&round.primary.elapsedMs)+'</b></span><span>'+labels[1]+'<b>'+formatTime(round.evaluator&&round.evaluator.elapsedMs)+'</b></span></div></div>')
    }
    return '<div class="round-strip dynamic" style="--round-count:'+count+'">'+cells.join("")+'</div>'
  }
  function simpleStep(name,state,time,note){
    return '<div class="step-cell status-'+state+'"><div class="step-top"><strong>'+esc(name)+'</strong>'+badge(state)+'</div><p>'+esc(note)+' · <span class="time '+(state==="active"?"active":"")+'">'+formatTime(time)+'</span></p></div>'
  }
  function renderMatrix(wave){
    var entries=waveSlices(wave),columns="150px repeat("+entries.length+", minmax(270px, 1fr))";
    var heads=['<div class="matrix-cell matrix-head"><small>Selected</small><strong>Wave '+wave.wave+'</strong><span class="time">'+formatTime(wave.elapsedMs)+'</span></div>'].concat(entries.map(function(entry){
      var slice=entry.slice,laneOrder=entry.laneSize>1?" · "+entry.position+"/"+entry.laneSize:"";
      return '<button class="matrix-cell matrix-head slice-select" data-slice="'+esc(slice.ghIssue)+'" type="button"><small><span class="lane-tag">Lane '+entry.lane+laneOrder+'</span></small><strong>#'+esc(slice.ghIssue)+' '+esc(slice.title||"Untitled slice")+'</strong><span class="time">'+badge(slice.state,slice.outcome||label(slice.state))+'</span>'+(slice.waitsOn.length?'<span class="warning">Waits on '+slice.waitsOn.map(function(id){return "#"+esc(id)}).join(", ")+'</span>':"")+'</button>'
    }));
    var rows=[
      ["01","Explore",function(slice){return simpleStep("Explorer",invocationState(slice.explorer),slice.explorer&&slice.explorer.elapsedMs,"context.md")}],
      ["02","Contract rounds",function(slice){var state=slice.contractRounds.length?roundState(slice.contractRounds[slice.contractRounds.length-1]):slice.state;return '<div class="step-cell status-'+state+'">'+roundStrip(slice.contractRounds,model.pipeline.run.contractRoundLimit,"contract")+'</div>'}],
      ["03","Implementation rounds",function(slice){var state=slice.implementationRounds.length?roundState(slice.implementationRounds[slice.implementationRounds.length-1]):slice.state;return '<div class="step-cell status-'+state+'">'+roundStrip(slice.implementationRounds,model.pipeline.run.implementationRoundLimit,"implementation")+'</div>'}],
      ["04","Slice outcome",function(slice){return simpleStep("Feature branch",slice.state,null,slice.outcome||label(slice.state))}]
    ];
    var body=[];rows.forEach(function(row){body.push('<div class="matrix-cell row-label"><span class="number">'+row[0]+'</span>'+row[1]+'</div>');entries.forEach(function(entry){body.push(row[2](entry.slice))})});
    return '<div class="stage-matrix-wrap"><section class="stage-matrix" style="grid-template-columns:'+columns+';--slice-count:'+entries.length+'">'+heads.concat(body).join("")+'</section></div>'
  }
  function ledgerRound(round,index,limit,kind){
    if(!round)return '<div class="ledger-round unused"><div class="ledger-round-head"><strong>Round '+(index+1)+(limit?" / "+limit:"")+'</strong><span>Not observed</span></div></div>';
    var state=roundState(round),actors=kind==="contract"?["Planner","Contract evaluator"]:["Generator","Implementation evaluator"];
    function actorRows(invocations,name){var items=invocations||[];if(!items.length)return '<div class="actor-row"><b>'+name+'</b><span>Waiting</span><time>—</time></div>';return items.map(function(inv,index){return '<div class="actor-row"><b>'+name+' '+(items.length>1?"A"+(index+1):"")+'</b><span>'+(inv.state==="active"?"Working":"Completed")+'</span><time>'+formatTime(inv.elapsedMs)+'</time></div>'}).join("")}
    return '<div class="ledger-round '+(state==="active"?"current":"")+'"><div class="ledger-round-head"><strong>Round '+round.round+(limit?" / "+limit:"")+'</strong>'+badge(state)+'</div>'+actorRows(round.primaryInvocations,actors[0])+actorRows(round.evaluatorInvocations,actors[1])+'<div class="verdict status-'+state+'">'+esc(roundVerdict(round)||label(state))+'</div></div>'
  }
  function roundLedger(rounds,limit,kind){var count=Math.max(limit||0,rounds.length);if(count===0)count=1;var cells=[];for(var index=0;index<count;index++){cells.push(ledgerRound(rounds.find(function(round){return round.round===index+1}),index,limit,kind))}return cells.join("")}
  function renderLedger(wave,slice){
    var entries=waveSlices(wave),selectedEntry=entries.find(function(entry){return entry.slice.ghIssue===slice.ghIssue}),sidebar=entries.map(function(entry){return '<button class="slice-nav '+(entry.slice.ghIssue===slice.ghIssue?"selected":"")+'" data-slice="'+esc(entry.slice.ghIssue)+'" type="button"><strong><span class="lane-tag">Lane '+entry.lane+'</span> #'+esc(entry.slice.ghIssue)+' '+esc(entry.slice.title)+'</strong><small>'+label(entry.slice.state)+' · '+formatTime(totalSliceTime(entry.slice))+'</small></button>'}).join("");
    return '<div class="ledger-layout"><aside class="ledger-sidebar"><h3>Wave '+wave.wave+' slices</h3>'+sidebar+'<div class="sidebar-total"><span>Wave elapsed</span><strong>'+formatTime(wave.elapsedMs)+'</strong></div></aside><section class="ledger-main"><header class="ledger-title"><div><h3>#'+esc(slice.ghIssue)+' '+esc(slice.title)+'</h3><p>Lane '+(selectedEntry?selectedEntry.lane:"—")+' · observed invocation time '+formatTime(totalSliceTime(slice))+'</p></div><button class="back" id="backToMatrix" type="button">Back to matrix</button></header><section class="review-section"><header class="review-section-head"><strong>Planner → Contract evaluator</strong><span>'+slice.contractRounds.length+' round'+(slice.contractRounds.length===1?"":"s")+' observed</span></header><div class="round-ledger">'+roundLedger(slice.contractRounds,model.pipeline.run.contractRoundLimit,"contract")+'</div></section><section class="review-section"><header class="review-section-head"><strong>Generator → Implementation evaluator</strong><span>'+slice.implementationRounds.length+' round'+(slice.implementationRounds.length===1?"":"s")+' observed</span></header><div class="round-ledger">'+roundLedger(slice.implementationRounds,model.pipeline.run.implementationRoundLimit,"implementation")+'</div></section><div class="other-steps"><div class="compact-step status-'+invocationState(slice.explorer)+'"><strong>Explorer</strong><span class="time">'+formatTime(slice.explorer&&slice.explorer.elapsedMs)+'</span></div><div class="compact-step status-'+slice.state+'"><strong>Slice outcome</strong><span class="time">'+esc(slice.outcome||label(slice.state))+'</span></div><div class="compact-step status-'+(slice.waitsOn.length?"blocked":"done")+'"><strong>Dependencies</strong><span class="time">'+(slice.waitsOn.length?"Waits on "+slice.waitsOn.map(function(id){return "#"+esc(id)}).join(", "):"Clear")+'</span></div></div></section></div>'
  }
  function totalSliceTime(slice){var total=slice.explorer&&slice.explorer.elapsedMs||0;slice.contractRounds.concat(slice.implementationRounds).forEach(function(round){total+=(round.primary&&round.primary.elapsedMs||0)+(round.evaluator&&round.evaluator.elapsedMs||0)});return total}
  function renderPhases(){document.getElementById("phaseRail").innerHTML=model.pipeline.aggregateStages.map(function(phase){return '<div class="phase-card status-'+phase.state+'"><strong>'+esc(phase.label)+'</strong>'+badge(phase.state,phase.verdict||label(phase.state))+'<span class="time">'+phase.attempts.length+' attempt'+(phase.attempts.length===1?"":"s")+'</span></div>'}).join("")}
  function render(){
    if(!model)return;var waves=model.pipeline.waves,run=model.pipeline.run;
    if(selectedWave==null||!waves.some(function(wave){return wave.wave===selectedWave})){var active=waves.find(function(wave){return wave.state==="active"});selectedWave=(active||waves[waves.length-1]||{}).wave}
    document.getElementById("runName").textContent=(run.slug||"Unknown run")+" / "+(run.provider||"unknown provider");
    document.getElementById("runStatus").textContent=label(run.state).toUpperCase();document.getElementById("runElapsed").textContent=formatTime(run.elapsedMs);
    var slices=allSlices(),done=slices.filter(function(slice){return slice.state==="done"}).length;document.getElementById("progress").textContent=done+" / "+slices.length+" slices";
    renderTabs();var wave=currentWave(),root=document.getElementById("viewRoot");
    if(!wave){document.getElementById("waveSummary").innerHTML="";root.innerHTML='<div class="empty-state">No waves are available for this run.</div>'}
    else{renderSummary(wave);var slice=selectedSlice&&waveSlices(wave).map(function(entry){return entry.slice}).find(function(item){return item.ghIssue===selectedSlice});document.getElementById("viewTitle").textContent=slice?"Review round ledger":"Expanded stage matrix";document.getElementById("viewSubtitle").textContent=slice?"Observed planner/evaluator and generator/evaluator invocation history.":"Lanes run in parallel; slices inside a lane remain in serial order.";root.innerHTML=slice?renderLedger(wave,slice):renderMatrix(wave)}
    renderPhases()
  }
  document.addEventListener("click",function(event){var waveButton=event.target.closest("[data-wave]");if(waveButton&&waveButton.classList.contains("wave-tab")){selectedWave=Number(waveButton.getAttribute("data-wave"));selectedSlice=null;render();return}var sliceButton=event.target.closest("[data-slice]");if(sliceButton){selectedSlice=sliceButton.getAttribute("data-slice");render();return}if(event.target.closest("#backToMatrix")){selectedSlice=null;render()}});
  async function poll(){try{var response=await fetch("/api/status",{cache:"no-store"});if(!response.ok)throw new Error("HTTP "+response.status);model=await response.json();failures=0;var connection=document.getElementById("connection");connection.textContent="LIVE";connection.classList.remove("offline");render()}catch(error){failures++;if(failures>1){var connection=document.getElementById("connection");connection.textContent="DISCONNECTED";connection.classList.add("offline")}}setTimeout(poll,1000)}
  poll()
})();</script></body></html>`;
