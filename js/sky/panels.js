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
    const rank = ranked.findIndex((x) => x.a.id === meId) + 1;

    return `
    <section class="cards">
      <div class="card">
        <h3>${esc(me.name)}</h3>
        <p class="muted">${esc(Cities.name(me.home))} 기반 · ${St.living(s).length}사 중 <b>${rank}위</b></p>
        <div class="sky-stats">
          ${stat('자기자본', money(St.equity(s, me)))}
          ${stat('현금', money(me.cash))}
          ${stat('부채', money(me.debt))}
          ${stat('노선', `${routes.length}개`)}
          ${stat('기재', `${planes.length}대`, idle ? `유휴 ${idle}` : '')}
          ${stat('정비 입고', `${inCheck}대`)}
        </div>
      </div>
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
    const step = Math.max(10e6, Math.round(room / 4 / 1e6) * 1e6);
    return `<div class="card full">
      <h3>자금</h3>
      <div class="sky-stats">
        ${stat('현금', money(a.cash))}
        ${stat('부채', money(a.debt))}
        ${stat('차입 여력', money(room))}
        ${stat('이자율', `연 ${(St.interestRate(s, a) * 100).toFixed(1)}%`)}
      </div>
      <div class="row">
        <button class="ghost" data-action="borrow" data-amount="${step}" ${room < step ? 'disabled' : ''}>
          ${money(step)} 차입</button>
        <button class="ghost" data-action="repay" data-amount="${step}" ${a.debt <= 0 || a.cash <= 0 ? 'disabled' : ''}>
          ${money(Math.min(step, a.debt))} 상환</button>
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
              .map((o) => `<li>${esc(s.types[o.typeId].name)} ${o.count}대 — ${o.deliverTurn - s.turn}분기 뒤</li>`)
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
            <b>${esc(t.name)}</b> <span class="muted">${(p.ageQuarters / 4).toFixed(1)}년 · 잔존 ${money(St.residual(t, p.ageQuarters))}</span>
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
  function openCandidates(s, meId, limit) {
    const me = St.airline(s, meId);
    const idle = St.planesOf(s, meId).filter((p) => p.routeId === null && p.checkUntilTurn !== s.turn);
    const served = new Set(St.routesOf(s, meId).filter((r) => r.active).map((r) => Cities.pairKey(r.from, r.to)));
    const out = [];
    // 양쪽 다 슬롯을 가진 구간은 두 번 걸린다 — 목록에 같은 노선이 두 줄로 뜬다.
    const seen = new Set();
    for (const from of Object.keys(me.slots).filter((c) => me.slots[c] > 0).sort()) {
      for (const to of Cities.CITIES) {
        if (to.id === from || served.has(Cities.pairKey(from, to.id))) continue;
        if (seen.has(Cities.pairKey(from, to.id))) continue;
        const dist = Cities.distance(from, to.id);
        const plane = idle
          .filter((p) => Econ.canFly(s.types[p.typeId], dist))
          .sort((x, y) => s.types[y.typeId].seats - s.types[x.typeId].seats)[0];
        if (!plane) continue;
        const cap = Econ.capacity([plane], dist, (t) => s.types[t]);
        if (cap.maxFreq < 1) continue;
        const freq = Math.min(cap.maxFreq, 7);
        const needFrom = Math.max(0, freq - A.freeSlots(s, meId, from));
        const needTo = Math.max(0, freq - A.freeSlots(s, meId, to.id));
        if (needFrom > A.unsoldSlots(s, from) || needTo > A.unsoldSlots(s, to.id)) continue;
        const cost =
          A.slotCost(s, meId, from, needFrom) + A.slotCost(s, meId, to.id, needTo) + A.routeSetupCost(s, from, to.id);
        seen.add(Cities.pairKey(from, to.id));
        out.push({
          from,
          to: to.id,
          dist,
          plane,
          freq,
          needFrom,
          needTo,
          cost,
          demand: St.demandFor(s, Cities.get(from), to).total,
          score: Ai.attractiveness(s, meId, Cities.get(from), to) / (1 + cost / 60e6),
        });
      }
    }
    return out.sort((x, y) => y.score - x.score).slice(0, limit || 24);
  }

  function renderOpen(s, meId) {
    const me = St.airline(s, meId);
    const idle = St.planesOf(s, meId).filter((p) => p.routeId === null && p.checkUntilTurn !== s.turn);
    if (!idle.length) {
      return `<section class="cards"><div class="card">
        <p class="muted">유휴 기재가 없다. <b>기재</b> 탭에서 발주하거나, 노선에서 빼야 새 구간을 열 수 있다.</p>
      </div></section>`;
    }
    const cands = openCandidates(s, meId);
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
            (c) => `<button class="cand" data-action="open-route"
                data-from="${esc(c.from)}" data-to="${esc(c.to)}"
                ${me.cash < c.cost ? 'disabled' : ''}>
              <b>${esc(Cities.name(c.from))} – ${esc(Cities.name(c.to))}</b>
              <span>${num(c.dist)}km · 분기 수요 ${num(c.demand)}</span>
              <span>로컬 ${esc(root.AirlinerSkyMarket.localStrengthLabel(Cities.get(c.from), Cities.get(c.to)))}
                · ${esc(s.types[c.plane.typeId].name)} 주 ${c.freq}왕복</span>
              <span class="${me.cash < c.cost ? 'bad' : 'accent'}">${money(c.cost)}${
                c.needFrom + c.needTo ? ` (슬롯 ${c.needFrom + c.needTo}자리 포함)` : ''
              }</span>
            </button>`,
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
    const line = (r, cls) => {
      const a = xy(Cities.get(r.from));
      const b = xy(Cities.get(r.to));
      // 태평양을 가로지르는 선이 지도를 통째로 되돌아 긋는 것을 막는다.
      if (Math.abs(a.x - b.x) > W / 2) return '';
      return `<line class="${cls}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" />`;
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
    renderRoutes,
    renderFleet,
    renderOpen,
    renderMap,
    renderHistory,
    openCandidates,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
