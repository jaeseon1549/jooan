/* 퀀트 내비게이터 - 핵심 계산 로직 (화면과 분리된 순수 함수)
 * 섀넌의 도깨비 전략: TQQQ : (SGOV + 예수금) 을 목표 비중으로 유지하고,
 * 밴드(±%p)를 벗어나면 LOC 주문으로 목표 비중으로 되돌린다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QN = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    target: 50,   // TQQQ 목표 비중 (%)
    band: 5,      // 리밸런싱 밴드 (± %p)  -> 45% / 55%
    near: 3,      // 사전 예약 구간 (± %p) -> 47% / 53% 부터 LOC 미리 걸기
    fee: 0.1,     // 매매 수수료 (%)
    buffer: 0,    // 투입금 배치 시 현금으로 남길 금액 (USD)
    split: true,  // 밴드 이탈 상태에서 분할 LOC(과매도/과매수 방지)
    always: false // 항상 양방향 LOC 표시
  };

  const EPS = 1e-9;
  const r2 = (x) => Math.round(x * 100) / 100;
  const ceil2 = (x) => Math.ceil(x * 100 - 1e-7) / 100;
  const floor2 = (x) => Math.floor(x * 100 + 1e-7) / 100;

  /** 보유 현황 지표. S(안전자산) = SGOV 평가액 + 예수금 */
  function metrics(st) {
    const T = st.B * st.pT;
    const Ssgov = st.C * st.pS;
    const S = Ssgov + st.D;
    const H = T + S;
    return { T, Ssgov, S, H, w: H > 0 ? T / H : 0 };
  }

  /** 가격 p에서 목표 비중으로 되돌리기 위해 팔아야 하는 TQQQ 주수(실수) */
  function needSell(B, S, t, p) { return Math.max(0, B * (1 - t) - (t * S) / p); }
  /** 가격 p에서 목표 비중으로 되돌리기 위해 사야 하는 TQQQ 주수(실수) */
  function needBuy(B, S, t, p) { return Math.max(0, (t * S) / p - B * (1 - t)); }

  /**
   * 추가 투입금 배치 (매수만으로 목표 비중에 최대한 근접).
   * 원 코드의 문제: 한쪽이 목표를 넘으면 반대쪽 매수량이 투입금보다 커질 수 있었음.
   * 여기서는 쓸 수 있는 현금(pool) 한도 안에서 정수 주수를 전수탐색해 편차를 최소화한다.
   */
  function planDeposit(st, cfg) {
    const fee = cfg.fee / 100;
    const t = cfg.target / 100;
    const depUSD = st.depKRW > 0 && st.fx > 0 ? st.depKRW / st.fx : 0;
    const m = metrics(st);
    const Hall = m.H + depUSD;
    const pool = Math.max(0, st.D + depUSD - cfg.buffer);
    const costT = st.pT * (1 + fee);
    const costS = st.pS * (1 + fee);
    let best = { qT: 0, qS: 0, spent: 0, dev: Infinity };
    const maxT = Math.floor(pool / costT + EPS);
    for (let qT = 0; qT <= maxT; qT++) {
      const rest = pool - qT * costT;
      const qS = Math.max(0, Math.floor(rest / costS + EPS));
      const spent = qT * costT + qS * costS;
      const wA = Hall > 0 ? (m.T + qT * st.pT) / Hall : 0;
      const dev = Math.abs(wA - t);
      if (dev < best.dev - 1e-12 || (Math.abs(dev - best.dev) <= 1e-12 && spent > best.spent)) {
        best = { qT, qS, spent, dev };
      }
    }
    const cashAfter = st.D + depUSD - best.spent;
    const wBefore = Hall > 0 ? m.T / Hall : 0;
    const wAfter = Hall > 0 ? (m.T + best.qT * st.pT) / Hall : 0;
    return {
      depUSD, pool, qT: best.qT, qS: best.qS, spent: best.spent,
      cashAfter: Math.max(0, cashAfter), wBefore, wAfter
    };
  }

  /** 투입금 배치 후 가상 보유 상태 */
  function afterDeposit(st, dep) {
    return { ...st, B: st.B + dep.qT, C: st.C + dep.qS, D: dep.cashAfter, depKRW: 0 };
  }

  /** LOC 체결 시뮬레이션 (종가 p) */
  function simulate(st, orders, p, cfg) {
    const fee = cfg.fee / 100;
    let B = st.B, cash = st.D;
    const filled = [];
    for (const o of orders) {
      if (o.side === 'sell' && p >= o.limit - EPS) {
        B -= o.qty; cash += o.qty * p * (1 - fee); filled.push(o);
      } else if (o.side === 'buy' && p <= o.limit + EPS) {
        B += o.qty; cash -= o.qty * p * (1 + fee); filled.push(o);
      }
    }
    const S0 = st.C * st.pS;
    const wBefore = (st.B * p) / (st.B * p + S0 + st.D);
    const wAfter = (B * p) / (B * p + S0 + cash);
    return { wBefore, wAfter, filled, B, cash };
  }

  /**
   * 오늘 걸 LOC 주문 계획.
   *  - 트리거 가격: 보유 수량과 안전자산을 고정했을 때 비중이 밴드 경계가 되는 TQQQ 가격
   *      P_hi = hi/(1-hi) * S / B ,  P_lo = lo/(1-lo) * S / B
   *  - 수량: 트리거 가격에서 목표 비중으로 복구하는 정수 주수(편차 최소, 원 코드의 ROUNDUP 대신 반올림)
   */
  function planLOC(st, cfg) {
    const t = cfg.target / 100, band = cfg.band / 100, near = cfg.near / 100;
    const fee = cfg.fee / 100;
    const hi = t + band, lo = t - band;
    const m = metrics(st);
    const out = { m, t, hi, lo, zone: 'calm', orders: [], fund: null, trig: null, idle: null };
    if (!(st.B > 0) || !(m.H > 0) || !(st.pT > 0)) { out.zone = 'empty'; return out; }

    const Phi = (hi / (1 - hi)) * m.S / st.B;
    const Plo = (lo / (1 - lo)) * m.S / st.B;
    out.trig = { Phi, Plo, upPct: Phi / st.pT - 1, dnPct: Plo / st.pT - 1 };

    const w = m.w;
    const breachUp = w >= hi - EPS, breachDn = w <= lo + EPS;
    const nearUp = w >= t + near - EPS, nearDn = w <= t - near + EPS;
    const upArmed = cfg.always || nearUp;
    const dnArmed = cfg.always || nearDn;
    out.zone = breachUp ? 'breach-up' : breachDn ? 'breach-dn' : nearUp ? 'near-up' : nearDn ? 'near-dn' : 'calm';

    // ── 매도 LOC (지정가 이상에서 체결)
    if (breachUp || upArmed) {
      const limit = Math.max(0.01, ceil2(Phi));
      let qTrig = Math.round(needSell(st.B, m.S, t, Phi));
      if (breachUp) {
        const qNow = Math.min(st.B, Math.round(needSell(st.B, m.S, t, st.pT)));
        if (cfg.split && qTrig > 0 && qNow > qTrig) {
          out.orders.push({ side: 'sell', sym: 'TQQQ', qty: qTrig, limit, tag: '1차 (밴드 경계)' });
          out.orders.push({ side: 'sell', sym: 'TQQQ', qty: qNow - qTrig, limit: r2(st.pT), tag: '2차 (현재가 유지 시)' });
        } else if (qNow > 0) {
          out.orders.push({ side: 'sell', sym: 'TQQQ', qty: qNow, limit, tag: '밴드 이탈' });
        }
      } else if (qTrig > 0) {
        out.orders.push({ side: 'sell', sym: 'TQQQ', qty: Math.min(st.B, qTrig), limit, tag: '사전 예약' });
      }
    }

    // ── 매수 LOC (지정가 이하에서 체결)
    if (breachDn || dnArmed) {
      const limit = Math.max(0.01, floor2(Plo));
      const qTrig = Math.round(needBuy(st.B, m.S, t, Plo));
      if (breachDn) {
        const qNow = Math.round(needBuy(st.B, m.S, t, st.pT));
        if (cfg.split && qTrig > 0 && qNow > qTrig) {
          out.orders.push({ side: 'buy', sym: 'TQQQ', qty: qTrig, limit, tag: '1차 (밴드 경계)' });
          out.orders.push({ side: 'buy', sym: 'TQQQ', qty: qNow - qTrig, limit: r2(st.pT), tag: '2차 (현재가 유지 시)' });
        } else if (qNow > 0) {
          out.orders.push({ side: 'buy', sym: 'TQQQ', qty: qNow, limit, tag: '밴드 이탈' });
        }
      } else if (qTrig > 0) {
        out.orders.push({ side: 'buy', sym: 'TQQQ', qty: qTrig, limit, tag: '사전 예약' });
      }
    }

    // ── 매수 LOC 자금 점검 (부족하면 SGOV 선매도 안내)
    const buys = out.orders.filter((o) => o.side === 'buy');
    if (buys.length) {
      const maxCost = buys.reduce((a, o) => a + o.qty * o.limit * (1 + fee), 0);
      const shortfall = Math.max(0, maxCost - st.D);
      let sgovSell = 0, enough = true;
      if (shortfall > 0) {
        sgovSell = Math.ceil(shortfall / (st.pS * (1 - fee)) - EPS);
        if (sgovSell > st.C) { enough = false; sgovSell = st.C; }
      }
      out.fund = { need: maxCost, have: st.D, shortfall, sgovSell, enough };
    }

    // ── 놀고 있는 예수금 (매수 주문이 없을 때만 안내)
    if (!buys.length && st.D - cfg.buffer >= st.pS * (1 + fee)) {
      out.idle = { qS: Math.floor((st.D - cfg.buffer) / (st.pS * (1 + fee)) + EPS) };
    }
    return out;
  }

  /** 시나리오 표: 오늘 종가가 x% 움직이면? */
  function scenarios(st, orders, cfg, moves) {
    return (moves || [-20, -15, -10, -5, -2, 0, 2, 5, 10, 15, 20]).map((r) => {
      const p = st.pT * (1 + r / 100);
      const s = simulate(st, orders, p, cfg);
      return { r, p, wBefore: s.wBefore, wAfter: s.wAfter, filled: s.filled.length };
    });
  }

  /** 체결 반영 (수수료 포함). 문제가 있으면 warn 으로 알려준다. */
  function applyTrade(h, tr, cfg) {
    const fee = cfg.fee / 100;
    const out = { B: h.B, C: h.C, D: h.D };
    const key = tr.sym === 'TQQQ' ? 'B' : 'C';
    const gross = tr.qty * tr.price;
    let warn = null;
    if (tr.side === 'buy') {
      out[key] += tr.qty;
      out.D -= gross * (1 + fee);
    } else {
      if (tr.qty > out[key] + EPS) warn = `${tr.sym} 보유 수량(${out[key]}주)보다 많이 팔 수 없어요`;
      out[key] -= tr.qty;
      out.D += gross * (1 - fee);
    }
    if (out.D < -0.005) { warn = warn || `예수금이 $${r2(-out.D).toFixed(2)} 부족해요`; }
    out.D = r2(out.D);
    return { h: out, warn };
  }

  /** 가격 기준일이 오래됐는지 (주말 포함 4일 초과면 경고) */
  function daysOld(isoDate, now) {
    if (!isoDate) return null;
    const d = new Date(isoDate + 'T00:00:00Z');
    const n = now ? new Date(now) : new Date();
    const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
    return Math.floor((today - d.getTime()) / 86400000);
  }

  return {
    DEFAULT_SETTINGS, metrics, needSell, needBuy, planDeposit, afterDeposit,
    planLOC, simulate, scenarios, applyTrade, daysOld, r2
  };
});
