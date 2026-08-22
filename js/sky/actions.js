/*
 * 항공사 계층의 명령 — 노선을 열고 닫고, 슬롯을 사고 반납하고, 기재를 발주하고 판다.
 *
 * 플레이어와 AI 가 **같은 문을 쓴다.** AI 전용 지름길을 두면 화면에서 막힌 수를 AI 만
 * 두게 되고, 밸런스를 재는 자동 플레이가 사람이 못 하는 판을 재게 된다.
 *
 * 모든 명령은 `{ ok, msg }` 를 돌려주고, 실패하면 상태를 건드리지 않는다. 실패 사유를
 * 문장으로 돌려주는 것은 화면에 그대로 띄우기 위해서다 — 왜 안 되는지 모르는 회색
 * 버튼이 가장 나쁘다.
 */
(function (root) {
  'use strict';

  const Cities = root.AirlinerCities;
  const Econ = root.AirlinerSkyEconomics;
  const St = root.AirlinerSkyState;
  const B = St.BALANCE;

  const FARE_MIN_MUL = 0.6;
  const FARE_MAX_MUL = 1.7;
  /** 슬롯이 마를수록 값이 가파르게 오른다 — 요지를 늦게 잡을수록 비싸다. */
  const SLOT_SCARCITY_EXP = 1.9;
  /** 노선 개설비 — 취항 준비·판촉·현지 조업 계약. */
  const ROUTE_SETUP_BASE = 200000;
  const ROUTE_SETUP_PER_KM = 40;
  /** 발주에서 인도까지 */
  const ORDER_QUARTERS = 2;
  /** 중고로 팔면 잔존가치의 이만큼만 받는다 */
  const RESALE_RATE = 0.85;

  const fail = (msg) => ({ ok: false, msg });
  const done = (msg) => ({ ok: true, msg });

  // ── 슬롯 ──

  /** 이 회사가 이 공항에서 실제로 쓰고 있는 슬롯 (주간 왕복 1회에 한 자리). */
  function usedSlots(s, airlineId, city) {
    return s.routes
      .filter((r) => r.airlineId === airlineId && r.active && (r.from === city || r.to === city))
      .reduce((x, r) => x + r.freq, 0);
  }

  const freeSlots = (s, airlineId, city) => St.slotsAt(St.airline(s, airlineId) || {}, city) - usedSlots(s, airlineId, city);

  /** 아직 아무도 안 가져간 슬롯. */
  function unsoldSlots(s, city) {
    const taken = s.airlines.filter((a) => a.alive).reduce((x, a) => x + St.slotsAt(a, city), 0);
    return Math.max(0, St.totalSlots(s, city) - taken);
  }

  /**
   * 슬롯 한 자리 값. 마를수록 가파르게 오르고, 안방은 싸다.
   *
   * `taken` 은 "이번에 이미 집은 자리 수" — 여러 자리를 한꺼번에 살 때 값이 자리마다
   * 오르는 것을 **상태를 건드리지 않고** 재기 위한 것이다.
   */
  function slotPrice(s, airlineId, city, taken) {
    const c = Cities.get(city);
    const total = St.totalSlots(s, city);
    const free = Math.max(0, unsoldSlots(s, city) - (taken || 0));
    const scarcity = Math.min(1, Math.max(0, (total - free + 1) / total));
    const a = St.airline(s, airlineId);
    const home = a && a.home === city ? B.SLOT_HOME_DISCOUNT : 1;
    const size = (c.standing + c.tour) / 100;
    return B.SLOT_BASE_PRICE * size * (1 + Math.pow(scarcity, SLOT_SCARCITY_EXP) * 6) * c.fee * home * s.world.inflation * Econ.BALANCE.FARE_SCALE;
  }

  /**
   * n 자리를 살 때의 값. **한 자리마다 다시 매긴다** — 현재 단가에 개수를 곱하면
   * 실제보다 싸게 잡혀, 예산은 통과했는데 매입이 실패한다. 그때 반대편 슬롯은 이미
   * 사둔 뒤라 노선도 못 열고 슬롯만 놀린다.
   *
   * 값을 재는 것만으로 상태가 바뀌면 안 된다. 예전에는 슬롯 수를 실제로 올렸다 되돌렸는데,
   * 한 번도 안 가진 도시에 `0` 짜리 키가 남아 "슬롯을 가진 도시" 목록이 세계 전체로
   * 불어났다 — 취항 후보 화면이 이스탄불을 대한항공의 거점으로 내놨다.
   */
  function slotCost(s, airlineId, city, count) {
    if (count <= 0) return 0;
    let total = 0;
    for (let i = 0; i < count; i++) total += slotPrice(s, airlineId, city, i);
    return total;
  }

  function buySlots(s, airlineId, city, count) {
    const a = St.airline(s, airlineId);
    if (!a || !a.alive) return fail('없는 항공사입니다.');
    if (!Cities.get(city)) return fail('알 수 없는 공항입니다.');
    if (!Number.isInteger(count) || count < 1) return fail('한 자리 이상의 정수여야 합니다.');
    if (unsoldSlots(s, city) < count) return fail(`${Cities.name(city)}에 남은 슬롯이 ${unsoldSlots(s, city)}자리뿐입니다.`);
    const cost = slotCost(s, airlineId, city, count);
    if (a.cash < cost) return fail('슬롯 매입비가 부족합니다.');
    a.cash -= cost;
    a.slots[city] = St.slotsAt(a, city) + count;
    return done(`${Cities.name(city)} 슬롯 ${count}자리를 확보했습니다.`);
  }

  /** 반납은 값을 못 받는다 — 임차라 되팔 물건이 아니다. 임차료가 멎을 뿐이다. */
  function sellSlots(s, airlineId, city, count) {
    const a = St.airline(s, airlineId);
    if (!a || !a.alive) return fail('없는 항공사입니다.');
    const free = freeSlots(s, airlineId, city);
    if (!Number.isInteger(count) || count < 1) return fail('한 자리 이상의 정수여야 합니다.');
    if (free < count) return fail(`쓰지 않는 슬롯이 ${free}자리뿐입니다.`);
    a.slots[city] = St.slotsAt(a, city) - count;
    if (a.slots[city] <= 0) delete a.slots[city];
    return done(`${Cities.name(city)} 슬롯 ${count}자리를 반납했습니다.`);
  }

  // ── 노선 ──

  const routeSetupCost = (s, from, to) =>
    (ROUTE_SETUP_BASE + Cities.distance(from, to) * ROUTE_SETUP_PER_KM) * s.world.inflation * Econ.BALANCE.FARE_SCALE;

  function openRoute(s, airlineId, from, to, planeIds, freq, fareMul, serviceExtra) {
    const a = St.airline(s, airlineId);
    if (!a || !a.alive) return fail('없는 항공사입니다.');
    if (from === to) return fail('같은 도시로는 노선을 열 수 없습니다.');
    if (!Cities.get(from) || !Cities.get(to)) return fail('알 수 없는 공항입니다.');
    if (St.isClosed(s.cityState[from] || {}, s.turn) || St.isClosed(s.cityState[to] || {}, s.turn)) {
      return fail('공항이 폐쇄 중입니다.');
    }
    const key = Cities.pairKey(from, to);
    if (s.routes.some((r) => r.airlineId === airlineId && r.active && Cities.pairKey(r.from, r.to) === key)) {
      return fail('이미 같은 구간에 노선이 있습니다.');
    }
    if (!Number.isInteger(freq) || freq < 1) return fail('주간 편수는 1 이상의 정수여야 합니다.');
    // `clampFare(NaN)` 은 NaN 이다. 안 막으면 개설비를 받고 운임이 NaN 인 노선이 저장되고,
    // 다음 정산에서 점유율·수입·현금이 줄줄이 NaN 이 된다. `tuneRoute` 와 같은 문이다.
    if (fareMul !== undefined && !Number.isFinite(fareMul)) return fail('운임 배수가 올바르지 않습니다.');
    if (serviceExtra !== undefined && !Number.isFinite(serviceExtra)) return fail('서비스 등급이 올바르지 않습니다.');
    // 배열이 아니면 아래 `new Set(...)` 이 TypeError 를 던진다 — 명령 계층은 예외가
    // 아니라 `{ ok: false }` 를 돌려주기로 되어 있다.
    if (!Array.isArray(planeIds) || !planeIds.length) return fail('투입할 기재를 고르세요.');

    const dist = Cities.distance(from, to);
    // 같은 기체를 두 번 적으면 수송력이 그만큼 부풀어, 한 대로 주 60왕복짜리 노선을
    // 열고 슬롯을 82자리 잡을 수 있다. 실제로 그렇게 됐다.
    if (new Set(planeIds).size !== planeIds.length) return fail('같은 기재를 두 번 넣을 수 없습니다.');
    const planes = [];
    for (const id of planeIds) {
      const p = s.planes.find((x) => x.id === id);
      if (!p) return fail('보유하지 않은 기재입니다.');
      if (p.airlineId !== airlineId) return fail('다른 항공사의 기재입니다.');
      if (p.routeId !== null) return fail('이미 다른 노선에 배속된 기재가 있습니다.');
      const t = s.types[p.typeId];
      if (!Econ.canFly(t, dist)) return fail(`${t.name}의 항속거리(${t.range}km)로는 ${Math.round(dist)}km를 날 수 없습니다.`);
      planes.push(p);
    }
    const cap = Econ.capacity(planes, dist, (t) => s.types[t]);
    if (freq > cap.maxFreq) return fail(`기재 ${planes.length}대로는 주 ${cap.maxFreq}왕복이 한계입니다.`);
    if (freeSlots(s, airlineId, from) < freq) return fail(`${Cities.name(from)} 슬롯이 부족합니다.`);
    if (freeSlots(s, airlineId, to) < freq) return fail(`${Cities.name(to)} 슬롯이 부족합니다.`);

    const cost = routeSetupCost(s, from, to);
    if (a.cash < cost) return fail('개설 비용이 부족합니다.');

    const id = s.nextId++;
    a.cash -= cost;
    s.routes.push({
      id,
      airlineId,
      from,
      to,
      fareMul: clampFare(fareMul === undefined ? 1 : fareMul),
      freq,
      serviceExtra: Math.min(2, Math.max(0, Math.round(serviceExtra || 0))),
      active: true,
      last: null,
    });
    for (const p of planes) p.routeId = id;
    return done(`${Cities.name(from)}–${Cities.name(to)} 노선을 열었습니다.`);
  }

  function closeRoute(s, airlineId, routeId) {
    const r = s.routes.find((x) => x.id === routeId && x.airlineId === airlineId);
    if (!r) return fail('없는 노선입니다.');
    // 노선을 지우지 않고 닫는다 — 지우면 이번 분기 결산에서 그 노선의 실적이 통째로
    // 사라져, 접은 분기의 손익이 화면에서 증발한다.
    r.active = false;
    r.freq = 0;
    for (const p of St.assignedTo(s, routeId)) p.routeId = null;
    return done(`${Cities.name(r.from)}–${Cities.name(r.to)} 노선을 접었습니다.`);
  }

  const clampFare = (v) => Math.min(FARE_MAX_MUL, Math.max(FARE_MIN_MUL, v));

  /**
   * 운임·편수·서비스를 한꺼번에 조정한다.
   *
   * **전부 검사한 뒤에 하나라도 바꾼다.** 순서대로 적용하면 편수가 막혔을 때
   * `{ ok: false }` 를 돌려주면서 운임 변경은 남아, 화면은 "실패"라고 말하는데 값은
   * 이미 바뀌어 있다. 명령이 실패하면 상태는 손대지 않은 그대로여야 한다.
   */
  function tuneRoute(s, airlineId, routeId, opts) {
    const r = s.routes.find((x) => x.id === routeId && x.airlineId === airlineId);
    if (!r || !r.active) return fail('없는 노선입니다.');
    const o = opts || {};
    if (o.fareMul !== undefined && !Number.isFinite(o.fareMul)) return fail('운임 배수가 수가 아닙니다.');
    if (o.serviceExtra !== undefined && !Number.isFinite(o.serviceExtra)) return fail('서비스 등급이 수가 아닙니다.');
    if (o.freq !== undefined) {
      if (!Number.isInteger(o.freq) || o.freq < 1) return fail('주간 편수는 1 이상의 정수여야 합니다.');
      const dist = Cities.distance(r.from, r.to);
      // **배속 목록 전체로 잰다.** 이번 분기에 뜨는 기재로 재면 중정비로 한 대가 빠진
      // 분기에 주 10왕복짜리 시간표를 9로 내리는 것조차 막힌다 — 한계가 5로 잡히니
      // 9 > 5 로 거절이고, 화면의 −1 단추가 죽는다. 여기서 정하는 것은 **계속 가져갈
      // 시간표**이고, 이번 분기의 일시적 감편은 `effectiveFreq` 가 따로 처리한다.
      // `assignPlanes` 가 같은 이유로 같은 목록을 본다.
      const cap = Econ.capacity(St.assignedTo(s, r.id), dist, (t) => s.types[t]);
      if (o.freq > cap.maxFreq) return fail(`배속 기재로는 주 ${cap.maxFreq}왕복이 한계입니다.`);
      const extra = o.freq - r.freq;
      if (extra > 0 && (freeSlots(s, airlineId, r.from) < extra || freeSlots(s, airlineId, r.to) < extra)) {
        return fail('슬롯이 부족합니다.');
      }
    }
    if (o.fareMul !== undefined) r.fareMul = clampFare(o.fareMul);
    if (o.serviceExtra !== undefined) r.serviceExtra = Math.min(2, Math.max(0, Math.round(o.serviceExtra)));
    if (o.freq !== undefined) r.freq = o.freq;
    return done('노선을 조정했습니다.');
  }

  /** 노선의 기재를 통째로 다시 정한다. 빠진 기체는 유휴가 된다. */
  function assignPlanes(s, airlineId, routeId, planeIds) {
    const r = s.routes.find((x) => x.id === routeId && x.airlineId === airlineId);
    if (!r || !r.active) return fail('없는 노선입니다.');
    const dist = Cities.distance(r.from, r.to);
    if (!Array.isArray(planeIds)) return fail('투입할 기재를 고르세요.');
    if (new Set(planeIds).size !== planeIds.length) return fail('같은 기재를 두 번 넣을 수 없습니다.');
    const planes = [];
    for (const id of planeIds) {
      const p = s.planes.find((x) => x.id === id);
      if (!p || p.airlineId !== airlineId) return fail('보유하지 않은 기재입니다.');
      if (p.routeId !== null && p.routeId !== routeId) return fail('이미 다른 노선에 배속된 기재입니다.');
      if (!Econ.canFly(s.types[p.typeId], dist)) return fail(`${s.types[p.typeId].name}의 항속거리로는 이 구간을 못 납니다.`);
      planes.push(p);
    }
    if (!planes.length) return fail('한 대 이상 남겨야 합니다. 접으려면 노선을 닫으세요.');
    for (const p of St.assignedTo(s, routeId)) p.routeId = null;
    for (const p of planes) p.routeId = routeId;
    // 줄어든 기재로 감당 못 하는 편수는 자동으로 내린다 — 안 그러면 시장이 걷어가는
    // 좌석과 화면에 뜬 편수가 어긋난다.
    //
    // **배속 목록 전체로 잰다.** 지금 뜨는 기재로 재면, 중정비로 한 대가 빠진 분기에
    // 예비기를 붙이는 순간 편수가 그 분기 수송력까지 영구히 깎인다(49 → 45, 입고기가
    // 돌아와도 45). 이번 분기의 일시적 손실은 `effectiveFreq` 가 이미 처리한다 —
    // 여기서 정하는 것은 **계속 가져갈 시간표**다.
    const cap = Econ.capacity(St.assignedTo(s, routeId), dist, (t) => s.types[t]);
    if (r.freq > cap.maxFreq) r.freq = Math.max(1, cap.maxFreq);
    return done('기재를 다시 배속했습니다.');
  }

  // ── 기재 ──

  /** 발주. 두 분기 뒤에 들어온다 — 값은 지금 치른다. */
  function buyAircraft(s, airlineId, typeId, count) {
    const a = St.airline(s, airlineId);
    if (!a || !a.alive) return fail('없는 항공사입니다.');
    const t = s.types[typeId];
    if (!t) return fail('알 수 없는 기종입니다.');
    // **통합 판에서는 자사 기종을 이 통로로 못 산다.** 제조사 프로그램이 기종표에
    // 들어오는데 여기서 받아 주면, 제조사 수주 장부에도 생산비에도 잡히지 않은 기체가
    // 두 분기 뒤 그냥 생긴다 — 플레이어도 경쟁 항공사도 통합 경제 바깥에서 그 기체를
    // 얻는다. 자체 발주는 `AirlinerSkyGroup.placeOrder` 를, 경쟁사는 제조사 계층의
    // 공고·입찰을 지나야 한다.
    //
    // 통합 판이 아니면 막지 않는다. 항공사 단독 판에도 카탈로그로 프로그램을 깔 수
    // 있고(`newGame(seed, { programs })`), 그때는 제조사 장부라는 것이 아예 없다.
    if (t.own && s.groupAirlineId) {
      return fail(`${t.name}은(는) 자사 기종입니다 — 개요의 모회사 카드에서 자체 발주하세요.`);
    }
    const year = St.yearFracOf(s);
    if (t.eis > year) return fail(`${t.name}은(는) ${Math.floor(t.eis)}년 ${Math.floor((t.eis % 1) * 4) + 1}분기부터 인도됩니다.`);
    if (t.end && t.end <= year) return fail(`${t.name}은(는) 단종됐습니다.`);
    // 소수 대수를 받으면 값은 1.1대 어치만 받고 인도 루프는 두 대를 만든다.
    if (!Number.isInteger(count) || count < 1) return fail('한 대 이상의 정수여야 합니다.');
    const cost = t.price * count;
    if (a.cash < cost) return fail('발주 대금이 부족합니다.');
    a.cash -= cost;
    if (!s.orders) s.orders = [];
    // **치른 값을 새겨 둔다.** 자기자본이 인도 전 선급금을 잡는데, 그걸 지금 카탈로그
    // 값으로 다시 재면 인도 대기 중에 정가가 오른 것만으로 자본이 불어난다
    // (90M 짜리가 120M 이 되면 대당 30M 이 공짜로 생겼다).
    s.orders.push({ id: s.nextId++, airlineId, typeId, count, paid: cost, deliverTurn: s.turn + ORDER_QUARTERS });
    return done(`${t.name} ${count}대를 발주했습니다.`);
  }

  function sellAircraft(s, airlineId, planeId) {
    const a = St.airline(s, airlineId);
    const p = s.planes.find((x) => x.id === planeId && x.airlineId === airlineId);
    if (!a || !p) return fail('보유하지 않은 기재입니다.');
    if (p.routeId !== null) return fail('노선에 배속된 기재는 팔 수 없습니다.');
    if (p.checkUntilTurn === s.turn) return fail('중정비 중인 기재는 팔 수 없습니다.');
    a.cash += St.residual(s.types[p.typeId], p.ageQuarters, p.paid) * RESALE_RATE;
    s.planes = s.planes.filter((x) => x.id !== planeId);
    return done(`${s.types[p.typeId].name} 한 대를 처분했습니다.`);
  }

  // ── 금융 ──

  function borrow(s, airlineId, amount) {
    const a = St.airline(s, airlineId);
    if (!a || !a.alive) return fail('없는 항공사입니다.');
    // NaN 은 어떤 비교에도 걸리지 않아 그대로 통과한다 — 부채와 현금이 통째로 NaN 이
    // 되고, 그 뒤 자본·결산·화면이 전부 따라 망가진다.
    if (!Number.isFinite(amount) || amount <= 0) return fail('금액이 올바르지 않습니다.');
    const room = St.debtCap(s, a) - a.debt;
    if (amount > room) return fail(`차입 한도가 ${Math.round(Math.max(0, room) / 1e6)}M 남았습니다.`);
    a.debt += amount;
    a.cash += amount;
    return done(`${Math.round(amount / 1e6)}M을 차입했습니다.`);
  }

  function repay(s, airlineId, amount) {
    const a = St.airline(s, airlineId);
    if (!a || !a.alive) return fail('없는 항공사입니다.');
    if (!Number.isFinite(amount) || amount <= 0) return fail('금액이 올바르지 않습니다.');
    const pay = Math.min(amount, a.debt, a.cash);
    if (pay <= 0) return fail('갚을 수 있는 금액이 없습니다.');
    a.debt -= pay;
    a.cash -= pay;
    return done(`${Math.round(pay / 1e6)}M을 상환했습니다.`);
  }

  root.AirlinerSkyActions = {
    FARE_MIN_MUL,
    FARE_MAX_MUL,
    ORDER_QUARTERS,
    RESALE_RATE,
    usedSlots,
    freeSlots,
    unsoldSlots,
    slotPrice,
    slotCost,
    routeSetupCost,
    buySlots,
    sellSlots,
    openRoute,
    closeRoute,
    tuneRoute,
    assignPlanes,
    buyAircraft,
    sellAircraft,
    borrow,
    repay,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
