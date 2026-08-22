/*
 * 노선망 AI — 경쟁 항공사가 스스로 노선을 열고 접고 기재를 산다.
 *
 * 이게 없으면 세계가 창업 노선망에 20년 동안 얼어붙는다. 플레이어가 무엇을 하든
 * 상대는 같은 자리에 같은 편수로 서 있고, 요지를 선점하는 것도 늦게 들어가는 것도
 * 아무 뜻이 없어진다.
 *
 * 성격은 새로 만들지 않았다. 제조사 게임이 이미 매겨 둔 `priceSensitivity`(가격 민감도)
 * 와 `prestige`(위신)에서 나온다 — 라이언에어는 싸게 많이 깔고, 에미레이트는 비싸게
 * 크게 간다. 두 계층에서 같은 회사가 같은 성격이어야 한다.
 *
 * AI 는 플레이어와 **같은 명령**만 쓴다 (`js/sky/actions.js`). 지름길을 두면 화면에서
 * 막힌 수를 AI 만 두게 되고, 자동 플레이로 재는 밸런스가 사람이 못 하는 판이 된다.
 */
(function (root) {
  'use strict';

  const Cities = root.AirlinerCities;
  const Econ = root.AirlinerSkyEconomics;
  const Market = root.AirlinerSkyMarket;
  const Cargo = root.AirlinerSkyCargo;
  const St = root.AirlinerSkyState;
  const A = root.AirlinerSkyActions;
  const Data = root.AirlinerData;

  const B = {
    /** 이만큼은 손대지 않는다 — 다 털어 넣으면 한 분기 적자에 파산한다 */
    CASH_FLOOR: 40e6,
    /** 한 분기에 여는 노선 수 */
    MAX_NEW_ROUTES: 3,
    /** 한 번에 발주하는 기재 수 */
    MAX_ORDERS: 3,
    /** 유휴기가 이만큼 있으면 더 사지 않는다 */
    IDLE_ENOUGH: 4,
    /** 이보다 못 채우고 적자면 접을 후보 */
    HOPELESS_LOAD: 0.48,
    /** 접기를 매번 하지 않는다 — 한 분기 적자로 간선을 버리면 안 된다 */
    CLOSE_CHANCE: 0.45,
    /** 이보다 잘 차면 편수를 늘린다 */
    GROW_LOAD: 0.84,
    /** 이만큼 내리 놀린 슬롯만 반납한다 — 즉시 반납은 되사기 비용으로 손해다 */
    SHED_AFTER: 6,
    /** 노선을 열 값어치가 있는 최소 분기 수요 */
    MIN_DEMAND: 1500,
  };

  const seedOf = (id) => Data.AIRLINES.find((x) => x.id === id) || {};

  /**
   * 이 회사가 노리는 운임 수준. 가격 민감도가 낮은 회사(= 비싸게 파는 회사)일수록 높다.
   * 1.4(라이언에어) → 0.86, 0.5(에미레이트) → 1.12.
   */
  function targetFare(airlineId) {
    const sens = seedOf(airlineId).priceSensitivity;
    return Math.min(1.15, Math.max(0.85, 1.3 - (sens === undefined ? 1 : sens) * 0.32));
  }

  /** 얼마나 세게 미는가 — 위신이 높은 회사가 더 크게 지른다. */
  function aggression(airlineId) {
    const p = seedOf(airlineId).prestige;
    return 0.85 + (p === undefined ? 0.8 : p) * 0.45;
  }

  const idlePlanes = (s, id) => St.planesOf(s, id).filter((p) => p.routeId === null && p.checkUntilTurn !== s.turn);

  /** 모든 AI 회사를 굴린다. 회사 순서는 목록 순서로 고정 — 결정론이 여기 걸린다. */
  function actAll(s, rng, opts) {
    const o = opts || {};
    for (const a of St.living(s)) {
      if (a.id === o.playerId) continue;
      act(s, a.id, rng);
    }
    return s;
  }

  function act(s, airlineId, rng) {
    const a = St.airline(s, airlineId);
    if (!a || !a.alive) return s;
    tuneRoutes(s, airlineId, rng);
    pruneRoutes(s, airlineId, rng);
    growFrequency(s, airlineId);
    upgauge(s, airlineId);
    openRoutes(s, airlineId, rng);
    manageFleet(s, airlineId, rng);
    shedIdleSlots(s, airlineId);
    finance(s, airlineId);
    return s;
  }

  /** 만석이면 값을 올리고, 텅 비면 내린다. */
  function tuneRoutes(s, airlineId, rng) {
    const anchor = targetFare(airlineId);
    for (const r of St.routesOf(s, airlineId)) {
      if (!r.active || !r.last) continue;
      // 못 뜬 분기는 값을 매기는 근거가 못 된다. 좌석이 0 이면 탑승률도 0 으로 잡히는데,
      // 그걸 "텅 비어서 안 팔렸다"로 읽으면 **뜨지도 않은 분기마다 운임을 깎는다**.
      if (r.last.seats <= 0) continue;
      const lf = r.last.loadFactor;
      let fare = r.fareMul;
      if (lf > 0.9) fare *= 1.05;
      else if (lf > 0.82) fare *= 1.02;
      else if (lf < 0.5) fare *= 0.94;
      else if (lf < 0.65) fare *= 0.97;
      fare += rng.range(-0.02, 0.02);
      // 회사 성향이 정한 기준선으로 서서히 끌려간다.
      A.tuneRoute(s, airlineId, r.id, { fareMul: fare * 0.85 + anchor * 0.15 });
    }
  }

  /**
   * 돈이 안 되고 손님도 없는 노선은 접는다.
   *
   * `last.cost` 에는 그 노선이 문 슬롯 임차료가 이미 들어 있다. 그래서 여기서 따로
   * 더할 것 없이 손익만 보면 **슬롯값까지 갚고 남는가**를 판단하는 셈이 된다.
   */
  function pruneRoutes(s, airlineId, rng) {
    for (const r of St.routesOf(s, airlineId).slice()) {
      if (!r.active || !r.last) continue;
      // 좌석이 0 이면 "띄웠는데 텅 빈" 것이 아니라 아예 못 뜬 것이다. 이걸 안 가리면
      // 공항 폐쇄 한 번에 멀쩡한 간선을 영구히 접는다.
      if (r.last.seats <= 0) continue;
      const hopeless = r.last.revenue - r.last.cost < 0 && r.last.loadFactor < B.HOPELESS_LOAD;
      if (hopeless && rng.chance(B.CLOSE_CHANCE)) A.closeRoute(s, airlineId, r.id);
    }
  }

  /** 잘 나가는 노선에 편수를 붙이고, 남는 기재를 밀어 넣는다. */
  function growFrequency(s, airlineId) {
    const ranked = St.routesOf(s, airlineId)
      .filter((r) => r.active && r.last && r.last.loadFactor > B.GROW_LOAD)
      .sort((x, y) => y.last.revenue - y.last.cost - (x.last.revenue - x.last.cost) || x.id - y.id);

    for (const r of ranked) {
      const dist = Cities.distance(r.from, r.to);
      // 이번 분기에 **실제로 뜨는** 기재로 센다. 배속 목록으로 세면 정비 들어간 기체의
      // 수송력까지 있다고 보고 편수를 올려 슬롯을 쓰는데, 시장은 그 좌석을 그 자리에서
      // 걷어간다 — 결산과 같은 목록을 봐야 한다.
      const cap = Econ.capacity(St.flyingOn(s, r.id), dist, (t) => s.types[t]);
      if (r.freq < cap.maxFreq) {
        if (A.tuneRoute(s, airlineId, r.id, { freq: r.freq + 1 }).ok) continue;
      }
      // 기재가 한계면 유휴기를 추가 투입한다. 다만 **슬롯이 막고 있으면 넣지 않는다** —
      // 기재를 늘려도 편수가 못 오르니 값만 나가고, 그 자리가 매 분기 다시 비어 있는
      // 것처럼 보여 AI 가 기재를 무한히 밀어 넣는다(80분기에 노선당 열한 대까지 갔다).
      // 슬롯이 병목인 노선은 upgauge 가 더 큰 기체로 갈아 끼워 푼다.
      if (A.freeSlots(s, airlineId, r.from) < 1 || A.freeSlots(s, airlineId, r.to) < 1) continue;
      const idle = idlePlanes(s, airlineId).find((p) => Econ.canFly(s.types[p.typeId], dist));
      if (!idle) continue;
      const ids = St.assignedTo(s, r.id).map((p) => p.id).concat([idle.id]);
      if (!A.assignPlanes(s, airlineId, r.id, ids).ok) continue;
      const grown = Econ.capacity(St.flyingOn(s, r.id), dist, (t) => s.types[t]);
      const want = Math.min(
        grown.maxFreq,
        r.freq + Math.max(0, A.freeSlots(s, airlineId, r.from)),
        r.freq + Math.max(0, A.freeSlots(s, airlineId, r.to)),
      );
      if (want > r.freq) A.tuneRoute(s, airlineId, r.id, { freq: want });
    }
  }

  /**
   * 슬롯이 동나 편수를 못 늘리는데 만석인 노선은, 더 큰 기재로 갈아타는 수밖에 없다.
   * 이게 없으면 허브가 포화된 순간부터 회사가 현금만 쌓아두고 멈춰 선다.
   */
  function upgauge(s, airlineId) {
    for (const r of St.routesOf(s, airlineId)) {
      if (!r.active || !r.last || r.last.loadFactor < 0.92) continue;
      const dist = Cities.distance(r.from, r.to);
      const cap = Econ.capacity(St.flyingOn(s, r.id), dist, (t) => s.types[t]);
      if (r.freq < cap.maxFreq) continue; // 아직 편수로 풀 수 있다
      if (A.freeSlots(s, airlineId, r.from) > 0 && A.freeSlots(s, airlineId, r.to) > 0) continue;

      const current = St.assignedTo(s, r.id);
      const smallest = current.slice().sort((x, y) => s.types[x.typeId].seats - s.types[y.typeId].seats)[0];
      if (!smallest) continue;
      const bigger = idlePlanes(s, airlineId)
        .filter((p) => Econ.canFly(s.types[p.typeId], dist) && s.types[p.typeId].seats > s.types[smallest.typeId].seats)
        .sort((x, y) => s.types[y.typeId].seats - s.types[x.typeId].seats)[0];
      if (!bigger) continue;
      const ids = current.filter((p) => p.id !== smallest.id).map((p) => p.id).concat([bigger.id]);
      A.assignPlanes(s, airlineId, r.id, ids);
    }
  }

  /**
   * 취항 후보를 고를 때 **목적지 슬롯 매입비까지 포함해서** 판단한다.
   * 이걸 빼먹으면 AI 는 창업 때 받은 다섯 도시 밖으로 영영 나가지 못한다.
   */
  function openRoutes(s, airlineId, rng) {
    const limit = Math.max(1, Math.round(B.MAX_NEW_ROUTES * aggression(airlineId)));
    for (let opened = 0; opened < limit; opened++) {
      const a = St.airline(s, airlineId);
      const idle = idlePlanes(s, airlineId);
      if (!idle.length) break;
      const budget = (a.cash - B.CASH_FLOOR * s.world.inflation) * 0.55;
      if (budget <= 0) break;

      const served = new Set(St.routesOf(s, airlineId).filter((r) => r.active).map((r) => Cities.pairKey(r.from, r.to)));
      // 슬롯을 가진 도시는 **전부** 출발 거점이다. 상위 몇 곳만 보면 후반에 제 노선망의
      // 3분의 2가 탐색에서 빠져, 갈 만한 짝이 소진되는 순간 노선망이 통째로 굳는다.
      const origins = Object.keys(a.slots).filter((c) => a.slots[c] > 0).sort();

      let best = null;
      for (const fromId of origins) {
        if (St.isClosed(s.cityState[fromId] || {}, s.turn)) continue;
        for (const to of Cities.CITIES) {
          if (to.id === fromId) continue;
          if (served.has(Cities.pairKey(fromId, to.id))) continue;
          if (St.isClosed(s.cityState[to.id] || {}, s.turn)) continue;

          const dist = Cities.distance(fromId, to.id);
          const plane = idle
            .filter((p) => Econ.canFly(s.types[p.typeId], dist))
            .sort((x, y) => s.types[y.typeId].seats - s.types[x.typeId].seats)[0];
          if (!plane) continue;
          const cap = Econ.capacity([plane], dist, (t) => s.types[t]);
          if (cap.maxFreq < 1) continue;
          const freq = Math.min(cap.maxFreq, 7);

          const needFrom = Math.max(0, freq - A.freeSlots(s, airlineId, fromId));
          const needTo = Math.max(0, freq - A.freeSlots(s, airlineId, to.id));
          if (needFrom > A.unsoldSlots(s, fromId) || needTo > A.unsoldSlots(s, to.id)) continue;

          const cost =
            A.slotCost(s, airlineId, fromId, needFrom) +
            A.slotCost(s, airlineId, to.id, needTo) +
            A.routeSetupCost(s, fromId, to.id);
          if (cost > budget) continue;

          // 같은 매력이면 슬롯값이 싼 쪽이 낫다.
          const score = attractiveness(s, airlineId, Cities.get(fromId), to, s.types[plane.typeId]) / (1 + cost / 60e6);
          if (!best || score > best.score) {
            best = { fromId, toId: to.id, plane, freq, needFrom, needTo, score };
          }
        }
      }
      if (!best || best.score <= 0) break;

      if (best.needFrom > 0 && !A.buySlots(s, airlineId, best.fromId, best.needFrom).ok) break;
      if (best.needTo > 0 && !A.buySlots(s, airlineId, best.toId, best.needTo).ok) break;
      const freq = Math.min(best.freq, A.freeSlots(s, airlineId, best.fromId), A.freeSlots(s, airlineId, best.toId));
      if (freq < 1) break;
      const fare = targetFare(airlineId) + rng.range(-0.04, 0.04);
      if (!A.openRoute(s, airlineId, best.fromId, best.toId, [best.plane.id], freq, fare).ok) break;
    }
  }

  /** 수요가 크고 경쟁이 옅을수록 매력적이다. */
  /**
   * 이 구간에 이 기종을 붙였을 때 **화물이 매출을 얼마나 더 얹는가** (0.. 비율).
   *
   * 화물을 안 보면 자동조종은 벨리로 먹는 장거리 광동체 노선을 여객 수요만으로
   * 판단한다 — 사람이 쓸 수 있는 손잡이를 기계는 못 쓰는 셈이고, 등급 눈금이
   * "자동조종만큼 하면 B" 인 이 게임에서는 그게 곧 난이도 왜곡이다.
   *
   * 크기는 재지 않고 **비율**만 본다. `attractiveness` 가 돈이 아니라 상대 점수라,
   * 매출의 2할이 화물인 노선을 2할 더 끌리는 것으로 두면 단위가 맞는다.
   */
  function cargoLift(s, type, a, b) {
    if (!Cargo || !type) return 0;
    const dist = Cities.distance(a.id, b.id);
    const ctx = {
      economy: s.world.economy,
      inflation: s.world.inflation,
      dev: (id) => (s.cityState[id] || {}).dev || 1,
    };
    const cap = Econ.capacity([{ typeId: type.id }], dist, () => type);
    if (cap.maxFreq < 1) return 0;
    const freq = Math.min(cap.maxFreq, 7);
    const legs = Econ.quarterlyLegs(freq);
    // 짐이 먹는 몫은 아직 모른다(태울 손님 수가 정해지기 전이다) — 절반쯤 찬다고 본다.
    const tons = Cargo.bellyTons(type) * legs * (1 - Cargo.BALANCE.CARGO_BAGGAGE_SHARE * 0.5);
    const carried = Math.min(tons, Cargo.demandTons(a.id, b.id, ctx));
    const cargoRev = carried * Cargo.revenuePerTon(dist, s.world.inflation);
    const seats = Econ.quarterlySeats(freq, cap.avgSeats);
    const paxRev = seats * 0.7 * Econ.standardFare(dist, s.world.inflation);
    if (paxRev <= 0) return 0;
    // 상한을 둔다 — 여객 수요가 거의 없는 구간에서 비율이 발산해 화물만 보고 취항한다.
    return Math.min(0.6, cargoRev / paxRev);
  }

  function attractiveness(s, airlineId, a, b, type) {
    const demand = St.demandFor(s, a, b).total;
    if (demand < B.MIN_DEMAND) return 0;
    const key = Cities.pairKey(a.id, b.id);
    const dist = Cities.distance(a.id, b.id);
    let rivalSeats = 0;
    for (const r of s.routes) {
      if (!r.active || Cities.pairKey(r.from, r.to) !== key) continue;
      // 여기서는 일부러 **배속 목록**으로 센다. 취항은 몇 해를 가는 결정이라 경쟁자의
      // 상시 공급을 봐야 한다 — 이번 분기에 상대 기체가 정비에 들어갔다는 건 잡음이지
      // 신호가 아니다. 좌석·원가·편수처럼 이번 분기에 곧바로 값을 치르는 계산은
      // 반대로 반드시 뜨는 목록을 써야 한다 (growFrequency·시장·결산이 그렇다).
      const planes = St.assignedTo(s, r.id);
      const cap = Econ.capacity(planes, dist, (t) => s.types[t]);
      rivalSeats += Econ.quarterlySeats(Math.min(r.freq, cap.maxFreq), cap.avgSeats);
    }
    const me = St.airline(s, airlineId);
    const homeBonus = a.id === me.home || b.id === me.home ? 1.35 : 1;
    const brandBonus = 1 + (me.brand || 0) / 200;
    // 모델에 있는 경쟁자만 세면 절반만 보는 것이다. 로컬 항공사는 어느 구간에나 있고
    // 세기가 구간마다 다르므로, 로컬이 억센 시장은 그만큼 깎아 본다 — 이게 없으면
    // AI 는 편차를 못 읽고 하필 빡센 시장만 골라 들어간다.
    const local = Math.exp(Market.localStrength(a, b));
    return (demand / (1 + rivalSeats / 1000) / (1 + local)) * homeBonus * brandBonus * (1 + cargoLift(s, type, a, b));
  }

  /** 노선망 평균 거리에 맞는, 좌석당 값이 가장 싼 기종을 고른다. */
  function preferredType(s, airlineId) {
    const a = St.airline(s, airlineId);
    const routes = St.routesOf(s, airlineId).filter((r) => r.active);
    const typical = routes.length
      ? routes.reduce((x, r) => x + Cities.distance(r.from, r.to), 0) / routes.length
      : 2500;
    const year = St.yearFracOf(s);
    const seed = seedOf(airlineId);
    const candidates = Object.keys(s.types)
      .map((id) => s.types[id])
      .filter((t) => t.eis <= year && (!t.end || t.end > year) && Econ.canFly(t, typical))
      .sort((x, y) => (x.id < y.id ? -1 : 1));
    if (!candidates.length) return null;
    // 위신이 높은 회사는 크고 이름난 기체를, 가격에 민감한 회사는 좌석단가가 싼 기체를.
    if ((seed.prestige || 0.8) >= 1.1) {
      return candidates.sort((x, y) => y.prestige + y.seats / 200 - (x.prestige + x.seats / 200))[0];
    }
    if ((seed.priceSensitivity || 1) >= 1.2) {
      return candidates.sort((x, y) => x.price / x.seats - y.price / y.seats)[0];
    }
    const cost = (t) => (t.price / t.seats) * (1 + (t.fuel / t.seats) * 20);
    return candidates.sort((x, y) => cost(x) - cost(y))[0];
  }

  /** 늙은 유휴기를 정리하고, 여유가 있으면 발주한다. */
  function manageFleet(s, airlineId, rng) {
    // 25년(100분기) 넘은 유휴기는 판다. 정비 중인 기체는 처분 대상에서도 뺀다 —
    // 뜯어 놓은 기체를 그 분기에 팔지는 않는다.
    for (const p of St.planesOf(s, airlineId).slice()) {
      if (p.routeId !== null || p.checkUntilTurn === s.turn || p.ageQuarters <= 100) continue;
      A.sellAircraft(s, airlineId, p.id);
    }
    if (idlePlanes(s, airlineId).length >= B.IDLE_ENOUGH) return;

    const t = preferredType(s, airlineId);
    if (!t) return;
    const a = St.airline(s, airlineId);
    const affordable = Math.floor((a.cash - B.CASH_FLOOR * s.world.inflation) / t.price);
    if (affordable < 1) return;
    const want = Math.max(1, Math.min(B.MAX_ORDERS, Math.floor(Math.min(affordable, B.MAX_ORDERS) * aggression(airlineId))));
    // 매 분기 지르지는 않는다 — 그러면 모든 회사가 같은 속도로 커져 성격이 안 보인다.
    if (!rng.chance(0.6)) return;
    A.buyAircraft(s, airlineId, t.id, want);
  }

  /**
   * **오래** 놀리는 슬롯을 반납한다. 슬롯이 분기 임차료를 무는 고정비가 된 뒤로는
   * 쌓아 두는 것만으로 손실이지만, 그렇다고 그 자리에서 내놓으면 안 된다 — 다음
   * 분기에 노선을 열며 같은 자리를 더 비싼 값에 되사게 된다(슬롯값은 마를수록
   * 오른다). 실제로 즉시 반납으로 두었을 때 20년 자기자본 중앙값이 2,550M 에서
   * 2,337M 로 떨어졌다. 그래서 몇 분기 내리 놀린 자리만 내놓는다.
   *
   * 안방은 성장 여지로 조금 남겨 둔다.
   */
  function shedIdleSlots(s, airlineId) {
    const a = St.airline(s, airlineId);
    if (!a.idleSlotQuarters) a.idleSlotQuarters = {};
    const clock = a.idleSlotQuarters;
    for (const city of Object.keys(a.slots).sort()) {
      const free = A.freeSlots(s, airlineId, city);
      const keep = city === a.home ? 4 : 1;
      if (free <= keep) {
        delete clock[city];
        continue;
      }
      clock[city] = (clock[city] || 0) + 1;
      if (clock[city] < B.SHED_AFTER) continue;
      if (A.sellSlots(s, airlineId, city, free - keep).ok) delete clock[city];
    }
    for (const city of Object.keys(clock)) if (!a.slots[city]) delete clock[city];
  }

  /** 현금이 마르면 빌리고, 남으면 갚는다. */
  function finance(s, airlineId) {
    const a = St.airline(s, airlineId);
    const floor = B.CASH_FLOOR * s.world.inflation;
    if (a.cash < floor) {
      const room = St.debtCap(s, a) - a.debt;
      const want = Math.min(room, floor * 3 - a.cash);
      if (want > 0) A.borrow(s, airlineId, want);
      return;
    }
    // 이자는 아무것도 안 하고 나가는 돈이다. 현금이 넉넉하면 먼저 갚는다.
    const spare = a.cash - floor * 4;
    if (a.debt > 0 && spare > 0) A.repay(s, airlineId, Math.min(a.debt, spare));
  }

  root.AirlinerSkyAi = {
    BALANCE: B,
    targetFare,
    aggression,
    actAll,
    act,
    attractiveness,
    preferredType,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
