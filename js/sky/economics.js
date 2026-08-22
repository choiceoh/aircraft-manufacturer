/*
 * 노선 채산 — 운임과 원가.
 *
 * sky-tycoon 의 `core/sim/Economics.kt` 를 옮겨 왔다. 잘라낸 것: 화물, 리스료,
 * 객실 배치(비즈니스 좌석), 부대사업 정비 할인, 난이도 배수. 남긴 것은 노선 하나가
 * 뜨고 내리는 데 실제로 드는 값이다.
 *
 * 상태를 안 본다 — 필요한 것은 전부 인자로 받는다. 기종은 `typeOf(typeId)` 로 찾는데,
 * 이 게임의 기체가 경쟁 카탈로그와 플레이어 프로그램 두 곳에서 오기 때문이다
 * (`js/sky/types.js`).
 */
(function (root) {
  'use strict';

  const Cities = root.AirlinerCities;

  const B = {
    /**
     * 표준 편도 이코노미 운임 = 기본 + 거리요금.
     *
     * 착륙료·회항처럼 **거리를 안 타는 원가**가 많아서 기본요금이 없으면 짧은 노선일수록
     * 고정비를 못 건진다. 그래서 단거리는 편수를 욕심내면 바로 적자로 넘어간다.
     */
    FARE_BASE: 48,
    FARE_PER_KM: 0.0275,
    FARE_DIST_EXP: 1.02,
    FARE_MIN_MUL: 0.55,
    FARE_MAX_MUL: 1.8,
    /**
     * 운임 척도 — sky 쪽 돈을 이 게임의 돈으로 옮기는 **유일한** 배수.
     *
     * 두 게임은 기체 값의 **모양**이 달라 환율 하나로 못 누른다(`js/sky/types.js` 참고).
     * 기체 값을 이 게임 것으로 두기로 했으므로, 대신 sky 쪽 돈 전부 — 운임·운항 원가·
     * 간접비·슬롯 임차료·노선 개설비 — 를 이 배수로 옮긴다. 매출만 옮기면 마진이
     * 척도만큼 부풀고, 원가만 옮기면 그 반대다. **한 군데서만** 곱해야 한다.
     *
     * 기체 값만 이 배수 밖에 있다. 그래서 이 값이 정하는 것은 마진이 아니라
     * **기체 값 대비 노선 수익의 크기** — 즉 회수 기간이다.
     *
     * 값은 노선망 AI 를 붙인 뒤 다섯 시드 × 20년으로 재서 잡았다. 0.15 에서 자기자본이
     * 20년에 중앙 1.8배(사분위 1.4~2.2, 최대 3.4)로 늘고 열둘 중 0.6곳이 접힌다 —
     * 성장이 실재하되 아무도 돈을 찍지 못하는 자리다. 0.35 를 넘기면 상위 회사가
     * 18배까지 뛰어 판이 한쪽으로 굳고, 0.08 아래면 아무도 자라지 못한다.
     */
    FARE_SCALE: 0.15,

    WEEKS_PER_QUARTER: 13,
    /** 한 대가 주당 실제로 날 수 있는 시간 */
    MAX_WEEKLY_HOURS: 98,
    /** 지상 조업에 더 붙는 여유 */
    TURNAROUND_EXTRA: 0.35,
    /** 활주·유도 시간 — 블록타임에 붙는다 */
    BLOCK_TAXI: 0.25,

    LANDING_BASE: 1000,
    NAV_PER_KM: 0.03,
    PAX_SERVICE_BASE: 5.5,
    PAX_SERVICE_PER_LEVEL: 2.2,
    /** 판매·유통비 — 매출에 비례한다 */
    DISTRIBUTION_RATE: 0.24,
    /** 기체가 늙을수록 정비비가 는다 (분기당) */
    AGE_MAINT_PER_QUARTER: 0.012,

    /** 수익 계수 — 출장객이 관광객의 두 배를 낸다 */
    BIZ_YIELD: 1.9,
    LEI_YIELD: 0.95,
  };

  /** 표준 편도 이코노미 운임 (그 시점 명목 달러). */
  function standardFare(distanceKm, inflation) {
    const inf = inflation === undefined ? 1 : inflation;
    return (B.FARE_BASE + B.FARE_PER_KM * Math.pow(distanceKm, B.FARE_DIST_EXP)) * inf * B.FARE_SCALE;
  }

  /** 왕복 1회에 기재가 묶이는 시간 — 편수 상한을 정한다. */
  function roundTripHours(type, distanceKm) {
    return 2 * (distanceKm / type.speed + type.turn + B.TURNAROUND_EXTRA);
  }

  /** 편도 블록타임 — 승무원비·정비비가 이 시간에 붙는다. */
  function blockHoursPerLeg(type, distanceKm) {
    return distanceKm / type.speed + B.BLOCK_TAXI;
  }

  /** 이 기종으로 이 거리를 날 수 있나 (항속 + 여유 5%). */
  function canFly(type, distanceKm) {
    return type.range >= distanceKm * 1.05;
  }

  /**
   * 노선에 투입된 기재가 만들어내는 수송력.
   *
   * **항속이 모자란 기체는 여기서 빠진다.** 명령 계층이 이미 막고 있지만, 수송력을 재는
   * 쪽이 스스로 확인하지 않으면 그 검사를 우회한 경로(옛 세이브, 손으로 넣은 노선)가
   * 곧바로 좌석과 수입을 만든다 — 5,950km 짜리 A321 이 8,817km 태평양에서 분기
   * 19,240석을 내놓는 것을 실제로 봤다.
   */
  /**
   * 이 거리를 실제로 날 수 있는 기재만 남긴다.
   *
   * **수송력·원가·비행시간이 모두 같은 목록을 봐야 한다.** 수송력에서만 걸러 냈더니,
   * 못 나는 기체가 원가와 정비시간을 나눠 가져갔다 — 도쿄–LA 에 ATR 한 대를 섞으면
   * 그 기체가 분기 697시간을 적립하고 노선 원가가 33% 싸졌다.
   */
  function flyable(planes, distanceKm, typeOf) {
    return planes.filter((p) => canFly(typeOf(p.typeId), distanceKm));
  }

  function capacity(planes, distanceKm, typeOf) {
    const able = flyable(planes, distanceKm, typeOf);
    if (!able.length) return { maxFreq: 0, avgSeats: 0, minRange: 0, avgAgeQuarters: 0, usable: false };
    let freqSum = 0;
    let seatWeighted = 0;
    let minRange = Infinity;
    let ageSum = 0;
    for (const p of able) {
      const t = typeOf(p.typeId);
      const perPlane = B.MAX_WEEKLY_HOURS / roundTripHours(t, distanceKm);
      freqSum += perPlane;
      seatWeighted += perPlane * t.seats;
      if (t.range < minRange) minRange = t.range;
      ageSum += p.ageQuarters;
    }
    const maxFreq = Math.floor(freqSum);
    return {
      maxFreq,
      avgSeats: freqSum <= 0 ? 0 : seatWeighted / freqSum,
      minRange: minRange === Infinity ? 0 : minRange,
      avgAgeQuarters: ageSum / able.length,
      usable: maxFreq > 0,
    };
  }

  /**
   * 이 노선이 **이번 분기에 실제로 뜨는** 주간 왕복 편수.
   *
   * 시장·원가·정비시간이 각자 이 값을 다시 세면 서로 어긋난다. 실제로 어긋났다: 시장은
   * 기재 한계로 잘라 좌석을 내놓는데 원가는 설정된 편수 그대로 청구해, 중정비로 기체가
   * 빠진 분기마다 멀쩡한 노선이 적자로 뒤집혔다. 한 군데서 답한다.
   *
   * `closed` 는 양끝 공항 중 하나라도 폐쇄된 경우다 — 그때는 아예 안 뜬다. 수요만 0 으로
   * 두면 빈 비행기가 연료·승무원·착륙료를 그대로 물며 계속 난다.
   */
  function effectiveFreq(route, planes, distanceKm, typeOf, closed) {
    if (closed || !route.active || route.freq <= 0 || !planes.length) return 0;
    return Math.min(route.freq, capacity(planes, distanceKm, typeOf).maxFreq);
  }

  /** 분기 총 공급 좌석 (편도 편수 × 좌석). */
  function quarterlySeats(freq, avgSeats) {
    return freq * 2 * B.WEEKS_PER_QUARTER * avgSeats;
  }

  /** 분기 총 편도 운항 횟수. */
  function quarterlyLegs(freq) {
    return freq * 2 * B.WEEKS_PER_QUARTER;
  }

  /**
   * 편수를 기재들이 나눠 가지는 몫 (합이 1).
   *
   * 기종마다 한 바퀴에 묶이는 시간이 달라 빠른 기재가 더 많은 편을 가져간다.
   * **원가 안분과 정비시간 적립이 같은 몫을 써야 한다** — 따로 세면 연료비를 많이 낸
   * 기체가 정비는 덜 받은 것으로 잡혀 점검 주기가 원가와 어긋난다.
   */
  function legShares(planes, distanceKm, typeOf) {
    const raw = planes.map((p) =>
      canFly(typeOf(p.typeId), distanceKm) ? B.MAX_WEEKLY_HOURS / roundTripHours(typeOf(p.typeId), distanceKm) : 0,
    );
    const sum = raw.reduce((a, b) => a + b, 0);
    if (sum <= 0) return raw.map(() => 0);
    return raw.map((x) => x / sum);
  }

  /** 이 노선에서 각 기재가 이번 분기에 쌓는 블록타임 (기재 id → 시간). */
  function blockHoursByPlane(planes, freq, distanceKm, typeOf) {
    if (!planes.length || freq <= 0) return {};
    const legs = quarterlyLegs(freq);
    const shares = legShares(planes, distanceKm, typeOf);
    const out = {};
    planes.forEach((p, i) => {
      out[p.id] = blockHoursPerLeg(typeOf(p.typeId), distanceKm) * legs * shares[i];
    });
    return out;
  }

  /**
   * 노선 하나의 분기 운항 원가.
   *
   * @param ctx {typeOf, oil, inflation, serviceLevel, pax, revenue}
   */
  function routeCost(route, planes, ctx) {
    if (!planes.length || route.freq <= 0) return zeroCost();
    const from = Cities.get(route.from);
    const to = Cities.get(route.to);
    const dist = Cities.distance(route.from, route.to);
    // **여기서 스스로 자른다.** 부르는 쪽이 자르기를 기대하면 언젠가 한 곳이 빠뜨리고,
    // 그러면 시장이 내놓지도 않은 편에 연료와 승무원 값이 붙는다.
    const freq = effectiveFreq(route, planes, dist, ctx.typeOf, ctx.closed);
    if (freq <= 0) return zeroCost();
    const legs = quarterlyLegs(freq);
    const inflation = ctx.inflation === undefined ? 1 : ctx.inflation;
    const oil = ctx.oil === undefined ? 1 : ctx.oil;
    const shares = legShares(planes, dist, ctx.typeOf);
    if (shares.reduce((a, b) => a + b, 0) <= 0) return zeroCost();

    let fuel = 0;
    let crew = 0;
    let maint = 0;
    let landingSeats = 0;
    planes.forEach((p, i) => {
      const t = ctx.typeOf(p.typeId);
      const myLegs = legs * shares[i];
      const block = blockHoursPerLeg(t, dist) * myLegs;
      fuel += myLegs * dist * t.fuel * oil;
      crew += block * t.crew * inflation;
      maint += block * t.maint * inflation * (1 + p.ageQuarters * B.AGE_MAINT_PER_QUARTER);
      landingSeats += myLegs * t.seats;
    });

    const feeAvg = (from.fee + to.fee) / 2;
    const landing = B.LANDING_BASE * feeAvg * (landingSeats / 150) * inflation;
    const nav = legs * dist * B.NAV_PER_KM * inflation;
    const service = (ctx.serviceLevel || 1) + (route.serviceExtra || 0);
    const paxService = (ctx.pax || 0) * (B.PAX_SERVICE_BASE + B.PAX_SERVICE_PER_LEVEL * service) * inflation;
    const distribution = (ctx.revenue || 0) * B.DISTRIBUTION_RATE;

    // 운임 척도를 올리면 매출만 커지고 원가는 그대로다 — 그러면 마진이 척도만큼
    // 부풀어 잰 의미가 없다. 거리·시간에 붙는 실물 원가에도 같은 척도를 건다.
    const scale = B.FARE_SCALE;
    return sumCost({
      fuel: fuel * scale,
      crew: crew * scale,
      maint: maint * scale,
      landing: landing * scale,
      nav: nav * scale,
      paxService: paxService * scale,
      distribution,
    });
  }

  function zeroCost() {
    return sumCost({ fuel: 0, crew: 0, maint: 0, landing: 0, nav: 0, paxService: 0, distribution: 0 });
  }

  function sumCost(c) {
    c.total = c.fuel + c.crew + c.maint + c.landing + c.nav + c.paxService + c.distribution;
    return c;
  }

  root.AirlinerSkyEconomics = {
    BALANCE: B,
    standardFare,
    roundTripHours,
    blockHoursPerLeg,
    canFly,
    flyable,
    capacity,
    quarterlySeats,
    quarterlyLegs,
    legShares,
    blockHoursByPlane,
    routeCost,
    effectiveFreq,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
