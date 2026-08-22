/*
 * 시장 점유 — 같은 구간의 항공사들이 승객을 어떻게 나눠 갖나.
 *
 * sky-tycoon 의 `core/sim/Market.kt` 에서 직항 시장 부분을 옮겨 왔다 (허브 환승은
 * 다음 단계). 잘라낸 것: 객실 배치와 프리미엄 수요, 부대시설 가산.
 *
 * 핵심은 후보에 **로컬 항공사라는 바깥 선택지**가 늘 함께 있다는 것이다. 이 게임에
 * 나오는 항공사들은 그 시대의 주요 회사고, 나머지 수요가 비어 있는 게 아니라 모델에
 * 없는 지역 사업자들이 낮은 경쟁력으로 실어 나른다고 본다. 이 가정이 있어야
 * **내놓은 좌석이 무조건 팔리지 않는다** — 로컬보다 매력이 있어야 팔리고, 그래서
 * 탑승률이 곧 경쟁력의 함수가 된다.
 *
 * 상태를 안 본다. 필요한 조회는 전부 `ctx` 로 받는다.
 */
(function (root) {
  'use strict';

  const Cities = root.AirlinerCities;
  const Demand = root.AirlinerDemand;
  const Econ = root.AirlinerSkyEconomics;

  const B = {
    /** 출장객은 운임에 둔감하고 편수·서비스를 본다. 관광객은 정반대다. */
    BIZ_PRICE_SENS: 1.7,
    BIZ_FREQ_W: 0.85,
    BIZ_SERVICE_W: 0.38,
    LEI_PRICE_SENS: 4.2,
    LEI_FREQ_W: 0.42,
    LEI_SERVICE_W: 0.16,

    BRAND_W: 0.012,
    PRESTIGE_W: 0.02,
    HUB_W: 0.18,
    SAFETY_W: 0.9,
    /** 그 공항에서 이 회사가 **다른 어디로 더 갈 수 있는가** */
    FEED_W: 0.3,
    /** 기반 국가 프리미엄 — 홈이면 온전히, 같은 권역이면 절반 */
    HOME_W: 0.45,

    /**
     * 로컬 항공사의 효용. 거리가 멀수록 약해진다 — 태평양을 건널 광동체를 굴릴 회사는
     * 대개 이미 게임 안에 있다. 거리에 무관하게 세게 두면 도쿄–LA 같은 간판 간선이
     * 독점인데도 반도 못 채운다.
     */
    FRINGE_UTIL: 1.95,
    FRINGE_DIST_REF: 1000,
    FRINGE_DIST_W: 0.85,
    /**
     * 도시쌍마다의 편차. 로컬의 실력이 어디나 똑같을 리 없다 — 억센 국적사가 버티는
     * 구간이 있고 손 놓은 구간이 있다. 값 하나로 두면 모든 노선이 똑같이 빡빡해
     * **어디를 뚫을지가 판단거리가 되지 않는다**.
     */
    FRINGE_SIGMA: 0.6,

    /** 시장 평균 운임이 싸면 원래 안 움직였을 사람도 움직인다 */
    INDUCED_ELASTICITY: 0.45,
    /** 좌석이 없어 흘린 몫을 다시 돌리는 횟수 */
    SPILL_ROUNDS: 3,

    // ── 환승 ──

    /** 우회가 이보다 심하면 아무도 안 탄다 (직항 거리의 배수) */
    CONNECT_MAX_DETOUR: 1.35,
    /**
     * "환승하지 않는다"의 효용. 후보끼리만 정규화하면 CONNECT_PENALTY 가 모든 항에서
     * 똑같이 빠져 상쇄되고, 후보가 하나뿐이면 아무리 나쁜 여정이어도 남은 수요를
     * 통째로 가져간다.
     */
    CONNECT_OUTSIDE_UTIL: 0,
    /** 경유편은 직항보다 싸게 판다 */
    CONNECT_FARE_MUL: 0.92,
    /** 환승 승객의 수익률 — 빈자리를 메우는 몫이라 원가가 덜 붙는다 */
    CONNECT_YIELD: 1.05,
    /** 갈아타는 불편. 이게 없으면 허브가 만능이 된다 */
    CONNECT_PENALTY: 1.15,
  };

  // ── 로컬 항공사 ──

  const MASK = (1n << 64n) - 1n;

  /** splitmix64 마무리 섞기 — 이웃한 도시쌍 이름이 비슷한 값으로 몰리지 않게 한다. */
  function mix64(seed) {
    let z = (seed + 0x9e3779b97f4a7c15n) & MASK;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return (z ^ (z >> 31n)) & MASK;
  }

  const bellCache = new Map();

  /**
   * 도시쌍 이름에서 **결정론적으로** 뽑은 종 모양 편차.
   *
   * 분기마다 다시 굴리면 탑승률이 이유 없이 출렁여 경영 판단이 잡음에 묻히고 세이브도
   * 재현되지 않는다. 해시를 직접 짜는 것은 문자열 해시가 환경마다 갈릴 여지를 없애기
   * 위해서다.
   */
  function bellDeviate(key) {
    let v = bellCache.get(key);
    if (v !== undefined) return v;
    // FNV-1a
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < key.length; i++) {
      h = (h ^ BigInt(key.charCodeAt(i))) & MASK;
      h = (h * 0x100000001b3n) & MASK;
    }
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      h = mix64(h);
      sum += Number(h >> 11n) / 9007199254740992; // 2^53
    }
    // 균등 4개의 합은 평균 2, 표준편차 sqrt(4/12).
    v = (sum - 2) / 0.5773502691896257;
    bellCache.set(key, v);
    return v;
  }

  function fringeUtility(pairKey, distanceKm) {
    const far = B.FRINGE_DIST_W * Math.log(Math.max(1, distanceKm / B.FRINGE_DIST_REF));
    return B.FRINGE_UTIL - far + bellDeviate(pairKey) * B.FRINGE_SIGMA;
  }

  /**
   * 이 구간 로컬이 얼마나 센가 — **밖으로 연다.**
   *
   * 숨겨 두면 편차가 "돈을 쓰고 나서야 알게 되는 함정"이 된다. 흩어 놓은 이유가
   * 시장을 고르는 재미인데, 고를 정보가 없으면 그냥 운이다.
   */
  function localStrength(a, b) {
    return fringeUtility(Cities.pairKey(a.id, b.id), Cities.between(a, b));
  }

  /** 사람이 읽는 3단계. 기준은 거리 보정한 중앙에서 ±0.5σ — 종분포라 대략 3:4:3 이다. */
  function localStrengthLabel(a, b) {
    const d = Cities.between(a, b);
    const mid = B.FRINGE_UTIL - B.FRINGE_DIST_W * Math.log(Math.max(1, d / B.FRINGE_DIST_REF));
    const half = 0.5 * B.FRINGE_SIGMA;
    const s = localStrength(a, b);
    if (s > mid + half) return '강함';
    if (s < mid - half) return '약함';
    return '보통';
  }

  // ── 배분 ──

  /**
   * 로짓으로 수요를 나눈다.
   *
   * 좌석이 모자라 못 태운 몫만 다음 라운드로 넘긴다. **로컬을 택한 손님까지 다시
   * 돌리면** 라운드를 거듭할수록 바깥 선택지가 무력해져(50%가 93.75%가 된다) 이 모델이
   * 통째로 무너진다.
   */
  function allocate(offers, demand, fringeUtil, utility) {
    const taken = offers.map(() => 0);
    if (demand <= 0) return { taken, unmet: 0 };
    let left = demand;

    for (let round = 0; round <= B.SPILL_ROUNDS; round++) {
      if (left <= 1e-6) break;
      const active = offers.map((o, i) => i).filter((i) => offers[i].remaining > 1e-6);
      if (!active.length) break;

      const utils = active.map((i) => utility(offers[i]));
      const maxU = Math.max(Math.max(...utils), fringeUtil);
      const weights = utils.map((u) => Math.exp(u - maxU));
      const fringe = Math.exp(fringeUtil - maxU);
      const denom = weights.reduce((x, y) => x + y, 0) + fringe;
      if (denom <= 0) break;

      let spilled = 0;
      active.forEach((idx, k) => {
        const want = left * (weights[k] / denom);
        const o = offers[idx];
        const give = Math.min(want, o.remaining);
        o.remaining -= give;
        taken[idx] += give;
        spilled += want - give;
      });
      if (spilled <= 1e-9) {
        left = 0;
        break;
      }
      left = spilled;
    }
    return { taken, unmet: left };
  }

  /**
   * 한 도시쌍의 직항 시장을 푼다.
   *
   * @param ctx {
   *   airlineOf(id), planesOn(routeId), typeOf(typeId), slotsAt(airlineId, cityId),
   *   totalSlots(cityId), feedCount(airlineId, cityId, selfRouteId),
   *   demand(a, b), inflation, oil
   * }
   */
  function resolvePair(a, b, routes, ctx) {
    if (!routes.length) return [];
    // 공항이 닫혔으면 아무도 뜨지 않는다. 수요만 0 으로 두면 빈 비행기가 연료와
    // 착륙료를 그대로 물며 계속 난다.
    const closed = !!(ctx.closed && (ctx.closed(a.id) || ctx.closed(b.id)));
    const dist = Cities.between(a, b);
    const standard = Econ.standardFare(dist, ctx.inflation);

    const offers = [];
    for (const r of routes) {
      if (!r.active || r.freq <= 0) continue;
      const airline = ctx.airlineOf(r.airlineId);
      if (!airline || airline.alive === false) continue;
      // 중정비로 묶인 기체는 빠진다 — 그만큼 편수와 좌석이 준다.
      const planes = ctx.planesOn(r.id);
      if (!planes.length) continue;
      const cap = Econ.capacity(planes, dist, ctx.typeOf);
      if (!cap.usable) continue;
      // 유효 편수는 채산과 **같은 함수**로 낸다 — 따로 세면 시장이 내놓은 좌석과
      // 청구되는 원가가 어긋난다.
      const freq = Econ.effectiveFreq(r, planes, dist, ctx.typeOf, closed);
      if (freq <= 0) continue;

      const seats = Econ.quarterlySeats(freq, cap.avgSeats);
      const fare = standard * (r.fareMul === undefined ? 1 : r.fareMul);
      const fareRatio = Math.max(0.05, fare / standard);

      // 슬롯 점유는 **확장분까지 포함한 총량**으로 나눈다. 안 그러면 점유율이 1을 넘어
      // 있지도 않은 지배력 보너스가 붙는다.
      const hub =
        (ctx.slotsAt(airline.id, a.id) / Math.max(1, ctx.totalSlots(a.id)) +
          ctx.slotsAt(airline.id, b.id) / Math.max(1, ctx.totalSlots(b.id))) /
        2;
      const prestige = planes.reduce((s, p) => s + ctx.typeOf(p.typeId).prestige, 0) / planes.length;
      const feed = ctx.feedCount(airline.id, a.id, r.id) + ctx.feedCount(airline.id, b.id, r.id);

      // 기반 국가 프리미엄 — 홈 공항이 끝점이면 온전히, 같은 권역이면 절반.
      const homeCity = Cities.get(airline.home);
      let homeEdge = 0;
      if (airline.home === a.id || airline.home === b.id) homeEdge = 1;
      else if (homeCity && (homeCity.region === a.region || homeCity.region === b.region)) homeEdge = 0.5;

      const common =
        B.BRAND_W * (airline.brand || 0) +
        B.PRESTIGE_W * prestige +
        B.HUB_W * hub +
        B.SAFETY_W * ((airline.safety === undefined ? 1 : airline.safety) - 1) +
        B.FEED_W * feed +
        B.HOME_W * homeEdge;

      const service = (airline.serviceLevel || 1) + (r.serviceExtra || 0);
      const logFreq = Math.log(1 + freq);
      const logFare = Math.log(fareRatio);

      offers.push({
        routeId: r.id,
        airlineId: airline.id,
        freq,
        fare,
        seats,
        remaining: seats,
        biz: 0,
        lei: 0,
        bizUtil: -B.BIZ_PRICE_SENS * logFare + B.BIZ_SERVICE_W * service + B.BIZ_FREQ_W * logFreq + common,
        leiUtil: -B.LEI_PRICE_SENS * logFare + B.LEI_SERVICE_W * service + B.LEI_FREQ_W * logFreq + common,
      });
    }
    if (!offers.length) return [];

    const demand = ctx.demand(a, b);
    // 시장 평균 운임이 싸면 원래 안 움직였을 사람들까지 움직인다.
    const capacityTotal = offers.reduce((s, o) => s + o.seats, 0);
    const weightedFareRatio =
      capacityTotal <= 0 ? 1 : offers.reduce((s, o) => s + o.seats * (o.fare / standard), 0) / capacityTotal;
    const induced = Math.pow(Math.min(3, Math.max(0.3, weightedFareRatio)), -B.INDUCED_ELASTICITY);

    const fringeUtil = fringeUtility(Cities.pairKey(a.id, b.id), dist);

    // 출장객이 먼저 고른다 (수익 관리).
    const bizOut = allocate(offers, demand.business * induced, fringeUtil, (o) => o.bizUtil);
    bizOut.taken.forEach((v, i) => (offers[i].biz = v));
    const leiOut = allocate(offers, demand.leisure * induced, fringeUtil, (o) => o.leiUtil);
    leiOut.taken.forEach((v, i) => (offers[i].lei = v));

    // 점유율 분모는 **로컬 몫까지 포함한 시장 전체**다. 모델에 있는 회사끼리만 나누면
    // 혼자 취항한 구간이 언제나 100% 로 뜬다 — 실제로는 로컬에 밀려 조금밖에 못 실었어도.
    const marketTotal = (demand.business + demand.leisure) * induced;
    return offers.map((o) => ({
      routeId: o.routeId,
      airlineId: o.airlineId,
      /** 이번 분기에 **실제로 뜬** 주간 왕복 편수. 환승 매력도가 이 값을 읽는다. */
      freq: o.freq,
      bizPax: o.biz,
      leiPax: o.lei,
      pax: o.biz + o.lei,
      seats: o.seats,
      fare: o.fare,
      revenue: o.biz * o.fare * Econ.BALANCE.BIZ_YIELD + o.lei * o.fare * Econ.BALANCE.LEI_YIELD,
      share: marketTotal <= 0 ? 0 : Math.min(1, Math.max(0, (o.biz + o.lei) / marketTotal)),
      loadFactor: o.seats <= 0 ? 0 : Math.min(1, (o.biz + o.lei) / o.seats),
      unmet: bizOut.unmet + leiOut.unmet,
    }));
  }


  // ── 2단계: 허브 환승 ──

  /**
   * 경유 여정의 효용 — 직항보다 확실히 불리해야 허브가 만능이 되지 않는다.
   *
   * 편수는 **병목 구간**이 정한다. 한쪽이 주 2회면 그 여정은 주 2회짜리다.
   */
  function connectUtility(airline, ra, rc, aId, cId, hubId, fare, direct, ctx, freqA, freqB) {
    const standard = Econ.standardFare(direct, ctx.inflation);
    const logFare = Math.log(Math.max(0.05, fare / standard));
    const service = ((airline.serviceLevel || 1) * 2 + (ra.serviceExtra || 0) + (rc.serviceExtra || 0)) / 2;
    // **설정 편수가 아니라 이번 분기에 실제로 뜬 편수**를 쓴다. 중정비로 기재가 빠져
    // 주 2회밖에 못 뜨는 노선이 주 100회짜리 매력으로 환승 수요를 끌어가면, 남은
    // 빈자리에 감당 못 할 손님이 몰린다.
    const freq = Math.min(freqA, freqB);
    const hubGrip = ctx.slotsAt(airline.id, hubId) / Math.max(1, ctx.totalSlots(hubId));
    return (
      -B.LEI_PRICE_SENS * 0.5 * logFare -
      B.BIZ_PRICE_SENS * 0.5 * logFare +
      B.BIZ_SERVICE_W * service +
      B.BIZ_FREQ_W * Math.log(1 + freq) +
      B.BRAND_W * (airline.brand || 0) +
      B.HUB_W * hubGrip +
      B.SAFETY_W * ((airline.safety === undefined ? 1 : airline.safety) - 1) -
      B.CONNECT_PENALTY
    );
  }

  /** 환승 승객이 쓸 수 있는 빈자리. */
  function econSpare(o) {
    return Math.max(0, o.seats - o.pax);
  }

  /** 환승 한 건이 실린 결과를 두 구간에 나눠 적는다. */
  function accumulate(o, take, addPax, addRev) {
    // 수입은 구간 거리로 나눈다 — 긴 구간이 더 가져간다.
    const total = Math.max(1, o.distA + o.distB);
    const revenue = take * o.fare * B.CONNECT_YIELD;
    addPax[o.legA] = (addPax[o.legA] || 0) + take;
    addPax[o.legB] = (addPax[o.legB] || 0) + take;
    addRev[o.legA] = (addRev[o.legA] || 0) + revenue * (o.distA / total);
    addRev[o.legB] = (addRev[o.legB] || 0) + revenue * (o.distB / total);
  }

  /**
   * 2단계 — 직항이 채우지 못한 수요를 허브 경유 여정이 가져간다.
   *
   * 좌석은 **양쪽 구간에서 동시에** 소비되므로 병목은 둘 중 여유가 적은 쪽이다.
   * 우회가 심하면 승객이 타지 않으므로 CONNECT_MAX_DETOUR 로 잘라낸다.
   */
  function resolveConnections(routes, base, unmetByPair, ctx) {
    // 노선별 남은 좌석. 환승 승객이 여기서만 태워진다.
    const spare = {};
    // 항공사 → 도시 → 그 도시에서 뻗은 [상대 도시, 노선] 목록.
    const links = new Map();
    for (const r of routes) {
      const o = base[r.id];
      if (!o) continue;
      const left = econSpare(o);
      if (left <= 1) continue;
      spare[r.id] = left;
      if (!links.has(r.airlineId)) links.set(r.airlineId, new Map());
      const byCity = links.get(r.airlineId);
      if (!byCity.has(r.from)) byCity.set(r.from, []);
      if (!byCity.has(r.to)) byCity.set(r.to, []);
      byCity.get(r.from).push([r.to, r]);
      byCity.get(r.to).push([r.from, r]);
    }
    if (!Object.keys(spare).length) return base;

    // 도시쌍별 후보 모으기. 허브에서 뻗은 노선 쌍만 보면 되므로 전 도시쌍을 훑지 않는다.
    const candidates = new Map();
    for (const [airlineId, byCity] of links) {
      const airline = ctx.airlineOf(airlineId);
      if (!airline || airline.alive === false) continue;
      for (const [hubId, spokes] of byCity) {
        if (spokes.length < 2) continue;
        for (let i = 0; i < spokes.length; i++) {
          for (let j = i + 1; j < spokes.length; j++) {
            const [aId, ra] = spokes[i];
            const [cId, rc] = spokes[j];
            if (aId === cId) continue;
            // 같은 항공사가 A–C 직항을 갖고 있어도 후보로 둔다. 직항은 1단계에서
            // 이미 로컬 수요를 가져갔고, 여기서 채우는 것은 그러고도 남은 좌석이다.
            const oa = base[ra.id];
            const ob = base[rc.id];
            if (!oa || !ob) continue;
            const direct = Cities.distance(aId, cId);
            if (direct < 1) continue;
            const da = Cities.distance(aId, hubId);
            const db = Cities.distance(hubId, cId);
            if (da + db > direct * B.CONNECT_MAX_DETOUR) continue;

            const fare =
              Econ.standardFare(direct, ctx.inflation) *
              (((ra.fareMul === undefined ? 1 : ra.fareMul) + (rc.fareMul === undefined ? 1 : rc.fareMul)) / 2) *
              B.CONNECT_FARE_MUL;
            const key = Cities.pairKey(aId, cId);
            if (!candidates.has(key)) candidates.set(key, []);
            candidates.get(key).push({
              legA: ra.id,
              legB: rc.id,
              hubId,
              fare,
              distA: da,
              distB: db,
              util: connectUtility(airline, ra, rc, aId, cId, hubId, fare, direct, ctx, oa.freq, ob.freq),
              want: 0,
              pax: 0,
            });
          }
        }
      }
    }
    if (!candidates.size) return base;

    const addPax = {};
    const addRev = {};
    // 구간별 남은 좌석을 **소비해 가며** 배분한다. 여정 하나는 두 구간의 좌석을 동시에
    // 먹으므로, 나중에 노선별로 따로 자르면 한쪽만 깎여 "한 승객이 두 구간을 쓴다"는
    // 전제가 깨진다 (A 구간은 80% 로 줄고 B 구간은 그대로 남는 식).
    const spareLeft = Object.assign({}, spare);

    // 도시쌍마다 로짓 가중치를 미리 굳혀 둔다. 키로 정렬해 결정론을 지킨다.
    const keys = [...candidates.keys()].sort();
    const weightsByPair = {};
    const outsideByPair = {};
    const leftByPair = {};
    for (const key of keys) {
      const offers = candidates.get(key);
      // 직항 시장이 남긴 몫만 줍는다. 아무도 취항하지 않은 도시쌍은 1단계를 거치지
      // 않았으므로 수요 전체가 미충족이다.
      const [aId, cId] = key.split('|');
      const direct = unmetByPair[key];
      const unmet = direct === undefined ? ctx.demand(Cities.get(aId), Cities.get(cId)).total : direct;
      if (unmet <= 1) continue;

      // 1단계를 아예 안 거친 도시쌍(아무 메이저도 직항하지 않는 곳)에서는 **로컬
      // 항공사도 함께 겨뤄야 한다**. 스포크끼리의 구간이 대개 여기 해당하는데, 로컬을
      // 빼면 경유편이 "안 감"만 상대로 이겨서 수요를 통째로 가져간다 — 직항 시장에는
      // 로컬을 깔아 두고 환승 시장만 무주공산으로 두는 셈이라 허브 수송량이 부푼다.
      const fringeU = direct === undefined ? fringeUtility(key, Cities.distance(aId, cId)) : null;
      const maxU = Math.max(
        ...offers.map((o) => o.util),
        B.CONNECT_OUTSIDE_UTIL,
        fringeU === null ? B.CONNECT_OUTSIDE_UTIL : fringeU,
      );
      const weights = offers.map((o) => Math.exp(o.util - maxU));
      const outside =
        Math.exp(B.CONNECT_OUTSIDE_UTIL - maxU) + (fringeU === null ? 0 : Math.exp(fringeU - maxU));
      if (weights.reduce((x, y) => x + y, 0) + outside <= 0) continue;
      weightsByPair[key] = weights;
      outsideByPair[key] = outside;
      leftByPair[key] = unmet;
    }

    // 도시쌍을 하나씩 끝까지 태우고 넘어가면 **먼저 처리된 도시쌍이 공용 구간의 여유
    // 좌석을 통째로 먹는다** — 도쿄 허브에서 도쿄–LA 의 빈자리를 베이징발 승객이 다
    // 가져가고 서울·홍콩발은 한 명도 못 타는 식으로, 정렬 순서가 곧 허브 경제가 된다.
    // 그래서 라운드마다 **모든 도시쌍의 희망 수요를 먼저 모으고**, 구간별로 초과분을
    // 비례 배분해 깎는다. 한 여정은 두 구간을 쓰므로 더 빡빡한 쪽 비율을 따른다.
    for (let round = 0; round <= B.SPILL_ROUNDS; round++) {
      // 1) 이번 라운드에 각 여정이 원하는 양.
      // 좌석이 찬 후보를 빼고 정규화한 분모를 기억해 둔다 — 3) 에서 "환승 안 함" 몫을
      // 뺄 때 **같은 분모**를 써야 덜 빠지지 않는다.
      const roundDenom = {};
      let anyWant = false;
      for (const key of keys) {
        const offers = candidates.get(key);
        for (const o of offers) o.want = 0;
        const left = leftByPair[key];
        if (left === undefined || left <= 1) continue;
        const weights = weightsByPair[key];
        const open = offers
          .map((o, i) => i)
          .filter((i) => Math.min(spareLeft[offers[i].legA] || 0, spareLeft[offers[i].legB] || 0) > 1e-6);
        if (!open.length) continue;
        // 남은 후보만으로 다시 정규화한다. 바깥 선택지(환승 안 함)는 계속 겨룬다.
        const openDenom = open.reduce((s2, i) => s2 + weights[i], 0) + outsideByPair[key];
        if (openDenom <= 0) continue;
        roundDenom[key] = openDenom;
        for (const i of open) {
          offers[i].want = left * (weights[i] / openDenom);
          anyWant = true;
        }
      }
      if (!anyWant) break;

      // 2) 구간별 희망 합계 → 여유를 넘으면 그 비율만큼 모두 깎는다.
      const legWant = {};
      for (const key of keys) {
        for (const o of candidates.get(key)) {
          if (o.want <= 0) continue;
          legWant[o.legA] = (legWant[o.legA] || 0) + o.want;
          legWant[o.legB] = (legWant[o.legB] || 0) + o.want;
        }
      }
      const legScale = {};
      for (const routeId of Object.keys(legWant)) {
        const room = spareLeft[routeId] || 0;
        const w = legWant[routeId];
        legScale[routeId] = w <= room ? 1 : room / w;
      }

      // 3) 실제로 태우고, 도시쌍별로 못 태운 몫을 다음 라운드로 넘긴다.
      let anyServed = false;
      for (const key of keys) {
        const left = leftByPair[key];
        if (left === undefined) continue;
        // 이번 라운드에 열린 후보가 하나도 없었다면 좌석이 어디에도 없다는 뜻이다.
        // spareLeft 는 줄기만 하므로 다음 라운드에도 마찬가지 — 여기서 끝낸다.
        const openDenom = roundDenom[key];
        if (openDenom === undefined) {
          leftByPair[key] = 0;
          continue;
        }
        let served = 0;
        for (const o of candidates.get(key)) {
          if (o.want <= 0) continue;
          const scale = Math.min(
            legScale[o.legA] === undefined ? 1 : legScale[o.legA],
            legScale[o.legB] === undefined ? 1 : legScale[o.legB],
          );
          const take = o.want * scale;
          if (take <= 1e-9) continue;
          spareLeft[o.legA] = (spareLeft[o.legA] || 0) - take;
          spareLeft[o.legB] = (spareLeft[o.legB] || 0) - take;
          o.pax += take;
          served += take;
          accumulate(o, take, addPax, addRev);
        }
        // 좌석이 없어 흘린 몫만 다시 돌린다. "환승하지 않겠다"를 고른 손님까지 재제안하면
        // 라운드를 거듭할수록 바깥 선택지가 무력해진다 (50% 가 93.75% 로).
        const spilled = left - served - left * (outsideByPair[key] / openDenom);
        if (served > 1e-9) anyServed = true;
        leftByPair[key] = spilled <= 1e-9 ? 0 : spilled;
      }
      if (!anyServed) break;
    }
    if (!Object.keys(addPax).length) return base;

    // 배분 단계에서 이미 좌석을 소비했으므로 사후 보정이 없다.
    const out = {};
    for (const id of Object.keys(base)) {
      const o = base[id];
      const p = addPax[id];
      if (p === undefined) {
        out[id] = o;
        continue;
      }
      const rev = addRev[id] || 0;
      out[id] = Object.assign({}, o, {
        connectPax: p,
        connectRevenue: rev,
        pax: o.pax + p,
        revenue: o.revenue + rev,
        loadFactor: o.seats <= 0 ? 0 : Math.min(1, (o.pax + p) / o.seats),
      });
    }
    return out;
  }

  /**
   * 온 노선을 한 번에 푼다 — 직항 시장(1단계) 다음에 허브 환승(2단계).
   *
   * 이 2단계가 노선의 가치를 **네트워크에 의존하게** 만든다. 스포크 하나는 로컬 수요만
   * 보면 적자여도, 허브에서 뻗은 다른 노선에 승객을 물어다 주면 살아난다. 그래서
   * "어디에 허브를 세우고 무엇을 붙일 것인가"가 비로소 판단거리가 된다.
   *
   * @returns 노선 id → 결과
   */
  function resolveAll(routes, ctx) {
    const byPair = new Map();
    for (const r of routes) {
      if (!r.active || r.freq <= 0) continue;
      const key = Cities.pairKey(r.from, r.to);
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(r);
    }
    const base = {};
    // 1단계가 남긴 **진짜 미충족 수요**. 유발 수요가 반영돼 있고, 로컬을 택한 손님은
    // 빠져 있다 — 다시 계산하면 두 단계의 시장 크기가 어긋나고 로컬 손님을 환승에
    // 두 번 파는 셈이 된다.
    const unmetByPair = {};
    for (const key of [...byPair.keys()].sort()) {
      const [aId, bId] = key.split('|');
      const outs = resolvePair(Cities.get(aId), Cities.get(bId), byPair.get(key), ctx);
      if (!outs.length) continue;
      unmetByPair[key] = outs[0].unmet;
      for (const o of outs) base[o.routeId] = o;
    }
    return resolveConnections(routes, base, unmetByPair, ctx);
  }

  root.AirlinerSkyMarket = {
    BALANCE: B,
    bellDeviate,
    fringeUtility,
    localStrength,
    localStrengthLabel,
    allocate,
    resolvePair,
    resolveConnections,
    resolveAll,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
