// GatePlan - local-first MVP
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const state = {
  tasks: [],         // pool of tasks
  todayPlan: [],     // items planned for yyyy-mm-dd
  streak: 0,
  lastCheckinDate: null,
  settings: { morningHour: "07:00", calLinks: "on" },
};

function todayKey(d=new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

function load() {
  const saved = JSON.parse(localStorage.getItem("gp_state")||"{}");
  Object.assign(state, saved);
  if (!state.settings) state.settings = { morningHour:"07:00", calLinks:"on" };
}
function save() {
  localStorage.setItem("gp_state", JSON.stringify(state));
}

function initDemoIfEmpty() {
  if (state.tasks.length===0) {
    state.tasks.push(
      {id:crypto.randomUUID(), title:"30 min reading", defDur:30, due:null, tags:["focus"]},
      {id:crypto.randomUUID(), title:"Workout", defDur:45, due:null, tags:["health"]},
      {id:crypto.randomUUID(), title:"Deep work block", defDur:60, due:null, tags:["study"]},
    );
  }
}

function renderDateInfo() {
  $("#dateInfo").textContent = (new Date()).toDateString();
  $("#streakInfo").textContent = `Streak: ${state.streak} 🔥`;
}

function setTab(tabId) {
  $$(".tab").forEach(b => b.classList.remove("active"));
  $(`#tab-${tabId}`).classList.add("active");
  $$(".view").forEach(v => v.classList.remove("visible"));
  $(`#view-${tabId}`).classList.add("visible");
}

function renderPoolSelect() {
  const sel = $("#planTaskSelect");
  sel.innerHTML = "";
  state.tasks.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.title;
    sel.appendChild(opt);
  });
}

function renderPoolList() {
  const ul = $("#poolList");
  ul.innerHTML = "";
  state.tasks.forEach(t => {
    const li = document.createElement("li");
    const left = document.createElement("div");
    const right = document.createElement("div");
    left.innerHTML = `<strong>${t.title}</strong> <span class="badge">${t.defDur}m</span> ${t.due?`<span class="small">due ${t.due}</span>`:""} ${t.tags?.length? `<span class="small">#${t.tags.join(", #")}</span>`:""}`;
    const del = document.createElement("button"); del.textContent="Delete";
    del.addEventListener("click", ()=>{
      state.tasks = state.tasks.filter(x=>x.id!==t.id); save(); renderPoolList(); renderPoolSelect();
    });
    right.appendChild(del);
    li.append(left, right);
    ul.appendChild(li);
  });
}

function getTodayPlan() {
  const key = todayKey();
  if (!state.todayPlan) state.todayPlan = [];
  if (!state.todayPlan.find(d=>d.date===key)) {
    state.todayPlan.push({ date:key, items:[], planned:false, checked:false, freeTomorrow:false });
  }
  return state.todayPlan.find(d=>d.date===key);
}

function renderTodayPlanList() {
  const todays = getTodayPlan();
  const ul = $("#todayPlanList");
  ul.innerHTML = "";
  todays.items.sort((a,b)=>(a.start||"").localeCompare(b.start||""));
  todays.items.forEach((it, idx)=>{
    const li = document.createElement("li");
    const left = document.createElement("div");
    const right = document.createElement("div");
    left.innerHTML = `<strong>${it.title}</strong> ${it.start?`<span class="badge">${it.start}</span>`:""} <span class="badge">${it.duration}m</span>`;
    // Calendar link
    if (state.settings.calLinks==="on") {
      const a = document.createElement("a");
      a.textContent = "Add to Google Calendar";
      a.href = makeGCalLink(it);
      a.target = "_blank";
      a.className = "small";
      left.appendChild(document.createElement("br"));
      left.appendChild(a);
    }
    const rm = document.createElement("button"); rm.textContent="Remove";
    rm.addEventListener("click", ()=>{
      todays.items.splice(idx,1); save(); renderTodayPlanList(); renderTodayLiveList(); renderCheckinList(); maybeShowGate();
    });
    right.appendChild(rm);
    li.append(left,right);
    ul.appendChild(li);
  });
}

function renderTodayLiveList() {
  const todays = getTodayPlan();
  const ul = $("#todayLiveList");
  ul.innerHTML = "";
  if (todays.items.length===0) {
    const p = document.createElement("p");
    p.className="muted";
    p.textContent = "No tasks planned yet. Go to Morning Plan.";
    ul.appendChild(p);
    return;
  }
  todays.items.forEach((it)=>{
    const li = document.createElement("li");
    li.innerHTML = `<div><strong>${it.title}</strong> ${it.start?`<span class="badge">${it.start}</span>`:""} <span class="badge">${it.duration}m</span></div>`;
    ul.appendChild(li);
  });
}

function renderCheckinList() {
  const todays = getTodayPlan();
  const ul = $("#checkinList");
  ul.innerHTML = "";
  if (todays.items.length===0) {
    const p = document.createElement("p");
    p.className="muted";
    p.textContent = "Nothing planned today.";
    ul.appendChild(p);
    return;
  }
  todays.items.forEach((it)=>{
    const li = document.createElement("li");
    const left = document.createElement("div");
    left.innerHTML = `<strong>${it.title}</strong> ${it.start?`<span class="badge">${it.start}</span>`:""} <span class="badge">${it.duration}m</span>`;

    const right = document.createElement("div");
    const success = document.createElement("button"); success.textContent="Success";
    const notYet = document.createElement("button"); notYet.textContent="Not yet";
    const skipped = document.createElement("button"); skipped.textContent="Skipped";

    const reasons = ["underestimated","urgent_interruption","low_energy","blocked","procrastination","sick","technical_issue"];
    const chips = document.createElement("div"); chips.className="chips"; chips.style.display="none";
    reasons.forEach(r=>{
      const c=document.createElement("div"); c.className="chip"; c.textContent=r.replace("_"," ");
      c.addEventListener("click", ()=>{
        chips.querySelectorAll(".chip").forEach(x=>x.classList.remove("selected"));
        c.classList.add("selected");
        it.reason = r;
      });
      chips.appendChild(c);
    });

    function mark(status){
      it.status = status;
      if (status==="success"){
        chips.style.display="none";
        it.reason=null;
      } else {
        chips.style.display="flex";
      }
    }

    success.addEventListener("click", ()=>mark("success"));
    notYet.addEventListener("click", ()=>mark("not_yet"));
    skipped.addEventListener("click", ()=>mark("skipped"));

    right.append(success, notYet, skipped);
    li.append(left, right);
    li.appendChild(chips);
    ul.appendChild(li);
  });
}

function makeGCalLink(it){
  // Build a simple Google Calendar template link for today with start and duration
  const key = todayKey();
  const [y,m,d] = key.split("-").map(Number);
  let start = it.start || "09:00";
  const [hh,mm] = start.split(":").map(Number);
  const startDate = new Date(y, m-1, d, hh, mm);
  const endDate = new Date(startDate.getTime() + (it.duration||30)*60000);

  function fmt(d){
    const pad = n => String(n).padStart(2,"0");
    // Use local time; Google can parse UTC 'Z' or local with timezone-less; we'll provide UTC:
    const y = d.getUTCFullYear();
    const mo = pad(d.getUTCMonth()+1);
    const da = pad(d.getUTCDate());
    const h = pad(d.getUTCHours());
    const mi = pad(d.getUTCMinutes());
    const s = pad(d.getUTCSeconds());
    return `${y}${mo}${da}T${h}${mi}${s}Z`;
  }
  const dates = `${fmt(startDate)}/${fmt(endDate)}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: it.title,
    dates,
    details: "Planned via GatePlan",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function addToToday() {
  const id = $("#planTaskSelect").value;
  const t = state.tasks.find(x=>x.id===id);
  if (!t) return;
  const start = $("#planStartTime").value || "";
  const dur = parseInt($("#planDuration").value || t.defDur || 30, 10);
  const todays = getTodayPlan();
  todays.items.push({title:t.title, start, duration: dur, status:null, reason:null});
  save();
  renderTodayPlanList(); renderTodayLiveList(); renderCheckinList(); maybeShowGate();
}

function finishPlanning() {
  const todays = getTodayPlan();
  if (todays.items.length===0) {
    alert("Add at least one task to Today.");
    return;
  }
  todays.planned = true;
  save();
  maybeShowGate();
  alert("Great! Planning saved.");
}

function submitCheckin() {
  const todays = getTodayPlan();
  // Validate reasons
  for (const it of todays.items) {
    if ((it.status==="not_yet" || it.status==="skipped") && !it.reason) {
      alert(`Please choose a reason for "${it.title}".`);
      return;
    }
    if (!it.status) {
      alert(`Please mark a status for "${it.title}".`);
      return;
    }
  }
  todays.checked = true;
  // Streak logic: success if all are success OR the day was declared free
  const allSuccess = todays.items.length>0 && todays.items.every(it=>it.status==="success");
  if (allSuccess || $("#tomorrowFree").checked) {
    state.streak = (state.streak||0) + 1;
  } else {
    state.streak = 0;
  }
  state.lastCheckinDate = todayKey();
  // Free tomorrow flag
  todays.freeTomorrow = !!$("#tomorrowFree").checked;
  save();
  $("#checkinResult").textContent = "Check-in saved. Nice work!";
  renderDateInfo();
}

function maybeShowGate() {
  // Show the gate in the morning if not planned and current time is after morning hour
  const gate = $("#gate");
  const todays = getTodayPlan();
  const [mh, mm] = (state.settings.morningHour||"07:00").split(":").map(Number);
  const now = new Date();
  const gateTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), mh, mm, 0);
  const shouldGate = (now >= gateTime) && !todays.planned && !todays.freeToday;
  gate.classList.toggle("hidden", !shouldGate);
}

function wireUI() {
  $("#tab-plan").addEventListener("click", ()=>{setTab("plan")});
  $("#tab-today").addEventListener("click", ()=>{setTab("today"); renderTodayLiveList();});
  $("#tab-pool").addEventListener("click", ()=>{setTab("pool")});
  $("#tab-checkin").addEventListener("click", ()=>{setTab("checkin")});
  $("#tab-settings").addEventListener("click", ()=>{setTab("settings")});

  $("#addToToday").addEventListener("click", addToToday);
  $("#finishPlanning").addEventListener("click", finishPlanning);
  $("#addPoolTask").addEventListener("click", ()=>{
    const title = $("#poolTitle").value.trim();
    const defDur = parseInt($("#poolDuration").value||"30",10);
    const due = $("#poolDue").value || null;
    const tags = $("#poolTags").value ? $("#poolTags").value.split(",").map(s=>s.trim()).filter(Boolean): [];
    if (!title) { alert("Enter a title"); return; }
    state.tasks.push({id:crypto.randomUUID(), title, defDur, due, tags});
    $("#poolTitle").value=""; $("#poolDuration").value=""; $("#poolDue").value=""; $("#poolTags").value="";
    save(); renderPoolSelect(); renderPoolList();
  });

  $("#saveSettings").addEventListener("click", ()=>{
    state.settings.morningHour = $("#morningHour").value || "07:00";
    state.settings.calLinks = $("#calLinks").value || "on";
    save(); alert("Settings saved.");
  });

  $("#gateGo").addEventListener("click", ()=>{
    setTab("plan");
  });

  window.addEventListener("focus", ()=>{
    renderDateInfo(); maybeShowGate();
  });

  // Installation prompt
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $("#installBtn").classList.remove("hidden");
  });
  $("#installBtn").addEventListener("click", async ()=>{
    $("#installBtn").classList.add("hidden");
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    }
  });
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js');
  }
}

function init() {
  load();
  initDemoIfEmpty();
  renderDateInfo();
  renderPoolSelect();
  renderPoolList();
  renderTodayPlanList();
  renderTodayLiveList();
  renderCheckinList();
  setTab("plan");
  maybeShowGate();
  wireUI();
  registerSW();
}
document.addEventListener("DOMContentLoaded", init);
