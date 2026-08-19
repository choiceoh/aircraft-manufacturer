/*
 * 기체 형상 — 동체 단면과 날개.
 *
 * 설계 심화의 핵심이다. 기존 기술 슬라이더는 "올리면 다 좋아지고 비싸진다"는
 * 한 방향 다이얼이라, 아무리 늘려도 깊이가 생기지 않는다. 여기 두 축은 **양방향**이다:
 *
 *   동체 단면 — 좁게 많이 태우면 연비·원가가 좋아지고 객실 점수가 떨어진다
 *   날개      — 장거리형은 순항 연비가 좋아지고 이착륙 성능이 나빠진다
 *
 * 어느 쪽도 "정답"이 없고, 어떤 항공사의 어떤 노선을 노리느냐가 답을 정한다.
 */
(function (root) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * 동체 단면 — 한 열에 몇 좌석을 넣는가.
   *
   *   rows      : 이 단면이 감당하는 자연스러운 열 수. 벗어나면 뭉툭하거나 지나치게 길다
   *   comfort   : 객실 쾌적성 가산. 같은 급에서 좌석을 덜 넣을수록 넓고 조용하다
   *   effPerSeat: 좌석당 연비 계수. 같은 동체에 많이 태울수록 좌석당 항력이 준다
   *   costPerSeat: 좌석당 표준원가 계수
   *   devMult   : 단면이 커질수록 개발이 비싸다 (동체 직경은 구조 설계의 출발점)
   */
  const CROSS_SECTIONS = {
    regional: [
      { abreast: 3, name: '3열 (1+2)', rows: [20, 40], comfort: 6, effPerSeat: 0.94, costPerSeat: 1.08, devMult: 0.94 },
      { abreast: 4, name: '4열 (2+2)', rows: [16, 33], comfort: 2, effPerSeat: 1.0, costPerSeat: 1.0, devMult: 1.0 },
      { abreast: 5, name: '5열 (2+3)', rows: [14, 26], comfort: -3, effPerSeat: 1.05, costPerSeat: 0.94, devMult: 1.06 },
    ],
    narrow: [
      { abreast: 5, name: '5열 (2+3)', rows: [24, 44], comfort: 5, effPerSeat: 0.95, costPerSeat: 1.07, devMult: 0.96 },
      { abreast: 6, name: '6열 (3+3)', rows: [20, 40], comfort: 0, effPerSeat: 1.0, costPerSeat: 1.0, devMult: 1.0 },
      { abreast: 7, name: '7열 (2+3+2)', rows: [18, 34], comfort: -5, effPerSeat: 1.04, costPerSeat: 0.95, devMult: 1.08 },
    ],
    wide: [
      { abreast: 7, name: '7열 (2+3+2)', rows: [30, 46], comfort: 8, effPerSeat: 0.93, costPerSeat: 1.09, devMult: 0.95 },
      { abreast: 8, name: '8열 (2+4+2)', rows: [28, 48], comfort: 4, effPerSeat: 0.97, costPerSeat: 1.03, devMult: 1.0 },
      { abreast: 9, name: '9열 (3+3+3)', rows: [26, 50], comfort: -2, effPerSeat: 1.02, costPerSeat: 0.97, devMult: 1.05 },
      { abreast: 10, name: '10열 (3+4+3)', rows: [24, 50], comfort: -7, effPerSeat: 1.06, costPerSeat: 0.93, devMult: 1.11 },
    ],
  };

  /** 세그먼트 기본 단면 — 그 급에서 가장 흔한 배열. */
  const DEFAULT_ABREAST = { regional: 4, narrow: 6, wide: 9 };

  function sectionsFor(segment) {
    return CROSS_SECTIONS[segment] || CROSS_SECTIONS.narrow;
  }

  function section(segment, abreast) {
    const list = sectionsFor(segment);
    return list.find((c) => c.abreast === abreast) || list.find((c) => c.abreast === DEFAULT_ABREAST[segment]) || list[0];
  }

  /**
   * 좌석수가 이 단면에 잘 맞는가 (0~1).
   * 열 수가 자연 범위를 벗어나면 뭉툭한 동체(항력 낭비)거나 지나치게 긴 동체
   * (구조 보강·이륙 시 꼬리 접촉)라 효율이 깎인다.
   */
  function sectionFit(sec, seats) {
    const rows = seats / sec.abreast;
    const [lo, hi] = sec.rows;
    if (rows >= lo && rows <= hi) return 1;
    const off = rows < lo ? (lo - rows) / lo : (rows - hi) / hi;
    return clamp(1 - off * 1.8, 0.45, 1);
  }

  /**
   * 날개 특성 (0~100).
   *   0   = 단거리 특화: 두껍고 넓은 날개. 이착륙이 좋고 가볍고 싸다. 순항 연비는 나쁘다
   *   100 = 장거리 특화: 얇고 긴 고종횡비 날개. 순항 연비가 좋다. 무겁고 비싸고 활주로를 길게 쓴다
   *
   * 항속거리와 짝이 맞아야 한다 — 단거리 노선용 기체에 장거리 날개를 달면
   * 원가만 오르고, 장거리 기체에 단거리 날개를 달면 연료를 태운다.
   */
  function wingProfile(wing, rangeRatio, relief) {
    const w = clamp(wing, 0, 100) / 100;
    // 날개 소재의 경량 여유 (0=알루미늄, 1=전복합재). 고종횡비 날개는 가벼워야
    // 성립한다 — 알루미늄으로 밀어붙이면 구조 중량이 이득을 갉아먹는다.
    const r = clamp(relief === undefined ? 0 : relief, 0, 1);

    // 순항 효율: 장거리형일수록 좋다. 다만 짧은 노선에서는 그 이점을 못 쓴다.
    // 무거운 날개로 종횡비만 올리면 이득의 상당 부분이 중량으로 상쇄된다.
    const heavyPenalty = Math.max(0, w - 0.5) * (1 - r) * 10;
    const cruiseGain = (w - 0.45) * 14 * clamp(rangeRatio, 0.6, 1.4) - heavyPenalty;

    // 이착륙 성능 (0~100): 단거리형일수록 좋다. 항속이 길수록(=무거울수록) 나빠진다.
    const field = clamp(88 - w * 52 - Math.max(0, rangeRatio - 1) * 26 + r * 6, 5, 99);

    // 구조 중량 → 원가·개발비. 고종횡비 날개는 휨하중이 커 구조가 비싸다.
    // 복합재는 그 부담을 덜어 준다(대신 소재 자체가 비싸다 — data.js 쪽에서 청구된다).
    const costMult = 1 + w * 0.1 * (1 - r * 0.45);
    const devMult = 1 + w * 0.14 * (1 - r * 0.4);

    return {
      cruiseGain: Math.round(cruiseGain * 10) / 10,
      field: Math.round(field),
      costMult,
      devMult,
    };
  }

  /**
   * 연료 여유 (0~100) — 설계 항속을 넘는 노선을 위해 탱크·최대이륙중량에 얼마나
   * 여유를 두는가. 세 번째 양방향 축이다.
   *
   *   0   = 설계 임무에 딱 맞춘 기체. 가볍고 싸고 연비가 좋다. 대신 설계 항속을
   *         넘는 순간 태울 수 있는 승객이 급격히 준다
   *   100 = 넉넉한 탱크와 높은 최대이륙중량. 감톤하면 훨씬 멀리 간다. 대신 늘
   *         무거운 구조를 지고 다녀 짧은 노선에서 손해다
   *
   * 실제로 A321LR·777-200LR 이 이 선택이다 — 같은 동체에 연료와 MTOW 를 더해
   * 노선 폭을 샀고, 그만큼 단거리 운용에서는 불리했다.
   */
  const DEFAULT_FUEL_MARGIN = 35;

  /**
   * payload-range 곡선.
   *
   *   full  : 만석으로 갈 수 있는 거리(설계 항속)
   *   light : 좌석을 20% 비웠을 때 갈 수 있는 거리
   *
   * 표시용이 아니라 입찰이 실제로 읽는 값이다. 항속이 모자란 기체는 실격이 아니라
   * **승객을 덜 태우고** 그 노선을 뛴다 — 실제 항공사가 하는 일이 그거다.
   */
  function payloadRange(range, wing, fuelMargin) {
    const w = clamp(wing, 0, 100) / 100;
    const m = clamp(fuelMargin === undefined ? DEFAULT_FUEL_MARGIN : fuelMargin, 0, 100) / 100;
    // 장거리형 날개는 연료를 더 싣고, 여유를 둔 설계는 감톤 이득이 더 크다.
    const gain = 1.06 + w * 0.12 + m * 0.34;
    return {
      full: Math.round(range),
      light: Math.round(range * gain),
    };
  }

  /**
   * 그 거리를 뛸 때 실제로 채울 수 있는 좌석 비율 (0~1).
   *
   * 설계 항속 안이면 만석이고, 넘어서면 연료를 더 싣느라 승객을 내린다.
   * full→light 구간에서 20% 를 내리는 기울기를 그대로 연장한다. 절벽이 아니라
   * 경사라, 조금 모자란 기체는 조금 손해를 보고 크게 모자란 기체는 크게 잃는다.
   */
  function seatFactorAt(pr, distance) {
    if (!pr || !(pr.full > 0)) return 1;
    if (!(distance > pr.full)) return 1;
    const span = Math.max(1, pr.light - pr.full);
    // full→light 사이에서 좌석의 20% 를 내린다.
    const factor = 1 - 0.2 * ((distance - pr.full) / span);
    return clamp(factor, 0, 1);
  }

  root.AirlinerAirframe = {
    CROSS_SECTIONS,
    DEFAULT_ABREAST,
    sectionsFor,
    section,
    sectionFit,
    wingProfile,
    payloadRange,
    seatFactorAt,
    DEFAULT_FUEL_MARGIN,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
