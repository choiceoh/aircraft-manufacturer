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

  /** 슬롯 한 자리 값. 마를수록 가파르게 오르고, 안방은 싸다. */
  function slotPrice(s, airlineId, city) {
    const c = Cities.get(city);
    const total = St.totalSlots(s, city);
    const free = unsoldSlots(s, city);
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
   */
  function slotCost(s, airlineId, city, count) {
    const a = St.airline(s, airlineId);
    if (!a || count <= 0) return 0;
    const before = St.slotsAt(a, city);
    let total = 0;
    for (let i = 0; i < count; i++) {
      a.slots[city] = before + i;
      total += slotPrice(s, airlineId, city);
    }
    a.slots[city] = before;
    return total;
  }

  function buySlots(s, airlineId, city, count) {
    const a = St.airline(s, airlineId);
    if (!a || !a.alive) return fail('없는 항공사입니다.');
    if (!Cities.get(city)) return fail('알 수 없는 공항입니다.');
    if (count < 1) return fail('한 자리 이상이어야 합니다.');
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
    if (count < 1) return fail('한 자리 이상이어야 합니다.');
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
    if (freq < 1) return fail('주간 편수는 1 이상이어야 합니다.');
    if (!planeIds || !planeIds.length) return fail('투입할 기재를 고르세요.');

    const dist = Cities.distance(from, to);
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
      serviceExtra: Math.min(2, Math.max(0, serviceExtra || 0)),
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

  function tuneRoute(s, airlineId, routeId, opts) {
    const r = s.routes.find((x) => x.id === routeId && x.airlineId === airlineId);
    if (!r || !r.active) return fail('없는 노선입니다.');
    const o = opts || {};
    if (o.fareMul !== undefined) r.fareMul = clampFare(o.fareMul);
    if (o.serviceExtra !== undefined) r.serviceExtra = Math.min(2, Math.max(0, o.serviceExtra));
    if (o.freq !== undefined) {
      if (o.freq < 1) return fail('주간 편수는 1 이상이어야 합니다.');
      const dist = Cities.distance(r.from, r.to);
      const cap = Econ.capacity(St.flyingOn(s, r.id), dist, (t) => s.types[t]);
      if (o.freq > cap.maxFreq) return fail(`지금 기재로는 주 ${cap.maxFreq}왕복이 한계입니다.`);
      const extra = o.freq - r.freq;
      if (extra > 0 && (freeSlots(s, airlineId, r.from) < extra || freeSlots(s, airlineId, r.to) < extra)) {
        return fail('슬롯이 부족합니다.');
      }
      r.freq = o.freq;
    }
    return done('노선을 조정했습니다.');
  }

  /** 노선의 기재를 통째로 다시 정한다. 빠진 기체는 유휴가 된다. */
  function assignPlanes(s, airlineId, routeId, planeIds) {
    const r = s.routes.find((x) => x.id === routeId && x.airlineId === airlineId);
    if (!r || !r.active) return fail('없는 노선입니다.');
    const dist = Cities.distance(r.from, r.to);
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
    const cap = Econ.capacity(St.flyingOn(s, routeId), dist, (t) => s.types[t]);
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
    const year = St.yearFracOf(s);
    if (t.eis > year) return fail(`${t.name}은(는) ${Math.floor(t.eis)}년 ${Math.floor((t.eis % 1) * 4) + 1}분기부터 인도됩니다.`);
    if (t.end && t.end <= year) return fail(`${t.name}은(는) 단종됐습니다.`);
    if (count < 1) return fail('한 대 이상이어야 합니다.');
    const cost = t.price * count;
    if (a.cash < cost) return fail('발주 대금이 부족합니다.');
    a.cash -= cost;
    if (!s.orders) s.orders = [];
    s.orders.push({ id: s.nextId++, airlineId, typeId, count, deliverTurn: s.turn + ORDER_QUARTERS });
    return done(`${t.name} ${count}대를 발주했습니다.`);
  }

  function sellAircraft(s, airlineId, planeId) {
    const a = St.airline(s, airlineId);
    const p = s.planes.find((x) => x.id === planeId && x.airlineId === airlineId);
    if (!a || !p) return fail('보유하지 않은 기재입니다.');
    if (p.routeId !== null) return fail('노선에 배속된 기재는 팔 수 없습니다.');
    if (p.checkUntilTurn === s.turn) return fail('중정비 중인 기재는 팔 수 없습니다.');
    a.cash += St.residual(s.types[p.typeId], p.ageQuarters) * RESALE_RATE;
    s.planes = s.planes.filter((x) => x.id !== planeId);
    return done(`${s.types[p.typeId].name} 한 대를 처분했습니다.`);
  }

  // ── 금융 ──

  function borrow(s, airlineId, amount) {
    const a = St.airline(s, airlineId);
    if (!a || !a.alive) return fail('없는 항공사입니다.');
    if (amount <= 0) return fail('금액이 0 이하입니다.');
    const room = St.debtCap(s, a) - a.debt;
    if (amount > room) return fail(`차입 한도가 ${Math.round(Math.max(0, room) / 1e6)}M 남았습니다.`);
    a.debt += amount;
    a.cash += amount;
    return done(`${Math.round(amount / 1e6)}M을 차입했습니다.`);
  }

  function repay(s, airlineId, amount) {
    const a = St.airline(s, airlineId);
    if (!a || !a.alive) return fail('없는 항공사입니다.');
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
