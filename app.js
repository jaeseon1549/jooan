/* 퀀트 내비게이터 - 화면/동작 (바닐라 JS, 외부 의존성 없음) */
(() => {
  'use strict';
  const { DEFAULT_SETTINGS, metrics, planDeposit, afterDeposit, planLOC, scenarios, applyTrade, daysOld, r2 } = QN;

  const KEY = 'qn.v1';
  const STALE_MS = 20 * 3600 * 1000;

  /* ───────────── 상태 ───────────── */
  const blankPx = () => ({ v: 0, date: '', src: 'manual', ts: 0 });
  const defaults = () => ({
    v: 1,
    settings: { ...DEFAULT_SETTINGS },
    hold: { B: 0, C: 0, D: 0 },
    px: { T: blankPx(), S: blankPx(), F: blankPx() },
    depKRW: 0,
    pending: [],
    history: [],
    apiKey: '',
    hideInstall: false
  });
  function merge(d, raw) {
    const out = { ...d, ...raw };
    out.settings = { ...d.settings, ...(raw.settings || {}) };
    out.hold = { ...d.hold, ...(raw.hold || {}) };
    const px = raw.px || {};
    out.px = { T: { ...blankPx(), ...px.T }, S: { ...blankPx(), ...px.S }, F: { ...blankPx(), ...px.F } };
    out.pending = Array.isArray(raw.pending) ? raw.pending : [];
    out.history = Array.isArray(raw.history) ? raw.history : [];
    return out;
  }
  function load() {
    const d = defaults();
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (raw && typeof raw === 'object') return merge(d, raw);
    } catch (e) { /* 무시 */ }
    return d;
  }
  let state = load();
  let tab = 'today';
  const ui = { busy: false, msg: '' };
  let sheet = null;

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { toast('저장 공간을 쓸 수 없어요. 사생활 보호 모드인지 확인해 주세요.'); }
  }

  /* ───────────── 유틸 ───────────── */
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => { const n = parseFloat(String(v).replace(/,/g, '').trim()); return Number.isFinite(n) ? n : 0; };
  const usd = (x) => (x < 0 ? '-' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const krw = (x) => Math.round(x).toLocaleString('ko-KR') + '원';
  const pct1 = (x) => (x * 100).toFixed(1) + '%';
  const pct0 = (x) => Math.round(x * 100) + '%';
  const round4 = (x) => Math.round(x * 1e4) / 1e4;
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDT = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const ago = (ms) => {
    const m = Math.floor(ms / 60000);
    if (m < 1) return '방금'; if (m < 60) return `${m}분 전`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}시간 전`;
    return `${Math.floor(h / 24)}일 전`;
  };
  let toastTimer;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }
  const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('복사했어요'); }
    catch (e) { window.prompt('길게 눌러 복사해 주세요', text); }
  }

  /* ───────────── 시세 가져오기 ───────────── */
  async function getJSON(url, ms = 9000) {
    const ctl = new AbortController();
    const id = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '응답 시간 초과' : e.message === 'Failed to fetch' ? '네트워크 오류 또는 브라우저 차단(CORS)' : e.message);
    } finally { clearTimeout(id); }
  }
  async function fetchFX() {
    try {
      const j = await getJSON('https://api.frankfurter.dev/v2/rate/USD/KRW');
      if (j && j.rate > 0) return { rate: j.rate, date: j.date };
      throw new Error('형식 오류');
    } catch (e1) {
      const j = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW');
      if (j && j.rates && j.rates.KRW > 0) return { rate: j.rates.KRW, date: j.date };
      throw new Error('환율 형식 오류');
    }
  }
  async function fetchEOD(sym) {
    const j = await getJSON(`https://api.twelvedata.com/eod?symbol=${sym}&apikey=${encodeURIComponent(state.apiKey)}`);
    if (j.status === 'error' || j.code) throw new Error(j.message || 'API 오류');
    const close = parseFloat(j.close);
    if (!(close > 0)) throw new Error('가격 형식 오류');
    return { price: close, date: String(j.datetime || '').slice(0, 10) };
  }
  async function refresh() {
    if (ui.busy) return;
    ui.busy = true; ui.msg = '불러오는 중…'; renderResults();
    const errs = [];
    const jobs = [];
    jobs.push(fetchFX().then((r) => { state.px.F = { v: round4(r.rate), date: r.date, src: 'auto', ts: Date.now() }; })
      .catch((e) => errs.push('환율: ' + e.message)));
    if (state.apiKey) {
      for (const [k, sym] of [['T', 'TQQQ'], ['S', 'SGOV']]) {
        jobs.push(fetchEOD(sym).then((r) => { state.px[k] = { v: r.price, date: r.date, src: 'auto', ts: Date.now() }; })
          .catch((e) => errs.push(`${sym}: ${e.message}`)));
      }
    } else {
      errs.push('주가 자동 조회는 설정에서 Twelve Data 키를 넣으면 돼요. 지금은 직접 입력해 주세요.');
    }
    await Promise.all(jobs);
    ui.busy = false;
    ui.msg = errs.length ? errs.join('\n') : '시세를 불러왔어요';
    save(); render();
  }

  /* ───────────── 계산 ───────────── */
  function engine() {
    const s = state;
    const st = { B: s.hold.B, C: s.hold.C, D: s.hold.D, pT: s.px.T.v, pS: s.px.S.v, fx: s.px.F.v, depKRW: s.depKRW };
    if (!(st.pT > 0 && st.pS > 0)) return { ready: false, st };
    const cfg = s.settings;
    const plan0 = planLOC(st, cfg);
    const dep = st.depKRW > 0 && st.fx > 0 ? planDeposit(st, cfg) : null;
    const st2 = dep ? afterDeposit(st, dep) : st;
    const plan = dep ? planLOC(st2, cfg) : plan0;
    const sc = scenarios(st2, plan.orders, cfg);
    return { ready: true, st, st2, cfg, plan0, dep, plan, sc, m: metrics(st) };
  }
  const sameOrder = (a, b) => a.side === b.side && a.sym === b.sym && a.qty === b.qty && Math.abs(a.limit - b.limit) < 0.005;
  const isPinned = (o) => state.pending.some((p) => sameOrder(p, o));

  function judge(p) {
    const T = state.px.T;
    const changed = (T.date && T.date !== p.refAsof) || (!T.date && T.v !== p.refPrice);
    if (!changed || !(T.v > 0)) return null;
    const fill = p.side === 'sell' ? T.v >= p.limit - 1e-9 : T.v <= p.limit + 1e-9;
    return { close: T.v, fill };
  }
  function pxLabel(p) {
    if (!p.v) return { t: '값을 입력해 주세요', stale: true };
    const age = Date.now() - p.ts;
    if (p.src === 'auto') {
      const d = daysOld(p.date);
      const stale = age > STALE_MS || (d != null && d > 4);
      return { t: `${p.date} 기준, 자동 ${ago(age)}` + (stale ? ' (새로고침 필요)' : ''), stale };
    }
    const stale = !p.ts || age > STALE_MS;
    return { t: p.ts ? `직접 입력, ${ago(age)}` + (stale ? ' (오늘 가격이 맞나요?)' : '') : '직접 입력', stale };
  }

  /* ───────────── 화면: 오늘 ───────────── */
  const ZONE = (E) => {
    const { hi, lo } = E.plan0;
    return {
      'calm': ['ok', '☕ 관망 구간'],
      'near-up': ['near', '📈 상승 접근, 매도 LOC 미리 걸기'],
      'near-dn': ['near', '📉 하락 접근, 매수 LOC 미리 걸기'],
      'breach-up': ['breach', `🚨 ${pct0(hi)} 이탈, 매도 리밸런싱`],
      'breach-dn': ['breach', `🚨 ${pct0(lo)} 이탈, 매수 리밸런싱`],
      'empty': ['idle', 'TQQQ 보유가 없어요']
    }[E.plan0.zone];
  };


  function basisRow() {
    const T = state.px.T, S = state.px.S;
    const stale = [T, S].some((p) => p.v > 0 && pxLabel(p).stale);
    const basis = T.date ? `${T.date} 종가 기준` : '직접 입력한 가격 기준';
    return `<div class="row" style="margin-bottom:14px"><span class="small ${stale ? '' : 'muted'}" style="${stale ? 'color:var(--warn);font-weight:600' : ''}">${basis}${stale ? ', 갱신 필요' : ''}</span>
      <button class="btn small" data-act="refresh" ${ui.busy ? 'disabled' : ''}>${ui.busy ? '불러오는 중' : '시세 불러오기'}</button></div>
      ${ui.msg ? `<div class="small muted" style="white-space:pre-line;margin:-6px 0 12px">${esc(ui.msg)}</div>` : ''}`;
  }

  function heroHTML(E) {
    const { m, plan0 } = E;
    if (!(m.H > 0)) {
      return `<section class="card empty"><div class="big">🧭</div>
        <p><b>아직 보유 수량이 없어요</b></p>
        <p class="muted small">아래에 추가 투입금을 넣으면 TQQQ와 SGOV를 얼마씩 사야 하는지 계산해 드려요.<br>이미 보유 중이라면 <button class="link" data-tab-go="hold">보유 탭</button>에서 수량을 입력해 주세요.</p></section>`;
    }
    const w = m.w, { lo, hi, t } = plan0;
    const rmin = Math.max(0, (lo - 0.08) * 100), rmax = Math.min(100, (hi + 0.08) * 100);
    const pos = (x) => Math.max(0, Math.min(100, ((x * 100 - rmin) / (rmax - rmin)) * 100));
    const [cls, label] = ZONE(E);
    const pinCls = cls === 'breach' ? 'breach' : cls === 'near' ? 'near' : '';
    let trig = '';
    if (plan0.trig && (plan0.zone === 'calm' || plan0.zone.startsWith('near'))) {
      const { Phi, Plo, upPct, dnPct } = plan0.trig;
      trig = `<div class="stack small muted" style="margin-top:14px">
        <div>TQQQ가 <b>${(upPct * 100).toFixed(1)}%</b> 오르면 (종가 ${usd(Phi)} 이상) 비중이 ${pct0(hi)}에 닿아요</div>
        <div>TQQQ가 <b>${(Math.abs(dnPct) * 100).toFixed(1)}%</b> 내리면 (종가 ${usd(Plo)} 이하) 비중이 ${pct0(lo)}에 닿아요</div></div>`;
    }
    return `<section class="card hero">
      ${basisRow(E)}
      <div class="ratio"><span class="n t">${(w * 100).toFixed(1)}</span><span class="sep">:</span><span class="n s">${((1 - w) * 100).toFixed(1)}</span></div>
      <div class="ratio-l"><span>TQQQ</span><span>SGOV와 예수금</span></div>
      <div class="meter" style="--lo:${pos(lo)}%;--hi:${pos(hi)}%">
        <div class="meter-track"><i class="meter-target" style="left:${pos(t)}%"></i><b class="meter-pin ${pinCls}" style="left:${pos(w)}%"></b></div>
        <div class="meter-scale"><span style="left:${pos(lo)}%">${pct0(lo)}</span><span style="left:${pos(t)}%">${pct0(t)}</span><span style="left:${pos(hi)}%">${pct0(hi)}</span></div>
      </div>
      <div class="center" style="margin-top:12px"><span class="chip ${cls}">${label}</span></div>
      ${trig}
      <div class="totals"><span>총 자산 <b>${usd(m.H)}</b></span><span>${E.st.fx > 0 ? `<b>${krw(m.H * E.st.fx)}</b>` : '환율을 입력하면 원화로 보여요'}</span></div>
    </section>`;
  }

  function staleNotes(E) {
    const out = [];
    const T = state.px.T, S = state.px.S, F = state.px.F;
    const any = [['TQQQ', T], ['SGOV', S], ['환율', F]].filter(([, p]) => p.v > 0 && pxLabel(p).stale).map(([n]) => n);
    if (any.length) out.push(`<div class="note warn small">${any.join(', ')} 값이 오래됐을 수 있어요. 주문 수량과 지정가는 <b>직전 종가</b> 기준이라, 오늘 종가로 갱신한 뒤 확인하세요.</div>`);
    if (state.depKRW > 0 && !(F.v > 0)) out.push('<div class="note bad small">추가 투입금을 달러로 바꾸려면 환율이 필요해요.</div>');
    return out.join('');
  }

  function pendingHTML(E) {
    if (!state.pending.length) return '';
    const items = state.pending.map((p, i) => {
      const j = E.ready ? judge(p) : null;
      const jt = j
        ? `종가 ${usd(j.close)} 기준으로 <b>${j.fill ? '체결 조건을 충족' : '체결 조건에 못 미침'}</b>해요 (${j.fill ? '체결됐을 가능성이 높아요' : '미체결로 보여요'}). 증권사 체결 내역으로 꼭 확인하세요.`
        : '새 종가를 반영하면 체결 여부를 예상해 드려요.';
      return `<div class="order ${p.side}">
        <div class="order-h"><span class="side">${p.side === 'buy' ? '매수' : '매도'}</span><b>${esc(p.sym)}</b><span class="qty">${p.qty}주</span>${p.tag ? `<span class="tag">${esc(p.tag)}</span>` : ''}</div>
        <div class="limit">LOC 지정가 ${usd(p.limit)}</div>
        <div class="small muted">${fmtDT(p.placedAt)} 등록. ${jt}</div>
        <div class="btns"><button class="btn primary small grow" data-act="fill" data-i="${i}">체결됐어요</button><button class="btn small grow" data-act="drop" data-i="${i}">미체결, 삭제</button></div>
      </div>`;
    }).join('');
    return `<section class="card"><h2>걸어둔 주문 확인</h2>${items}</section>`;
  }

  function depositHTML(E) {
    if (!(state.depKRW > 0)) return '';
    if (!E.dep) return '';
    const { dep, st } = E;
    const lines = [];
    if (dep.qT > 0) lines.push(`<div class="row"><span>TQQQ 매수</span><b>${dep.qT}주</b></div><div class="small muted">약 ${usd(dep.qT * st.pT)}</div>`);
    if (dep.qS > 0) lines.push(`<div class="row"><span>SGOV 매수</span><b>${dep.qS}주</b></div><div class="small muted">약 ${usd(dep.qS * st.pS)}</div>`);
    const none = !lines.length;
    return `<section class="card"><h2>투입금 배치</h2>
      <p class="small muted" style="margin:0 0 10px">${krw(state.depKRW)}을 환율 ${st.fx.toLocaleString('ko-KR')}원으로 환전하면 약 ${usd(dep.depUSD)}예요.</p>
      ${none ? '<div class="note info small">1주를 살 만큼의 금액이 아니에요. 예수금으로 두었다가 다음에 함께 배치하세요.</div>' : `<div class="stack">${lines.join('')}</div>
      <div class="totals"><span>남는 현금 <b>${usd(dep.cashAfter)}</b></span><span>비중 <b>${pct1(E.m.w)}</b>에서 <b>${pct1(dep.wAfter)}</b></span></div>`}
      <div class="btns" style="margin-top:12px"><button class="btn primary grow" data-act="${none ? 'dep-only' : 'apply-dep'}">${none ? '예수금 입금만 반영' : '매수 체결 반영'}</button></div>
      ${none ? '' : '<p class="small muted" style="margin-bottom:0">시장가 또는 현재가 근처 지정가로 바로 사고, 체결되면 위 버튼으로 기록하세요. 매수는 현금 한도 안에서만 나누고, 이미 비중이 높은 쪽은 사지 않아요.</p>'}
    </section>`;
  }

  function ordersHTML(E) {
    const { plan, st2, dep } = E;
    const head = `<h2>오늘 걸 주문</h2>${dep ? '<p class="small muted" style="margin:-6px 0 10px">위 투입금 매수가 체결된 뒤 보유 기준이에요.</p>' : ''}`;
    if (plan.zone === 'empty') {
      return `<section class="card">${head}<div class="note info small">TQQQ를 보유하면 그 수량으로 LOC 주문을 계산해 드려요.</div></section>`;
    }
    let body = '';
    if (!plan.orders.length) {
      body += `<div class="empty" style="padding:14px 0"><div class="big">☕</div><b>오늘은 걸 주문이 없어요</b><p class="small muted" style="margin:6px 0 0">비중이 밴드 안쪽이라 기다리면 돼요.</p></div>`;
    } else {
      body += plan.orders.map((o, i) => {
        const sim = QN.simulate(st2, plan.orders, o.limit, E.cfg); // 분할 주문은 함께 체결되는 기준
        return `<div class="order ${o.side}">
          <div class="order-h"><span class="side">${o.side === 'buy' ? '매수' : '매도'}</span><b>${o.sym}</b><span class="qty">${o.qty}주</span><span class="tag">${esc(o.tag)}</span></div>
          <div class="limit">LOC 지정가 <b>${usd(o.limit)}</b></div>
          <div class="small muted">${o.side === 'sell' ? '종가가 지정가 이상이면 체결' : '종가가 지정가 이하면 체결'}. 종가가 지정가일 때 비중은 약 ${pct1(sim.wAfter)}.</div>
          <div class="btns"><button class="btn small" data-act="copy" data-i="${i}">복사</button>
          ${isPinned(o) ? '<span class="done-mark" style="align-self:center">등록됨 ✓</span>' : `<button class="btn primary small grow" data-act="pin" data-i="${i}">주문 걸었어요</button>`}</div>
        </div>`;
      }).join('');
    }
    if (plan.fund) {
      const f = plan.fund;
      if (f.shortfall <= 0) body += `<div class="note good small" style="margin-top:10px">매수 LOC에 최대 <b>${usd(f.need)}</b>가 필요하고, 예수금 <b>${usd(f.have)}</b>로 충분해요.</div>`;
      else if (f.enough) body += `<div class="note warn" style="margin-top:10px">매수 LOC가 체결되면 최대 <b>${usd(f.need)}</b>가 필요한데 예수금은 <b>${usd(f.have)}</b>예요.<br>데이장(한국 낮 시간)에 <b>SGOV ${f.sgovSell}주</b>를 먼저 팔아 달러를 확보하세요.
        <div class="btns" style="margin-top:8px"><button class="btn small" data-act="apply-fund">SGOV 매도 체결 반영</button></div></div>`;
      else body += `<div class="note bad" style="margin-top:10px">SGOV를 모두 팔아도 필요한 현금(<b>${usd(f.need)}</b>)에 못 미쳐요. 수량을 줄이거나 현금을 더 확보하세요.</div>`;
    }
    if (plan.idle) {
      body += `<div class="note info small" style="margin-top:10px">예수금 <b>${usd(st2.D)}</b>가 놀고 있어요. SGOV ${plan.idle.qS}주를 사 두면 이자가 붙어요. 비중은 그대로예요.
        <div class="btns" style="margin-top:8px"><button class="btn small" data-act="apply-idle">SGOV 매수 체결 반영</button></div></div>`;
    }
    return `<section class="card">${head}${body}</section>`;
  }

  function scenarioHTML(E) {
    if (!(E.m.H > 0) || E.plan.zone === 'empty') return '';
    const rows = E.sc.map((s) => {
      const sign = s.r > 0 ? '+' : s.r < 0 ? '−' : '';
      return `<tr class="${s.filled ? 'hit' : ''} ${s.r === 0 ? 'now' : ''}"><td>${sign}${Math.abs(s.r)}%</td><td>${usd(s.p)}</td><td>${pct1(s.wBefore)}</td><td>${s.filled ? `${s.filled}건` : '없음'}</td><td>${pct1(s.wAfter)}</td></tr>`;
    }).join('');
    return `<section class="card"><details><summary>오늘 종가별 시나리오</summary>
      <table class="tbl"><thead><tr><th>TQQQ 변동</th><th>종가</th><th>비중</th><th>체결</th><th>체결 후</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="small muted" style="margin-bottom:0">위 주문이 걸려 있을 때 종가가 이렇게 끝나면 어떻게 되는지 보여줘요. 노란 줄은 주문이 체결되는 경우예요.</p></details></section>`;
  }

  function resultsA() {
    const E = engine();
    if (!E.ready) {
      return `<section class="card empty"><div class="big">🧭</div><p><b>시세를 입력하면 시작해요</b></p>
        <p class="muted small">아래 칸에 TQQQ와 SGOV의 직전 종가, 환율을 입력하거나 불러오기 버튼을 눌러 주세요.<br>보유 수량은 <button class="link" data-tab-go="hold">보유 탭</button>에서 입력해요.</p>
        <div class="btns" style="justify-content:center;margin-top:8px"><button class="btn small" data-act="refresh" ${ui.busy ? 'disabled' : ''}>${ui.busy ? '불러오는 중' : '시세 불러오기'}</button></div>
        ${ui.msg ? `<div class="small muted" style="white-space:pre-line;margin-top:8px">${esc(ui.msg)}</div>` : ''}</section>`;
    }
    return heroHTML(E) + staleNotes(E) + pendingHTML(E) + depositHTML(E) + ordersHTML(E);
  }
  function resultsB() {
    const E = engine();
    return E.ready ? scenarioHTML(E) : '';
  }
  function renderResults() {
    const a = $('#res-a'), b = $('#res-b');
    if (a) a.innerHTML = resultsA();
    if (b) b.innerHTML = resultsB();
    paintBadge();
  }

  function paintSrc() {
    for (const [k, id] of [['T', 'T'], ['S', 'S'], ['F', 'F']]) {
      const el = $('#src-' + id); if (!el) continue;
      const l = pxLabel(state.px[k]);
      el.textContent = l.t; el.classList.toggle('stale', l.stale);
    }
    const dh = $('#dep-hint');
    if (dh) dh.textContent = state.depKRW > 0 && state.px.F.v > 0 ? `약 ${usd(state.depKRW / state.px.F.v)}` : '';
  }
  function renderToday() {
    const px = state.px;
    const banner = (!isStandalone() && isIOS() && !state.hideInstall)
      ? `<div class="note info small" style="margin-bottom:12px">홈 화면에 추가하면 앱처럼 열려요. Safari 아래쪽 공유 버튼을 누르고 <b>홈 화면에 추가</b>를 고르세요.
         <div class="btns" style="margin-top:8px"><button class="btn small" data-act="hide-install">알겠어요</button></div></div>` : '';
    $('#app').innerHTML = `${banner}
      <div id="res-a"></div>
      <section class="card">
        <h2>시세 직접 입력</h2>
        <div class="grid3">
          <label class="field"><span>TQQQ ($)</span><input class="in" id="in-T" inputmode="decimal" autocomplete="off" value="${px.T.v || ''}"><i class="src" id="src-T"></i></label>
          <label class="field"><span>SGOV ($)</span><input class="in" id="in-S" inputmode="decimal" autocomplete="off" value="${px.S.v || ''}"><i class="src" id="src-S"></i></label>
          <label class="field"><span>환율 (원)</span><input class="in" id="in-F" inputmode="decimal" autocomplete="off" value="${px.F.v || ''}"><i class="src" id="src-F"></i></label>
        </div>
        <p class="small muted" style="margin:10px 0 0">증권사 앱의 직전 종가를 그대로 넣어도 돼요.</p>
      </section>
      <section class="card">
        <label class="field"><span>추가 투입금 (원), 없으면 비워 두세요</span><input class="in" id="in-dep" inputmode="numeric" autocomplete="off" value="${state.depKRW || ''}"></label>
        <div class="small muted" id="dep-hint" style="margin-top:4px"></div>
      </section>
      <div id="res-b"></div>`;
    paintSrc(); renderResults();
  }

  /* ───────────── 화면: 보유 ───────────── */
  function renderHold() {
    const h = state.hold, E = engine();
    const sum = E.ready ? (() => {
      const m = E.m;
      return `<div class="stack small">
        <div class="row"><span class="muted">TQQQ 평가액</span><b>${usd(m.T)}</b></div>
        <div class="row"><span class="muted">SGOV 평가액</span><b>${usd(m.Ssgov)}</b></div>
        <div class="row"><span class="muted">예수금</span><b>${usd(h.D)}</b></div>
        <div class="row"><span class="muted">총 자산</span><b>${usd(m.H)}${E.st.fx > 0 ? ` (${krw(m.H * E.st.fx)})` : ''}</b></div></div>`;
    })() : '<p class="small muted" style="margin:0">오늘 탭에서 시세를 입력하면 평가액이 보여요.</p>';
    $('#app').innerHTML = `
      <section class="card"><h2>현재 보유</h2>
        <div class="stack">
          <label class="field"><span>TQQQ 보유 수량 (주)</span><input class="in" data-hold="B" inputmode="decimal" value="${h.B}"></label>
          <label class="field"><span>SGOV 보유 수량 (주)</span><input class="in" data-hold="C" inputmode="decimal" value="${h.C}"></label>
          <label class="field"><span>예수금 ($)</span><input class="in" data-hold="D" inputmode="decimal" value="${h.D}"></label>
        </div>
        <p class="small muted" style="margin-bottom:0">체결 반영 버튼을 쓰면 자동으로 바뀌어요. 증권사 앱과 수량이 다를 때만 여기서 직접 맞추세요. 고친 내용은 기록에 남아요.</p>
      </section>
      <section class="card"><h2>평가</h2>${sum}</section>`;
  }

  /* ───────────── 화면: 기록 ───────────── */
  function renderLog() {
    const hs = state.history.slice(0, 60);
    const list = hs.length ? hs.map((e) => `<div class="hist">
        <div class="d">${fmtDT(e.ts)}</div><div class="t">${esc(e.label)}</div>
        <div class="h">TQQQ ${e.after.B}주, SGOV ${e.after.C}주, 예수금 ${usd(e.after.D)}</div></div>`).join('')
      : '<div class="empty"><p class="muted">아직 기록이 없어요.<br>체결을 반영하면 여기에 쌓여요.</p></div>';
    $('#app').innerHTML = `
      <section class="card"><div class="row" style="margin-bottom:6px"><h2 style="margin:0">거래 기록</h2>
        <button class="btn small danger" data-act="undo" ${hs.length ? '' : 'disabled'}>마지막 되돌리기</button></div>${list}</section>
      <section class="card"><h2>백업과 복원</h2>
        <p class="small muted" style="margin-top:0">폰을 바꾸거나 앱을 지웠을 때를 대비해 가끔 백업해 두세요. 백업을 복사해 메모 앱에 붙여 두면 돼요. API 키는 포함되지 않아요.</p>
        <div class="btns"><button class="btn grow" data-act="export">백업 복사</button></div>
        <label class="field" style="margin-top:12px"><span>복원할 백업을 붙여 넣으세요</span><textarea class="in" id="restore-box" spellcheck="false"></textarea></label>
        <div class="btns" style="margin-top:8px"><button class="btn grow" data-act="restore">복원하기</button></div>
      </section>`;
  }

  /* ───────────── 화면: 설정 ───────────── */
  function renderSet() {
    const s = state.settings;
    const f = (id, label, val, step, hint) => `<label class="field"><span>${label}</span><input class="in" data-set="${id}" inputmode="decimal" value="${val}"><i class="src">${hint || ''}</i></label>`;
    $('#app').innerHTML = `
      <section class="card"><h2>전략</h2>
        <div class="grid2">
          ${f('target', 'TQQQ 목표 비중 (%)', s.target, 1, '나머지는 SGOV와 예수금')}
          ${f('band', '밴드 (± %p)', s.band, 1, `${s.target - s.band}% 아래 또는 ${s.target + s.band}% 위에서 리밸런싱`)}
          ${f('near', '미리 걸기 구간 (± %p)', s.near, 1, `${s.target - s.near}%, ${s.target + s.near}%부터 LOC 예약`)}
          ${f('fee', '매매 수수료 (%)', s.fee, 0.01, '증권사 수수료율')}
        </div>
        <div style="margin-top:10px">${f('buffer', '투입금 배치 때 현금으로 남길 금액 ($)', s.buffer, 1, '0이면 가능한 만큼 모두 배치해요')}</div>
        <label class="switch"><input type="checkbox" data-sw="split" ${s.split ? 'checked' : ''}><span><b>분할 LOC 사용</b><span class="small muted">밴드를 이미 넘은 날, 주문을 2개로 나눠 가격이 되돌려져도 과매도(과매수)가 생기지 않게 해요.</span></span></label>
        <label class="switch"><input type="checkbox" data-sw="always" ${s.always ? 'checked' : ''}><span><b>항상 양방향 LOC 표시</b><span class="small muted">큰 갭이 나도 놓치지 않지만, 매수 쪽은 항상 현금이 필요해요.</span></span></label>
      </section>
      <section class="card"><h2>시세 자동 조회</h2>
        <label class="field"><span>Twelve Data API 키 (선택)</span><input class="in" data-key="apiKey" type="password" autocomplete="off" autocapitalize="off" value="${esc(state.apiKey)}"></label>
        <p class="small muted" style="margin-bottom:0">twelvedata.com에서 무료로 가입하면 키를 받아요. 키는 이 기기에만 저장돼요. 키가 없어도 직접 입력해서 쓸 수 있어요. 환율은 키 없이 불러와요(ECB 참고환율이라 증권사 적용 환율과 조금 달라요).</p>
      </section>
      <section class="card"><details><summary>이 앱의 계산 방식</summary>
        <div class="stack small">
          <p style="margin:0">TQQQ와 (SGOV + 예수금)을 목표 비중으로 유지해요. 비중이 밴드를 벗어나면 목표 비중으로 되돌리는 LOC 주문을 만들어요.</p>
          <p style="margin:0"><b>지정가</b>는 보유 수량을 고정했을 때 비중이 밴드 경계가 되는 TQQQ 가격이에요. 종가가 그 선을 넘은 날에만 주문이 체결돼요.</p>
          <p style="margin:0"><b>수량</b>은 지정가에서 체결됐을 때 목표 비중과 가장 가까워지는 정수 주수예요.</p>
          <p style="margin:0">투입금은 매수만으로 배치해요. 이미 목표를 넘은 쪽은 사지 않고, 현금 한도를 넘겨 사라는 안내는 하지 않아요.</p>
          <p style="margin:0" class="muted">참고용 계산 도구예요. 실제 주문 전에 증권사 화면의 수량과 가격을 꼭 확인하세요.</p>
        </div></details></section>
      <section class="card"><h2>앱 관리</h2>
        <p class="small muted" style="margin-top:0">${isStandalone() ? '홈 화면 앱으로 실행 중이에요.' : 'iPhone은 Safari에서 공유 버튼을 누르고 홈 화면에 추가를 고르면 앱처럼 쓸 수 있어요.'}</p>
        <div class="btns"><button class="btn danger" data-act="reset">모든 데이터 지우기</button></div>
      </section>`;
  }

  /* ───────────── 체결 반영 시트 ───────────── */
  function openSheet(cfg) { sheet = cfg; renderSheet(); $('#sheet').hidden = false; }
  function closeSheet() { sheet = null; $('#sheet').hidden = true; $('#sheet').innerHTML = ''; }
  function renderSheet() {
    const s = sheet;
    $('#sheet').innerHTML = `<div class="sheet-bg" data-act="sheet-close"></div>
      <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${esc(s.title)}">
        <h2>${esc(s.title)}</h2><p class="small muted" style="margin:0 0 6px">${esc(s.sub || '')}</p>
        ${s.depUSD != null ? `<div class="line"><div class="lh">예수금 입금</div><label class="field"><span>입금(환전)된 달러 ($)</span><input class="in" id="sh-dep" inputmode="decimal" value="${r2(s.depUSD)}"></label></div>` : ''}
        ${s.lines.map((l, i) => `<div class="line"><div class="lh">${l.sym} ${l.side === 'buy' ? '매수' : '매도'}</div>
          <div class="grid2"><label class="field"><span>체결 수량 (주)</span><input class="in" data-sh="qty" data-i="${i}" inputmode="decimal" value="${l.qty}"></label>
          <label class="field"><span>체결 단가 ($)</span><input class="in" data-sh="price" data-i="${i}" inputmode="decimal" value="${l.price}"></label></div></div>`).join('')}
        <div class="btns" style="margin-top:14px"><button class="btn grow" data-act="sheet-close">취소</button><button class="btn primary grow" data-act="sheet-apply">반영하기</button></div>
      </div>`;
  }
  function sheetApply() {
    const s = sheet, cfg = state.settings;
    const lines = s.lines.map((l, i) => ({ ...l,
      qty: num($(`[data-sh="qty"][data-i="${i}"]`).value), price: num($(`[data-sh="price"][data-i="${i}"]`).value) }));
    const dep = s.depUSD != null ? num($('#sh-dep').value) : 0;
    for (const l of lines) if (!(l.qty > 0) || !(l.price > 0)) return toast('수량과 단가를 확인해 주세요');
    let h = { ...state.hold };
    h.D = r2(h.D + dep);
    const warns = [];
    for (const l of lines) { const r = applyTrade(h, l, cfg); h = r.h; if (r.warn) warns.push(r.warn); }
    if (warns.length && !window.confirm(warns.join('\n') + '\n그래도 반영할까요? (부족한 값은 0으로 처리돼요)')) return;
    h = { B: Math.max(0, round4(h.B)), C: Math.max(0, round4(h.C)), D: Math.max(0, r2(h.D)) };
    const sum = lines.map((l) => `${l.sym} ${l.side === 'buy' ? '+' : '−'}${l.qty}`).join(', ');
    const entry = { id: Date.now(), ts: Date.now(), type: s.type, before: { ...state.hold }, after: h, restore: {},
      label: `${s.label}${sum ? `: ${sum}` : dep ? `: 예수금 +${usd(dep)}` : ''}` };
    if (s.clearDep) { entry.restore.depKRW = state.depKRW; state.depKRW = 0; }
    if (s.pendIdx != null && state.pending[s.pendIdx]) { entry.restore.pending = state.pending[s.pendIdx]; state.pending.splice(s.pendIdx, 1); }
    state.hold = h;
    state.history.unshift(entry);
    state.history = state.history.slice(0, 500);
    save(); closeSheet(); toast('반영했어요'); render();
  }

  /* ───────────── 동작 ───────────── */
  function undoLast() {
    const e = state.history[0]; if (!e) return;
    if (!window.confirm(`마지막 기록을 되돌릴까요?\n${e.label}`)) return;
    state.hold = { ...e.before };
    if (e.restore && e.restore.depKRW) state.depKRW = e.restore.depKRW;
    if (e.restore && e.restore.pending) state.pending.unshift(e.restore.pending);
    state.history.shift(); save(); toast('되돌렸어요'); render();
  }
  function exportBackup() {
    const { apiKey, ...rest } = state;
    copyText(JSON.stringify(rest));
  }
  function restoreBackup() {
    const txt = ($('#restore-box').value || '').trim();
    if (!txt) return toast('붙여 넣을 백업이 없어요');
    let obj;
    try { obj = JSON.parse(txt); } catch (e) { return toast('백업 형식이 올바르지 않아요'); }
    if (!obj || typeof obj !== 'object' || !obj.hold || !Number.isFinite(Number(obj.hold.B))) return toast('백업 형식이 올바르지 않아요');
    if (!window.confirm('현재 데이터를 백업 내용으로 바꿀까요?')) return;
    state = merge(defaults(), { ...obj, apiKey: state.apiKey });
    save(); toast('복원했어요'); render();
  }
  function paintBadge() {
    const t = $('[data-tab="today"]'); if (!t) return;
    const old = $('.dot', t); if (old) old.remove();
    if (state.pending.length) t.insertAdjacentHTML('beforeend', '<i class="dot" aria-label="확인할 주문이 있어요"></i>');
  }
  function render() {
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (tab === 'today') renderToday(); else if (tab === 'hold') renderHold(); else if (tab === 'log') renderLog(); else renderSet();
    paintBadge();
  }
  function goTab(t) { tab = t; render(); window.scrollTo(0, 0); }

  document.addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-tab-go]'); if (go) return goTab(go.dataset.tabGo);
    const tb = ev.target.closest('.tab'); if (tb) return goTab(tb.dataset.tab);
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act, i = Number(el.dataset.i);
    const E = ['pin', 'copy', 'apply-dep', 'apply-fund', 'apply-idle', 'dep-only', 'fill'].includes(act) ? engine() : null;
    switch (act) {
      case 'refresh': refresh(); break;
      case 'hide-install': state.hideInstall = true; save(); render(); break;
      case 'copy': { const o = E.plan && E.plan.orders[i]; if (o) copyText(`${o.sym} ${o.side === 'buy' ? '매수' : '매도'} LOC ${o.qty}주 지정가 $${o.limit.toFixed(2)}`); break; }
      case 'pin': {
        const o = E.plan && E.plan.orders[i]; if (!o || isPinned(o)) break;
        state.pending.push({ ...o, id: Date.now() + i, placedAt: Date.now(), refPrice: state.px.T.v, refAsof: state.px.T.date || '' });
        save(); toast('주문을 등록했어요. 내일 체결 여부를 확인해 주세요'); render(); break;
      }
      case 'drop': {
        if (!window.confirm('이 주문을 미체결로 보고 삭제할까요?')) break;
        state.pending.splice(i, 1); save(); render(); break;
      }
      case 'fill': {
        const p = state.pending[i]; if (!p) break;
        openSheet({ title: '체결 반영', sub: '증권사 체결 내역과 같은 수량과 단가로 고쳐 주세요. 단가는 보통 그날 종가예요.',
          lines: [{ sym: p.sym, side: p.side, qty: p.qty, price: E.ready ? E.st.pT : p.limit }], type: 'loc', label: 'LOC 체결', pendIdx: i });
        break;
      }
      case 'apply-dep': case 'dep-only': {
        const d = E.dep; if (!d) break;
        const lines = [];
        if (act === 'apply-dep') {
          if (d.qT > 0) lines.push({ sym: 'TQQQ', side: 'buy', qty: d.qT, price: E.st.pT });
          if (d.qS > 0) lines.push({ sym: 'SGOV', side: 'buy', qty: d.qS, price: E.st.pS });
        }
        openSheet({ title: '투입금 반영', sub: '증권사에서 실제로 체결된 수량과 단가로 고쳐 주세요.', depUSD: d.depUSD, lines, type: 'deposit', label: `투입금 ${krw(state.depKRW)} 배치`, clearDep: true });
        break;
      }
      case 'apply-fund': {
        const f = E.plan && E.plan.fund; if (!f) break;
        openSheet({ title: 'SGOV 매도 반영', sub: '매수 LOC 자금을 만들기 위한 매도예요.', lines: [{ sym: 'SGOV', side: 'sell', qty: f.sgovSell, price: E.st2.pS }], type: 'fund', label: 'SGOV 매도(자금 확보)' });
        break;
      }
      case 'apply-idle': {
        const q = E.plan && E.plan.idle; if (!q) break;
        openSheet({ title: 'SGOV 매수 반영', sub: '놀고 있는 예수금으로 산 SGOV예요.', lines: [{ sym: 'SGOV', side: 'buy', qty: q.qS, price: E.st2.pS }], type: 'idle', label: 'SGOV 매수(유휴 예수금)' });
        break;
      }
      case 'sheet-close': closeSheet(); break;
      case 'sheet-apply': sheetApply(); break;
      case 'undo': undoLast(); break;
      case 'export': exportBackup(); break;
      case 'restore': restoreBackup(); break;
      case 'reset':
        if (window.confirm('보유, 기록, 설정을 모두 지울까요? 되돌릴 수 없어요.')) { state = defaults(); save(); toast('초기화했어요'); render(); }
        break;
    }
  });

  document.addEventListener('input', (ev) => {
    const id = ev.target.id;
    if (id === 'in-T' || id === 'in-S' || id === 'in-F') {
      const k = id.slice(3);
      state.px[k] = { v: num(ev.target.value), date: '', src: 'manual', ts: Date.now() };
      save(); paintSrc(); renderResults();
    } else if (id === 'in-dep') {
      state.depKRW = num(ev.target.value); save(); paintSrc(); renderResults();
    }
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset.hold) {
      const key = el.dataset.hold, val = num(el.value);
      if (val < 0) { toast('0 이상으로 입력해 주세요'); return renderHold(); }
      const old = state.hold[key];
      const nv = key === 'D' ? r2(val) : round4(val);
      if (nv === old) return;
      const before = { ...state.hold };
      state.hold[key] = nv;
      const nm = { B: 'TQQQ 수량', C: 'SGOV 수량', D: '예수금' }[key];
      const fmt = (v) => (key === 'D' ? usd(v) : `${v}주`);
      state.history.unshift({ id: Date.now(), ts: Date.now(), type: 'adjust', before, after: { ...state.hold }, restore: {}, label: `${nm} 직접 수정: ${fmt(old)} → ${fmt(nv)}` });
      save(); renderHold();
    } else if (el.dataset.set) {
      const key = el.dataset.set, s = state.settings; let v = num(el.value);
      const lim = { target: [10, 90], band: [1, 40], near: [0, 40], fee: [0, 2], buffer: [0, 1e9] }[key];
      v = Math.min(lim[1], Math.max(lim[0], v));
      const next = { ...s, [key]: v };
      if (next.target - next.band <= 0 || next.target + next.band >= 100) { toast('목표 비중과 밴드 조합이 범위를 벗어났어요'); return renderSet(); }
      state.settings = next; save(); renderSet();
    } else if (el.dataset.sw) {
      state.settings[el.dataset.sw] = el.checked; save();
    } else if (el.dataset.key) {
      state.apiKey = el.value.trim(); save(); toast(state.apiKey ? '키를 저장했어요' : '키를 지웠어요');
    }
  });

  /* ───────────── 시작 ───────────── */
  render();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
})();
