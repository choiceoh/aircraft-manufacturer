/*
 * 통합 모드 — 제조사와 자체 항공사를 잇는 자리.
 *
 * 두 계층은 서로를 모른다. 제조사 엔진은 노선도 슬롯도 모르고, 항공사 계층은 생산
 * 대기열도 인증도 모른다. 그 사이를 잇는 규칙만 여기 모은다 — 어느 쪽 파일에 넣어도
 * 그쪽이 상대를 알게 되기 때문이다.
 *
 * 잇는 것은 넷이다.
 *
 *   세계     유가·경기는 제조사 게임이 굴린다. 항공사가 따로 흔들면 같은 분기에
 *            제조사는 호황을, 항공사는 불황을 겪는 판이 된다.
 *   자체 발주  계열 항공사는 공고를 내지 않는다. 대신 **줄은 똑같이 선다** —
 *            생산 대기열에서 남의 주문을 제치지 않는다.
 *   불신     내 항공사와 노선에서 겨루는 항공사는 나를 경쟁자로 본다. 이것이
 *            자체 항공사를 갖는 값이다.
 *   성적     합산 자기자본으로 잰다. 합산이라 계열 간 이전가격은 성적을 못 바꾼다 —
 *            한 주머니에서 다른 주머니로 옮길 뿐이다.
 *
 * **돈의 단위가 다르다.** 제조사 엔진은 백만 달러 단위(`cash: 9500` = 95억),
 * 항공사 계층은 달러 단위다. 이 파일이 두 계층 사이에서 돈을 옮길 때마다 `MUSD` 를
 * 지난다 — 한 군데서만 환산해야 어느 쪽이 어느 단위인지 헷갈리지 않는다.
 */
(function (root) {
  'use strict';

  const E = root.AirlinerEngine;
  const St = root.AirlinerSkyState;
  const Cities = root.AirlinerCities;

  /** 제조사 장부의 1 = 항공사 장부의 100만. */
  const MUSD = 1e6;

  /**
   * 노선이 겹치는 항공사가 분기마다 잃는 신뢰.
   *
   * 한 노선에 하나씩이다. 노선 수로 재면 허브 하나에 몰아 넣은 판과 대륙을 잇는 판이
   * 같은 값을 치르는데, 실제로 남의 안방을 밟는 쪽은 뒤엣것이다.
   */
  const RIVALRY_PER_ROUTE = 0.45;
  /** 한 분기에 한 회사가 잃을 수 있는 신뢰의 한계. 없으면 대형 항공사 관계가 몇 해 만에 바닥난다. */
  const RIVALRY_MAX_PER_QUARTER = 3;

  // ── 세계 ──────────────────────────────────────────────────────────

  /** 제조사가 굴리는 유가·경기를 항공사 계층에 옮긴다. 분기마다 부른다. */
  function syncWorld(mfg, sky) {
    if (!mfg || !sky) return;
    St.syncWorld(sky, mfg);
  }

  // ── 자체 발주 ──────────────────────────────────────────────────────

  /** 자체 항공사가 지금 발주할 수 있는 자사 프로그램. */
  function orderableProgram(mfg, programId) {
    if (!mfg) return null;
    return (mfg.programs || []).find((p) => p.id === programId && p.phase === 'production') || null;
  }

  function orderablePrograms(mfg) {
    return (mfg.programs || []).filter((p) => p.phase === 'production');
  }

  /**
   * 자체 항공사가 자사 기체를 발주한다.
   *
   * **양쪽 장부가 같은 값을 반대로 적는다.** 제조사가 착수금을 받고, 항공사가 같은
   * 착수금을 낸다. 합산하면 0 — 실제로 나가는 것은 제조사 쪽 생산비뿐이다. 여기서
   * 값을 깎아도 합산 성적은 그대로라, 이전가격으로 성적을 만들 길은 없다.
   *
   * 실패하면 **어느 쪽 장부도 건드리지 않는다.** 제조사에 먼저 올리고 항공사에서
   * 실패하면 아무도 사지 않은 주문이 생산 대기열을 차지한다.
   */
  function placeOrder(mfg, sky, airlineId, programId, qty) {
    const a = St.airline(sky, airlineId);
    if (!a || !a.alive) return { ok: false, msg: '없는 항공사입니다.' };
    const p = orderableProgram(mfg, programId);
    if (!p) return { ok: false, msg: '양산 중인 자사 기종이 아닙니다.' };
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, msg: '대수는 1 이상의 정수여야 합니다.' };

    // 제조사가 매길 값을 **제조사에게 물어서** 항공사가 낼 수 있는지 먼저 본다.
    // 여기서 비율을 따로 알고 있으면 엔진 상수를 바꾼 날 견적과 청구액이 갈린다.
    const quote = E.inHouseQuote(mfg, { programId, qty });
    if (!quote || !quote.orderable) return { ok: false, msg: '양산 중인 자사 기종이 아닙니다.' };
    if (a.cash < quote.deposit * MUSD) {
      return { ok: false, msg: `착수금 ${Math.round(quote.deposit)}M 이 모자랍니다.` };
    }

    const r = E.placeInHouseOrder(mfg, { airlineId, programId, qty });
    if (!r.ok) return { ok: false, msg: r.error };

    a.cash -= r.deposit * MUSD;
    // 발주 장부는 첫 발주에서 만들어진다(`Actions.buyAircraft` 와 같은 규칙).
    if (!sky.orders) sky.orders = [];
    // 인도 전까지는 선급금으로 자기자본에 남는다 — 항공사 계층의 발주와 같은 대우다.
    // `external` 은 "인도 시점을 제조사가 정한다"는 표식이라, 항공사 타이머가 건드리지 않는다.
    sky.orders.push({
      id: sky.nextId++,
      airlineId,
      typeId: programId,
      count: qty,
      paid: r.deposit * MUSD,
      external: true,
      deliverTurn: null,
    });
    return { ok: true, msg: `${p.name} ${qty}기를 자체 발주했습니다.`, deposit: r.deposit * MUSD };
  }

  /**
   * 제조사가 이번 분기에 인도한 자체 발주분을 항공사 기단에 세운다.
   *
   * 항공사는 여기서 잔금을 낸다 — 착수금과 합해 정가다. 제조사 쪽 금융 조건·로열티·
   * 관세는 제조사의 사정이라 계열 항공사가 대신 물지 않는다.
   */
  function receiveDeliveries(mfg, sky, report, airlineId) {
    const list = (report && report.inHouse) || [];
    const got = [];
    for (const d of list) {
      if (d.airlineId !== airlineId) continue;
      const a = St.airline(sky, airlineId);
      if (!a || !a.alive) continue;
      a.cash -= d.balance * MUSD;
      St.receiveAircraft(sky, airlineId, d.programId, d.qty, d.unitPrice * MUSD);
      consumeOrder(sky, airlineId, d.programId, d.qty);
      got.push(d);
    }
    return got;
  }

  /**
   * 인도된 만큼 선급금 기록을 덜어낸다.
   *
   * 안 덜면 인도된 기체가 기단과 선급금 양쪽에 잡혀 자기자본이 두 번 세어진다.
   * 한 발주가 나눠 인도될 수 있으므로(생산 대기열이 재고만큼만 내보낸다) 대수를 깎는다.
   */
  function consumeOrder(sky, airlineId, typeId, qty) {
    if (!sky.orders) return;
    let left = qty;
    for (const o of sky.orders) {
      if (left <= 0) break;
      if (!o.external || o.airlineId !== airlineId || o.typeId !== typeId) continue;
      const take = Math.min(left, o.count);
      const unit = o.count > 0 ? o.paid / o.count : 0;
      o.count -= take;
      o.paid -= unit * take;
      left -= take;
    }
    sky.orders = sky.orders.filter((o) => !o.external || o.count > 0);
  }

  // ── 불신 ──────────────────────────────────────────────────────────

  /**
   * 내 항공사와 노선에서 겨루는 항공사가 나를 경쟁자로 본다.
   *
   * 자체 항공사를 갖는 값이다. 기체를 파는 상대가 곧 노선에서 싸우는 상대라, 노선망을
   * 넓힐수록 제조사의 영업이 좁아진다 — 1934년 항공우편법으로 해체된 United Aircraft
   * & Transport 가 실제로 걸었던 길이다.
   *
   * 겹치는 **노선 수**로 잰다. 회사 수로 재면 남의 안방에 한 편 넣은 것과 노선망을
   * 통째로 겹쳐 놓은 것이 같은 값이 된다.
   */
  function applyRivalry(mfg, sky, airlineId) {
    if (!mfg || !sky || !mfg.relations) return [];
    const mine = St.routesOf(sky, airlineId).filter((r) => r.active);
    if (!mine.length) return [];
    const mineKeys = new Set(mine.map((r) => Cities.pairKey(r.from, r.to)));

    const hit = [];
    for (const a of sky.airlines) {
      if (a.id === airlineId || !a.alive) continue;
      if (mfg.relations[a.id] === undefined) continue;
      let overlap = 0;
      for (const r of St.routesOf(sky, a.id)) {
        if (r.active && mineKeys.has(Cities.pairKey(r.from, r.to))) overlap += 1;
      }
      if (!overlap) continue;
      const drop = Math.min(RIVALRY_MAX_PER_QUARTER, overlap * RIVALRY_PER_ROUTE);
      mfg.relations[a.id] = Math.max(0, mfg.relations[a.id] - drop);
      hit.push({ airlineId: a.id, overlap, drop });
    }
    return hit;
  }

  // ── 성적 ──────────────────────────────────────────────────────────

  /**
   * 합산 성적.
   *
   * **계열 간 선급금은 상계한다.** 자체 발주의 착수금은 항공사 장부에서 선급금(자산)이
   * 되고 제조사 장부에서는 현금이 된다 — 같은 돈이 두 번 세어진다. 상계하지 않으면
   * 자체 발주를 넣었다 뺐다 하는 것만으로 그룹 자기자본이 불어난다(3기 발주에 38M).
   *
   * 상계하고 나면 계열 간 거래는 합계를 움직이지 못한다. 이전가격을 어떻게 매기든
   * 성적이 그대로여야 한다는 것이 이 모드의 규칙이고, 그 규칙이 사는 자리가 여기다.
   *
   * 제조사 쪽은 재고·라인까지 세는 엔진의 순자산을 그대로 쓴다 — 현금에서 빚만 뺀
   * 값으로 재면 라인을 지은 분기마다 그룹이 가난해진 것처럼 보인다.
   */
  function combinedEquity(mfg, sky, airlineId) {
    const a = sky && St.airline(sky, airlineId);
    const air = a && a.alive ? St.equity(sky, a) : 0;
    const maker = mfg ? E.netWorth(mfg) * MUSD : 0;
    const internal = internalPrepaid(sky, airlineId);
    return { maker, airline: air, internal, total: maker + air - internal };
  }

  /** 아직 인도되지 않은 자체 발주의 선급금 — 그룹 안에서만 오간 돈이다. */
  function internalPrepaid(sky, airlineId) {
    if (!sky || !sky.orders) return 0;
    return sky.orders
      .filter((o) => o.external && o.airlineId === airlineId)
      .reduce((x, o) => x + (o.paid || 0), 0);
  }

  // ── 분기 글루 ──────────────────────────────────────────────────────

  /**
   * 제조사 정산과 항공사 정산 **사이**에 도는 일.
   *
   * 인도가 먼저다 — 이번 분기에 받은 기체가 이번 분기 노선에 설 수 있어야, 화면에
   * 뜬 기재와 시장이 걷어가는 좌석이 같은 목록이 된다. 세계는 그다음이다.
   */
  function betweenTurns(mfg, sky, airlineId, report) {
    if (!mfg || !sky || !airlineId) return [];
    const got = receiveDeliveries(mfg, sky, report, airlineId);
    syncWorld(mfg, sky);
    return got;
  }

  /**
   * 두 계층이 다 정산된 **뒤**에 도는 일.
   *
   * 불신은 이번 분기에 실제로 굴린 노선망으로 잰다 — 정산 전에 재면 이번 분기에 접은
   * 노선까지 값을 치른다.
   */
  function afterTurns(mfg, sky, airlineId) {
    if (!mfg || !sky || !airlineId) return [];
    return applyRivalry(mfg, sky, airlineId);
  }

  root.AirlinerSkyGroup = {
    MUSD,
    quote: (mfg, programId, qty) => E.inHouseQuote(mfg, { programId, qty }),
    RIVALRY_PER_ROUTE,
    RIVALRY_MAX_PER_QUARTER,
    syncWorld,
    orderablePrograms,
    orderableProgram,
    placeOrder,
    receiveDeliveries,
    consumeOrder,
    applyRivalry,
    combinedEquity,
    internalPrepaid,
    betweenTurns,
    afterTurns,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
