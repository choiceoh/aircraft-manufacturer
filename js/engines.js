/*
 * 엔진 카탈로그 — 1998~2017년에 실제로 팔리던 민항 엔진.
 *
 * 기체 설계에서 두 번째 축이다. 좋은 엔진은 연비를 크게 올리지만 단가가 비싸고,
 * 갓 나온 엔진은 통합 비용·기간이 늘고 초기 신뢰성이 나쁘다(Trent 1000·PW1100G가
 * 실제로 그랬다). "성숙한 엔진으로 안전하게 갈 것인가, 신형에 걸 것인가"가 핵심 선택.
 *
 * 주의 — eff 는 연비 지수(0~100)에 직접 더해지고, 그 지수는 입찰 점수의 연비 항목으로
 * 들어간다. 유가가 높은 국면에서 가중치가 커지므로 ±3만 움직여도 체감이 크다.
 */
(function (root) {
  'use strict';

  /**
   * eff       : 연비 지수 가산 (기준 0)
   * costMult  : 기체 표준 생산원가 배수
   * riskMult  : 결함 위험 배수 (성숙도 보정 전)
   * devMult   : 개발비 배수 (통합 난이도)
   * timeMult  : 개발기간 배수
   * comfort   : 객실 쾌적성 가산 (터보프롭은 느리고 시끄러워 마이너스)
   * cruise    : 순항속도 (km/h). 적어 둔 엔진만 — 나머지는 급별 기본값을 쓴다
   *             (터보프롭은 제트기의 3분의 2 속도라 가동률과 노선 공급이 통째로 다르다)
   * eis/end   : 신규 채택 가능 구간, 소수 연도
   */
  const ENGINES = [
    // ── 리저널 ──
    { id: 'pw127', maker: 'P&W 캐나다', name: 'PW127 (터보프롭)', segments: ['regional'], eis: 1988, end: null, eff: 9, costMult: 0.9, riskMult: 0.85, devMult: 0.95, timeMult: 0.95, comfort: -9, cruise: 540 },
    { id: 'cf34-3', maker: 'GE', name: 'CF34-3', segments: ['regional'], eis: 1992, end: 2008, eff: -2, costMult: 0.96, riskMult: 0.95, devMult: 1.0, timeMult: 1.0, comfort: 0 },
    { id: 'ae3007', maker: '롤스로이스', name: 'AE 3007', segments: ['regional'], eis: 1996, end: 2016, eff: 1, costMult: 0.98, riskMult: 1.0, devMult: 1.0, timeMult: 1.0, comfort: 0 },
    { id: 'cf34-8', maker: 'GE', name: 'CF34-8', segments: ['regional'], eis: 2001, end: null, eff: 3, costMult: 1.0, riskMult: 1.0, devMult: 1.02, timeMult: 1.0, comfort: 1 },
    { id: 'cf34-10', maker: 'GE', name: 'CF34-10', segments: ['regional'], eis: 2005, end: null, eff: 5, costMult: 1.03, riskMult: 1.02, devMult: 1.04, timeMult: 1.02, comfort: 1 },
    { id: 'sam146', maker: '파워젯', name: 'SaM146', segments: ['regional'], eis: 2011, end: null, eff: 6, costMult: 0.99, riskMult: 1.15, devMult: 1.05, timeMult: 1.03, comfort: 1 },
    { id: 'pw1500g', maker: 'P&W', name: 'PW1500G (기어드 팬)', segments: ['regional'], eis: 2016, end: null, eff: 11, costMult: 1.12, riskMult: 1.3, devMult: 1.15, timeMult: 1.1, comfort: 3 },

    // ── 협동체 ──
    { id: 'jt8d', maker: 'P&W', name: 'JT8D-200', segments: ['narrow'], eis: 1980, end: 2000, eff: -8, costMult: 0.86, riskMult: 0.9, devMult: 0.94, timeMult: 0.95, comfort: -4 },
    { id: 'cfm56-3', maker: 'CFM', name: 'CFM56-3', segments: ['narrow'], eis: 1984, end: 2000, eff: -4, costMult: 0.92, riskMult: 0.9, devMult: 0.96, timeMult: 0.97, comfort: -1 },
    { id: 'v2500', maker: 'IAE', name: 'V2500', segments: ['narrow'], eis: 1989, end: null, eff: 1, costMult: 1.0, riskMult: 0.98, devMult: 1.0, timeMult: 1.0, comfort: 1 },
    { id: 'cfm56-5b', maker: 'CFM', name: 'CFM56-5B', segments: ['narrow'], eis: 1994, end: null, eff: 2, costMult: 1.0, riskMult: 0.95, devMult: 1.0, timeMult: 1.0, comfort: 0 },
    { id: 'cfm56-7b', maker: 'CFM', name: 'CFM56-7B', segments: ['narrow'], eis: 1997, end: null, eff: 3, costMult: 1.01, riskMult: 0.93, devMult: 1.0, timeMult: 1.0, comfort: 0 },
    { id: 'br715', maker: '롤스로이스', name: 'BR715', segments: ['narrow'], eis: 1999, end: 2006, eff: 4, costMult: 1.04, riskMult: 1.05, devMult: 1.03, timeMult: 1.02, comfort: 2 },
    { id: 'leap-1a', maker: 'CFM', name: 'LEAP-1A', segments: ['narrow'], eis: 2016, end: null, eff: 10, costMult: 1.1, riskMult: 1.22, devMult: 1.14, timeMult: 1.08, comfort: 2 },
    { id: 'pw1100g', maker: 'P&W', name: 'PW1100G (기어드 팬)', segments: ['narrow'], eis: 2016, end: null, eff: 11, costMult: 1.11, riskMult: 1.35, devMult: 1.16, timeMult: 1.1, comfort: 3 },

    // ── 광동체 ──
    { id: 'rb211-524', maker: '롤스로이스', name: 'RB211-524', segments: ['wide'], eis: 1977, end: 2003, eff: -6, costMult: 0.9, riskMult: 0.92, devMult: 0.95, timeMult: 0.96, comfort: -2 },
    { id: 'cf6-80c2', maker: 'GE', name: 'CF6-80C2', segments: ['wide'], eis: 1985, end: 2010, eff: -2, costMult: 0.95, riskMult: 0.9, devMult: 0.97, timeMult: 0.98, comfort: 0 },
    { id: 'pw4000', maker: 'P&W', name: 'PW4000', segments: ['wide'], eis: 1987, end: 2012, eff: -1, costMult: 0.97, riskMult: 0.95, devMult: 0.98, timeMult: 0.99, comfort: 0 },
    { id: 'trent700', maker: '롤스로이스', name: 'Trent 700', segments: ['wide'], eis: 1995, end: null, eff: 3, costMult: 1.03, riskMult: 1.0, devMult: 1.02, timeMult: 1.0, comfort: 1 },
    { id: 'ge90', maker: 'GE', name: 'GE90', segments: ['wide'], eis: 1995, end: 2006, eff: 4, costMult: 1.12, riskMult: 1.05, devMult: 1.08, timeMult: 1.04, comfort: 2 },
    { id: 'trent800', maker: '롤스로이스', name: 'Trent 800', segments: ['wide'], eis: 1996, end: 2010, eff: 4, costMult: 1.05, riskMult: 1.0, devMult: 1.03, timeMult: 1.01, comfort: 1 },
    { id: 'trent500', maker: '롤스로이스', name: 'Trent 500', segments: ['wide'], eis: 2002, end: 2011, eff: 4, costMult: 1.05, riskMult: 1.02, devMult: 1.04, timeMult: 1.02, comfort: 1 },
    { id: 'ge90-115b', maker: 'GE', name: 'GE90-115B', segments: ['wide'], eis: 2004, end: null, eff: 6, costMult: 1.15, riskMult: 1.05, devMult: 1.1, timeMult: 1.05, comfort: 2 },
    { id: 'trent900', maker: '롤스로이스', name: 'Trent 900', segments: ['wide'], eis: 2007, end: null, eff: 6, costMult: 1.09, riskMult: 1.12, devMult: 1.08, timeMult: 1.05, comfort: 2 },
    { id: 'genx', maker: 'GE', name: 'GEnx', segments: ['wide'], eis: 2011, end: null, eff: 10, costMult: 1.12, riskMult: 1.2, devMult: 1.12, timeMult: 1.07, comfort: 3 },
    { id: 'trent1000', maker: '롤스로이스', name: 'Trent 1000', segments: ['wide'], eis: 2011, end: null, eff: 10, costMult: 1.11, riskMult: 1.35, devMult: 1.13, timeMult: 1.08, comfort: 3 },
    { id: 'trentxwb', maker: '롤스로이스', name: 'Trent XWB', segments: ['wide'], eis: 2015, end: null, eff: 12, costMult: 1.14, riskMult: 1.15, devMult: 1.14, timeMult: 1.08, comfort: 3 },

    // ── 국산 엔진 (domestic) ──
    //
    // 카탈로그에 있지만 **아무나 못 산다**. `domestic` 이 붙은 엔진은 그 코드를
    // 해금한 회사에게만 보인다(available/resolve 의 domesticIds). 보잉이 PS-90A 로
    // 737을 설계하는 일이 없어야 하고, 무엇보다 이 엔진들을 공용 풀에 그냥 풀면
    // defaultFor 와 문턱 계산이 통째로 흔들린다.
    //
    // 값의 성격은 서방 엔진의 거울상이다: 싸고 공급이 안전한 대신 연비가 처지고
    // 초기 신뢰성이 나쁘다. PS-90A 가 실제로 CFM56 대비 그랬고, 그래서 Tu-204 는
    // 국내선에서 버티고 수출에서는 밀렸다.
    { id: 'ps90a', maker: 'UEC', name: 'PS-90A', segments: ['narrow', 'wide'], eis: 1992, end: null, eff: -2, costMult: 0.84, riskMult: 1.12, devMult: 0.98, timeMult: 1.0, comfort: -1, domestic: 'uec' },
    { id: 'd436', maker: 'UEC', name: 'D-436', segments: ['regional'], eis: 1999, end: null, eff: -1, costMult: 0.86, riskMult: 1.1, devMult: 0.98, timeMult: 1.0, comfort: -1, domestic: 'uec' },

    // ── 국산 2세대 (PD) ──
    //
    // 1세대가 "싼 대신 처지는" 거울상이라면, 2세대는 그 거래를 **되사 오는** 쪽이다.
    // 연비가 서방 동시대와 겨룰 수준으로 올라오고, 대신 1세대의 깊은 원가 우위를
    // 거의 다 반납한다(0.84 → 0.96). 새 코어라 초기 신뢰성도 다시 나빠진다.
    //
    // 원가를 서방 가까이 올려 둔 것은 밸런스이기도 하다. 싸면서 연비까지 좋으면
    // 해금한 회사에게 **다른 선택지가 없어진다**(CFM56-7B 는 1.01 에 연비 3이다).
    // 지금은 조금 싸고 조금 낫되 초기 신뢰성이 나쁘고 선호 공급사 감점을 상시로
    // 문다 — 여전히 양방향이다.
    //
    // **연대는 역사가 아니다.** 실제 PD-14 는 2024년 취항이고 PD-35 는 아직도
    // 개발 중이다. 게임 창(1998~2017) 안에서 닿을 수 있는 목표로 만들려고 앞당겼다 —
    // 러시아 엔진 개발이 10여 년 빨랐다면 어땠을까 하는 대체 역사다. 그 대신
    // **1세대를 지나온 회사만** 이 사업을 열 수 있고, 착수 가능 시점도 취항에서
    // 개발 기간만큼 거슬러 올라간 해로 막아 둔다.
    { id: 'pd14', maker: 'UEC', name: 'PD-14', segments: ['narrow'], eis: 2012, end: null, eff: 4, costMult: 0.96, riskMult: 1.18, devMult: 1.06, timeMult: 1.03, comfort: 1, domestic: 'uec' },
    { id: 'pd8', maker: 'UEC', name: 'PD-8', segments: ['regional'], eis: 2013, end: null, eff: 4, costMult: 0.95, riskMult: 1.16, devMult: 1.04, timeMult: 1.02, comfort: 1, domestic: 'uec' },
    { id: 'pd35', maker: 'UEC', name: 'PD-35', segments: ['wide'], eis: 2014, end: null, eff: 5, costMult: 0.98, riskMult: 1.2, devMult: 1.08, timeMult: 1.05, comfort: 1, domestic: 'uec' },
  ];

  const BY_ID = Object.fromEntries(ENGINES.map((e) => [e.id, e]));

  /** 성숙도가 오르는 데 걸리는 연수 — 그 전까지는 초기 결함 위험이 얹힌다. */
  const MATURITY_YEARS = 3;

  /**
   * 취항 직후 엔진의 추가 위험 배수. 취항 해에 +45%, MATURITY_YEARS 뒤 0%.
   * 신형 엔진을 처음 다는 기체가 실제로 겪는 초기 트러블을 값으로 옮긴 것.
   */
  function maturityRisk(eng, year) {
    if (!year) return 1;
    const age = year - eng.eis;
    if (age >= MATURITY_YEARS) return 1;
    return 1 + 0.45 * (1 - Math.max(0, age) / MATURITY_YEARS);
  }

  /**
   * 런칭 파트너는 정식 취항 몇 년 전에 엔진을 받는다 — A320neo 런치 커스터머가
   * LEAP·GTF 를 남들보다 먼저 단 것이 이것이다. 성숙도 위험은 실제 eis 기준
   * 그대로 계산한다: 일찍 쓰는 만큼 초기 트러블도 온전히 먼저 겪는다.
   */
  const EARLY_ACCESS_YEARS = 2;

  /**
   * 국산 엔진은 해금한 회사만 쓴다. 공용 풀에 그냥 두면 보잉이 PS-90A 로 737을
   * 설계하고, defaultFor 가 그걸 집어 기준 밸런스가 통째로 움직인다.
   */
  function unlocked(eng, domesticIds) {
    return !eng.domestic || !!(domesticIds && domesticIds.includes(eng.id));
  }

  function inService(eng, year, earlyIds, domesticIds) {
    if (!unlocked(eng, domesticIds)) return false;
    const early = earlyIds && earlyIds.includes(eng.id) ? EARLY_ACCESS_YEARS : 0;
    return year >= eng.eis - early && (eng.end === null || year < eng.end);
  }

  /** 그 시점 그 세그먼트에서 채택 가능한 엔진들. */
  function available(segment, year, earlyIds, domesticIds) {
    return ENGINES.filter(
      (e) => e.segments.includes(segment) && unlocked(e, domesticIds) && (!year || inService(e, year, earlyIds, domesticIds)),
    );
  }

  /**
   * 지정이 없을 때 쓰는 기본 엔진 — 그 시점에 고를 수 있는 것 중 "성숙하고 무난한" 쪽.
   * 세이브에 엔진이 없던 옛 프로그램과 승계 기종이 이 경로를 탄다.
   */
  function defaultFor(segment, year) {
    // 기본값은 **국산 엔진을 절대 집지 않는다**. 여기서 집히면 엔진을 지정하지 않은
    // 옛 세이브·승계 기종이 해금도 없이 국산 엔진을 달게 된다.
    const pool = available(segment, year);
    if (!pool.length) return ENGINES.find((e) => e.segments.includes(segment) && !e.domestic) || null;
    const mature = pool.filter((e) => maturityRisk(e, year) === 1);
    const from = mature.length ? mature : pool;
    return from.reduce((a, b) => (b.eff > a.eff ? b : a));
  }

  function get(id) {
    return BY_ID[id] || null;
  }

  /** 설계안이 실제로 쓸 엔진을 정한다. 지정이 없거나 그 시점에 못 사면 기본값으로. */
  function resolve(segment, engineId, year, earlyIds, domesticIds) {
    const e = get(engineId);
    // 해금 검사는 **날짜와 별개**다. `!year` 로 날짜를 건너뛰는 경로(연도 없이 부르는
    // 순수 평가)가 해금까지 함께 건너뛰면, 아무나 evaluate({engine:'ps90a'}) 로
    // 국산 엔진을 달 수 있게 된다.
    if (e && e.segments.includes(segment) && unlocked(e, domesticIds) && (!year || inService(e, year, earlyIds, domesticIds))) {
      return e;
    }
    return defaultFor(segment, year);
  }

  root.AirlinerEngines = {
    ENGINES,
    MATURITY_YEARS,
    EARLY_ACCESS_YEARS,
    available,
    defaultFor,
    get,
    resolve,
    inService,
    maturityRisk,
    unlocked,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
