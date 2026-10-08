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
  async function viewService() {
    const year = new Date().getFullYear();
    view.innerHTML = `
      <div class="page-head"><h2>勞務報酬（外包／稿費）</h2></div>
      <div class="two-col">
        <form class="card" id="svForm">
          <h3>新增一筆</h3>
          <div class="grid">
            <label>給付日期<input type="date" name="pay_date" value="${today()}" required></label>
            <label>領款人 *<input name="payee" required></label>
            <label>類別（設計、稿費…）<input name="category"></label>
            <label>給付金額（元）*<input type="number" min="0" name="gross" required></label>
          </div>
          <label style="margin-top:10px">備註<input name="note"></label>
          <div id="svPreview" class="muted" style="margin:10px 0"></div>
          <div class="dlg-actions"><button class="btn primary" type="submit">儲存</button></div>
          <p class="note">以居住者為準：單次達 $${money(rates.svcWithholdThreshold)} 扣繳 ${Number((rates.svcWithholdRate * 100).toFixed(4))}%，達 $${money(rates.svcNhiThreshold)} 扣補充保費 ${Number((rates.suppRate * 100).toFixed(4))}%。稿費免稅額、非居住者、薪資所得等情形需自行判斷。</p>
        </form>
        <div class="card"><div class="row"><label>年度<input type="number" id="svYear" value="${year}" style="width:100px"></label>
          <button class="btn" id="svCsv">匯出 CSV</button></div><div class="table-wrap" id="svList" style="margin-top:10px"></div></div>
      </div>`;
    const form = $('#svForm');
    form.addEventListener('input', () => {
      const r = calcService(form.gross.value, rates);
      $('#svPreview').textContent = `扣繳 ${money(r.withholding)}　補充保費 ${money(r.nhi)}　實領 ${money(r.net)}`;
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(form);
      const r = calcService(f.get('gross'), rates);
      await q(sb.from('service_payments').insert({
        pay_date: f.get('pay_date'), payee: f.get('payee').trim(), category: f.get('category').trim(),
        gross: r.gross, withholding: r.withholding, nhi: r.nhi, net: r.net, note: f.get('note').trim()
      }));
      toast('已儲存'); form.reset(); form.pay_date.value = today(); $('#svPreview').textContent = ''; load();
    });
    let list = [];
    const load = async () => {
      const y = $('#svYear').value;
      list = await q(sb.from('service_payments').select('*').gte('pay_date', `${y}-01-01`).lte('pay_date', `${y}-12-31`).order('pay_date', { ascending: false }));
      const s = (f) => list.reduce((a, r) => a + r[f], 0);
      $('#svList').innerHTML = list.length ? `<table><thead><tr><th>日期</th><th>領款人</th><th>類別</th><th class="num">金額</th><th class="num">扣繳</th><th class="num">補充保費</th><th class="num">實領</th><th></th></tr></thead>
        <tbody>${list.map((r) => `<tr><td>${esc(r.pay_date)}</td><td>${esc(r.payee)}</td><td>${esc(r.category)}</td><td class="num">${money(r.gross)}</td><td class="num">${money(r.withholding)}</td><td class="num">${money(r.nhi)}</td><td class="num">${money(r.net)}</td><td><button class="btn small danger" data-del="${r.id}">刪除</button></td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="3">合計</td><td class="num">${money(s('gross'))}</td><td class="num">${money(s('withholding'))}</td><td class="num">${money(s('nhi'))}</td><td class="num">${money(s('net'))}</td><td></td></tr></tfoot></table>`
        : '<div class="empty">這一年度還沒有紀錄。</div>';
      $('#svList').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
        if (!confirm('確定刪除這筆紀錄？')) return;
        await q(sb.from('service_payments').delete().eq('id', b.dataset.del)); load();
      }));
    };
    $('#svYear').onchange = load;
    $('#svCsv').onclick = () => {
      if (!list.length) return toast('沒有資料可匯出', true);
      downloadCSV(`勞務報酬_${$('#svYear').value}.csv`, [['日期', '領款人', '類別', '金額', '扣繳稅款', '補充保費', '實領', '備註'],
        ...list.map((r) => [r.pay_date, r.payee, r.category, r.gross, r.withholding, r.nhi, r.net, r.note])]);
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
    ['svcWithholdRate', '勞務報酬扣繳率 %', 'pct'], ['svcWithholdThreshold', '勞務報酬 扣繳起點（元）', 'num'], ['svcNhiThreshold', '勞務報酬 補充保費起點（元）', 'num']
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
