/*
 * 항공사 계층의 화면 — 상태를 받아 HTML 문자열을 돌려주는 순수 함수 모음.
 *
 * 제조사 쪽 `js/panels.js` 와 같은 규약이다. DOM 이벤트 배선은 `js/sky/ui.js` 가
 * 위임으로 처리하고(다시 그려도 핸들러가 살아 있도록), 여기서는 문자열만 만든다.
 * 스타일도 같은 `css/style.css` 를 쓴다 — 두 게임이 한 판에서 이어지려면 같은 계기판을
 * 보고 있어야 한다.
 */
(function (root) {
  'use strict';

  const Cities = root.AirlinerCities;
  const Econ = root.AirlinerSkyEconomics;
  const St = root.AirlinerSkyState;
  const A = root.AirlinerSkyActions;
  const Ai = root.AirlinerSkyAi;
  const P = root.AirlinerPanels;
  const Charts = root.AirlinerCharts;

  const esc = P.esc;
  const num = (n) => Math.round(n).toLocaleString('ko-KR');
  const pct = (v) => `${Math.round(v * 100)}%`;

  /**
   * 돈은 제조사 쪽과 같은 눈금으로 읽는다 — 두 계층이 같은 화폐를 쓴다.
   *
   * 백만 밑으로도 눈금을 내린다. `$M` 로만 적으면 슬롯 임차료 3만 6천 달러가 `$0.0M`
   * 으로 뜨는데, 그건 "0" 이라고 말하는 것과 같다 — 반납할지 말지를 그 숫자로 정한다.
   */
  function money(usd) {
    const m = usd / 1e6;
    if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(Math.abs(m) >= 10000 ? 0 : 1)}B`;
    if (Math.abs(m) >= 10) return `$${Math.round(m)}M`;
    if (Math.abs(m) >= 1) return `$${m.toFixed(1)}M`;
    if (Math.abs(usd) >= 1000) return `$${Math.round(usd / 1000)}k`;
    return `$${Math.round(usd)}`;
  }

  const tone = (v) => (v > 0 ? 'good' : v < 0 ? 'bad' : '');

  /**
   * 카드 한 장을 통째로 접는다 — 제조사 쪽 `foldCard` 와 같은 규칙이다(그쪽은 내보내지
   * 않아 여기 한 번 더 둔다). 접어도 **지금 값은 제목 옆에 남긴다**: 무엇을 감추고
   * 있는지 모르면 열어 보는 것 말고는 확인할 방법이 없고, 그러면 접은 의미가 없다.
   */
  function fold(folds, id, defaultOpen, title, body) {
    const toggled = !!(folds && folds.has(id));
    const open = defaultOpen ? !toggled : toggled;
    return `<section class="card fold-card full">
      <details class="fold"${open ? ' open' : ''}>
        <summary data-fold="${id}"><b>${title}</b></summary>
        <div class="fold-body">${body}</div>
      </details>
    </section>`;
  }
  const sign = (v) => (v > 0 ? '+' : '');

  function bar(v, cls) {
    const w = Math.max(0, Math.min(100, v * 100));
    return `<div class="bar"><span class="${cls || ''}" style="width:${w}%"></span></div>`;
  }

  /** 탑승률은 색으로 먼저 읽힌다 — 숫자를 세기 전에 어느 노선이 문제인지 보여야 한다. */
  const lfClass = (lf) => (lf >= 0.75 ? 'good' : lf >= 0.55 ? '' : 'bad');

  // ─────────────────────────────── 개요 ───────────────────────────────

  function renderOverview(s, meId) {
    const me = St.airline(s, meId);
    const r = me.results[me.results.length - 1];
    const routes = St.routesOf(s, meId).filter((x) => x.active);
    const planes = St.planesOf(s, meId);
    const idle = planes.filter((p) => p.routeId === null).length;
    const inCheck = planes.filter((p) => p.checkUntilTurn === s.turn).length;

    const ranked = St.living(s)
      .map((a) => ({ a, eq: St.equity(s, a) }))
      .sort((x, y) => y.eq - x.eq);
    // 접힌 회사는 이 목록에 없다 — `findIndex` 가 -1 을 내 "0위"가 뜬다.
    const rank = me.alive ? ranked.findIndex((x) => x.a.id === meId) + 1 : 0;

    // 통합 모드에서는 **제조사가 무너져도 판이 끝난 것**이다. 항공사만 보고 판단하면,
    // 파산 모달이 "그룹 성적은 항공사 화면에 있다"고 안내한 바로 그 화면에 성적표가
    // 없다 — 그룹 결과는 이미 F 로 정해졌는데.
    const groupOver = (() => {
      const Shell = root.AirlinerShell;
      if (!Shell || Shell.shell.mode !== 'group') return false;
      const mfg = root.AirlinerUI && root.AirlinerUI.ui.state;
      return !!(mfg && mfg.gameOver);
    })();
    // **항공사 성적표는 항공사 자신의 끝에만 뜬다.** `finalCard` 는 "20년 경영을
    // 마쳤다"고 적고 지금 순위를 최종 순위로 내놓는다 — 제조사만 무너진 시점에 띄우면
    // 아직 굴러가는 회사를 다 끝난 것처럼 말한다. 그룹 성적표만 앞당긴다.
    const over = s.turn >= s.totalTurns || !me.alive;
    return `
    <section class="cards">
      ${over || groupOver ? groupFinalCard(s, meId) : ''}
      ${over ? finalCard(s, meId) : ''}
      <div class="card">
        <h3>${esc(me.name)}</h3>
        <p class="muted">${esc(Cities.name(me.home))} 기반 · ${
          rank ? `자기자본 <b>${rank}위</b> / 생존 ${St.living(s).length}사` : '<b>파산</b> — 순위에서 빠졌다'
        }</p>
        <div class="sky-stats">
          ${stat('자기자본', money(St.equity(s, me)))}
          ${stat('현금', money(me.cash))}
          ${stat('부채', money(me.debt))}
          ${stat('노선', `${routes.length}개`)}
          ${stat('기재', `${planes.length}대`, idle ? `유휴 ${idle}` : '')}
          ${stat('정비 입고', `${inCheck}대`)}
        </div>
      </div>
      ${groupCard(s, meId)}
      ${r ? quarterCard(r) : '<div class="card"><p class="muted">첫 분기를 넘기면 실적이 나온다.</p></div>'}
      ${financeCard(s, meId)}
      ${slotCard(s, meId)}
      <div class="card full">
        <h3>순위</h3>
        <table class="tbl"><thead><tr><th class="r"></th><th>회사</th><th class="r">자기자본</th><th class="r">노선</th><th class="r">기재</th></tr></thead><tbody>
        ${ranked
          .map(
            (x, i) => `<tr class="${x.a.id === meId ? 'me' : ''}">
              <td>${i + 1}</td><td>${esc(x.a.name)}</td>
              <td class="r">${money(x.eq)}</td>
              <td class="r">${St.routesOf(s, x.a.id).filter((y) => y.active).length}</td>
              <td class="r">${St.planesOf(s, x.a.id).length}</td></tr>`,
          )
          .join('')}
        </tbody></table>
      </div>
    </section>`;
  }

  /**
   * 통합 모드 전용 — 모회사와의 사이.
   *
   * 통합 모드가 아니면 아무것도 그리지 않는다. 이 카드가 답하는 것은 셋이다.
   * 그룹 성적이 얼마인가, 자사 기종을 지금 얼마에 받을 수 있는가, 노선을 넓힌 값으로
   * 제조사가 무엇을 잃고 있는가.
   */
  function groupCard(s, meId) {
    const G = root.AirlinerSkyGroup;
    const Shell = root.AirlinerShell;
    if (!G || !Shell || Shell.shell.mode !== 'group') return '';
    const mfg = root.AirlinerUI && root.AirlinerUI.ui.state;
    if (!mfg) return '';

    const eq = G.combinedEquity(mfg, s, meId);
    // **대수마다 따로 견적을 받는다.** 한 대 견적의 착수금은 이미 반올림된 값이라,
    // 거기에 대수를 곱하면 실제 청구액과 어긋난다(84.8M 기종 2기는 실제 25M 인데 곱하면
    // 26M, 5기는 64M 인데 65M). 그 차이만큼, 낼 수 있는 돈으로도 단추가 잠긴다.
    const QTYS = [1, 2, 5];
    // **만들 수 있는 기종인지 함께 본다.** 조립 라인이 없으면 재고가 안 나오고, 재고가
    // 없으면 인도가 영영 안 된다 — 발주는 받아 주면서 아무 말도 안 하면 플레이어는
    // 몇 해를 기다리다 "인도가 안 된다"고 읽는다. 실제로 그렇게 됐다.
    const lineState = (id) => {
      const ls = (mfg.lines || []).filter((l) => l.programId === id);
      if (!ls.length) return { ok: false, why: '조립 라인 없음 — 세우기 전에는 한 대도 못 만든다' };
      if (ls.every((l) => l.idle)) return { ok: false, why: '조립 라인이 모두 가동 중지 상태다' };
      return { ok: true, why: '' };
    };
    const progs = G.orderablePrograms(mfg)
      .map((p) => ({ base: G.quote(mfg, p.id, 1), lots: QTYS.map((n) => G.quote(mfg, p.id, n)), line: lineState(p.id) }))
      .filter((x) => x.base);
    const me = St.airline(s, meId);
    const pending = (s.orders || []).filter((o) => o.external && o.airlineId === meId);

    // 지금 노선이 겹치는 회사와, 그 때문에 제조사가 잃고 있는 신뢰.
    const mineKeys = new Set(
      St.routesOf(s, meId).filter((x) => x.active).map((x) => Cities.pairKey(x.from, x.to)),
    );
    const rivals = [];
    for (const a of s.airlines) {
      if (a.id === meId || !a.alive) continue;
      const n = St.routesOf(s, a.id).filter((x) => x.active && mineKeys.has(Cities.pairKey(x.from, x.to))).length;
      if (n) rivals.push({ a, n, rel: mfg.relations ? Math.round(mfg.relations[a.id] ?? 0) : null });
    }
    rivals.sort((x, y) => y.n - x.n || x.a.id.localeCompare(y.a.id));

    return `<div class="card full">
      <h3>모회사</h3>
      <p class="muted">두 장부를 합해서 잰다. 계열 간 거래는 합계를 못 움직인다 — 값을 어떻게 매기든 그룹 성적은 그대로다.</p>
      <div class="sky-stats">
        ${stat('그룹 합산', money(eq.total))}
        ${stat('제조사', money(eq.maker))}
        ${stat('항공사', money(eq.airline))}
        ${eq.internal ? stat('계열 상계', '−' + money(eq.internal), '중복 계상분') : ''}
      </div>

      <h4>자체 발주</h4>
      <p class="muted">공고를 거치지 않는다. 대신 <b>줄은 똑같이 선다</b> — 생산 대기열에서 남의 주문을 제치지 않으므로, 재고가 나와야 인도된다.</p>
      ${
        progs.length
          ? `<ul class="lines">${progs
              .map(({ base, lots, line }) => {
                const dep = base.deposit * G.MUSD;
                return `<li>
                  <b>${esc(base.name)}</b>
                  <span class="muted">대당 ${money(base.unitPrice * G.MUSD)} · 1기 착수금 ${money(dep)}${
                    me.cash >= dep ? '' : ' — 현금 부족'
                  }</span>
                  ${line.ok ? '' : `<span class="order-warn">⚠ ${esc(line.why)}</span>`}
                  <span class="row">
                    ${lots
                      .map((q) =>
                        q
                          ? `<button class="ghost" data-action="group-order" data-prog="${esc(q.programId)}" data-qty="${q.qty}"${
                              me.cash >= q.deposit * G.MUSD ? '' : ' disabled'
                            } title="착수금 ${money(q.deposit * G.MUSD)}">${q.qty}기</button>`
                          : '',
                      )
                      .join('')}
                  </span>
                </li>`;
              })
              .join('')}</ul>`
          : '<p class="muted">아직 양산 중인 자사 기종이 없다. 제조사 화면에서 형식증명을 받아야 한다.</p>'
      }
      ${
        pending.length
          ? (() => {
              const stuck = pending.filter((o) => !lineState(o.typeId).ok);
              const n = pending.reduce((x, o) => x + o.count, 0);
              return `<p class="muted">인도 대기 ${n}기 · 선급금 ${money(pending.reduce((x, o) => x + o.paid, 0))}</p>
                ${
                  stuck.length
                    ? `<p class="order-warn">발주해 둔 ${stuck.reduce((x, o) => x + o.count, 0)}기는 <b>만들 라인이 없어 오지 않는다</b>.
                       제조사 화면 <b>생산</b> 탭에서 라인을 세워야 한다.</p>`
                    : ''
                }`;
            })()
          : ''
      }

      <h4>노선에서 겨루는 손님</h4>
      ${
        rivals.length
          ? `<p class="muted">이 회사들은 우리 기체를 사는 손님이자 노선의 경쟁자다. 겹칠수록 제조사를 덜 믿는다 — 자체 항공사를 갖는 값이다.</p>
             <table class="tbl"><thead><tr><th>회사</th><th class="r">겹치는 노선</th><th class="r">제조사 관계</th></tr></thead><tbody>
             ${rivals
               .map(
                 (x) =>
                   `<tr><td>${esc(x.a.name)}</td><td class="r">${x.n}개</td><td class="r">${
                     x.rel === null ? '—' : x.rel
                   }</td></tr>`,
               )
               .join('')}
             </tbody></table>`
          : '<p class="muted">아직 겹치는 노선이 없다. 남의 안방을 밟기 전까지는 값을 치르지 않는다.</p>'
      }
    </div>`;
  }

  /** 숫자 한 칸 — 라벨 위, 값 아래. 좁은 화면에서 두 칸씩 접힌다. */
  const stat = (label, value, sub) =>
    `<div class="sky-stat"><span>${esc(label)}</span><b>${esc(value)}</b>${sub ? `<i>${esc(sub)}</i>` : ''}</div>`;

  function quarterCard(r) {
    const rows = [
      ['운항 수입', r.revenue, 1],
      ['연료', -r.fuel],
      ['승무원', -r.crew],
      ['정비', -r.maint],
      ['중정비', -r.checkCost],
      ['착륙·항행', -r.landing],
      ['기내 서비스', -r.paxService],
      ['판매 수수료', -r.distribution],
      ['간접비', -r.overhead],
      ['슬롯 임차료', -r.slotRent],
      ['감가상각', -r.depreciation],
      ['이자', -r.interest],
      ['법인세', -r.tax],
    ];
    return `<div class="card">
      <h3>이번 분기 손익</h3>
      <table class="tbl"><tbody>
      ${rows
        .filter((x) => Math.abs(x[1]) >= 1)
        .map((x) => `<tr><td>${esc(x[0])}</td><td class="r ${x[2] ? 'good' : 'bad'}">${money(x[1])}</td></tr>`)
        .join('')}
      <tr class="sum"><td><b>순익</b></td><td class="r ${tone(r.net)}"><b>${sign(r.net)}${money(r.net)}</b></td></tr>
      </tbody></table>
      <p class="muted">승객 ${num(r.pax)}명 · 공급 ${num(r.seats)}석 · 탑승률 ${r.seats > 0 ? pct(r.pax / r.seats) : '—'}</p>
    </div>`;
  }

  /**
   * 차입과 상환 — AI 는 `Ai.finance` 로 늘 쓰는 수단이다.
   *
   * 화면에 없으면 플레이어만 한 분기 적자에 기재를 팔아 메워야 한다. 명령은 이미 있고
   * 한도도 명령 쪽이 재므로, 여기서는 누를 자리만 낸다.
   */
  function financeCard(s, meId) {
    const a = St.airline(s, meId);
    const room = Math.max(0, St.debtCap(s, a) - a.debt);
    // 남은 여력이 10M 밑이면 그 남은 만큼만 빌린다. 최소 단위를 강요하면 버튼이
    // 잠겨, 명령 계층과 AI 는 되는 소액 차입을 플레이어만 못 해 급매로 몰린다.
    const step = Math.min(room, Math.max(10e6, Math.round(room / 4 / 1e6) * 1e6));
    // **상환액은 차입 여력과 무관하다.** 손실로 자본이 줄어 부채가 한도를 넘으면
    // 여력이 0 이 되는데, 그때가 바로 빚을 줄여야 할 때다. 여력에서 금액을 끌어오면
    // 버튼이 0 을 보내고 명령이 물린다 — 갚을 길이 막힌다.
    const payable = Math.min(a.debt, Math.max(0, a.cash));
    const payStep = Math.min(payable, Math.max(10e6, Math.round(payable / 4 / 1e6) * 1e6));
    return `<div class="card full">
      <h3>자금</h3>
      <div class="sky-stats">
        ${stat('현금', money(a.cash))}
        ${stat('부채', money(a.debt))}
        ${stat('차입 여력', money(room))}
        ${stat('이자율', `연 ${(St.interestRate(s, a) * 100).toFixed(1)}%`)}
      </div>
      <div class="row">
        <button class="ghost" data-action="borrow" data-amount="${step}" ${step <= 0 ? 'disabled' : ''}>
          ${money(step)} 차입</button>
        <button class="ghost" data-action="repay" data-amount="${payStep}" ${payStep <= 0 ? 'disabled' : ''}>
          ${money(payStep)} 상환</button>
      </div>
      <p class="muted">이자는 아무것도 안 하고 나가는 돈이다. 여유가 생기면 먼저 갚는 편이 낫다.</p>
    </div>`;
  }

  /**
   * 노는 슬롯 — 쥐고 있는 것만으로 매 분기 임차료가 나간다.
   *
   * 노선을 접어도 슬롯은 남는다(그래야 곧바로 다시 열 수 있다). 반납할 자리가 화면에
   * 없으면 플레이어만 영영 그 임차료를 문다 — AI 는 `shedIdleSlots` 로 정리한다.
   */
  function slotCard(s, meId) {
    const a = St.airline(s, meId);
    const rows = Object.keys(a.slots)
      .map((city) => ({ city, free: A.freeSlots(s, meId, city), held: a.slots[city] }))
      .filter((x) => x.free > 0)
      .sort((x, y) => y.free * (Cities.get(y.city).standing + Cities.get(y.city).tour) - x.free * (Cities.get(x.city).standing + Cities.get(x.city).tour));
    if (!rows.length) return '';
    const waste = rows.reduce((x, r) => x + r.free * St.slotRent(s, meId, r.city), 0);
    return `<div class="card full">
      <h3>노는 슬롯</h3>
      <p class="muted">쓰지 않는 ${rows.reduce((x, r) => x + r.free, 0)}자리에 분기마다 <b>${money(waste)}</b>가 나간다.
        반납하면 임차료가 멎지만, 다시 잡을 때는 그 사이 오른 값을 치른다.</p>
      <table class="tbl"><thead><tr><th>공항</th><th class="r">보유</th><th class="r">노는 자리</th><th class="r">분기 임차료</th><th class="r"></th></tr></thead><tbody>
      ${rows
        .map(
          (x) => `<tr><td>${esc(Cities.name(x.city))}</td>
            <td class="r">${x.held}</td><td class="r">${x.free}</td>
            <td class="r">${money(x.free * St.slotRent(s, meId, x.city))}</td>
            <td class="r"><button class="ghost" data-action="shed" data-city="${esc(x.city)}" data-count="${x.free}">반납</button></td></tr>`,
        )
        .join('')}
      </tbody></table>
    </div>`;
  }

  /**
   * 최종 성적표.
   *
   * 등급만 던지면 무엇을 잘하고 못했는지가 남지 않는다 — 항목별 점수를 함께 편다
   * (제조사 쪽 `scoreBreakdown` 과 같은 규칙).
   */
  /**
   * 통합 모드의 최종 성적표 — 그룹으로 읽는 20년.
   *
   * 두 계층의 성적표를 따로 두면 정작 이 모드가 내건 규칙("성적은 합산 자기자본이다")을
   * 결말이 안 지킨다. 이것이 머리에 오고, 항공사 성적표는 그 아래 세부로 남는다.
   */
  function groupFinalCard(s, meId) {
    const G = root.AirlinerSkyGroup;
    const Shell = root.AirlinerShell;
    if (!G || !Shell || Shell.shell.mode !== 'group') return '';
    const mfg = root.AirlinerUI && root.AirlinerUI.ui.state;
    if (!mfg) return '';
    const g = G.groupScore(mfg, s, meId);
    if (!g) return '';

    const a = St.airline(s, meId);
    const dead = [];
    if (!a.alive) dead.push('항공사');
    if (mfg.gameOver && mfg.gameOver.reason === 'bankrupt') dead.push('제조사');
    const why = dead.length
      ? `${dead.join('·')}가 무너졌다 — 통합 경영은 둘을 함께 지고 가는 판이다`
      : `${s.startYear + Math.floor((s.totalTurns - 1) / 4)}년 · 제조사와 자체 항공사를 함께 20년`;

    return `<div class="card full sky-final">
      <div class="sky-grade ${g.grade === 'F' ? 'bad' : 'good'}">${g.grade}</div>
      <h3>그룹 — ${num(g.score)}점</h3>
      <p class="muted">${esc(why)}</p>
      <div class="sky-stats">
        ${stat('그룹 자본', money(g.equity.total))}
        ${stat('제조사', money(g.equity.maker))}
        ${stat('항공사', money(g.equity.airline))}
        ${g.equity.internal ? stat('계열 상계', '−' + money(g.equity.internal), '중복 계상분') : ''}
      </div>
      <table class="tbl"><tbody>
        ${g.rows
          .map(
            (r) => `<tr><td><b>${esc(r.label)}</b><br><span class="muted">${esc(r.detail)}</span></td>
              <td class="r">${g.alive ? num(r.points) : '—'}</td></tr>`,
          )
          .join('')}
        <tr class="sum"><td><b>합계</b></td><td class="r"><b>${num(g.score)}</b></td></tr>
      </tbody></table>
      <p class="muted">S 7,000 · A 4,600 · B 3,000 · C 1,700 — 두 게임과 같은 눈금이다.
        <b>자본은 연결 기준으로 한 번만 센다</b> — 그래서 계열 간 값을 어떻게 매기든 이 점수는 안 움직인다.
        ${g.alive ? '' : '한쪽이라도 무너지면 F 다.'}</p>
    </div>`;
  }

  function finalCard(s, meId) {
    const f = St.finalScore(s, meId);
    if (!f) return '';
    const a = St.airline(s, meId);
    const why = a.alive ? `${s.startYear + Math.floor((s.totalTurns - 1) / 4)}년 · 20년 경영을 마쳤다` : '자본이 마르고 회사가 문을 닫았다';
    return `<div class="card full sky-final">
      <div class="sky-grade ${f.grade === 'F' ? 'bad' : 'good'}">${f.grade}</div>
      <h3>${esc(a.name)} — ${num(f.score)}점</h3>
      <p class="muted">${esc(why)} · 열두 회사 중 <b>${f.rank}위</b> (점수 기준)</p>
      <table class="tbl"><tbody>
        ${f.rows
          .map(
            (r) => `<tr><td><b>${esc(r.label)}</b><br><span class="muted">${esc(r.detail)}</span></td>
              <td class="r">${a.alive ? num(r.points) : '—'}</td></tr>`,
          )
          .join('')}
        <tr class="sum"><td><b>합계</b></td><td class="r"><b>${num(f.score)}</b></td></tr>
      </tbody></table>
      <p class="muted">S 7,000 · A 4,600 · B 3,000 · C 1,700 — 제조사 쪽과 같은 눈금이다.
        ${a.alive ? '' : '파산은 아무리 많이 실어 날랐어도 F 다.'}</p>
    </div>`;
  }

  // ─────────────────────────────── 노선 ───────────────────────────────

  function renderRoutes(s, meId, folds) {
    const routes = St.routesOf(s, meId)
      .filter((r) => r.active)
      .sort((x, y) => profitOf(y) - profitOf(x) || x.id - y.id);
    if (!routes.length) return '<section class="cards"><div class="card"><p class="muted">노선이 없다. <b>취항</b> 탭에서 열어라.</p></div></section>';

    return `<section class="cards">${routes.map((r) => routeCard(s, meId, r, folds)).join('')}</section>`;
  }

  const profitOf = (r) => (r.last ? r.last.revenue - r.last.cost : 0);

  function routeCard(s, meId, r, folds) {
    const dist = Cities.distance(r.from, r.to);
    const planes = St.assignedTo(s, r.id);
    const flying = St.flyingOn(s, r.id);
    const cap = Econ.capacity(flying, dist, (t) => s.types[t]);
    const last = r.last;
    const p = profitOf(r);
    const grounded = planes.length - flying.length;

    const body = `
      <div class="sky-stats">
        ${stat('거리', `${num(dist)}km`)}
        ${stat('편수', `주 ${r.freq}왕복`, `기재 한계 ${cap.maxFreq}`)}
        ${stat('운임', `표준의 ${r.fareMul.toFixed(2)}배`)}
        ${stat('기재', `${planes.length}대`, grounded ? `정비 ${grounded}대` : '')}
      </div>
      ${
        last && last.seats > 0
          ? `<div class="sky-stat wide"><span>탑승률</span><b class="${lfClass(last.loadFactor)}">${pct(last.loadFactor)}</b></div>
             ${bar(last.loadFactor, lfClass(last.loadFactor))}
             <p class="muted">승객 ${num(last.pax)}명${last.connectPax ? ` (환승 ${num(last.connectPax)})` : ''}
               · 점유율 ${pct(last.share)} · 수입 ${money(last.revenue)} · 원가 ${money(last.cost)}</p>`
          : '<p class="muted">아직 실적이 없다.</p>'
      }
      ${
        planes.length > 1
          ? `<div class="sky-detach"><span class="muted">기재를 떼면 다른 노선에 쓸 수 있다</span>
              ${planes
                .map(
                  (p) => `<button class="ghost" data-action="detach" data-route="${r.id}" data-plane="${p.id}">
                    ${esc(s.types[p.typeId].name)} 떼기</button>`,
                )
                .join('')}
            </div>`
          : ''
      }
      <div class="row">
        <button class="ghost" data-action="fare" data-route="${r.id}" data-delta="-0.05">운임 −5%</button>
        <button class="ghost" data-action="fare" data-route="${r.id}" data-delta="0.05">운임 +5%</button>
        <button class="ghost" data-action="freq" data-route="${r.id}" data-delta="-1">편수 −1</button>
        <button class="ghost" data-action="freq" data-route="${r.id}" data-delta="1">편수 +1</button>
        <button class="danger" data-action="close-route" data-route="${r.id}">노선 접기</button>
      </div>`;

    return fold(
      folds,
      `route-${r.id}`,
      false,
      `${esc(Cities.name(r.from))} – ${esc(Cities.name(r.to))}
        <span class="fold-val ${tone(p)}">${sign(p)}${money(p)}</span>
        ${last && last.seats > 0 ? `<span class="chip ${lfClass(last.loadFactor)}">${pct(last.loadFactor)}</span>` : ''}`,
      body,
    );
  }

  // ─────────────────────────────── 기재 ───────────────────────────────

  function renderFleet(s, meId, folds) {
    const planes = St.planesOf(s, meId);
    const me = St.airline(s, meId);
    const byType = {};
    for (const p of planes) (byType[p.typeId] = byType[p.typeId] || []).push(p);

    const orders = (s.orders || []).filter((o) => o.airlineId === meId);
    const year = St.yearFracOf(s);
    const buyable = Object.keys(s.types)
      .map((id) => s.types[id])
      .filter((t) => t.eis <= year && (!t.end || t.end > year))
      .sort((x, y) => x.price - y.price);

    return `<section class="cards">
      <div class="card full">
        <h3>보유 기재 ${planes.length}대</h3>
        ${
          Object.keys(byType).length
            ? `<table class="tbl"><thead><tr><th>기종</th><th class="r">대수</th><th class="r">기령</th><th class="r">유휴</th><th class="r">정비</th></tr></thead><tbody>
              ${Object.keys(byType)
                .sort()
                .map((id) => {
                  const g = byType[id];
                  const age = g.reduce((x, p) => x + p.ageQuarters, 0) / g.length / 4;
                  return `<tr><td>${esc(s.types[id].name)}</td><td class="r">${g.length}</td>
                    <td class="r">${age.toFixed(1)}년</td>
                    <td class="r">${g.filter((p) => p.routeId === null).length}</td>
                    <td class="r">${g.filter((p) => p.checkUntilTurn === s.turn).length}</td></tr>`;
                })
                .join('')}
            </tbody></table>`
            : '<p class="muted">기재가 없다.</p>'
        }
      </div>
      ${idleCard(s, meId, planes)}
      ${
        orders.length
          ? `<div class="card full"><h3>인도 예정</h3><ul class="lines">${orders
              // 자체 발주는 `deliverTurn` 이 없다 — 제조사의 생산 대기열이 때를 정한다.
              // 달력으로 빼면 "0분기 뒤"로 떴다가 "-5분기 뒤"까지 내려간다.
              .map(
                (o) =>
                  `<li>${esc(s.types[o.typeId] ? s.types[o.typeId].name : o.typeId)} ${o.count}대 — ${
                    o.external ? '생산 대기' : `${o.deliverTurn - s.turn}분기 뒤`
                  }</li>`,
              )
              .join('')}</ul></div>`
          : ''
      }
      ${fold(
        folds,
        'buy',
        false,
        `발주 <span class="muted">현금 ${money(me.cash)}</span>`,
        `<table class="tbl"><thead><tr><th>기종</th><th class="r">좌석</th><th class="r">항속</th><th class="r">값</th><th class="r"></th></tr></thead><tbody>
          ${buyable
            .map(
              (t) => `<tr><td>${esc(t.name)}</td><td class="r">${t.seats}</td><td class="r">${num(t.range)}km</td>
                <td class="r">${money(t.price)}</td>
                <td class="r"><button class="ghost" data-action="buy" data-type="${esc(t.id)}"
                  ${me.cash < t.price ? 'disabled' : ''}>발주</button></td></tr>`,
            )
            .join('')}
        </tbody></table>`,
      )}
    </section>`;
  }

  function idleCard(s, meId, planes) {
    const idle = planes.filter((p) => p.routeId === null);
    if (!idle.length) return '';
    const routes = St.routesOf(s, meId).filter((r) => r.active);
    return `<div class="card full">
      <h3>유휴 기재 ${idle.length}대</h3>
      <p class="muted">놀려도 간접비는 나간다. 노선에 붙이거나 처분하라.</p>
      <ul class="lines">${idle
        .map((p) => {
          const t = s.types[p.typeId];
          const fits = routes.filter((r) => Econ.canFly(t, Cities.distance(r.from, r.to)));
          return `<li>
            <b>${esc(t.name)}</b> <span class="muted">${(p.ageQuarters / 4).toFixed(1)}년 · 잔존 ${money(
              St.residual(t, p.ageQuarters, p.paid),
            )} · 처분가 ${money(St.residual(t, p.ageQuarters, p.paid) * A.RESALE_RATE)}</span>
            ${
              fits.length
                ? `<select data-action="assign" data-plane="${p.id}">
                    <option value="">노선에 붙이기…</option>
                    ${fits.map((r) => `<option value="${r.id}">${esc(Cities.name(r.from))}–${esc(Cities.name(r.to))}</option>`).join('')}
                  </select>`
                : '<span class="muted">붙일 만한 노선이 없다</span>'
            }
            <button class="ghost" data-action="sell" data-plane="${p.id}">처분</button>
          </li>`;
        })
        .join('')}</ul>
    </div>`;
  }

  // ─────────────────────────────── 취항 ───────────────────────────────

  /**
   * 신규 취항 후보 — AI 가 쓰는 매력도(`Ai.attractiveness`)를 그대로 보여준다.
   *
   * 플레이어와 AI 가 **같은 잣대**를 봐야 한다. 화면에만 다른 점수를 띄우면 "왜 저기를
   * 안 갔지"가 정보 비대칭이 되고, 잣대를 고칠 때 두 군데를 고치게 된다.
   */
  /**
   * 취항 후보.
   *
   * 후보마다 **그 구간에 쓸 수 있는 유휴기를 전부** 실어 보낸다. 가장 큰 기체를 골라
   * 놓고 그것만 넘기면, 장거리에 아껴 둔 광동체가 단거리에 끌려 나가고 플레이어는
   * 노선을 연 뒤 작은 기체로 갈아 끼우고 광동체를 떼는 수밖에 없다.
   */
  function openCandidates(s, meId, limit, choice) {
    const picked = choice || {};
    const me = St.airline(s, meId);
    const idle = St.planesOf(s, meId).filter((p) => p.routeId === null && p.checkUntilTurn !== s.turn);
    const served = new Set(St.routesOf(s, meId).filter((r) => r.active).map((r) => Cities.pairKey(r.from, r.to)));
    const out = [];
    // 양쪽 다 슬롯을 가진 구간은 두 번 걸린다 — 목록에 같은 노선이 두 줄로 뜬다.
    const seen = new Set();
    for (const from of Object.keys(me.slots).filter((c) => me.slots[c] > 0).sort()) {
      // 닫힌 공항은 후보에서 뺀다. 누르면 슬롯부터 사고 나서 `openRoute` 가 폐쇄를
      // 이유로 물리므로, 노선은 못 열고 슬롯값만 치르게 된다. AI 는 이미 거른다.
      if (St.isClosed(s.cityState[from] || {}, s.turn)) continue;
      for (const to of Cities.CITIES) {
        if (to.id === from || served.has(Cities.pairKey(from, to.id))) continue;
        if (seen.has(Cities.pairKey(from, to.id))) continue;
        if (St.isClosed(s.cityState[to.id] || {}, s.turn)) continue;
        const dist = Cities.distance(from, to.id);
        // 큰 기체가 먼저 오되, 나머지도 고를 수 있게 함께 싣는다.
        // **견적은 기체마다 따로 낸다.** 기종이 다르면 한 바퀴에 묶이는 시간이 달라
        // 낼 수 있는 편수가 갈리고, 그러면 필요한 슬롯과 값도 갈린다. 기본 기체의
        // 견적을 보여주고 다른 기체로 열면 화면에 없던 값이 빠져나간다.
        const usable = [];
        for (const p of idle
          .filter((x) => Econ.canFly(s.types[x.typeId], dist))
          .sort((x, y) => s.types[y.typeId].seats - s.types[x.typeId].seats || x.id - y.id)) {
          const cap = Econ.capacity([p], dist, (t) => s.types[t]);
          if (cap.maxFreq < 1) continue;
          const f = Math.min(cap.maxFreq, 7);
          const nf = Math.max(0, f - A.freeSlots(s, meId, from));
          const nt = Math.max(0, f - A.freeSlots(s, meId, to.id));
          if (nf > A.unsoldSlots(s, from) || nt > A.unsoldSlots(s, to.id)) continue;
          usable.push({
            plane: p,
            freq: f,
            needFrom: nf,
            needTo: nt,
            cost: A.slotCost(s, meId, from, nf) + A.slotCost(s, meId, to.id, nt) + A.routeSetupCost(s, from, to.id),
          });
        }
        if (!usable.length) continue;
        const key = Cities.pairKey(from, to.id);
        // 플레이어가 고른 기체가 있으면 그 견적을 앞에 세운다 — 화면이 보여주는 값과
        // 누를 때 빠져나가는 값이 같아야 한다.
        const chosen = usable.find((u) => u.plane.id === picked[`${from}|${to.id}`]) || usable[0];
        seen.add(key);
        out.push({
          from,
          to: to.id,
          dist,
          usable,
          plane: chosen.plane,
          freq: chosen.freq,
          needFrom: chosen.needFrom,
          needTo: chosen.needTo,
          cost: chosen.cost,
          demand: St.demandFor(s, Cities.get(from), to).total,
          score: Ai.attractiveness(s, meId, Cities.get(from), to) / (1 + chosen.cost / 60e6),
        });
      }
    }
    return out.sort((x, y) => y.score - x.score).slice(0, limit || 24);
  }

  function renderOpen(s, meId, choice) {
    const me = St.airline(s, meId);
    const idle = St.planesOf(s, meId).filter((p) => p.routeId === null && p.checkUntilTurn !== s.turn);
    if (!idle.length) {
      return `<section class="cards"><div class="card">
        <p class="muted">유휴 기재가 없다. <b>기재</b> 탭에서 발주하거나, 노선에서 빼야 새 구간을 열 수 있다.</p>
      </div></section>`;
    }
    const cands = openCandidates(s, meId, undefined, choice);
    if (!cands.length) {
      return `<section class="cards"><div class="card">
        <p class="muted">지금 기재로 열 수 있는 새 구간이 없다. 더 멀리 나는 기체가 필요하다.</p>
      </div></section>`;
    }
    return `<section class="cards">
      <div class="card">
        <h3>취항 후보</h3>
        <p class="muted">수요가 크고 경쟁이 옅을수록 위로 온다. 현지 항공사가 억센 구간은 그만큼 깎아 봤다.
          비용에는 <b>목적지 슬롯 매입비</b>가 들어 있다 — 이걸 빼고 보면 열자마자 슬롯이 모자란다.</p>
        <div class="cands">
        ${cands
          .map(
            (c) => `<div class="cand-box">
              <button class="cand" data-action="open-route"
                data-from="${esc(c.from)}" data-to="${esc(c.to)}"
                ${me.cash < c.cost ? 'disabled' : ''}>
                <b>${esc(Cities.name(c.from))} – ${esc(Cities.name(c.to))}</b>
                <span>${num(c.dist)}km · 분기 수요 ${num(c.demand)}</span>
                <span>로컬 ${esc(root.AirlinerSkyMarket.localStrengthLabel(Cities.get(c.from), Cities.get(c.to)))}
                  · ${esc(s.types[c.plane.typeId].name)} 주 ${c.freq}왕복</span>
                <span class="${me.cash < c.cost ? 'bad' : 'accent'}">${money(c.cost)}${
                  c.needFrom + c.needTo ? ` (슬롯 ${c.needFrom + c.needTo}자리 포함)` : ''
                }</span>
              </button>
              ${
                c.usable.length > 1
                  ? `<select data-action="pick-plane" data-from="${esc(c.from)}" data-to="${esc(c.to)}">
                      ${c.usable
                        .map(
                          (u) => `<option value="${u.plane.id}"${u.plane.id === c.plane.id ? ' selected' : ''}>
                            ${esc(s.types[u.plane.typeId].name)} · ${s.types[u.plane.typeId].seats}석 · 주 ${u.freq}왕복 · ${money(u.cost)}</option>`,
                        )
                        .join('')}
                    </select>`
                  : `<span class="muted cand-plane">${esc(s.types[c.plane.typeId].name)} · ${s.types[c.plane.typeId].seats}석</span>`
              }
            </div>`,
          )
          .join('')}
        </div>
      </div>
    </section>`;
  }

  // ─────────────────────────────── 지도 ───────────────────────────────

  /**
   * 노선망 지도 — 라이브러리 없이 SVG 문자열로 만든다(`js/charts.js` 와 같은 규칙).
   *
   * 도시 이름은 **viewBox 밖 HTML 이 아니라** 안에 둔다. 여기서는 글자가 지도와 함께
   * 줄어드는 편이 맞다 — 라벨만 원래 크기로 남으면 도시가 촘촘한 유럽이 통째로 뭉갠다.
   * 대신 큰 공항만 이름을 단다.
   *
   * 좁은 화면에서는 지도를 폭에 맞추지 않고 **가로로 흐르게** 둔다. 420px 에 세계를
   * 우겨 넣으면 유럽이 점 하나가 되어 아무것도 못 읽는다 (본문은 여전히 안 넘친다 —
   * 흐르는 것은 이 컨테이너 안뿐이다).
   */
  function renderMap(s, meId) {
    const W = 1000;
    const H = 500;
    // 위도 60°N~45°S 만 쓴다. 극지방까지 그리면 아무 도시도 없는 띠가 위아래로 남아
    // 정작 도시가 몰린 띠가 얇아진다 (45개 도시가 다 이 안에 있다).
    const LAT_TOP = 60;
    const LAT_BOTTOM = -45;
    const xy = (c) => ({
      x: (Cities.project(c.lat, c.lon).x) * W,
      y: ((LAT_TOP - c.lat) / (LAT_TOP - LAT_BOTTOM)) * H,
    });
    const mine = St.routesOf(s, meId).filter((r) => r.active);
    const others = s.routes.filter((r) => r.active && r.airlineId !== meId);
    const seg = (cls, x1, y1, x2, y2) =>
      `<line class="${cls}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" />`;

    /**
     * 노선 한 줄.
     *
     * 날짜변경선을 넘는 구간(상하이–LA, 오클랜드–LA…)은 그냥 이으면 지도를 통째로
     * 되돌아 긋는다. 그렇다고 안 그리면 **개수에는 세면서 화면에는 없는** 노선이 된다 —
     * 태평양 노선망이 통째로 보이지 않는데 "전체 305개"라고 적히는 식이다. 지도 양끝에서
     * 잘라 두 토막으로 그린다.
     */
    const line = (r, cls) => {
      const a = xy(Cities.get(r.from));
      const b = xy(Cities.get(r.to));
      const dx = b.x - a.x;
      if (Math.abs(dx) <= W / 2) return seg(cls, a.x, a.y, b.x, b.y);
      // 짧은 쪽으로 돌아간다 — 넘어가는 방향이 반대다.
      const wrapped = dx > 0 ? dx - W : dx + W;
      const edge = wrapped < 0 ? 0 : W;
      const t = (edge - a.x) / wrapped;
      const yc = a.y + (b.y - a.y) * t;
      return seg(cls, a.x, a.y, edge, yc) + seg(cls, W - edge, yc, b.x, b.y);
    };
    const dots = Cities.CITIES.map((c) => {
      const p = xy(c);
      const big = c.standing + c.tour >= 105;
      return `<circle class="map-city" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${big ? 3.4 : 2}" />
        ${big ? `<text class="map-label" x="${(p.x + 5).toFixed(1)}" y="${(p.y + 3.5).toFixed(1)}">${esc(c.name)}</text>` : ''}`;
    }).join('');

    return `<section class="cards"><div class="card full">
      <h3>노선망</h3>
      <div class="map-wrap">
        <svg class="map" data-home="${esc(St.airline(s, meId).home)}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="세계 노선망">
          <g>${others.map((r) => line(r, 'map-rival')).join('')}</g>
          <g>${mine.map((r) => line(r, 'map-mine')).join('')}</g>
          <g>${dots}</g>
        </svg>
      </div>
      <p class="muted"><b class="map-key-mine">굵은 선</b>이 우리 노선, 옅은 선이 남의 노선이다.
        우리 ${mine.length}개 · 전체 ${mine.length + others.length}개.</p>
    </div></section>`;
  }

  // ─────────────────────────────── 기록 ───────────────────────────────

  function renderHistory(s, meId) {
    const me = St.airline(s, meId);
    if (!me.results.length) return '<section class="cards"><div class="card"><p class="muted">아직 기록이 없다.</p></div></section>';
    const C = Charts;
    const labels = me.results.map((r) => `${s.startYear + Math.floor(r.turn / 4)}.${(r.turn % 4) + 1}`);
    const asMoney = (v) => money(v);
    return `<section class="cards">
      ${chartCard(C, '분기 순익', me.results.map((r) => r.net), labels, asMoney)}
      ${chartCard(C, '현금', me.results.map((r) => r.cash), labels, asMoney)}
      ${chartCard(C, '분기 승객', me.results.map((r) => r.pax), labels, num)}
      <div class="card full"><h3>최근 분기</h3>
        <table class="tbl"><thead><tr><th>분기</th><th class="r">수입</th><th class="r">순익</th><th class="r">승객</th><th class="r">탑승률</th></tr></thead><tbody>
        ${me.results
          .slice(-12)
          .reverse()
          .map(
            (r) => `<tr><td>${s.startYear + Math.floor(r.turn / 4)}년 ${(r.turn % 4) + 1}분기</td>
              <td class="r">${money(r.revenue)}</td>
              <td class="r ${tone(r.net)}">${sign(r.net)}${money(r.net)}</td>
              <td class="r">${num(r.pax)}</td>
              <td class="r">${r.seats > 0 ? pct(r.pax / r.seats) : '—'}</td></tr>`,
          )
          .join('')}
        </tbody></table>
      </div>
    </section>`;
  }

  function chartCard(C, title, values, labels, format) {
    return `<div class="card"><h3>${esc(title)}</h3>
      <div class="chartbox">${C.line({
        height: 130,
        zero: true,
        format,
        labels,
        series: [{ name: title, values, cls: 'accent', fill: true }],
      })}</div></div>`;
  }

  root.AirlinerSkyPanels = {
    money,
    renderOverview,
    groupCard,
    groupFinalCard,
    finalCard,
    renderRoutes,
    renderFleet,
    renderOpen,
    renderMap,
    renderHistory,
    openCandidates,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
