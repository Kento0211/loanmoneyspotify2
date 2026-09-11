(() => {
  "use strict";

  const CONFIG = window.APP_CONFIG || {};
  const supabaseClient = (
    CONFIG.SUPABASE_URL &&
    CONFIG.SUPABASE_PUBLISHABLE_KEY &&
    window.supabase?.createClient
  ) ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY) : null;

  const STORAGE = {
    vaultCode: "loan-ledger-vault-code-v3",
    localBlob: "loan-ledger-local-blob-v3"
  };

  let state = { loans: [], groups: [] };
  let unlocked = false;
  let vaultCode = localStorage.getItem(STORAGE.vaultCode) || "";
  let vaultBlob = null;
  let currentPin = null;
  let calendarDate = new Date();
  let todoDate = new Date();
  let saveTimer = null;
  let selectedPersonId = null;

  const $ = id => document.getElementById(id);
  const yen = n => new Intl.NumberFormat("ja-JP", { style:"currency", currency:"JPY", maximumFractionDigits:0 }).format(Math.round(Number(n) || 0));
  const dateISO = d => {
    const x = new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`;
  };
  const today = () => dateISO(new Date());
  const uid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2,10)}`);

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function setStatus(text, online=false) {
    $("syncStatus").textContent = text;
    $("syncStatus").classList.toggle("online", online);
  }

  function normalizeState(data) {
    const loans = Array.isArray(data?.loans) ? data.loans.map(normalizeLoan) : [];
    const groups = Array.isArray(data?.groups) ? data.groups.map(normalizeGroup) : [];
    return { loans, groups };
  }

  function normalizeLoan(l) {
    return {
      id: l.id || uid(),
      name: String(l.name || "").trim(),
      principal: Number(l.principal) || 0,
      rate: Number(l.rate) || 0,
      rateUnit: l.rateUnit === "yearly" ? "yearly" : "monthly",
      startDate: l.startDate || today(),
      updateDays: (() => {
        const src = Array.isArray(l.updateDays) ? l.updateDays : (l.updateDate ? [Number(String(l.updateDate).split("-")[2])] : []);
        const out = [];
        src.forEach(v => { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= 31 && !out.includes(n)) out.push(n); });
        out.sort((a,b)=>a-b);
        return out;
      })(),
      updateDates: (() => {
        const src = Array.isArray(l.updateDates) ? l.updateDates : [];
        const out = [];
        src.forEach(v => { const x = String(v); if (/^\d{2}-\d{2}$/.test(x) && !out.includes(x)) out.push(x); });
        return out;
      })(),
      note: String(l.note || ""),
      payments: Array.isArray(l.payments) ? l.payments.map(p => ({ id:p.id || uid(), date:p.date || today(), amount:Number(p.amount)||0, note:String(p.note||"") })) : []
    };
  }

  function normalizeGroup(g) {
    return {
      id: g.id || uid(),
      name: String(g.name || "グループ"),
      memberIds: Array.from(new Set(Array.isArray(g.memberIds) ? g.memberIds : [])),
      sharedAmount: g.sharedAmount === "" || g.sharedAmount == null ? null : Number(g.sharedAmount),
      updateDays: (() => {
        const src = Array.isArray(g.updateDays) ? g.updateDays : [];
        const out = [];
        src.forEach(v => { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= 31 && !out.includes(n)) out.push(n); });
        out.sort((a,b)=>a-b);
        return out;
      })(),
      updateDates: (() => {
        const src = Array.isArray(g.updateDates) ? g.updateDates : [];
        const out = [];
        src.forEach(v => { const x = String(v); if (/^\d{2}-\d{2}$/.test(x) && !out.includes(x)) out.push(x); });
        return out;
      })(),
      rateUnit: g.rateUnit === "yearly" ? "yearly" : "monthly"
    };
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE.localBlob);
      if (raw && currentPin) return;
      state = { loans: [], groups: [] };
    } catch { state = { loans: [], groups: [] }; }
  }

  function saveLocalBlob(blob) {
    localStorage.setItem(STORAGE.localBlob, JSON.stringify(blob));
  }

  function activeGroupFor(loanId) {
    return state.groups.find(g => g.memberIds.includes(loanId)) || null;
  }

  function effectivePrincipal(loan, group = activeGroupFor(loan.id)) {
    if (group && group.sharedAmount != null && Number.isFinite(group.sharedAmount)) return Number(group.sharedAmount);
    return Number(loan.principal) || 0;
  }

  function effectiveUpdateDays(loan) {
    const days = new Set(loan.updateDays || []);
    state.groups.filter(g => g.memberIds.includes(loan.id)).forEach(g => (g.updateDays || []).forEach(d => days.add(d)));
    return [...days].sort((a,b)=>a-b);
  }

  function effectiveUpdateDates(loan) {
    const dates = new Set(loan.updateDates || []);
    state.groups.filter(g => g.memberIds.includes(loan.id)).forEach(g => (g.updateDates || []).forEach(v => dates.add(v)));
    return [...dates].sort();
  }

  function monthDays(year, monthIndex) { return new Date(year, monthIndex + 1, 0).getDate(); }

  function monthlyOccurrences(loan, targetDate) {
    const start = new Date(`${loan.startDate}T00:00:00`);
    const target = new Date(`${targetDate}T00:00:00`);
    if (target < start) return [];
    const result = [];
    const days = loan.rateUnit === "yearly" ? effectiveUpdateDates(loan) : effectiveUpdateDays(loan);
    if (!days.length) return result;
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const end = new Date(target.getFullYear(), target.getMonth(), 1);
    while (cursor <= end) {
      const max = monthDays(cursor.getFullYear(), cursor.getMonth());
      days.forEach(day => {
        if (day > max) return;
        const d = new Date(cursor.getFullYear(), cursor.getMonth(), day);
        if (d >= start && d <= target) result.push(dateISO(d));
      });
      cursor.setMonth(cursor.getMonth()+1);
    }
    return result.sort();
  }

  function yearlyOccurrences(loan, targetDate) {
    const start = new Date(`${loan.startDate}T00:00:00`);
    const target = new Date(`${targetDate}T00:00:00`);
    if (target < start) return [];
    const result = [];
    let schedules = effectiveUpdateDates(loan);
    if (!schedules.length) schedules = effectiveUpdateDays(loan).map(day => `${String(start.getMonth()+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`);
    for (let year = start.getFullYear(); year <= target.getFullYear(); year++) {
      schedules.forEach(value => {
        const [month, day] = value.split("-").map(Number);
        const d = new Date(year, month - 1, day);
        if (d.getMonth() === month - 1 && d.getDate() === day && d >= start && d <= target) result.push(dateISO(d));
      });
    }
    return result.sort();
  }

  function occurrencesUntil(loan, targetDate = today()) {
    return loan.rateUnit === "yearly" ? yearlyOccurrences(loan, targetDate) : monthlyOccurrences(loan, targetDate);
  }

  function totalPaid(loan, targetDate = today()) {
    return (loan.payments || []).filter(p => p.date <= targetDate).reduce((s,p)=>s+Number(p.amount||0),0);
  }

  function interestPerOccurrence(loan) {
    return effectivePrincipal(loan) * (Number(loan.rate) / 100);
  }

  function interestFor(loan, targetDate = today()) {
    return occurrencesUntil(loan, targetDate).length * interestPerOccurrence(loan);
  }

  function currentBalance(loan, targetDate = today()) {
    return Math.max(0, effectivePrincipal(loan) + interestFor(loan, targetDate) - totalPaid(loan, targetDate));
  }

  function dueForOccurrence(loan, date) {
    if (date < loan.startDate || date > today()) return 0;
    return interestPerOccurrence(loan);
  }

  function paymentForDate(loan, date) {
    return (loan.payments || []).filter(p => p.date === date).reduce((s,p)=>s+Number(p.amount||0),0);
  }

  function todoItems(monthDate = todoDate) {
    const y = monthDate.getFullYear(), m = monthDate.getMonth();
    const daysInMonth = monthDays(y,m);
    const items = [];
    state.loans.forEach(loan => {
      const dates = loan.rateUnit === "yearly"
        ? effectiveUpdateDates(loan).filter(v => Number(v.split("-")[0]) === m + 1).map(v => Number(v.split("-")[1]))
        : effectiveUpdateDays(loan);
      dates.forEach(day => {
        if (day > daysInMonth) return;
        const date = `${y}-${String(m+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
        if (date < loan.startDate) return;
        const due = dueForOccurrence(loan, date);
        const paid = paymentForDate(loan, date);
        items.push({ loan, date, due, paid, done: paid >= due && due > 0, balance: currentBalance(loan, date) });
      });
    });
    return items.sort((a,b)=>a.date.localeCompare(b.date) || a.loan.name.localeCompare(b.loan.name));
  }

  function renderAll() {
    renderHero();
    renderLoans();
    renderTodo();
    renderGroups();
    renderCalendar();
    renderSummary();
    renderCalculator();
    renderPeopleSelects();
  }

  function renderHero() {
    const principal = state.loans.reduce((s,l)=>s+effectivePrincipal(l),0);
    const interest = state.loans.reduce((s,l)=>s+interestFor(l),0);
    $("heroTotal").textContent = yen(principal);
    $("heroInterest").textContent = `累計利子 ${yen(interest)}`;
    $("loanCountLabel").textContent = `${state.loans.length}人`;
  }

  function renderLoans() {
    const list = $("loanList");
    if (!state.loans.length) {
      list.innerHTML = `<div class="empty">まだ借りている人が登録されていません。<br>「＋ 人を追加」から登録してください。</div>`;
      return;
    }
    list.innerHTML = state.loans.map(loan => {
      const group = activeGroupFor(loan.id);
      const interest = interestFor(loan);
      const balance = currentBalance(loan);
      const scheduleLabels = loan.rateUnit === "yearly"
        ? effectiveUpdateDates(loan).map(v=>{const [m,d]=v.split("-");return `${Number(m)}月${Number(d)}日`;})
        : effectiveUpdateDays(loan).map(d=>`${d}日`);
      return `<article class="person-card glass" data-person="${loan.id}">
        <button class="person-main" data-person-open="${loan.id}">
          <div class="person-head"><div><div class="person-name">${esc(loan.name)}</div><div class="person-sub">${group ? `GROUP · ${esc(group.name)}` : "個別管理"}</div></div><span class="status-pill">${loan.rateUnit === "monthly" ? "月利" : "年利"} ${num(loan.rate)}%</span></div>
          <div class="person-balance">${yen(balance)}</div>
          <div class="person-meta"><span>借入額 ${yen(effectivePrincipal(loan))}</span><span>利子 ${yen(interest)}</span><span>借入日 ${fmtDate(loan.startDate)}</span></div>
          <div class="schedule-row">更新日 ${scheduleLabels.length ? scheduleLabels.map(v=>`<b>${v}</b>`).join(" ") : "未設定"}</div>
        </button>
        <div class="person-actions"><button class="small-button" data-edit="${loan.id}">編集</button><button class="small-button" data-payment="${loan.id}">返済を記録</button><button class="small-button danger-button" data-delete="${loan.id}">削除</button></div>
      </article>`;
    }).join("");

    list.querySelectorAll("[data-person-open]").forEach(b => b.onclick = () => openPersonDetail(b.dataset.personOpen));
    list.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => openPersonEdit(b.dataset.edit));
    list.querySelectorAll("[data-payment]").forEach(b => b.onclick = () => openPayment(b.dataset.payment));
    list.querySelectorAll("[data-delete]").forEach(b => b.onclick = () => deletePerson(b.dataset.delete));
  }

  function renderTodo() {
    const items = todoItems();
    $("todoTitle").textContent = `${todoDate.getFullYear()}年${todoDate.getMonth()+1}月の利息TODO`;
    $("todoDateLabel").textContent = `${items.length}件の更新`;
    if (!items.length) {
      $("todoList").innerHTML = `<div class="empty">この月の利息更新予定はありません。</div>`;
      return;
    }
    $("todoList").innerHTML = items.map(item => {
      const statusClass = item.done ? "done" : "pending";
      const status = item.done ? "✓" : "×";
      const paidLabel = item.paid ? `支払済 ${yen(item.paid)}` : `未払い · 現在 ${yen(item.balance)}`;
      return `<div class="todo-item ${statusClass}">
        <button class="todo-status" data-todo-toggle="${item.loan.id}|${item.date}" title="支払記録を変更">${status}</button>
        <div class="todo-info"><strong>${esc(item.loan.name)}</strong><span>${fmtDate(item.date)} · 利息 ${yen(item.due)}</span></div>
        <div class="todo-money"><strong>${paidLabel}</strong><small>${item.done ? `残高 ${yen(item.balance)}` : ""}</small></div>
        <button class="small-button" data-todo-payment="${item.loan.id}|${item.date}">${item.done ? "修正" : "支払"}</button>
      </div>`;
    }).join("");
    $("todoList").querySelectorAll("[data-todo-payment]").forEach(b => {
      const [id,date] = b.dataset.todoPayment.split("|");
      b.onclick = () => openPayment(id, date);
    });
    $("todoList").querySelectorAll("[data-todo-toggle]").forEach(b => {
      const [id,date] = b.dataset.todoToggle.split("|");
      b.onclick = () => toggleTodo(id,date);
    });
  }

  async function toggleTodo(id,date) {
    const loan = state.loans.find(l=>l.id===id);
    if (!loan) return;
    const due = dueForOccurrence(loan,date);
    const existing = paymentForDate(loan,date);
    if (existing >= due && due > 0) {
      loan.payments = loan.payments.filter(p=>p.date!==date);
    } else {
      loan.payments = loan.payments.filter(p=>p.date!==date);
      loan.payments.push({id:uid(),date,amount:due,note:"利息TODO完了"});
    }
    renderAll(); await persist();
  }

  function renderGroups() {
    const list = $("groupList");
    if (!state.groups.length) {
      list.innerHTML = `<div class="empty compact-empty">グループはまだありません。</div>`;
      return;
    }
    list.innerHTML = state.groups.map(g => {
      const members = g.memberIds.map(id=>state.loans.find(l=>l.id===id)).filter(Boolean);
      const schedule = g.rateUnit === "yearly" ? (g.updateDates||[]).map(v=>{const [m,d]=v.split("-");return `${Number(m)}月${Number(d)}日`;}).join("・") : (g.updateDays||[]).map(d=>d+"日").join("・");
      return `<div class="group-card glass"><div class="group-top"><div><strong>${esc(g.name)}</strong><span>${members.length}人 · ${g.rateUnit === "yearly" ? "年" : "月"}更新 ${schedule || "未設定"}</span></div><div>${g.sharedAmount != null ? `<b>${yen(g.sharedAmount)}/人</b>` : `<b>個別金額</b>`}</div></div><div class="group-members">${members.map(m=>`<span>${esc(m.name)}</span>`).join("")}</div><div class="person-actions"><button class="small-button" data-group-edit="${g.id}">編集</button><button class="small-button danger-button" data-group-delete="${g.id}">削除</button></div></div>`;
    }).join("");
    list.querySelectorAll("[data-group-edit]").forEach(b=>b.onclick=()=>openGroupEdit(b.dataset.groupEdit));
    list.querySelectorAll("[data-group-delete]").forEach(b=>b.onclick=()=>deleteGroup(b.dataset.groupDelete));
  }

  function renderCalendar() {
    const y=calendarDate.getFullYear(), m=calendarDate.getMonth();
    $("calendarTitle").textContent=`${y}年${m+1}月`;
    const first=new Date(y,m,1), start=new Date(y,m,1-first.getDay());
    const cells=[];
    for(let i=0;i<42;i++){
      const d=new Date(start); d.setDate(start.getDate()+i); const iso=dateISO(d);
      const events=todoItems(calendarDate).filter(x=>x.date===iso);
      const muted=d.getMonth()!==m;
      cells.push(`<button class="calendar-day ${muted?"muted":""} ${iso===today()?"today":""}" data-calendar-date="${iso}"><div class="day-number">${d.getDate()}</div>${events.slice(0,3).map(e=>`<span class="event ${e.done?"event-done":""}">${e.done?"✓":"•"} ${esc(e.loan.name)}</span>`).join("")}${events.length>3?`<span class="event more">+${events.length-3}件</span>`:""}</button>`);
    }
    $("calendarGrid").innerHTML=cells.join("");
    $("calendarGrid").querySelectorAll("[data-calendar-date]").forEach(b=>b.onclick=()=>{ todoDate=new Date(`${b.dataset.calendarDate}T00:00:00`); renderTodo(); });
  }

  function renderSummary() {
    const principal=state.loans.reduce((s,l)=>s+effectivePrincipal(l),0);
    const interest=state.loans.reduce((s,l)=>s+interestFor(l),0);
    const paid=state.loans.reduce((s,l)=>s+totalPaid(l),0);
    $("summaryCount").textContent=state.loans.length;
    $("summaryPrincipal").textContent=yen(principal);
    $("summaryInterest").textContent=yen(interest);
    $("summaryPaid").textContent=yen(paid); if($("summaryPaid2")) $("summaryPaid2").textContent=yen(paid);
    $("summaryTotal").textContent=yen(Math.max(0,principal+interest-paid));
  }

  function renderCalculator() {
    const select=$("calcLoan"), old=select.value;
    select.innerHTML=`<option value="">貸している人を選択</option>`+state.loans.map(l=>`<option value="${l.id}">${esc(l.name)} — ${yen(currentBalance(l))}</option>`).join("");
    if(state.loans.some(l=>l.id===old)) select.value=old;
    if(!$("calcDate").value) $("calcDate").value=today();
    calculateResult();
  }
  function calculateResult(){
    const loan=state.loans.find(l=>l.id===$("calcLoan").value), date=$("calcDate").value||today(), result=$("calcResult");
    if(!loan){result.innerHTML=`<span>計算結果</span><strong>貸している人を選択してください</strong>`;return;}
    const interest=interestFor(loan,date), paid=totalPaid(loan,date), balance=currentBalance(loan,date);
    result.innerHTML=`<span>${fmtDate(date)} 時点</span><strong>利子 ${yen(interest)}</strong><small>支払済 ${yen(paid)} · 現在 ${yen(balance)}</small>`;
  }

  function renderPeopleSelects(){
    const box=$("groupPeople");
    box.innerHTML=state.loans.length ? state.loans.map(l=>`<label class="check-person"><input type="checkbox" value="${l.id}"><span>${esc(l.name)}</span><small>${yen(l.principal)}</small></label>`).join("") : `<div class="muted">先に「人を追加」してください。</div>`;
  }

  function renderScheduleChips(kind) {
    const isGroup = kind === "group";
    const daysEl = $(isGroup ? "groupScheduleDays" : "scheduleDays");
    const daysData = $(isGroup ? "groupScheduleDaysData" : "scheduleDaysData");
    const datesData = $(isGroup ? "groupScheduleDatesData" : "scheduleDatesData");
    const controls = $(isGroup ? "groupScheduleControls" : "personScheduleControls");
    const unit = controls.dataset.unit || "monthly";
    const days = JSON.parse(daysData.value || "[]");
    const dates = JSON.parse(datesData.value || "[]");
    if (unit === "yearly") {
      daysEl.innerHTML = dates.map(v => { const [m,d]=v.split("-"); return `<span class="day-chip">${Number(m)}月${Number(d)}日 <button type="button" data-remove-date="${v}">×</button></span>`; }).join("");
      daysEl.querySelectorAll("[data-remove-date]").forEach(b=>b.onclick=()=>removeScheduleValue(kind,"date",b.dataset.removeDate));
    } else {
      daysEl.innerHTML = days.map(day=>`<span class="day-chip">${day}日 <button type="button" data-remove-day="${day}">×</button></span>`).join("");
      daysEl.querySelectorAll("[data-remove-day]").forEach(b=>b.onclick=()=>removeScheduleValue(kind,"day",Number(b.dataset.removeDay)));
    }
  }

  function setScheduleUnit(kind, unit) {
    const isGroup = kind === "group";
    const controls = $(isGroup ? "groupScheduleControls" : "personScheduleControls");
    controls.dataset.unit = unit;
    const monthInput = $(isGroup ? "groupScheduleMonthInput" : "scheduleMonthInput");
    monthInput.classList.toggle("hidden", unit !== "yearly");
    renderScheduleChips(kind);
  }

  function setScheduleInputs(days=[], dates=[], unit="monthly") {
    $("scheduleDaysData").value=JSON.stringify(days);
    $("scheduleDatesData").value=JSON.stringify(dates);
    setScheduleUnit("person", unit);
  }

  function setGroupScheduleDays(days=[], dates=[], unit="monthly") {
    $("groupScheduleDaysData").value=JSON.stringify(days);
    $("groupScheduleDatesData").value=JSON.stringify(dates);
    setScheduleUnit("group", unit);
  }

  function addScheduleValue(kind) {
    const isGroup = kind === "group";
    const controls = $(isGroup ? "groupScheduleControls" : "personScheduleControls");
    const unit = controls.dataset.unit || "monthly";
    const dayInput = $(isGroup ? "groupScheduleDayInput" : "scheduleDayInput");
    const monthInput = $(isGroup ? "groupScheduleMonthInput" : "scheduleMonthInput");
    const day = Number(dayInput.value);
    if (!Number.isInteger(day) || day < 1 || day > 31) return toast("日付は1〜31で入力してください。");
    const holder = $(isGroup ? "groupScheduleDaysData" : "scheduleDaysData");
    const datesHolder = $(isGroup ? "groupScheduleDatesData" : "scheduleDatesData");
    let days = JSON.parse(holder.value || "[]");
    let dates = JSON.parse(datesHolder.value || "[]");
    if (unit === "yearly") {
      const month = Number(monthInput.value);
      const value = `${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
      const test = new Date(2024, month-1, day);
      if (test.getMonth() !== month-1 || test.getDate() !== day) return toast("その月にはその日付がありません。");
      if (!dates.includes(value)) dates.push(value);
      dates.sort();
    } else {
      if (!days.includes(day)) days.push(day);
      days.sort((a,b)=>a-b);
    }
    holder.value=JSON.stringify(days); datesHolder.value=JSON.stringify(dates);
    renderScheduleChips(kind);
    dayInput.value="";
  }

  function removeScheduleValue(kind, type, value) {
    const isGroup = kind === "group";
    const holder = $(isGroup ? "groupScheduleDaysData" : "scheduleDaysData");
    const datesHolder = $(isGroup ? "groupScheduleDatesData" : "scheduleDatesData");
    if (type === "day") holder.value=JSON.stringify(JSON.parse(holder.value||"[]").filter(x=>Number(x)!==Number(value)));
    else datesHolder.value=JSON.stringify(JSON.parse(datesHolder.value||"[]").filter(x=>x!==value));
    renderScheduleChips(kind);
  }

  function openPersonAdd(){
    $("personForm").reset(); $("personId").value=""; $("personStartDate").value=today(); $("scheduleDaysData").value="[]"; $("scheduleDatesData").value="[]"; setScheduleInputs([],[],"monthly"); $("personDialogTitle").textContent="人を追加"; $("personDialog").showModal();
  }
  function openPersonEdit(id){
    const l=state.loans.find(x=>x.id===id); if(!l)return;
    $("personId").value=l.id; $("personName").value=l.name; $("personPrincipal").value=l.principal; $("personRate").value=l.rate; $("personRateUnit").value=l.rateUnit; $("personStartDate").value=l.startDate; $("personNote").value=l.note;
    setScheduleInputs(l.updateDays||[],l.updateDates||[],l.rateUnit);
    // Backward-compatible yearly data: old updateDays belong to the start month.
    if(l.rateUnit === "yearly" && !(l.updateDates||[]).length) {
      const month=String(new Date(`${l.startDate}T00:00:00`).getMonth()+1).padStart(2,"0");
      setScheduleInputs([],(l.updateDays||[]).map(d=>`${month}-${String(d).padStart(2,"0")}`),"yearly");
    }
    $("personDialogTitle").textContent="人を編集"; $("personDialog").showModal();
  }
  async function savePerson(e){
    e.preventDefault();
    try {
      if(vaultCode && !unlocked) return toast("先に保管庫を開いてください。");
      const id=$("personId").value || uid();
      const unit=$("personRateUnit").value === "yearly" ? "yearly" : "monthly";
      const parseArray = (id) => {
        try { const v=JSON.parse($(id).value || "[]"); return Array.isArray(v) ? v : []; }
        catch { $(id).value="[]"; return []; }
      };
      const days=parseArray("scheduleDaysData").map(Number).filter(d=>Number.isInteger(d)&&d>=1&&d<=31);
      const dates=parseArray("scheduleDatesData").filter(v=>/^\d{2}-\d{2}$/.test(String(v)));
      const hasSchedule=unit === "yearly" ? dates.length : days.length;
      const name=$("personName").value.trim();
      const startDate=$("personStartDate").value;
      if(!name || !startDate || !hasSchedule) return toast("名前・借入日・利息更新日を入力してください。");
      const old=state.loans.find(x=>x.id===id);
      const entry=normalizeLoan({id,name,principal:Number($("personPrincipal").value),rate:Number($("personRate").value),rateUnit:unit,startDate,updateDays:unit === "monthly" ? days : [],updateDates:unit === "yearly" ? dates : [],note:$("personNote").value.trim(),payments:old?.payments||[]});
      const i=state.loans.findIndex(x=>x.id===id);
      if(i>=0) state.loans[i]=entry; else state.loans.unshift(entry);
      $("personDialog").close();
      renderAll();
      await persist();
      toast("保存しました");
    } catch(err) {
      console.error("人の保存でエラー:",err);
      toast(`保存できませんでした: ${err?.message || err}`);
    }
  }

  function openGroupAdd(){
    $("groupForm").reset(); $("groupId").value=""; $("groupSharedAmount").value=""; $("groupScheduleDaysData").value="[]"; $("groupScheduleDatesData").value="[]"; setGroupScheduleDays([],[],"monthly"); renderPeopleSelects(); $("groupDialogTitle").textContent="グループを作成"; $("groupDialog").showModal();
  }
  function openGroupEdit(id){
    const g=state.groups.find(x=>x.id===id); if(!g)return;
    $("groupId").value=g.id; $("groupName").value=g.name; $("groupSharedAmount").value=g.sharedAmount??""; setGroupScheduleDays(g.updateDays||[],g.updateDates||[],g.rateUnit||"monthly"); renderPeopleSelects(); g.memberIds.forEach(id=>{const c=$("groupPeople").querySelector(`input[value="${id}"]`);if(c)c.checked=true;}); $("groupDialogTitle").textContent="グループを編集"; $("groupDialog").showModal();
  }
  async function saveGroup(e){
    e.preventDefault(); if(vaultCode&&!unlocked)return toast("先に保管庫を開いてください。");
    const id=$("groupId").value||uid(); const unit=$("groupRateUnit").value; const memberIds=[...$("groupPeople").querySelectorAll("input:checked")].map(x=>x.value); const days=JSON.parse($("groupScheduleDaysData").value||"[]"), dates=JSON.parse($("groupScheduleDatesData").value||"[]");
    const hasSchedule=unit === "yearly" ? dates.length : days.length;
    if(!$("groupName").value.trim()||!memberIds.length||!hasSchedule)return toast("グループ名・メンバー・更新日を入力してください。");
    const group=normalizeGroup({id,name:$("groupName").value.trim(),memberIds,sharedAmount:$("groupSharedAmount").value===""?null:Number($("groupSharedAmount").value),updateDays:unit === "monthly" ? days : [],updateDates:unit === "yearly" ? dates : [],rateUnit:unit});
    // A group has one common cycle, so selected people follow the group's monthly/yearly setting.
    state.loans.forEach(l=>{if(memberIds.includes(l.id)) l.rateUnit=unit;});
    // Keep one active group per person to avoid duplicate group schedules.
    state.groups=state.groups.filter(g=>g.id===id || !g.memberIds.some(pid=>memberIds.includes(pid)));
    const i=state.groups.findIndex(g=>g.id===id); if(i>=0)state.groups[i]=group;else state.groups.push(group);
    $("groupDialog").close(); renderAll(); await persist(); toast("グループを保存しました");
  }
  async function deleteGroup(id){
    const g=state.groups.find(x=>x.id===id);if(!g||!confirm(`「${g.name}」を削除しますか？`))return;state.groups=state.groups.filter(x=>x.id!==id);renderAll();await persist();toast("グループを削除しました");
  }
  async function deletePerson(id){
    const l=state.loans.find(x=>x.id===id);if(!l||!confirm(`${l.name}を削除しますか？`))return;state.loans=state.loans.filter(x=>x.id!==id);state.groups.forEach(g=>g.memberIds=g.memberIds.filter(x=>x!==id));state.groups=state.groups.filter(g=>g.memberIds.length);renderAll();await persist();toast("削除しました");
  }

  function openPayment(id,date=today()){
    const loan=state.loans.find(l=>l.id===id);if(!loan)return;
    $("paymentLoanId").value=id;$("paymentDate").value=date;$("paymentAmount").value=paymentForDate(loan,date)||"";$("paymentNote").value="";$("paymentDialog").showModal();
  }
  async function savePayment(e){
    e.preventDefault(); const loan=state.loans.find(l=>l.id===$("paymentLoanId").value);if(!loan)return;
    const date=$("paymentDate").value, amount=Number($("paymentAmount").value);if(!date||amount<=0)return toast("支払日と金額を入力してください。");
    loan.payments=(loan.payments||[]).filter(p=>p.date!==date);loan.payments.push({id:uid(),date,amount,note:$("paymentNote").value.trim()});$("paymentDialog").close();renderAll();await persist();toast("支払いを記録しました");
  }

  function openPersonDetail(id){
    const loan=state.loans.find(l=>l.id===id);if(!loan)return;selectedPersonId=id;
    const group=activeGroupFor(id);const interest=interestFor(loan);const balance=currentBalance(loan);const schedule=loan.rateUnit === "yearly" ? effectiveUpdateDates(loan).map(v=>{const [m,d]=v.split("-");return `${Number(m)}月${Number(d)}日`;}) : effectiveUpdateDays(loan).map(d=>d+"日");
    $("detailTitle").textContent=loan.name;
    $("detailBody").innerHTML=`<div class="detail-grid"><div><span>借入額</span><strong>${yen(effectivePrincipal(loan))}</strong></div><div><span>現在の金額</span><strong>${yen(balance)}</strong></div><div><span>利子</span><strong>${yen(interest)}</strong></div><div><span>利率</span><strong>${num(loan.rate)}% / ${loan.rateUnit==="monthly"?"月":"年"}</strong></div><div><span>利息更新日</span><strong>${schedule.join("・")||"—"}</strong></div><div><span>借入日</span><strong>${fmtDate(loan.startDate)}</strong></div></div><div class="detail-note">${group?`グループ：${esc(group.name)}${group.sharedAmount!=null?` · グループ金額 ${yen(group.sharedAmount)}`:""}`:"個別管理"}</div><h3 class="detail-subtitle">支払い履歴</h3><div class="payment-history">${(loan.payments||[]).slice().sort((a,b)=>b.date.localeCompare(a.date)).map(p=>`<div><span>${fmtDate(p.date)}</span><strong>${yen(p.amount)}</strong></div>`).join("")||`<span class="muted">まだ支払い記録がありません。</span>`}</div>`;
    $("personDetailDialog").showModal();
  }

  async function persist(){
    if(!unlocked||!vaultCode||!currentPin)return;
    clearTimeout(saveTimer); saveTimer=setTimeout(()=>syncCloud().catch(err=>toast(err.message)),300);
  }
  async function syncCloud(){
    if(!supabaseClient||!vaultCode||!currentPin){setStatus("ローカル");return;}
    setStatus("同期中…"); const encrypted=await CryptoVault.encryptObject(state,currentPin,vaultBlob?.salt||null);
    const {error}=await supabaseClient.rpc("save_encrypted_vault",{p_vault_code:vaultCode,p_payload:encrypted});
    if(error)throw new Error(`Supabase保存エラー: ${error.message}`);vaultBlob=encrypted;saveLocalBlob(encrypted);setStatus("クラウド同期済み",true);
  }
  async function fetchCloud(code){
    if(!supabaseClient)throw new Error("Supabaseの設定がありません。config.jsを確認してください。");
    const {data,error}=await supabaseClient.rpc("get_encrypted_vault",{p_vault_code:code});if(error)throw new Error(`Supabase取得エラー: ${error.message}`);return data;
  }
  function showVaultMessage(msg){$("vaultMessage").textContent=msg;}
  function prepareVaultDialog(){
    showVaultMessage("");$("vaultSetup").classList.toggle("hidden",!!vaultCode);$("vaultUnlock").classList.toggle("hidden",!vaultCode);$("pairingPanel").classList.add("hidden");$("vaultTitle").textContent=vaultCode?"保管庫を開く":"暗号保管庫";$("vaultDescription").textContent=vaultCode?"暗証コードで暗号化データを開きます。":"初回は暗証コードを設定してください。";
  }
  function setUnlockedUI(){
    $("lockButton").classList.toggle("hidden",!unlocked);$("vaultButton").classList.toggle("hidden",unlocked);setStatus(unlocked?"クラウド同期済み":"ローカル",unlocked);
  }
  function lockVault(){unlocked=false;currentPin=null;vaultBlob=null;state={loans:[],groups:[]};renderAll();setUnlockedUI();if(vaultCode)toast("ロックしました");}

  async function createVault(){
    const pin=$("setupPin").value, confirmPin=$("setupPinConfirm").value;
    if(pin.length<8)return showVaultMessage("暗証コードは8文字以上にしてください。");if(pin!==confirmPin)return showVaultMessage("暗証コードが一致しません。");if(!supabaseClient)return showVaultMessage("Supabase設定がありません。config.jsを確認してください。");
    try{const code=CryptoVault.randomVaultCode();const encrypted=await CryptoVault.encryptObject(state,pin);const {error}=await supabaseClient.rpc("save_encrypted_vault",{p_vault_code:code,p_payload:encrypted});if(error)throw new Error(error.message);vaultCode=code;vaultBlob=encrypted;currentPin=pin;unlocked=true;localStorage.setItem(STORAGE.vaultCode,code);saveLocalBlob(encrypted);setUnlockedUI();renderAll();$("vaultDialog").close();toast("暗号保管庫を作成しました");}catch(err){showVaultMessage(`作成できませんでした: ${err.message}`);}
  }
  async function unlockVault(){
    const pin=$("unlockPin").value;if(!pin)return showVaultMessage("暗証コードを入力してください.");if(!vaultCode)return;
    try{const row=await fetchCloud(vaultCode);if(!row?.payload)throw new Error("保管庫が見つかりません。");const data=normalizeState(await CryptoVault.decryptObject(row.payload,pin));state=data;vaultBlob=row.payload;currentPin=pin;unlocked=true;saveLocalBlob(row.payload);$("unlockPin").value="";setUnlockedUI();renderAll();$("vaultDialog").close();toast("ロックを解除しました");}catch(err){showVaultMessage(err.message);}
  }
  async function connectVault(){
    const code=$("connectCode").value.trim();if(code.length<32)return $("connectMessage").textContent="共有コードが短すぎます。";
    try{const row=await fetchCloud(code);if(!row?.payload)throw new Error("保管庫が見つかりません。");vaultCode=code;vaultBlob=row.payload;localStorage.setItem(STORAGE.vaultCode,code);$("connectDialog").close();prepareVaultDialog();$("vaultDialog").showModal();toast("保管庫を見つけました。暗証コードを入力してください。");}catch(err){$("connectMessage").textContent=err.message;}
  }
  async function changePairingCode(){
    if(!unlocked||!currentPin||!supabaseClient)return;
    try{const newCode=CryptoVault.randomVaultCode();const encrypted=await CryptoVault.encryptObject(state,currentPin);const {error}=await supabaseClient.rpc("save_encrypted_vault",{p_vault_code:newCode,p_payload:encrypted});if(error)throw new Error(error.message);vaultCode=newCode;vaultBlob=encrypted;localStorage.setItem(STORAGE.vaultCode,newCode);$("pairingCode").textContent=newCode;toast("新しい共有コードを作成しました");}catch(err){showVaultMessage(err.message);}
  }
  function showPairing(){
    $("pairingPanel").classList.remove("hidden");$("pairingCode").textContent=vaultCode||"—";$("pairingImport").classList.remove("hidden");
  }

  function esc(v){return String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));}
  function num(v){return Number(v||0).toLocaleString("ja-JP",{maximumFractionDigits:2});}
  function fmtDate(v){if(!v)return"—";const [y,m,d]=v.split("-");return `${y}/${m}/${d}`;}

  function setup(){
    state={loans:[],groups:[]};
    renderAll(); setUnlockedUI(); setStatus(supabaseClient?(vaultCode?"保管庫あり":"ローカル"):"Supabase未設定");

    $("addPersonButton").onclick=()=>{if(vaultCode&&!unlocked){prepareVaultDialog();$("vaultDialog").showModal();return;}openPersonAdd();};
    $("addGroupButton").onclick=()=>{if(vaultCode&&!unlocked){prepareVaultDialog();$("vaultDialog").showModal();return;}openGroupAdd();};
    $("vaultButton").onclick=()=>{prepareVaultDialog();$("vaultDialog").showModal();};
    $("lockButton").onclick=lockVault;
    $("createVaultButton").onclick=createVault;
    $("unlockButton").onclick=unlockVault;
    $("showPairingButton").onclick=showPairing;
    $("connectVaultButton").onclick=connectVault;
    $("connectStartButton").onclick=()=>$("connectDialog").showModal();
    $("copyPairingButton").onclick=async()=>{if(!vaultCode)return;await navigator.clipboard.writeText(vaultCode);toast("共有コードをコピーしました");};
    $("newPairingButton").onclick=changePairingCode;
    $("personForm").addEventListener("submit",savePerson);
    $("groupForm").addEventListener("submit",saveGroup);
    $("paymentForm").addEventListener("submit",savePayment);
    $("calcLoan").onchange=calculateResult;$("calcDate").onchange=calculateResult;
    $("prevMonth").onclick=()=>{calendarDate.setMonth(calendarDate.getMonth()-1);renderCalendar();};$("nextMonth").onclick=()=>{calendarDate.setMonth(calendarDate.getMonth()+1);renderCalendar();};$("todayMonth").onclick=()=>{calendarDate=new Date();renderCalendar();};
    $("todoPrev").onclick=()=>{todoDate.setMonth(todoDate.getMonth()-1);renderTodo();};$("todoNext").onclick=()=>{todoDate.setMonth(todoDate.getMonth()+1);renderTodo();};$("todoToday").onclick=()=>{todoDate=new Date();renderTodo();};
    $("personRateUnit").onchange=()=>{ const unit=$("personRateUnit").value; setScheduleUnit("person",unit); };
    $("groupRateUnit").onchange=()=>{ const unit=$("groupRateUnit").value; setScheduleUnit("group",unit); };
    $("addScheduleDay").onclick=()=>addScheduleValue("person");
    $("addGroupScheduleDay").onclick=()=>addScheduleValue("group");
    document.querySelectorAll("[data-close]").forEach(btn=>btn.onclick=()=>$(btn.dataset.close).close());
    $("detailEditButton").onclick=()=>{ $("personDetailDialog").close(); if(selectedPersonId)openPersonEdit(selectedPersonId); };
    $("detailPaymentButton").onclick=()=>{ $("personDetailDialog").close(); if(selectedPersonId)openPayment(selectedPersonId); };
  }

  setup();
})();
