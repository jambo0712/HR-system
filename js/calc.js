/* 薪資／保險／勞務報酬 計算核心（純函式，不碰畫面與資料庫） */
(function (root) {
  'use strict';

  // 預設費率與級距（115 年／2026）。可在「設定」頁修改，政策調整時不必改程式。
  // ⚠ 實際申報前請對照勞保局、健保署、國稅局官方公告。
  const DEFAULT_RATES = {
    company: '我的公司',
    laborRate: 0.125,        // 勞保普通事故 11.5% + 就業保險 1%
    laborEeShare: 0.2,       // 員工負擔 20%
    laborErShare: 0.7,       // 雇主負擔 70%
    healthRate: 0.0517,      // 健保費率
    healthEeShare: 0.3,      // 員工負擔 30%
    healthErShare: 0.6,      // 雇主負擔 60%
    avgDependents: 0.57,     // 雇主計算健保時的平均眷口數
    pensionErRate: 0.06,     // 雇主勞退提繳 6%
    pensionSelfDefault: 0,   // 新增員工時，勞退自提的預設比例（0～6%）
    suppRate: 0.0211,        // 二代健保補充保費
    minWage: 29500,          // 基本工資（月）
    hoursPerMonth: 240,      // 時薪 = 月薪 ÷ 30 ÷ 8
    prorateDivisor: 30,      // 到職／離職當月按日計薪的除數
    ot1: 1.34,
    ot2: 1.67,
    ot3: 2,
    sickPayRatio: 0.5,       // 普通傷病假給薪比例
    svcWithholdRate: 0.1,    // 勞務報酬扣繳率（居住者）
    svcWithholdThreshold: 20010, // 單次給付達此金額才扣繳
    svcNhiThreshold: 20000,  // 單次給付達此金額才收補充保費
    // 薪資所得扣繳估算（115 年綜所稅參數）
    taxExemption: 101000,    // 免稅額（每人）
    taxStandard: 136000,     // 標準扣除額（單身）
    taxSpecial: 227000,      // 薪資所得特別扣除額
    taxBrackets: [[610000, 0.05], [1380000, 0.12], [2770000, 0.2], [5210000, 0.3], [1e15, 0.4]],
    laborGrades: [29500, 30300, 31800, 33300, 34800, 36300, 38200, 40100, 42000, 43900, 45800],
    healthGrades: [29500, 30300, 31800, 33300, 34800, 36300, 38200, 40100, 42000, 43900, 45800,
      48200, 50600, 53000, 55400, 57800, 60800, 63800, 66800, 69800, 72800, 76500, 80200, 83900,
      87600, 92100, 96600, 101100, 105600, 110100, 115500, 120900, 126300, 131700, 137100, 142500,
      147900, 150000, 156400, 162800, 169200, 175600, 182000, 189500, 197000, 204500, 212000,
      219500, 228200, 236900, 245600, 254300, 263000, 273000, 283000, 293000, 303000, 313000]
  };

  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const rd = (v) => Math.round(v);
  const pad = (x) => String(x).padStart(2, '0');

  // 取「大於等於薪資的最小級距」；超過最高級就用最高級
  function nearestGrade(salary, grades) {
    const s = n(salary);
    if (s <= 0 || !grades || !grades.length) return 0;
    for (const g of grades) if (g >= s) return g;
    return grades[grades.length - 1];
  }

  // 該月份員工在職天數（依到職日、離職日）
  function employedInfo(emp, month) {
    const [y, m] = month.split('-').map(Number);
    const dim = new Date(y, m, 0).getDate();
    const first = `${month}-01`;
    const last = `${month}-${pad(dim)}`;
    const hire = emp.hire_date || '0000-01-01';
    const resign = emp.resign_date || '9999-12-31';
    const start = hire > first ? hire : first;
    const end = resign < last ? resign : last;
    if (start > end) return { days: 0, dim, full: false, endsAtMonthEnd: false };
    const ms = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
    const days = Math.round((ms(end) - ms(start)) / 86400000) + 1;
    return { days, dim, full: start === first && end === last, endsAtMonthEnd: end === last };
  }

  function annualTax(net, brackets) {
    let tax = 0, prev = 0;
    for (const [upper, rate] of brackets) {
      if (net > prev) tax += (Math.min(net, upper) - prev) * rate;
      prev = upper;
    }
    return tax;
  }

  // 月薪扣繳估算：年化後扣掉免稅額與扣除額，套級距，再除以 12
  function estimateTax(taxable, taxDependents, rt) {
    const annual = Math.max(0, taxable) * 12
      - (rt.taxExemption * (1 + n(taxDependents)) + rt.taxStandard + rt.taxSpecial);
    return annual > 0 ? rd(annualTax(annual, rt.taxBrackets) / 12) : 0;
  }

  // month（'YYYY-MM'）可省略；省略時不做按日計薪
  function calcPayroll(emp, inp, rt, month) {
    inp = inp || {};
    const fullBase = n(emp.base_salary);
    const hourly = fullBase / rt.hoursPerMonth;

    // 按日計薪
    let pr = { days: 0, dim: 30, full: true, ratio: 1, laborRatio: 1, healthRatio: 1, notEmployed: false };
    if (month) {
      const e = employedInfo(emp, month);
      if (e.days === 0) pr = { days: 0, dim: e.dim, full: false, ratio: 0, laborRatio: 0, healthRatio: 0, notEmployed: true };
      else if (e.full) pr = { days: e.days, dim: e.dim, full: true, ratio: 1, laborRatio: 1, healthRatio: 1, notEmployed: false };
      else {
        const ratio = Math.min(e.days, rt.prorateDivisor) / rt.prorateDivisor;
        // 勞保、勞退：按在職日數；健保：月中退保當月不收，月中加保收全月
        pr = { days: e.days, dim: e.dim, full: false, ratio, laborRatio: ratio, healthRatio: e.endsAtMonthEnd ? 1 : 0, notEmployed: false };
      }
    }

    const base = rd(fullBase * pr.ratio);
    const overtimePay = rd(hourly * (rt.ot1 * n(inp.ot1) + rt.ot2 * n(inp.ot2) + rt.ot3 * n(inp.ot3)));
    const leaveDeduct = rd(hourly * n(inp.personalHours) + hourly * n(inp.sickHours) * (1 - rt.sickPayRatio));
    const allowance = n(inp.allowance);
    const bonus = n(inp.bonus);
    const otherAdd = n(inp.otherAdd);
    const gross = base + allowance + overtimePay + bonus + otherAdd - leaveDeduct;

    const li = n(emp.labor_insured);
    const hi = n(emp.health_insured);
    const dep = Math.min(Math.max(n(emp.dependents), 0), 3);
    const pensionWage = hi || li;

    // 員工自付
    const laborEe = rd(li * rt.laborRate * rt.laborEeShare * pr.laborRatio);
    const healthEe = rd(hi * rt.healthRate * rt.healthEeShare) * (1 + dep) * pr.healthRatio;
    const pensionSelf = rd(pensionWage * n(emp.pension_self_rate) * pr.laborRatio);

    // 二代健保補充保費
    let supp = 0;
    if (hi > 0) {
      // 獎金：累計超過 4 倍投保金額的部分才計費
      const prior = n(inp.priorBonus);
      const limit = 4 * hi;
      const excess = Math.max(0, prior + bonus - limit) - Math.max(0, prior - limit);
      supp = rd(excess * rt.suppRate);
    } else if (gross >= rt.minWage) {
      // 未在本單位投保健保（例如兼職）：領薪達基本工資以上就要扣
      supp = rd(gross * rt.suppRate);
    }

    // 所得稅：欄位留空（null／''）= 自動估算，填數字 = 手動
    const taxAuto = inp.tax === '' || inp.tax === null || inp.tax === undefined;
    const tax = taxAuto ? estimateTax(gross - pensionSelf, emp.tax_dependents, rt) : n(inp.tax);
    const otherDeduct = n(inp.otherDeduct);
    const dedTotal = laborEe + healthEe + pensionSelf + supp + tax + otherDeduct;

    // 雇主負擔
    const erLabor = rd(li * rt.laborRate * rt.laborErShare * pr.laborRatio);
    const erHealth = hi > 0 ? rd(hi * rt.healthRate * rt.healthErShare * (1 + rt.avgDependents) * pr.healthRatio) : 0;
    const erPension = rd(pensionWage * rt.pensionErRate * pr.laborRatio);

    return {
      input: {
        ot1: n(inp.ot1), ot2: n(inp.ot2), ot3: n(inp.ot3),
        personalHours: n(inp.personalHours), sickHours: n(inp.sickHours),
        allowance, bonus, otherAdd, priorBonus: n(inp.priorBonus),
        tax: taxAuto ? null : tax, otherDeduct
      },
      hourly: Math.round(hourly * 100) / 100,
      proration: pr,
      taxAuto,
      items: { fullBase, base, allowance, overtimePay, bonus, otherAdd, leaveDeduct, gross },
      ded: { labor: laborEe, health: healthEe, pension: pensionSelf, supp, tax, otherDeduct, total: dedTotal },
      employer: { labor: erLabor, health: erHealth, pension: erPension, total: erLabor + erHealth + erPension },
      net: gross - dedTotal
    };
  }

  // 勞務報酬（外包／稿費等，居住者）
  function calcService(gross, rt) {
    const g = n(gross);
    const withholding = g >= rt.svcWithholdThreshold ? rd(g * rt.svcWithholdRate) : 0;
    const nhi = g >= rt.svcNhiThreshold ? rd(g * rt.suppRate) : 0;
    return { gross: g, withholding, nhi, net: g - withholding - nhi };
  }

  const api = { DEFAULT_RATES, nearestGrade, employedInfo, estimateTax, calcPayroll, calcService };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calc = api;
})(this);
