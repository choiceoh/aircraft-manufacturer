/*
 * 정적 밸런스 데이터. 모든 금액 단위는 M$(백만 달러), 기간 단위는 분기.
 * 여기 숫자만 만져도 게임 난이도가 바뀌도록 로직(engine)과 분리해 둔다.
 */
(function (root) {
  'use strict';

  const CONFIG = {
    startYear: 1998,
    totalTurns: 80, // 20년
    startCash: 4200,
    startDebt: 1500,
    startReputation: 48,
    startEngineers: 3400,
    maxDebt: 14000,
    interestPerQuarter: 0.016,
    engineerCostPerQuarter: 0.035, // 1명당 M$
    engineerHireCost: 0.06, // 채용 일시금 (1명당)
    fixedOverheadPerQuarter: 55,
    lineOverheadPerLine: 9,
    defaultProgramShare: 50, // 신규 프로그램의 기본 인력 배분(%)
    launchUpfrontRate: 0.08, // 개발 착수금 (총 개발비 대비). 나머지는 진행도에 비례해 집행된다.
    depositRate: 0.15, // 수주 시 선수금
    inventoryHoldingCost: 0.004, // 재고 1기당 분기 유지비 (원가 대비)
    learningExponent: Math.log(0.87) / Math.log(2), // 87% 학습곡선
    // 바닥값이 높으면 누적 40기쯤에서 원가 개선이 멈춰버린다. 0.28이면 약 560기까지
    // 완만하게 내려가, 장기 양산이 실제로 보상받는다.
    learningFloor: 0.28,
    firstUnitPremium: 1.9, // T1 원가 = 표준원가 × 이 값
    maxDiscount: 0.35,
    qualityInvestRate: 0.035, // 품질 강화 1회 비용 (개발비 대비). UI 표시와 실제 청구가 이 값을 공유한다.
    qualityRiskMult: 0.62, // 1회당 결함 위험 배수
    // 결함 위험 상한. 설계 계산(design)과 개발 중 페널티(engine) 양쪽이 이 값을 쓴다.
    // 두 곳에 각각 박아 두면 한쪽만 올렸을 때 "악재가 위험을 낮추는" 역전이 생긴다.
    defectRiskMax: 0.75,
    // 패밀리 개발 — 처음에 공통 구조·조종석을 설계해 두는 값. 비싸지만 이후
    // 같은 단면의 파생형이 훨씬 싸고, 항공사 공통성도 패밀리 단위로 쌓인다.
    familyDevMult: 1.22,
    familyTimeMult: 1.08,
    // 파생형 개발비·기간 배수 (패밀리 여부 × 엔진 교체 여부).
    // 재장착이어도 패밀리면 공통 구조·조종석 덕을 본다 — A320neo 가 그랬다.
    derivRates: {
      plain: { cost: 0.34, time: 0.5, eng: 0.55 },
      family: { cost: 0.22, time: 0.36, eng: 0.45 },
      reEngined: { cost: 0.58, time: 0.72, eng: 0.75 },
      familyReEngined: { cost: 0.44, time: 0.6, eng: 0.62 },
    },
    // ETOPS — 쌍발기로 대양을 건널 자격. 없으면 장거리 노선 응찰 자체가 막힌다.
    etopsDevMult: 1.08,
    etopsCertQuarters: 1,
    rampPerQuarter: 0.22, // 라인 가동률 상승 속도
  };

  /** 기체 세그먼트 — 설계 가능 범위와 기준점 */
  const SEGMENTS = {
    regional: {
      id: 'regional',
      name: '리저널기',
      desc: '단거리 지선. 개발이 싸고 빠르지만 대당 이익이 얇다.',
      seats: { min: 60, max: 130, ref: 90 },
      range: { min: 1200, max: 4800, ref: 2500 },
      devBase: 2100,
      devQuarters: 11,
      engineersNeeded: 2000,
      unitCostBase: 31,
      listPriceBase: 42,
      lineCost: 430,
      lineMaxRate: 13, // 분기당 최대 생산 기수
      certQuarters: 3,
    },
    narrow: {
      id: 'narrow',
      name: '협동체',
      desc: '시장의 심장. 물량이 압도적이라 라인만 돌면 현금이 돈다.',
      seats: { min: 120, max: 240, ref: 180 },
      range: { min: 2800, max: 7800, ref: 5500 },
      devBase: 6400,
      devQuarters: 15,
      engineersNeeded: 3800,
      unitCostBase: 60,
      listPriceBase: 94,
      lineCost: 880,
      lineMaxRate: 16,
      certQuarters: 4,
    },
    wide: {
      id: 'wide',
      name: '광동체',
      desc: '장거리 간판. 개발비가 회사를 삼킬 수 있지만 평판이 크게 오른다.',
      seats: { min: 230, max: 480, ref: 320 },
      range: { min: 6500, max: 16500, ref: 12000 },
      devBase: 11000,
      devQuarters: 19,
      engineersNeeded: 6000,
      unitCostBase: 162,
      listPriceBase: 258,
      lineCost: 1580,
      lineMaxRate: 6,
      certQuarters: 5,
    },
  };

  const SEGMENT_ORDER = ['regional', 'narrow', 'wide'];

  /** 주 구조재 선택 — 연비/개발비/개발리스크 트레이드오프 */
  /**
   * 부위별 소재 — 동체와 날개를 따로 고른다.
   *
   * 한 덩어리 3택이던 시절에는 복합재로 갈수록 다 좋아지고 다 비싸지는 한 방향
   * 다이얼이라 결정이랄 게 없었다. 부위를 나누면 각각 성격이 갈린다:
   *
   *   동체 — 여압 사이클이 걸려 개발이 가장 어렵다. 대신 넓은 단면·높은 여압·큰 창으로
   *          객실이 크게 좋아진다 (787이 실제로 판 것). 위험 ↔ 객실.
   *   날개 — 가벼워야 종횡비를 높일 수 있다. 연비와 직결되지만 원가가 오른다.
   *          고종횡비 장거리 날개는 사실상 복합재라야 성립한다. 연비 ↔ 원가.
   *
   * 그래서 "동체는 알루미늄, 날개만 복합재"(777 방식) 같은 실제 조합이 생긴다.
   */
  const FUSELAGE_MATERIALS = {
    aluminum: {
      id: 'aluminum', name: '알루미늄 동체', desc: '검증된 여압 구조. 개발이 순탄하다.',
      devCostMult: 1.0, devTimeMult: 1.0, unitCostMult: 1.0, comfortBonus: 0, efficiencyBonus: 0, riskBonus: 0,
    },
    alloy: {
      id: 'alloy', name: '신합금 동체', desc: '3세대 알루미늄-리튬. 조금 가볍고 조금 비싸다.',
      devCostMult: 1.09, devTimeMult: 1.04, unitCostMult: 1.05, comfortBonus: 3, efficiencyBonus: 3, riskBonus: 0.02,
    },
    composite: {
      id: 'composite', name: '복합재 동체', desc: '여압 사이클 검증이 관문. 객실 환경은 압도적이다.',
      devCostMult: 1.3, devTimeMult: 1.22, unitCostMult: 1.12, comfortBonus: 14, efficiencyBonus: 5, riskBonus: 0.13,
    },
  };

  const WING_MATERIALS = {
    aluminum: {
      id: 'aluminum', name: '알루미늄 날개', desc: '무겁지만 싸고 확실하다.',
      devCostMult: 1.0, devTimeMult: 1.0, unitCostMult: 1.0, efficiencyBonus: 0, riskBonus: 0, aspectRelief: 0,
    },
    hybrid: {
      id: 'hybrid', name: '복합재 외피 날개', desc: '외피만 복합재. 무난한 절충.',
      devCostMult: 1.12, devTimeMult: 1.06, unitCostMult: 1.06, efficiencyBonus: 5, riskBonus: 0.03, aspectRelief: 0.4,
    },
    composite: {
      id: 'composite', name: '전복합재 날개', desc: '가볍다. 고종횡비 장거리 날개는 사실상 이것뿐이다.',
      devCostMult: 1.26, devTimeMult: 1.14, unitCostMult: 1.13, efficiencyBonus: 11, riskBonus: 0.07, aspectRelief: 1,
    },
  };

  /**
   * 조립 라인 등급 — 지금까지 라인은 전부 같았고 "돈 되면 늘린다"가 전부였다.
   *
   *   costMult  : 건설비 배수
   *   rateMult  : 분기당 생산 능력 배수
   *   rampMult  : 램프업 속도 배수 (자동화 라인은 안정화가 오래 걸린다)
   *   overhead  : 라인 유지비 배수
   *
   * 재래식은 싸고 빨리 도는 대신 물량이 안 나오고, 고속 라인은 반대다.
   * 수요가 확실한 기종에만 고속 라인을 거는 것이 맞다.
   */
  const LINE_GRADES = {
    classic: { id: 'classic', name: '재래식 라인', desc: '싸고 빨리 안정된다. 물량은 적다.', costMult: 0.72, rateMult: 0.72, rampMult: 1.35, overhead: 0.85 },
    standard: { id: 'standard', name: '표준 라인', desc: '무난한 기준선.', costMult: 1.0, rateMult: 1.0, rampMult: 1.0, overhead: 1.0 },
    highRate: { id: 'highRate', name: '고속 자동화 라인', desc: '물량이 크게 늘지만 비싸고 안정화가 느리다.', costMult: 1.75, rateMult: 1.55, rampMult: 0.65, overhead: 1.3 },
  };

  /** 라인 전환 비용 (신규 건설 대비). 같은 동체 단면이라야 치구를 재활용할 수 있다. */
  const RETOOL_COST_RATE = 0.35;

  /**
   * 외주 비중 — 원가 ↔ 공급 차질 위험.
   * 787 이 실제로 겪은 트레이드오프다. 외주를 늘리면 단가가 내려가지만
   * 공급망 사고가 잦아지고 길어진다.
   */
  const OUTSOURCING = {
    low: { id: 'low', name: '수직계열 (외주 20%)', costMult: 1.06, supplyRisk: 0.5 },
    mid: { id: 'mid', name: '균형 (외주 50%)', costMult: 1.0, supplyRisk: 1.0 },
    high: { id: 'high', name: '광범위 외주 (80%)', costMult: 0.91, supplyRisk: 1.9 },
  };

  /** 옛 단일 소재 선택을 부위별 조합으로 옮긴다 (세이브 · 기존 코드 호환). */
  const LEGACY_MATERIAL_MAP = {
    aluminum: { fuselage: 'aluminum', wingMat: 'aluminum' },
    hybrid: { fuselage: 'aluminum', wingMat: 'hybrid' },
    composite: { fuselage: 'composite', wingMat: 'composite' },
  };


  /** 항공사 — 수주전 상대이자 관계 관리 대상 */
  /**
   * 항공사 — 각자 노선망이 다르다.
   *
   *   seatBand / rangeBand : 이 항공사가 실제로 발주하는 크기·거리대
   *   field                : 활주로 제약 ('short' 짧은 활주로, 'hot' 고온고지)
   *
   * 요구사양을 세그먼트 대역에서 균등 난수로 뽑던 시절에는 최적해가 늘 대역
   * 중앙이라 좌석·항속 결정이 사실상 무의미했다. 항공사마다 수요가 몰린 지점을
   * 주면 "누구를 노릴 것인가"가 곧 설계가 된다 — 저비용 고밀도 vertex 를 겨냥한
   * 235석 7열 기체와, 프리미엄 장거리 albion 을 겨냥한 280석 7열 기체는
   * 완전히 다른 비행기다.
   */
  const AIRLINES = [
    { id: 'hanul', name: '한울항공', home: '동아시아', bias: 'narrow', priceSensitivity: 0.9, prestige: 0.8,
      seatBand: [150, 185], rangeBand: [3000, 4800], field: 'normal', route: '조밀 단거리 간선' },
    { id: 'carta', name: '카르타 에어', home: '중동', bias: 'wide', priceSensitivity: 0.5, prestige: 1.25,
      seatBand: [280, 400], rangeBand: [12000, 16000], field: 'normal', route: '허브 초장거리' },
    { id: 'nordic', name: '노르딕윙스', home: '북유럽', bias: 'regional', priceSensitivity: 1.15, prestige: 0.7,
      seatBand: [68, 95], rangeBand: [1400, 2600], field: 'short', route: '단거리 지선 · 짧은 활주로' },
    { id: 'panamer', name: '판아메르 항공', home: '북미', bias: 'narrow', priceSensitivity: 1.05, prestige: 1.0,
      seatBand: [170, 205], rangeBand: [5200, 7200], field: 'normal', route: '대륙횡단 (장거리 협동체)' },
    { id: 'asialink', name: '아시아링크', home: '동남아', bias: 'wide', priceSensitivity: 1.2, prestige: 0.85,
      seatBand: [330, 430], rangeBand: [7000, 9800], field: 'normal', route: '역내 고밀도 중장거리' },
    { id: 'albion', name: '알비온 항공', home: '서유럽', bias: 'wide', priceSensitivity: 0.75, prestige: 1.15,
      seatBand: [250, 330], rangeBand: [10000, 14000], field: 'normal', route: '프리미엄 장거리' },
    { id: 'meridian', name: '메리디안 항공', home: '남미', bias: 'narrow', priceSensitivity: 1.3, prestige: 0.6,
      seatBand: [125, 160], rangeBand: [2900, 4400], field: 'hot', route: '고온고지 소형 간선' },
    { id: 'sahara', name: '사하라 에어', home: '아프리카', bias: 'regional', priceSensitivity: 1.25, prestige: 0.55,
      seatBand: [62, 88], rangeBand: [1600, 3000], field: 'hot', route: '고온 오지 노선' },
    { id: 'oceanic', name: '오세아닉', home: '오세아니아', bias: 'wide', priceSensitivity: 0.95, prestige: 0.9,
      seatBand: [232, 275], rangeBand: [11000, 15000], field: 'normal', route: '저밀도 장거리 (얇은 노선)' },
    { id: 'kosmo', name: '코스모항공', home: '중앙아시아', bias: 'narrow', priceSensitivity: 1.35, prestige: 0.5,
      seatBand: [140, 175], rangeBand: [3400, 5200], field: 'hot', route: '고지 공항 간선' },
    { id: 'lumen', name: '루멘 에어라인', home: '북미', bias: 'regional', priceSensitivity: 1.1, prestige: 0.75,
      seatBand: [100, 128], rangeBand: [1800, 3400], field: 'normal', route: '지선 피더 (대형 리저널)' },
    { id: 'vertex', name: '버텍스 제트', home: '서유럽', bias: 'narrow', priceSensitivity: 1.4, prestige: 0.45,
      seatBand: [205, 240], rangeBand: [2900, 4600], field: 'normal', route: '저비용 초고밀도' },
  ];

  /**
   * 업게이지 추세 — 항공사 평균 좌석수는 해마다 오른다(1998~2017 실제 현상).
   * 게임에서는 승계 기종이 서서히 작아지는 압력이 된다: 1998년 주류였던 150석
   * DN-150 이 2010년대에는 한 급 아래가 되어, 후속기를 띄우지 않으면 시장에서 밀린다.
   */
  const UPGAUGE_PER_YEAR = 0.008;

  /** 활주로 제약별 요구 이착륙 성능 (설계의 fieldPerf 가 이 값 이상이어야 응찰 가능). */
  const FIELD_REQUIREMENT = { normal: 0, short: 64, hot: 58 };

  /** 이 거리를 넘는 노선은 ETOPS 인증을 요구한다. */
  const ETOPS_RANGE_KM = 9000;

  /**
   * 요구 항속 대비 허용 부족분 — 이만큼만 채우면 응찰할 수 있다.
   * 즉 항속 R인 기체가 실제로 노릴 수 있는 노선은 R / RANGE_TOLERANCE 까지다.
   *
   * 입찰 실격 판정과 ETOPS 판단이 반드시 같은 값을 봐야 한다. 따로 두면
   * 8,100~8,999km 기체처럼 "9,000km 노선에 응찰은 되는데 ETOPS 는 못 받는" 사각이 생긴다.
   */
  const RANGE_TOLERANCE = 0.9;

  /** ETOPS 가 값을 하는 최소 항속 — 이 아래로는 인증해 봐야 닿을 노선이 없다. */
  const ETOPS_USEFUL_RANGE = ETOPS_RANGE_KM * RANGE_TOLERANCE;

  /**
   * 경쟁 제조사는 `js/fleet.js`의 실존 제조사·실기종 카탈로그에서 나온다.
   * 세그먼트별 경쟁력은 고정값이 아니라 "그 시점에 실제로 팔리던 기종"에서 유도되고,
   * 아래 이벤트는 거기에 얹히는 보정치(drift)만 움직인다.
   */

  /**
   * 입찰 조건 — 할인율 말고 무엇을 걸 수 있나.
   *
   * 할인 슬라이더 하나뿐일 때는 응찰만 하면 88% 이겼다(측정치). 결정이 하나면
   * 최적값이 하나이기 때문이다. 아래 두 축은 각각 **이미 있는 자원**에 값을 매긴다 —
   * 인도 약속은 라인 여력에, 금융 조건은 현금흐름에.
   *
   * bonus 는 입찰 점수(0~100 척도)에 그대로 더해진다. 분할 판정 폭이 ±4점이라
   * 6.5점이면 판을 뒤집을 수 있다 — 대신 못 지키면 위약금과 관계 하락이 따른다.
   */
  const BID_PLEDGES = {
    standard: {
      id: 'standard',
      name: '표준 인도',
      hint: '통상 일정. 약속도 위약금도 없다',
      bonus: 0,
      dueQuarters: 14,
      penaltyRate: 0,
      priority: 0,
    },
    early: {
      id: 'early',
      name: '조기 인도 약속',
      hint: '7분기 안에 다 넘긴다. 넘길 때까지 분기마다 위약금 1.5%',
      bonus: 2,
      dueQuarters: 7,
      penaltyRate: 0.015,
      priority: 1,
    },
    priority: {
      id: 'priority',
      name: '최우선 인도 약속',
      hint: '4분기 안에 다 넘긴다. 넘길 때까지 분기마다 위약금 3.5%',
      bonus: 4,
      dueQuarters: 4,
      penaltyRate: 0.035,
      priority: 2,
    },
  };

  /**
   * 금융 조건. 같은 가격이라도 **언제 받느냐**가 다르다.
   *   cash   — 선수금을 두 배로 당겨 받는다. 항공사는 싫어한다.
   *   normal — 기준.
   *   vendor — 우리가 대금을 빌려준다. 항공사는 좋아하고, 현금은 8분기에 걸쳐 들어온다.
   * 실제로 제조사 금융(vendor financing)은 수주전의 핵심 무기이자 제조사를 무너뜨린
   * 원인이기도 하다.
   */
  const BID_FINANCING = {
    cash: {
      id: 'cash',
      name: '선수금 확대',
      hint: '계약 즉시 두 배로 받는다. 점수는 깎인다',
      bonus: -2,
      depositMult: 2,
      onDelivery: 1,
      quarters: 0,
      interest: 0,
    },
    normal: {
      id: 'normal',
      name: '표준 조건',
      hint: '선수금 15%, 인도 시 잔금',
      bonus: 0,
      depositMult: 1,
      onDelivery: 1,
      quarters: 0,
      interest: 0,
    },
    vendor: {
      id: 'vendor',
      name: '자체 금융 제공',
      hint: '인도 대금의 42%만 즉시. 8분기 분할 + 이자 — 불황에는 떼일 수 있다',
      bonus: 3,
      depositMult: 1,
      onDelivery: 0.42,
      quarters: 8,
      interest: 0.02,
    },
  };

  /** 경쟁사 경쟁력 상한 — 이벤트 누적으로 무한정 강해지는 것을 막는다. */
  const RIVAL_STRENGTH_CAP = 78;
  /** 경쟁사 경쟁력 하한 — 악재가 겹쳐도 시장이 무주공산이 되지는 않는다. */
  const RIVAL_STRENGTH_FLOOR = 25;
  /** 이벤트 보정치의 절대 한계. 카탈로그가 만든 시대 흐름을 뒤집지 못하게 묶는다. */
  const RIVAL_DRIFT_LIMIT = 14;

  /**
   * 이벤트가 건드릴 제조사·세그먼트를 고른다.
   * 그 시점에 실제로 그 세그먼트를 팔고 있던 조합만 후보다 — 2016년의 BAE나
   * 1998년의 수호이가 "신형을 발표"하면 안 된다.
   */
  function rivalTargets(s) {
    const F = root.AirlinerFleet;
    const year = F.yearAt(s.turn, CONFIG.startYear);
    const out = [];
    for (const c of s.competitors) {
      for (const seg of SEGMENT_ORDER) {
        const types = F.availableTypes(seg, year).filter((t) => t.maker === c.id);
        if (types.length) out.push({ c, seg, types });
      }
    }
    return out;
  }

  function flagshipOf(types) {
    return types.reduce((a, b) => (b.power > a.power ? b : a));
  }

  /**
   * 랜덤 이벤트. apply(state, ctx)는 engine이 주입한 헬퍼로 상태를 바꾸고
   * 사용자에게 보여줄 문장을 반환한다. weight는 상대 출현 빈도.
   */
  const EVENTS = [
    {
      id: 'fuel_spike',
      name: '유가 급등',
      weight: 10,
      apply: (s, h) => {
        const d = h.rng.range(0.18, 0.42);
        s.market.fuelIndex = Math.min(2.2, s.market.fuelIndex + d);
        return `국제 유가가 치솟았다. 항공사들이 연비를 최우선으로 보기 시작한다. (연료지수 +${d.toFixed(2)})`;
      },
    },
    {
      id: 'fuel_drop',
      name: '유가 안정',
      weight: 8,
      apply: (s, h) => {
        const d = h.rng.range(0.12, 0.3);
        s.market.fuelIndex = Math.max(0.5, s.market.fuelIndex - d);
        return `유가가 내려앉았다. 연비 프리미엄이 힘을 잃고 가격 경쟁이 거세진다. (연료지수 -${d.toFixed(2)})`;
      },
    },
    {
      id: 'boom',
      name: '항공 수요 호황',
      weight: 9,
      apply: (s, h) => {
        const d = h.rng.range(0.15, 0.35);
        s.market.demandIndex = Math.min(2.0, s.market.demandIndex + d);
        return `여객 수요가 폭발했다. 항공사들이 앞다퉈 발주 계획을 앞당긴다. (수요지수 +${d.toFixed(2)})`;
      },
    },
    {
      id: 'recession',
      name: '경기 침체',
      weight: 9,
      apply: (s, h) => {
        const d = h.rng.range(0.2, 0.45);
        s.market.demandIndex = Math.max(0.35, s.market.demandIndex - d);
        return `경기가 꺾였다. 신규 발주가 얼어붙고 기존 계약도 흔들린다. (수요지수 -${d.toFixed(2)})`;
      },
    },
    {
      id: 'order_cancel',
      name: '발주 취소',
      weight: 7,
      condition: (s) => s.backlog.some((o) => o.remaining > 0),
      apply: (s, h) => {
        const live = s.backlog.filter((o) => o.remaining > 0);
        const order = h.rng.pick(live);
        const cut = Math.max(1, Math.round(order.remaining * h.rng.range(0.2, 0.5)));
        order.remaining -= cut;
        order.cancelled = (order.cancelled || 0) + cut;
        h.reputation(-2);
        return `${order.airlineName}이(가) ${order.programName} ${cut}기 발주를 취소했다. 선수금은 위약금으로 남는다.`;
      },
    },
    {
      id: 'strike',
      name: '생산직 파업',
      weight: 6,
      condition: (s) => s.lines.length > 0,
      apply: (s, h) => {
        // 재발이 기존 잔여 기간을 줄이면 악재가 오히려 이득이 된다 — 긴 쪽을 남긴다.
        s.effects.strikeQuarters = Math.max(s.effects.strikeQuarters || 0, h.rng.int(1, 2));
        return `조립 노조가 파업에 돌입했다. ${s.effects.strikeQuarters}개 분기 동안 생산이 반토막 난다.`;
      },
    },
    {
      id: 'supplier_delay',
      name: '공급망 차질',
      weight: 8,
      condition: (s) => s.lines.length > 0,
      apply: (s, h) => {
        // 외주가 많을수록 공급망 사고가 길어진다 — 787 이 실제로 겪은 대가.
        const risk = (OUTSOURCING[s.outsourcing] || OUTSOURCING.mid).supplyRisk;
        const q = Math.max(1, Math.round(h.rng.int(1, 3) * risk));
        s.effects.supplyQuarters = Math.max(s.effects.supplyQuarters || 0, q);
        return `1차 협력사가 납기를 놓쳤다. ${s.effects.supplyQuarters}개 분기 동안 생산율이 25% 깎인다.`;
      },
    },
    {
      id: 'cert_snag',
      name: '인증 지연',
      weight: 7,
      condition: (s) => s.programs.some((p) => p.phase === 'cert'),
      apply: (s, h) => {
        const p = h.rng.pick(s.programs.filter((x) => x.phase === 'cert'));
        const q = h.rng.int(1, 3);
        p.certRemaining += q;
        return `감항당국이 ${p.name}의 비행제어 소프트웨어에 추가 시험을 요구했다. 인증이 ${q}분기 밀린다.`;
      },
    },
    {
      id: 'tech_grant',
      name: '정부 연구지원금',
      weight: 6,
      apply: (s, h) => {
        const amount = Math.round(h.rng.range(180, 520));
        h.income(amount);
        return `국책 항공기술 과제에 선정돼 지원금 ${h.fmt(amount)}을(를) 수령했다.`;
      },
    },
    {
      id: 'defect',
      name: '운항 중 결함',
      // 발생 빈도 자체를 함대 평균 위험에 연동한다. 고정 가중치면 품질 투자로
      // defectRisk 를 낮춰도 (특히 기종이 하나뿐인 초반) 빈도가 전혀 줄지 않는다.
      weight: (s) => {
        const fleet = s.programs.filter((p) => p.delivered > 0);
        if (!fleet.length) return 0;
        const avg = fleet.reduce((a, p) => a + p.defectRisk, 0) / fleet.length;
        return Math.max(1, Math.min(16, 8 * (avg / 0.15)));
      },
      condition: (s) => s.programs.some((p) => p.delivered > 0),
      apply: (s, h) => {
        // 결함 위험이 높은 기종일수록 자주 걸린다. 균등 추첨이면 품질 투자로 낮춘
        // defectRisk 가 중대/경미 판정에만 쓰여 "위험 25% 감소"가 빈도에 반영되지 않는다.
        const fleet = s.programs.filter((p) => p.delivered > 0);
        const p = h.pickWeighted(fleet, (x) => x.defectRisk);
        const severity = h.rng.next() < p.defectRisk ? 'major' : 'minor';
        if (severity === 'major') {
          const cost = Math.round(p.delivered * p.unitCostBase * h.rng.range(0.08, 0.2));
          h.expense(cost);
          h.reputation(-9);
          // 기종별로 기록하고, 이미 정지 중이면 더 긴 쪽을 남긴다
          // (단일 슬롯이면 다른 기종의 정지가 기존 정지를 조기 해제해 버린다).
          const q = h.rng.int(1, 3);
          s.effects.grounded[p.id] = Math.max(s.effects.grounded[p.id] || 0, q);
          return `${p.name}에서 중대 결함이 발견돼 전 기체가 운항 정지됐다. 수리·보상에 ${h.fmt(cost)} 소요, 인도도 멈춘다.`;
        }
        const cost = Math.round(p.delivered * h.rng.range(0.15, 0.5));
        h.expense(cost);
        h.reputation(-2);
        return `${p.name}에 경미한 결함 서비스회보가 발행됐다. 대응 비용 ${h.fmt(cost)}.`;
      },
    },
    {
      id: 'rival_launch',
      name: '경쟁사 개량형 투입',
      weight: 9,
      apply: (s, h) => {
        const targets = rivalTargets(s);
        if (!targets.length) return '경쟁사들이 조용한 분기를 보냈다.';
        const t = h.rng.pick(targets);
        const gain = h.rng.range(3, 8);
        t.c.drift[t.seg] = Math.min(RIVAL_DRIFT_LIMIT, (t.c.drift[t.seg] || 0) + gain);
        return `${t.c.name}이(가) ${flagshipOf(t.types).name} 개량형을 내놨다. ${SEGMENTS[t.seg].name} 경쟁이 거세진다.`;
      },
    },
    {
      id: 'rival_trouble',
      name: '경쟁사 악재',
      weight: 6,
      apply: (s, h) => {
        const targets = rivalTargets(s);
        if (!targets.length) return '경쟁사들이 조용한 분기를 보냈다.';
        const t = h.rng.pick(targets);
        const loss = h.rng.range(4, 9);
        t.c.drift[t.seg] = Math.max(-RIVAL_DRIFT_LIMIT, (t.c.drift[t.seg] || 0) - loss);
        h.reputation(2);
        return `${t.c.name}의 ${flagshipOf(t.types).name} 인도가 대규모 지연에 빠졌다. 반사이익이 우리에게 온다.`;
      },
    },
    {
      id: 'engineer_poach',
      name: '핵심 인력 유출',
      weight: 6,
      condition: (s) => s.engineers > 1500,
      apply: (s, h) => {
        const loss = Math.round(s.engineers * h.rng.range(0.05, 0.12));
        s.engineers -= loss;
        return `경쟁사가 설계팀을 통째로 스카우트했다. 엔지니어 ${loss.toLocaleString('ko-KR')}명 이탈.`;
      },
    },
    {
      id: 'award',
      name: '업계 수상',
      weight: 5,
      condition: (s) => s.programs.some((p) => p.phase === 'production'),
      apply: (s, h) => {
        h.reputation(h.rng.int(4, 8));
        return '항공업계 연례 시상식에서 올해의 기체상을 받았다. 브랜드 신뢰도가 올라간다.';
      },
    },
    {
      id: 'credit_squeeze',
      name: '신용 경색',
      weight: 5,
      apply: (s, h) => {
        // 진행 중인 경색보다 약한 재발이 덮어쓰면, 악재가 오히려 이자를 낮추고
        // 기간을 앞당겨 끝내 버린다. 더 강하고 더 긴 쪽을 남긴다.
        s.effects.rateBump = Math.max(s.effects.rateBump || 0, h.rng.range(0.004, 0.011));
        s.effects.rateBumpQuarters = Math.max(s.effects.rateBumpQuarters || 0, h.rng.int(2, 5));
        return `금융시장이 경색됐다. 당분간 차입 이자율이 분기 ${(s.effects.rateBump * 100).toFixed(1)}%p 오른다.`;
      },
    },
  ];


  /**
   * 역사적 충격 — 1998~2017년에 실제로 항공기 시장을 흔든 사건을 정해진 분기에 넣는다.
   * 무작위 이벤트와 달리 시드와 무관하게 항상 같은 시점에 오므로, 플레이어는 두 번째
   * 판부터 "2001년 3분기 전에 현금을 쌓아 두자"처럼 역사 자체를 공략할 수 있다.
   *
   * turn = (연도 - 1998) * 4 + (분기 - 1)
   */
  const HISTORICAL = [
    {
      turn: (2001 - 1998) * 4 + 2, // 2001년 3분기
      name: '9·11 테러',
      apply: (s, h) => {
        s.market.demandIndex = Math.max(0.45, s.market.demandIndex * 0.66);
        s.effects.demandSlumpQuarters = Math.max(s.effects.demandSlumpQuarters || 0, 7);
        // 발주 취소가 실제로 쏟아졌다.
        let cancelled = 0;
        for (const o of s.backlog.filter((x) => x.remaining > 0)) {
          const cut = Math.round(o.remaining * h.rng.range(0.15, 0.4));
          if (cut > 0) {
            o.remaining -= cut;
            o.cancelled = (o.cancelled || 0) + cut;
            cancelled += cut;
          }
        }
        return `미국 동시다발 테러로 항공 수요가 붕괴했다. 발주 ${cancelled}기가 취소되고 수요 회복에는 수년이 걸린다.`;
      },
    },
    {
      turn: (2003 - 1998) * 4 + 1, // 2003년 2분기
      name: 'SARS 확산',
      apply: (s) => {
        s.market.demandIndex = Math.max(0.5, s.market.demandIndex * 0.85);
        s.effects.demandSlumpQuarters = Math.max(s.effects.demandSlumpQuarters || 0, 3);
        return '사스가 아시아 노선을 마비시켰다. 역내 항공사들이 인도 연기를 요청한다.';
      },
    },
    {
      turn: (2008 - 1998) * 4 + 1, // 2008년 2분기
      name: '유가 사상 최고',
      apply: (s) => {
        s.market.fuelIndex = Math.min(2.2, Math.max(s.market.fuelIndex * 1.75, 1.9));
        s.effects.fuelShockQuarters = Math.max(s.effects.fuelShockQuarters || 0, 6);
        return '유가가 배럴당 $140을 넘었다. 항공사들이 연비 나쁜 기종을 조기 퇴역시키기 시작한다.';
      },
    },
    {
      turn: (2008 - 1998) * 4 + 3, // 2008년 4분기
      name: '금융위기',
      apply: (s, h) => {
        s.market.demandIndex = Math.max(0.45, s.market.demandIndex * 0.72);
        s.effects.demandSlumpQuarters = Math.max(s.effects.demandSlumpQuarters || 0, 5);
        // 신용이 마른다 — 조달 비용이 오래 오른다.
        s.effects.rateBump = Math.max(s.effects.rateBump || 0, 0.012);
        s.effects.rateBumpQuarters = Math.max(s.effects.rateBumpQuarters || 0, 8);
        s.market.fuelIndex = Math.max(0.5, s.market.fuelIndex * 0.55);
        return '리먼 파산으로 금융시장이 얼어붙었다. 항공사 자금조달이 막히고 우리 차입 금리도 뛴다.';
      },
    },
    {
      turn: (2010 - 1998) * 4 + 1, // 2010년 2분기
      name: '아이슬란드 화산 분화',
      apply: (s, h) => {
        const cost = Math.round(h.rng.range(40, 110));
        h.expense(cost);
        return `화산재로 유럽 하늘이 닫혔다. 인도 지연과 위약 대응에 ${h.fmt(cost)}이 나갔다.`;
      },
    },
    {
      turn: (2014 - 1998) * 4 + 2, // 2014년 3분기
      name: '유가 급락',
      apply: (s) => {
        s.market.fuelIndex = Math.max(0.45, s.market.fuelIndex * 0.5);
        return '셰일 증산으로 유가가 반토막 났다. 연비 프리미엄이 당분간 힘을 잃는다.';
      },
    },
  ];


  /**
   * 가상 충격 — 역사적 사건이 불발된 자리를 메운다.
   * 규모는 역사적 충격과 같은 범위로 맞춰 밸런스 봉투를 유지하되, 발생 시점이
   * 무작위라 암기가 통하지 않는다. 상승 충격을 섞어 타임라인이 일방적으로
   * 벌주기만 하지 않게 했다.
   */
  const FICTIONAL_SHOCKS = [
    {
      id: 'mega_bankruptcy',
      name: '대형 항공사 연쇄 파산',
      apply: (s, h) => {
        s.market.demandIndex = Math.max(0.45, s.market.demandIndex * 0.72);
        s.effects.demandSlumpQuarters = Math.max(s.effects.demandSlumpQuarters || 0, 5);
        let lost = 0;
        for (const o of s.backlog.filter((x) => x.remaining > 0)) {
          if (!h.rng.chance(0.45)) continue;
          const cut = Math.round(o.remaining * h.rng.range(0.2, 0.5));
          if (cut > 0) {
            o.remaining -= cut;
            o.cancelled = (o.cancelled || 0) + cut;
            lost += cut;
          }
        }
        return `주요 항공사 두 곳이 연달아 파산 보호를 신청했다. 발주 ${lost}기가 증발하고 업계 전체가 발주를 미룬다.`;
      },
    },
    {
      id: 'emerging_boom',
      name: '신흥시장 항공 붐',
      apply: (s) => {
        s.market.demandIndex = Math.min(2.0, s.market.demandIndex * 1.45);
        s.effects.demandBoomQuarters = Math.max(s.effects.demandBoomQuarters || 0, 6);
        return '아시아·중동 신흥 항공사들이 동시에 기단 확장에 나섰다. 당분간 발주가 쏟아진다.';
      },
    },
    {
      id: 'regional_conflict',
      name: '산유국 분쟁',
      apply: (s) => {
        s.market.fuelIndex = Math.min(2.2, Math.max(s.market.fuelIndex * 1.6, 1.75));
        s.effects.fuelShockQuarters = Math.max(s.effects.fuelShockQuarters || 0, 5);
        return '주요 산유국에서 무력 충돌이 벌어졌다. 유가가 급등하고 항공사들이 연비를 최우선으로 따지기 시작한다.';
      },
    },
    {
      id: 'emission_rules',
      name: '배출 규제 도입',
      apply: (s, h) => {
        const cost = Math.round(h.rng.range(60, 160));
        h.expense(cost);
        s.market.fuelIndex = Math.min(2.2, s.market.fuelIndex * 1.25);
        s.effects.fuelShockQuarters = Math.max(s.effects.fuelShockQuarters || 0, 8);
        return `국제 배출 규제가 발효됐다. 인증 대응에 ${h.fmt(cost)}이 들고, 연비가 사실상 규제 요건이 된다.`;
      },
    },
    {
      id: 'titanium_squeeze',
      name: '항공소재 공급난',
      apply: (s, h) => {
        s.effects.supplyQuarters = Math.max(s.effects.supplyQuarters || 0, h.rng.int(3, 5));
        const cost = Math.round(h.rng.range(50, 140));
        h.expense(cost);
        return `티타늄·탄소섬유 공급이 막혔다. 생산이 밀리고 긴급 조달에 ${h.fmt(cost)}이 나갔다.`;
      },
    },
    {
      id: 'lessor_boom',
      name: '리스사 대량 발주',
      apply: (s, h) => {
        s.market.demandIndex = Math.min(2.0, s.market.demandIndex * 1.3);
        s.effects.demandBoomQuarters = Math.max(s.effects.demandBoomQuarters || 0, 4);
        // 선수금만 주고 주문을 안 만들면 "계약 없는 공짜 현금"이 된다.
        // 실제 발주를 백로그에 넣고, 그 선수금만큼만 현금을 준다.
        const buildable = s.programs.filter((p) => p.phase === 'production');
        if (!buildable.length) {
          return '대형 리스사가 기단 교체 프로그램을 발표했다. 시장이 달아오르지만, 우리에겐 지금 팔 기체가 없다.';
        }
        const p = h.rng.pick(buildable);
        const qty = h.rng.int(6, 18);
        const unitPrice = Math.round(p.listPrice * 0.86 * 10) / 10;
        const deposit = Math.round(qty * unitPrice * CONFIG.depositRate);
        s.backlog.push({
          id: 'ord-' + s.nextId++,
          airlineId: 'leasing',
          airlineName: '글로벌 리스',
          programId: p.id,
          programName: p.name,
          qty,
          remaining: qty,
          unitPrice,
          wonTurn: s.turn,
        });
        h.income(deposit);
        return `글로벌 리스가 ${p.name} ${qty}기를 발주했다. 선수금 ${h.fmt(deposit)} 입금.`;
      },
    },
    {
      id: 'credit_freeze',
      name: '항공금융 경색',
      apply: (s) => {
        s.effects.rateBump = Math.max(s.effects.rateBump || 0, 0.011);
        s.effects.rateBumpQuarters = Math.max(s.effects.rateBumpQuarters || 0, 7);
        s.market.demandIndex = Math.max(0.5, s.market.demandIndex * 0.85);
        s.effects.demandSlumpQuarters = Math.max(s.effects.demandSlumpQuarters || 0, 4);
        return '항공기 금융이 얼어붙었다. 항공사도 우리도 돈을 빌리기가 어려워진다.';
      },
    },
    {
      id: 'pilot_shortage',
      name: '조종사 부족 심화',
      apply: (s) => {
        s.market.demandIndex = Math.max(0.5, s.market.demandIndex * 0.88);
        s.effects.demandSlumpQuarters = Math.max(s.effects.demandSlumpQuarters || 0, 4);
        return '조종사 부족으로 항공사들이 노선 확장을 늦춘다. 신규 발주도 함께 미뤄진다.';
      },
    },
    {
      id: 'open_skies',
      name: '항공자유화 협정',
      apply: (s) => {
        s.market.demandIndex = Math.min(2.0, s.market.demandIndex * 1.35);
        s.effects.demandBoomQuarters = Math.max(s.effects.demandBoomQuarters || 0, 5);
        return '주요 권역 간 항공자유화 협정이 발효됐다. 신규 노선이 열리며 기재 수요가 뛴다.';
      },
    },
  ];

  /** 역사적 사건이 실제로 일어날 확률. 나머지는 가상 충격으로 대체된다. */
  const HISTORICAL_ODDS = 0.6;

  root.AirlinerData = {
    CONFIG,
    SEGMENTS,
    SEGMENT_ORDER,
    FUSELAGE_MATERIALS,
    WING_MATERIALS,
    LEGACY_MATERIAL_MAP,
    LINE_GRADES,
    RETOOL_COST_RATE,
    OUTSOURCING,
    AIRLINES,
    FIELD_REQUIREMENT,
    UPGAUGE_PER_YEAR,
    ETOPS_RANGE_KM,
    RANGE_TOLERANCE,
    ETOPS_USEFUL_RANGE,
    BID_PLEDGES,
    BID_FINANCING,
    RIVAL_STRENGTH_CAP,
    RIVAL_STRENGTH_FLOOR,
    RIVAL_DRIFT_LIMIT,
    EVENTS,
    HISTORICAL,
    FICTIONAL_SHOCKS,
    HISTORICAL_ODDS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
