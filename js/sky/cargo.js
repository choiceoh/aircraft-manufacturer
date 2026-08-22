/*
 * 화물 — 손님 발밑에 실려 가는 또 하나의 사업.
 *
 * sky-tycoon 의 `core/sim/Cargo.kt` 를 옮겨 왔다. 이 계층을 처음 옮길 때 통째로
 * 잘라냈던 것을 되살린다.
 *
 * **왜 비율이 아니라 모형인가.** 화물을 "여객매출 × 0.13" 으로 두면 광동체를 장거리
 * 무역로에 붙이든 협동체를 관광 노선에 붙이든 화물이 똑같이 따라온다 — 기종 선택에도
 * 노선 선택에도 아무 영향을 못 준다. 실제 벨리 카고는 셋에 달려 있고 셋 다 플레이어가
 * 만지는 손잡이다:
 *
 *   어디로 가는가   화물은 관광지가 아니라 경제·산업 중심지 사이를 흐른다. 수요를
 *                  `standing` 으로 잡는다 — `tour` 는 화물을 만들지 않는다.
 *   무엇으로 가는가  컨테이너가 들어가는 광동체가 협동체의 두 배 반을 싣는다.
 *   얼마나 비었는가  손님 짐이 먼저 들어간다. 만석 노선은 실을 자리가 없다.
 *
 * **이 게임에서 이게 왜 중요한가.** 제조사 계층이 만든 광동체가 항공사 계층에서
 * 값을 하는 자리가 하나 더 생긴다 — 지금까지 광동체는 "좌석이 많고 멀리 가는 기체"
 * 였을 뿐이라, 좌석당 경제성만 보면 협동체를 여러 대 굴리는 쪽이 늘 안전했다.
 *
 * **저쪽과 다르게 둔 것.** sky-tycoon 은 권역별 경기(`regionEconomy`)로 무역을
 * 흔드는데, 이 게임의 세계는 제조사 계층이 굴리고 거기에는 권역별 경기가 없다
 * (`syncWorld` 가 넘기는 것은 유가와 세계 경기 하나뿐이다). 없는 값을 지어내는 대신
 * 세계 경기만 쓴다 — 권역 경기가 생기면 그때 곱하면 된다.
 *
 * 상태를 안 본다. 필요한 조회는 전부 `ctx` 로 받는다 — `js/sky/market.js` 와 같은 규약이다.
 */
(function (root) {
  'use strict';

  const Cities = root.AirlinerCities;
  const Econ = root.AirlinerSkyEconomics;

  const B = {
    /** 규모 상수 — 이 값이 화물 수요 전체의 눈금이다. */
    CARGO_K: 30.0,
    /** 무역량은 두 도시 비중의 곱에서 온다. 지수가 1 보다 작아 거대도시 쌍이 판을 삼키지 않는다. */
    CARGO_TRADE_EXP: 0.62,
    /** 이 거리까지는 거리에 비례해 늘고, 그 위로는 평평하다 (km). */
    CARGO_DIST_REF: 2500.0,
    CARGO_DIST_EXP: 0.85,
    /**
     * 세계 화물 중 **여객기 배로 갈 몫**. 나머지는 화물 전용사와 해운이 가져간다.
     * 이게 없으면 큰 기체 몇 대로 그 구간 화물을 통째로 쓸어 담는다.
     */
    CARGO_ADDRESSABLE: 0.55,
    /** 좌석당 벨리 용적 (톤). 광동체는 바닥 아래에 컨테이너가 들어간다. */
    CARGO_TONS_PER_SEAT: 0.022,
    CARGO_TONS_PER_SEAT_WIDE: 0.055,
    /** 만석일 때 손님 짐이 먹는 벨리 비율. */
    CARGO_BAGGAGE_SHARE: 0.55,
    /** 톤·km 단가와 그 거리 체감. */
    CARGO_YIELD_PER_TON_KM: 0.62,
    CARGO_YIELD_DIST_EXP: 0.82,
  };

  /** 이 기종이 한 편에 실을 수 있는 화물 (톤). */
  function bellyTons(type) {
    if (!type) return 0;
    const perSeat = type.widebody ? B.CARGO_TONS_PER_SEAT_WIDE : B.CARGO_TONS_PER_SEAT;
    // 초음속기는 동체가 가늘고 연료가 무거워 화물을 거의 못 싣는다.
    const supersonic = (type.speed || 0) > 1500 ? 0.25 : 1;
    return type.seats * perSeat * supersonic;
  }

  /**
   * 도시쌍의 분기 화물 수요 (톤).
   *
   * 여객과 달리 **거리가 멀수록 유리하다** — 짧은 구간은 트럭이 가져간다.
   *
   * @param ctx {economy, dev} — `dev(cityId)` 는 그 도시의 성장 누적치.
   */
  function quarterlyTons(fromId, toId, ctx) {
    const a = Cities.get(fromId);
    const b = Cities.get(toId);
    if (!a || !b) return 0;
    const dist = Cities.distance(fromId, toId);
    const trade = Math.pow(a.standing * b.standing, B.CARGO_TRADE_EXP);
    const distFactor = Math.pow(Math.min(1, dist / B.CARGO_DIST_REF), B.CARGO_DIST_EXP);
    const dev = ctx.dev || (() => 1);
    const growth = Math.sqrt(Math.max(0.01, dev(fromId) * dev(toId)));
    return B.CARGO_K * trade * distFactor * (ctx.economy === undefined ? 1 : ctx.economy) * growth;
  }

  /**
   * 이 노선이 이번 분기에 내놓는 화물 적재 여력 (톤).
   *
   * 손님 짐이 먼저 들어간다 — 많이 태울수록 남는 자리가 준다. 여객으로 꽉 찬 노선이
   * 화물까지 쓸어 담지는 못한다는 뜻이고, 그래서 화물은 큰 기체를 **여유 있게**
   * 굴리는 쪽에 붙는다.
   *
   * 짐을 미는 것은 **탑승률이 아니라 사람 수**다. 이 게임에는 아직 객실 등급이 없어
   * 지금은 둘이 같지만, 등급이 들어오면 갈린다 — 비즈니스를 크게 깔면 총 좌석이 줄어
   * 같은 인원에도 탑승률이 오르는데 벨리 용적은 기체 크기가 정하는 것이라 그대로다.
   * 그때 탑승률로 재고 있으면 **객실 배치만 다르다는 이유로** 화물 여력이 달라진다.
   * 지금부터 물리 좌석으로 재 둔다.
   */
  function capacityTons(planes, freq, distanceKm, pax, typeOf) {
    if (!planes || !planes.length || freq <= 0) return 0;
    const legs = Econ.quarterlyLegs(freq);
    const shares = Econ.legShares(planes, distanceKm, typeOf);
    let tons = 0;
    for (let i = 0; i < planes.length; i++) {
      tons += bellyTons(typeOf(planes[i].typeId)) * legs * shares[i];
    }
    const physicalSeats = Econ.quarterlySeats(freq, Econ.capacity(planes, distanceKm, typeOf).avgSeats);
    const load = physicalSeats <= 0 ? 0 : Math.max(0, Math.min(1, pax / physicalSeats));
    const baggage = Math.min(0.95, B.CARGO_BAGGAGE_SHARE * load);
    return tons * (1 - baggage);
  }

  /** 톤당 운임 — 거리에 비례하되 장거리일수록 톤·km 단가는 떨어진다. */
  function revenuePerTon(distanceKm, inflation) {
    const inf = inflation === undefined ? 1 : inflation;
    return B.CARGO_YIELD_PER_TON_KM * Math.pow(distanceKm, B.CARGO_YIELD_DIST_EXP) * inf;
  }

  /**
   * 도시쌍 하나의 화물 배분 — 노선 id → 이번 분기 화물 매출.
   *
   * 화주는 브랜드를 보지 않는다. 자리가 있는 곳에 싣는다. 그래서 적재 여력에 비례해
   * 나누고, 수요가 여력보다 적으면 그만큼만 채운다. 여객처럼 로짓으로 갈라도 되지만
   * 그러면 서비스 등급 같은 여객 손잡이가 화물까지 좌우해 화물이 여객의 그림자로
   * 되돌아간다 — 되살리는 이유가 사라진다.
   */
  function allocate(fromId, toId, capacity, ctx) {
    const ids = Object.keys(capacity);
    if (!ids.length) return {};
    let supply = 0;
    for (const id of ids) supply += capacity[id];
    if (supply <= 0) return {};
    const dist = Cities.distance(fromId, toId);
    const demand = quarterlyTons(fromId, toId, ctx) * B.CARGO_ADDRESSABLE;
    const carried = Math.min(demand, supply);
    const perTon = revenuePerTon(dist, ctx.inflation);
    const out = {};
    for (const id of ids) out[id] = carried * (capacity[id] / supply) * perTon;
    return out;
  }

  /**
   * 판 전체의 화물을 푼다 (노선 id → 이번 분기 화물 매출).
   *
   * **여객이 먼저 풀린 뒤에 부른다** — 빈자리가 얼마인지 알아야 실을 양이 정해진다.
   *
   * 같은 구간의 다른 항공사까지 한 번에 넣어야 맞는다. 화물은 그 구간의 적재 여력을
   * 나눠 갖는 것이라, 한 회사만 넣고 돌리면 경쟁자 몫까지 제 것으로 잡는다.
   *
   * @param ctx {typeOf, flyingOn, economy, inflation, dev}
   */
  function resolveAll(routes, outcomes, ctx) {
    const byPair = {};
    for (const r of routes) {
      if (!r.active || r.freq <= 0) continue;
      if (!outcomes[r.id]) continue;
      const key = Cities.pairKey(r.from, r.to);
      (byPair[key] || (byPair[key] = [])).push(r);
    }
    const out = {};
    for (const key of Object.keys(byPair)) {
      const list = byPair[key];
      const fromId = list[0].from;
      const toId = list[0].to;
      const dist = Cities.distance(fromId, toId);
      const capacity = {};
      for (const r of list) {
        const o = outcomes[r.id];
        if (!o || o.seats <= 0) continue;
        const planes = ctx.flyingOn(r.id);
        if (!planes.length) continue;
        const freq = Math.min(r.freq, Econ.capacity(planes, dist, ctx.typeOf).maxFreq);
        const tons = capacityTons(planes, freq, dist, o.pax, ctx.typeOf);
        if (tons > 0) capacity[r.id] = tons;
      }
      const share = allocate(fromId, toId, capacity, ctx);
      for (const id of Object.keys(share)) out[id] = share[id];
    }
    return out;
  }

  /** 화면에 쓰는 도시쌍 화물 수요 (톤) — 여객기가 노려볼 수 있는 몫만. */
  function demandTons(fromId, toId, ctx) {
    return quarterlyTons(fromId, toId, ctx) * B.CARGO_ADDRESSABLE;
  }

  root.AirlinerSkyCargo = {
    BALANCE: B,
    bellyTons,
    quarterlyTons,
    capacityTons,
    revenuePerTon,
    allocate,
    resolveAll,
    demandTons,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
