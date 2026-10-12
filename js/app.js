/* 薪資保險人事系統 — 前端主程式（純靜態，資料存 Supabase） */
(function () {
  'use strict';

  const { SUPABASE_URL, SUPABASE_KEY } = window.APP_CONFIG;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  const { DEFAULT_RATES, nearestGrade, employedInfo, calcPayroll, calcService } = window.Calc;

  const $ = (s, r = document) => r.querySelector(s);
  const view = $('#view');
  const dlg = $('#dlg');

  let rates = JSON.parse(JSON.stringify(DEFAULT_RATES));
  let employees = [];

  /* ---------- 小工具 ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v) => Number(v || 0).toLocaleString('zh-TW');
  const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const thisMonth = () => new Date().toISOString().slice(0, 7);
  const today = () => new Date().toISOString().slice(0, 10);
  const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return d.toISOString().slice(0, 7); };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } };

  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // 包裝 Supabase 呼叫：有錯就顯示並中斷
  async function q(promise) {
    const { data, error } = await promise;
    if (error) { toast('發生錯誤：' + error.message, true); throw error; }
    return data;
  }

  // 一次最多回 1000 筆，所以分頁抓完
  async function fetchAll(table, orderCol) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = await q(sb.from(table).select('*').order(orderCol).range(from, from + 999));
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }

  function downloadFile(filename, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function downloadCSV(filename, rows) {
    const body = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    downloadFile(filename, '﻿' + body, 'text/csv;charset=utf-8');
  }

  function openDialog(html) {
    dlg.innerHTML = html;
    dlg.showModal();
    dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  }

  /* ---------- 登入 ---------- */
  async function showApp() {
    $('#loginView').hidden = true;
    $('#app').hidden = false;
    await loadRates();
    await loadEmployees();
    route();
  }
  function showLogin() {
    $('#app').hidden = true;
    $('#loginView').hidden = false;
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    $('#loginError').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
    if (error) $('#loginError').textContent = '登入失敗：Email 或密碼不正確';
    else e.target.reset();
  });
  $('#logoutBtn').addEventListener('click', () => sb.auth.signOut());

  sb.auth.onAuthStateChange((event, session) => {
    if (session) { if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') setTimeout(showApp, 0); }
    else showLogin();
  });

  /* ---------- 資料載入 ---------- */
  async function loadRates() {
    const { data } = await sb.from('settings').select('value').eq('key', 'rates').maybeSingle();
    rates = Object.assign(JSON.parse(JSON.stringify(DEFAULT_RATES)), data ? data.value : {});
  }
  async function loadEmployees() {
    employees = await q(sb.from('employees').select('*').order('emp_no').order('name'));
  }

  /* ---------- 路由 ---------- */
  const routes = { home: viewHome, employees: viewEmployees, payroll: viewPayroll, batch: viewBatch, payslips: viewPayslips, service: viewService, settings: viewSettings };
  function route() {
    const name = (location.hash.replace(/^#\/?/, '') || 'home');
    const key = routes[name] ? name : 'home';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === key));
    routes[key]().catch((e) => console.error(e));
  }
  window.addEventListener('hashchange', route);

  /* ---------- 薪資單共用 ---------- */
  function snapshotEmp(emp) {
    return {
      name: emp.name, emp_no: emp.emp_no, title: emp.title, base_salary: emp.base_salary,
      labor_insured: emp.labor_insured, health_insured: emp.health_insured, dependents: emp.dependents,
      hire_date: emp.hire_date, resign_date: emp.resign_date
    };
  }
  function buildDetail(emp, inp, month) {
    const r = calcPayroll(emp, inp, rates, month);
    r.emp = snapshotEmp(emp);
    r.company = rates.company;
    return r;
  }
  const payrollRow = (empId, month, detail, status) => ({
    employee_id: empId, month, detail, net_pay: detail.net,
    status, paid_at: status === 'paid' ? new Date().toISOString() : null
  });
  const isPaid = (r) => r && r.status === 'paid';

  // 員工下拉選單可選的人：在職，或已有離職日（可能還要算最後一個月）
  const selectableEmployees = () => employees.filter((e) => e.active || e.resign_date);

  /* ======================================================
     總覽
  ====================================================== */
  async function viewHome() {
    const m = thisMonth();
    const slips = await q(sb.from('payrolls').select('net_pay, status, detail').eq('month', m));
    const active = employees.filter((e) => e.active).length;
    const net = slips.reduce((s, r) => s + r.net_pay, 0);
    const er = slips.reduce((s, r) => s + (r.detail.employer ? r.detail.employer.total : 0), 0);
    const gross = slips.reduce((s, r) => s + (r.detail.items ? r.detail.items.gross : 0), 0);
    const paid = slips.filter(isPaid).length;
    const lb = lsGet('lastBackup');
    const days = lb ? Math.floor((Date.now() - new Date(lb)) / 86400000) : null;
    const backupWarn = days === null || days > 30
      ? `<p class="note">${days === null ? '這台電腦還沒有備份紀錄。' : `距離上次備份已 ${days} 天。`}建議到「設定」頁下載一份備份。</p>` : '';
    view.innerHTML = `
      <div class="page-head"><h2>總覽（${esc(m)}）</h2></div>
      ${backupWarn}
      <div class="stats">
        <div class="stat"><span class="muted">在職員工</span><b>${active} 人</b></div>
        <div class="stat"><span class="muted">本月薪資單（已發放）</span><b>${slips.length} 張（${paid}）</b></div>
        <div class="stat"><span class="muted">應發薪資合計</span><b>$${money(gross)}</b></div>
        <div class="stat"><span class="muted">實發金額合計</span><b>$${money(net)}</b></div>
        <div class="stat"><span class="muted">雇主負擔（勞健退）</span><b>$${money(er)}</b></div>
      </div>
      <div class="card">
        <h3>使用流程</h3>
        <ol>
          <li>到「設定」確認勞保、健保、所得稅等費率與投保級距是最新的。</li>
          <li>到「員工」新增員工，填入月薪、投保資料、到職日（離職時填離職日）。</li>
          <li>每月到「批次試算」一次填完所有人（或用「薪資試算」逐人處理），確認後儲存。</li>
          <li>到「薪資單」核對、標記「已發放」鎖定，再列印或匯出 CSV。</li>
          <li>定期到「設定」下載備份。</li>
        </ol>
        <p class="note">本系統為試算輔助工具，費率、級距與扣繳稅額請以勞保局、健保署與國稅局公告為準。</p>
      </div>`;
  }

  /* ======================================================
     員工
  ====================================================== */
  async function viewEmployees() {
    await loadEmployees();
    const rows = employees.map((e) => `
      <tr>
        <td>${esc(e.emp_no)}</td><td>${esc(e.name)}</td><td>${esc(e.title)}</td>
        <td><span class="tag">${e.emp_type === 'part' ? '兼職' : '全職'}</span></td>
        <td class="num">${money(e.base_salary)}</td>
        <td class="num">${money(e.labor_insured)}</td>
        <td class="num">${money(e.health_insured)}</td>
        <td class="num">${e.dependents}</td>
        <td>${e.active ? '在職' : '<span class="muted">離職</span>'}${e.resign_date ? `<br><span class="muted">離職日 ${esc(e.resign_date)}</span>` : ''}</td>
        <td><button class="btn small" data-edit="${e.id}">編輯</button>
            <button class="btn small danger" data-del="${e.id}">刪除</button></td>
      </tr>`).join('');
    view.innerHTML = `
      <div class="page-head"><h2>員工資料</h2><button class="btn primary" id="addEmp">＋ 新增員工</button></div>
      <div class="card table-wrap">
        ${employees.length ? `<table>
          <thead><tr><th>編號</th><th>姓名</th><th>職稱</th><th>類型</th><th class="num">月薪</th><th class="num">勞保投保</th><th class="num">健保投保</th><th class="num">眷屬</th><th>狀態</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table>` : '<div class="empty">還沒有員工，按右上角「新增員工」開始。</div>'}
      </div>`;
    $('#addEmp').onclick = () => employeeForm();
    view.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => employeeForm(employees.find((e) => e.id === b.dataset.edit))));
    view.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const e = employees.find((x) => x.id === b.dataset.del);
      if (!confirm(`確定刪除「${e.name}」？\n該員工已儲存的所有薪資單也會一併刪除，無法復原。\n（若只是離職，建議填離職日並改為「離職」狀態。）`)) return;
      try { await q(sb.from('employees').delete().eq('id', e.id)); } catch (err) { return; }
      toast('已刪除');
      viewEmployees();
    }));
  }

  function employeeForm(emp) {
    const e = emp || { emp_type: 'full', base_salary: 0, labor_insured: 0, health_insured: 0, dependents: 0, tax_dependents: 0, pension_self_rate: rates.pensionSelfDefault, active: true, hire_date: today() };
    openDialog(`
      <form id="empForm">
        <h3>${emp ? '編輯員工' : '新增員工'}</h3>
        <div class="grid">
          <label>員工編號<input name="emp_no" value="${esc(e.emp_no)}"></label>
          <label>姓名 *<input name="name" value="${esc(e.name)}" required></label>
          <label>職稱<input name="title" value="${esc(e.title)}"></label>
          <label>身分證／居留證字號（選填）<input name="id_no" maxlength="10" autocomplete="off" value="${esc(e.id_no)}"
            pattern="[A-Za-z][A-Da-d12][0-9]{8}" title="格式：1 個英文字母＋1 位數字（或 A–D）＋8 位數字"></label>
          <label>戶籍地址（選填）<input name="address" autocomplete="off" value="${esc(e.address)}"></label>
          <label>Email（選填）<input type="email" name="email" autocomplete="off" value="${esc(e.email)}"></label>
          <label>聯絡電話（選填）<input type="tel" name="phone" autocomplete="off" value="${esc(e.phone)}"></label>
          <label>到職日<input type="date" name="hire_date" value="${esc(e.hire_date || '')}"></label>
          <label>離職日（在職免填）<input type="date" name="resign_date" value="${esc(e.resign_date || '')}"></label>
          <label>類型<select name="emp_type">
            <option value="full" ${e.emp_type === 'full' ? 'selected' : ''}>全職</option>
            <option value="part" ${e.emp_type === 'part' ? 'selected' : ''}>兼職</option></select></label>
          <label>月薪（元）<input type="number" min="0" name="base_salary" value="${e.base_salary}"></label>
          <label>勞保投保薪資<input type="number" min="0" name="labor_insured" value="${e.labor_insured}"></label>
          <label>健保投保金額<input type="number" min="0" name="health_insured" value="${e.health_insured}"></label>
          <label>健保眷屬人數（0–3）<input type="number" min="0" max="3" name="dependents" value="${e.dependents}"></label>
          <label>扶養親屬人數（報稅免稅額用）<input type="number" min="0" max="20" name="tax_dependents" value="${e.tax_dependents || 0}"></label>
          <label>勞退自提 %（0–6）<input type="number" min="0" max="6" step="0.5" name="pension_self_rate" value="${Number((e.pension_self_rate * 100).toFixed(2))}"></label>
        </div>
        <p><button type="button" class="btn small" id="autoGrade">依月薪自動帶入投保級距</button>
           <span class="muted">兼職或未在本單位投保者，請把投保欄位填 0。</span></p>
        <label>備註<textarea name="note">${esc(e.note)}</textarea></label>
        <label class="check"><input type="checkbox" name="active" ${e.active ? 'checked' : ''}> 在職（離職後最後一個月薪資算完，再取消勾選）</label>
        <div class="dlg-actions"><button type="button" class="btn" data-close>取消</button><button class="btn primary" type="submit">儲存</button></div>
      </form>`);
    const form = $('#empForm');
    $('#autoGrade').onclick = () => {
      const s = num(form.base_salary.value);
      form.labor_insured.value = nearestGrade(s, rates.laborGrades);
      form.health_insured.value = nearestGrade(s, rates.healthGrades);
    };
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(form);
      const row = {
        emp_no: f.get('emp_no').trim(), name: f.get('name').trim(), title: f.get('title').trim(),
        id_no: f.get('id_no').trim().toUpperCase(), address: f.get('address').trim(),
        email: f.get('email').trim(), phone: f.get('phone').trim(),
        hire_date: f.get('hire_date') || null, resign_date: f.get('resign_date') || null, emp_type: f.get('emp_type'),
        base_salary: Math.round(num(f.get('base_salary'))),
        labor_insured: Math.round(num(f.get('labor_insured'))),
        health_insured: Math.round(num(f.get('health_insured'))),
        dependents: Math.min(3, Math.max(0, Math.round(num(f.get('dependents'))))),
        tax_dependents: Math.min(20, Math.max(0, Math.round(num(f.get('tax_dependents'))))),
        pension_self_rate: Math.min(6, Math.max(0, num(f.get('pension_self_rate')))) / 100,
        note: f.get('note').trim(), active: f.get('active') === 'on'
      };
      if (row.resign_date && row.hire_date && row.resign_date < row.hire_date) return toast('離職日不可早於到職日', true);
      await q(emp ? sb.from('employees').update(row).eq('id', emp.id) : sb.from('employees').insert(row));
      dlg.close();
      toast('已儲存');
      viewEmployees();
    });
  }

  /* ======================================================
     薪資試算（單人）
  ====================================================== */
  async function viewPayroll() {
    await loadEmployees();
    const list = selectableEmployees();
    view.innerHTML = `
      <div class="page-head"><h2>薪資試算（單人）</h2><a class="btn" href="#/batch">改用批次試算</a></div>
      <div class="card"><div class="row">
        <label style="min-width:160px">薪資月份<input type="month" id="pMonth" value="${thisMonth()}"></label>
        <label style="min-width:220px">員工<select id="pEmp">
          ${list.map((e) => `<option value="${e.id}">${esc(e.emp_no)} ${esc(e.name)}${e.active ? '' : '（離職）'}</option>`).join('')}</select></label>
      </div></div>
      <div id="pBody">${list.length ? '' : '<div class="card empty">請先到「員工」新增在職員工。</div>'}</div>`;
    if (!list.length) return;
    const load = () => payrollEditor($('#pEmp').value, $('#pMonth').value);
    $('#pMonth').onchange = load;
    $('#pEmp').onchange = load;
    load();
  }

  async function payrollEditor(empId, month) {
    if (!empId || !month) return;
    const emp = employees.find((e) => e.id === empId);
    const body = $('#pBody');
    const existing = await q(sb.from('payrolls').select('*').eq('employee_id', empId).eq('month', month).maybeSingle());
    // 本年度此月份以前已發獎金（二代健保補充保費累計用）
    const prev = await q(sb.from('payrolls').select('detail').eq('employee_id', empId).gte('month', month.slice(0, 4) + '-01').lt('month', month));
    const priorBonus = prev.reduce((s, r) => s + num(r.detail && r.detail.input && r.detail.input.bonus), 0);
    const iv = existing ? existing.detail.input : {};
    const locked = isPaid(existing);

    const nf = (name, label, step) => `<label>${label}<input type="number" step="${step || 1}" min="0" name="${name}" value="${name === 'priorBonus' ? priorBonus : (iv[name] || 0)}"></label>`;
    body.innerHTML = `
      <div class="two-col">
        <form class="card" id="pForm">
          <h3>${esc(emp.name)}　月薪 $${money(emp.base_salary)}</h3>
          ${locked ? `<p class="note">🔒 此薪資單已於 ${esc((existing.paid_at || '').slice(0, 10))} 標記為已發放，無法修改。要修改請先解除鎖定。</p>`
            : existing ? '<p class="note">此月份已有草稿薪資單，儲存會覆蓋舊資料。</p>' : ''}
          <fieldset ${locked ? 'disabled' : ''} style="border:0;padding:0;margin:0">
            <div class="grid">
              ${nf('ot1', '加班 1.34 倍（小時）', 0.5)}
              ${nf('ot2', '加班 1.67 倍（小時）', 0.5)}
              ${nf('ot3', '加班 2 倍（小時）', 0.5)}
              ${nf('personalHours', '事假（小時，不給薪）', 0.5)}
              ${nf('sickHours', '普通病假（小時，半薪）', 0.5)}
              ${nf('allowance', '津貼／津補貼（元）')}
              ${nf('bonus', '獎金（元）')}
              ${nf('priorBonus', '本年度先前已發獎金（元）')}
              ${nf('otherAdd', '其他加項（元）')}
              <label>代扣所得稅（留空＝自動估算）<input type="number" min="0" name="tax" placeholder="自動" value="${iv.tax === null || iv.tax === undefined ? '' : iv.tax}"></label>
              ${nf('otherDeduct', '其他扣款（元）')}
            </div>
            <div class="dlg-actions">
              <button class="btn" type="submit" data-status="draft">儲存草稿</button>
              <button class="btn primary" type="submit" data-status="paid">儲存並標記已發放</button>
            </div>
          </fieldset>
          ${locked ? '<div class="dlg-actions"><button type="button" class="btn" id="unlockBtn">解除鎖定</button></div>' : ''}
        </form>
        <div class="card" id="pResult"></div>
      </div>`;
    const form = $('#pForm');
    const compute = () => {
      const inp = {};
      new FormData(form).forEach((val, k) => (inp[k] = k === 'tax' ? val : num(val)));
      return buildDetail(emp, inp, month);
    };
    const draw = () => { $('#pResult').innerHTML = breakdownHTML(locked ? existing.detail : compute()); };
    form.addEventListener('input', draw);
    draw();
    if (locked) {
      $('#unlockBtn').onclick = async () => {
        if (!confirm('解除鎖定後可再修改這張薪資單。確定嗎？')) return;
        await q(sb.from('payrolls').update({ status: 'draft', paid_at: null }).eq('id', existing.id));
        toast('已解除鎖定');
        payrollEditor(empId, month);
      };
      return;
    }
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const status = ev.submitter && ev.submitter.dataset.status === 'paid' ? 'paid' : 'draft';
      const r = compute();
      if (r.proration.notEmployed) return toast('這位員工在此月份不在職，無法建立薪資單', true);
      if (status === 'paid' && !confirm('標記為已發放後會鎖定，無法直接修改。確定嗎？')) return;
      await q(sb.from('payrolls').upsert(payrollRow(empId, month, r, status), { onConflict: 'employee_id,month' }));
      toast(status === 'paid' ? '已儲存並標記為已發放' : '草稿已儲存');
      payrollEditor(empId, month);
    });
  }

  function breakdownHTML(r) {
    const row = (l, v, cls) => `<tr class="${cls || ''}"><td>${l}</td><td class="num">${money(v)}</td></tr>`;
    const i = r.items, d = r.ded, er = r.employer, p = r.proration;
    let notes = '';
    if (p.notEmployed) notes += '<p class="note">這位員工在此月份不在職（尚未到職或已離職），不會產生薪資。</p>';
    else if (!p.full) notes += `<p class="note">到職／離職當月：在職 ${p.days} 天，本薪 = 月薪 ${money(i.fullBase)} × ${Math.min(p.days, rates.prorateDivisor)}/${rates.prorateDivisor}。勞保、勞退按日數，健保${p.healthRatio ? '收全月' : '月中退保當月不收'}。</p>`;
    return `
      <h3>試算結果</h3>${notes}
      <table class="breakdown">
        ${row(p.full ? '本薪' : '本薪（按日計）', i.base)}${row('津貼', i.allowance)}${row('加班費', i.overtimePay)}${row('獎金', i.bonus)}${row('其他加項', i.otherAdd)}
        ${row('請假扣薪', -i.leaveDeduct)}${row('應發薪資', i.gross, 'total')}
        ${row('勞保費（自付）', -d.labor)}${row('健保費（自付）', -d.health)}${row('勞退自提', -d.pension)}
        ${row('二代健保補充保費', -d.supp)}${row(r.taxAuto ? '所得稅（自動估算）' : '所得稅（手動）', -d.tax)}${row('其他扣款', -d.otherDeduct)}
        ${row('扣款合計', -d.total, 'total')}
        ${row('實發金額', r.net, 'net')}
      </table>
      <h3 style="margin-top:16px">雇主負擔（不從薪資扣）</h3>
      <table class="breakdown">
        ${row('勞保費', er.labor)}${row('健保費（含平均眷口）', er.health)}${row('勞退 6%', er.pension)}${row('合計', er.total, 'total')}
      </table>
      <p class="muted">時薪 $${r.hourly}（月薪 ÷ ${rates.hoursPerMonth}）。所得稅為估算，請以扣繳稅額表為準。</p>`;
  }

  /* ======================================================
     批次試算
  ====================================================== */
  const BATCH_COLS = [
    ['ot1', '加班1.34'], ['ot2', '加班1.67'], ['ot3', '加班2'], ['personalHours', '事假h'], ['sickHours', '病假h'],
    ['allowance', '津貼'], ['bonus', '獎金'], ['otherAdd', '其他加項'], ['tax', '所得稅'], ['otherDeduct', '其他扣款']
  ];

  async function viewBatch() {
    await loadEmployees();
    view.innerHTML = `
      <div class="page-head"><h2>批次薪資試算</h2>
        <div class="row">
          <label>月份<input type="month" id="bMonth" value="${thisMonth()}"></label>
          <button class="btn" id="bCopy">帶入上月固定項目</button>
          <button class="btn" id="bSave">儲存全部草稿</button>
          <button class="btn primary" id="bPaid">全部標記已發放</button>
        </div></div>
      <p class="muted">所得稅欄位留空＝自動估算。「帶入上月固定項目」只複製津貼、其他加項、其他扣款。已發放（🔒）的列不會被修改。</p>
      <div class="card table-wrap" id="bTable"></div>`;

    let state = [];
    let month = '';

    const rowCalc = (s) => buildDetail(s.emp, s.inp, month);
    const paintRow = (s) => {
      const tr = view.querySelector(`tr[data-id="${s.emp.id}"]`);
      const r = rowCalc(s);
      tr.querySelector('.c-gross').textContent = money(r.items.gross);
      tr.querySelector('.c-ded').textContent = money(r.ded.total);
      tr.querySelector('.c-net').textContent = money(r.net);
      tr.querySelector('.c-tax').textContent = r.taxAuto ? `自動 ${money(r.ded.tax)}` : '';
    };

    const load = async () => {
      month = $('#bMonth').value;
      if (!month) return;
      const [cur, prior] = await Promise.all([
        q(sb.from('payrolls').select('*').eq('month', month)),
        q(sb.from('payrolls').select('employee_id, detail').gte('month', month.slice(0, 4) + '-01').lt('month', month))
      ]);
      const curMap = new Map(cur.map((r) => [r.employee_id, r]));
      const bonusMap = new Map();
      prior.forEach((r) => bonusMap.set(r.employee_id, (bonusMap.get(r.employee_id) || 0) + num(r.detail && r.detail.input && r.detail.input.bonus)));

      let skipped = 0;
      state = [];
      for (const emp of employees) {
        if (!(emp.active || emp.resign_date || curMap.has(emp.id))) continue;
        if (employedInfo(emp, month).days === 0) { if (emp.active) skipped++; continue; }
        const existing = curMap.get(emp.id);
        const iv = existing ? existing.detail.input : {};
        const inp = { priorBonus: bonusMap.get(emp.id) || 0, tax: iv.tax === null || iv.tax === undefined ? '' : iv.tax };
        BATCH_COLS.forEach(([k]) => { if (k !== 'tax') inp[k] = iv[k] || 0; });
        state.push({ emp, existing, inp, locked: isPaid(existing) });
      }

      const head = BATCH_COLS.map(([, l]) => `<th>${l}</th>`).join('');
      $('#bTable').innerHTML = state.length ? `<table>
        <thead><tr><th>員工</th>${head}<th class="num">應發</th><th class="num">扣款</th><th class="num">實發</th><th>狀態</th></tr></thead>
        <tbody>${state.map((s) => `<tr data-id="${s.emp.id}">
          <td>${esc(s.emp.emp_no)} ${esc(s.emp.name)}${s.emp.active ? '' : ' <span class="muted">(離職)</span>'}</td>
          ${BATCH_COLS.map(([k]) => `<td><input class="mini" type="number" min="0" step="any" data-f="${k}" ${s.locked ? 'disabled' : ''}
              value="${k === 'tax' ? s.inp.tax : (s.inp[k] || '')}" placeholder="${k === 'tax' ? '自動' : '0'}"></td>`).join('')}
          <td class="num c-gross"></td><td class="num c-ded"></td><td class="num"><b class="c-net"></b><br><span class="muted c-tax"></span></td>
          <td>${s.locked ? '🔒 已發放' : s.existing ? '草稿' : '<span class="muted">未建立</span>'}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">這個月份沒有需要計薪的員工。</div>';
      if (skipped) $('#bTable').insertAdjacentHTML('beforeend', `<p class="muted">另有 ${skipped} 位在職員工在此月份尚未到職，已略過。</p>`);
      state.forEach(paintRow);
    };

    $('#bTable').addEventListener('input', (ev) => {
      const el = ev.target;
      if (!el.dataset.f) return;
      const s = state.find((x) => x.emp.id === el.closest('tr').dataset.id);
      s.inp[el.dataset.f] = el.dataset.f === 'tax' ? el.value : num(el.value);
      paintRow(s);
    });
    $('#bMonth').onchange = load;

    $('#bCopy').onclick = async () => {
      const prev = await q(sb.from('payrolls').select('employee_id, detail').eq('month', prevMonth(month)));
      const map = new Map(prev.map((r) => [r.employee_id, r.detail.input || {}]));
      let n = 0;
      state.forEach((s) => {
        if (s.locked || !map.has(s.emp.id)) return;
        const iv = map.get(s.emp.id);
        ['allowance', 'otherAdd', 'otherDeduct'].forEach((k) => {
          s.inp[k] = iv[k] || 0;
          view.querySelector(`tr[data-id="${s.emp.id}"] [data-f="${k}"]`).value = s.inp[k] || '';
        });
        paintRow(s); n++;
      });
      toast(n ? `已帶入 ${n} 位員工的上月固定項目` : '上月沒有可帶入的資料', !n);
    };

    const saveAll = async (status) => {
      const todo = state.filter((s) => !s.locked);
      if (!todo.length) return toast('沒有可儲存的列（全部已發放或無人）', true);
      if (status === 'paid' && !confirm(`將 ${todo.length} 位員工的 ${month} 薪資單標記為已發放並鎖定，確定嗎？`)) return;
      const payload = todo.map((s) => payrollRow(s.emp.id, month, rowCalc(s), status));
      await q(sb.from('payrolls').upsert(payload, { onConflict: 'employee_id,month' }));
      toast(status === 'paid' ? `已發放 ${todo.length} 張` : `已儲存 ${todo.length} 張草稿`);
      load();
    };
    $('#bSave').onclick = () => saveAll('draft');
    $('#bPaid').onclick = () => saveAll('paid');
    load();
  }

  /* ======================================================
     薪資單
  ====================================================== */
  async function viewPayslips() {
    view.innerHTML = `
      <div class="page-head"><h2>薪資單</h2>
        <div class="row"><label>月份<input type="month" id="sMonth" value="${thisMonth()}"></label>
        <button class="btn" id="sPaidAll">本月草稿全部標記已發放</button>
        <button class="btn" id="sCsv">匯出 CSV</button></div></div>
      <div class="card table-wrap" id="sList"></div>`;
    let list = [];
    const load = async () => {
      list = await q(sb.from('payrolls').select('*').eq('month', $('#sMonth').value).order('created_at'));
      const sum = (f) => list.reduce((s, r) => s + f(r.detail), 0);
      $('#sList').innerHTML = list.length ? `<table>
        <thead><tr><th>員工</th><th>狀態</th><th class="num">應發</th><th class="num">勞保</th><th class="num">健保</th><th class="num">勞退自提</th><th class="num">補充保費</th><th class="num">所得稅＋其他</th><th class="num">實發</th><th class="num">雇主負擔</th><th></th></tr></thead>
        <tbody>${list.map((r, idx) => { const d = r.detail; return `<tr>
          <td>${esc(d.emp.emp_no)} ${esc(d.emp.name)}</td>
          <td>${isPaid(r) ? '🔒 已發放' : '草稿'}</td><td class="num">${money(d.items.gross)}</td>
          <td class="num">${money(d.ded.labor)}</td><td class="num">${money(d.ded.health)}</td><td class="num">${money(d.ded.pension)}</td>
          <td class="num">${money(d.ded.supp)}</td><td class="num">${money(d.ded.tax + d.ded.otherDeduct)}</td>
          <td class="num"><b>${money(r.net_pay)}</b></td><td class="num">${money(d.employer.total)}</td>
          <td><button class="btn small" data-view="${idx}">檢視／列印</button>
            ${isPaid(r) ? `<button class="btn small" data-unlock="${r.id}">解除鎖定</button>` : `<button class="btn small" data-pay="${r.id}">標記已發放</button> <button class="btn small danger" data-del="${r.id}">刪除</button>`}</td></tr>`; }).join('')}</tbody>
        <tfoot><tr><td>合計</td><td></td><td class="num">${money(sum((d) => d.items.gross))}</td><td class="num">${money(sum((d) => d.ded.labor))}</td>
          <td class="num">${money(sum((d) => d.ded.health))}</td><td class="num">${money(sum((d) => d.ded.pension))}</td><td class="num">${money(sum((d) => d.ded.supp))}</td>
          <td class="num">${money(sum((d) => d.ded.tax + d.ded.otherDeduct))}</td><td class="num">${money(list.reduce((s, r) => s + r.net_pay, 0))}</td>
          <td class="num">${money(sum((d) => d.employer.total))}</td><td></td></tr></tfoot></table>`
        : '<div class="empty">這個月份還沒有薪資單。</div>';
      view.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => showSlip(list[b.dataset.view])));
      view.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = async () => {
        await q(sb.from('payrolls').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', b.dataset.pay));
        toast('已標記為已發放'); load();
      }));
      view.querySelectorAll('[data-unlock]').forEach((b) => (b.onclick = async () => {
        if (!confirm('解除鎖定後可再修改這張薪資單。確定嗎？')) return;
        await q(sb.from('payrolls').update({ status: 'draft', paid_at: null }).eq('id', b.dataset.unlock));
        toast('已解除鎖定'); load();
      }));
      view.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
        if (!confirm('確定刪除這張薪資單？')) return;
        await q(sb.from('payrolls').delete().eq('id', b.dataset.del));
        toast('已刪除'); load();
      }));
    };
    $('#sMonth').onchange = load;
    $('#sPaidAll').onclick = async () => {
      const drafts = list.filter((r) => !isPaid(r));
      if (!drafts.length) return toast('沒有草稿薪資單', true);
      if (!confirm(`將 ${drafts.length} 張草稿標記為已發放並鎖定，確定嗎？`)) return;
      await q(sb.from('payrolls').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('month', $('#sMonth').value).eq('status', 'draft'));
      toast('已全部標記為已發放'); load();
    };
    $('#sCsv').onclick = () => {
      if (!list.length) return toast('這個月份沒有資料', true);
      const head = ['月份', '狀態', '編號', '姓名', '本薪', '津貼', '加班費', '獎金', '其他加項', '請假扣薪', '應發', '勞保', '健保', '勞退自提', '補充保費', '所得稅', '其他扣款', '實發', '雇主勞保', '雇主健保', '雇主勞退'];
      const rows = list.map((r) => { const d = r.detail, i = d.items, k = d.ded, e = d.employer;
        return [r.month, isPaid(r) ? '已發放' : '草稿', d.emp.emp_no, d.emp.name, i.base, i.allowance, i.overtimePay, i.bonus, i.otherAdd, i.leaveDeduct, i.gross, k.labor, k.health, k.pension, k.supp, k.tax, k.otherDeduct, r.net_pay, e.labor, e.health, e.pension]; });
      downloadCSV(`薪資表_${$('#sMonth').value}.csv`, [head, ...rows]);
    };
    load();
  }

  function showSlip(r) {
    const d = r.detail, i = d.items, k = d.ded, p = d.proration;
    const line = (l, v) => (v ? `<tr><td>${l}</td><td class="num">${money(v)}</td></tr>` : '');
    const ov = $('#slipOverlay');
    ov.innerHTML = `
      <div class="slip-tools"><button class="btn primary" id="slipPrint">列印</button><button class="btn" id="slipClose">關閉</button></div>
      <div class="slip">
        <h2>${esc(d.company || rates.company)}</h2>
        <div class="sub">${esc(r.month)} 薪資單</div>
        <div class="info">
          <div>姓名：${esc(d.emp.name)}</div><div>編號：${esc(d.emp.emp_no)}</div>
          <div>職稱：${esc(d.emp.title)}</div><div>勞保／健保投保：${money(d.emp.labor_insured)} ／ ${money(d.emp.health_insured)}</div>
        </div>
        <table><thead><tr><th>給付項目</th><th class="num">金額</th></tr></thead><tbody>
          ${line(p && !p.full ? `本薪（在職 ${p.days} 天）` : '本薪', i.base)}${line('津貼', i.allowance)}${line('加班費', i.overtimePay)}${line('獎金', i.bonus)}${line('其他加項', i.otherAdd)}
          <tr><td><b>應發合計</b></td><td class="num"><b>${money(i.gross)}</b></td></tr></tbody></table>
        <table><thead><tr><th>扣款項目</th><th class="num">金額</th></tr></thead><tbody>
          ${line('請假扣薪', i.leaveDeduct)}${line('勞工保險費', k.labor)}${line('全民健保費', k.health)}${line('勞退自提', k.pension)}
          ${line('二代健保補充保費', k.supp)}${line('代扣所得稅', k.tax)}${line('其他扣款', k.otherDeduct)}
          <tr><td><b>扣款合計</b></td><td class="num"><b>${money(k.total + i.leaveDeduct)}</b></td></tr></tbody></table>
        <div class="netline">實發金額　$${money(r.net_pay)}</div>
        <div class="foot">本薪資單由系統試算產生，如有疑問請洽公司人事。</div>
      </div>`;
    ov.hidden = false;
    $('#slipClose').onclick = () => (ov.hidden = true);
    $('#slipPrint').onclick = () => window.print();
  }

  /* ======================================================
     勞務報酬
  ====================================================== */
  const ID_BUCKET = 'id-docs';
  const ID_SIDES = [['front', '正面', 'id_front_path'], ['back', '反面', 'id_back_path']];

  const PAYEE_STATUS = [['national', '本國籍'], ['foreign_183', '外國籍在台滿 183 天'], ['foreign_under', '外國籍在台未滿 183 天']];
  const INCOME_TYPES = [['50', '50 薪資所得（兼職人員薪資）'], ['9A', '9A 執行業務所得'], ['9B', '9B 稿費'], ['92', '92 其他所得']];
  const PAY_METHODS = [['cash', '現金'], ['transfer', '匯款'], ['check', '支票'], ['voucher', '禮券']];
  const SV_TEXT_FIELDS = ['pay_date', 'payee', 'payee_id_no', 'payee_address', 'payee_phone', 'payee_email', 'category',
    'period_start', 'period_end', 'gross', 'bank_name', 'bank_branch', 'bank_account', 'account_holder', 'note',
    'payee_status', 'income_type', 'pay_method'];

  // 縮圖並轉成 JPEG：檔案變小，同時去除照片內的 EXIF（含 GPS 位置）
  async function compressImage(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('圖片處理失敗'))), 'image/jpeg', 0.82));
  }
  async function idSignedUrl(path) {
    const { data } = await sb.storage.from(ID_BUCKET).createSignedUrl(path, 3600);
    return data ? data.signedUrl : '';
  }

  // 上傳區（單據下方）；上傳後的影本會同步顯示在單據的「影本黏貼處」
  function renderIdPanel(r) {
    const panel = $('#idPanel');
    panel.innerHTML = `
      <h3>身分證（居留證／護照）影本</h3>
      <p class="muted">上傳後會自動出現在上方單據的「影本黏貼處」。影本屬高度敏感個資：僅存放在你的私有儲存空間，需登入才看得到；圖片會自動縮小並移除拍攝位置等資訊。請僅用於扣繳申報備查，並依個資法妥善保管。</p>
      <div class="id-grid">${ID_SIDES.map(([side, label, col]) => `
        <div class="id-slot" data-side="${side}">
          <b>${label}</b>
          ${r[col] ? `<img alt="影本${label}" data-img="${side}"><div class="row">
              <label class="btn small">重新上傳<input type="file" accept="image/*" hidden data-up="${side}"></label>
              <button class="btn small danger" data-rm="${side}">刪除</button></div>`
            : `<div class="id-empty">尚未上傳</div>
              <label class="btn small">選擇圖片<input type="file" accept="image/*" hidden data-up="${side}"></label>`}
        </div>`).join('')}</div>`;

    ID_SIDES.forEach(async ([side, , col]) => {
      const slipImg = $(`#slipOverlay [data-lfimg="${side}"]`);
      if (!r[col]) { if (slipImg) { slipImg.removeAttribute('src'); slipImg.hidden = true; } return; }
      const url = await idSignedUrl(r[col]);
      panel.querySelectorAll(`[data-img="${side}"]`).forEach((i) => (i.src = url));
      if (slipImg) { slipImg.src = url; slipImg.hidden = false; }
    });

    panel.querySelectorAll('[data-up]').forEach((inp) => (inp.onchange = async () => {
      const file = inp.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) return toast('請選擇圖片檔（JPG／PNG 等）', true);
      if (file.size > 20 * 1024 * 1024) return toast('圖片超過 20MB，請先縮小', true);
      const side = inp.dataset.up, col = `id_${side}_path`;
      try {
        toast('處理並上傳中…');
        const blob = await compressImage(file);
        const path = `${r.id}/${side}.jpg`;
        const { error } = await sb.storage.from(ID_BUCKET).upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (error) throw error;
        await q(sb.from('service_payments').update({ [col]: path }).eq('id', r.id));
        r[col] = path;
        toast('已上傳');
        renderIdPanel(r);
      } catch (e) { toast('上傳失敗：' + (e.message || e), true); }
    }));
    panel.querySelectorAll('[data-rm]').forEach((btn) => (btn.onclick = async () => {
      const col = `id_${btn.dataset.rm}_path`;
      if (!confirm('確定刪除這張影本？刪除後無法復原。')) return;
      await sb.storage.from(ID_BUCKET).remove([r[col]]);
      await q(sb.from('service_payments').update({ [col]: null }).eq('id', r.id));
      r[col] = null;
      toast('已刪除');
      renderIdPanel(r);
    }));
  }

  // 勞務報酬單（附件格式，A4 一頁）
  function showServiceSlip(r) {
    const ov = $('#slipOverlay');
    const st = r.payee_status || 'national';
    const ty = r.income_type || '9A';
    const resident = st !== 'foreign_under';
    const roc = new Date(r.pay_date).getFullYear() - 1911;
    const pct = (v) => Number((v * 100).toFixed(4));
    const nhiTxt = `${pct(rates.suppRate)}%`;
    const box = (on) => (on ? '■' : '□');
    const rocDate = (d) => { if (!d) return '　　年　　月　　日'; const [y, m, dd] = d.split('-').map(Number); return `${y - 1911}年${m}月${dd}日`; };
    const company = rates.company.endsWith('公司') ? rates.company : rates.company + '公司';
    const exemptTxt = `提供職業工會的健保加保證明，不須扣${nhiTxt}補充保費。`;
    const has = (v) => (v ? esc(v) : '');
    const amt = (v) => `<u>&nbsp;&nbsp;${money(v)}&nbsp;&nbsp;</u>`;

    const resRows = [
      ['50', '薪資所得', '兼職人員薪資。',
        `全數計入所得，但可扣除薪資特別扣除額(${roc}年為${Number((rates.taxSpecial / 10000).toFixed(2))}萬元)。<br>達${money(rates.salaryWithholdThreshold)}元，須代扣所得稅${pct(rates.salaryWithholdRate)}%。<br>金額達基本工資(${roc}年為${money(rates.minWage)}元)，須負擔${nhiTxt}補充保費。<br>${exemptTxt}`],
      ['9A', '執行業務所得', '以專業能力取得之酬勞。包含律師、工程師、節目製作人等。',
        `無免稅額，扣除所屬類別費用率後計入個人所得。<br>達${money(rates.svcWithholdThreshold)}元，需代扣所得稅${pct(rates.svcWithholdRate)}%。<br>達${money(rates.svcNhiThreshold)}元，需扣繳${nhiTxt}補充保費。<br>${exemptTxt}`],
      ['9B', '稿費', '包含顧問費、演講費、出席費、稿費。',
        `可先扣18萬免稅額，再扣除30%費用後計入個人所得。<br>達${money(rates.svcWithholdThreshold)}元，需代扣所得稅${pct(rates.svcWithholdRate)}%。<br>達${money(rates.svcNhiThreshold)}元，需扣繳${nhiTxt}補充保費。<br>${exemptTxt}`],
      ['92', '其他所得', '', `不須扣繳、不須${nhiTxt}補充保費。`]
    ];
    const nonRows = [
      ['50', '薪資所得', `${roc}年薪資${money(rates.nonResSalaryLimit)}元以下扣繳${pct(rates.nonResSalaryLowRate)}%、逾${money(rates.nonResSalaryLimit)}元扣繳${pct(rates.nonResSalaryHighRate)}%。`],
      ['9A', '執行業務所得', `均須扣繳${pct(rates.nonResRate)}%。`],
      ['9B', '稿費', `領款金額不超過${money(rates.nonResManuscriptLimit)}元不須扣繳，逾${money(rates.nonResManuscriptLimit)}元須扣繳${pct(rates.nonResRate)}%。`],
      ['92', '其他所得', `均須扣繳${pct(rates.nonResRate)}%。`]
    ];

    ov.innerHTML = `
      <div class="slip-tools"><button class="btn primary" id="slipPrint">列印</button><button class="btn" id="slipClose">關閉</button></div>
      <div class="slip lf-wrap">
        <h2 class="lf-title">${esc(company)} 勞務報酬單</h2>
        <div class="lf-date">填表日期：${esc(rocDate(r.pay_date))}</div>
        <table class="lf">
          <colgroup><col style="width:12%"><col style="width:28%"><col style="width:30%"><col style="width:30%"></colgroup>
          <tr>
            <td class="c" rowspan="3">所得人資料</td>
            <td rowspan="3" class="chk">${PAYEE_STATUS.map(([k, l]) => `${box(st === k)}${l}`).join('<br>')}</td>
            <td>姓名：${has(r.payee)}</td>
            <td>身分證字號：<br><span class="s">(居留證/護照號碼)</span> ${has(r.payee_id_no)}</td>
          </tr>
          <tr><td colspan="2">戶籍地址：${has(r.payee_address)}</td></tr>
          <tr><td colspan="2">連絡電話：${has(r.payee_phone)}${r.payee_email ? `　Email：${has(r.payee_email)}` : ''}</td></tr>
          <tr><td colspan="2">勞務內容：${has(r.category)}</td>
              <td colspan="2" class="r">期間：自 ${esc(rocDate(r.period_start))} 至 ${esc(rocDate(r.period_end))}</td></tr>

          <tr><td class="c" rowspan="5">所得類別<br><span class="s">(本國籍、在台滿 183 天)</span></td>
              <td class="c">類別</td><td colspan="2">注意事項：單次給付(同日、同筆費用)</td></tr>
          ${resRows.map(([code, name, desc, note]) => `<tr>
              <td>${box(resident && ty === code)}${code} ${name}${desc ? `<br><span class="s">${desc}</span>` : ''}</td>
              <td colspan="2" class="s">${note}</td></tr>`).join('')}

          <tr><td class="c" rowspan="5">所得類別<br><span class="s">(在台未滿 183 天)</span></td>
              <td class="c">類別</td><td colspan="2">注意事項：須於 10 日內申報。</td></tr>
          ${nonRows.map(([code, name, note]) => `<tr>
              <td>${box(!resident && ty === code)}${code} ${name}</td><td colspan="2" class="s">${note}</td></tr>`).join('')}

          <tr>
            <td class="c">領款金額</td>
            <td colspan="2" class="amt">
              支領金額： 新台幣 ${amt(r.gross)} 元<br>
              代扣所得稅：新台幣 ${amt(r.withholding)} 元<br>
              二代健保： 新台幣 ${amt(r.nhi)} 元${r.nhi_exempt ? ' <span class="s">(已提供加保證明，免扣)</span>' : ''}<br>
              支領淨額： 新台幣 ${amt(r.net)} 元
              <div class="bank">銀行名稱：${has(r.bank_name)}<br>銀行分行：${has(r.bank_branch)}<br>
                所得人帳號：${has(r.bank_account)}<br>所得人戶名：${has(r.account_holder)}<br>
                付款方式：${PAY_METHODS.map(([k, l]) => `${box((r.pay_method || 'transfer') === k)}${l}`).join(' ')}</div>
              ${r.note ? `<div class="s">備註：${esc(r.note)}</div>` : ''}
            </td>
            <td class="signs"><div class="sg">領款人：<span class="r s">(簽名或蓋章)</span></div><div class="sg">會計/經辦人：</div></td>
          </tr>
          <tr><td colspan="4" class="c">身分證(居留證/護照)影本黏貼處</td></tr>
          <tr><td colspan="4" class="pair"><div class="pairin">
            <div class="half"><div class="hd">正面</div><div class="imgbox"><img data-lfimg="front" alt="影本正面" hidden></div></div>
            <div class="half"><div class="hd">反面</div><div class="imgbox"><img data-lfimg="back" alt="影本反面" hidden></div></div>
          </div></td></tr>
        </table>
      </div>
      <div class="id-panel card" id="idPanel" style="margin-top:12px"></div>`;
    ov.hidden = false;
    $('#slipClose').onclick = () => { ov.hidden = true; ov.innerHTML = ''; };
    $('#slipPrint').onclick = () => window.print();
    renderIdPanel(r);
  }

  const optionsHTML = (list, sel) => list.map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('');

  async function viewService() {
    await loadEmployees();
    const year = new Date().getFullYear();
    view.innerHTML = `
      <div class="page-head"><h2>勞務報酬單</h2></div>
      <form class="card" id="svForm">
        <h3 id="svTitle">新增勞務報酬單</h3>
        <label style="margin-bottom:10px;max-width:360px">領款人來源
          <select id="svSource">
            <option value="">手動輸入（外部人員）</option>
            ${employees.map((e) => `<option value="${e.id}">${esc(e.emp_no)} ${esc(e.name)}${e.active ? '' : '（離職）'}</option>`).join('')}
          </select>
        </label>
        <h4>所得人資料</h4>
        <div class="grid">
          <label>填表／給付日期<input type="date" name="pay_date" value="${today()}" required></label>
          <label>身分別<select name="payee_status">${optionsHTML(PAYEE_STATUS, 'national')}</select></label>
          <label>姓名 *<input name="payee" required></label>
          <label>身分證／居留證／護照號碼<input name="payee_id_no" maxlength="20" autocomplete="off"></label>
          <label>戶籍地址<input name="payee_address" autocomplete="off"></label>
          <label>連絡電話<input type="tel" name="payee_phone" autocomplete="off"></label>
          <label>Email<input type="email" name="payee_email" autocomplete="off"></label>
        </div>
        <h4>勞務內容與所得類別</h4>
        <div class="grid">
          <label>勞務內容<input name="category" placeholder="例如：LOGO 設計"></label>
          <label>期間（起）<input type="date" name="period_start"></label>
          <label>期間（迄）<input type="date" name="period_end"></label>
          <label>所得類別<select name="income_type">${optionsHTML(INCOME_TYPES, '9A')}</select></label>
          <label>給付金額（元）*<input type="number" min="0" name="gross" required></label>
          <label class="check" style="align-self:end"><input type="checkbox" name="nhi_exempt"> 已提供職業工會加保證明（免扣補充保費）</label>
        </div>
        <h4>付款資料</h4>
        <div class="grid">
          <label>付款方式<select name="pay_method">${optionsHTML(PAY_METHODS, 'transfer')}</select></label>
          <label>銀行名稱<input name="bank_name" autocomplete="off"></label>
          <label>銀行分行<input name="bank_branch" autocomplete="off"></label>
          <label>所得人帳號<input name="bank_account" autocomplete="off" inputmode="numeric"></label>
          <label>所得人戶名<input name="account_holder" autocomplete="off"></label>
        </div>
        <label style="margin-top:10px">備註<input name="note"></label>
        <div id="svPreview" class="muted" style="margin:10px 0"></div>
        <div class="dlg-actions">
          <button type="button" class="btn" id="svCancel" hidden>取消編輯</button>
          <button class="btn primary" type="submit" id="svSubmit">儲存</button>
        </div>
        <p class="note">扣繳規則依公司的勞務報酬單附件設定（數字可在「設定」頁修改）。身分證號、帳號屬敏感個資，僅存於你的私有資料庫。稿費免稅額的實際抵扣與年度申報仍需自行判斷。</p>
      </form>
      <div class="card"><div class="row"><label>年度<input type="number" id="svYear" value="${year}" style="width:100px"></label>
        <button class="btn" id="svCsv">匯出 CSV</button></div><div class="table-wrap" id="svList" style="margin-top:10px"></div></div>`;

    const form = $('#svForm');
    let editing = null;
    const calcFromForm = () => calcService(form.gross.value, rates, { status: form.payee_status.value, type: form.income_type.value, nhiExempt: form.nhi_exempt.checked });
    const preview = () => {
      const r = calcFromForm();
      $('#svPreview').textContent = `扣繳 ${money(r.withholding)}　補充保費 ${money(r.nhi)}　支領淨額 ${money(r.net)}`;
    };
    const resetForm = () => {
      editing = null;
      form.reset();
      form.pay_date.value = today();
      $('#svTitle').textContent = '新增勞務報酬單';
      $('#svSubmit').textContent = '儲存';
      $('#svCancel').hidden = true;
      $('#svPreview').textContent = '';
    };
    const startEdit = (rec) => {
      editing = rec;
      SV_TEXT_FIELDS.forEach((k) => { form[k].value = rec[k] === null || rec[k] === undefined ? '' : rec[k]; });
      form.nhi_exempt.checked = !!rec.nhi_exempt;
      $('#svTitle').textContent = `編輯勞務報酬單：${rec.payee}`;
      $('#svSubmit').textContent = '更新';
      $('#svCancel').hidden = false;
      preview();
      form.scrollIntoView({ behavior: 'smooth' });
    };
    $('#svCancel').onclick = resetForm;

    // 從員工名單帶入領款人資料（帶入後仍可修改）
    $('#svSource').addEventListener('change', (ev) => {
      const emp = employees.find((e) => e.id === ev.target.value);
      form.payee.value = emp ? emp.name : '';
      form.payee_id_no.value = emp ? emp.id_no || '' : '';
      form.payee_address.value = emp ? emp.address || '' : '';
      form.payee_email.value = emp ? emp.email || '' : '';
      form.payee_phone.value = emp ? emp.phone || '' : '';
      form.account_holder.value = emp ? emp.name : '';
      if (emp && (!emp.id_no || !emp.address)) toast('此員工尚未填身分證字號或地址，可直接在這裡補填，或到「員工」頁補上');
    });
    form.addEventListener('input', preview);
    form.addEventListener('change', preview);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(form);
      const r = calcFromForm();
      const row = {
        pay_date: f.get('pay_date'), payee: f.get('payee').trim(), category: f.get('category').trim(),
        payee_id_no: f.get('payee_id_no').trim().toUpperCase(), payee_address: f.get('payee_address').trim(),
        payee_email: f.get('payee_email').trim(), payee_phone: f.get('payee_phone').trim(),
        payee_status: f.get('payee_status'), income_type: f.get('income_type'),
        period_start: f.get('period_start') || null, period_end: f.get('period_end') || null,
        bank_name: f.get('bank_name').trim(), bank_branch: f.get('bank_branch').trim(),
        bank_account: f.get('bank_account').trim(), account_holder: f.get('account_holder').trim(),
        pay_method: f.get('pay_method'), nhi_exempt: form.nhi_exempt.checked,
        gross: r.gross, withholding: r.withholding, nhi: r.nhi, net: r.net, note: f.get('note').trim()
      };
      if (row.period_start && row.period_end && row.period_end < row.period_start) return toast('期間的迄日不可早於起日', true);
      await q(editing ? sb.from('service_payments').update(row).eq('id', editing.id) : sb.from('service_payments').insert(row));
      toast(editing ? '已更新' : '已儲存');
      resetForm();
      load();
    });

    let list = [];
    const typeLabel = (r) => `${r.income_type}${r.payee_status === 'foreign_under' ? '（非居住者）' : ''}`;
    const load = async () => {
      const y = $('#svYear').value;
      list = await q(sb.from('service_payments').select('*').gte('pay_date', `${y}-01-01`).lte('pay_date', `${y}-12-31`).order('pay_date', { ascending: false }));
      const s = (f) => list.reduce((a, r) => a + r[f], 0);
      $('#svList').innerHTML = list.length ? `<table><thead><tr><th>日期</th><th>領款人</th><th>所得類別</th><th>勞務內容</th><th class="num">金額</th><th class="num">扣繳</th><th class="num">補充保費</th><th class="num">淨額</th><th></th></tr></thead>
        <tbody>${list.map((r) => `<tr><td>${esc(r.pay_date)}</td><td>${esc(r.payee)}</td><td>${esc(typeLabel(r))}</td><td>${esc(r.category)}</td><td class="num">${money(r.gross)}</td><td class="num">${money(r.withholding)}</td><td class="num">${money(r.nhi)}</td><td class="num">${money(r.net)}</td>
          <td><button class="btn small" data-slip="${r.id}">勞務報酬單</button> <button class="btn small" data-edit="${r.id}">編輯</button> <button class="btn small danger" data-del="${r.id}">刪除</button></td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="4">合計</td><td class="num">${money(s('gross'))}</td><td class="num">${money(s('withholding'))}</td><td class="num">${money(s('nhi'))}</td><td class="num">${money(s('net'))}</td><td></td></tr></tfoot></table>`
        : '<div class="empty">這一年度還沒有紀錄。</div>';
      $('#svList').querySelectorAll('[data-slip]').forEach((b) => (b.onclick = () => showServiceSlip(list.find((r) => r.id === b.dataset.slip))));
      $('#svList').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => startEdit(list.find((r) => r.id === b.dataset.edit))));
      $('#svList').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
        if (!confirm('確定刪除這筆紀錄？')) return;
        const rec = list.find((x) => x.id === b.dataset.del);
        const files = [rec.id_front_path, rec.id_back_path].filter(Boolean);
        if (files.length) await sb.storage.from(ID_BUCKET).remove(files); // 一併刪除身分證影本
        await q(sb.from('service_payments').delete().eq('id', b.dataset.del));
        if (editing && editing.id === rec.id) resetForm();
        load();
      }));
    };
    $('#svYear').onchange = load;
    $('#svCsv').onclick = () => {
      if (!list.length) return toast('沒有資料可匯出', true);
      const stLabel = Object.fromEntries(PAYEE_STATUS), pmLabel = Object.fromEntries(PAY_METHODS);
      downloadCSV(`勞務報酬_${$('#svYear').value}.csv`, [
        ['日期', '領款人', '身分別', '身分證／居留證／護照', '戶籍地址', '聯絡電話', 'Email', '所得類別', '勞務內容', '期間起', '期間迄', '金額', '扣繳稅款', '補充保費', '淨額', '付款方式', '銀行', '分行', '帳號', '戶名', '備註'],
        ...list.map((r) => [r.pay_date, r.payee, stLabel[r.payee_status], r.payee_id_no, r.payee_address, r.payee_phone, r.payee_email, r.income_type, r.category,
          r.period_start, r.period_end, r.gross, r.withholding, r.nhi, r.net, pmLabel[r.pay_method], r.bank_name, r.bank_branch, r.bank_account, r.account_holder, r.note])]);
    };
    load();
  }

  /* ======================================================
     設定＋備份
  ====================================================== */
  const SETTING_FIELDS = [
    ['company', '公司名稱（薪資單抬頭）', 'text'],
    ['laborRate', '勞保總費率 %（含就業保險）', 'pct'], ['laborEeShare', '勞保 員工負擔比例 %', 'pct'], ['laborErShare', '勞保 雇主負擔比例 %', 'pct'],
    ['healthRate', '健保費率 %', 'pct'], ['healthEeShare', '健保 員工負擔比例 %', 'pct'], ['healthErShare', '健保 雇主負擔比例 %', 'pct'],
    ['avgDependents', '雇主計算健保的平均眷口數', 'num'], ['pensionErRate', '雇主勞退提繳 %', 'pct'],
    ['pensionSelfDefault', '勞退自提：新增員工的預設比例 %（0–6）', 'pct'],
    ['suppRate', '二代健保補充保費率 %', 'pct'], ['minWage', '基本工資（月，元）', 'num'], ['hoursPerMonth', '月薪換算時薪的除數（小時）', 'num'],
    ['prorateDivisor', '到職／離職當月按日計薪的除數（天）', 'num'],
    ['ot1', '加班倍率 一', 'num'], ['ot2', '加班倍率 二', 'num'], ['ot3', '加班倍率 三', 'num'], ['sickPayRatio', '普通病假給薪比例 %', 'pct'],
    ['taxExemption', '所得稅：免稅額（每人，元）', 'num'], ['taxStandard', '所得稅：標準扣除額（單身，元）', 'num'], ['taxSpecial', '所得稅：薪資特別扣除額（元）', 'num'],
    ['svcWithholdRate', '勞務報酬扣繳率 %', 'pct'], ['svcWithholdThreshold', '勞務報酬 扣繳起點（元）', 'num'], ['svcNhiThreshold', '勞務報酬 補充保費起點（元）', 'num'],
    ['salaryWithholdThreshold', '勞務單：兼職薪資（50）扣繳起點（元）', 'num'], ['salaryWithholdRate', '勞務單：兼職薪資（50）扣繳率 %', 'pct'],
    ['nonResSalaryLimit', '勞務單：非居住者薪資 低稅率上限（元）', 'num'], ['nonResSalaryLowRate', '勞務單：非居住者薪資 上限以下扣繳率 %', 'pct'],
    ['nonResSalaryHighRate', '勞務單：非居住者薪資 逾上限扣繳率 %', 'pct'], ['nonResRate', '勞務單：非居住者 9A／9B／92 扣繳率 %', 'pct'],
    ['nonResManuscriptLimit', '勞務單：非居住者稿費 免扣繳上限（元）', 'num']
  ];
  const BACKUP_TABLES = [['settings', 'key'], ['employees', 'created_at'], ['payrolls', 'created_at'], ['service_payments', 'created_at']];

  async function viewSettings() {
    const inputs = SETTING_FIELDS.map(([k, label, type]) => {
      const val = type === 'pct' ? Number((rates[k] * 100).toFixed(4)) : rates[k];
      return `<label>${label}<input name="${k}" ${type === 'text' ? '' : 'type="number" step="any"'} value="${esc(val)}"></label>`;
    }).join('');
    const bracketText = rates.taxBrackets.map(([u, r]) => `${u >= 1e14 ? '' : u},${Number((r * 100).toFixed(4))}`).join('\n');
    const lb = lsGet('lastBackup');
    view.innerHTML = `
      <div class="page-head"><h2>設定與備份</h2></div>
      <div class="card">
        <h3>資料備份</h3>
        <p class="muted">備份檔含全部員工與薪資資料，屬敏感個資，請存放在安全的地方（不要上傳到 GitHub）。${lb ? `上次備份：${esc(lb.slice(0, 10))}` : '尚未備份過。'}</p>
        <div class="row">
          <button class="btn primary" id="bkExport">下載備份（JSON）</button>
          <label style="min-width:240px">還原：選擇備份檔<input type="file" id="bkFile" accept="application/json,.json"></label>
          <button class="btn" id="bkImport">匯入還原</button>
        </div>
        <p class="muted" style="margin-bottom:0">還原時，相同資料會被覆蓋；已發放（鎖定）的薪資單受保護，遇到會停止並提示。</p>
      </div>
      <form class="card" id="setForm">
        <h3>費率與級距</h3>
        <p class="note">預設值為 115 年（2026）資料，勞保總費率採 12.5%。所得稅為依綜所稅免稅額、扣除額與級距年化估算，與官方扣繳稅額表可能有些微差異。政策調整時請在此修改，並對照官方公告確認。</p>
        <div class="grid" style="margin:14px 0">${inputs}</div>
        <label>所得稅級距（每行「年淨所得上限,稅率%」；最後一行上限留空＝無上限）<textarea name="taxBrackets" rows="5">${esc(bracketText)}</textarea></label>
        <label style="margin-top:10px">勞保投保薪資級距（逗號分隔，由小到大）<textarea name="laborGrades">${rates.laborGrades.join(', ')}</textarea></label>
        <label style="margin-top:10px">健保投保金額級距（逗號分隔，由小到大）<textarea name="healthGrades">${rates.healthGrades.join(', ')}</textarea></label>
        <div class="dlg-actions">
          <button type="button" class="btn" id="setReset">還原預設值</button>
          <button class="btn primary" type="submit">儲存設定</button></div>
      </form>`;

    $('#bkExport').onclick = async () => {
      const data = {};
      for (const [t, col] of BACKUP_TABLES) data[t] = await fetchAll(t, col);
      const payload = { app: 'payroll', version: 1, exported_at: new Date().toISOString(), data };
      downloadFile(`薪資系統備份_${today()}.json`, JSON.stringify(payload, null, 1), 'application/json');
      lsSet('lastBackup', new Date().toISOString());
      toast(`備份完成：員工 ${data.employees.length}、薪資單 ${data.payrolls.length}、勞務報酬 ${data.service_payments.length}`);
      viewSettings();
    };

    $('#bkImport').onclick = async () => {
      const file = $('#bkFile').files[0];
      if (!file) return toast('請先選擇備份檔', true);
      let payload;
      try { payload = JSON.parse(await file.text()); } catch (e) { return toast('檔案不是有效的 JSON', true); }
      if (!payload || payload.app !== 'payroll' || !payload.data) return toast('這不是本系統的備份檔', true);
      const d = payload.data;
      if (!confirm(`將還原備份（${(payload.exported_at || '').slice(0, 10)}）：員工 ${(d.employees || []).length}、薪資單 ${(d.payrolls || []).length}、勞務報酬 ${(d.service_payments || []).length}。\n相同資料會被覆蓋，確定嗎？`)) return;
      const conflicts = { settings: 'key', employees: 'id', payrolls: 'id', service_payments: 'id' };
      try {
        for (const t of Object.keys(conflicts)) {
          const rows = d[t] || [];
          for (let i = 0; i < rows.length; i += 200) {
            await q(sb.from(t).upsert(rows.slice(i, i + 200), { onConflict: conflicts[t] }));
          }
        }
      } catch (e) { return; }
      await loadRates(); await loadEmployees();
      toast('還原完成');
      viewSettings();
    };

    const form = $('#setForm');
    const parseGrades = (s) => s.split(/[,\s，]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
    const parseBrackets = (s) => {
      const rows = s.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [u, r] = l.split(',');
        return [u && u.trim() ? num(u) : 1e15, num(r) / 100];
      }).sort((a, b) => a[0] - b[0]);
      if (rows.length) rows[rows.length - 1][0] = 1e15;
      return rows;
    };
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const next = {};
      for (const [k, , type] of SETTING_FIELDS) {
        const raw = form[k].value;
        next[k] = type === 'text' ? raw.trim() : type === 'pct' ? num(raw) / 100 : num(raw);
      }
      next.laborGrades = parseGrades(form.laborGrades.value);
      next.healthGrades = parseGrades(form.healthGrades.value);
      next.taxBrackets = parseBrackets(form.taxBrackets.value);
      if (next.pensionSelfDefault < 0 || next.pensionSelfDefault > 0.06) return toast('勞退自提比例必須在 0%～6% 之間', true);
      if (!next.laborGrades.length || !next.healthGrades.length) return toast('級距不可為空', true);
      if (!next.taxBrackets.length) return toast('所得稅級距不可為空', true);
      if (!next.hoursPerMonth || !next.prorateDivisor) return toast('時薪與按日計薪的除數不可為 0', true);
      await q(sb.from('settings').upsert({ key: 'rates', value: next, updated_at: new Date().toISOString() }));
      rates = Object.assign(JSON.parse(JSON.stringify(DEFAULT_RATES)), next);
      toast('設定已儲存');
    });
    $('#setReset').onclick = async () => {
      if (!confirm('確定還原為預設值？')) return;
      await q(sb.from('settings').delete().eq('key', 'rates'));
      rates = JSON.parse(JSON.stringify(DEFAULT_RATES));
      toast('已還原'); viewSettings();
    };
  }

  /* ---------- 啟動 ---------- */
  sb.auth.getSession().then(({ data }) => { if (!data.session) showLogin(); });
})();
