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
    split: false, // (고급) 밴드 이탈 상태에서 주문을 2개로 나누기. 기본은 1개
    always: false, // 항상 양방향 LOC 표시
    notifyNear: true,   // 알림: 밴드 근접(미리 걸기 구간)도 알림
    notifyDaily: false  // 알림: 관망인 날에도 매일 요약 알림
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
          // 한 번에 걸기: 수량은 '지금 가격' 기준으로 목표 비중이 되는 주수.
          // 지정가는 '이 수량을 팔았을 때 비중이 (목표 - 미리걸기구간) 밑으로 내려가지 않는 가장 낮은 종가'.
          // (그 아래로 떨어지면 체결되지 않아 과매도를 막고, 밴드 경계 가격보다는 높게 유지)
          const wF = t - near;
          // 정수 반올림 때문에 지금 가격에서도 하한 밑으로 내려가는 일이 없도록 수량 상한을 둔다
          const qMax = Math.floor(st.B - (wF * (st.B * st.pT + m.S)) / st.pT + 1e-9);
          const q = Math.min(qNow, qMax);
          if (q > 0) {
            const denom = st.B * (1 - wF) - q;
            let L = denom > 0 ? (wF * m.S) / denom : st.pT;
            L = Math.min(Math.max(ceil2(L), limit), r2(st.pT));
            out.orders.push({ side: 'sell', sym: 'TQQQ', qty: q, limit: Math.max(0.01, L), tag: '밴드 이탈' });
          }
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
          // 지정가는 '이 수량을 샀을 때 비중이 (목표 + 미리걸기구간) 위로 올라가지 않는 가장 높은 종가'.
          const wC = t + near;
          const qMax = Math.floor((wC * (st.B * st.pT + m.S)) / st.pT - st.B + 1e-9);
          const q = Math.min(qNow, qMax);
          if (q > 0) {
            const L0 = (wC * m.S) / (st.B * (1 - wC) + q);
            const L = Math.max(Math.min(floor2(L0), limit), r2(st.pT));
            out.orders.push({ side: 'buy', sym: 'TQQQ', qty: q, limit: Math.max(0.01, L), tag: '밴드 이탈' });
          }
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

  /**
   * 체결 뒤 정리: 종가 p 에서 주문이 체결된다고 가정했을 때
   *  - 매도 체결 → 매도대금(+예수금)으로 SGOV 를 최대한 매수
   *  - 매수 LOC 자금 부족 → fund.sgovSell 만큼 SGOV 를 먼저 매도(체결 여부와 무관)
   * 결과로 TQQQ / SGOV / 현금 구성 비율과 SGOV 순매매 수량을 돌려준다.
   */
  function settle(st, orders, p, cfg, fund) {
    const fee = cfg.fee / 100;
    const sim = simulate(st, orders, p, cfg);
    const B = sim.B;
    let C = st.C, D = sim.cash;
    const sells = sim.filled.filter((o) => o.side === 'sell').reduce((a, o) => a + o.qty, 0);
    const buys = sim.filled.filter((o) => o.side === 'buy').reduce((a, o) => a + o.qty, 0);
    if (fund && fund.sgovSell > 0) { C -= fund.sgovSell; D += fund.sgovSell * st.pS * (1 - fee); }
    if (sells > 0) {
      const q = Math.max(0, Math.floor((D - cfg.buffer) / (st.pS * (1 + fee)) + EPS));
      if (q > 0) { C += q; D -= q * st.pS * (1 + fee); }
    }
    const net = C - st.C;
    const T = B * p, Sv = C * st.pS, H = T + Sv + D;
    return {
      p, B, C, D, sells, buys, filled: sim.filled.length,
      proceeds: sells * p * (1 - fee), cost: buys * p * (1 + fee),
      sgov: { act: net > 0 ? 'buy' : net < 0 ? 'sell' : null, qty: Math.abs(net), amount: Math.abs(net) * st.pS },
      comp: H > 0 ? { t: T / H, s: Sv / H, c: D / H } : { t: 0, s: 0, c: 0 }
    };
  }

  /** 주문 방향별로 "체결되면 이렇게 된다" 요약. 밴드 이탈이면 현재가 유지, 사전 예약이면 지정가에서 체결되는 경우 */
  function finishPlan(st, plan, cfg) {
    const out = [];
    for (const side of ['sell', 'buy']) {
      const os = plan.orders.filter((o) => o.side === side);
      if (!os.length) continue;
      const breach = side === 'sell' ? plan.zone === 'breach-up' : plan.zone === 'breach-dn';
      const p = breach ? r2(st.pT) : os[0].limit;
      const f = settle(st, os, p, cfg, side === 'buy' ? plan.fund : null);
      const T0 = st.B * p, S0 = st.C * st.pS, H0 = T0 + S0 + st.D;
      out.push({
        side, breach, orders: os, qty: side === 'sell' ? f.sells : f.buys, ...f,
        before: { B: st.B, C: st.C, D: st.D, comp: { t: T0 / H0, s: S0 / H0, c: st.D / H0 } }
      });
    }
    return out;
  }

  /** 시나리오 표: 오늘 종가가 x% 움직이면? */
  function scenarios(st, orders, cfg, moves, fund) {
    return (moves || [-20, -15, -10, -5, -2, 0, 2, 5, 10, 15, 20]).map((r) => {
      const p = st.pT * (1 + r / 100);
      const s = simulate(st, orders, p, cfg);
      const f = settle(st, orders, p, cfg, fund);
      return { r, p, wBefore: s.wBefore, wAfter: s.wAfter, filled: s.filled.length, sgov: f.sgov, comp: f.comp };
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


  /* ───────────── 분석 묶음 (앱과 알림 서버가 같이 쓴다) ───────────── */

  /** 보유/시세/투입금/설정으로 오늘의 계획을 한 번에 계산 */
  function analyze(inp) {
    const h = inp.hold, px = inp.px, cfg = Object.assign({}, DEFAULT_SETTINGS, inp.settings || {});
    const st = { B: h.B, C: h.C, D: h.D, pT: px.pT, pS: px.pS, fx: px.fx || 0, depKRW: inp.depKRW || 0 };
    if (!(st.pT > 0 && st.pS > 0)) return { ready: false, st, cfg };
    const plan0 = planLOC(st, cfg);
    const dep = st.depKRW > 0 && st.fx > 0 ? planDeposit(st, cfg) : null;
    const st2 = dep ? afterDeposit(st, dep) : st;
    const plan = dep ? planLOC(st2, cfg) : plan0;
    return { ready: true, st, st2, cfg, plan0, dep, plan, m: metrics(st) };
  }

  /* ───────────── 미국 주식시장 달력 ───────────── */
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
  /** m월의 n번째 wd요일 날짜(일). wd: 0=일 ... 6=토 */
  function nthWeekday(y, m, wd, n) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  }
  function lastWeekday(y, m, wd) {
    const last = new Date(Date.UTC(y, m, 0));
    return last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7);
  }
  function easterSunday(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    return { month: Math.floor((h + l - 7 * m + 114) / 31), day: ((h + l - 7 * m + 114) % 31) + 1 };
  }
  /** 토요일이면 금요일, 일요일이면 월요일에 쉰다 */
  function observed(y, m, d) {
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const t = new Date(Date.UTC(y, m - 1, d + (wd === 6 ? -1 : wd === 0 ? 1 : 0)));
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  /** 해당 연도의 NYSE 정규 휴장일 (YYYY-MM-DD 목록). 임시 휴장(국가 추모일 등)은 포함하지 않는다 */
  function usMarketHolidays(y) {
    const out = [];
    const jan1 = new Date(Date.UTC(y, 0, 1)).getUTCDay();
    if (jan1 === 0) out.push(ymd(y, 1, 2)); else if (jan1 !== 6) out.push(ymd(y, 1, 1)); // 토요일 신정은 쉬지 않음
    out.push(ymd(y, 1, nthWeekday(y, 1, 1, 3)));            // 마틴 루터 킹 데이
    out.push(ymd(y, 2, nthWeekday(y, 2, 1, 3)));            // 대통령의 날
    const e = easterSunday(y);
    const gf = new Date(Date.UTC(y, e.month - 1, e.day - 2));
    out.push(ymd(y, gf.getUTCMonth() + 1, gf.getUTCDate())); // 성금요일
    out.push(ymd(y, 5, lastWeekday(y, 5, 1)));              // 메모리얼 데이
    out.push(observed(y, 6, 19));                            // 준틴스
    out.push(observed(y, 7, 4));                             // 독립기념일
    out.push(ymd(y, 9, nthWeekday(y, 9, 1, 1)));            // 노동절
    out.push(ymd(y, 11, nthWeekday(y, 11, 4, 4)));          // 추수감사절
    out.push(observed(y, 12, 25));                           // 크리스마스
    return out;
  }
  function isUsMarketHoliday(dateStr) {
    const y = Number(String(dateStr).slice(0, 4));
    return usMarketHolidays(y).indexOf(dateStr) >= 0;
  }
  /** 해당 날짜의 뉴욕 시간대 UTC 오프셋(시간): 서머타임 -4, 아니면 -5 */
  function usEtOffset(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d);
    return t >= Date.UTC(y, 2, nthWeekday(y, 3, 0, 2)) && t < Date.UTC(y, 10, nthWeekday(y, 11, 0, 1)) ? -4 : -5;
  }
  /** 그날 정규장 마감(오후 4시, 뉴욕)의 UTC 시각(ms) */
  function usCloseUtc(dateStr) { return Date.parse(dateStr + 'T16:00:00Z') - usEtOffset(dateStr) * 3600000; }
  /** dateStr 하루 전부터 거슬러 올라가 가장 가까운 개장일 (주말, 휴장일 제외) */
  function prevTradingDay(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    let t = Date.UTC(y, m - 1, d);
    for (let i = 0; i < 10; i++) {
      t -= 86400000;
      const dt = new Date(t), s = ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()), wd = dt.getUTCDay();
      if (wd !== 0 && wd !== 6 && !isUsMarketHoliday(s)) return s;
    }
    return null;
  }

  /** 시각(ms)의 뉴욕 현지 날짜와 시:분 */
  function etParts(ms) {
    let off = usEtOffset(new Date(ms).toISOString().slice(0, 10));
    const etDate = new Date(ms + off * 3600000).toISOString().slice(0, 10);
    off = usEtOffset(etDate);
    const d = new Date(ms + off * 3600000);
    return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) };
  }

  const LIVE_MAX_AGE_MS = 20 * 60000;

  /**
   * Twelve Data /quote 응답을 우리가 쓰는 값으로 바꾼다.
   * price: 장중이면 현재가, 장이 닫혀 있으면 마지막 종가 / open: 지금 장이 열려 있는지
   * date: 이 값이 속한 거래일 / prevClose, prevDate: 그 전 거래일 종가 / at: 마지막 시세 시각(ms)
   */
  function parseQuote(j, nowMs) {
    if (!j || typeof j !== 'object' || j.status === 'error' || j.code) throw new Error((j && j.message) || 'API 오류');
    const price = parseFloat(j.close);
    if (!(price > 0)) throw new Error('가격 형식 오류');
    const date = String(j.datetime || '').slice(0, 10);
    const pc = parseFloat(j.previous_close);
    const sec = Number(j.last_quote_at);
    const at = sec > 0 ? sec * 1000 : 0;
    return {
      price, date,
      open: j.is_market_open === true || j.is_market_open === 'true',
      prevClose: pc > 0 ? pc : 0,
      prevDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? prevTradingDay(date) : null,
      at,
      ageMs: at && nowMs ? Math.max(0, nowMs - at) : null
    };
  }

  /** 가장 최근에 끝난 정규장 종가. 장중이면 전 거래일 종가, 장이 닫혀 있으면 지금 값이 곧 종가 */
  function lastClose(q) {
    return q.open ? { date: q.prevDate, close: q.prevClose } : { date: q.date, close: q.price };
  }

  /** 지금 값이 "오늘 열린 장의 최신 시세"인지. 아니면 이유를 돌려준다 */
  function liveStatus(q, nowMs) {
    if (!q.open) return { ok: false, why: '미국 증시가 아직 열리지 않았거나 쉬는 날이에요' };
    const et = etParts(nowMs);
    if (q.date !== et.date) return { ok: false, why: '시세가 아직 오늘 장 값이 아니에요 (시세 기준일 ' + (q.date || '없음') + ')' };
    if (q.ageMs != null && q.ageMs > LIVE_MAX_AGE_MS) return { ok: false, why: '시세가 ' + Math.round(q.ageMs / 60000) + '분 전 값이에요' };
    return { ok: true, why: '' };
  }

  /** 걸어둔 LOC 주문이 eodDate 종가로 결정됐는지, 체결 조건을 충족했는지 */
  function judgePending(p, eodDate, close) {
    if (!eodDate || !(close > 0) || !(p.placedAt > 0)) return { judged: false };
    if (!(usCloseUtc(eodDate) > p.placedAt)) return { judged: false }; // 주문 걸기 전에 끝난 종가라 해당 없음
    const fill = p.side === 'sell' ? close >= p.limit - EPS : close <= p.limit + EPS;
    return { judged: true, fill, close };
  }

  /* ───────────── 알림 문구 ───────────── */
  const fmtUsd = (x) => '$' + Number(x).toFixed(2);
  const fmtPct = (x) => (x * 100).toFixed(1) + '%';
  const fmtKrw = (x) => Math.round(x).toLocaleString('ko-KR') + '원';

  /**
   * 점검 결과 → 푸시 알림 내용.
   * level: pending(걸어둔 주문 확인) / breach(밴드 이탈) / near(미리 걸기) / deposit(투입금) / daily(관망 요약) / none(보내지 않음)
   * ctx = { res: analyze() 결과, eod: { T:{date,close}, S:{date,close} }, pending: [{ p, judged, fill }] }
   */
  function alertMessage(ctx) {
    const { res, eod } = ctx;
    const pending = ctx.pending || [];
    const head = ctx.head || `기준 ${eod.T.date} 종가: TQQQ ${fmtUsd(eod.T.close)}, SGOV ${fmtUsd(eod.S.close)}`;

    if (pending.length) {
      if (!pending.some((x) => x.judged)) return { level: 'none', reason: '걸어둔 주문이 아직 마감 전이에요' };
      const lines = pending.map((x) => {
        const o = x.p;
        const state = !x.judged ? '아직 마감 전' : x.fill ? '체결 조건 충족, 체결됐을 가능성이 높아요' : '체결 조건 미달, 미체결로 보여요';
        const cl = x.judged && x.close > 0 ? `${x.date ? x.date.slice(5) + ' ' : ''}종가 ${fmtUsd(x.close)}, ` : '';
        return `${o.sym} ${o.side === 'buy' ? '매수' : '매도'} ${o.qty}주(지정가 ${fmtUsd(o.limit)}): ${cl}${state}`;
      });
      return {
        level: 'pending', priority: 4, tags: ['white_check_mark'], title: '✅ 걸어둔 주문을 확인해 주세요',
        body: [head, ...lines, '증권사 체결 내역을 보고 츄테크 앱에서 "체결됐어요" 또는 "미체결, 삭제"를 눌러 주세요. 기록해야 다음 점검이 정확해져요.'].join('\n')
      };
    }
    if (!res.ready) return { level: 'none', reason: '시세가 없어요' };

    const { plan, dep, st2, cfg } = res;
    const w = res.m.w;
    const zone = plan.zone;
    const lines = [head];
    if (dep) {
      const buys = [dep.qT > 0 ? `TQQQ ${dep.qT}주` : '', dep.qS > 0 ? `SGOV ${dep.qS}주` : ''].filter(Boolean).join(', ');
      lines.push(`투입금 ${fmtKrw(res.st.depKRW)}(약 ${fmtUsd(dep.depUSD)}): ${buys ? buys + ' 매수' : '1주를 살 만큼이 아니라 예수금으로 보관'}`);
    }
    if (plan.fund && plan.fund.shortfall > 0) {
      lines.push(plan.fund.enough
        ? `먼저 데이장에 SGOV ${plan.fund.sgovSell}주를 팔아 달러를 확보하세요`
        : 'SGOV를 모두 팔아도 매수 자금이 모자라요. 수량을 줄이거나 현금을 더 확보하세요');
    }
    plan.orders.forEach((o, i) => {
      lines.push(`${plan.orders.length > 1 ? (i + 1) + ') ' : ''}TQQQ ${o.qty}주 LOC ${o.side === 'buy' ? '매수' : '매도'}, 지정가 ${fmtUsd(o.limit)}`);
    });
    const fin = plan.orders.length ? finishPlan(st2, plan, cfg) : [];
    fin.forEach((f) => {
      const c = f.comp;
      const comp = `TQQQ ${fmtPct(c.t)}, SGOV ${fmtPct(c.s)}, 현금 ${fmtPct(c.c)}`;
      if (f.side === 'sell' && f.sgov.act === 'buy') lines.push(`체결되면 SGOV ${f.sgov.qty}주를 매수하세요 (정리 후 ${comp})`);
      else lines.push(`체결되면 비중 ${comp}`);
    });

    const act = plan.orders.length ? plan.orders[0].side : (zone.endsWith('up') ? 'sell' : 'buy');
    const verb = act === 'sell' ? '매도' : '매수';
    if (zone === 'breach-up' || zone === 'breach-dn') {
      if (!plan.orders.length) lines.push('수량이 1주에 못 미쳐서 걸 주문이 없어요');
      lines.push('LOC 주문은 미국 장 마감 전까지 걸면 돼요. 걸고 나면 앱에서 "주문 걸었어요"를 눌러 주세요.');
      return { level: 'breach', priority: 4, tags: ['rotating_light'], title: `🚨 TQQQ ${fmtPct(w)}, ${verb} 리밸런싱 필요`, body: lines.join('\n') };
    }
    if ((zone === 'near-up' || zone === 'near-dn') && cfg.notifyNear !== false && plan.orders.length) {
      lines.push('아직 밴드 안쪽이에요. 큰 변동에 대비해 미리 걸어 두는 주문이에요.');
      return { level: 'near', priority: 3, tags: [zone === 'near-up' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'], title: `${zone === 'near-up' ? '📈' : '📉'} TQQQ ${fmtPct(w)}, ${verb} LOC 미리 걸기`, body: lines.join('\n') };
    }
    if (dep) return { level: 'deposit', priority: 3, tags: ['moneybag'], title: '💰 투입금 배치 계획이 있어요', body: lines.join('\n') };
    if (cfg.notifyDaily) {
      const t = res.plan0.trig;
      if (t) lines.push(`TQQQ가 ${(t.upPct * 100).toFixed(1)}% 오르거나 ${(Math.abs(t.dnPct) * 100).toFixed(1)}% 내리면 밴드에 닿아요`);
      return { level: 'daily', priority: 2, tags: ['coffee'], title: `☕ TQQQ ${fmtPct(w)}, 오늘은 관망`, body: lines.join('\n') };
    }
    return { level: 'none', reason: '밴드 안쪽이라 알릴 게 없어요' };
  }

  return {
    DEFAULT_SETTINGS, metrics, needSell, needBuy, planDeposit, afterDeposit,
    planLOC, simulate, settle, finishPlan, scenarios, applyTrade, daysOld, r2,
    analyze, usMarketHolidays, isUsMarketHoliday, usEtOffset, usCloseUtc, prevTradingDay, judgePending, alertMessage,
    etParts, parseQuote, lastClose, liveStatus, LIVE_MAX_AGE_MS
  };
});
