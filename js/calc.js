/* 薪資／保險／勞務報酬 計算核心（純函式，不碰畫面與資料庫） */
(function (root) {
  'use strict';

  // 預設費率與級距（115 年／2026）。可在「設定」頁修改，政策調整時不必改程式。
  // ⚠ 實際申報前請對照勞保局、健保署官方公告。
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
    suppRate: 0.0211,        // 二代健保補充保費
    minWage: 29500,          // 基本工資（月）
    hoursPerMonth: 240,      // 時薪 = 月薪 ÷ 30 ÷ 8
    ot1: 1.34,
    ot2: 1.67,
    ot3: 2,
    sickPayRatio: 0.5,       // 普通傷病假給薪比例
    svcWithholdRate: 0.1,    // 勞務報酬扣繳率（居住者）
    svcWithholdThreshold: 20010, // 單次給付達此金額才扣繳
    svcNhiThreshold: 20000,  // 單次給付達此金額才收補充保費
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

  // 取「大於等於薪資的最小級距」；超過最高級就用最高級
  function nearestGrade(salary, grades) {
    const s = n(salary);
    if (s <= 0 || !grades || !grades.length) return 0;
    for (const g of grades) if (g >= s) return g;
    return grades[grades.length - 1];
  }

  function calcPayroll(emp, inp, rt) {
    inp = inp || {};
    const base = n(emp.base_salary);
    const hourly = base / rt.hoursPerMonth;

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
    const laborEe = rd(li * rt.laborRate * rt.laborEeShare);
    const healthEe = rd(hi * rt.healthRate * rt.healthEeShare) * (1 + dep);
    const pensionSelf = rd(pensionWage * n(emp.pension_self_rate));

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

    const tax = n(inp.tax);
    const otherDeduct = n(inp.otherDeduct);
    const dedTotal = laborEe + healthEe + pensionSelf + supp + tax + otherDeduct;

    // 雇主負擔
    const erLabor = rd(li * rt.laborRate * rt.laborErShare);
    const erHealth = hi > 0 ? rd(hi * rt.healthRate * rt.healthErShare * (1 + rt.avgDependents)) : 0;
    const erPension = rd(pensionWage * rt.pensionErRate);

    return {
      input: {
        ot1: n(inp.ot1), ot2: n(inp.ot2), ot3: n(inp.ot3),
        personalHours: n(inp.personalHours), sickHours: n(inp.sickHours),
        allowance, bonus, otherAdd, priorBonus: n(inp.priorBonus), tax, otherDeduct
      },
      hourly: Math.round(hourly * 100) / 100,
      items: { base, allowance, overtimePay, bonus, otherAdd, leaveDeduct, gross },
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

  const api = { DEFAULT_RATES, nearestGrade, calcPayroll, calcService };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Calc = api;
})(this);
