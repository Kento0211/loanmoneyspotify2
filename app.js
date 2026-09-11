(() => {
  "use strict";

  const CONFIG = window.APP_CONFIG || {};
  const supabaseClient = (
    CONFIG.SUPABASE_URL &&
    CONFIG.SUPABASE_PUBLISHABLE_KEY &&
    window.supabase?.createClient
  ) ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_PUBLISHABLE_KEY) : null;

  const STORAGE = {
    loans: "loan-ledger-local-loans-v2",
    vaultCode: "loan-ledger-vault-code-v2",
    meta: "loan-ledger-vault-meta-v2"
  };

  let loans = [];
  let unlocked = false;
  let vaultCode = localStorage.getItem(STORAGE.vaultCode) || "";
  let vaultBlob = null;
  let currentPin = null;
  let calendarDate = new Date();
  let saveTimer = null;

  const $ = id => document.getElementById(id);
  const yen = n => new Intl.NumberFormat("ja-JP", { style:"currency", currency:"JPY", maximumFractionDigits:0 }).format(Math.round(n || 0));
  const dateISO = d => {
    const x = new Date(d);
    const y = x.getFullYear();
    const m = String(x.getMonth()+1).padStart(2,"0");
    const day = String(x.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  };
  const today = () => dateISO(new Date());

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 2300);
  }

  function setStatus(text, online=false) {
    $("syncStatus").textContent = text;
    $("syncStatus").classList.toggle("online", online);
  }

  function loadLocal() {
    try { loans = JSON.parse(localStorage.getItem(STORAGE.loans) || "[]"); }
    catch { loans = []; }
  }

  function saveLocal() {
    localStorage.setItem(STORAGE.loans, JSON.stringify(loans));
  }

  function monthlyCount(start, update, target) {
    const s = new Date(start + "T00:00:00");
    const u = new Date(update + "T00:00:00");
    const t = new Date(target + "T00:00:00");
    if (t < s || t < u) return 0;
    let count = 0;
    const cursor = new Date(u);
    while (cursor <= t && count < 2400) {
      count++;
      cursor.setMonth(cursor.getMonth()+1);
    }
    return count;
  }

  function yearlyCount(start, update, target) {
    const s = new Date(start + "T00:00:00");
    const u = new Date(update + "T00:00:00");
    const t = new Date(target + "T00:00:00");
    if (t < s || t < u) return 0;
    let count = 0;
    const cursor = new Date(u);
    while (cursor <= t && count < 200) {
      count++;
      cursor.setFullYear(cursor.getFullYear()+1);
    }
    return count;
  }

  function interestFor(loan, targetDate = today()) {
    const count = loan.rateUnit === "yearly"
      ? yearlyCount(loan.startDate, loan.updateDate, targetDate)
      : monthlyCount(loan.startDate, loan.updateDate, targetDate);
    return Number(loan.principal) * (Number(loan.rate) / 100) * count;
  }

  function totalInterest() {
    return loans.reduce((sum,l) => sum + interestFor(l), 0);
  }

  function renderAll() {
    renderLoans();
    renderCalculator();
    renderSummary();
    renderCalendar();
    $("heroTotal").textContent = yen(loans.reduce((s,l)=>s+Number(l.principal),0));
    $("heroInterest").textContent = `累計利子 ${yen(totalInterest())}`;
    $("loanCountLabel").textContent = `${loans.length}件の貸付`;
  }

  function renderLoans() {
    const list = $("loanList");
    if (!loans.length) {
      list.innerHTML = `<div class="empty">まだ貸付がありません。<br>「＋ 貸付を追加」から登録してください。</div>`;
      return;
    }
    list.innerHTML = loans.map(loan => {
      const interest = interestFor(loan);
      return `<article class="loan-card glass">
        <div class="loan-top">
          <div>
            <div class="loan-name">${esc(loan.name)}</div>
            <div class="loan-note">${esc(loan.note || "メモなし")}</div>
          </div>
          <span class="status-pill">${loan.rateUnit === "monthly" ? "月利" : "年利"} ${num(loan.rate)}%</span>
        </div>
        <div class="loan-amount">${yen(loan.principal)}</div>
        <div class="loan-meta">
          <div><span>現在までの利子</span><strong>${yen(interest)}</strong></div>
          <div><span>更新日</span><strong>${fmtDate(loan.updateDate)}</strong></div>
        </div>
        <div class="loan-actions">
          <button class="small-button" data-edit="${loan.id}">編集</button>
          <button class="small-button" data-delete="${loan.id}">削除</button>
        </div>
      </article>`;
    }).join("");
    list.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => openEdit(b.dataset.edit));
    list.querySelectorAll("[data-delete]").forEach(b => b.onclick = () => deleteLoan(b.dataset.delete));
  }

  function renderCalculator() {
    const select = $("calcLoan");
    const old = select.value;
    select.innerHTML = `<option value="">貸付を選択</option>` + loans.map(l => `<option value="${l.id}">${esc(l.name)} — ${yen(l.principal)}</option>`).join("");
    if (loans.some(l=>l.id===old)) select.value = old;
    if (!$("calcDate").value) $("calcDate").value = today();
    calculateResult();
  }

  function calculateResult() {
    const loan = loans.find(l => l.id === $("calcLoan").value);
    const date = $("calcDate").value || today();
    const result = $("calcResult");
    if (!loan) {
      result.innerHTML = `<span>計算結果</span><strong>貸付を選択してください</strong>`;
      return;
    }
    const interest = interestFor(loan, date);
    result.innerHTML = `<span>${fmtDate(date)} 時点</span><strong>${yen(interest)} の利子</strong><small>${yen(Number(loan.principal)+interest)}（元金＋利子）</small>`;
  }

  function renderSummary() {
    const principal = loans.reduce((s,l)=>s+Number(l.principal),0);
    const interest = totalInterest();
    $("summaryCount").textContent = loans.length;
    $("summaryPrincipal").textContent = yen(principal);
    $("summaryInterest").textContent = yen(interest);
    $("summaryTotal").textContent = yen(principal+interest);
  }

  function renderCalendar() {
    const y = calendarDate.getFullYear(), m = calendarDate.getMonth();
    $("calendarTitle").textContent = `${y}年${m+1}月`;
    const first = new Date(y,m,1);
    const last = new Date(y,m+1,0);
    const start = new Date(y,m,1-first.getDay());
    const grid = $("calendarGrid");
    const cells = [];
    for (let i=0;i<42;i++) {
      const d = new Date(start);
      d.setDate(start.getDate()+i);
      const iso = dateISO(d);
      const events = loans.filter(l => l.updateDate.slice(5) === iso.slice(5));
      const muted = d.getMonth() !== m;
      const cls = ["calendar-day", muted ? "muted" : "", iso===today() ? "today":""].join(" ");
      cells.push(`<div class="${cls}">
        <div class="day-number">${d.getDate()}</div>
        ${events.map(e=>`<span class="event">${esc(e.name)}</span>`).join("")}
      </div>`);
    }
    grid.innerHTML = cells.join("");
  }

  function openAdd() {
    $("loanForm").reset();
    $("loanId").value = "";
    $("loanDialogTitle").textContent = "貸付を追加";
    $("loanStartDate").value = today();
    $("loanUpdateDate").value = today();
    $("loanDialog").showModal();
  }

  function openEdit(id) {
    const l = loans.find(x=>x.id===id);
    if (!l) return;
    $("loanId").value = l.id;
    $("loanName").value = l.name;
    $("loanPrincipal").value = l.principal;
    $("loanRate").value = l.rate;
    $("loanRateUnit").value = l.rateUnit;
    $("loanStartDate").value = l.startDate;
    $("loanUpdateDate").value = l.updateDate;
    $("loanNote").value = l.note || "";
    $("loanDialogTitle").textContent = "貸付を編集";
    $("loanDialog").showModal();
  }

  async function deleteLoan(id) {
    const l = loans.find(x=>x.id===id);
    if (!l || !confirm(`${l.name} の貸付を削除しますか？`)) return;
    loans = loans.filter(x=>x.id!==id);
    await persist();
    renderAll();
    toast("削除しました");
  }

  async function saveLoan(e) {
    e.preventDefault();
    if (!unlocked && vaultCode) return toast("先に保管庫を開いてください。");
    const id = $("loanId").value || crypto.randomUUID();
    const entry = {
      id,
      name: $("loanName").value.trim(),
      principal: Number($("loanPrincipal").value),
      rate: Number($("loanRate").value),
      rateUnit: $("loanRateUnit").value,
      startDate: $("loanStartDate").value,
      updateDate: $("loanUpdateDate").value,
      note: $("loanNote").value.trim()
    };
    if (!entry.name || !entry.startDate || !entry.updateDate) return;
    const idx = loans.findIndex(x=>x.id===id);
    if (idx >= 0) loans[idx] = entry; else loans.unshift(entry);
    $("loanDialog").close();
    renderAll();
    await persist();
    toast("保存しました");
  }

  async function persist() {
    saveLocal();
    if (!unlocked || !vaultCode || !currentPin) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => syncCloud().catch(err => toast(err.message)), 250);
  }

  async function syncCloud() {
    if (!supabaseClient || !vaultCode || !currentPin) {
      setStatus("ローカル");
      return;
    }
    setStatus("同期中…");
    const encrypted = await CryptoVault.encryptObject({ loans }, currentPin, vaultBlob?.salt || null);
    const { error } = await supabaseClient.rpc("save_encrypted_vault", {
      p_vault_code: vaultCode,
      p_payload: encrypted
    });
    if (error) throw new Error(`Supabase保存エラー: ${error.message}`);
    vaultBlob = encrypted;
    setStatus("クラウド同期済み", true);
  }

  async function fetchCloud(code) {
    if (!supabaseClient) throw new Error("Supabaseの設定がありません。config.jsを確認してください。");
    const { data, error } = await supabaseClient.rpc("get_encrypted_vault", { p_vault_code: code });
    if (error) throw new Error(`Supabase取得エラー: ${error.message}`);
    return data;
  }

  async function createVault() {
    const pin = $("setupPin").value;
    const confirmPin = $("setupPinConfirm").value;
    if (pin.length < 8) return showVaultMessage("暗証コードは8文字以上にしてください。");
    if (pin !== confirmPin) return showVaultMessage("暗証コードが一致しません。");
    if (!supabaseClient) return showVaultMessage("Supabase設定がありません。config.jsを確認してください。");

    try {
      const code = CryptoVault.randomVaultCode();
      const empty = { loans: [] };
      const encrypted = await CryptoVault.encryptObject(empty, pin);
      const { error } = await supabaseClient.rpc("save_encrypted_vault", {
        p_vault_code: code, p_payload: encrypted
      });
      if (error) throw new Error(error.message);

      vaultCode = code;
      vaultBlob = encrypted;
      currentPin = pin;
      unlocked = true;
      localStorage.setItem(STORAGE.vaultCode, vaultCode);
      $("setupPin").value = "";
      $("setupPinConfirm").value = "";
      setUnlockedUI();
      renderAll();
      await syncCloud();
      $("vaultDialog").close();
      toast("暗号保管庫を作成しました");
    } catch (err) {
      showVaultMessage(`作成できませんでした: ${err.message}`);
    }
  }

  async function unlockVault() {
    const pin = $("unlockPin").value;
    if (!pin) return showVaultMessage("暗証コードを入力してください。");
    if (!vaultCode) return;
    try {
      const row = await fetchCloud(vaultCode);
      if (!row?.payload) throw new Error("保管庫が見つかりません。共有コードを確認してください。");
      const data = await CryptoVault.decryptObject(row.payload, pin);
      loans = Array.isArray(data.loans) ? data.loans : [];
      vaultBlob = row.payload;
      currentPin = pin;
      unlocked = true;
      saveLocal();
      $("unlockPin").value = "";
      setUnlockedUI();
      renderAll();
      $("vaultDialog").close();
      toast("ロックを解除しました");
      setStatus("クラウド同期済み", true);
    } catch (err) {
      showVaultMessage(err.message);
    }
  }

  async function connectVault() {
    const code = $("connectCode").value.trim();
    if (code.length < 32) return $("connectMessage").textContent = "共有コードが短すぎます。";
    try {
      const row = await fetchCloud(code);
      if (!row?.payload) throw new Error("保管庫が見つかりません。");
      vaultCode = code;
      vaultBlob = row.payload;
      localStorage.setItem(STORAGE.vaultCode, vaultCode);
      $("connectDialog").close();
      prepareVaultDialog();
      $("vaultDialog").showModal();
      toast("保管庫を見つけました。暗証コードを入力してください。");
    } catch (err) {
      $("connectMessage").textContent = err.message;
    }
  }

  function prepareVaultDialog() {
    $("vaultMessage").textContent = "";
    $("vaultSetup").classList.toggle("hidden", !!vaultCode);
    $("vaultUnlock").classList.toggle("hidden", !vaultCode);
    $("pairingPanel").classList.add("hidden");
    $("pairingImport").classList.add("hidden");
    $("vaultTitle").textContent = vaultCode ? "保管庫を開く" : "暗号保管庫";
    $("vaultDescription").textContent = vaultCode
      ? "暗証コードを入力すると暗号化データを復号します。"
      : "初回は暗証コードを設定してください。";
  }

  function setUnlockedUI() {
    $("lockButton").classList.toggle("hidden", !unlocked);
    $("vaultButton").classList.toggle("hidden", unlocked);
    $("lockButton").textContent = "ロック";
    setStatus(unlocked ? "クラウド同期済み" : "ローカル", unlocked);
  }

  function lockVault() {
    unlocked = false;
    currentPin = null;
    vaultBlob = null;
    setUnlockedUI();
    if (vaultCode) toast("ロックしました");
  }

  function showVaultMessage(msg) {
    $("vaultMessage").textContent = msg;
  }

  function showPairing() {
    $("pairingPanel").classList.remove("hidden");
    $("pairingImport").classList.remove("hidden");
    $("pairingCode").textContent = vaultCode || "保管庫を作成すると表示されます";
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[ch]));
  }
  function num(value) { return Number(value).toLocaleString("ja-JP", {maximumFractionDigits:2}); }
  function fmtDate(value) {
    if (!value) return "—";
    const [y,m,d] = value.split("-");
    return `${y}/${m}/${d}`;
  }

  function setup() {
    loadLocal();
    $("calcDate").value = today();
    renderAll();
    setUnlockedUI();

    if (supabaseClient) setStatus(vaultCode ? "保管庫あり" : "ローカル");
    else setStatus("Supabase未設定");

    $("addLoanButton").onclick = () => {
      if (vaultCode && !unlocked) {
        prepareVaultDialog(); $("vaultDialog").showModal(); return;
      }
      openAdd();
    };
    $("vaultButton").onclick = () => { prepareVaultDialog(); $("vaultDialog").showModal(); };
    $("lockButton").onclick = lockVault;
    $("createVaultButton").onclick = createVault;
    $("unlockButton").onclick = unlockVault;
    $("showPairingButton").onclick = showPairing;
    $("connectVaultButton").onclick = connectVault;
    $("connectStartButton").onclick = () => {
      $("connectDialog").showModal();
    };
    $("copyPairingButton").onclick = async () => {
      if (!vaultCode) return;
      await navigator.clipboard.writeText(vaultCode);
      toast("共有コードをコピーしました");
    };
    $("newPairingButton").onclick = async () => {
      if (!unlocked || !currentPin) return;
      const old = vaultCode;
      const newCode = CryptoVault.randomVaultCode();
      try {
        const encrypted = await CryptoVault.encryptObject({ loans }, currentPin);
        const { error } = await supabaseClient.rpc("save_encrypted_vault", {
          p_vault_code: newCode, p_payload: encrypted
        });
        if (error) throw new Error(error.message);
        vaultCode = newCode;
        vaultBlob = encrypted;
        localStorage.setItem(STORAGE.vaultCode, vaultCode);
        $("pairingCode").textContent = newCode;
        toast("新しい共有コードを作成しました");
        // Old vault is deliberately not deleted automatically to avoid accidental lockout.
        void old;
      } catch (err) { showVaultMessage(err.message); }
    };

    $("loanForm").addEventListener("submit", saveLoan);
    $("calcLoan").onchange = calculateResult;
    $("calcDate").onchange = calculateResult;
    $("prevMonth").onclick = () => { calendarDate.setMonth(calendarDate.getMonth()-1); renderCalendar(); };
    $("nextMonth").onclick = () => { calendarDate.setMonth(calendarDate.getMonth()+1); renderCalendar(); };
    $("todayMonth").onclick = () => { calendarDate = new Date(); renderCalendar(); };

    document.querySelectorAll("[data-close]").forEach(btn => {
      btn.onclick = () => $(btn.dataset.close).close();
    });

    // If this browser has no vault yet, local data remains available.
    // Once a vault is created/unlocked, data is encrypted and synced.
  }

  setup();
})();
