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
      const freq = Math.min(r.freq, cap.maxFreq);
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

  root.AirlinerSkyMarket = {
    BALANCE: B,
    bellDeviate,
    fringeUtility,
    localStrength,
    localStrengthLabel,
    allocate,
    resolvePair,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
