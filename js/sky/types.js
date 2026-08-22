/*
 * 기종 어댑터 — 두 게임이 실제로 맞물리는 자리.
 *
 * 항공사 계층(sky-tycoon 이식분)이 기체에 요구하는 것은 열 가지다:
 *   좌석 · 항속 · 순항속도 · 값 · 연료(L/km) · 정비비($/블록시간) · 승무원비($/블록시간)
 *   · 지상조업(편도 시간) · 브랜드 가산 · 광동체 여부
 *
 * 이 게임의 기체는 두 곳에서 온다.
 *   1. 경쟁 제조사 카탈로그 (`js/fleet.js`) — 실존 기종
 *   2. 플레이어가 설계한 프로그램 (`s.programs`)
 * 둘 다 여기서 같은 모양으로 나간다. 항공사 계층은 어느 쪽인지 몰라도 된다.
 *
 * ── 값(price)에 대하여 ──
 *
 * sky-tycoon 은 기체 값을 좌석×항속 기울기로 매기고, 이 게임은 좌석^0.95 × 항속^0.34 ×
 * 기술로 매긴다. 같은 제원에 두 값의 비를 재 보면 0.29~0.73 으로 흩어진다 — **환율
 * 하나로 누를 수 없다.** 단일 환율을 쓰면 광동체가 sky 기준보다 상대적으로 두 배
 * 비싸져 장거리 노선이 회수 기간을 못 맞추고, 장거리 게임이 통째로 죽는다.
 *
 * 그래서 **기체 값은 이 게임 것을 그대로 쓴다.** 기체 값을 정하는 것이 이 게임의
 * 본체이므로 그쪽이 기준이어야 하고, 항공사 쪽 운임·원가를 거기에 맞춘다
 * (`js/sky/economics.js` 의 FARE_SCALE — 노선 마진이 sky 의 목표 밴드에 들도록 잡는다).
 *
 * ── 유도식의 정확도 ──
 *
 * 좌석·급·세대만으로 연료·정비·승무원·조업시간을 낸다. sky-tycoon 이 손으로 적어 둔
 * 24개 기종과 대조하면 1980년 이후 구간에서 평균 오차가 연료 9.9% · 정비 9.9% ·
 * 승무원 5.8% · 조업 8.4% · 속도 1.3% 다. 그 대조는 세대 지수를 **연도에서 어림한**
 * 값으로 잰 것이라 상한이다 — 여기서는 실제 연비 지수를 쓰므로 더 가깝다.
 */
(function (root) {
  'use strict';

  const Fleet = root.AirlinerFleet;
  const Design = root.AirlinerDesign;

  /**
   * 순항속도 (km/h) — sky 카탈로그가 급별로 거의 상수다.
   * 다만 터보프롭은 같은 리저널기라도 절반 가까이 느리므로, 카탈로그가 `cruise` 를
   * 적어 둔 기종은 그 값을 쓴다 (ATR 511~556, Q400 667).
   */
  const SPEED = { regional: 815, narrow: 840, wide: 895 };

  /** 좌석당 연료 (L/km). 세대 지수로 나눈다 — 좋은 엔진일수록 덜 먹는다. */
  const FUEL_PER_SEAT = { regional: 0.0175, narrow: 0.0168, wide: 0.0242 };

  /** 좌석당 정비비 ($/블록시간). 역시 세대를 탄다. */
  const MAINT_PER_SEAT = { regional: 2.9, narrow: 2.7, wide: 3.2 };

  /** 승무원비 = 기본 + 좌석당. 세대와 무관하다 — 사람 값은 기술로 안 준다. */
  const CREW = { regional: [250, 1.3], narrow: [250, 1.2], wide: [230, 2.1] };

  /** 편도 지상조업 시간 = 기본 + 좌석당. 큰 기체일수록 오래 세워 둔다. */
  const TURN = { regional: [0.3, 0.0019], narrow: [0.3, 0.0019], wide: [0.45, 0.0028] };

  /**
   * 브랜드 가산 — 상징적인 기재일수록 승객이 알아본다.
   * 크고 새로울수록 높다. sky 는 DC-9 1 에서 A380 20 까지 매겼다.
   */
  function prestigeOf(seats, wide, gen) {
    const size = Math.sqrt(seats / 100);
    return Math.round(Math.max(1, size * (wide ? 7 : 4) * Math.max(0.6, gen)) * 10) / 10;
  }

  /**
   * 세대 지수 — 1.0 이 1998년 협동체(737-800)다.
   *
   * 경쟁 기종은 카탈로그의 `eff` 가 이미 이 척도다. 플레이어 프로그램은 설계 평가의
   * `efficiency`(5~99)를 같은 척도로 옮긴다: 1998년 협동체 기준 설계가 대략 50이다.
   */
  const PROGRAM_EFF_BASE = 50;

  function programGen(p) {
    return Math.max(0.6, Math.min(1.45, (p.efficiency || PROGRAM_EFF_BASE) / PROGRAM_EFF_BASE));
  }

  function build(o) {
    const seg = o.segment;
    const wide = seg === 'wide';
    const gen = Math.max(0.5, o.gen);
    const [crewBase, crewPerSeat] = CREW[seg];
    const [turnBase, turnPerSeat] = TURN[seg];
    return {
      id: o.id,
      name: o.name,
      maker: o.maker,
      segment: seg,
      widebody: wide,
      seats: o.seats,
      range: o.range,
      speed: o.speed || SPEED[seg],
      /** 달러. 이 게임의 정가($M)를 그대로 옮긴다 — 위 주석 참고. */
      price: o.priceMusd * 1e6,
      fuel: round3((o.seats * FUEL_PER_SEAT[seg]) / gen),
      maint: Math.round((o.seats * MAINT_PER_SEAT[seg]) / gen),
      crew: Math.round(crewBase + o.seats * crewPerSeat),
      turn: round3(turnBase + o.seats * turnPerSeat),
      prestige: prestigeOf(o.seats, wide, gen),
      /** 이 기종을 살 수 있는 구간 (소수 연도). */
      eis: o.eis,
      end: o.end,
      /** 우리가 만든 것인가 — 자사 기체를 굴리는 항공사에 붙는 이야기가 여기서 갈린다. */
      own: !!o.own,
    };
  }

  function round3(x) {
    return Math.round(x * 1000) / 1000;
  }

  /**
   * 경쟁 제조사 기종 → 항공사 계층이 쓰는 모양.
   *
   * 값은 이 게임의 설계 평가기로 매긴다. 경쟁 기종에만 따로 가격표를 두면 플레이어
   * 기체와 다른 자로 재는 셈이 되어, 같은 제원인데 값이 다른 일이 생긴다.
   */
  function fromRival(a, evaluate) {
    const ev = evaluate({
      segment: a.segment,
      seats: a.seats,
      range: a.range,
      tech: techFromEis(a.eis),
      material: 'aluminum',
      year: a.eis,
    });
    return build({
      id: a.id,
      name: a.name,
      maker: (Fleet.MAKER_BY_ID[a.maker] || {}).name || a.maker,
      segment: a.segment,
      seats: a.seats,
      range: a.range,
      speed: a.cruise,
      priceMusd: unclampPrice(ev, a.seats, a.range),
      gen: a.eff,
      eis: a.eis,
      end: a.end,
    });
  }

  /**
   * 세그먼트 한계 밖 제원의 정가를 되돌린다.
   *
   * `evaluate` 는 좌석·항속을 급별 한계로 자른 뒤 값을 매긴다 — 플레이어는 그 한계 안에서만
   * 설계하므로 문제가 없지만, 실존 기종은 한계를 넘는다(A380 525석을 480석 값으로, 767-200ER
   * 181석을 광동체 하한 230석 값으로 매기는 식). 57개 중 12개가 그렇다. 자르기 전후의 비를
   * 정가와 같은 지수로 되돌려, 값이 실제 제원을 따르게 한다.
   */
  function unclampPrice(ev, seats, range) {
    const e = Design.LIST_PRICE_EXP;
    return ev.listPrice * Math.pow(seats / ev.seats, e.seats) * Math.pow(range / ev.range, e.range);
  }

  /**
   * 취항 연도로 기술 수준을 어림한다 — 2017년 설계가 1998년 설계보다 앞서야
   * 값과 성능이 시대를 탄다. 1998년을 50, 2017년을 82로 둔다.
   */
  function techFromEis(eis) {
    const y = Math.max(1988, Math.min(2020, eis));
    return Math.round(50 + (y - 1998) * 1.7);
  }

  /** 플레이어가 만든 기종 → 같은 모양. 인증을 마친 프로그램만 팔 수 있다. */
  function fromProgram(p, companyName) {
    return build({
      id: p.id,
      name: p.name,
      maker: companyName,
      segment: p.segment,
      seats: p.seats,
      range: p.range,
      priceMusd: p.listPrice,
      gen: programGen(p),
      eis: null, // 인증 시점은 프로그램이 들고 있다 (certTurn)
      end: null,
      own: true,
    });
  }

  root.AirlinerSkyTypes = {
    SPEED,
    FUEL_PER_SEAT,
    MAINT_PER_SEAT,
    CREW,
    TURN,
    PROGRAM_EFF_BASE,
    techFromEis,
    fromRival,
    fromProgram,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
