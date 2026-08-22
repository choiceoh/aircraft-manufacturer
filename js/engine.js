/*
 * 게임 엔진 — 상태 생성, 플레이어 행동, 분기 정산.
 *
 * 규칙: 이 파일은 DOM을 모른다. 모든 함수는 state를 받아 state를 바꾸고 로그를 남긴다.
 * 덕분에 test/engine.test.cjs 에서 브라우저 없이 전체 시뮬레이션을 돌릴 수 있다.
 */
(function (root) {
  'use strict';

  const {
    CONFIG,
    SEGMENTS,
    AIRLINES,
    EVENTS,
    HISTORICAL,
    FICTIONAL_SHOCKS,
    HISTORICAL_ODDS,
    ETOPS_RANGE_KM,
    ETOPS_USEFUL_RANGE,
    LINE_GRADES,
    RETOOL_COST_RATE,
    OUTSOURCING,
    WING_MATERIALS,
    LEGACY_MATERIAL_MAP,
    BID_PLEDGES,
    BID_FINANCING,
    AFTERMARKET_PER_UNIT,
    AFTERMARKET_PER_UNIT_BY_SEG,
    AFTERMARKET_TIERS,
    FREIGHTER,
    GOV_MISSIONS,
    SCENARIOS,
    RESEARCH_PROJECTS,
    TAKEOVER,
    RIVAL_DRIFT_LIMIT,
  } = root.AirlinerData;
  const { MANUFACTURERS, AIRCRAFT, availableTypes, typeScore } = root.AirlinerFleet;
  const { evaluate, unitCostAt, clamp } = root.AirlinerDesign;
  const { generateRfps, makeRfp, scoreBid, resolveBid, normalizeTerms } = root.AirlinerBidding;
  const { createRng } = root.AirlinerRng;
  const Decisions = root.AirlinerDecisions;

  /** 금액 표기: 1000M$ 이상은 B$로 접는다. */
  function fmtMoney(m) {
    const v = Math.round(m);
    if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(2)}B`;
    return `$${v}M`;
  }

  /** 턴 인덱스 → 소수 연도 (1998.0 = 1998년 1분기). 엔진·기종 카탈로그가 이 값을 쓴다. */
  function yearOf(turn) {
    return CONFIG.startYear + turn / 4;
  }

  function turnLabel(turn) {
    const year = CONFIG.startYear + Math.floor(turn / 4);
    // 승계 기종의 착수 턴은 음수다(-40 = 1988년). JS 의 % 는 음수에서 음수를 내므로
    // 그대로 쓰면 "1988년 -2분기" 같은 분기가 나온다.
    const q = (((turn % 4) + 4) % 4) + 1;
    return `${year}년 ${q}분기`;
  }

  // ─────────────────────────────── 상태 생성 ───────────────────────────────

  /**
   * 플레이어블 회사 — 가상 승계사(기준 난이도) 또는 실제 제조사.
   * 실제 제조사를 고르면 그 회사는 경쟁 명단에서 빠지고, 1998년 실제 위치를
   * 본뜬 승계 상태(주력기·선단·자금 규모)에서 시작한다. 등급 문턱은 데네브
   * 기준으로 조정돼 있다 — 거인으로 시작하면 점수는 쉽게 나온다. 그게 거인이다.
   *
   * ── 회사 특성(사풍) ──
   *
   * 승계 상태만 다르고 20년의 플레이가 같으면, 회사 선택은 난이도 슬라이더에
   * 이름을 붙인 것에 지나지 않는다. `trait` 의 값들은 게임 내내 살아 있는
   * **규칙의 차이**다. 전부 선택 항목이고, 없으면 기준(데네브)이다.
   *
   *   home       : 본국·전통 고객(항공사 id). 시작 관계가 높고, 그 항공사 수주전에서
   *                가산점을 받는다. 실제 선단 이력에서 골랐다 — 라이언에어는 737 만
   *                굴렸고, KLM 시티호퍼는 E-Jet 을, 비데뢰에는 Dash 8 을 굴렸다.
   *   focus      : 세그먼트별 개발비·기간 배수. "그 회사가 잘하는 급"과 "남의 급".
   *                원형이든 파생형이든 그 급이면 붙는다.
   *   deriv      : 파생형 개발비·기간 배수. 급을 가리지 않고 파생형에만 붙는다 —
   *                CRJ 를 다섯 번 늘려 본 회사의 값이다.
   *   gov        : 정부 특수기 사업 보정 — 자격 문턱(인도 실적)·낙찰 확률·지원 수익.
   *   aid        : 정부 런치 에이드 보정 — 지원율과 무역 긴장.
   *   foreignBid : 서방 시장 감점. 평판이 오르면 사라진다 — 벽이지 천장이 아니다.
   *                `certification` 이 있으면 기종별로 값을 치르고 단번에 뚫을 수도 있다.
   *   stateOrders: 본국 정부·국영 항공사의 무입찰 발주. 곳간의 바닥을 받쳐 주되 단가가 짜다.
   *
   * 균형의 원칙은 설계 축과 같다: **모든 특색은 양방향이다.** 방산이 센 회사는
   * 지원금이 약하고, 지원금이 후한 회사는 무역 분쟁의 표적이 된다.
   */
  const PLAYABLE_COMPANIES = [
    {
      id: 'deneb', name: '데네브 항공우주', makers: [], difficulty: '기준',
      desc: '가상의 중견 제조사. 낡은 주력기 하나와 20년 — 이 게임의 원래 이야기다.',
      trait: { name: '무색무취', note: '본국도 방산도 정부도 없다. 오로지 설계와 영업으로 서는 회사 — 이 게임의 기준선이다.' },
      cash: CONFIG.startCash, debt: CONFIG.startDebt, engineers: CONFIG.startEngineers,
      reputation: CONFIG.startReputation, rivalDelivered: 240, overheadMult: 1, scoreMult: 1,
      legacies: [
        { name: 'DN-150', segment: 'narrow', seats: 150, range: 4800, tech: 38, engine: 'cfm56-3',
          produced: 186, fleets: [['panamer', 62], ['hanul', 48]], backlog: [['panamer', 24], ['hanul', 16]] },
      ],
      intro: '주력기 DN-150이 아직 현금을 벌어다 주지만, 설계는 이미 낡았다.',
    },
    {
      id: 'boeing', name: '보잉', makers: ['boeing'], difficulty: '쉬움',
      desc: '시애틀의 거인. 협동체와 광동체 두 주력, 두터운 선단 — 대신 에어버스가 전력으로 온다.',
      trait: {
        name: '방산의 유산',
        note: '광동체가 집이고 군이 오랜 고객이다. 대신 리저널은 남의 시장이고, 워싱턴은 개발비를 대주지 않는다.',
        home: ['panamer', 'vertex'],
        focus: { wide: { cost: 0.92, time: 0.95 }, regional: { cost: 1.12, time: 1.05 } },
        gov: { deliveredMult: 0.5, winBonus: 0.12, sustainMult: 1.3 },
        aid: { rateMult: 0.6, tensionMult: 0.5 },
      },
      cash: 9500, debt: 5200, engineers: 7800, reputation: 63, rivalDelivered: 620,
      // 거인의 값: 본사·법무·연금이 무겁고(간접비 ×1.7), 등급은 출발선을 감안해 환산된다.
      overheadMult: 1.7, scoreMult: 0.45,
      legacies: [
        { name: '737-400', segment: 'narrow', seats: 150, range: 4200, tech: 42, engine: 'cfm56-3',
          produced: 520, fleets: [['vertex', 70], ['panamer', 55]], backlog: [['vertex', 20], ['panamer', 12]] },
        { name: '767-300ER', segment: 'wide', seats: 269, range: 11000, tech: 45, engine: 'cf6-80c2', etopsCertified: true,
          produced: 210, fleets: [['albion', 30], ['oceanic', 24]], backlog: [['oceanic', 6]] },
      ],
      intro: '737 라인이 현금을 찍고 767이 대양을 건넌다. 다만 둘 다 설계가 한 세대 전 것이다.',
    },
    {
      id: 'airbus', name: '에어버스', makers: ['airbus'], difficulty: '쉬움',
      desc: '툴루즈의 도전자. A320의 기세와 A330의 대양 — 보잉의 아성을 허물어야 한다.',
      trait: {
        name: '컨소시엄의 정치력',
        note: '협동체가 집이고 각국 정부가 개발 위험을 나눠 진다. 대신 그 돈이 무역 분쟁의 표적이고, 군은 우리 고객이 아니다.',
        home: ['albion', 'hanul'],
        focus: { narrow: { cost: 0.9, time: 0.95 } },
        gov: { winBonus: -0.06, sustainMult: 0.85 },
        aid: { rateMult: 1.4, tensionMult: 1.6 },
      },
      cash: 8800, debt: 6000, engineers: 7200, reputation: 59, rivalDelivered: 780,
      overheadMult: 1.65, scoreMult: 0.5,
      legacies: [
        { name: 'A320', segment: 'narrow', seats: 164, range: 5600, tech: 50, engine: 'cfm56-5b',
          produced: 340, fleets: [['kosmo', 48], ['albion', 26]], backlog: [['kosmo', 14]] },
        { name: 'A330-300', segment: 'wide', seats: 277, range: 10400, tech: 48, engine: 'trent700', etopsCertified: true,
          produced: 96, fleets: [['asialink', 22]], backlog: [['asialink', 8]] },
      ],
      intro: 'A320은 아직 젊고 A330은 팔리는 중이다. 출발선은 좋다 — 문제는 바다 건너의 거인이다.',
    },
    {
      id: 'embraer', name: '엠브라에르', makers: ['embraer'], difficulty: '어려움',
      desc: '상파울루의 복병. 리저널 틈새 하나로 시작해 위로 올라가야 한다.',
      trait: {
        name: '리저널의 장인',
        note: '지선 기체는 누구보다 싸고 빠르게 만든다. 다만 광동체는 다른 세계다 — 계단이 가파르다.',
        home: ['meridian', 'lumen'],
        focus: { regional: { cost: 0.85, time: 0.92 }, wide: { cost: 1.2, time: 1.08 } },
        gov: { deliveredMult: 0.7 },
        aid: { rateMult: 1.25, tensionMult: 0.7 },
      },
      cash: 4400, debt: 1300, engineers: 1800, reputation: 46, rivalDelivered: 260,
      // 복병의 위안: 몸집이 작아 간접비도 작고(×0.6), 등급 환산은 후하다.
      overheadMult: 0.6, scoreMult: 1.5,
      legacies: [
        { name: 'ERJ-145', segment: 'regional', seats: 74, range: 2600, tech: 48, wing: 38, engine: 'ae3007',
          produced: 140, fleets: [['lumen', 40], ['sahara', 22]], backlog: [['sahara', 30], ['nordic', 20]] },
      ],
      intro: 'ERJ가 피더 시장을 뚫었다. 리저널의 얇은 마진 위에서 다음 급을 노려야 한다.',
    },
    {
      id: 'uac', name: 'UAC (통합항공기제작사)', makers: ['tupolev', 'sukhoi'], difficulty: '어려움',
      desc: '러시아 통합 항공. Tu-204와 4발 Il-96M, 서랍 속 SSJ-100 설계안 — 다 가졌지만 전부 미완이다.',
      trait: {
        name: '국가의 주문 · 서방의 벽',
        note: '국가가 개발비를 대고 곳간이 비면 발주로 메워 준다. 대신 북미·서유럽 항공사는 인증과 정비망을 믿지 않는다 — 평판으로 천천히 녹거나, 서방 형식증명을 사서 기종별로 단번에 뚫거나.',
        home: ['kosmo'],
        gov: { deliveredMult: 0.4, winBonus: 0.15, sustainMult: 1.15 },
        aid: { rateMult: 1.6, tensionMult: 0 },
        foreignBid: {
          regions: ['북미', '서유럽'],
          penalty: 3,
          fadeFrom: 45,
          fadeTo: 75,
          // 서방 형식증명(EASA/FAA) — 평판을 기다리는 대신 **기종 하나씩** 값을 치르고
          // 벽을 지운다. SSJ-100 이 2012년에 EASA 형식증명을 받은 것이 이 항목이다.
          // 심사는 우리 규제 당국이 아니라 상대 당국이 한다: 돈과 분기를 내고, 그동안
          // 설계를 고치라는 지적이 붙는다.
          certification: { costRate: 0.09, quarters: 6, findingChance: 0.4 },
        },
        // 자회사 UEC — 서방 엔진을 국산으로 갈아 끼우는 사업. 시간과 돈을 **둘 다**
        // 채워야 끝난다: 돈을 아무리 부어도 minQuarters 는 안 줄고, 분기가 아무리
        // 지나도 자금이 안 차면 안 끝난다. 실제 엔진 개발이 그렇다.
        localEngine: {
          maker: 'UEC',
          // 대체 대상 엔진의 세그먼트 → 그 자리를 메울 국산 엔진.
          // PS-90A 는 실제로 Tu-204(협동체)와 Il-96(광동체)을 모두 돌렸다.
          map: { regional: 'd436', narrow: 'ps90a', wide: 'ps90a' },
          /** 개발비 = 그 세그먼트 개발비 기준 × 이 비율 */
          costRate: 0.25,
          /** 돈을 다 부어도 이보다 빨리는 안 끝난다 */
          minQuarters: 10,
          /** 국산 엔진을 단 기종에 붙는 국가 발주 단가 우대 (정가 대비 가산) */
          stateBonus: 0.08,
          // 2세대(PD) — 1세대를 지나온 회사만 연다. 1세대가 원가를 사고 수주
          // 경쟁력을 판 거래였다면, 이쪽은 그것을 **되사 오는** 사업이다. 새 코어라
          // 훨씬 비싸고 길고, 원가 우위를 상당 부분 반납한다.
          gen2: {
            map: { regional: 'pd8', narrow: 'pd14', wide: 'pd35' },
            costRate: 0.45,
            minQuarters: 14,
          },
        },
        // 국가 발주 — 수출이 막혀도 곳간이 완전히 마르지는 않는다. 대신 단가가 짜서
        // 여기에 기대면 살아는 남고 크지는 못한다.
        stateOrders: {
          customer: '국영 항공사',
          segments: ['regional', 'narrow', 'wide'],
          cooldown: 11,
          qty: [6, 12],
          priceMult: 0.78,
        },
      },
      cash: 2200, debt: 4200, engineers: 3800, reputation: 36, rivalDelivered: 380,
      overheadMult: 0.9, scoreMult: 0.8,
      legacies: [
        // 실제 러시아 라인은 연 몇 대를 겨우 냈다 — 라인 용량이 서방의 몇 분의 일이다.
        { name: 'Tu-204', segment: 'narrow', seats: 196, range: 4300, tech: 42, engine: 'cfm56-5b',
          produced: 40, lineCapacity: 5, fleets: [['kosmo', 24]], backlog: [['kosmo', 12]] },
        // Il-96 은 4발이다 — ETOPS 없이 대양을 건너는, 이 게임 엔진 수 축의 산 증인.
        { name: 'Il-96M', segment: 'wide', seats: 262, range: 11500, tech: 40, engine: 'pw4000', engines: 4,
          produced: 24, lineCapacity: 1, fleets: [['kosmo', 10]], backlog: [['kosmo', 4]] },
      ],
      // 서랍 속 설계안 — 개발 15%에서 동결된 채 인계된다. 밀지 말지는 플레이어의 몫.
      devPrograms: [
          // 1998년엔 SaM146 이 없다 — CF34 로 설계를 시작하고, SaM146(조기 접근으로
        // 2009년부터)은 나중에 재장착 파생으로 다는 것이 이 회사의 실제 항로다.
        { name: 'SSJ-100', segment: 'regional', seats: 98, range: 3050, tech: 58, engine: 'cf34-3', progress: 15 },
      ],
      // 수호이를 품었으니 SaM146 런칭 파트너 지위도 승계한다 (2009년부터 쓸 수 있다).
      earlyEngines: ['sam146'],
      intro: 'Tu-204와 Il-96이 옛 소련권을 지키고, 서랍에는 SSJ-100 설계안이 잠들어 있다. 서방 시장이 숙제다.',
    },
    {
      id: 'bombardier', name: '봉바르디에', makers: ['bombardier'], difficulty: '어려움',
      desc: '몬트리올의 승부사. CRJ로 버는 동안 더 큰 기체로 올라설 길을 찾아야 한다.',
      trait: {
        name: '계보의 승부사',
        note: 'CRJ 를 늘리고 또 늘려 본 회사다 — 파생형이 남들보다 싸고 빠르다. 대신 백지에서 큰 기체를 그리는 일은 여전히 비싸다.',
        home: ['nordic', 'panamer'],
        focus: { regional: { cost: 0.94, time: 0.97 }, wide: { cost: 1.15, time: 1.05 } },
        deriv: { cost: 0.85, time: 0.9 },
        aid: { rateMult: 1.25, tensionMult: 0.7 },
      },
      cash: 4600, debt: 1500, engineers: 1900, reputation: 47, rivalDelivered: 300,
      overheadMult: 0.62, scoreMult: 1.45,
      legacies: [
        { name: 'CRJ-200', segment: 'regional', seats: 72, range: 2400, tech: 47, wing: 36, engine: 'cf34-3',
          produced: 170, fleets: [['nordic', 36], ['lumen', 20]], backlog: [['nordic', 26], ['sahara', 22]] },
      ],
      intro: 'CRJ가 지선을 지배한다. 다만 리저널만으로 20년을 버틸 수는 없다.',
    },
  ];

  function companyPreset(id) {
    return PLAYABLE_COMPANIES.find((c) => c.id === id) || PLAYABLE_COMPANIES[0];
  }

  /** 본국·전통 고객의 시작 관계 하한. 승계 선단(58)보다 조금 높다. */
  const HOME_START_RELATION = 62;

  /** 이 판의 사풍. 옛 세이브는 빈 객체 — 모든 보정이 기준값이 된다. */
  function companyTrait(s) {
    return (s && s.trait) || {};
  }

  function homeAirlines(s) {
    return companyTrait(s).home || [];
  }

  function newGame(seed, companyName, scenarioId) {
    // 시나리오는 회사를 강제한다 — 목표와 시작 조건이 그 회사 전제로 잡혀 있다.
    const scenario = scenarioId ? SCENARIOS.find((x) => x.id === scenarioId) || null : null;
    if (scenario) companyName = scenario.company;
    // companyName 이 프리셋 id 면 그 회사로 시작한다. 아니면 기준 회사에 그 이름을 붙인다
    // (옛 호출·테스트 호환 — newGame(seed) / newGame(seed, '내 회사') 모두 그대로 돈다).
    const isPresetId = PLAYABLE_COMPANIES.some((c) => c.id === companyName);
    const preset = isPresetId ? companyPreset(companyName) : companyPreset('deneb');
    const s = {
      version: 1,
      seed: seed >>> 0,
      rngState: seed >>> 0,
      // 프리셋 id 로 시작하면 항상 프리셋의 회사명이다 — 'deneb' 을 넘겼는데
      // 회사명이 "deneb" 이 되면 화면·로그·점수 내역이 전부 그 문자열을 문다.
      company: isPresetId ? preset.name : companyName || preset.name,
      // 이 회사가 실존 제조사(들)라면 그 제조사는 경쟁 명단·시장 배분에서 빠진다.
      // UAC 처럼 여러 제조사를 흡수한 회사가 있어 배열이다.
      playerMakers: preset.makers,
      // 회사 규모의 값 — 간접비 배수. 그리고 출발선을 감안한 등급 환산 배수.
      overheadMult: preset.overheadMult,
      scoreMult: preset.scoreMult,
      // 사풍 — 본국 시장·개발 특기·방산·지원금. 20년 내내 규칙으로 살아 있다.
      // 상태에 복사해 둔다: 세이브만 있고 프리셋 id 는 없는 판(이름을 직접 지은
      // 데네브)도 자기 특성을 잃지 않아야 하고, 프리셋 값을 나중에 손봐도
      // 진행 중인 판의 규칙이 도중에 바뀌지 않는다.
      //
      // **얕은 복사가 필수다.** 프리셋 객체를 그대로 물리면 상태가 공용 카탈로그를
      // 가리키게 되고, ensureShape 의 사풍 채우기가 그 카탈로그를 통째로 오염시킨다
      // (한 판에서 UAC 를 불러오면 그 프로세스의 데네브 프리셋에 UAC 축이 붙는 식).
      trait: { ...(preset.trait || {}) },
      turn: 0,
      nextId: 1,
      cash: preset.cash,
      debt: preset.debt,
      reputation: preset.reputation,
      engineers: preset.engineers,
      market: { fuelIndex: 1.0, demandIndex: 1.0 },
      effects: {
        strikeQuarters: 0,
        supplyQuarters: 0,
        grounded: {}, // programId → 남은 정지 분기수 (기종별로 독립)
        rateBump: 0,
        rateBumpQuarters: 0,
        // 차환 감면 — 가산과 상쇄되지 않도록 슬롯을 따로 둔다.
        rateCut: 0,
        rateCutQuarters: 0,
      },
      programs: [],
      lines: [],
      backlog: [],
      relations: {},
      // 항공사별 우리 기체 보유량 (airlineId → programId → 대수). 선단 공통성 가산의 근거.
      fleets: {},
      competitors: newCompetitors(preset.makers),
      rfps: [],
      bids: {},
      log: [],
      history: [],
      stats: {
        delivered: 0,
        revenue: 0,
        rivalDelivered: preset.rivalDelivered,
        ordersWon: 0,
        bidsMade: 0,
        // 경쟁 서사용 장부 — 총량만으로는 "누구에게 밀리고 있는가"가 보이지 않는다.
        rivalByMaker: {},
        duels: {},
        // 분기말 이력만 보면 분기 중에 빌렸다 갚은 봉우리가 통째로 빠진다.
        peakDebt: 0,
        // 승계 선단 덕에 시작부터 43%대다. 이력만 보면 그 출발점이 회고에서 사라진다.
        peakShare: 0,
      },
      // 분기 중 즉시 발생한 실적(재고 처분 등) — 다음 endTurn 리포트가 흡수한다.
      pending: { revenue: 0, delivered: 0, rdCost: 0, capex: 0, overhead: 0, ordersWon: 0, productionCost: 0 },
      events: [],
      // 이번 분기 업계 동향 (경쟁사 취항·단산). 개요 화면이 읽는다.
      news: [],
      // 지금 답을 기다리는 결정 사건. 고르지 않고 분기를 넘기면 fallback 이 적용된다.
      decision: null,
      // 결정의 지연 결과 — { turn, id, optionId, memo }. 그 분기가 오면 정산한다.
      pendingOutcomes: [],
      // 자체 금융으로 넘긴 대금 — { turn, amount, airlineName }. 분기마다 회수한다.
      receivables: [],
      // 애프터마켓(부품·정비) 투자 수준. 인도한 기체가 쌓일수록 값을 한다.
      aftermarket: 'none',
      // 장기 기술 연구 — 한 번에 한 프로젝트, 완료(done)는 영구다.
      research: { active: null, progress: {}, done: {} },
      // 경쟁사에서 인수한 기종 — 경쟁 카탈로그에서 내려온다.
      acquiredTypes: {},
      // 5년 단위 이사회 목표. newGame 에서 첫 목표를 발령한다.
      mandate: null,
      // 증자 횟수와 누적 지분 희석 — 최종 점수에서 그만큼 우리 몫이 아니다.
      equityRounds: 0,
      equityDilution: 0,
      // 조달 전략 — 원가 ↔ 공급 차질 위험.
      outsourcing: 'mid',
      // 이번 판의 충격 일정표 (역사 실현분 + 가상 대체분). newGame 에서 확정된다.
      shocks: [],
      // 경쟁사 드라마 — 신기종 발표·개발 지연·초기 결함 파동. newGame 에서 확정된다.
      // 지연은 조회 시점에 카탈로그 eis 에 얹고(rivalDelays), 위기는 그 기종의
      // 수주 경쟁력을 몇 분기 깎는다(rivalCrises).
      rivalDrama: [],
      rivalDelays: {},
      rivalCrises: {},
      // 엔진 공급사 관계 — 그 공급사 엔진을 단 인도 실적이 공급사별로 쌓인다.
      // 독점 계약·런칭 파트너 제안의 전제 조건이 이 장부다.
      engineRelations: {},
      engineDeal: null,
      engineEarlyAccess: {},
      // 정부 지원금이 쌓는 무역 긴장 — 문턱을 넘으면 관세 판정이 날아온다.
      tradeTension: 0,
      // UEC 국산화 — 진행 중인 사업 { target, engine, cost, funded, quarters }
      // 과 이미 해금한 국산 엔진 id 목록.
      localEngineProject: null,
      localEngines: [],
      // 이 회사가 남긴 순간들 — 첫 인도, 100호기, 첫 광동체. 종료 회고의 연표가 된다.
      milestones: [],
      gameOver: null,
    };
    for (const a of AIRLINES) s.relations[a.id] = 34 + (a.prestige < 0.8 ? 10 : 0);
    // 본국·전통 고객은 초면이 아니다. 승계 선단이 없는 항공사라도 그 회사의
    // 영업소가 수십 년째 그 도시에 있다 — 관계는 승계 선단과 별개로 시작한다.
    for (const aid of homeAirlines(s)) {
      if (s.relations[aid] !== undefined) s.relations[aid] = Math.max(s.relations[aid], HOME_START_RELATION);
    }
    // 승계 부채가 봉우리의 출발점이다. 첫 정산 전에 갚아 버리면 이력에 한 번도 안 남는다.
    markDebtPeak(s);

    seedLegacyProgram(s, preset);
    // 승계 선단이 들어온 **뒤에** 재야 시작 점유율이 잡힌다 — 규모는 회사마다 다르다
    // (데네브 186기·43.7%, 보잉 730기, 복병은 140~170기).
    s.stats.peakShare = marketShare(s);

    // 시나리오 시작 조건은 **파생값보다 먼저** 덮어쓴다. 뒤에 하면 첫 분기 금리
    // 캐시·이사회 목표·개장 로그가 전부 건강한 재무 기준으로 굳는다 — 잿더미
    // 회사가 첫 분기에 BBB 금리를 쓰고, 로그는 $4.2B 자본금을 자랑하게 된다.
    // 난수를 쓰지 않으므로 시드 전개(충격·드라마·수주)는 그대로다.
    if (scenario && scenario.tweaks) {
      if (typeof scenario.tweaks.cash === 'number') s.cash = scenario.tweaks.cash;
      if (typeof scenario.tweaks.debt === 'number') s.debt = scenario.tweaks.debt;
      s.stats.peakDebt = Math.max(s.stats.peakDebt || 0, s.debt);
    }

    const rng = rngFor(s);
    s.shocks = buildShockSchedule(s, rng);
    // 드라마는 **별도 난수열**로 뽑는다. 본류(rng)에 끼우면 드라마 규칙을 손볼 때마다
    // 같은 시드의 모든 전개가 통째로 갈려, 밸런스 변화와 시드 재편이 구분되지 않는다.
    const drama = buildRivalDrama(s.seed, preset.makers);
    s.rivalDrama = drama.events;
    s.rivalDelays = drama.delays;
    issueMandate(s, rng);
    s.rfps = generateRfps(s, rng);
    s.ratingForQuarter = creditRating(s).grade;
    s.rateForQuarter = interestRate(s);
    saveRng(s, rng);

    pushLog(s, 'info', `${s.company} 경영을 인계받았다. 자본금 ${fmtMoney(s.cash)}, 차입금 ${fmtMoney(s.debt)}. ${preset.intro}`);
    pushLog(s, 'info', `20년 안에 후속기를 띄워 시장을 잡아라. ${s.programs[0] ? s.programs[0].name : '주력기'}의 수명은 길지 않다.`);

    // 시나리오 표식과 소개 — 시작 조건 자체는 위(파생값 이전)에서 이미 덮어썼다.
    if (scenario) {
      s.scenario = scenario.id;
      pushLog(s, 'event', `[시나리오 · ${scenario.name}] ${scenario.desc}`);
      pushLog(s, 'event', `목표: ${scenario.goalText}. 파산하면 어떤 목표든 실패다.`);
    }
    return s;
  }

  /**
   * 시작 시점의 "노후 주력기". 이 게임의 출발점은 창업이 아니라 승계다.
   * 개발에는 5년 넘게 걸리는데 신생사는 그 사이 현금이 말라 죽으므로,
   * 플레이어에게 후속기 개발을 버텨낼 캐시카우를 쥐여준다.
   * 대신 연비가 낮아 유가가 오르거나 경쟁사가 신형을 내면 급속히 경쟁력을 잃는다.
   */
  function seedLegacyProgram(s, preset) {
    // 1990년대 설계라 그 시절 엔진을 달고 있다 — 지금 기준으로는 연비가 처진다.
    // 어느 회사를 골랐든 승계라는 출발점은 같다: 이미 팔리는 기체, 이미 있는 선단.
    s.fleets = {};
    for (const leg of (preset || companyPreset('deneb')).legacies) {
      // ETOPS 실적이 있는 승계기는 설계 플래그도 켠다 — 안 켜면 화면이 "ETOPS 없음"을
      // 보여주고 파생형 시드가 그 자격을 잃는다 (4발은 evaluate 가 알아서 끈다).
      const spec = { segment: leg.segment, seats: leg.seats, range: leg.range, tech: leg.tech, material: 'aluminum', engine: leg.engine, wing: leg.wing, engines: leg.engines, etops: !!leg.etopsCertified, year: yearOf(0) };
      const ev = evaluate(spec);
      const p = {
        id: 'prog-' + s.nextId++,
        name: leg.name,
        ...ev,
        phase: 'production',
        progress: 100,
        spent: ev.devCost,
        certRemaining: 0,
        qualityInvests: 1,
        share: 0,
        produced: leg.produced, // 이미 학습곡선을 상당히 내려온 상태
        delivered: leg.produced,
        stock: 0,
        launchTurn: -40,
        engineTurn: -40,
        certTurn: -8,
        derivedFrom: null,
        legacy: true,
      };
      // 오랜 운용으로 초기 결함은 대부분 잡혔다. 광동체 승계기는 ETOPS 실적도 있다.
      p.defectRisk = Math.round(p.defectRisk * 0.7 * 1000) / 1000;
      if (leg.etopsCertified) p.etopsCertified = true;
      // 767을 물려받은 회사가 다음 광동체에서 "첫 광동체 인도"를 축하받으면 안 된다.
      if (leg.segment === 'wide') s.stats.firstWideDone = true;
      s.programs.push(p);

      s.lines.push({
        id: 'line-' + s.nextId++,
        programId: p.id,
        capacity: leg.lineCapacity || SEGMENTS[leg.segment].lineMaxRate,
        // 저율 생산 라인의 핸디캡은 설비의 성질이다 — 전환해도 따라간다.
        // 새 라인을 제값 주고 세우는 것이 이 핸디캡을 벗는 유일한 길이다.
        capMult: leg.lineCapacity ? leg.lineCapacity / SEGMENTS[leg.segment].lineMaxRate : 1,
        ramp: 1,
        partial: 0,
        idle: false,
        builtTurn: -8,
      });
      s.stats.delivered += p.delivered;
      // 물려받은 것은 기체만이 아니라 엔진 공급사와의 거래다 — 730기를 인도한
      // 보잉이 "거래 이력 없음"으로 시작하면 독점 계약·런칭 파트너 제안이
      // 몇 년간 잠긴다. 실존 제조사만 승계한다: 가상 데네브는 협상 테이블이
      // 아직 없는 중견사라는 것이 기준 난이도의 일부다 (넣어 보니 결정 순환이
      // 흔들려 40시드 파산 11→15로 굳었다 — 의도한 기준이 아니다).
      const legMaker = (root.AirlinerEngines.get(p.engine) || {}).maker;
      if (legMaker && preset.makers.length) {
        s.engineRelations[legMaker] = (s.engineRelations[legMaker] || 0) + p.delivered;
      }

      // 인계받은 선단과 수주 잔고 — 선단 공통성 가산이 여기서 시작되므로
      // 이 계정들은 지켜야 할 자산이고 나머지는 새로 뚫어야 할 시장이다.
      for (const [aid, units] of leg.fleets) {
        s.fleets[aid] = s.fleets[aid] || {};
        s.fleets[aid][p.id] = units;
        // 우리 기체를 수십 기 굴리는 항공사가 초면일 리 없다 — 열린 주문이
        // 없어도 관계는 승계된다. 관계는 입찰 점수에 직접 들어간다.
        s.relations[aid] = Math.max(s.relations[aid] || 0, 58);
      }
      for (const [aid, qty] of leg.backlog) {
        const a = AIRLINES.find((x) => x.id === aid);
        s.backlog.push({
          id: 'ord-' + s.nextId++,
          airlineId: aid,
          airlineName: a ? a.name : aid,
          programId: p.id,
          programName: p.name,
          qty,
          remaining: qty,
          unitPrice: Math.round(p.listPrice * 0.92 * 10) / 10,
          wonTurn: -4,
        });
        // 선단과 같은 하한이되 **덮어쓰지는 않는다**. 대입으로 두면 이미 더 높게
        // 잡힌 관계(본국·전통 고객)를 열린 주문이 있다는 이유로 오히려 끌어내린다.
        s.relations[aid] = Math.max(s.relations[aid] || 0, 58);
      }
    }

    // 서랍 속 설계안 — 진행 중인 개발을 동결 상태로 인계받는다 (UAC 의 SSJ-100).
    // 밀어붙일지, 서랍에 도로 넣을지는 플레이어의 첫 결정이 된다.
    for (const d of preset.devPrograms || []) {
      const ev = evaluate({ segment: d.segment, seats: d.seats, range: d.range, tech: d.tech, material: 'aluminum', engine: d.engine, year: yearOf(0) });
      s.programs.push({
        id: 'prog-' + s.nextId++,
        name: d.name,
        ...ev,
        phase: 'dev',
        progress: d.progress,
        // advanceDevelopment 는 매 진행분에서 착수금(8%) 몫을 뺀 값을 청구한다 —
        // 진행률만큼만 시딩하면 완성 총액이 광고한 개발비보다 싸진다. 전 소유자가
        // 착수금을 이미 낸 것으로 본다: 착수금 + 진행분×(1−착수율).
        spent: Math.round(ev.devCost * (CONFIG.launchUpfrontRate + (d.progress / 100) * (1 - CONFIG.launchUpfrontRate))),
        certRemaining: ev.certQuarters,
        qualityInvests: 0,
        share: 0,
        produced: 0,
        delivered: 0,
        stock: 0,
        launchTurn: 0,
        engineTurn: 0,
        certTurn: null,
        derivedFrom: null,
      });
    }
    // 흡수한 제조사의 런칭 파트너 지위 — 그 엔진이 남들보다 먼저 열린다.
    for (const engId of preset.earlyEngines || []) s.engineEarlyAccess[engId] = true;
  }

  /**
   * 나중에 추가된 필드를 기본값으로 채운다.
   * 세이브 version은 그대로 1이라 이전 커밋의 저장본도 로드되는데, 그 상태로
   * 새 필드를 건드리면 현금만 차감한 채 예외가 나 행동이 반쯤 적용된다.
   * 상태를 바꾸는 진입점에서 먼저 호출한다.
   */
  /**
   * 경쟁사 상태. 세그먼트별 경쟁력 자체는 fleet 카탈로그가 시점별로 만들어 주므로
   * 여기 남는 건 이벤트가 얹는 보정치(drift)뿐이다.
   */
  function newCompetitors(playerMakers) {
    return MANUFACTURERS.filter((m) => !(playerMakers || []).includes(m.id)).map((m) => ({
      id: m.id,
      name: m.name,
      // drift 는 이벤트가 얹는 보정치, reaction 은 우리 성적에 대한 가격 공세다.
      // 한 칸을 같이 쓰면 반격의 감쇠가 이벤트 보정을 지우고, 이벤트가 준 마이너스
      // 보정은 반격 로직의 감쇠 경로에 걸리지 않아 영원히 남는다.
      drift: { regional: 0, narrow: 0, wide: 0 },
      reaction: { regional: 0, narrow: 0, wide: 0 },
    }));
  }

  /**
   * 실명 교체(2026) 이전 세이브가 쓰던 가상 표기 — 열려 있는 결정 사건의 본문은
   * memo 에 이름을 안 남기는 사건도 있어, id 로 못 찾고 이 사전으로 훑는다.
   */
  const LEGACY_AIRLINE_NAMES = {
    hanul: '한울항공', carta: '카르타 에어', nordic: '노르딕윙스', panamer: '판아메르 항공',
    asialink: '아시아링크', albion: '알비온 항공', meridian: '메리디안 항공', sahara: '사하라 에어',
    oceanic: '오세아닉', kosmo: '코스모항공', lumen: '루멘 에어라인', vertex: '버텍스 제트',
  };

  function ensureShape(s) {
    if (!s.effects) s.effects = {};
    if (!s.effects.grounded) {
      s.effects.grounded = {};
      // 단일 슬롯이던 옛 형식(groundedProgram/groundedQuarters)을 그대로 버리면
      // 불러온 순간 정지가 풀려 인도가 재개된다. 남은 기간을 옮겨온다.
      if (s.effects.groundedProgram && s.effects.groundedQuarters > 0) {
        s.effects.grounded[s.effects.groundedProgram] = s.effects.groundedQuarters;
      }
      delete s.effects.groundedProgram;
      delete s.effects.groundedQuarters;
    }
    if (!s.pending) s.pending = { revenue: 0, delivered: 0, rdCost: 0, capex: 0, overhead: 0, ordersWon: 0, productionCost: 0 };
    for (const k of ['revenue', 'delivered', 'rdCost', 'capex', 'overhead', 'ordersWon', 'productionCost']) {
      if (typeof s.pending[k] !== 'number') s.pending[k] = 0;
    }
    if (!s.stats) s.stats = { delivered: 0, revenue: 0, rivalDelivered: 240, ordersWon: 0, bidsMade: 0 };
    // 제조사별 장부가 없던 세이브는 빈 장부로 시작한다. 총량(rivalDelivered)은 그대로
    // 두고 배분만 앞으로 쌓는다 — 과거분을 지금 기준으로 역산해 나누면 그때의
    // 카탈로그가 아니라 현재 카탈로그로 배분되어 없던 기종이 인도한 것이 된다.
    if (!s.stats.rivalByMaker || typeof s.stats.rivalByMaker !== 'object') s.stats.rivalByMaker = {};
    if (!s.stats.duels || typeof s.stats.duels !== 'object') s.stats.duels = {};
    // 봉우리를 모르는 세이브는 지금 부채와 분기말 이력의 최댓값에서 시작한다.
    if (typeof s.stats.peakDebt !== 'number') {
      s.stats.peakDebt = (s.history || []).reduce((a, h) => (h.debt > a ? h.debt : a), Math.round(s.debt));
    }
    if (typeof s.stats.peakShare !== 'number') {
      s.stats.peakShare = (s.history || []).reduce(
        (a, h) => (typeof h.share === 'number' && h.share > a ? h.share : a),
        marketShare(s),
      );
    }
    if (!Array.isArray(s.news)) s.news = [];
    if (s.decision === undefined) s.decision = null;
    if (!Array.isArray(s.pendingOutcomes)) s.pendingOutcomes = [];
    if (!Array.isArray(s.receivables)) s.receivables = [];
    if (!AFTERMARKET_TIERS[s.aftermarket]) s.aftermarket = 'none';
    if (s.mandate === undefined) s.mandate = null;
    if (typeof s.equityRounds !== 'number') s.equityRounds = 0;
    if (typeof s.equityDilution !== 'number') s.equityDilution = 0;
    if (typeof s.rateForQuarter !== 'number') s.rateForQuarter = interestRate(s);
    if (typeof s.ratingForQuarter !== 'string') s.ratingForQuarter = creditRating(s).grade;
    // 장기 연구·프로그램 인수 — 이 기능 이전 세이브의 기본값.
    if (!s.research || typeof s.research !== 'object') s.research = { active: null, progress: {}, done: {} };
    if (!s.research.progress || typeof s.research.progress !== 'object') s.research.progress = {};
    if (!s.research.done || typeof s.research.done !== 'object') s.research.done = {};
    if (!s.acquiredTypes || typeof s.acquiredTypes !== 'object') s.acquiredTypes = {};

    if (!OUTSOURCING[s.outsourcing]) s.outsourcing = 'mid';
    for (const l of s.lines || []) {
      if (!LINE_GRADES[l.grade]) l.grade = 'standard';
      if (typeof l.paidCost !== 'number') {
        const lp = s.programs.find((x) => x.id === l.programId);
        const g = LINE_GRADES[l.grade];
        if (lp) l.paidCost = Math.round(SEGMENTS[lp.segment].lineCost * g.costMult);
      }
    }

    if (!s.fleets) {
      // 선단 개념이 없던 세이브를 빈 장부로 두면, 새 판이라면 62·48기를 물려받았을
      // 계정이 "신규 계정"이 되어 공통성 가산(최대 6점)을 통째로 잃는다.
      // 승계분을 다시 심고, 남아 있는 주문 기록에서 실제 인도분을 복원한다.
      s.fleets = {};
      const legacy = s.programs.find((p) => p.legacy);
      if (legacy) {
        s.fleets.panamer = { [legacy.id]: 62 };
        s.fleets.hanul = { [legacy.id]: 48 };
      }
      for (const o of s.backlog || []) {
        const shipped = o.qty - (o.cancelled || 0) - o.remaining;
        if (shipped > 0) addToFleet(s, o.airlineId, o.programId, shipped);
      }
    }

    // 항공사 표시 이름은 카탈로그가 정본이다 (id 는 불변). 가상 이름 시절의
    // 세이브를 불러오면 열린 주문·공고가 옛 이름을 물고 있어 화면에 두 이름이
    // 섞인다 — 표시 문자열만 맞춘다. 완료 주문·로그·마일스톤은 그 시점의 기록이라 둔다.
    for (const o of s.backlog || []) {
      if (!(o.remaining > 0)) continue;
      const a = AIRLINES.find((x) => x.id === o.airlineId);
      if (a && o.airlineName !== a.name) o.airlineName = a.name;
    }
    for (const r of s.rfps || []) {
      const a = AIRLINES.find((x) => x.id === r.airlineId);
      if (!a) continue;
      if (r.airlineName !== a.name) r.airlineName = a.name;
      // 본거지도 표시용이다 — 카탈로그에서 본거지가 옮겨진 항공사의 옛 공고가
      // 새 이름에 옛 본거지를 달고 나오면 안 된다.
      if (r.home !== a.home) r.home = a.home;
    }
    // 열려 있는 결정 사건도 항공사 이름을 물고 있다 (기록이 아니라 진행형이다).
    // memo.airlineName 은 수의계약 수락 시 h.order 로 그대로 들어가므로, 안 맞추면
    // 옛 이름의 주문이 오늘 새로 태어난다. 본문 치환은 **그 사건이 가리키는 항공사의
    // 옛 표기만** 바꾼다 — 사전 전체로 훑으면 플레이어가 기체 이름을 다른 옛 항공사
    // 이름으로 지어 둔 경우까지 덮어쓴다. 항공사 이름을 본문에 싣는 사건은 전부
    // memo.airline 을 남기므로(launch_customer·loyal_direct_order·delivery_slip) 이걸로 충분하다.
    const d = s.decision;
    if (d && d.memo && d.memo.airline) {
      const a = AIRLINES.find((x) => x.id === d.memo.airline);
      const old = LEGACY_AIRLINE_NAMES[d.memo.airline];
      // 어느 기체의 이름이 그 옛 표기를 품고 있으면 본문 치환을 통째로 건너뛴다 —
      // 문자열만으로는 항공사와 기체를 구분할 수 없고, 플레이어가 지은 이름을
      // 덮어쓰는 쪽이 옛 항공사 이름이 카드에 한 번 더 보이는 쪽보다 나쁘다.
      const collides = s.programs.some((p) => typeof p.name === 'string' && old && p.name.includes(old));
      if (a && old && a.name !== old && !collides) {
        if (typeof d.text === 'string' && d.text.includes(old)) d.text = d.text.split(old).join(a.name);
        if (typeof d.name === 'string' && d.name.includes(old)) d.name = d.name.split(old).join(a.name);
      }
      if (a && typeof d.memo.airlineName === 'string') d.memo.airlineName = a.name;
    }
    // 예약된 후속 결과의 memo 도 같은 이유로 맞춘다 — 몇 분기 뒤 그 이름으로 발화한다.
    for (const po of s.pendingOutcomes || []) {
      if (!po.memo || !po.memo.airline || typeof po.memo.airlineName !== 'string') continue;
      const a = AIRLINES.find((x) => x.id === po.memo.airline);
      if (a) po.memo.airlineName = a.name;
    }

    // 단면 개념이 없던 세이브의 프로그램에 단면을 채운다. 비워 두면 라인 전환
    // 검사(from.abreast === undefined)가 통과해, 어떤 단면·세그먼트로든 35% 할인가에
    // 갈아탈 수 있다 — 치구 재활용이라는 전제 자체가 무너진다.
    for (const p of s.programs) {
      if (p.abreast === undefined) p.abreast = root.AirlinerAirframe.DEFAULT_ABREAST[p.segment];
      if (p.wing === undefined) p.wing = 45;
      // 날개를 채웠으면 이착륙 성능도 같이 유도한다. 비워 두면 scoreBid 의
      // 폴백(?? 100)이 옛 기체를 만점으로 쳐서, 짧은 활주로·고온고지 노선에
      // 영구히 무자격 응찰한다 — 그 제약이 있으나 마나가 된다.
      if (typeof p.fieldPerf !== 'number') {
        const legacyMat = LEGACY_MATERIAL_MAP[p.material] || LEGACY_MATERIAL_MAP.aluminum;
        const wmat = WING_MATERIALS[p.wingMat || legacyMat.wingMat] || WING_MATERIALS.aluminum;
        const ratio = p.range / SEGMENTS[p.segment].range.ref;
        p.fieldPerf = root.AirlinerAirframe.wingProfile(p.wing, ratio, wmat.aspectRelief).field;
      }
    }

    // 시험비행 개념이 없던 세이브의 인증 중 기종을 옮긴다. 남은 분기를 기본 편대
    // 기준 시간으로 되돌려, 불러온 판의 취항 시점이 달라지지 않게 한다.
    for (const p of s.programs) {
      if (p.phase !== 'cert') continue;
      if (typeof p.testHoursNeeded === 'number' && typeof p.testHours === 'number') continue;
      const left = Math.max(1, p.certRemaining || 1);
      p.testFleet = p.testFleet || DEFAULT_TEST_FLEET;
      p.testHours = 0;
      p.testHoursNeeded = Math.round(left * DEFAULT_TEST_FLEET * TEST_HOURS_PER_QUARTER);
      // 옛 세이브는 시험기 값을 낸 적이 없다. 회수액도 없어야 회계가 맞는다.
      p.testSpent = p.testSpent || 0;
    }

    // 탑재-항속 개념이 없던 세이브의 기종에 곡선을 채운다. 비워 두면 입찰이
    // 만석 항속만 보고 감톤 능력을 통째로 잃어, 이미 완성된 기체가 갑자기
    // 장거리 공고에서 밀린다.
    for (const p of s.programs) {
      if (p.fuelMargin === undefined) p.fuelMargin = root.AirlinerAirframe.DEFAULT_FUEL_MARGIN;
      if (!p.payloadRange || !(p.payloadRange.full > 0)) {
        p.payloadRange = root.AirlinerAirframe.payloadRange(p.range, p.wing === undefined ? 45 : p.wing, p.fuelMargin);
      }
    }

    // ETOPS 개념이 없던 세이브의 장거리 기종에 자격을 준다. 그러지 않으면 이미
    // 완성된 광동체가 9,000km 이상 노선에서 전부 실격되는데, 소급 취득 수단이 없다.
    // 기준은 요구 항속이 아니라 **닿을 수 있는 노선**이다 — 응찰은 요구의
    // RANGE_TOLERANCE 만 채우면 되므로 8,100km 기체도 9,000km 공고에 들어갈 수
    // 있었다. 9,000 으로 자르면 그 구간(8,100~8,999)이 통째로 영구 실격된다.
    for (const p of s.programs) {
      if (p.etops === undefined) p.etops = p.range >= ETOPS_USEFUL_RANGE;
      // ETOPS 를 "따내는 인증"으로 바꾸기 전 세이브. 이미 양산 중인 기종은 그동안
      // 날아 왔으므로 인증을 가진 것으로 본다 — 그러지 않으면 불러온 판에서
      // 멀쩡히 대양 노선을 뛰던 기체가 갑자기 실격된다.
      if (p.etopsCertified === undefined) p.etopsCertified = !!p.etops && p.phase === 'production';
    }

    // 연구 완료 분기를 남기기 전 세이브. 완료 목록은 있는데 **언제** 끝났는지가
    // 없다. 두 단계로 되찾는다:
    //
    //   1. 로그에 완료 기록이 남아 있으면 그 분기가 정답이다(250줄 안에 있으면).
    //   2. 없으면 **가장 이른 가능 시점**으로 둔다 — 연구는 정해진 분기를 채워야
    //      끝나므로 그보다 이를 수는 없다. 실제로는 더 늦게 끝났을 수 있다.
    if (s.research && s.research.done) {
      if (!s.research.doneTurn || typeof s.research.doneTurn !== 'object') s.research.doneTurn = {};
      for (const [id, doneFlag] of Object.entries(s.research.done)) {
        if (!doneFlag || typeof s.research.doneTurn[id] === 'number') continue;
        const proj = RESEARCH_PROJECTS.find((x) => x.id === id);
        if (!proj) continue;
        const entry = (s.log || []).find((l) => typeof l.text === 'string' && l.text.startsWith(`${proj.name} 연구 완료`));
        s.research.doneTurn[id] = entry && typeof entry.turn === 'number' ? entry.turn : proj.quarters;
      }
    }

    // 착수 시점의 연구 기록이 없던 세이브의 프로그램. 통째로 비워 두면 연구 뒤에
    // 그린 기체가 자기 보정을 잃은 채로 평가돼, 엔진을 갈아 끼울 때 값이 어긋난다
    // (연비 상한에 닿은 설계에서 1점). 위에서 되찾은 완료 분기로 가른다 —
    // 승계 기종(launchTurn 이 음수)이 복합재 연구를 달고 있는 일은 이걸로 막힌다.
    for (const p of s.programs) {
      if (p.research && typeof p.research === 'object') continue;
      const born = typeof p.launchTurn === 'number' ? p.launchTurn : 0;
      const filled = {};
      for (const [id, doneFlag] of Object.entries((s.research && s.research.done) || {})) {
        if (!doneFlag) continue;
        const at = (s.research.doneTurn || {})[id];
        // 같은 분기는 **못 받은 쪽**이다. 착수는 플레이어가 그 분기에 하고, 연구
        // 정산(runResearch)은 그 분기의 endTurn 안에서 뒤늦게 돈다 — 그래서 완료
        // 분기에 착수한 기체는 실제로 연구 없이 평가됐다(launchProgram 의 스냅숏이
        // 그 순서를 그대로 담는다). 마이그레이션도 같은 경계를 써야 한다.
        if (typeof at === 'number' && born <= at) continue;
        filled[id] = true;
      }
      p.research = filled;
    }

    // 엔진을 **언제 달았는지**가 없던 프로그램(승계 기종과 옛 세이브). 착수 분기로
    // 채운다 — 그 시점에는 착수와 장착이 같은 분기다. 국산화로 갈아 끼우면 그때로
    // 옮겨 간다.
    for (const p of s.programs) {
      if (typeof p.engineTurn !== 'number') p.engineTurn = typeof p.launchTurn === 'number' ? p.launchTurn : 0;
    }

    // 엔진 개념이 없던 세이브의 프로그램에 엔진을 채운다. 비워 두면 그 기종의
    // 파생형이 derivedFrom.engine === undefined 로 판정돼, 엔진을 갈아 끼우고도
    // 재장착 비용(58%)이 아니라 순수 동체 연장 할인(34%)을 받는다.
    for (const p of s.programs) {
      if (p.engine && root.AirlinerEngines.get(p.engine)) continue;
      // launchTurn 은 승계 기종이면 음수다(DN-150 = -40 = 1988년). 0으로 클램프하면
      // 1998년 기준 엔진이 잡혀 새 게임의 같은 기체와 달라지고, 2000년 이후에는
      // 단산 여부가 갈려 파생형 비용까지 34% vs 58% 로 어긋난다.
      const born = typeof p.launchTurn === 'number' ? p.launchTurn : 0;
      const eng = root.AirlinerEngines.defaultFor(p.segment, yearOf(born));
      if (!eng) continue;
      p.engine = eng.id;
      p.engineName = eng.name;
      p.engineMaker = eng.maker;
    }
    // 일정표가 없던 세이브는 시드에서 결정적으로 다시 만든다(같은 시드 → 같은 일정).
    // 이미 지난 분기의 슬롯은 버린다 — 충격은 endTurn 이 턴을 올린 뒤 발화하므로
    // 현재 턴 이하 슬롯은 영영 뜨지 않는 죽은 항목이 되고, 그 시점 충격은 옛 규칙
    // 아래서 이미 한 번 지나갔다.
    if (!Array.isArray(s.shocks)) {
      s.shocks = buildShockSchedule(s, createRng(s.seed)).filter((x) => x.turn > s.turn);
    }

    // 가상 경쟁사(strength 스칼라)를 쓰던 세이브는 실존 제조사 명단으로 갈아끼운다.
    // 옛 strength 는 새 카탈로그와 척도가 달라 옮겨올 수 없으므로 보정치는 0에서 시작한다.
    if (!Array.isArray(s.competitors) || s.competitors.some((c) => !c.drift)) {
      s.competitors = newCompetitors(s.playerMakers);
    }
    for (const c of s.competitors) {
      if (!c.reaction) c.reaction = {};
      for (const seg of ['regional', 'narrow', 'wide']) {
        if (typeof c.drift[seg] !== 'number') c.drift[seg] = 0;
        if (typeof c.reaction[seg] !== 'number') c.reaction[seg] = 0;
      }
    }

    // 옛 달력(정산 중 완성)으로 저장된 진행 중 개량 — 새 달력에서 doneTurn 은
    // "적용 시작 분기"다. 이미 지난 doneTurn 을 다음 분기로 당겨 화면("1분기
    // 남음")과 실제 적용 시점이 일치하게 한다. 완성 정산 자체는 같은 분기다.
    for (const p of s.programs || []) {
      for (const u of Object.values(p.upgrades || {})) {
        if (!u.applied && typeof u.doneTurn === 'number' && u.doneTurn <= s.turn) u.doneTurn = s.turn + 1;
      }
    }

    // 드라마가 없던 세이브 — 남은 기간의 드라마를 새로 뽑지 않고 빈 채로 둔다.
    // 중간부터 지연을 얹으면 이미 취항한 기종이 갑자기 미취항으로 되돌아간다.
    if (!Array.isArray(s.rivalDrama)) s.rivalDrama = [];
    if (!s.rivalDelays || typeof s.rivalDelays !== 'object') s.rivalDelays = {};
    if (!s.rivalCrises || typeof s.rivalCrises !== 'object') s.rivalCrises = {};
    if (!s.engineRelations || typeof s.engineRelations !== 'object') s.engineRelations = {};
    if (s.engineDeal === undefined) s.engineDeal = null;
    if (!s.engineEarlyAccess || typeof s.engineEarlyAccess !== 'object') s.engineEarlyAccess = {};
    if (typeof s.tradeTension !== 'number') s.tradeTension = 0;
    if (s.localEngineProject === undefined) s.localEngineProject = null;
    if (!Array.isArray(s.localEngines)) s.localEngines = [];
    if (!Array.isArray(s.playerMakers)) {
      // 단수 문자열이던 시절의 세이브 — 배열로 옮긴다.
      s.playerMakers = typeof s.playerMaker === 'string' && s.playerMaker ? [s.playerMaker] : [];
      delete s.playerMaker;
    }
    if (typeof s.overheadMult !== 'number') s.overheadMult = 1;
    if (typeof s.scoreMult !== 'number') s.scoreMult = 1;
    // 사풍이 없던 세이브 — 고른 제조사에서 되찾는다. 보잉으로 시작한 판이
    // 불러오는 순간 "특색 없는 보잉"이 되면 안 된다. 다만 시작 관계 보정은
    // newGame 한 번뿐인 효과라 소급하지 않는다 (그 판의 관계는 이미 20년치
    // 영업의 결과이지, 출발선이 아니다).
    {
      const makers = s.playerMakers || [];
      const exact = PLAYABLE_COMPANIES.find(
        (c) => c.makers.length === makers.length && c.makers.every((m) => makers.includes(m)),
      );
      // 흡수된 회사도 자기 사풍을 찾아야 한다. 투폴레프로 시작한 세이브는
      // playerMakers 가 ['tupolev'] 인데, 지금 그 자리를 잇는 프리셋은
      // UAC(['tupolev', 'sukhoi'])라 개수가 안 맞는다. 정확히 일치하는 프리셋이
      // 없으면 **그 제조사를 품은** 프리셋으로 넓힌다 — 안 그러면 그 판이
      // 조용히 기준선(무보정)으로 저장돼 영영 러시아 회사의 규칙을 못 받는다.
      // 빈 배열(가상 회사)은 모든 프리셋에 트리비얼하게 포함되므로 제외한다.
      const absorbed =
        exact ||
        (makers.length
          ? PLAYABLE_COMPANIES.find((c) => c.makers.length && makers.every((m) => c.makers.includes(m)))
          : null);
      const preset = (absorbed || companyPreset('deneb')).trait || {};
      if (!s.trait || typeof s.trait !== 'object') {
        s.trait = { ...preset };
      } else {
        // 사풍은 있는데 **새로 생긴 축이 없는** 세이브 — PR 마다 축이 하나씩 늘기
        // 때문에 이 경우가 훨씬 흔하다. 없는 칸만 채운다:
        //   · 이미 있는 칸은 건드리지 않는다 — 진행 중인 판의 규칙이 프리셋을
        //     손볼 때마다 도중에 바뀌면 안 된다(사풍을 상태에 복사해 둔 이유).
        //   · 없는 칸은 채운다 — 안 그러면 옛 UAC 세이브가 UEC 국산화를
        //     20년 내내 못 보게 된다. 새 기능이 옛 판에서 통째로 사라지는 것은
        //     "규칙이 안 바뀐다"가 아니라 그냥 버그다.
        for (const [k, v] of Object.entries(preset)) {
          if (!(k in s.trait)) s.trait[k] = v;
        }
      }
    }
    if (!Array.isArray(s.milestones)) s.milestones = [];
    return s;
  }

  /**
   * 충격 일정표를 시드마다 한 번 만든다.
   *
   * 역사적 사건은 각각 HISTORICAL_ODDS(60%) 확률로만 실현된다. 불발된 자리는
   * 가상 충격이 **무작위 시점에** 대신 들어간다. 전부 고정이면 두 번째 판부터
   * 정답 암기가 되고, 전부 무작위면 학습이 무의미해진다. 섞으면 "2001년은
   * 위험할 수 있다"는 지식은 살아 있되 그것만 믿을 수는 없게 된다.
   *
   * 충격 총 개수는 유지해 밸런스 봉투를 흔들지 않는다.
   */
  function buildShockSchedule(s, rng) {
    const schedule = [];
    const pool = FICTIONAL_SHOCKS.slice();

    // 1단계: 어떤 역사적 사건이 실현되는지 먼저 전부 정한다.
    // (섞어서 처리하면 앞서 배치한 가상 충격이 뒤에 확정될 역사 시점과 겹친다.)
    const misses = [];
    const used = new Set();
    for (const h of HISTORICAL) {
      if (rng.chance(HISTORICAL_ODDS)) {
        schedule.push({ turn: h.turn, kind: 'historical', id: h.id || 'hist-' + h.turn });
        used.add(h.turn);
      } else {
        misses.push(h);
      }
    }

    // 2단계: 불발된 수만큼 가상 충격을 빈 분기에 배치한다.
    for (let i = 0; i < misses.length && pool.length; i++) {
      const pick = pool.splice(rng.int(0, pool.length - 1), 1)[0];
      let turn = rng.int(6, CONFIG.totalTurns - 5);
      for (let tries = 0; tries < 40 && used.has(turn); tries++) {
        turn = rng.int(6, CONFIG.totalTurns - 5);
      }
      if (used.has(turn)) continue; // 자리를 못 찾으면 이번 판에서는 건너뛴다
      used.add(turn);
      schedule.push({ turn, kind: 'fictional', id: pick.id });
    }

    schedule.sort((a, b) => a.turn - b.turn);
    return schedule;
  }

  /**
   * 경쟁사 드라마 일정표 — 발표·지연·초기 결함 파동.
   *
   * 카탈로그의 취항은 조용히 일어나는 기정사실이었다. 실제 업계에서 신기종은
   * 발표 → 지연 → 취항 → (때로) 결함 파동의 **서사**로 온다: 787 이 3년 밀리고
   * 배터리로 다시 섰다. 그 서사가 곧 플레이어의 기회다 — 경쟁기가 밀린 몇 분기가
   * 우리 기종의 창이고, 파동 중에는 그 기종과 붙는 수주전이 쉬워진다.
   *
   * 다만 한 방향이면 안 된다. 지연·위기만 넣고 재 보니 판 전체가 통째로 쉬워졌다
   * (기준 하네스 파산 12/40 → 4/40) — 세계가 살아나는 게 아니라 상대가 약해진
   * 것뿐이다. 그래서 **호평**이 있다: 일부 신기종은 취항하자마자 주문이 몰려
   * 한동안 더 세다(A320neo 가 그랬다). 드라마는 시장의 결이지 난이도 조절이 아니다.
   */
  const DRAMA_ANNOUNCE_LEAD = 8;
  const DRAMA_DELAY_ODDS = 0.18;
  const DRAMA_CRISIS_ODDS = 0.18;
  const DRAMA_ACCLAIM_ODDS = 0.25;

  function buildRivalDrama(seed, playerMakers) {
    // 본류 난수열과 분리한다 — 드라마 규칙을 손볼 때 같은 시드의 나머지 전개가
    // 통째로 재편되면, 밸런스 변화와 시드 재편을 구분할 수 없게 된다.
    const rng = createRng(((seed >>> 0) + 0x5eed0) >>> 0);
    const events = [];
    const delays = {};
    for (const t of AIRCRAFT) {
      // 플레이어가 그 제조사면 자기 미래 기종의 드라마는 없다 — 그 미래는 이제 플레이어의 몫이다.
      if ((playerMakers || []).includes(t.maker)) continue;
      const eisTurn = Math.round((t.eis - CONFIG.startYear) * 4);
      // 시작 시점에 이미 취항(임박)했거나 게임 밖이면 드라마 없이 지나간다.
      if (eisTurn <= 2 || eisTurn >= CONFIG.totalTurns) continue;
      if (eisTurn - DRAMA_ANNOUNCE_LEAD > 0) {
        events.push({ turn: eisTurn - DRAMA_ANNOUNCE_LEAD, kind: 'announce', typeId: t.id });
      }
      if (rng.chance(DRAMA_DELAY_ODDS)) {
        const q = rng.int(2, 3);
        delays[t.id] = q;
        // 지연 소식은 원래 취항 예정 분기에 뜬다 — "온다던 게 안 왔다"가 뉴스다.
        events.push({ turn: eisTurn, kind: 'delay', typeId: t.id, quarters: q });
      }
      const effEis = eisTurn + (delays[t.id] || 0);
      if (rng.chance(DRAMA_CRISIS_ODDS)) {
        if (effEis + 2 < CONFIG.totalTurns) {
          events.push({
            turn: effEis + rng.int(2, 5),
            kind: 'crisis',
            typeId: t.id,
            quarters: rng.int(4, 6),
            amount: rng.int(4, 5),
          });
        }
      } else if (rng.chance(DRAMA_ACCLAIM_ODDS)) {
        // 반대의 결 — 취항하자마자 호평과 주문이 몰리는 기종. 그 기간에 이
        // 기종과 붙는 수주전은 어렵다. 위기와 같은 통로에 음수로 얹는다.
        if (effEis + 1 < CONFIG.totalTurns) {
          events.push({
            turn: effEis + rng.int(1, 3),
            kind: 'acclaim',
            typeId: t.id,
            quarters: rng.int(4, 7),
            amount: -rng.int(4, 6),
          });
        }
      }
    }
    events.sort((a, b) => a.turn - b.turn);
    return { events, delays };
  }

  /** 초기 결함 파동 중인 기종의 경쟁력 감점. 입찰·인도 배분·반격 판정이 같이 쓴다. */
  function crisisDip(s, typeId) {
    const c = s.rivalCrises && s.rivalCrises[typeId];
    return c ? c.amount : 0;
  }

  /** 인도된 기체를 항공사 선단에 올린다 — 이후 그 항공사 입찰에서 공통성 가산이 붙는다. */
  /**
   * 자체 항공사 발주 — 통합 모드에서만 쓴다.
   *
   * 계열 항공사는 공고를 내지 않는다. 입찰을 거치지 않고 장부에 바로 올라가되,
   * **줄은 똑같이 선다** — 생산 대기열에서 남의 주문을 제치지 않는다. 그래서 자체
   * 항공사의 값은 "확정된 런치 커스터머"이지 "공짜 기체"가 아니다.
   *
   * 값은 정가 그대로다. 계열 간 거래라 깎아 봐야 한 주머니에서 다른 주머니로 옮길
   * 뿐이고(합산 성적으로 재므로), 정가로 두어야 제조사 장부가 남의 주문과 같은 자로
   * 읽힌다. 대금 일정도 같다 — 지금 착수금, 인도 때 잔금.
   */
  /**
   * 자체 발주 견적. 상태를 건드리지 않는다.
   *
   * 값을 매기는 자리가 여기 하나여야 한다 — 부르는 쪽이 착수금 비율을 따로 알고
   * 있으면, 엔진의 상수를 바꾼 날 화면의 견적과 실제 청구액이 갈린다.
   */
  /**
   * 자체 발주 단가 — **원가다. 정가가 아니다.**
   *
   * 처음에는 정가로 넘겼다. "깎아도 한 주머니에서 다른 주머니로 옮길 뿐"이라고 생각했는데
   * 틀렸다. 정가로 넘기면 제조사가 마진을 이익으로 잡고 항공사는 그 값을 자산으로
   * 자본화한다 — 그룹 밖에서는 아무 일도 없었는데 대당 32.6M 이 생긴다. 자회사에
   * 계속 대주는 것만으로 그룹 자기자본이 불어났다.
   *
   * 원가로 넘기면 만들 자리도 없다. 연결 회계가 내부거래 이익을 지우는 것과 같은 뜻이고,
   * 규칙도 단순해진다 — **자회사에 대주는 값은 만드는 값이지 파는 값이 아니다.**
   */
  const inHouseUnitPrice = (p) => p.unitCostBase;

  function inHouseQuote(s, opts) {
    const o = opts || {};
    const qty = o.qty;
    const p = s.programs.find((x) => x.id === o.programId);
    if (!p) return null;
    const n = Number.isInteger(qty) && qty > 0 ? qty : 1;
    const total = n * inHouseUnitPrice(p);
    const deposit = Math.round(total * CONFIG.depositRate);
    return {
      programId: p.id,
      name: p.name,
      qty: n,
      unitPrice: inHouseUnitPrice(p),
      total,
      deposit,
      balance: total - deposit,
      depositRate: CONFIG.depositRate,
      orderable: p.phase === 'production',
    };
  }

  /**
   * 계열 항공사의 공고를 걷어낸다 — 통합 모드에서만 쓴다.
   *
   * 자회사는 공고를 내지 않는다는 것이 그 모드의 규칙인데, `generateRfps` 는
   * `AIRLINES` 를 전부 돌기 때문에 그냥 두면 자회사가 계속 공고를 내고 그 물량이
   * 플레이어나 경쟁사에게 낙찰된다 — 자체 발주 통로와 이중으로 사는 셈이고, 낙찰·유찰
   * 관계 변동까지 따라붙는다.
   */
  function dropAirlineRfps(s, airlineId) {
    if (!airlineId || !Array.isArray(s.rfps)) return 0;
    const gone = s.rfps.filter((r) => r.airlineId === airlineId);
    if (!gone.length) return 0;
    s.rfps = s.rfps.filter((r) => r.airlineId !== airlineId);
    // 걷어낸 공고에 걸린 입찰도 함께 지운다. 남겨 두면 없는 공고를 물고 있는
    // 입찰이 다음 정산에서 판정된다.
    if (s.bids) for (const r of gone) delete s.bids[r.id];
    return gone.length;
  }

  /**
   * 계열 항공사의 자체 발주를 장부에서 지운다 — 그 항공사가 문을 닫았을 때.
   *
   * 남겨 두면 몇 분기 뒤 제조사가 그 기체를 인도하면서 잔금을 매출로 잡는데, 받을
   * 상대가 없다 — 아무도 치르지 않은 돈이 제조사 장부에서 생긴다. 착수금은 돌려주지
   * 않는다(계약을 깬 쪽이 계열 항공사다).
   */
  function cancelInHouseOrders(s, airlineId) {
    if (!airlineId || !Array.isArray(s.backlog)) return 0;
    const gone = s.backlog.filter((o) => o.inHouse && o.airlineId === airlineId && o.remaining > 0);
    if (!gone.length) return 0;
    const qty = gone.reduce((x, o) => x + o.remaining, 0);
    s.backlog = s.backlog.filter((o) => !(o.inHouse && o.airlineId === airlineId));
    pushLog(s, 'bad', `계열 항공사가 문을 닫아 자체 발주 ${qty}기가 취소됐다.`);
    return qty;
  }

  function placeInHouseOrder(s, opts) {
    const o = opts || {};
    const qty = o.qty;
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, error: '대수는 1 이상의 정수여야 합니다.' };
    const p = s.programs.find((x) => x.id === o.programId);
    if (!p) return { ok: false, error: '없는 프로그램입니다.' };
    if (p.phase !== 'production') return { ok: false, error: `${p.name}은(는) 아직 양산 기종이 아닙니다.` };
    const airline = AIRLINES.find((a) => a.id === o.airlineId);
    if (!airline) return { ok: false, error: '없는 항공사입니다.' };

    const unitPrice = inHouseUnitPrice(p);
    const deposit = Math.round(qty * unitPrice * CONFIG.depositRate);
    s.cash += deposit;
    s.pending.revenue += deposit;
    s.stats.ordersWon += qty;
    s.pending.ordersWon = (s.pending.ordersWon || 0) + qty;
    s.backlog.push({
      id: 'ord-' + s.nextId++,
      airlineId: airline.id,
      airlineName: airline.name,
      programId: p.id,
      programName: p.name,
      qty,
      remaining: qty,
      unitPrice,
      wonTurn: s.turn,
      reqEtops: false,
      gov: false,
      // 인도될 때 항공사 계층에 실제 기체로 넘겨야 한다는 표식.
      inHouse: true,
    });
    pushLog(s, 'good', `자체 항공사 ${airline.name}이(가) ${p.name} ${qty}기를 발주했다.`);
    return { ok: true, qty, unitPrice, deposit, total: qty * unitPrice };
  }

  function addToFleet(s, airlineId, programId, n) {
    if (!s.fleets[airlineId]) s.fleets[airlineId] = {};
    s.fleets[airlineId][programId] = (s.fleets[airlineId][programId] || 0) + n;
  }

  function rngFor(s) {
    const rng = createRng(s.rngState);
    return rng;
  }
  function saveRng(s, rng) {
    s.rngState = rng.getState();
  }

  function pushLog(s, kind, text) {
    s.log.unshift({ turn: s.turn, label: turnLabel(s.turn), kind, text });
    if (s.log.length > 250) s.log.length = 250;
  }

  // ─────────────────────────────── 플레이어 행동 ───────────────────────────────

  /** 세그먼트별 완성 경험치 — 큰 기체일수록 조직이 배우는 게 많다. */
  const EXPERIENCE_POINTS = { regional: 1, narrow: 2, wide: 3 };

  /**
   * 조직 경험 — 형식증명까지 가 본 프로그램의 합.
   *
   * 저장하지 않고 매번 계산한다(certTurn 에서 유도되므로 옛 세이브도 그대로 된다).
   * 승계 기종은 뺀다 — 그 경험은 이미 기준 밸런스에 들어 있고, 포함하면 모든 판이
   * 2점을 들고 시작해 기준 일정이 통째로 움직인다. 매각한 프로그램은 남는다:
   * 도면은 넘겨도 그걸 만들어 본 사람들은 회사에 있다.
   * 파생형은 절반 — 새로 배우는 것이 훨씬 적다.
   */
  function companyExperience(s) {
    let xp = 0;
    for (const p of s.programs) {
      // 인수한 프로그램은 남이 개발해 본 경험이다 — 형식증명을 샀다고 조직이 배우진 않는다.
      if (p.legacy || p.acquired || p.certTurn === null || p.certTurn === undefined) continue;
      const pts = EXPERIENCE_POINTS[p.segment] || 1;
      xp += p.derivedFrom ? pts * 0.5 : pts;
    }
    return xp;
  }

  /** 신규 프로그램 착수. 착수금(개발비의 8%)을 즉시 지출한다. */
  function launchProgram(s, spec, name) {
    const evalSpec = evaluate({ ...spec, ...designContext(s) });
    const upfront = Math.round(evalSpec.devCost * CONFIG.launchUpfrontRate);
    if (s.cash < upfront) {
      return { ok: false, error: `착수금 ${fmtMoney(upfront)}이 부족합니다.` };
    }
    if (s.programs.filter((p) => p.phase === 'dev' || p.phase === 'cert').length >= 3) {
      return { ok: false, error: '동시에 개발 가능한 프로그램은 3개까지입니다.' };
    }

    // 프로그램 이름은 결정 사건 본문처럼 서식을 허용하는 자리에도 그대로 끼어든다.
    // 꺾쇠를 아예 저장하지 않아, 세이브에 태그가 남을 여지를 없앤다.
    const cleanName = String(name || '')
      .replace(/[<>]/g, '')
      .trim()
      .slice(0, 40);
    const program = {
      id: 'prog-' + s.nextId++,
      name: cleanName || `${SEGMENTS[evalSpec.segment].name}-${s.programs.length + 1}`,
      ...evalSpec,
      phase: 'dev',
      progress: 0,
      spent: upfront,
      certRemaining: evalSpec.certQuarters,
      qualityInvests: 0,
      share: CONFIG.defaultProgramShare,
      produced: 0,
      delivered: 0,
      stock: 0,
      launchTurn: s.turn,
      // 지금 엔진을 단 분기. 착수 시점에는 착수 분기와 같지만, 국산화로 갈아
      // 끼우면 그때로 옮겨 간다 — 옛 엔진을 평가할 연도가 이 값이다.
      engineTurn: s.turn,
      certTurn: null,
      // 호환성 판정을 통과했을 때만 원형 연결을 남긴다. 원형에서 소재·기술·항속을
      // 갈아엎어 신규 설계 비용을 전액 낸 설계에 파생형 딱지가 붙으면 안 된다.
      derivedFrom: evalSpec.derivative ? spec.derivedFrom : null,
      // 이 설계가 어떤 연구 위에서 그려졌는지 — 엔진을 갈아 끼울 때 이 시점을
      // 그대로 되짚어야 연구 보정이 두 평가에서 상쇄된다(연비 상한에 닿은 설계는
      // 안 그러면 1점이 어긋난다).
      research: { ...((s.research && s.research.done) || {}) },
    };
    // 패밀리 계보 — 조종석·정비 공통성이 이 단위로 쌓인다. 패밀리로 착수하면
    // 자기 자신이 뿌리가 되고, 그 패밀리의 파생형은 뿌리를 물려받는다.
    const parent = evalSpec.derivative && spec.derivedFrom ? s.programs.find((x) => x.id === spec.derivedFrom.id) : null;
    program.familyId = parent && parent.familyId ? parent.familyId : evalSpec.family ? program.id : null;

    s.cash -= upfront;
    // 착수금도 연구개발비다 — 리포트에 넣지 않으면 현금은 줄었는데
    // 재무표의 비용·손익으로는 설명되지 않고, 총 R&D도 8% 적게 보고된다.
    ensureShape(s);
    s.pending.rdCost += upfront;
    s.programs.push(program);
    pushLog(
      s,
      'program',
      `${program.name} 개발 착수. 총 개발비 ${fmtMoney(program.devCost)}, 예상 ${program.devQuarters}분기, 필요 인력 ${program.engineersNeeded.toLocaleString('ko-KR')}명.`,
    );
    return { ok: true, program };
  }

  /**
   * 프로그램이 들고 있는 **설계 스펙** — 기체를 다시 평가해야 할 때 읽는 한 곳.
   *
   * 프로그램에서 스펙을 손으로 되짚는 자리가 둘(파생형 착수 시드·엔진 교체의 쌍
   * 평가)인데, 따로 적어 두니 한쪽에만 칸이 빠지는 일이 반복됐다. 옛 세이브의
   * `material`(단면·날개 소재로 쪼개기 전의 한 칸)이 그 예다 — 빠뜨리면 복합재
   * 기체가 알루미늄으로 평가돼 비율이 어긋난다. 새 설계 축은 여기 한 번만 넣는다.
   *
   * `material` 은 `fuselage`/`wingMat` 이 있으면 평가기가 무시한다(옛 칸이 새 칸을
   * 덮지 않는다). 옛 세이브에만 값을 한다.
   */
  function programSpec(p) {
    return {
      segment: p.segment,
      seats: p.seats,
      range: p.range,
      tech: p.tech,
      material: p.material,
      fuselage: p.fuselage,
      wingMat: p.wingMat,
      engine: p.engine,
      abreast: p.abreast,
      wing: p.wing,
      fuelMargin: p.fuelMargin,
      etops: !!p.etops,
      growth: !!p.growth,
      maintainable: !!p.maintainable,
      engines: p.engines || 2,
      dualSource: !!p.dualSource,
      // **착수 시점의** 장기 연구다. 완료된 연구는 그 뒤 설계에만 값을 하고 이미
      // 나온 기체를 소급해 고치지 않으므로, 지금 연구 목록으로 되짚으면 기체가
      // 갖지도 않은 보정을 얹게 된다. 옛 세이브는 ensureShape 가 채워 준다.
      research: p.research || {},
      // 조직 경험도 같은 성질이다 — 착수 시점의 값이 결함 위험 배수로 들어가
      // 있다. 배수라 대개 상쇄되지만 위험 상한(defectRiskMax)에 닿으면 깨진다.
      experience: p.experience || 0,
    };
  }

  /** 파생형 착수용 설계 시드 — 원형의 기술/소재를 물려받는다. */
  function derivativeSpec(base, seatDelta) {
    const seg = SEGMENTS[base.segment];
    // 연구와 경험만은 물려받지 않는다. 파생형도 **지금 그리는 설계**라 착수 시점의
    // 값은 오늘 것을 쓴다(파생형은 애초에 경험 할인을 받지 않는다).
    const { research, experience, ...inherited } = programSpec(base);
    return {
      // 구조 설계의 일부라 파생형이 물려받는다 — 성장 여유·정비성·엔진 수·이중화도 함께.
      ...inherited,
      seats: clamp(base.seats + seatDelta, seg.seats.min, seg.seats.max),
      // 호환성 판정에 쓰이도록 원형 스펙을 함께 싣는다.
      derivedFrom: {
        id: base.id,
        name: base.name,
        tech: base.tech,
        material: base.material,
        fuselage: base.fuselage,
        wingMat: base.wingMat,
        range: base.range,
        engine: base.engine,
        abreast: base.abreast,
        wing: base.wing,
        // 착수 옵션(base.family)이 아니라 패밀리 소속으로 판정한다. 파생형은
        // familyId 를 물려받지만 family 플래그는 물려받지 않아서, 2대째 파생형이
        // 같은 패밀리인데도 일반 요율을 물게 된다.
        family: !!base.familyId,
        growth: !!base.growth,
        maintainable: !!base.maintainable,
        engines: base.engines || 2,
        dualSource: !!base.dualSource,
      },
    };
  }

  /** 품질 강화 투자 — 결함 위험을 25% 상대 감소. 프로그램당 3회까지. */
  function investQuality(s, programId) {
    const p = s.programs.find((x) => x.id === programId);
    if (!p) return { ok: false, error: '프로그램을 찾을 수 없습니다.' };
    if (p.qualityInvests >= 3) return { ok: false, error: '품질 투자는 3회까지입니다.' };
    // 개발비의 3.5%. 예전 6%는 현금이 가장 마른 개발 구간에 부담이 몰리는 반면
    // 효과는 양산 이후에나 나타나, 투자할수록 손해인 함정 선택지였다.
    const cost = Math.round(p.devCost * CONFIG.qualityInvestRate);
    if (s.cash < cost) return { ok: false, error: `${fmtMoney(cost)}이 부족합니다.` };
    ensureShape(s);
    s.cash -= cost;
    s.pending.rdCost += cost;
    p.spent += cost; // 매몰비용 표시가 실제 지출과 어긋나지 않게
    p.qualityInvests++;
    p.defectRisk = Math.round(p.defectRisk * CONFIG.qualityRiskMult * 1000) / 1000;
    pushLog(s, 'program', `${p.name} 추가 시험·검증에 ${fmtMoney(cost)} 투입. 결함 위험 ${(p.defectRisk * 100).toFixed(1)}%로 하락.`);
    return { ok: true };
  }

  /**
   * 풍동·목업 투자 — 결함 위험의 **불확실성**을 산다.
   *
   * 설계 화면의 결함 위험은 종이 위의 추정치다. 실기 시험(설계 동결)에서
   * 실측치가 확정되는데, 그 주사위의 폭이 풍동을 산 팀은 훨씬 좁다(±30% → ±8%).
   * investQuality(위험 수준 자체를 낮춤)와 다른 축이다 — 이건 모르는 것을
   * 아는 것으로 바꾸는 돈이고, 그래서 개발 초반(50% 전)에만 의미가 있다.
   */
  const WIND_TUNNEL_COST_RATE = 0.02;
  const RISK_UNCERTAINTY_BASE = 0.3;
  const RISK_UNCERTAINTY_TUNNEL = 0.08;

  function investWindTunnel(s, programId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    const p = s.programs.find((x) => x.id === programId);
    if (!p) return { ok: false, error: '없는 프로그램입니다.' };
    if (p.phase !== 'dev') return { ok: false, error: '개발 중에만 풍동 시험을 늘릴 수 있습니다.' };
    if (p.progress >= 50) return { ok: false, error: '설계가 절반을 넘었다 — 이제 와서 풍동을 돌려도 도면이 안 바뀝니다.' };
    if (p.windTunnel) return { ok: false, error: '이미 확장 풍동·목업 프로그램을 돌리고 있습니다.' };
    const cost = Math.round(p.devCost * WIND_TUNNEL_COST_RATE);
    if (s.cash < cost) return { ok: false, error: `풍동·목업 비용 ${fmtMoney(cost)}이 부족합니다.` };
    ensureShape(s);
    s.cash -= cost;
    s.pending.rdCost += cost;
    p.spent += cost;
    p.windTunnel = true;
    // 미리 찾은 문제는 미리 고친다 — 위험 자체도 조금 내려간다.
    p.defectRisk = Math.round(p.defectRisk * 0.92 * 1000) / 1000;
    pushLog(s, 'program', `${p.name} 확장 풍동·목업 시험에 ${fmtMoney(cost)} 투입. 결함 위험 추정이 ±${Math.round(RISK_UNCERTAINTY_TUNNEL * 100)}% 폭으로 좁혀졌다.`);
    return { ok: true, cost };
  }

  /**
   * 정부 런치 에이드 — 개발 위험을 국가와 나눈다.
   *
   * 지금 개발비의 25%를 현금으로 받고, 성공하면 인도마다 계약가의 5%씩
   * 총 1.4배까지 갚는다. 개발을 접으면 갚지 않는다 — 그게 이 돈의 조건이고,
   * A380·A350 의 launch aid 가 정확히 이 구조였다. 공짜가 아닌 이유는 따로 있다:
   * 지원을 받을 때마다 무역 긴장이 쌓이고, 문턱을 넘으면 WTO 판정(관세)이 온다.
   */
  const LAUNCH_AID_RATE = 0.25;
  const LAUNCH_AID_ROYALTY = 0.05;
  const LAUNCH_AID_PAYBACK = 1.4;
  const LAUNCH_AID_TENSION = 3;
  /** 관세 판정이 살아 있는 동안 상대 앞마당(북미·서유럽) 인도에 붙는 세율. */
  const TRADE_TARIFF_RATE = 0.04;
  /** 독점 공급 계약 — 계약 공급사 엔진 인도분의 부품 리베이트와 계약 기간. */
  const ENGINE_DEAL_REBATE = 0.02;
  const ENGINE_DEAL_QUARTERS = 16;

  function investLaunchAid(s, programId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    const p = s.programs.find((x) => x.id === programId);
    if (!p) return { ok: false, error: '없는 프로그램입니다.' };
    if (p.phase !== 'dev') return { ok: false, error: '개발 중인 프로그램만 지원 대상입니다.' };
    if (p.progress >= 50) return { ok: false, error: '개발이 절반을 넘었다 — 정부는 위험을 나누는 돈만 낸다.' };
    if (p.launchAid) return { ok: false, error: '이미 지원을 받은 프로그램입니다.' };
    ensureShape(s);
    // 사풍 — 국가가 개발 위험을 얼마나 지고, 그 대가로 무역 긴장이 얼마나 쌓이는가.
    // 에어버스의 컨소시엄은 후하지만 표적이 되고, 미국은 개발비 대신 방산으로 준다.
    const aidT = companyTrait(s).aid || {};
    const aid = Math.round(p.devCost * launchAidRate(s));
    s.cash += aid;
    p.launchAid = { amount: aid, repaid: 0 };
    const tension = LAUNCH_AID_TENSION * (aidT.tensionMult ?? 1);
    s.tradeTension += tension;
    pushLog(
      s,
      'program',
      `${p.name}에 정부 지원금 ${fmtMoney(aid)}. 인도마다 계약가의 ${Math.round(LAUNCH_AID_ROYALTY * 100)}%씩, 총 ${LAUNCH_AID_PAYBACK}배까지 갚는다 — 개발을 접으면 갚지 않는다.${
        tension > 0 ? ' 대신 무역 긴장이 올랐다.' : ' WTO 밖의 돈이라 무역 긴장은 쌓이지 않는다.'
      }`,
    );
    return { ok: true, aid };
  }

  /** 이 회사가 실제로 받는 런치 에이드 지원율. 화면도 이 값을 써야 버튼과 결과가 맞는다. */
  function launchAidRate(s) {
    const aid = companyTrait(s).aid || {};
    return LAUNCH_AID_RATE * (aid.rateMult ?? 1);
  }

  /** 설계 평가에 실어 보낼 공급사 계약 맥락 — 조기 접근 엔진과 독점 공급사. */
  function engineDealContext(s) {
    return {
      earlyEngines: Object.keys(s.engineEarlyAccess || {}),
      exclusiveMaker: s.engineDeal && s.turn < s.engineDeal.until ? s.engineDeal.maker : null,
    };
  }

  /**
   * 설계 평가에 실어 보낼 회사 맥락 전부 — 지금 시점·조직 경험·공급사 계약·장기 연구·사풍.
   *
   * 미리보기(panels)와 실제 착수(launchProgram)가 **같은 맥락**으로 평가해야
   * 화면의 개발비와 청구서가 어긋나지 않는다. 호출부마다 손으로 조합하던 것을
   * 한곳에 모아 두는 이유다 — 축이 하나 늘 때마다 세 군데를 고쳐야 했다.
   */
  function designContext(s) {
    const t = companyTrait(s);
    return {
      year: yearOf(s.turn),
      experience: companyExperience(s),
      ...engineDealContext(s),
      ...researchContext(s),
      // 해금한 국산 엔진 — 설계 화면과 착수가 같은 목록을 봐야 한다.
      domesticEngines: s.localEngines || [],
      houseFocus: t.focus || null,
      houseDeriv: t.deriv || null,
    };
  }

  /** 개발 취소 — 투입 비용은 돌아오지 않는다. */
  function cancelProgram(s, programId) {
    // voidOrdersFor 가 pending·relations 를 만진다 — 옛 세이브를 불러온 직후라면
    // 그 칸들이 없어 절반만 적용된 채 예외가 날 수 있다.
    ensureShape(s);
    const p = s.programs.find((x) => x.id === programId);
    if (!p || p.phase === 'production' || p.phase === 'cancelled') {
      return { ok: false, error: '취소할 수 없는 프로그램입니다.' };
    }
    p.phase = 'cancelled';
    adjustReputation(s, -4);
    pushLog(s, 'bad', `${p.name} 개발 중단. 매몰비용 ${fmtMoney(p.spent)}, 업계 신뢰가 흔들린다.`);
    // 시나리오의 기둥(붉은 별의 SSJ)을 접었다면 그 자리에서 알린다 — 분기 정산까지 미루지 않는다.
    tickScenario(s);
    voidOrdersFor(s, p, '개발 중단');
    return { ok: true };
  }

  /**
   * 죽은 프로그램의 미인도 주문을 정리한다 — 선수금을 위약 배수로 물어 준다.
   *
   * 선주문이 생기면서 필요해졌다: 종이 비행기를 팔아 선수금을 챙기고 개발을
   * 접으면, 이 정리가 없을 때 그 돈이 통째로 공짜가 된다. 실제 계약도 제조사
   * 귀책 취소에는 선수금 반환 + 위약이 붙는다.
   */
  const ORDER_VOID_REFUND_MULT = 1.5;

  /**
   * 깨진 계약의 관계 벌점 — 그 수주가 벌어 준 관계(응찰 +2 · 수주 +10)를 지우고도
   * 흉이 남아야 한다. 수주 이득보다 작으면 "수주 → 파기" 반복이 위약금을 내면서
   * 관계를 사는 농사가 된다: 관계는 입찰 점수로 돌아오는 자산이라, 돈으로 사게
   * 두면 안 된다.
   */
  const ORDER_BREACH_RELATION_PENALTY = 14;

  /**
   * 미인도 주문을 파기할 때 나갈 돈. UI 확인창이 이 값을 미리 보여 준다 —
   * 위약이 수십억일 수 있는데 확인창이 매몰비용만 말하면 동의가 아니라 함정이다.
   */
  function voidRefundFor(s, p) {
    let refund = 0;
    for (const o of s.backlog || []) {
      if (o.programId !== p.id || o.remaining <= 0) continue;
      refund += o.remaining * o.unitPrice * (o.depositRate ?? CONFIG.depositRate) * ORDER_VOID_REFUND_MULT;
    }
    return Math.round(refund);
  }

  function voidOrdersFor(s, p, why) {
    voidOrderList(s, p, s.backlog.filter((o) => o.programId === p.id && o.remaining > 0), why);
  }

  /**
   * 주어진 주문들만 골라 파기한다. 프로그램 전체가 아니라 일부 주문만 죽는
   * 경우(종료 시점의 ETOPS 미인증 주문 — 같은 기종의 일반 주문은 멀쩡하다)가
   * 있어 프로그램 단위 파기와 분리했다.
   */
  function voidOrderList(s, p, dead, why) {
    if (!dead.length) return;
    let refund = 0;
    for (const o of dead) {
      refund += o.remaining * o.unitPrice * (o.depositRate ?? CONFIG.depositRate) * ORDER_VOID_REFUND_MULT;
      s.relations[o.airlineId] = clamp((s.relations[o.airlineId] ?? 40) - ORDER_BREACH_RELATION_PENALTY, 0, 100);
    }
    refund = Math.round(refund);
    s.cash -= refund;
    s.pending.overhead += refund;
    const ids = new Set(dead.map((o) => o.id));
    s.backlog = s.backlog.filter((o) => !ids.has(o.id));
    adjustReputation(s, -Math.min(6, dead.length * 2));
    pushLog(s, 'bad', `${why}으로 ${p.name} 주문 ${dead.length}건이 파기됐다. 선수금 반환과 위약금으로 ${fmtMoney(refund)}이 나갔다.`);
  }

  /**
   * 선주문 이탈 — 개발이 **멈춘 지** 이만큼 지나면 항공사가 계약을 깬다.
   *
   * 이게 없으면 개발을 40%에서 동결한 채 표준 조건(위약금 없음)으로 선수금만
   * 무한히 걷는 종이 비행기 농사가 성립한다. 고객 이탈은 실제로도 그랬다 —
   * 787 지연에 항공사들이 주문을 물렀다. 위약 배수가 걸리므로 농사는 손해다.
   *
   * 기준은 경과 시간이 아니라 **정체**다. "수주 후 n분기"로 자르면 인력이 얇아
   * 느리게 가는 성실한 개발이 같이 걸린다(40% 시점 선주문 → 취항까지 ~15분기가
   * 정상 범위다). 진행 중인 프로그램은 lastProgressTurn 이 매 분기 갱신되므로
   * 여기 걸리는 건 실제로 손을 놓은 프로그램뿐이다.
   */
  const PREORDER_STALL_QUARTERS = 6;

  function expirePreorders(s, report) {
    const expired = new Set();
    for (const o of s.backlog) {
      if (o.remaining <= 0) continue;
      const p = s.programs.find((x) => x.id === o.programId);
      if (!p || p.phase === 'production') continue;
      // 시계는 주문마다 따로 간다 — 수주 시점과 마지막 진척 중 **늦은 쪽**부터.
      // 프로그램의 정체 시점만 보면 이미 6분기 멈춘 기종의 새 수주가 같은 분기에
      // 즉시 무른다: 선수금을 받자마자 1.5배로 물어 주는 함정이 된다. 항공사의
      // 인내심은 자기가 계약한 날부터 세는 게 맞다.
      const won = typeof o.wonTurn === 'number' ? o.wonTurn : -Infinity;
      const moved = typeof p.lastProgressTurn === 'number' ? p.lastProgressTurn : -Infinity;
      const lastMoved = Math.max(won, moved);
      if (!Number.isFinite(lastMoved) || s.turn - lastMoved < PREORDER_STALL_QUARTERS) continue;
      const refund = Math.round(o.remaining * o.unitPrice * (o.depositRate ?? CONFIG.depositRate) * ORDER_VOID_REFUND_MULT);
      s.cash -= refund;
      // 이 분기 리포트에 직접 적는다(chargeLatePenalties 와 같은 이유). endTurn 은
      // 리포트를 만들며 pending 을 이미 비웠으므로, pending 에 넣으면 현금은 지금
      // 나가고 비용은 다음 분기 장부에 적힌다 — 이 위약으로 파산하면 아예 증발한다.
      report.overhead += refund;
      s.relations[o.airlineId] = clamp((s.relations[o.airlineId] ?? 40) - ORDER_BREACH_RELATION_PENALTY, 0, 100);
      adjustReputation(s, -2);
      o.remaining = 0;
      expired.add(o.id);
      pushLog(
        s,
        'bad',
        `${o.airlineName}이 ${p.name} 선주문 ${o.qty}기를 물렀다 — 개발이 ${PREORDER_STALL_QUARTERS}분기째 멈춰 있다. 선수금 반환과 위약금으로 ${fmtMoney(refund)}이 나갔다.`,
      );
    }
    // 물러난 주문만 지운다. remaining 0 전체를 지우면 인도 완료 주문의 역사까지
    // 사라져, 최근 수주를 백로그에서 읽는 경쟁사 반격이 눈을 잃는다.
    if (expired.size) s.backlog = s.backlog.filter((o) => !expired.has(o.id));
  }

  /** 조립 라인 신설 — 인증 완료 기종만 가능. */
  function buildLine(s, programId, gradeId) {
    const p = s.programs.find((x) => x.id === programId);
    if (!p || p.phase !== 'production') return { ok: false, error: '양산 가능한 기종이 아닙니다.' };
    const seg = SEGMENTS[p.segment];
    const grade = LINE_GRADES[gradeId] || LINE_GRADES.standard;
    const cost = Math.round(seg.lineCost * grade.costMult);
    if (s.cash < cost) return { ok: false, error: `라인 건설비 ${fmtMoney(cost)}이 부족합니다.` };
    ensureShape(s);
    s.cash -= cost;
    s.pending.capex += cost;
    const capacity = Math.max(1, Math.round(seg.lineMaxRate * grade.rateMult));
    s.lines.push({
      id: 'line-' + s.nextId++,
      programId: p.id,
      grade: grade.id,
      paidCost: cost, // 폐쇄 환급의 근거 — 등급별 건설비가 다르다
      capacity,
      ramp: 0.15,
      partial: 0,
      idle: false,
      builtTurn: s.turn,
    });
    // 로그는 영구 경영 기록이다. 세그먼트 기준값을 적으면 현금 지출·라인 능력과
    // 어긋나므로(고속 협동체 라인이 $1.54B·25기인데 $880M·16기로 남는다) 실제 값을 쓴다.
    pushLog(s, 'good', `${p.name} 전용 ${grade.name} 조립 라인 신설 (${fmtMoney(cost)}). 최대 분기 ${capacity}기.`);
    return { ok: true };
  }

  /** 라인 폐쇄 — 건설비의 20%를 회수한다. */
  function closeLine(s, lineId) {
    const idx = s.lines.findIndex((l) => l.id === lineId);
    if (idx < 0) return { ok: false, error: '라인을 찾을 수 없습니다.' };
    const line = s.lines[idx];
    const p = s.programs.find((x) => x.id === line.programId);
    // 실제로 낸 값의 20%를 돌려준다. 기준가로 계산하면 고속 라인은 11%,
    // 재래식은 28% 가 돌아와 "20% 환급"이라는 안내와 어긋난다.
    const grade = LINE_GRADES[line.grade] || LINE_GRADES.standard;
    const paid = typeof line.paidCost === 'number' ? line.paidCost : SEGMENTS[p.segment].lineCost * grade.costMult;
    const refund = Math.round(paid * 0.2);
    ensureShape(s);
    s.cash += refund;
    s.pending.capex -= refund; // 매각 대금은 설비 투자의 환입
    s.lines.splice(idx, 1);
    pushLog(s, 'info', `${p.name} 라인 폐쇄. 설비 매각으로 ${fmtMoney(refund)} 회수.`);
    return { ok: true };
  }

  /**
   * 라인 전환 — 기존 라인을 다른 기종으로 돌린다.
   * 동체 단면이 같아야 치구를 재활용할 수 있다. 패밀리 전략이 개발비뿐 아니라
   * 생산 설비까지 재활용하게 만드는 지점이다(실제로도 같은 최종조립라인에서
   * 같은 계열 변형을 굴린다).
   */
  /**
   * 치구를 재활용할 수 있는 전환인가.
   * 화면(전환 버튼 노출)과 실행이 반드시 같은 규칙을 쓰도록 여기 한 곳에만 둔다.
   *
   * 열 수만 같으면 된다고 보면 안 된다 — 5열 리저널과 5열 협동체는 동체 직경부터
   * 다른 별개 기체다(7열 협동체 ↔ 7열 광동체도 마찬가지). 급이 다르면 치구가
   * 아니라 건물부터 다시 봐야 하므로, 급까지 같아야 전환을 허용한다.
   */
  function retoolCompatibility(from, to) {
    if (!from || from.abreast === undefined || !to || to.abreast === undefined) {
      return { ok: false, error: '동체 단면을 알 수 없어 치구 재활용 여부를 판단할 수 없습니다.' };
    }
    if (from.segment !== to.segment) {
      return { ok: false, error: '급이 달라 치구를 재활용할 수 없습니다. 새 라인을 세워야 합니다.' };
    }
    if (from.abreast !== to.abreast) {
      return { ok: false, error: '동체 단면이 달라 치구를 재활용할 수 없습니다. 새 라인을 세워야 합니다.' };
    }
    return { ok: true };
  }

  function retoolLine(s, lineId, targetProgramId) {
    const line = s.lines.find((l) => l.id === lineId);
    if (!line) return { ok: false, error: '라인을 찾을 수 없습니다.' };
    const from = s.programs.find((x) => x.id === line.programId);
    const to = s.programs.find((x) => x.id === targetProgramId);
    if (!to || to.phase !== 'production') return { ok: false, error: '양산 가능한 기종이 아닙니다.' };
    if (to.id === line.programId) return { ok: false, error: '이미 그 기종의 라인입니다.' };
    const compat = retoolCompatibility(from, to);
    if (!compat.ok) return compat;

    const seg = SEGMENTS[to.segment];
    const grade = LINE_GRADES[line.grade] || LINE_GRADES.standard;
    const cost = Math.round(seg.lineCost * grade.costMult * RETOOL_COST_RATE);
    if (s.cash < cost) return { ok: false, error: `전환 비용 ${fmtMoney(cost)}이 부족합니다.` };

    ensureShape(s);
    s.cash -= cost;
    s.pending.capex += cost;
    // paidCost 는 건드리지 않는다. 급·등급이 같은 전환만 허용되므로 전환 후에도
    // 이 라인은 "그 급 그 등급의 라인" 그대로고, 새로 세우는 값도 같다. 전환비는
    // 그 분기의 capex 로 끝나는 지출이지 라인 가치를 올리는 돈이 아니다.
    line.programId = to.id;
    // 저율 승계 라인(capMult<1)은 전환해도 저율이다 — 35% 전환비로 세그 기준
    // 용량을 얻으면 명시적으로 모델링한 핸디캡이 공짜로 사라진다.
    line.capacity = Math.max(1, Math.round(seg.lineMaxRate * grade.rateMult * (line.capMult || 1)));
    line.ramp = 0.15; // 전환 후에는 램프업을 다시 올린다
    line.partial = 0;
    pushLog(s, 'info', `${from ? from.name : '라인'} → ${to.name} 라인 전환 (${fmtMoney(cost)}). 램프업을 다시 올린다.`);
    return { ok: true };
  }

  /** 외주 비중 변경 — 원가 ↔ 공급 차질 위험. */
  function setOutsourcing(s, levelId) {
    if (!OUTSOURCING[levelId]) return { ok: false, error: '알 수 없는 외주 수준입니다.' };
    ensureShape(s);
    s.outsourcing = levelId;
    pushLog(s, 'info', `조달 전략을 ${OUTSOURCING[levelId].name}으로 바꿨다.`);
    return { ok: true };
  }

  /**
   * 라인 가동 중지/재개. 수주 잔고가 없는데 계속 찍어내면 화이트테일 재고가
   * 현금을 태우므로, 멈춰 세우는 것도 중요한 경영 판단이다.
   * 재가동 시 램프업을 처음부터 다시 올려야 한다.
   */
  function toggleLine(s, lineId) {
    const line = s.lines.find((l) => l.id === lineId);
    if (!line) return { ok: false, error: '라인을 찾을 수 없습니다.' };
    line.idle = !line.idle;
    const p = s.programs.find((x) => x.id === line.programId);
    if (line.idle) {
      line.ramp = 0.15;
      line.partial = 0;
      pushLog(s, 'info', `${p ? p.name : '라인'} 조립 라인 가동 중지. 재가동 시 램프업을 다시 올려야 한다.`);
    } else {
      pushLog(s, 'info', `${p ? p.name : '라인'} 조립 라인 가동 재개.`);
    }
    return { ok: true };
  }

  /** 미인도 재고(화이트테일) 헐값 처분 — 정가의 68%. */
  function sellStock(s, programId, qty) {
    ensureShape(s);
    const p = s.programs.find((x) => x.id === programId);
    if (!p || p.stock <= 0) return { ok: false, error: '처분할 재고가 없습니다.' };
    // 운항 정지 중이면 인도와 마찬가지로 처분도 막는다. 그러지 않으면
    // "인도도 멈춘다"는 결함 이벤트 효과를 리스사 처분으로 우회할 수 있다.
    if ((s.effects.grounded[p.id] || 0) > 0) {
      return { ok: false, error: `${p.name}은(는) 운항 정지 중이라 처분할 수 없습니다.` };
    }
    const n = Math.min(qty, p.stock);
    const revenue = Math.round(n * p.listPrice * 0.68);
    const progBefore = p.delivered;
    const companyBefore = s.stats.delivered;
    p.stock -= n;
    p.delivered += n;
    // 처분도 delivered 를 올리므로 마일스톤 문턱을 지난다. 여기서 안 세면
    // 문턱이 조용히 넘어가고, 이후의 진짜 인도는 그 순간을 영영 되찾지 못한다.
    recordDeliveryMilestones(s, p, { airlineName: '리스 시장', disposal: true }, progBefore, companyBefore);
    s.cash += revenue;
    s.stats.delivered += n;
    s.stats.revenue += revenue;
    // 분기 중 발생한 처분 실적 — 다음 정산 리포트에 합산해, 현금은 늘었는데
    // 재무표의 매출·손익·인도에는 빠져 설명이 안 되는 상태를 막는다.
    s.pending.revenue += revenue;
    s.pending.delivered += n;
    adjustReputation(s, -1);
    pushLog(s, 'info', `${p.name} 재고 ${n}기를 리스사에 정가 68%로 처분. ${fmtMoney(revenue)} 확보.`);
    return { ok: true };
  }

  function hireEngineers(s, count) {
    ensureShape(s);
    const cost = Math.round(Math.abs(count) * CONFIG.engineerHireCost);
    if (count > 0) {
      if (s.cash < cost) return { ok: false, error: `채용 비용 ${fmtMoney(cost)}이 부족합니다.` };
      s.cash -= cost;
      s.pending.overhead += cost;
      s.engineers += count;
      pushLog(s, 'info', `엔지니어 ${count.toLocaleString('ko-KR')}명 채용 (${fmtMoney(cost)}).`);
    } else {
      const cut = Math.min(-count, s.engineers - 500);
      if (cut <= 0) return { ok: false, error: '최소 인력 500명은 유지해야 합니다.' };
      const severance = Math.round(cut * CONFIG.engineerHireCost * 0.5);
      // 위로금을 낼 현금이 없으면 감원 자체가 불가능하다. 그냥 집행하면 현금이
      // 음수가 된 채 파산 판정 없이 다음 분기까지 회복할 틈이 생긴다.
      if (s.cash < severance) return { ok: false, error: `퇴직 위로금 ${fmtMoney(severance)}이 부족합니다.` };
      s.cash -= severance;
      s.pending.overhead += severance;
      s.engineers -= cut;
      adjustReputation(s, -1);
      pushLog(s, 'bad', `엔지니어 ${cut.toLocaleString('ko-KR')}명 감원. 조직이 술렁인다.`);
    }
    return { ok: true };
  }

  function borrow(s, amount) {
    const room = CONFIG.maxDebt - s.debt;
    const take = Math.min(amount, room);
    if (take <= 0) return { ok: false, error: '차입 한도가 남아있지 않습니다.' };
    s.debt += take;
    s.cash += take;
    markDebtPeak(s);
    pushLog(s, 'info', `${fmtMoney(take)} 차입. 총 부채 ${fmtMoney(s.debt)}.`);
    return { ok: true };
  }

  /**
   * 부채 봉우리 기록. 회고의 "최대 부채"를 분기말 이력에서만 뽑으면, 분기 중에
   * 빌렸다 같은 분기에 갚은 금액과 첫 정산 전에 갚아 버린 승계 부채가 통째로 빠진다.
   */
  function markDebtPeak(s) {
    if (!s.stats) return;
    if (!(s.stats.peakDebt >= s.debt)) s.stats.peakDebt = Math.round(s.debt);
  }

  function repay(s, amount) {
    const pay = Math.min(amount, s.debt, s.cash);
    if (pay <= 0) return { ok: false, error: '상환할 수 있는 금액이 없습니다.' };
    s.debt -= pay;
    s.cash -= pay;
    pushLog(s, 'info', `${fmtMoney(pay)} 상환. 잔여 부채 ${fmtMoney(s.debt)}.`);
    return { ok: true };
  }

  /** RFP 입찰 등록/해제. programId가 null이면 포기. */
  function setBid(s, rfpId, programId, discount, terms) {
    if (!programId) {
      delete s.bids[rfpId];
      return { ok: true };
    }
    // 이미 걸어 둔 조건은 유지한다 — 기종만 바꿔도 조건이 표준으로 되돌아가면
    // 화면에서 고른 값과 실제 응찰이 어긋난다.
    const prev = s.bids[rfpId];
    s.bids[rfpId] = {
      programId,
      discount: clamp(discount, 0, CONFIG.maxDiscount),
      terms: normalizeTerms(terms || (prev && prev.terms)),
    };
    return { ok: true };
  }

  /** 이미 올려둔 응찰의 조건만 바꾼다. */
  function setBidTerms(s, rfpId, terms) {
    const bid = s.bids[rfpId];
    if (!bid) return { ok: false, error: '먼저 기종을 골라야 합니다.' };
    bid.terms = normalizeTerms({ ...bid.terms, ...terms });
    return { ok: true };
  }

  function adjustReputation(s, delta) {
    s.reputation = clamp(s.reputation + delta, 0, 100);
  }

  // ─────────────────────────────── 분기 정산 ───────────────────────────────

  function endTurn(s) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    ensureShape(s);
    const rng = rngFor(s);

    // 답하지 않은 사건을 **리포트를 만들기 전에** 닫는다. 여기서 나가는 돈은
    // 플레이어 행동과 같은 통로(pending)를 쓰므로, 리포트를 먼저 만들면 이 분기에
    // 현금은 나가고 비용은 다음 분기 장부에 적히는 한 분기 어긋남이 생긴다.
    resolveOpenDecision(s, rng);

    // 목표 개념이 없던 세이브를 불러오면 목표가 비어 있다. 정산 함수는 빈 목표에서
    // 그냥 돌아가므로, 여기서 채워 주지 않으면 그 판은 끝까지 목표 없이 흘러간다.
    if (!s.mandate) issueMandate(s, rng);

    const report = {
      label: turnLabel(s.turn),
      revenue: s.pending.revenue,
      productionCost: s.pending.productionCost || 0,
      rdCost: s.pending.rdCost,
      capex: s.pending.capex,
      overhead: s.pending.overhead,
      interest: 0,
      delivered: s.pending.delivered,
      // 결정으로 성사된 수주도 이 분기 실적이다. 0으로 시작하면 리스사 대량 발주를
      // 받은 분기가 "신규 수주 0기"로 기록된다.
      ordersWon: s.pending.ordersWon || 0,
    };
    s.pending = { revenue: 0, delivered: 0, rdCost: 0, capex: 0, overhead: 0, ordersWon: 0, productionCost: 0 };

    resolveBids(s, rng, report);
    advanceDevelopment(s, rng, report);
    runProduction(s, report);
    runDeliveries(s, report);
    expirePreorders(s, report);
    chargeLatePenalties(s, report);
    collectReceivables(s, report, rng);
    runServices(s, report);
    runResearch(s, report);
    tickUpgrades(s, report);
    tickEtopsService(s);
    tickForeignCert(s, rng, report);
    tickLocalEngine(s);
    // 경쟁사 인도도 이 분기 몫으로 집계한다. 다음 분기 준비 단계에서 굴리면
    // 플레이어는 80분기, 경쟁사는 79분기가 되어 점유율이 늘 유리해진다.
    simulateRivals(s, rng);
    settleFinance(s, report);

    s.stats.peakShare = Math.max(s.stats.peakShare || 0, marketShare(s));
    // 시나리오 목표 — 단조 목표는 채우는 순간 기념하고, 무너진 목표는 그 자리에서 알린다.
    tickScenario(s);

    s.history.push({
      turn: s.turn,
      label: report.label,
      cash: Math.round(s.cash),
      debt: Math.round(s.debt),
      revenue: Math.round(report.revenue),
      cost: Math.round(report.productionCost + report.rdCost + report.capex + report.overhead + report.interest),
      net: Math.round(report.revenue - report.productionCost - report.rdCost - report.capex - report.overhead - report.interest),
      delivered: report.delivered,
      rd: Math.round(report.rdCost),
      backlog: totalBacklog(s),
      reputation: Math.round(s.reputation),
      // 추이 화면이 읽는 값들. 분기마다 여기서 찍어 두지 않으면 20년치를 되짚을 방법이 없다.
      worth: Math.round(netWorth(s)),
      share: Math.round(marketShare(s) * 10000) / 10000,
      ordersWon: report.ordersWon,
      fuel: Math.round(s.market.fuelIndex * 1000) / 1000,
      demand: Math.round(s.market.demandIndex * 1000) / 1000,
    });
    if (s.history.length > 120) s.history.shift();

    // 파산은 정산 결과로 확정한다. 다음 분기 이벤트를 먼저 굴리면 연구지원금 같은
    // 현금 유입이 이미 지급불능인 회사를 되살려 "즉시 종료" 규칙과 어긋난다.
    if (checkBankrupt(s)) {
      saveRng(s, rng);
      return { ok: true, report };
    }

    // ── 다음 분기로 ──
    s.turn++;

    // 마지막 분기를 정산했다면 여기서 끝낸다. 존재하지 않는 다음 분기의 경쟁사 인도량이
    // 최종 점유율을 깎거나, 이벤트가 최종 현금·평판까지 바꾼다.
    if (s.turn >= CONFIG.totalTurns) {
      // 아직 오지 않은 약속을 여기서 모두 닫는다. 그러지 않으면 종료 직전에 고른
      // 정부 지원금·낙관적 전망 같은 선택이 이득만 챙기고 대가를 영영 피한다.
      resolvePendingOutcomes(s, rng, { final: true });
      // 못 지킨 선주문도 여기서 정산한다. 마지막 6분기 안에 딴 선주문은 정체
      // 만료가 오기 전에 판이 끝나므로, 이 정산이 없으면 종료 직전 종이 비행기
      // 응찰이 선수금과 평판만 챙기고 최종 점수를 부풀린다. 인증까지 못 간
      // 기종의 계약은 실제로도 제조사 귀책이다 — 위약 배수 그대로 문다.
      //
      // 이사회 목표(settleMandate)보다 **먼저** 문다 — 순자산 목표를 위약 정산
      // 전 장부로 채점하면, 실제로는 미달인 회사가 달성 보상금으로 위약을 메우는
      // 순서 역전이 생긴다. 이사회는 다 갚고 남은 잔고를 본다.
      for (const p of s.programs) {
        if (p.phase === 'dev' || p.phase === 'cert') {
          voidOrdersFor(s, p, '기한 내 미취항');
          continue;
        }
        if (p.phase !== 'production') continue;
        // 형식증명은 있어도 인도 능력이 전무한 기종 — 인도 실적도 재고도 라인도
        // 없다 — 의 주문은 지킬 수 없던 약속이다. 마지막 분기에 인증과 수주를
        // 동시에 챙기는 경우가 정확히 여기 걸린다: resolveBids 가 advanceDevelopment
        // 보다 먼저 돌므로 인증 직전 기종이 수주 후 같은 정산에서 양산이 되는데,
        // 라인을 세울 기회가 없었으니 그 주문은 영영 인도되지 않는다.
        const bare = !(p.delivered > 0) && !(p.stock > 0) && !s.lines.some((l) => l.programId === p.id);
        if (bare) {
          voidOrdersFor(s, p, '기한 내 미인도');
          continue;
        }
        // 양산에는 갔지만 ETOPS 를 못 딴 기종의 대양 노선 주문도 같은 귀책이다 —
        // 약속한 능력(인증)이 끝내 없어서 인도 게이트에 막힌 채 판이 끝났다.
        // 같은 기종의 일반 주문은 인도 가능한 물량이므로 건드리지 않는다.
        if (!p.etopsCertified && p.engines !== 4) {
          const blocked = s.backlog.filter((o) => o.programId === p.id && o.remaining > 0 && o.reqEtops);
          voidOrderList(s, p, blocked, 'ETOPS 미인증');
        }
      }
      // 60분기에 발령된 목표는 80분기가 기한이다. 여기서 닫지 않으면 완주한 판마다
      // 마지막 5년치 성과가 보상·벌점 없이 사라진다.
      settleMandate(s, rng, { final: true });
      // 위 정산들이 만든 현금 이동은 이미 마감된 리포트에 없다. 마지막 분기 행에 얹어야
      // 종료 화면의 현금·매출·순자산 곡선이 실제 잔고와 맞는다. 새 행을 만들면
      // 존재하지 않는 81번째 분기가 재무표에 뜬다.
      foldPendingIntoLastRow(s);
      // 강제 정산이 현금을 다 태웠다면 완주가 아니라 파산이다. 이 검사를 빼면
      // 마지막 기술료 상환으로 회사가 무너지고도 완주 등급(F 아님)을 받는다.
      // 표시 분기는 마지막으로 경영한 분기여야 한다 — s.turn 은 이미 80이다.
      if (!checkBankrupt(s, Math.max(0, s.turn - 1))) finishGame(s);
      saveRng(s, rng);
      return { ok: true, report };
    }

    tickEffects(s);
    settleMandate(s, rng);
    driftMarket(s, rng);
    reactToRivals(s);
    rollMarketNews(s);
    resolvePendingOutcomes(s, rng);

    // 지연 결과가 현금을 말렸다면 이번 분기 이벤트·사건은 굴리지 않는다. 그대로 두면
    // 연구지원금 같은 현금 유입이 이미 지급불능인 회사를 되살려, 확정될 파산이 없던
    // 일이 된다. (rollEvents 안에도 같은 취지의 중단이 있다.)
    //
    // 다만 여기서 곧장 반환하지는 않는다. 공고 갱신과 아래 파산 확정을 건너뛰면
    // 회사는 지급불능인 채로 살아 있고, 지난 분기 공고·입찰이 그대로 남아 다음
    // 정산에서 같은 입찰이 한 번 더 판정된다.
    const doomedByOutcomes = isInsolvent(s);
    s.events = doomedByOutcomes ? [] : rollEvents(s, rng);
    // 이벤트(중대 결함 등)가 시나리오를 무너뜨렸다면 다음 분기 정산까지 기다리지
    // 않고 그 자리에서 알린다 — 정산 초의 판정은 이 분기 이벤트를 아직 못 봤다.
    tickScenario(s);
    s.decision = doomedByOutcomes ? null : rollDecision(s, rng);
    s.rfps = generateRfps(s, rng);
    s.bids = {};

    // 다음 분기에 적용될 이자율과 등급을 지금 함께 확정한다. 둘을 따로 두면
    // 분기 중 차입으로 등급만 바뀌어 "등급 B · 이자율 1.60%(=BBB 값)" 같은
    // 자기모순이 화면에 뜬다.
    s.ratingForQuarter = creditRating(s).grade;
    s.rateForQuarter = interestRate(s);
    // 금리 보정 기간은 여기서 센다. tickEffects 에서 다른 효과와 같이 깎으면,
    // 플레이어가 분기 중에 차환한 경우 이번 분기 금리는 이미 확정돼 있는데 기간만
    // 하나 줄어 광고한 6분기가 5번만 적용된다. 방금 확정한 금리가 곧 한 번의
    // 적용이므로, 확정 직후에 세는 것이 "몇 번의 이자에 붙는가"와 정확히 맞는다.
    tickRateEffects(s);

    // 이벤트(결함 수리비 등)가 현금을 빼앗아 지급불능이 된 경우도 즉시 종료다.
    // 정산 직후 검사만 두면, 이벤트발 지급불능은 다음 분기 내내 살아남아
    // 재고 처분 등으로 회생할 수 있다.
    if (checkBankrupt(s)) {
      // 여기서 끝나면 이 pending 을 흡수할 다음 분기가 영영 오지 않는다.
      flushTerminalQuarter(s);
    }

    saveRng(s, rng);
    return { ok: true, report };
  }

  /**
   * 수주전 전적을 제조사별로 남긴다. 로그는 흘러가 버리지만 이 장부는 20년 내내 쌓여,
   * "협동체에서는 늘 에어버스와 붙었고 절반을 내줬다" 같은 판의 요약이 된다.
   */
  function recordDuel(s, result, qtyAtStake) {
    const id = result.rivalMaker;
    if (!id) return;
    if (!s.stats.duels) s.stats.duels = {};
    const d = (s.stats.duels[id] = s.stats.duels[id] || { faced: 0, won: 0, split: 0, lost: 0, lostQty: 0 });
    d.faced++;
    if (result.outcome === 'win') d.won++;
    else if (result.outcome === 'split') {
      d.split++;
      // 절반을 나눠 가진 만큼은 상대에게 내준 물량이다. 완패만 세면 매번 반씩
      // 뺏기고도 "놓친 물량 0기"가 뜬다.
      d.lostQty += Math.max(0, (qtyAtStake || 0) - result.qty);
    } else {
      d.lost++;
      d.lostQty += qtyAtStake || 0;
    }
  }

  function resolveBids(s, rng, report) {
    // 1단계: 분기 시작 상태로 모든 입찰 점수를 먼저 고정한다.
    // 순차 처리하면 앞선 수주로 오른 평판·관계가 뒤 입찰의 점수를 바꿔,
    // 플레이어가 화면에서 확인한 점수와 다른 값으로 판정된다.
    const queued = [];
    const noBidAirlines = [];
    for (const rfp of s.rfps) {
      const bid = s.bids[rfp.id];
      if (!bid) {
        // 응찰 자체가 불가능한 공고(해당 세그먼트에 양산 기종이 없거나 전부 실격)는
        // 감점하지 않는다. 초반엔 협동체 DN-150 하나뿐이라 리저널·광동체 공고에
        // 대응할 방법이 없는데, 그걸로 관계가 깎이면 이후 입찰 점수까지 낮아진다.
        // 감점은 점수 계산이 모두 끝난 뒤에 적용한다 — 같은 항공사의 다른 공고
        // 점수가 이 감점의 영향을 받으면 안 된다.
        if (canBid(s, rfp)) noBidAirlines.push(rfp.airlineId);
        continue;
      }
      const program = s.programs.find((p) => p.id === bid.programId);
      if (!program || !biddablePhase(program)) continue;

      const score = scoreBid(s, rfp, program, bid.discount, bid.terms);
      if (score.blocked) continue;
      queued.push({ rfp, program, score, terms: normalizeTerms(bid.terms) });
    }

    // 2단계: 고정된 점수로 판정하고 보상·감점을 적용한다.
    for (const airlineId of noBidAirlines) {
      s.relations[airlineId] = clamp((s.relations[airlineId] ?? 40) - 1.5, 0, 100);
    }
    for (const { rfp, program, score, terms } of queued) {
      s.stats.bidsMade++;
      const result = resolveBid(s, rfp, { score }, rng);
      s.relations[rfp.airlineId] = clamp((s.relations[rfp.airlineId] ?? 40) + 2, 0, 100);
      recordDuel(s, result, rfp.qty);

      if (result.outcome === 'lose') {
        pushLog(
          s,
          'bad',
          `${rfp.airlineName} ${rfp.qty}기 수주 실패 — ${result.rivalName}에 밀렸다. (우리 ${score.total} vs ${result.rivalScore})`,
        );
        continue;
      }

      const unitPrice = score.price;
      const financing = BID_FINANCING[terms.financing] || BID_FINANCING.normal;
      const pledge = BID_PLEDGES[terms.pledge] || BID_PLEDGES.standard;
      const deposit = Math.round(result.qty * unitPrice * CONFIG.depositRate * financing.depositMult);
      s.cash += deposit;
      report.revenue += deposit;
      report.ordersWon += result.qty;
      s.stats.ordersWon += result.qty;
      s.relations[rfp.airlineId] = clamp(s.relations[rfp.airlineId] + 10, 0, 100);
      adjustReputation(s, result.outcome === 'win' ? 2 : 1);

      s.backlog.push({
        id: 'ord-' + s.nextId++,
        airlineId: rfp.airlineId,
        airlineName: rfp.airlineName,
        programId: program.id,
        programName: program.name,
        qty: result.qty,
        remaining: result.qty,
        unitPrice,
        wonTurn: s.turn,
        // 약속과 조건은 주문에 붙어 다닌다 — 인도 순서, 위약금, 대금 회수가 여기서 갈린다.
        pledge: pledge.id,
        financing: financing.id,
        // 대양 노선 주문은 인증 없이 인도할 수 없다 — 선주문으로 이긴 뒤 인증을
        // 건너뛰고 배송하는 구멍을 막으려면 요구가 주문에 붙어 다녀야 한다.
        reqEtops: !!rfp.reqEtops,
        // 수주한 이 분기의 인도가 이미 첫 번째 기회다. 그대로 더하면 "4분기 안에"가
        // 다섯 번의 인도를 허용해, 광고한 대가가 한 분기씩 무뎌진다.
        dueTurn: s.turn + pledge.dueQuarters - 1,
        // 선수금을 두 배로 받았으면 인도 시 잔금도 그만큼 줄어야 총액이 계약가다.
        depositRate: CONFIG.depositRate * financing.depositMult,
      });

      const verb = result.outcome === 'win' ? '단독 수주' : '분할 수주';
      pushLog(
        s,
        'good',
        `${rfp.airlineName} ${verb}! ${program.name} ${result.qty}기, 대당 ${fmtMoney(unitPrice)} (총 ${fmtMoney(result.qty * unitPrice)}). 선수금 ${fmtMoney(deposit)} 입금.`,
      );
    }
  }

  /**
   * 시험비행 — 형식증명은 기다리는 시간이 아니라 운영하는 과정이다.
   *
   * 설계를 동결하면 시험기를 만들어 규정 시간을 채워야 인증이 난다. 시험기를 더
   * 만들면 빨라지지만 그만큼 현금이 먼저 나간다 — 787은 6대, A380은 5대를 띄웠고
   * 그 선택이 곧 취항 시점과 초기 자금 부담을 갈랐다.
   *
   * 시험기 대수를 기본값으로 두면 예전과 같은 기간이 나오도록 눈금을 맞췄다.
   */
  const TEST_HOURS_PER_QUARTER = 350;
  const DEFAULT_TEST_FLEET = 2;
  const MAX_TEST_FLEET = 6;
  /** 시험기는 선행 생산 기체라 손으로 만드는 부분이 많다. */
  const TEST_AIRCRAFT_COST_MULT = 1.6;
  /** 인증 후 시험기를 개수해 처분할 때 건지는 비율. 실제로도 헐값이다. */
  const TEST_AIRCRAFT_SALVAGE = 0.4;

  /** 그 프로그램이 이번 분기에 쌓는 시험비행 시간. */
  function testHoursPerQuarter(p) {
    return (p.testFleet || 0) * TEST_HOURS_PER_QUARTER;
  }

  /** 남은 시험 시간을 분기로 환산 — 화면과 옛 필드(certRemaining)가 읽는다. */
  function certQuartersLeft(p) {
    const rate = testHoursPerQuarter(p);
    const left = Math.max(0, (p.testHoursNeeded || 0) - (p.testHours || 0));
    if (rate <= 0) return Infinity;
    return Math.ceil(left / rate);
  }

  /**
   * 인증을 n분기 미룬다 — 이벤트가 부르는 통로.
   *
   * 예전 모델에서는 certRemaining 에 그냥 더하면 됐지만, 지금 잔여 분기는 시험비행
   * 시간에서 계산되는 파생값이라 거기에 더해 봐야 다음 정산에서 덮어써진다.
   * "n분기"를 그 편대 기준 시간으로 환산해야 실제로 밀린다.
   */
  function delayCertification(p, quarters) {
    if (p.phase !== 'cert' || !(quarters > 0)) return 0;
    const added = Math.round(quarters * Math.max(testHoursPerQuarter(p), TEST_HOURS_PER_QUARTER));
    p.testHoursNeeded = (p.testHoursNeeded || 0) + added;
    p.certRemaining = certQuartersLeft(p);
    return added;
  }

  /** 시험기 한 대 값. 양산 원가에 선행 생산 할증을 얹는다. */
  function testAircraftCost(s, p) {
    return Math.round(currentUnitCost(s, p) * TEST_AIRCRAFT_COST_MULT);
  }

  /**
   * 시험기를 한 대 더 만든다. 인증 심사 중에만 의미가 있다.
   * 돈을 더 써서 취항을 앞당기는 선택 — 개발 막바지에 현금이 가장 마른 시점에 온다.
   */
  function addTestAircraft(s, programId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    const p = s.programs.find((x) => x.id === programId);
    if (!p) return { ok: false, error: '없는 프로그램입니다.' };
    if (p.phase !== 'cert') return { ok: false, error: '형식증명 심사 중인 기종만 시험기를 늘릴 수 있습니다.' };
    if ((p.testFleet || 0) >= MAX_TEST_FLEET) return { ok: false, error: `시험기는 ${MAX_TEST_FLEET}대까지입니다.` };

    // 남은 시간이 이미 다음 분기 안에 들어오면 한 대를 더 띄워도 취항이 앞당겨지지
    // 않는다. 화면은 이 버튼을 "취항을 앞당기는 수단"으로만 광고하므로, 아무 이득
    // 없이 제작비를 태우게 두면 안 된다.
    const after = { testFleet: (p.testFleet || 0) + 1, testHours: p.testHours, testHoursNeeded: p.testHoursNeeded };
    if (certQuartersLeft(after) >= certQuartersLeft(p)) {
      return { ok: false, error: '남은 시험이 이미 다음 분기에 끝납니다. 시험기를 늘려도 취항이 앞당겨지지 않습니다.' };
    }

    const cost = testAircraftCost(s, p);
    if (s.cash < cost) return { ok: false, error: `시험기 제작비 ${fmtMoney(cost)}이 부족합니다.` };
    s.cash -= cost;
    s.pending.rdCost += cost;
    p.spent += cost;
    p.testFleet = (p.testFleet || 0) + 1;
    p.testSpent = (p.testSpent || 0) + cost;
    pushLog(s, 'program', `${p.name} 시험기 ${p.testFleet}호기를 띄웠다 (${fmtMoney(cost)}). 남은 심사 ${certQuartersLeft(p)}분기.`);
    return { ok: true, cost };
  }

  /**
   * ETOPS — 설계 옵션이 아니라 따내는 인증이다.
   *
   * 쌍발기로 대양을 건너려면 기체가 그렇게 설계된 것만으로는 부족하다. 규제 당국은
   * 운항 실적을 본다. 실제로 777 이전에는 취항 후 1년을 날아야 ETOPS 가 나왔고,
   * 조기 취득(early ETOPS)은 시험비행에서 그만큼을 미리 증명해야 열렸다.
   *
   * 그래서 선택은 "설계에 넣는가"가 아니라 **"지금 돈을 내고 미리 따는가, 1년을
   * 기다리는가"** 다. 장거리 공고가 몰리는 시점에 이 1년이 아프다.
   */
  const ETOPS_SERVICE_QUARTERS = 4;
  /** 조기 취득에 필요한 추가 시험비행 — 기본 편대로 두 분기어치. */
  const ETOPS_EARLY_QUARTERS = 2;
  const ETOPS_EARLY_COST_RATE = 0.05;

  /**
   * 조기 ETOPS 취득 프로그램에 착수한다. 심사 중에만 열린다.
   * 시험 시간을 더 쌓아 취항과 동시에 인증을 받는다 — 그만큼 취항이 늦어진다.
   */
  function startEarlyEtops(s, programId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    const p = s.programs.find((x) => x.id === programId);
    if (!p) return { ok: false, error: '없는 프로그램입니다.' };
    if (!p.etops) return { ok: false, error: 'ETOPS 대응으로 설계된 기종이 아닙니다.' };
    if (p.phase !== 'cert') return { ok: false, error: '형식증명 심사 중에만 신청할 수 있습니다.' };
    if (p.etopsEarly) return { ok: false, error: '이미 조기 취득을 진행 중입니다.' };

    const cost = Math.round(p.devCost * ETOPS_EARLY_COST_RATE);
    if (s.cash < cost) return { ok: false, error: `조기 취득 비용 ${fmtMoney(cost)}이 부족합니다.` };
    s.cash -= cost;
    s.pending.rdCost += cost;
    p.spent += cost;
    p.etopsEarly = true;
    const addedHours = Math.round(ETOPS_EARLY_QUARTERS * DEFAULT_TEST_FLEET * TEST_HOURS_PER_QUARTER);
    p.testHoursNeeded += addedHours;
    pushLog(
      s,
      'program',
      `${p.name} 조기 ETOPS 취득에 착수했다 (${fmtMoney(cost)}). 재시험 ${num(addedHours)}시간이 늘고, 취항과 동시에 대양 노선에 들어간다.`,
    );
    return { ok: true, cost };
  }

  // ─────────────────────── UEC 국산화 (trait.localEngine) ───────────────────────
  //
  // UAC 는 서방 엔진을 달고 시작한다 — Tu-204 에 CFM56, Il-96 에 PW4000. 실제
  // 러시아 기체가 수출형에서 그랬듯이, 그게 서방 시장에 들이밀 수 있는 조합이기
  // 때문이다. 대신 그 엔진은 남의 공급망이고 남의 값이다.
  //
  // 자회사 UEC 에 개발비를 부어 그 자리를 국산 엔진으로 갈아 끼울 수 있다.
  // **시간과 돈을 둘 다 채워야** 끝난다: 돈을 아무리 부어도 minQuarters 는 줄지
  // 않고, 분기가 아무리 지나도 자금이 안 차면 끝나지 않는다. 실제 엔진 개발이 그렇다.
  //
  // 완성되면 그 엔진을 달고 있던 **우리 기종 전부**가 자동으로 갈아탄다 — 이름이
  // 바뀌고 생산원가가 내려간다. 대신 연비가 처지고 초기 신뢰성이 나빠진다:
  // PS-90A 가 CFM56 대비 실제로 그랬고, 그래서 Tu-204 는 국내선에서 버티고
  // 수출에서는 밀렸다.
  //
  // 측정된 값의 성격은 **원가를 사고 수주 경쟁력을 파는 것**이다 (Tu-204 기준):
  // 대당 원가 $59M → $50M, 대신 모든 수주전에서 1.5~1.8점을 잃는다. 서방의 벽이
  // −3점인 것과 견주면 그 절반쯤이다. 유가가 오를수록 감점이 조금 더 벌어지지만
  // (0.6 에서 −1.5, 1.9 에서 −1.8) 시대를 갈아엎을 만큼은 아니다 — 이 축의 본질은
  // 유가가 아니라 **곳간**이다. 현금이 급한 회사가 파는 것이 수주 경쟁력이다.

  /** 계약한 엔진과 다른 것을 받게 된 항공사의 관계 하락. */
  const LOCAL_ENGINE_SWAP_RELATION = 4;

  /** 관계 점수를 실제로 들고 있는 계정 — 카탈로그의 항공사뿐이다. */
  const RELATION_AIRLINES = new Set(AIRLINES.map((a) => a.id));

  function localEngineSpec(s) {
    return companyTrait(s).localEngine || null;
  }

  /** 이 기종이 국산 엔진을 달고 있나 — 국가 발주 우대와 공급 차질 면역의 근거. */
  function hasDomesticEngine(p) {
    return !!(p && (root.AirlinerEngines.get(p.engine) || {}).domestic);
  }

  /** 그 세대의 값 — 2세대는 새 코어라 훨씬 비싸고 길다. */
  function localEngineGen(spec, gen) {
    return gen === 2 ? spec.gen2 || null : spec;
  }

  /**
   * 2세대를 착수할 수 있는 가장 이른 **분기** — 취항에서 개발 기간만큼 거슬러 잡는다.
   *
   * 따로 적어 둔 숫자가 아니라 유도한 값인 이유는, 그래야 완성이 그 엔진의 취항보다
   * 앞설 수 없기 때문이다. 앞서면 갈아타는 시점에 그 엔진을 아직 못 사는 상태가 되고,
   * 쌍 평가가 통째로 폴백으로 떨어진다(비율이 전부 1 — 국산화가 아무 값도 안 바꾼다).
   *
   * 연도가 아니라 분기로 세는 이유 — 14분기는 3.5년이라 열리는 시점이 연중이다.
   * 소수 연도로 들고 다니면 화면이 그걸 연도로 잘라 "2008년부터"라고 적는데,
   * 실제로는 2008년 3분기다. 버튼은 잠겨 있는데 화면은 열렸다고 말하게 된다.
   */
  function localEngineOpensAt(to, quarters) {
    return (to.eis - CONFIG.startYear) * 4 - quarters;
  }

  /**
   * 지금 국산화를 걸 수 있는 자리들.
   *
   * - **1세대** — 우리가 쓰고 있는 서방 엔진을 국산으로. 원가를 사고 수주 경쟁력을 판다.
   * - **2세대** — 그 국산 엔진을 PD 계열로. 판 것을 되사 오는 사업이라 1세대를
   *   지나온 회사에만 열린다. 아직 이른 후보도 **감춰 두지 않고** 열리는 해와 함께
   *   내보낸다(`locked`) — 20년짜리 판에서 다음 목표가 보이는 것이 화면의 값이다.
   *
   * 열쇠가 `엔진 → 대체` 쌍인 것에 이유가 있다. PS-90A 는 협동체와 광동체를 모두
   * 돌리는데 2세대는 급마다 갈린다(PD-14 · PD-35). 엔진 하나로 묶으면 둘 중 하나가
   * 조용히 사라진다.
   */
  function localEngineTargets(s) {
    const spec = localEngineSpec(s);
    if (!spec) return [];
    const seen = new Map();
    for (const p of s.programs) {
      if (p.phase === 'cancelled' || p.phase === 'sold') continue;
      const eng = root.AirlinerEngines.get(p.engine);
      if (!eng) continue;
      // 서방 엔진이면 1세대, 이미 국산이면 2세대다.
      const gen = eng.domestic ? 2 : 1;
      const rates = localEngineGen(spec, gen);
      if (!rates || !rates.map) continue;
      const replacement = rates.map[p.segment];
      // 그 급에 대안이 없거나, 이미 그 엔진을 달고 있으면 갈아 끼울 것이 없다.
      if (!replacement || replacement === eng.id) continue;
      const to = root.AirlinerEngines.get(replacement);
      if (!to) continue;
      const key = `${eng.id}→${replacement}`;
      if (!seen.has(key)) {
        // 그 국산 엔진을 이미 만들어 뒀다면 이건 **개발이 아니라 재장착**이다:
        // 엔진은 있고, 그 기체에 다는 인증만 하면 된다. 싸고 짧다.
        const refit = (s.localEngines || []).includes(replacement);
        const quarters = refitQuarters(rates.minQuarters, refit);
        const opensTurn = gen === 2 ? localEngineOpensAt(to, quarters) : null;
        seen.set(key, {
          engine: eng,
          replacement,
          gen,
          refit,
          costRate: rates.costRate,
          minQuarters: rates.minQuarters,
          opensTurn,
          opensAt: opensTurn === null ? null : yearOf(opensTurn),
          opensLabel: opensTurn === null ? null : turnLabel(opensTurn),
          locked: opensTurn !== null && s.turn < opensTurn,
          programs: [],
        });
      }
      seen.get(key).programs.push(p);
    }
    return [...seen.values()];
  }

  /** 이미 개발한 엔진을 다른 기체에 다는 값 — 개발의 일부만 든다. */
  const LOCAL_ENGINE_REFIT_RATE = 0.35;

  function localEngineCost(s, target) {
    const spec = localEngineSpec(s);
    const segs = target.programs.map((p) => p.segment);
    // 여러 급이 걸린 엔진이면 가장 큰 급 기준이다 — 광동체용 코어를 만드는 값이
    // 협동체용보다 싸질 수는 없다.
    const base = Math.max(...segs.map((seg) => SEGMENTS[seg].devBase));
    // 옛 세이브·옛 호출부는 후보에 세대 값이 없다 — 그때는 1세대 요율로 읽는다.
    const rate = target.costRate ?? spec.costRate;
    return Math.round(base * rate * (target.refit ? LOCAL_ENGINE_REFIT_RATE : 1));
  }

  /** 재장착은 절반이면 된다 — 엔진은 이미 있고 그 기체에 다는 인증만 남았다. */
  function refitQuarters(minQuarters, refit) {
    return refit ? Math.max(2, Math.round(minQuarters * 0.5)) : minQuarters;
  }

  /** 그 사업에 필요한 최소 분기. */
  function localEngineQuarters(s, target) {
    const spec = localEngineSpec(s);
    return refitQuarters((target && target.minQuarters) ?? spec.minQuarters, !!(target && target.refit));
  }

  function startLocalEngine(s, targetEngineId, replacementId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    ensureShape(s);
    const spec = localEngineSpec(s);
    if (!spec) return { ok: false, error: '이 회사에는 국산화할 엔진 자회사가 없습니다.' };
    if (s.localEngineProject) return { ok: false, error: '이미 국산화 사업을 하나 진행 중입니다.' };
    const all = localEngineTargets(s).filter((t) => t.engine.id === targetEngineId);
    // 대체 엔진까지 받는 이유 — PS-90A 는 협동체·광동체를 모두 돌리는데 2세대는
    // 급마다 갈린다(PD-14 · PD-35). 엔진만으로는 어느 쪽인지 정해지지 않는다.
    const matched = replacementId ? all.filter((t) => t.replacement === replacementId) : all;
    if (!matched.length) return { ok: false, error: '지금 우리 기종이 달고 있는 엔진만 국산화할 수 있습니다.' };
    if (matched.length > 1) {
      return { ok: false, error: `이 엔진에는 갈아탈 곳이 둘입니다 — 어느 쪽인지 정하세요 (${matched.map((t) => (root.AirlinerEngines.get(t.replacement) || {}).name || t.replacement).join(' · ')}).` };
    }
    const target = matched[0];
    if (target.locked) {
      const to = root.AirlinerEngines.get(target.replacement);
      return { ok: false, error: `${to ? to.name : target.replacement} 는 ${target.opensLabel}부터 착수할 수 있습니다.` };
    }
    const minQuarters = localEngineQuarters(s, target);
    s.localEngineProject = {
      target: target.engine.id,
      engine: target.replacement,
      cost: localEngineCost(s, target),
      minQuarters,
      refit: !!target.refit,
      gen: target.gen || 1,
      funded: 0,
      quarters: 0,
    };
    const rep = root.AirlinerEngines.get(target.replacement);
    const repName = rep ? rep.name : target.replacement;
    pushLog(
      s,
      'program',
      target.refit
        ? `${spec.maker}에 ${target.engine.name} 자리에 ${repName} 를 다는 재장착 인증을 맡겼다. 엔진은 이미 우리 것이라 총 ${fmtMoney(s.localEngineProject.cost)}, 최소 ${minQuarters}분기면 된다.`
        : target.gen === 2
          ? `${spec.maker}에 ${target.engine.name} 를 대신할 **차세대 코어**(${repName}) 개발을 맡겼다. 총 ${fmtMoney(s.localEngineProject.cost)}, 최소 ${minQuarters}분기 — 1세대를 만들어 본 팀이 하는 일이지만 코어부터 새로 그린다.`
          : `${spec.maker}에 ${target.engine.name} 대체 엔진(${repName}) 개발을 맡겼다. 총 ${fmtMoney(s.localEngineProject.cost)}, 최소 ${minQuarters}분기 — 자금과 기간을 **둘 다** 채워야 나온다.`,
    );
    return { ok: true, project: s.localEngineProject };
  }

  function fundLocalEngine(s, amount) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    ensureShape(s);
    const proj = s.localEngineProject;
    if (!proj) return { ok: false, error: '진행 중인 국산화 사업이 없습니다.' };
    const need = proj.cost - proj.funded;
    if (need <= 0) return { ok: false, error: '개발비는 이미 다 채웠습니다 — 남은 것은 기간입니다.' };
    const put = Math.min(Math.max(0, Math.round(amount)), need);
    if (put <= 0) return { ok: false, error: '넣을 금액을 정하세요.' };
    if (s.cash < put) return { ok: false, error: `현금이 부족합니다 (보유 ${fmtMoney(s.cash)}).` };
    s.cash -= put;
    s.pending.rdCost += put;
    proj.funded += put;
    return { ok: true, funded: proj.funded, cost: proj.cost, put };
  }

  /** 국산화 취소 — 넣은 돈은 돌아오지 않는다. 개발을 접는 것과 같은 규칙이다. */
  function cancelLocalEngine(s) {
    if (!s.localEngineProject) return { ok: false, error: '진행 중인 국산화 사업이 없습니다.' };
    const spent = s.localEngineProject.funded;
    s.localEngineProject = null;
    pushLog(s, 'bad', `국산 엔진 개발을 접었다. 투입한 ${fmtMoney(spent)}은 돌아오지 않는다.`);
    return { ok: true, spent };
  }

  /**
   * 엔진을 갈아 끼우면 이 기종이 어떻게 되나 — **엔진만 다른 두 평가**의 차이.
   *
   * 엔진에서 유도되는 값을 손으로 하나씩 패치하지 않는다. 원가·정가·연비·객실·
   * 결함 위험이 전부 엔진을 타는데, 그중 하나라도 빠뜨리면 그게 그대로 버그가
   * 된다(정가를 빠뜨려 국산화한 기체가 서방 정가로 팔리던 것이 그 예다).
   * 엔진이 아닌 항은 두 평가에 똑같이 들어가 비율에서 상쇄되므로, 아래 스펙
   * 되짚기가 완벽하지 않아도 결과는 정확하다. 재평가로 통째로 갈아치우지 않는
   * 이유는 그 사이 쌓인 것(개량·품질 투자·인증 주사위)이 지워지기 때문이다.
   *
   * 완성 시점의 실제 적용(tickLocalEngine)과 착수 전 예고(생산 탭 카드)가 **이
   * 함수 하나**를 쓴다. 예고를 엔진 배수로 따로 계산하면 카드가 −16%를 적어 놓고
   * 실제로는 −18%가 나오는 식으로 갈라진다 — 그 카드는 거짓말을 하는 것이다.
   *
   * 상태는 건드리지 않는다. 바뀔 값을 계산해서 돌려줄 뿐이다.
   */
  function localEngineImpact(s, p, from, to, liveYear, engineBefore) {
    // 옛 엔진은 **그 엔진을 단 시점**의 연도로, 새 엔진은 **바뀐 기체가 보이는**
    // 연도로 평가한다. 그래야 성숙도 프리미엄이 옛 엔진 몫은 빠지고 새 엔진 몫이
    // 얹힌다.
    //
    // 착수 연도가 아니라 **장착 연도**인 이유 — 2세대 국산화는 1세대로 한 번
    // 갈아 끼운 엔진을 다시 바꾼다. SSJ-100 은 1998년에 나왔지만 D-436(취항 1999)을
    // 단 것은 2000년이다. 착수 연도로 재면 그 시점에 못 사는 엔진이라 평가가
    // 폴백으로 떨어지고(exact 실패), 정가·결함 위험·미성숙 표시가 통째로 안 바뀐다.
    const engineBorn = typeof p.engineTurn === 'number' ? p.engineTurn : p.launchTurn || 0;
    const designYear = Math.max(yearOf(0), yearOf(engineBorn));
    // 이중화였는지는 옛 평가가 그대로 재현해야 이중화 할증(원가 +3%)이 비율에서
    // 빠진다 — 대안을 접는 것이 국산화가 파는 값의 일부다.
    const hadDual = !!(p.dualSource || p.altEngine);
    // 원형 계보를 빼먹으면 파생형이 두 평가 모두에서 신규 설계로 잡힌다. 그러면
    // 재장착 감점(연비 −3)도, 파생형이 원형에서 물려받는 이중화 여부도 어긋난다.
    //
    // 계보의 엔진은 **스냅숏이 아니라 원형 프로그램의 지금 엔진**에서 읽는다.
    // `derivedFrom` 은 착수 시점의 복사본이라, 국산화가 원형을 갈아 끼우는 순간부터
    // 거짓말을 시작한다 — 원형은 PS-90A 인데 계보만 CFM56 을 가리키는 식으로.
    // 원형과 엔진이 달랐던 파생형은 그 사이 갈아타기에서 아예 건너뛰므로 스냅숏을
    // 고칠 기회조차 없다. 원형이 있으면 원형을 믿고, 없을 때만 스냅숏으로 물러선다.
    //
    // 새 평가의 계보는 **원형과 함께 옮긴다**. 국산화는 그 엔진을 단 기종을 전부
    // 같은 분기에 갈아 끼우므로 계보 전체가 같이 움직인다. 파생형에만 재장착 감점을
    // 물리면, 나란히 국산 엔진으로 옮겨 간 원형과 파생형이 착수 방식 때문에 갈라진다.
    // 반대로 원형과 같은 엔진으로 되돌아오는 파생형은 그 감점이 풀려야 한다.
    const anc = p.derivedFrom;
    // 원형의 엔진은 **이번 갈아타기 전** 값이어야 한다. 갈아타기는 프로그램을
    // 차례로 도는데, 원형이 먼저 처리되면 파생형 차례에는 이미 새 엔진이 박혀
    // 있다 — 그 값을 "있던 그대로"로 읽으면 원형이 늘 재장착으로 잡힌다.
    const parent = anc && anc.id ? s.programs.find((x) => x.id === anc.id) : null;
    const parentEngine = parent ? (engineBefore ? engineBefore.get(parent.id) ?? parent.engine : parent.engine) : null;
    const ancEngineOld = parent ? parentEngine : anc && anc.engine;
    const parentMoves = !!parent && parentEngine === from.id && to.segments.includes(parent.segment);
    const ancEngine = parentMoves ? to.id : ancEngineOld;
    const ancOld = anc ? { ...anc, dualSource: hadDual, engine: ancEngineOld } : null;
    const ancNew = anc ? { ...anc, dualSource: false, engine: ancEngine } : null;
    const base = {
      ...programSpec(p),
      domesticEngines: [from.id, to.id],
      // 조기 접근으로 착수한 기종(UAC 의 SaM146)은 이 맥락이 없으면 옛 엔진이
      // 설계 당시 연도에 "못 사는 엔진"으로 잡혀 평가가 통째로 어긋난다 —
      // exact 가 깨져 비율이 전부 1이 되고, 국산화가 아무 값도 안 바꾼다.
      earlyEngines: Object.keys(s.engineEarlyAccess || {}),
    };
    // 옛 평가는 **있던 그대로**(이중화 포함), 새 평가는 **될 그대로**(단일 국산).
    const evOld = evaluate({ ...base, engine: from.id, year: designYear, dualSource: hadDual, derivedFrom: ancOld });
    const evNew = evaluate({ ...base, engine: to.id, year: liveYear, dualSource: false, derivedFrom: ancNew });

    // 둘 중 하나라도 요청한 엔진으로 안 잡히면(그 시점에 못 사는 엔진 등) 비율이
    // 엉뚱해진다. 그때는 엔진 배수만으로 물러선다 — 틀린 값보다 거친 값이 낫다.
    const exact = evOld.engine === from.id && evNew.engine === to.id;
    const ratio = (a, b) => (exact && b ? a / b : 1);
    // 공급사 성능 패키지는 그 공급사 엔진에 붙은 값이다 — 엔진이 내려가면 함께 나간다.
    const eff = clamp(p.efficiency - (p.enginePipGain || 0), 1, 99);
    return {
      exact,
      hadDual,
      ancEngine,
      unitCostBase: exact
        ? Math.round(p.unitCostBase * ratio(evNew.unitCostBase, evOld.unitCostBase) * 10) / 10
        : Math.round((p.unitCostBase * to.costMult) / from.costMult * 10) / 10,
      listPrice: Math.round(p.listPrice * ratio(evNew.listPrice, evOld.listPrice) * 10) / 10,
      efficiency: clamp(Math.round(eff + (exact ? evNew.efficiency - evOld.efficiency : to.eff - from.eff)), 1, 99),
      comfort: clamp(Math.round(p.comfort + (exact ? evNew.comfort - evOld.comfort : to.comfort - from.comfort)), 1, 99),
      defectRisk:
        Math.round(clamp(p.defectRisk * ratio(evNew.defectRisk, evOld.defectRisk), 0.02, CONFIG.defectRiskMax) * 1000) / 1000,
      engineImmature: exact ? evNew.engineImmature : !!p.engineImmature,
    };
  }

  /**
   * 착수 전 예고 — 이 사업을 끝내면 걸린 기종들이 실제로 어떻게 바뀌나.
   * 완성 시점(지금 + 최소 분기)의 연도로 잡는다. 그때가 새 엔진이 실제로 보이는
   * 시점이고, 성숙도 프리미엄이 그 연도를 탄다.
   */
  function localEnginePreview(s, target) {
    const from = target && target.engine;
    const to = target && root.AirlinerEngines.get(target.replacement);
    if (!from || !to) return [];
    const liveYear = yearOf(s.turn + localEngineQuarters(s, target));
    return target.programs.map((p) => {
      const im = localEngineImpact(s, p, from, to, liveYear);
      return {
        program: p,
        exact: im.exact,
        // 원가·정가는 비율로, 연비·객실은 점수 차로 — 화면이 쓰는 그대로.
        cost: p.unitCostBase ? im.unitCostBase / p.unitCostBase - 1 : 0,
        listPrice: p.listPrice ? im.listPrice / p.listPrice - 1 : 0,
        efficiency: im.efficiency - p.efficiency,
        comfort: im.comfort - p.comfort,
        defectRisk: im.defectRisk - p.defectRisk,
      };
    });
  }

  /**
   * 국산화 진행 — 매 분기 정산에서 부른다. 자금과 기간이 **둘 다** 차면 완성되고,
   * 그 엔진을 달고 있던 우리 기종이 전부 갈아탄다.
   */
  function tickLocalEngine(s) {
    const proj = s.localEngineProject;
    if (!proj) return;
    const spec = localEngineSpec(s);
    if (!spec) return;
    proj.quarters += 1;
    // 옛 세이브(프로젝트에 minQuarters 가 없던 판)는 사풍의 기본값으로 읽는다.
    const need = proj.minQuarters ?? spec.minQuarters;
    if (proj.funded < proj.cost || proj.quarters < need) return;

    const from = root.AirlinerEngines.get(proj.target);
    const to = root.AirlinerEngines.get(proj.engine);
    s.localEngineProject = null;
    if (!from || !to) return;

    if (!s.localEngines.includes(to.id)) s.localEngines.push(to.id);

    const swapped = [];
    const dropped = [];
    const upset = new Set();
    // 갈아타기 **전** 엔진 배치. 계보의 "있던 그대로"를 여기서 읽는다.
    const engineBefore = new Map(s.programs.map((x) => [x.id, x.engine]));
    // 갈아탄 기체가 실제로 보이는 분기 — tickLocalEngine 은 s.turn++ **전에** 돈다.
    const liveYear = yearOf(s.turn + 1);
    for (const p of s.programs) {
      if (p.phase === 'cancelled' || p.phase === 'sold') continue;
      if (p.engine !== from.id) continue;
      // **그 엔진이 들어가는 급만** 갈아탄다. 1세대는 PS-90A 가 협동체·광동체를
      // 모두 돌려서 이 경계가 드러나지 않았지만, 2세대는 급마다 갈린다(PD-14 ·
      // PD-35). 엔진만 보고 갈아 끼우면 PD-14 사업이 광동체까지 끌고 가, 협동체용
      // 엔진을 단 광동체가 된다 — 평가는 그 엔진을 거부하므로 값은 폴백으로
      // 떨어지고 이름만 바뀐다.
      if (!to.segments.includes(p.segment)) continue;

      const im = localEngineImpact(s, p, from, to, liveYear, engineBefore);

      // 공급사 성능 패키지 카운터도 풀어야 새 공급사의 패키지를 받을 수 있다.
      p.enginePipGain = 0;

      // 이중화 기체는 서방 대안 인증을 함께 접는다. 안 그러면 국산 원가·국가
      // 발주 우대·공급 차질 면역을 받으면서 대안 공급사의 선호 가산(+2)까지
      // 챙기는, 양쪽을 다 갖는 구멍이 된다.
      if (p.altEngine) {
        dropped.push(p.name);
        p.altEngine = null;
        p.altEngineName = null;
        p.altMaker = null;
        p.dualSource = false;
      }

      p.unitCostBase = im.unitCostBase;
      p.listPrice = im.listPrice;
      p.efficiency = im.efficiency;
      p.comfort = im.comfort;
      p.defectRisk = im.defectRisk;
      if (im.exact) p.engineImmature = im.engineImmature;

      p.engine = to.id;
      // 엔진에서 나온 **표시용 캐시**도 함께 간다. 안 고치면 국산화한 Tu-204 가
      // 20년 뒤 회고에서까지 CFM56 을 달고 있는 것으로 남는다.
      p.engineName = to.name;
      p.engineMaker = to.maker;
      // 다음 세대가 "이 엔진을 언제 달았나"를 여기서 읽는다.
      p.engineTurn = s.turn + 1;

      // 개발비·개발기간·필요인력은 **일부러 그대로 둔다.** 엔진이 그 값들에도
      // 들어가지만, 이미 착수해 진행 중인 개발의 계약을 도중에 다시 쓰는 셈이고,
      // devCost 는 품질 투자·풍동·런치 에이드·서방 형식증명·국산화 비용의 기준이라
      // 지금 흔들면 이미 제시한 값들이 소급해서 바뀐다. 갈아 끼우는 것은 기체가
      // 앞으로 낼 성능과 원가이지, 이미 쓴 개발비가 아니다.

      // 이미 계약된 주문은 그 엔진을 보고 서명한 것이다. 주문마다 엔진 구성을
      // 따로 들고 다니게 하는 대신(생산·인도 회계를 통째로 갈라야 한다), 계약과
      // 다른 것을 받게 된 항공사의 관계를 깎는다 — 잔고가 두꺼울 때 갈아타는
      // 것이 실제로 비싸지도록.
      for (const o of s.backlog) {
        // 관계 점수는 **카탈로그에 있는 항공사**에만 있다. 정부·국영뿐 아니라
        // 리스사(lessor)·인수 승계(takeover) 같은 기관 계정도 잔고를 들 수 있는데,
        // 그쪽을 깎으면 아무도 안 읽는 유령 항목(s.relations.lessor)이 생기고
        // 로그만 "관계가 깎였다"고 말한다. 뺄 이름을 하나씩 세는 대신 있는 이름만
        // 받는다 — 새 기관 계정이 늘어도 새지 않는다.
        if (o.programId === p.id && o.remaining > 0 && RELATION_AIRLINES.has(o.airlineId)) {
          upset.add(o.airlineId);
        }
      }
      swapped.push(p.name);
    }
    // 계보 스냅숏의 엔진은 **원형 프로그램의 지금 엔진을 비춘다.** 갈아탄 기종만
    // 고쳐서는 모자란다 — 원형과 엔진이 달라 이번에 건너뛴 파생형의 계보도 원형이
    // 옮겨 간 만큼 낡는다. 한 규칙으로 전부 다시 맞춘다.
    for (const p of s.programs) {
      const d = p.derivedFrom;
      if (!d || !d.id) continue;
      const parent = s.programs.find((x) => x.id === d.id);
      if (parent && d.engine !== parent.engine) p.derivedFrom = { ...d, engine: parent.engine };
    }
    for (const aid of upset) {
      s.relations[aid] = clamp((s.relations[aid] ?? 40) - LOCAL_ENGINE_SWAP_RELATION, 0, 100);
    }
    // 옛 세이브의 진행 중 사업에는 세대 표시가 없다 — 대체 대상이 이미 국산이면
    // 그것이 곧 2세대다.
    const gen2 = (proj.gen || (from.domestic ? 2 : 1)) === 2;
    // engineRelations(공급사별 인도 실적)는 손대지 않는다. 이미 인도한 기체는
    // 실제로 그 공급사 엔진을 달고 나갔고, 그 이력까지 지우면 장부가 거짓이 된다.
    // 앞으로의 인도분이 UEC 쪽에 쌓이면서 자연히 무게중심이 옮겨 간다.
    pushLog(
      s,
      'good',
      swapped.length
        ? `${to.name} ${gen2 ? '개발' : '국산화'} 완료. ${swapped.join(' · ')}의 엔진이 ${from.name}에서 ${to.name}으로 바뀌었다 — ${
            gen2 ? '연비가 서방과 겨룰 자리로 올라왔다. 대신 대당 원가는 1세대만큼 싸지 않다' : '생산원가가 내려가고 공급이 우리 손에 들어왔다'
          }.${
            dropped.length ? ` ${dropped.join(' · ')}의 서방 대안 엔진 인증은 함께 접었다.` : ''
          }${
            upset.size ? ` 다만 ${from.name}으로 계약한 잔고가 남아 있어 ${upset.size}개 항공사의 관계가 깎였다.` : ''
          }`
        : `${to.name} 개발 완료. 갈아 끼울 기체는 없지만, 이제 설계에서 고를 수 있다.`,
    );
  }

  // ─────────────────── 서방 형식증명 (foreignBid.certification) ───────────────────
  //
  // "서방의 벽"은 평판으로 천천히 녹는다. 그건 회사 전체의 신뢰가 쌓이는 속도이지,
  // 특정 기체가 상대 당국의 서류를 통과했느냐와는 다른 문제다. SSJ-100 이 2012년에
  // EASA 형식증명을 받았을 때 달라진 것은 러시아 항공산업의 평판이 아니라 **그 기종
  // 하나의 자격**이었다.
  //
  // 그래서 이 경로는 기종 단위다: 돈과 분기를 내고, 그 기종에 한해 벽을 지운다.
  // 평판 경로와 병존한다 — 평판이 이미 높으면 살 것이 없고, 낮을수록 값을 한다.

  function foreignCertSpec(s) {
    const wall = companyTrait(s).foreignBid;
    return (wall && wall.certification) || null;
  }

  /** 이 기종이 낯선 시장에서 벽을 면제받는가. 입찰 점수(bidding)가 이 플래그를 본다. */
  function foreignCertified(p) {
    return !!(p && p.foreignCert && p.foreignCert.done);
  }

  function startForeignCert(s, programId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    ensureShape(s);
    const spec = foreignCertSpec(s);
    if (!spec) return { ok: false, error: '이 회사는 서방 형식증명을 따로 받을 것이 없습니다.' };
    const p = s.programs.find((x) => x.id === programId);
    if (!p) return { ok: false, error: '없는 프로그램입니다.' };
    // 상대 당국은 도면이 아니라 시험 결과를 본다 — 우리 형식증명 심사에 들어간 뒤부터다.
    if (p.phase !== 'cert' && p.phase !== 'production') {
      return { ok: false, error: '형식증명 심사에 들어간 뒤에야 신청할 수 있습니다.' };
    }
    if (p.foreignCert) {
      return { ok: false, error: p.foreignCert.done ? '이미 서방 형식증명을 받았습니다.' : '이미 심사를 진행 중입니다.' };
    }
    const cost = Math.round(p.devCost * spec.costRate);
    if (s.cash < cost) return { ok: false, error: `서방 형식증명 비용 ${fmtMoney(cost)}이 부족합니다.` };
    s.cash -= cost;
    s.pending.rdCost += cost;
    p.spent += cost;
    p.foreignCert = { left: spec.quarters, done: false, spent: cost };
    pushLog(
      s,
      'program',
      `${p.name} 서방 형식증명 심사에 착수했다 (${fmtMoney(cost)}). ${spec.quarters}분기 뒤 북미·서유럽 항공사 앞에서 낯선 제조사가 아니게 된다.`,
    );
    return { ok: true, cost };
  }

  /**
   * 서방 형식증명 심사 진행. 매 분기 정산에서 부른다.
   *
   * 상대 당국의 지적은 분기가 아니라 **설계 수정**으로 값을 치른다 — 심사가 한 분기
   * 늘고 비용이 조금 더 든다. 지적이 매 분기 날 수 있으면 심사가 끝나지 않으므로
   * 한 번만 뽑는다(절반 지점). 난수는 본류라 시드 재현이 유지된다.
   */
  function tickForeignCert(s, rng, report) {
    const spec = foreignCertSpec(s);
    if (!spec) return;
    for (const p of s.programs) {
      const fc = p.foreignCert;
      if (!fc || fc.done) continue;
      // 중단·매각된 기종의 심사는 함께 죽는다 — 없는 기체에 증명이 날 수 없다.
      if (p.phase === 'cancelled' || p.phase === 'sold') {
        p.foreignCert = null;
        continue;
      }
      if (!fc.audited && fc.left <= Math.ceil(spec.quarters / 2)) {
        fc.audited = true;
        if (rng && rng.chance(spec.findingChance ?? 0)) {
          const extra = Math.round(p.devCost * spec.costRate * 0.35);
          fc.left += 1;
          fc.spent += extra;
          s.cash -= extra;
          if (report) report.rdCost += extra;
          else s.pending.rdCost += extra;
          p.spent += extra;
          pushLog(
            s,
            'bad',
            `${p.name} 서방 형식증명 심사에서 지적이 나왔다. 설계 수정에 ${fmtMoney(extra)}, 심사가 한 분기 늘었다.`,
          );
        }
      }
      fc.left -= 1;
      if (fc.left <= 0) {
        fc.done = true;
        fc.left = 0;
        pushLog(
          s,
          'good',
          `${p.name} 서방 형식증명 취득. 북미·서유럽 항공사 수주전에서 더 이상 낯선 제조사의 감점을 받지 않는다.`,
        );
      }
    }
  }

  /**
   * 취항 후 운항 실적으로 ETOPS 를 따는 경로. 매 분기 정산에서 부른다.
   *
   * 양산 단계라는 것만으로는 안 된다 — 규제 당국이 보는 건 **실제로 굴러다닌 기록**이다.
   * 기체가 한 대도 없는 기종이 네 분기를 세는 건 실적이 아니라 달력이다.
   *
   * 재고도 실적으로 친다: 인도분만 세면 백로그가 전부 ETOPS 필수 주문인 기종이
   * 영구 교착에 빠진다 — 인도 게이트(runDeliveries)가 인도를 막고, 인도가 없어
   * 실적이 안 쌓이고, 실적이 없어 게이트가 안 열린다. 완성돼 놀고 있는 기체로
   * 노선 실증을 도는 건 실제 관행이기도 하다(787 route proving).
   */
  function tickEtopsService(s) {
    for (const p of s.programs) {
      if (p.phase !== 'production' || !p.etops || p.etopsCertified) continue;
      if (!(p.delivered > 0 || p.stock > 0)) continue;
      // 운항 정지 중에는 실적이 쌓이지 않는다 — 한 대도 못 뜨는 분기를
      // 실적으로 세면 결함으로 세워 둔 기간이 인증 심사에 그대로 들어간다.
      if ((s.effects.grounded[p.id] || 0) > 0) continue;
      p.etopsService = (p.etopsService || 0) + 1;
      if (p.etopsService >= ETOPS_SERVICE_QUARTERS) {
        p.etopsCertified = true;
        pushLog(s, 'good', `${p.name} 운항 실적 ${p.etopsService}분기를 채워 ETOPS 인증을 받았다. 대양 노선에 응찰할 수 있다.`);
      }
    }
  }

  /** 설계 동결 — 시험비행 단계로 넘어간다. */
  function enterCertification(s, p, report, rng) {
    // 설계 동결 — 종이 위의 결함 위험이 실기로 확정되는 순간. 풍동을 산 팀은
    // 주사위가 작다. 여기서 뽑는 난수는 본류 rng 라 시드 재현이 유지된다.
    if (rng) {
      const u = p.windTunnel ? RISK_UNCERTAINTY_TUNNEL : RISK_UNCERTAINTY_BASE;
      const draw = (rng.next() * 2 - 1) * u;
      const before = p.defectRisk;
      p.defectRisk = Math.round(clamp(before * (1 + draw), 0.02, CONFIG.defectRiskMax) * 1000) / 1000;
      if (p.defectRisk > before + 0.005) {
        pushLog(s, 'bad', `${p.name} 실기 구조 시험 — 종이보다 나쁘다. 결함 위험 ${(before * 100).toFixed(1)}% → ${(p.defectRisk * 100).toFixed(1)}%.`);
      } else if (p.defectRisk < before - 0.005) {
        pushLog(s, 'good', `${p.name} 실기 구조 시험 — 추정보다 깨끗하다. 결함 위험 ${(before * 100).toFixed(1)}% → ${(p.defectRisk * 100).toFixed(1)}%.`);
      }
    }
    p.phase = 'cert';
    p.testHours = 0;
    p.testHoursNeeded = Math.round(p.certQuarters * DEFAULT_TEST_FLEET * TEST_HOURS_PER_QUARTER);
    p.testFleet = 0;
    p.testSpent = 0;
    // 기본 편대는 자동으로 띄운다. 시험기 0대면 인증이 영원히 안 끝나므로,
    // "아무것도 안 하면 멈춘다"가 아니라 "더 넣으면 빨라진다"가 되게 한다.
    for (let i = 0; i < DEFAULT_TEST_FLEET; i++) {
      const cost = testAircraftCost(s, p);
      s.cash -= cost;
      // 이 경로는 endTurn 정산 중(리포트를 이미 만든 뒤)에 돌기 때문에 pending 에 적으면
      // 현금은 이번 분기에 나가고 비용은 다음 분기 장부에 실린다. 파산하면 그 다음
      // 분기가 아예 없어 비용이 통째로 사라지기도 한다. 리포트에 직접 단다.
      if (report) report.rdCost += cost;
      else s.pending.rdCost += cost;
      p.spent += cost;
      p.testSpent += cost;
      p.testFleet++;
    }
    pushLog(
      s,
      'program',
      `${p.name} 설계 동결 및 초도 비행 성공. 시험기 ${p.testFleet}대로 형식증명 심사에 들어간다 — ` +
        `${num(p.testHoursNeeded)}시간 필요, 지금 속도로 ${certQuartersLeft(p)}분기.`,
    );
  }

  function num(n) {
    return Math.round(n).toLocaleString('ko-KR');
  }

  function advanceDevelopment(s, rng, report) {
    // 이번 분기 시작 시점에 이미 인증 심사 중이던 프로그램 (아래 카운트다운 대상).
    const certifyingBefore = s.programs.filter((p) => p.phase === 'cert');

    // 인력 배분 0% = 프로그램 동결. 진행도 그대로 멈추고 개발비도 나가지 않는다.
    // 현금이 마를 때 개발을 갈아엎지 않고 버티는 유일한 탈출구다.
    const active = s.programs.filter((p) => p.phase === 'dev' && p.share > 0);
    const totalShare = active.reduce((a, p) => a + p.share, 0);

    for (const p of active) {
      const allocated = s.engineers * (p.share / totalShare);
      const ratio = allocated / p.engineersNeeded;
      const effective = Math.min(1.4, ratio);
      const gain = (100 / p.devQuarters) * effective;

      // 인력을 과도하게 밀어넣으면 설계 검증이 얕아진다.
      if (ratio > 1.25 && rng.chance(0.35)) {
        // 상한이 0.6 이면 엔진 배수까지 붙어 0.6을 넘긴 설계에서는 이 "악재"가
        // 오히려 위험을 낮춘다. 페널티는 절대 현재 위험보다 낮아질 수 없다.
        p.defectRisk =
          Math.round(Math.max(p.defectRisk, Math.min(CONFIG.defectRiskMax, p.defectRisk * 1.08)) * 1000) / 1000;
      }

      const before = p.progress;
      p.progress = Math.min(100, p.progress + gain);
      if (p.progress > before) p.lastProgressTurn = s.turn;
      // 착수금으로 이미 낸 몫을 빼고 남은 개발비만 진행도에 비례해 집행한다.
      // (전액을 다시 배분하면 실제 지출이 표시된 총 개발비의 108%가 된다.)
      const spend = p.devCost * (1 - CONFIG.launchUpfrontRate) * ((p.progress - before) / 100);
      p.spent += spend;
      s.cash -= spend;
      report.rdCost += spend;

      if (p.progress >= 100) enterCertification(s, p, report, rng);
    }

    // 개발 루프에서 방금 cert로 전환된 프로그램은 제외한다. 포함하면 개발에 그 분기를
    // 다 쓰고도 인증 1분기가 함께 지나가, 3분기짜리 인증이 실제로는 2분기에 끝난다.
    for (const p of certifyingBefore) {
      // 인증 지연 — 결함 위험이 높은 설계(고기술·복합재·미성숙 엔진)일수록 심사에서
      // 제동이 걸린다. 품질 투자는 이 확률을 함께 낮춘다.
      // 이 판정이 없으면 기술 슬라이더는 "비싸지만 확정된 이득"이라 도박이 아니게 된다.
      if (rng.chance(clamp(p.defectRisk * 0.26, 0.01, 0.12))) {
        // 지적은 시간으로 값을 치른다 — 기본 편대 기준 1~2분기어치의 재시험이다.
        // 시험기를 더 띄워 둔 팀은 그만큼 빨리 만회한다.
        const delay = rng.int(1, 2);
        const addedHours = Math.round(delay * DEFAULT_TEST_FLEET * TEST_HOURS_PER_QUARTER);
        const cost = Math.round(p.devCost * 0.03 * delay);
        p.testHoursNeeded += addedHours;
        p.findings = (p.findings || 0) + 1;
        p.spent += cost;
        s.cash -= cost;
        report.rdCost += cost;
        pushLog(
          s,
          'bad',
          `${p.name} 형식증명 심사에서 설계 변경 요구가 나왔다. 재시험 ${num(addedHours)}시간, 대응 비용 ${fmtMoney(cost)}.`,
        );
      }

      p.testHours = (p.testHours || 0) + testHoursPerQuarter(p);
      if (testHoursPerQuarter(p) > 0) p.lastProgressTurn = s.turn;
      p.certRemaining = certQuartersLeft(p);
      if (p.testHours >= p.testHoursNeeded) {
        p.phase = 'production';
        p.certTurn = s.turn;
        p.certRemaining = 0;
        // 조기 취득을 산 기종만 취항과 동시에 대양 노선에 들어간다.
        // 나머지는 운항 실적을 채워야 한다.
        p.etopsCertified = !!(p.etops && p.etopsEarly);
        p.etopsService = 0;
        adjustReputation(s, 5);
        // 시험기는 개수해 헐값에 넘긴다. 실제로도 시험기는 정상가로 안 팔린다.
        const salvage = Math.round((p.testSpent || 0) * TEST_AIRCRAFT_SALVAGE);
        if (salvage > 0) {
          s.cash += salvage;
          report.revenue += salvage;
        }
        if (!p.legacy) {
          const gained = (EXPERIENCE_POINTS[p.segment] || 1) * (p.derivedFrom ? 0.5 : 1);
          pushLog(
            s,
            'program',
            `${p.name}을 끝까지 만들어 본 경험이 조직에 남았다 (+${gained}). 다음 신규 설계의 기간과 필요 인력이 줄어든다.`,
          );
        }
        pushLog(
          s,
          'good',
          `${p.name} 형식증명 취득! 시험비행 ${num(p.testHours)}시간` +
            `${p.findings ? ` · 심사 지적 ${p.findings}건` : ''}. 시험기 ${p.testFleet}대를 개수해 ${fmtMoney(salvage)}을 회수했다. ` +
            `(정가 ${fmtMoney(p.listPrice)}, 연비지수 ${p.efficiency})` +
            (p.etops
              ? p.etopsCertified
                ? ' ETOPS 조기 취득 완료 — 대양 노선에 바로 들어간다.'
                : ` ETOPS 는 운항 실적 ${ETOPS_SERVICE_QUARTERS}분기를 채워야 나온다.`
              : ''),
        );
      }
    }
  }

  function runProduction(s, report) {
    const sourcing = OUTSOURCING[s.outsourcing] || OUTSOURCING.mid;
    let mult = 1;
    if (s.effects.strikeQuarters > 0) mult *= 0.5;
    if (s.effects.supplyQuarters > 0) mult *= 0.75;

    // 기종별 미인도 주문 잔량. 라인은 이 범위 + 소량의 선행 생산까지만 만든다.
    // (이 상한이 없으면 주문이 없어도 계속 찍어내 화이트테일이 무한히 쌓인다.)
    const ordered = {};
    for (const o of s.backlog) {
      if (o.remaining > 0) ordered[o.programId] = (ordered[o.programId] || 0) + o.remaining;
    }

    for (const line of s.lines) {
      const p = s.programs.find((x) => x.id === line.programId);
      if (!p || p.phase !== 'production' || line.idle) continue;

      // 엔진 공급 차질 — 그 공급사 엔진을 다는 라인만 멈칫한다.
      const short = s.effects.engineShortage;
      // 이중화 기체는 대안 공급사 라인으로 구멍의 절반을 메운다 — 두 번 인증한 값.
      const pMult =
        short && short.quarters > 0 && (root.AirlinerEngines.get(p.engine) || {}).maker === short.maker
          ? p.altEngine
            ? 0.75
            : 0.5
          : 1;

      // 미인도 주문에서 이미 쌓아둔 재고를 뺀 만큼만 만든다. p.stock이 갱신되므로
      // 같은 기종에 라인이 여러 개여도 자연히 나눠 갖는다.
      // 주문을 넘어선 선행 생산은 허용하지 않는다 — 여유분을 두면 재고를 처분할 때마다
      // 그만큼이 매 분기 재생성돼, 원가보다 비싼 처분가로 무한히 현금을 찍을 수 있다.
      const headroom = (ordered[p.id] || 0) - p.stock;
      if (headroom <= 0) {
        // 만들 게 없으면 라인이 식는다 — 재가동 시 램프업을 다시 올려야 한다.
        line.ramp = Math.max(0.15, line.ramp - CONFIG.rampPerQuarter * 0.5);
        line.partial = 0;
        continue;
      }

      // 자동화 라인은 물량이 크지만 안정화가 느리다 — 수요가 확실할 때만 값을 한다.
      const grade = LINE_GRADES[line.grade] || LINE_GRADES.standard;
      line.ramp = Math.min(1, line.ramp + CONFIG.rampPerQuarter * grade.rampMult * (researchDone(s, 'lean') ? LEAN_RAMP_MULT : 1));
      const raw = line.capacity * line.ramp * mult * pMult + line.partial;
      let units = Math.floor(raw);
      line.partial = raw - units;
      if (units > headroom) {
        units = headroom;
        line.partial = 0;
      }
      if (units <= 0) continue;

      let cost = 0;
      for (let i = 0; i < units; i++) {
        p.produced++;
        cost += unitCostAt(p.unitCostBase, p.produced, unitPremium(s)) * sourcing.costMult;
      }
      s.cash -= cost;
      report.productionCost += cost;
      p.stock += units;
    }
  }

  function runDeliveries(s, report) {
    // 약속한 주문을 먼저 인도한다. 같은 우선순위면 오래된 수주부터.
    // 우선 인도는 공짜가 아니다 — 다른 주문을 뒤로 밀어 그쪽 약속을 깨뜨린다.
    const orders = s.backlog
      .filter((o) => o.remaining > 0)
      .sort((a, b) => pledgeOf(b).priority - pledgeOf(a).priority || a.wonTurn - b.wonTurn);
    for (const o of orders) {
      const p = s.programs.find((x) => x.id === o.programId);
      if (!p || p.stock <= 0) continue;
      // 형식증명 없는 기체는 어떤 경로로 재고가 생겼든 인도할 수 없다 — 시뮬레이션의
      // 불변식이다. 특별 근무 같은 사건이 미인증 기종을 뽑는 걸 막더라도, 여기서
      // 한 번 더 지키지 않으면 새 재고 경로가 생길 때마다 같은 구멍이 다시 열린다.
      if (p.phase !== 'production') continue;
      if ((s.effects.grounded[p.id] || 0) > 0) continue;
      // 대양 노선 주문은 ETOPS 인증이 나와야 인도된다. 조기 취득을 건너뛰었으면
      // 운항 실적 4분기 동안 이 주문들이 기다린다 — 조기 인도 약속을 걸어 뒀다면
      // 그 지연의 위약금이 정확히 "1년을 기다리는" 선택의 값이다.
      if (o.reqEtops && !p.etopsCertified && p.engines !== 4) continue;

      const n = Math.min(o.remaining, p.stock);
      // 선수금을 이미 받은 만큼을 뺀 잔금이 인도 대금이다.
      const balance = n * o.unitPrice * (1 - (typeof o.depositRate === 'number' ? o.depositRate : CONFIG.depositRate));
      const financing = BID_FINANCING[o.financing] || BID_FINANCING.normal;
      const now = balance * financing.onDelivery;
      const later = balance - now;
      // 정부 지원금 로열티 — 성공한 기체가 갚는다. 인도 대금에서 원천 공제된다.
      let royalty = 0;
      if (p.launchAid) {
        const cap = Math.round(p.launchAid.amount * LAUNCH_AID_PAYBACK) - p.launchAid.repaid;
        if (cap > 0) {
          royalty = Math.min(cap, Math.round(n * o.unitPrice * LAUNCH_AID_ROYALTY));
          p.launchAid.repaid += royalty;
          if (p.launchAid.repaid >= Math.round(p.launchAid.amount * LAUNCH_AID_PAYBACK)) {
            pushLog(s, 'good', `${p.name} 정부 지원금 상환 완료 — 이제 인도 대금이 온전히 우리 몫이다.`);
          }
        }
      }
      // 보복 관세 — 판정이 살아 있는 동안 상대 앞마당(북미·서유럽) 인도에 붙는다.
      let duty = 0;
      if ((s.effects.tradeTariffQuarters || 0) > 0) {
        const home = (AIRLINES.find((a) => a.id === o.airlineId) || {}).home;
        if (home === '북미' || home === '서유럽') duty = Math.round(n * o.unitPrice * TRADE_TARIFF_RATE);
      }
      const revenue = now - royalty - duty;
      const progBefore = p.delivered;
      const companyBefore = s.stats.delivered;
      o.remaining -= n;
      p.stock -= n;
      p.delivered += n;
      addToFleet(s, o.airlineId, p.id, n);
      // 자체 항공사로 나간 기체는 리포트에 따로 적는다. 껍데기가 이 목록을 보고
      // 항공사 계층에 실제 기재를 세운다 — 엔진은 항공사 계층을 알지 못한다.
      if (o.inHouse) {
        // 자기 자회사에 넘긴 대수는 시장에서 이긴 것이 아니다. 세면 자기한테 팔아
        // 점유율과 인도 점수를 만들 수 있다(통합 모드의 `operatingScore` 가 뺀다).
        //
        // **프로그램별로도 센다.** 인도 점수는 급별 가중(리저널 0.7 · 협동체 1.2 ·
        // 광동체 3.2)이라, 총계만 두고 협동체로 가정해 빼면 광동체를 자회사에 넘길수록
        // 덜 빼진다 — 가중이 큰 급일수록 자기한테 파는 값이 커진다.
        s.stats.inHouseDelivered = (s.stats.inHouseDelivered || 0) + n;
        p.inHouseDelivered = (p.inHouseDelivered || 0) + n;
        if (!report.inHouse) report.inHouse = [];
        // 항공사가 낼 잔금은 **총액 기준**이다 — 금융 조건·로열티·관세는 제조사 쪽
        // 사정이지 계열 항공사가 치르는 값이 아니다. 착수금과 합해 정가가 된다.
        const rate = typeof o.depositRate === 'number' ? o.depositRate : CONFIG.depositRate;
        report.inHouse.push({
          airlineId: o.airlineId,
          programId: p.id,
          qty: n,
          unitPrice: o.unitPrice,
          balance: n * o.unitPrice * (1 - rate),
        });
      }
      recordDeliveryMilestones(s, p, o, progBefore, companyBefore);
      // 엔진 공급사 관계 — 그 공급사 엔진을 단 인도가 쌓일수록 협상 테이블이 생긴다.
      // 이중화 기체는 항공사가 선호하는 쪽 엔진을 달아 나간다 — A330 이 그랬다.
      const primMaker = (root.AirlinerEngines.get(p.engine) || {}).maker;
      const altM = p.altEngine ? (root.AirlinerEngines.get(p.altEngine) || {}).maker : null;
      const wantPref = (AIRLINES.find((a) => a.id === o.airlineId) || {}).enginePref;
      const engMaker = altM && wantPref === altM ? altM : primMaker;
      if (engMaker) s.engineRelations[engMaker] = (s.engineRelations[engMaker] || 0) + n;
      // 독점 계약 리베이트 — 계약 공급사 엔진 인도분은 부품값 일부를 돌려받는다.
      if (engMaker && s.engineDeal && s.turn < s.engineDeal.until && s.engineDeal.maker === engMaker) {
        const rebate = Math.round(n * p.unitCostBase * ENGINE_DEAL_REBATE);
        s.cash += rebate;
        s.stats.revenue += rebate;
        report.revenue += rebate;
      }
      s.cash += revenue;
      s.stats.delivered += n;
      s.stats.revenue += revenue;
      report.revenue += revenue;
      report.delivered += n;

      // 자체 금융분은 지금 못 받는다. 이자를 얹어 분기마다 나눠 받는다.
      if (later > 0 && financing.quarters > 0) {
        const perQuarter = (later * (1 + financing.interest)) / financing.quarters;
        for (let q = 1; q <= financing.quarters; q++) {
          s.receivables.push({
            turn: s.turn + q,
            amount: Math.round(perQuarter),
            airlineName: o.airlineName,
          });
        }
      }

      if (o.remaining === 0) {
        adjustReputation(s, 1);
        // 취소분을 빼야 실제 인도량이다. o.qty 를 쓰면 10기 중 5기가 취소되고 5기만
        // 인도돼도 "10기 인도 완료"로 기록돼 경영 기록이 실적과 어긋난다.
        const shipped = o.qty - (o.cancelled || 0);
        pushLog(s, 'good', `${o.airlineName} ${o.programName} ${shipped}기 인도 완료. 잔금 정산.`);
      }
    }
  }

  // ─────────────────────────────── 마일스톤 ───────────────────────────────

  /**
   * 이 회사가 남긴 순간들. 숫자는 흘러가지만 1호기 인도식과 100호기 라인오프는
   * 실제 제조사가 사진으로 남기는 날이다 — 게임에도 그 날이 있어야 20년이
   * 손익 곡선이 아니라 역사가 된다. 종료 회고의 연표가 여기서 나온다.
   * 보상은 소폭 평판뿐이다: 축하는 축하지, 또 하나의 최적화 대상이 아니다.
   */
  const PROGRAM_MILESTONES = [
    { at: 100, rep: 1 },
    { at: 300, rep: 1 },
    { at: 500, rep: 2 },
  ];
  const COMPANY_MILESTONES = [
    { at: 500, rep: 1 },
    { at: 1000, rep: 2 },
    { at: 1500, rep: 2 },
  ];

  function addMilestone(s, text, rep) {
    if (!Array.isArray(s.milestones)) s.milestones = [];
    s.milestones.push({ turn: s.turn, label: turnLabel(s.turn), text });
    pushLog(s, 'good', text);
    if (rep) adjustReputation(s, rep);
  }

  function recordDeliveryMilestones(s, p, o, progBefore, companyBefore) {
    const n = p.delivered - progBefore;
    if (n <= 0) return;
    if (!p.legacy) {
      if (progBefore === 0) {
        addMilestone(
          s,
          o.disposal
            ? `${p.name} 1호기가 리스사 주기장으로 — 화려하진 않아도 데뷔는 데뷔다.`
            : `${p.name} 1호기 인도식 — ${o.airlineName}이 런치 커스터머로 이름을 남겼다.`,
          1,
        );
      }
      // 첫 광동체는 "1호기"가 아니라 "첫 항공사 인도"의 순간이다. 처분이 이 순간을
      // 소모하면 안 되고(리스사 주기장행은 대양 노선이 아니다), 처분으로 1호기가
      // 먼저 나갔더라도 진짜 첫 고객 인도가 오면 그때 축하해야 한다 — 그래서
      // progBefore 가 아니라 firstWideDone 깃발로 따로 센다.
      if (p.segment === 'wide' && !s.stats.firstWideDone && !o.disposal) {
        s.stats.firstWideDone = true;
        addMilestone(s, `회사 역사상 첫 광동체 인도 — ${p.name}이 대양 노선에 선다.`, 2);
      }
      for (const m of PROGRAM_MILESTONES) {
        if (progBefore < m.at && p.delivered >= m.at) {
          addMilestone(s, `${p.name} ${m.at}호기 라인오프 — 공장 앞마당에서 기념식이 열렸다.`, m.rep);
        }
      }
    }
    const companyAfter = companyBefore + n;
    for (const m of COMPANY_MILESTONES) {
      if (companyBefore < m.at && companyAfter >= m.at) {
        addMilestone(s, `누적 인도 ${num(m.at)}기 — 회사의 이름이 업계 연감 한 줄에서 한 장이 됐다.`, m.rep);
      }
    }
  }

  /**
   * 그 기종이 **이번 분기에 실제로 뽑을 수 있는** 대수.
   *
   * 라인의 명목 최대치를 그대로 보여 주면, 램프업 15%짜리 새 라인이나 파업 중인
   * 라인도 만개로 보인다 — 지킬 수 없는 인도 약속을 초록불로 안내하는 셈이다.
   * runProduction 과 같은 계수를 쓴다.
   */
  function effectiveOutput(s, programId) {
    let mult = 1;
    if (s.effects.strikeQuarters > 0) mult *= 0.5;
    if (s.effects.supplyQuarters > 0) mult *= 0.75;
    if ((s.effects.grounded[programId] || 0) > 0) return 0;
    return s.lines
      .filter((l) => l.programId === programId && !l.idle)
      .reduce((a, l) => a + Math.floor(l.capacity * (typeof l.ramp === 'number' ? l.ramp : 1) * mult), 0);
  }

  function pledgeOf(order) {
    return BID_PLEDGES[order && order.pledge] || BID_PLEDGES.standard;
  }

  /**
   * 약속한 기한을 넘긴 주문의 위약금 — **밀린 분기마다** 문다.
   *
   * 한 번만 물리면 지키지 못할 약속이 여전히 남는 장사가 된다(측정: 위약금 181건을
   * 물고도 20판 중 16판이 S). 실제 지연 배상금도 기간에 비례한다. 계속 못 넘기면
   * 계속 나가므로, 라인 여력 없이 최우선 인도를 약속하는 것이 진짜 손해가 된다.
   */
  function chargeLatePenalties(s, report) {
    for (const o of s.backlog) {
      if (o.remaining <= 0) continue;
      const pledge = pledgeOf(o);
      if (!pledge.penaltyRate || typeof o.dueTurn !== 'number' || s.turn < o.dueTurn) continue;
      if (o.lastPenaltyTurn === s.turn) continue;

      const penalty = Math.round(o.remaining * o.unitPrice * pledge.penaltyRate);
      const first = o.lastPenaltyTurn === undefined;
      o.lastPenaltyTurn = s.turn;
      s.cash -= penalty;
      // 이 분기 리포트에만 적는다. pending 에도 넣으면 다음 분기 장부가 현금 이동
      // 없이 같은 위약금을 한 번 더 세어 손익과 신용등급이 어긋난다.
      report.overhead += penalty;
      s.relations[o.airlineId] = clamp((s.relations[o.airlineId] ?? 40) - 3, 0, 100);
      adjustReputation(s, -1);
      pushLog(
        s,
        'bad',
        first
          ? `${o.airlineName}과의 ${pledge.name}을 지키지 못했다. 미인도 ${o.remaining}기에 위약금 ${fmtMoney(penalty)}. 넘길 때까지 분기마다 물어야 한다.`
          : `${o.airlineName} 인도 지연이 이어진다. 이번 분기 위약금 ${fmtMoney(penalty)} (미인도 ${o.remaining}기).`,
      );
    }
  }

  /**
   * 이번 분기에 들어올 자체 금융 회수분.
   *
   * 불황에는 못 받는다 — 자체 금융의 진짜 위험은 이자가 아니라 **고객의 지불 능력**이다.
   * 호황에 공짜로 얻는 점수가 침체에서 값을 치르게 하는 지점이고, 실제로 제조사
   * 금융이 제조사를 무너뜨린 방식이기도 하다.
   */
  function collectReceivables(s, report, rng) {
    const due = (s.receivables || []).filter((r) => r.turn <= s.turn);
    if (!due.length) return;
    s.receivables = s.receivables.filter((r) => r.turn > s.turn);

    const slump = s.effects.demandSlumpQuarters > 0;
    let total = 0;
    let written = 0;
    for (const r of due) {
      if (slump && rng.chance(0.16)) {
        written += r.amount;
        continue;
      }
      total += r.amount;
    }
    if (total > 0) {
      s.cash += total;
      s.stats.revenue += total;
      report.revenue += total;
      pushLog(s, 'info', `자체 금융 대금 ${fmtMoney(total)}을 회수했다.`);
    }
    if (written > 0) {
      // 상각분은 애초에 현금으로도 매출로도 잡지 않는다 — 못 받은 돈이 비용으로
      // 한 번 더 빠지면 같은 손실을 두 번 세게 된다.
      adjustReputation(s, -1);
      pushLog(s, 'bad', `불황으로 항공사들이 대금을 치르지 못했다. 자체 금융 ${fmtMoney(written)}을 상각한다.`);
    }
  }

  function settleFinance(s, report) {
    // 화면에 고지한 값을 그대로 청구한다. 정산 시점에 다시 계산하면 그 분기의
    // 생산·인도로 등급이 바뀌어, 플레이어가 보고 판단한 이자와 실제가 달라진다.
    const rate = typeof s.rateForQuarter === 'number' ? s.rateForQuarter : interestRate(s);
    const interest = s.debt * rate;
    s.rating = creditRating(s).grade;
    report.rate = Math.round(rate * 10000) / 100;
    const overhead =
      CONFIG.fixedOverheadPerQuarter * (s.overheadMult || 1) +
      s.lines.reduce((a, l) => a + CONFIG.lineOverheadPerLine * ((LINE_GRADES[l.grade] || LINE_GRADES.standard).overhead), 0) +
      s.engineers * CONFIG.engineerCostPerQuarter +
      s.programs.reduce((a, p) => a + p.stock * p.unitCostBase * CONFIG.inventoryHoldingCost, 0);

    s.cash -= interest + overhead;
    report.interest += interest;
    report.overhead += overhead;

    // 현금이 마르면 한도까지 자동 차입 — 파산은 한도까지 쓴 뒤에 온다.
    if (s.cash < 0) {
      const need = Math.ceil(-s.cash);
      const room = CONFIG.maxDebt - s.debt;
      const take = Math.min(need, room);
      if (take > 0) {
        s.debt += take;
        s.cash += take;
        markDebtPeak(s);
        pushLog(s, 'bad', `운전자금 부족으로 ${fmtMoney(take)} 긴급 차입. 총 부채 ${fmtMoney(s.debt)}.`);
      }
    }
  }

  /**
   * 종료 분기를 재무 행으로 남긴다.
   * 이벤트로 파산하면 이 pending 을 흡수할 다음 분기가 오지 않는데, 직전 분기 행에
   * 접붙이면 2014년 1분기 결함 비용이 2013년 4분기 실적으로 기록되고 종료 화면의
   * 분기와도 어긋난다. 발생 분기에 별도 행을 만들어 장부와 표시를 일치시킨다.
   */
  function flushTerminalQuarter(s) {
    const p = s.pending;
    if (!p) return;
    const revenue = p.revenue;
    const cost = p.rdCost + p.capex + p.overhead + (p.productionCost || 0);
    s.history.push({
      turn: s.turn,
      label: turnLabel(s.turn),
      cash: Math.round(s.cash),
      debt: Math.round(s.debt),
      revenue: Math.round(revenue),
      cost: Math.round(cost),
      net: Math.round(revenue - cost),
      delivered: p.delivered,
      // 총비용에는 넣으면서 rd 를 안 적으면, 개조 개발비가 회사를 무너뜨린 바로
      // 그 분기의 R&D 가 경력 보고서 총계에서 빠진다.
      rd: Math.round(p.rdCost),
      backlog: totalBacklog(s),
      reputation: Math.round(s.reputation),
      worth: Math.round(netWorth(s)),
      share: Math.round(marketShare(s) * 10000) / 10000,
      ordersWon: 0,
      fuel: Math.round(s.market.fuelIndex * 1000) / 1000,
      demand: Math.round(s.market.demandIndex * 1000) / 1000,
    });
    if (s.history.length > 120) s.history.shift();
    s.pending = { revenue: 0, delivered: 0, rdCost: 0, capex: 0, overhead: 0, ordersWon: 0, productionCost: 0 };
  }

  /**
   * 종료 정산이 만든 현금 이동을 마지막 분기 행에 합친다.
   *
   * 새 행으로 남기면 경영하지 않은 분기(81번째)가 재무표와 곡선에 생긴다. 마지막
   * 분기의 손익에 얹는 편이 "그 분기에 정산됐다"는 사실과도 맞다.
   */
  function foldPendingIntoLastRow(s) {
    const p = s.pending;
    if (!p) return;
    const row = s.history[s.history.length - 1];
    if (!row) {
      flushTerminalQuarter(s);
      return;
    }
    row.revenue += Math.round(p.revenue);
    row.cost += Math.round(p.rdCost + p.capex + p.overhead + (p.productionCost || 0));
    row.net = row.revenue - row.cost;
    row.cash = Math.round(s.cash);
    row.debt = Math.round(s.debt);
    row.worth = Math.round(netWorth(s));
    row.share = Math.round(marketShare(s) * 10000) / 10000;
    row.reputation = Math.round(s.reputation);
    // 종료 정산이 주문을 파기했을 수 있다. 마지막 행이 정산 전 백로그를 물고
    // 있으면 종료 화면이 이미 사라진 기체를 계속 보여 준다.
    row.backlog = totalBacklog(s);
    s.pending = { revenue: 0, delivered: 0, rdCost: 0, capex: 0, overhead: 0, ordersWon: 0, productionCost: 0 };
  }

  /**
   * 금리 보정의 남은 기간. 방금 확정한 s.rateForQuarter 가 그 보정을 한 번 쓴 것이므로,
   * 확정 직후에 부른다. 다른 효과처럼 tickEffects 에서 깎으면 안 된다 — 그쪽은
   * 플레이어 행동으로 걸린 보정이 첫 적용 전에 한 분기를 잃는다.
   */
  function tickRateEffects(s) {
    const e = s.effects;
    if (e.rateCutQuarters > 0) {
      e.rateCutQuarters--;
      if (e.rateCutQuarters === 0) e.rateCut = 0;
    }
    if (e.rateBumpQuarters > 0) {
      e.rateBumpQuarters--;
      // 기간이 끝나면 가산폭도 함께 지운다. 남겨두면 나중에 약한 경색이
      // 재발할 때 max() 병합이 만료된 높은 값을 되살린다.
      if (e.rateBumpQuarters === 0) e.rateBump = 0;
    }
  }

  function tickEffects(s) {
    const e = s.effects;
    if (e.strikeQuarters > 0) e.strikeQuarters--;
    if (e.supplyQuarters > 0) e.supplyQuarters--;
    if (e.tradeTariffQuarters > 0) {
      e.tradeTariffQuarters--;
      if (e.tradeTariffQuarters === 0) pushLog(s, 'good', '보복 관세가 만료됐다. 북미·서유럽 인도가 다시 제값을 받는다.');
    }
    if (e.engineShortage && e.engineShortage.quarters > 0) {
      e.engineShortage.quarters--;
      if (e.engineShortage.quarters === 0) {
        pushLog(s, 'good', `${e.engineShortage.maker} 엔진 공급이 정상화됐다. 라인이 다시 돈다.`);
        e.engineShortage = null;
      }
    }
    // 독점 공급 계약 만료 — 리베이트도, 타사 엔진 할증도 함께 끝난다.
    if (s.engineDeal && s.turn >= s.engineDeal.until) {
      pushLog(s, 'event', `${s.engineDeal.maker} 독점 공급 계약이 만료됐다. 다음 설계는 어느 엔진이든 자유다.`);
      s.engineDeal = null;
    }
    if (e.demandSlumpQuarters > 0) e.demandSlumpQuarters--;
    if (e.demandBoomQuarters > 0) e.demandBoomQuarters--;
    if (e.fuelShockQuarters > 0) e.fuelShockQuarters--;
    for (const id of Object.keys(e.grounded)) {
      e.grounded[id] -= 1;
      if (e.grounded[id] <= 0) {
        delete e.grounded[id];
        const p = s.programs.find((x) => x.id === id);
        if (p) pushLog(s, 'good', `${p.name} 운항 정지 해제. 인도를 재개한다.`);
      }
    }
  }

  function driftMarket(s, rng) {
    const m = s.market;
    // 평균 회귀 + 잡음. 시장은 늘 1.0 근처로 되돌아가려 한다.
    // 충격이 진행 중이면 회귀를 크게 늦춘다. 그러지 않으면 9·11 이 두세 분기 만에
    // 없던 일이 되어, 역사적 사건이 한 번의 벌금으로만 남는다.
    // 호황도 침체와 같은 방식으로 지속된다 — 상승 충격이 한 분기 보너스로 끝나면
    // 가상 충격의 상방이 사실상 없는 것과 같다.
    const demandPull = s.effects.demandSlumpQuarters > 0 || s.effects.demandBoomQuarters > 0 ? 0.07 : 0.15;
    const fuelPull = s.effects.fuelShockQuarters > 0 ? 0.05 : 0.12;
    m.fuelIndex = clamp(m.fuelIndex + (1 - m.fuelIndex) * fuelPull + rng.normal(0, 0.05), 0.45, 2.2);
    m.demandIndex = clamp(m.demandIndex + (1 - m.demandIndex) * demandPull + rng.normal(0, 0.06), 0.35, 2.0);
    s.reputation = clamp(s.reputation + (50 - s.reputation) * 0.03, 0, 100);
  }

  /** 경쟁사 인도량을 추상적으로 굴려 시장 점유율을 만든다. */
  function simulateRivals(s, rng) {
    const industry = Math.max(4, Math.round(22 * s.market.demandIndex + rng.normal(0, 3)));
    s.stats.rivalDelivered += industry;
    allocateRivalDeliveries(s, industry);
  }

  /** 경쟁사 반격이 도달할 수 있는 최대 보정치. 이벤트 상한(14)과 별개로 훨씬 낮다. */
  const REACTION_LIMIT = 4.5;
  /** 반격이 붙고 빠지는 분기당 속도. 느려야 플레이어가 대응할 시간이 있다. */
  const REACTION_STEP = 0.3;

  /** 세그먼트별 인도 대수 비중. 대당 가격이 아니라 **기수** 기준이라 소형이 무겁다. */
  const SEGMENT_UNIT_SHARE = { regional: 0.3, narrow: 0.53, wide: 0.17 };

  /**
   * 업계 인도량을 제조사별로 나눠 담는다.
   *
   * 총량은 예전 식 그대로라 점유율 밸런스는 움직이지 않는다. 나누는 근거는 그 시점
   * 카탈로그의 실제 경쟁력이라, 787이 나오면 보잉 몫이 늘고 단산이 겹치면 줄어든다.
   *
   * 난수를 쓰지 않는다 — 여기서 한 번이라도 더 뽑으면 같은 시드의 이후 전개가
   * 통째로 갈려 세이브 재현성과 결정론 테스트가 깨진다. 대신 최대잉여법으로
   * 정수 배분해 총합을 정확히 맞춘다.
   */
  function allocateRivalDeliveries(s, industry) {
    if (industry <= 0) return;
    const year = yearOf(s.turn);
    const weights = new Map();

    for (const seg of Object.keys(SEGMENT_UNIT_SHARE)) {
      const pool = availableTypes(seg, year, s.rivalDelays).filter((t) => !(s.playerMakers || []).includes(t.maker) && !(s.acquiredTypes || {})[t.id]);
      if (!pool.length) continue;
      const segWeight = SEGMENT_UNIT_SHARE[seg];
      // 요구사양 없이 부르면 적합도 감점 없는 순수 카탈로그 실력이다.
      // 이벤트 보정치(drift)와 결함 파동까지 얹어야 입찰과 같은 실력으로 나뉜다 —
      // 빼면 "인도가 멈췄다"는 소식이 뜬 회사의 인도량이 그대로인 모순이 생긴다.
      const powers = pool.map((type) => ({
        maker: type.maker,
        w: Math.pow(
          Math.max(0, typeScore(type, s.market.fuelIndex, null, null) + driftOf(s, type.maker, seg) - crisisDip(s, type.id) - 30),
          2,
        ),
      }));
      // 세그먼트 안에서 먼저 정규화한다. 곧바로 segWeight 를 곱해 합치면 그 세그먼트
      // 몫이 "등재된 기종 수 × 실력 합"에 비례해 버려, 선언한 30/53/17 이 지켜지지
      // 않는다(1998년 카탈로그로 재면 11/64/24 가 나왔다). 기종을 많이 올린 제조사가
      // 그 사실만으로 점유율을 얻는 것도 같은 원인이다.
      const segTotal = powers.reduce((a, x) => a + x.w, 0);
      if (segTotal <= 0) continue;
      for (const x of powers) {
        weights.set(x.maker, (weights.get(x.maker) || 0) + (segWeight * x.w) / segTotal);
      }
    }
    if (!weights.size) return;

    const total = [...weights.values()].reduce((a, b) => a + b, 0);
    if (total <= 0) return;

    const quota = [...weights.entries()].map(([maker, w]) => {
      const exact = (industry * w) / total;
      const base = Math.floor(exact);
      return { maker, base, rem: exact - base };
    });
    let left = industry - quota.reduce((a, q) => a + q.base, 0);
    quota.sort((a, b) => b.rem - a.rem || (a.maker < b.maker ? -1 : 1));
    for (let i = 0; left > 0; i++, left--) quota[i % quota.length].base++;

    for (const q of quota) {
      if (q.base > 0) s.stats.rivalByMaker[q.maker] = (s.stats.rivalByMaker[q.maker] || 0) + q.base;
    }
  }

  /**
   * 그 제조사·세그먼트에 걸린 보정치 총합 — 이벤트(drift)와 가격 공세(reaction).
   * 입찰(bestOffering)이 쓰는 값과 같은 합이어야 배분과 수주전이 같은 실력을 본다.
   */
  function driftOf(s, makerId, segment) {
    const c = (s.competitors || []).find((x) => x.id === makerId);
    if (!c) return 0;
    const d = (c.drift && typeof c.drift[segment] === 'number' && c.drift[segment]) || 0;
    const r = (c.reaction && typeof c.reaction[segment] === 'number' && c.reaction[segment]) || 0;
    return d + r;
  }

  /** 제조사별 누적 인도 — 우리를 포함해 큰 순으로 정렬한 순위표. */
  function makerStandings(s) {
    const rows = MANUFACTURERS.map((m) => ({
      id: m.id,
      name: m.name,
      delivered: (s.stats.rivalByMaker && s.stats.rivalByMaker[m.id]) || 0,
      us: false,
    }));
    // 배분 이전 세이브·초기 승계분은 어느 제조사 몫인지 알 수 없다. 총량과의
    // 차이를 '기타'로 남겨 순위표 합계가 점유율 계산과 어긋나지 않게 한다.
    const allocated = rows.reduce((a, r) => a + r.delivered, 0);
    const unattributed = Math.max(0, s.stats.rivalDelivered - allocated);
    // 군용 인도는 민항 순위 밖이다 — 점유율 계산(marketShare)과 같은 차감을
    // 여기도 해야 순위표의 점유율이 점유율 카드와 어긋나지 않는다.
    rows.push({ id: 'us', name: s.company, delivered: Math.max(0, s.stats.delivered - govDelivered(s)), us: true });
    if (unattributed > 0) rows.push({ id: 'other', name: '집계 이전 인도분', delivered: unattributed, us: false });

    const total = rows.reduce((a, r) => a + r.delivered, 0) || 1;
    return rows
      .filter((r) => r.delivered > 0 || r.us)
      .map((r) => ({ ...r, share: r.delivered / total }))
      .sort((a, b) => b.delivered - a.delivered);
  }

  /** 제조사별 수주전 전적 — 붙은 횟수·완패·분할·완승. */
  function duelRecords(s) {
    const duels = s.stats.duels || {};
    return MANUFACTURERS.filter((m) => duels[m.id])
      .map((m) => ({ id: m.id, name: m.name, ...duels[m.id] }))
      .sort((a, b) => b.faced - a.faced);
  }

  /**
   * 업계 동향 — 이번 분기에 취항했거나 단산된 경쟁 기종.
   * 카탈로그가 조용히 바뀌면 "1998년의 문턱과 2016년의 문턱이 다르다"는 설계 의도가
   * 플레이어에게 한 번도 전달되지 않는다. 바뀌는 순간을 소식으로 띄운다.
   */
  /**
   * 경쟁사 반격.
   *
   * 예전에는 우리가 한 시장을 계속 먹어도 경쟁사가 아무 반응을 하지 않아, 응찰만
   * 하면 88% 이겼다(측정치). 실제 제조사는 시장을 내주는 순간 가격 공세로 답한다.
   *
   * 최근 성적을 세그먼트별로 보고 그 시장 최강 제조사의 보정치를 밀어 올린다.
   * 상한은 RIVAL_DRIFT_LIMIT — 카탈로그가 만든 시대 흐름을 뒤집지는 못한다.
   * 우리가 손을 떼면 보정치는 서서히 0으로 돌아간다(공세를 영원히 유지할 이유가 없다).
   *
   * 난수를 쓰지 않는다. 여기서 뽑으면 같은 시드의 전개가 갈린다.
   */
  function reactToRivals(s) {
    const year = yearOf(s.turn);
    for (const seg of Object.keys(SEGMENT_UNIT_SHARE)) {
      // 이 세그먼트에서 최근 8분기에 우리가 따낸 물량
      const recent = s.backlog.filter((o) => {
        if (s.turn - o.wonTurn > 8 || o.wonTurn > s.turn) return false;
        const p = s.programs.find((x) => x.id === o.programId);
        return p && p.segment === seg;
      });
      const wonUnits = recent.reduce((a, o) => a + o.qty, 0);

      // 그 시장에서 지금 가장 강한 제조사가 공세의 주체다. 플레이어 제조사는 뺀다.
      const pool = availableTypes(seg, year, s.rivalDelays).filter((t) => !(s.playerMakers || []).includes(t.maker) && !(s.acquiredTypes || {})[t.id]);
      let leader = null;
      for (const t of pool) {
        // 입찰·인도 배분과 같은 실력(보정치 포함)으로 봐야 한다. 카탈로그 점수만
        // 보면 "인도가 대거 지연됐다"는 악재를 맞은 회사가 반격의 주체로 뽑혀,
        // 실제로 수주전을 이기고 있는 쪽 대신 엉뚱한 회사에 공세 보너스가 붙는다.
        const power = typeScore(t, s.market.fuelIndex, null, null) + driftOf(s, t.maker, seg) - crisisDip(s, t.id);
        if (!leader || power > leader.power) leader = { maker: t.maker, power };
      }

      // 공세의 목표치. RIVAL_DRIFT_LIMIT(14)까지 밀면 시장이 통째로 닫힌다 —
      // 실제로 그렇게 두면 표준 조건 승률이 88%에서 12%로 떨어졌다. 반격은
      // "이기던 시장이 접전이 된다" 정도여야 하므로 상한을 따로 낮게 잡는다.
      const target = Math.min(REACTION_LIMIT, (wonUnits / 30) * REACTION_LIMIT);

      for (const c of s.competitors) {
        if (!c.reaction) c.reaction = { regional: 0, narrow: 0, wide: 0 };
        const cur = c.reaction[seg] || 0;
        if (leader && c.id === leader.maker && target > cur) {
          const next = Math.min(REACTION_LIMIT, cur + REACTION_STEP);
          if (Math.floor(next) > Math.floor(cur)) {
            const maker = MANUFACTURERS.find((m) => m.id === c.id);
            pushLog(
              s,
              'event',
              `${maker ? maker.name : c.id}이 ${SEGMENTS[seg].name} 시장에서 가격 공세를 시작했다. 이 시장 수주전이 더 어려워진다.`,
            );
          }
          c.reaction[seg] = next;
        } else if (cur > 0) {
          // 공세는 비용이다. 우리가 물러나거나 목표치 아래로 내려오면 제값을 받으러 돌아간다.
          c.reaction[seg] = Math.max(leader && c.id === leader.maker ? Math.max(0, target) : 0, cur - REACTION_STEP);
        }
      }
    }
  }

  function rollMarketNews(s) {
    const now = yearOf(s.turn);
    const prev = yearOf(s.turn - 1);
    const news = [];

    for (const t of AIRCRAFT) {
      // 플레이어 제조사의 카탈로그 미래는 뉴스가 아니다 — 그 미래는 플레이어가 만든다.
      // 인수한 기종도 마찬가지다: 그 기종의 소식은 이제 우리 로그에 산다.
      if ((s.playerMakers || []).includes(t.maker) || (s.acquiredTypes || {})[t.id]) continue;
      const maker = MANUFACTURERS.find((m) => m.id === t.maker);
      if (!maker) continue;
      // 지연이 걸린 기종은 밀린 시점에 취항 소식이 뜬다 — 입찰 문턱과 같은 달력.
      const eis = t.eis + ((s.rivalDelays && s.rivalDelays[t.id]) || 0) / 4;
      if (eis > prev && eis <= now) {
        news.push({
          kind: 'eis',
          text: `${maker.name} ${t.name} 취항 — ${SEGMENTS[t.segment].name} ${t.seats}석 · ${fmtNum(t.range)}km.`,
        });
      }
      if (t.end !== null && t.end > prev && t.end <= now) {
        news.push({ kind: 'end', text: `${maker.name} ${t.name} 신규 판매 종료.` });
      }
    }

    // 위기 회복 — 새 위기를 켜기 **전에** 기존 위기를 센다. 같은 분기에 켜자마자
    // 한 분기를 깎으면 광고한 기간보다 짧게 끝난다.
    for (const [typeId, c] of Object.entries(s.rivalCrises || {})) {
      c.left--;
      if (c.left <= 0) {
        delete s.rivalCrises[typeId];
        const t = AIRCRAFT.find((x) => x.id === typeId);
        if (t) {
          news.push(
            c.amount < 0
              ? { kind: 'recover', text: `${t.name} 초기 호평이 사그라들었다 — 주문 대기열이 정상으로 돌아왔다.` }
              : { kind: 'recover', text: `${t.name} 결함 파동 수습 — 인도가 재개되고 수주전 경쟁력이 돌아왔다.` },
          );
        }
      }
    }

    // 경쟁사 드라마 — 발표·지연·위기. 일정표는 newGame 에서 확정됐다.
    for (const ev of s.rivalDrama || []) {
      if (ev.turn !== s.turn) continue;
      // 일정표는 판 시작에 확정됐다 — 그 뒤 인수한 기종의 예고·위기는 무대에서 내린다.
      if ((s.acquiredTypes || {})[ev.typeId]) continue;
      const t = AIRCRAFT.find((x) => x.id === ev.typeId);
      const maker = t && MANUFACTURERS.find((m) => m.id === t.maker);
      if (!t || !maker) continue;
      if (ev.kind === 'announce') {
        news.push({
          kind: 'announce',
          text: `${maker.name}, 신형 ${t.name} 개발 발표 — ${SEGMENTS[t.segment].name} ${t.seats}석 · ${fmtNum(t.range)}km, ${Math.floor(t.eis)}년 취항 목표.`,
        });
      } else if (ev.kind === 'delay') {
        news.push({
          kind: 'delay',
          text: `${maker.name} ${t.name} 개발 ${ev.quarters}분기 지연 — 취항이 밀린다. 그 사이가 우리 기종의 창이다.`,
        });
      } else if (ev.kind === 'crisis') {
        s.rivalCrises[t.id] = { left: ev.quarters, amount: ev.amount };
        news.push({
          kind: 'crisis',
          text: `${t.name} 초기 결함 파동 — ${maker.name}이 수습에 들어갔다. 당분간 이 기종과 붙는 수주전이 쉬워지고, 흩어지는 인력을 잡을 기회다.`,
        });
      } else if (ev.kind === 'acclaim') {
        s.rivalCrises[t.id] = { left: ev.quarters, amount: ev.amount };
        news.push({
          kind: 'acclaim',
          text: `${t.name} 초기 호평 — 주문이 몰리며 ${maker.name}의 기세가 올랐다. 당분간 이 기종과 붙는 수주전이 어렵다.`,
        });
      }
    }

    s.news = news;
    for (const n of news) pushLog(s, 'info', n.text);
    return news;
  }

  function fmtNum(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  // ─────────────────────────────── 서비스 사업 ───────────────────────────────

  /**
   * 애프터마켓 투자. 한 번 올리면 내리지 않는다 — 거점을 세웠다 접었다 하는 건
   * 사업이 아니라 회계 장난이다.
   */
  function upgradeAftermarket(s, tierId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    const tier = AFTERMARKET_TIERS[tierId];
    if (!tier) return { ok: false, error: '없는 투자 단계입니다.' };
    const order = ['none', 'regional', 'global'];
    if (order.indexOf(tierId) <= order.indexOf(s.aftermarket)) {
      return { ok: false, error: '이미 그 이상으로 갖춰져 있습니다.' };
    }
    const cur = AFTERMARKET_TIERS[s.aftermarket] || AFTERMARKET_TIERS.none;
    const cost = tier.cost - cur.cost;
    if (s.cash < cost) return { ok: false, error: `투자비 ${fmtMoney(cost)}이 부족합니다.` };

    s.cash -= cost;
    s.pending.capex += cost;
    s.aftermarket = tierId;
    for (const a of AIRLINES) {
      s.relations[a.id] = clamp((s.relations[a.id] ?? 40) + tier.relation, 0, 100);
    }
    pushLog(s, 'good', `${tier.name}에 ${fmtMoney(cost)}을 투자했다. 부품·정비 수익이 늘고 고객 관계가 올랐다.`);
    return { ok: true };
  }

  /**
   * 화물형 개조 사업 착수. 양산 중인 기종에만 붙는다 — 굴러다니는 기체가 있어야
   * 개조할 것도 있다.
   */
  function startFreighter(s, programId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    const p = s.programs.find((x) => x.id === programId);
    if (!p) return { ok: false, error: '없는 프로그램입니다.' };
    if (p.phase !== 'production') return { ok: false, error: '양산 중인 기종만 화물형으로 개조할 수 있습니다.' };
    if (p.freighter || p.freighterAt) return { ok: false, error: '이미 화물형 사업이 진행 중입니다.' };

    const cost = Math.round(p.devCost * FREIGHTER.devRate);
    if (s.cash < cost) return { ok: false, error: `개조 개발비 ${fmtMoney(cost)}이 부족합니다.` };
    s.cash -= cost;
    s.pending.rdCost += cost;
    p.freighterAt = s.turn + FREIGHTER.quarters;
    pushLog(
      s,
      'program',
      `${p.name} 화물형 개조에 ${fmtMoney(cost)}을 투입했다. ${FREIGHTER.quarters}분기 뒤부터 개조 수익이 들어온다.`,
    );
    return { ok: true, cost };
  }

  // ─────────────────────────────── 기체 개량 ───────────────────────────────

  /**
   * 양산 기종의 중간 개량 — 기체는 취항으로 끝나지 않는다.
   *
   * 업게이지 추세와 경쟁사 neo 급이 시간을 등에 업고 밀려오는 게임에서, 지금까지
   * 플레이어의 답은 "새 기체"뿐이었다. 실제 제조사의 절반짜리 답이 개량이다 —
   * 737 은 PIP 로, A320 은 샤클릿으로 수명을 늘렸다. 개량은 파생형보다 싸고 빠르며
   * 형식증명을 그대로 쓰지만, 올려 주는 폭도 그만큼 작다: 연장이지 세대교체가 아니다.
   *
   * 이미 인도한 선단에는 **개조 키트**를 판다 — 인도가 끝난 기체가 한 번 더 벌어
   * 오고, 운용사 관계도 오른다(자기 기체가 낡게 방치되지 않는다는 신호다).
   * 그래서 개량은 선단이 클수록 값을 하고, 많이 판 기종을 더 아끼게 만든다.
   */
  const UPGRADES = {
    pip: { name: '성능 개량 패키지', costRate: 0.05, quarters: 3, eff: 4, desc: '엔진·공력 개량 — 연비 +4' },
    winglet: { name: '윙렛 장착', costRate: 0.03, quarters: 2, eff: 3, desc: '익단 연장 — 연비 +3' },
    cabin: { name: '객실 리프레시', costRate: 0.025, quarters: 2, comfort: 6, desc: '객실 신형화 — 객실 +6' },
  };
  /** 개조 키트 매출 — 인도된 1기당 정가의 이 비율. 선단이 클수록 개량이 값을 한다. */
  const RETROFIT_KIT_RATE = 0.012;

  function startUpgrade(s, programId, kind) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    const spec = UPGRADES[kind];
    if (!spec) return { ok: false, error: '없는 개량 항목입니다.' };
    const p = s.programs.find((x) => x.id === programId);
    if (!p) return { ok: false, error: '없는 프로그램입니다.' };
    if (p.phase !== 'production') return { ok: false, error: '양산 중인 기종만 개량할 수 있습니다.' };
    if (p.upgrades && p.upgrades[kind]) return { ok: false, error: '이미 진행했거나 완료한 개량입니다.' };

    const cost = Math.round(p.devCost * spec.costRate);
    if (s.cash < cost) return { ok: false, error: `개량 개발비 ${fmtMoney(cost)}이 부족합니다.` };
    ensureShape(s);
    s.cash -= cost;
    s.pending.rdCost += cost;
    p.spent += cost;
    if (!p.upgrades) p.upgrades = {};
    p.upgrades[kind] = { doneTurn: s.turn + spec.quarters };
    pushLog(s, 'program', `${p.name} ${spec.name} 착수 (${fmtMoney(cost)}). ${spec.quarters}분기 뒤 신규 생산분과 기존 선단에 함께 적용된다.`);
    return { ok: true, cost };
  }

  /** 개량 완성 정산 — 성능 반영, 기존 선단 개조 키트 매출, 운용사 관계. */
  function tickUpgrades(s, report) {
    for (const p of s.programs) {
      if (!p.upgrades) continue;
      for (const [kind, u] of Object.entries(p.upgrades)) {
        // doneTurn 은 "이 분기부터 적용"이다. 적용은 그 직전 분기 정산의 끝 —
        // 입찰 판정(resolveBids) **뒤** — 에서 일어난다. 판정 전에 적용하면 화면이
        // 보여 준 점수와 판정 점수가 갈라지고(분기 시작 상태로 채점한다는 불변식
        // 위반), 판정 후 적용하면서 doneTurn 을 한 분기 뒤로 두면 "0분기 남음"
        // 인데 효과가 없는 분기가 생긴다. 이 배치가 둘 다 지키는 유일한 자리다.
        if (u.applied || s.turn < u.doneTurn - 1) continue;
        const spec = UPGRADES[kind];
        if (!spec) continue;
        u.applied = true;
        if (spec.eff) p.efficiency = Math.min(99, Math.round(p.efficiency + spec.eff));
        if (spec.comfort) p.comfort = Math.min(99, Math.round(p.comfort + spec.comfort));

        // 이미 하늘에 있는 기체에 키트를 판다. endTurn 안에서 완성되므로
        // pending 이 아니라 이번 분기 리포트에 직접 적는다.
        const kits = Math.round((p.delivered || 0) * p.listPrice * RETROFIT_KIT_RATE);
        if (kits > 0) {
          s.cash += kits;
          report.revenue += kits;
          s.stats.revenue += kits;
        }
        const operators = [];
        for (const [airlineId, byProgram] of Object.entries(s.fleets || {})) {
          if ((byProgram[p.id] || 0) > 0) {
            s.relations[airlineId] = clamp((s.relations[airlineId] ?? 40) + 2, 0, 100);
            operators.push(airlineId);
          }
        }
        pushLog(
          s,
          'good',
          `${p.name} ${spec.name} 완성 — ${spec.desc.split(' — ')[1] || spec.desc}.` +
            (kits > 0 ? ` 기존 선단 ${num(p.delivered)}기 개조 키트로 ${fmtMoney(kits)}을 벌었고, 운용사 ${operators.length}곳의 신뢰가 올랐다.` : ''),
        );
      }
    }
  }

  /**
   * 서비스 사업 정산 — 부품·정비와 화물 개조.
   *
   * 신규 인도만이 매출이면 개발 공백기에 경영할 거리가 없다. 여기 수익은 이미 팔아
   * 둔 기체에서 나오므로, 초반의 인도 노력이 후반의 버팀목이 된다.
   */
  function runServices(s, report) {
    const tier = AFTERMARKET_TIERS[s.aftermarket] || AFTERMARKET_TIERS.none;
    const after = aftermarketBase(s) * tier.mult;

    let freight = 0;
    for (const p of s.programs) {
      if (p.freighterAt !== undefined && !p.freighter && s.turn >= p.freighterAt) {
        p.freighter = true;
        delete p.freighterAt;
        pushLog(s, 'good', `${p.name} 화물형 개조 사업이 문을 열었다.`);
      }
      // 군용 특수기는 화물기로 개조된 것이 아니다 — 그 인도분은 지원 수익이 맡는다.
      if (p.freighter) freight += Math.max(0, (p.delivered || 0) - govUnitsOf(s, p.id)) * FREIGHTER.perUnit;
    }
    // 여객이 얼어붙어도 화물은 돈다. 침체기의 버팀목이 화물 사업의 존재 이유다.
    if (s.effects.demandSlumpQuarters > 0) freight *= FREIGHTER.slumpMult;

    const total = Math.round(after + freight + govSustainment(s));
    if (total <= 0) return;
    s.cash += total;
    s.stats.revenue += total;
    report.revenue += total;
    report.services = total;
  }

  /**
   * 정부 특수기 지원 수익 — 인도된 군용기는 퇴역까지 정비·훈련·부품을 우리가 댄다.
   * 군용기 사업의 진짜 이문이 여기다: 판매는 한 번이지만 지원은 20년이다.
   */
  /** 이 기종의 인도분 중 군용 특수기 몫. */
  function govUnitsOf(s, programId) {
    return ((s.fleets || {}).gov || {})[programId] || 0;
  }

  function govSustainment(s) {
    // 사풍 — 오래 군을 상대한 회사는 지원 계약도 두껍게 쓴다. 반대로 방산이
    // 남의 집인 회사는 같은 기체로도 같은 계약을 못 받는다.
    // 0 은 유효한 값이다 ("군 지원 계약이 아예 없다"). ||는 그것을 1 로 되살린다.
    const mult = (companyTrait(s).gov || {}).sustainMult ?? 1;
    let sum = 0;
    for (const p of s.programs) {
      if (!p.govMission) continue;
      const m = GOV_MISSIONS.find((x) => x.id === p.govMission);
      if (m) sum += govUnitsOf(s, p.id) * m.sustainPerUnit * mult;
    }
    return sum;
  }

  /** 급별 단가로 계산한 선단의 분기 기본 서비스 수익 (투자 배수 적용 전). */
  /**
   * 단골 등급 — 그 항공사에 인도한 누적 대수로 잰다. 관계 점수는 오르내리지만
   * 인도 실적은 지워지지 않는다: 한 번 쌓은 단골은 유지된다.
   *   0 거래처 · 1 단골(20기+) · 2 핵심 고객(60기+)
   * 승계 선단의 델타(62기)가 시작부터 핵심 고객이다 — 물려받은 것은 기체만이
   * 아니라 계정이고, 그 계정을 지키는 것이 초반 전략의 한 축이 된다.
   */
  function loyaltyTier(s, airlineId) {
    const fleet = (s.fleets && s.fleets[airlineId]) || {};
    const units = Object.values(fleet).reduce((a, b) => a + b, 0);
    if (units >= 60) return 2;
    if (units >= 20) return 1;
    return 0;
  }

  /** 핵심 고객 선단의 전속 정비 계약 — 그 대수만큼 애프터마켓 단가가 오른다. */
  const LOYAL_SERVICE_BONUS = 0.15;

  function aftermarketBase(s) {
    // 4발은 엔진 정비 계약이 두 벌 더다 — 항공사에는 짐이지만 제조사에는 수익이다.
    let base = s.programs.reduce(
      (a, p) => a + (p.delivered || 0) * (AFTERMARKET_PER_UNIT_BY_SEG[p.segment] ?? AFTERMARKET_PER_UNIT) * (p.engines === 4 ? 1.25 : 1),
      0,
    );
    // 핵심 고객은 정비를 우리에게 전속으로 맡긴다 — 단골의 보상은 입찰 점수가
    // 아니라(공통성 가산이 이미 그 역할이다) 인도 뒤의 현금흐름으로 돌아온다.
    for (const [airlineId, byProgram] of Object.entries(s.fleets || {})) {
      // 군 선단은 항공사 단골이 아니다 — 군의 정비 계약 경제는 지원 수익 단가에
      // 이미 들어 있어, 여기서 또 받으면 이중 계상이다.
      if (airlineId === 'gov' || loyaltyTier(s, airlineId) < 2) continue;
      for (const [pid, n] of Object.entries(byProgram)) {
        const p = s.programs.find((x) => x.id === pid);
        if (p) base += n * (AFTERMARKET_PER_UNIT_BY_SEG[p.segment] ?? AFTERMARKET_PER_UNIT) * (p.engines === 4 ? 1.25 : 1) * LOYAL_SERVICE_BONUS;
      }
    }
    return base;
  }

  /** 화면이 읽는 서비스 수익 내역. */
  function serviceIncome(s) {
    const tier = AFTERMARKET_TIERS[s.aftermarket] || AFTERMARKET_TIERS.none;
    const fleet = s.programs.reduce((a, p) => a + (p.delivered || 0), 0);
    const after = aftermarketBase(s) * tier.mult;
    let freight = s.programs
      .filter((p) => p.freighter)
      .reduce((a, p) => a + Math.max(0, (p.delivered || 0) - govUnitsOf(s, p.id)) * FREIGHTER.perUnit, 0);
    if (s.effects.demandSlumpQuarters > 0) freight *= FREIGHTER.slumpMult;
    const gov = govSustainment(s);
    return { fleet, aftermarket: after, freight, gov, total: after + freight + gov, tier };
  }

  // ─────────────────────────────── 장기 기술 연구 ───────────────────────────────

  /**
   * 스컹크웍스 — 한 번에 한 프로젝트, 분기마다 연구비, 몇 년 뒤 회사 상수가 바뀐다.
   * 효과는 완료 이후의 신규 설계(researchContext)·신규 생산(린)에만 붙는다.
   */
  const LEAN_FIRST_UNIT_PREMIUM = 1.72;
  const LEAN_RAMP_MULT = 1.2;

  function researchDone(s, id) {
    return !!(s.research && s.research.done && s.research.done[id]);
  }

  /** 완료된 연구를 설계 평가에 넘긴다 — launchProgram·화면 미리보기가 같이 쓴다. */
  function researchContext(s) {
    return { research: (s.research && s.research.done) || {} };
  }

  /** 린 생산 연구 완료 시의 초도기 할증 — 아니면 undefined 로 기본값을 쓴다. */
  function unitPremium(s) {
    return researchDone(s, 'lean') ? LEAN_FIRST_UNIT_PREMIUM : undefined;
  }

  function startResearch(s, projectId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    ensureShape(s);
    const proj = RESEARCH_PROJECTS.find((x) => x.id === projectId);
    if (!proj) return { ok: false, error: '없는 연구 프로젝트입니다.' };
    if (s.research.done[projectId]) return { ok: false, error: '이미 완료한 연구입니다.' };
    if (s.research.active === projectId) return { ok: false, error: '이미 진행 중입니다.' };
    // 연구소는 하나다 — 갈아타면 기존 진행은 서랍에 남는다(사라지지 않는다).
    s.research.active = projectId;
    const done = s.research.progress[projectId] || 0;
    pushLog(
      s,
      'program',
      `${proj.name} 연구 착수 — 분기 ${fmtMoney(proj.costPerQuarter)}, 완료까지 ${proj.quarters - done}분기. ${proj.effect}.`,
    );
    return { ok: true };
  }

  function stopResearch(s) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    ensureShape(s);
    if (!s.research.active) return { ok: false, error: '진행 중인 연구가 없습니다.' };
    const proj = RESEARCH_PROJECTS.find((x) => x.id === s.research.active);
    s.research.active = null;
    pushLog(s, 'info', `${proj ? proj.name : '연구'}를 중단했다. 진행분은 남는다 — 다시 시작하면 이어서 간다.`);
    return { ok: true };
  }

  /** 분기 연구 정산 — 비용은 이 분기 R&D 로 잡히고, 다 차면 효과가 영구히 켜진다. */
  function runResearch(s, report) {
    const r = s.research;
    if (!r || !r.active) return;
    const proj = RESEARCH_PROJECTS.find((x) => x.id === r.active);
    if (!proj) {
      r.active = null;
      return;
    }
    s.cash -= proj.costPerQuarter;
    report.rdCost += proj.costPerQuarter;
    r.progress[proj.id] = (r.progress[proj.id] || 0) + 1;
    if (r.progress[proj.id] >= proj.quarters) {
      r.done[proj.id] = true;
      // **언제** 끝났는지도 남긴다. 착수 시점의 연구를 프로그램이 들고 다니게 된
      // 뒤로는 이 값이 곧 "그 기체가 이 연구를 받았는가"의 기준이 된다.
      r.doneTurn = r.doneTurn || {};
      r.doneTurn[proj.id] = s.turn;
      r.active = null;
      pushLog(s, 'good', `${proj.name} 연구 완료 — ${proj.effect}. 이제부터의 설계·생산에 적용된다.`);
    }
  }

  // ─────────────────────────────── 이사회 목표 ───────────────────────────────

  /**
   * 5년(20분기) 단위 이사회 목표.
   *
   * 20년을 한 번의 최종 점수로만 재면 중간이 없다 — 측정해 보니 파산(F) 아니면
   * A·S 였고 B·C·D 는 한 판도 나오지 않았다. 살아남는 것 자체가 서사가 되려면
   * 중간에 재는 눈금이 있어야 한다. 목표는 그 눈금이고, 달성·실패가 곧바로
   * 자금과 조달 비용으로 돌아온다.
   *
   * 목표치는 **발령 시점의 실적에서** 만든다. 고정값으로 두면 잘 나가는 판에는
   * 무의미하고 어려운 판에는 불가능한 숙제가 된다.
   */
  const MANDATES = [
    {
      id: 'delivery',
      name: '인도 확대',
      target: (s) => Math.round(s.stats.delivered + 55 + s.turn * 0.8),
      progress: (s) => s.stats.delivered,
      describe: (t) => `20년 누적 인도 ${t}기 달성`,
      unit: '기',
    },
    {
      id: 'worth',
      name: '자산 성장',
      target: (s) => Math.round(Math.max(1800, netWorth(s) * 1.35 + 900)),
      progress: (s) => Math.round(netWorth(s)),
      describe: (t) => `순자산 ${fmtMoney(t)} 달성`,
      unit: '',
      money: true,
    },
    {
      id: 'share',
      name: '점유율 확보',
      target: (s) => Math.round(Math.min(0.42, marketShare(s) + 0.05) * 1000) / 1000,
      progress: (s) => Math.round(marketShare(s) * 1000) / 1000,
      describe: (t) => `시장 점유율 ${(t * 100).toFixed(1)}% 달성`,
      unit: '',
      percent: true,
    },
    {
      id: 'newtype',
      name: '신형 투입',
      target: (s) => s.programs.filter((p) => !p.legacy && p.phase === 'production').length + 1,
      progress: (s) => s.programs.filter((p) => !p.legacy && p.phase === 'production').length,
      describe: (t) => `양산 중인 자체 개발 기종 ${t}종 확보`,
      unit: '종',
    },
  ];

  const MANDATE_QUARTERS = 20;

  function mandateDef(id) {
    return MANDATES.find((m) => m.id === id) || null;
  }

  /** 다음 목표를 발령한다. 같은 목표가 연달아 나오지 않게 직전 것은 뺀다. */
  function issueMandate(s, rng) {
    // 온전한 20분기가 남아 있을 때만 발령한다. 목표가 없던 옛 세이브를 79분기에
    // 불러오면 기한이 게임 밖(99분기)인 목표가 서고, 종료 정산이 그것을 한 분기
    // 만에 채점해 평판을 깎거나 증자를 안긴다. 정상 주기(0·20·40·60)에서는 늘 참이다.
    if (s.turn + MANDATE_QUARTERS > CONFIG.totalTurns) {
      s.mandate = null;
      return null;
    }
    const pool = MANDATES.filter((m) => !s.mandate || m.id !== s.mandate.id);
    const def = pool[Math.floor(rng.next() * pool.length)] || MANDATES[0];
    const target = def.target(s);
    s.mandate = {
      id: def.id,
      name: def.name,
      target,
      text: def.describe(target),
      issuedTurn: s.turn,
      dueTurn: s.turn + MANDATE_QUARTERS,
    };
    pushLog(s, 'info', `이사회가 새 목표를 내렸다 — ${s.mandate.text} (${turnLabel(s.mandate.dueTurn)}까지).`);
    return s.mandate;
  }

  /** 목표 진행 상황. 화면이 읽는다. */
  function mandateStatus(s) {
    if (!s.mandate) return null;
    const def = mandateDef(s.mandate.id);
    if (!def) return null;
    const now = def.progress(s);
    return {
      ...s.mandate,
      now,
      ratio: s.mandate.target > 0 ? clamp(now / s.mandate.target, 0, 1) : 1,
      met: now >= s.mandate.target,
      quartersLeft: Math.max(0, s.mandate.dueTurn - s.turn),
      format: (v) => (def.money ? fmtMoney(v) : def.percent ? (v * 100).toFixed(1) + '%' : `${Math.round(v)}${def.unit}`),
    };
  }

  /**
   * 기한이 된 목표를 정산한다.
   * 달성하면 이사회가 증자로 답하고, 실패하면 조달 비용이 오른다 — 실패가 곧바로
   * 파산으로 이어지지는 않되 다음 5년이 확실히 무거워진다.
   */
  function settleMandate(s, rng, opts) {
    const final = !!(opts && opts.final);
    if (!s.mandate || (!final && s.turn < s.mandate.dueTurn)) return;
    const st = mandateStatus(s);
    if (!st) {
      s.mandate = null;
      return;
    }

    if (st.met) {
      const grant = Math.round(600 + s.turn * 12);
      s.cash += grant;
      s.pending.revenue += grant;
      adjustReputation(s, 6);
      s.stats.mandatesMet = (s.stats.mandatesMet || 0) + 1;
      pushLog(s, 'good', `이사회 목표 달성 — ${s.mandate.text}. 증자 ${fmtMoney(grant)}과 신임을 얻었다.`);
    } else {
      adjustReputation(s, -6);
      s.effects.rateBump = Math.max(s.effects.rateBump || 0, 0.005);
      s.effects.rateBumpQuarters = Math.max(s.effects.rateBumpQuarters || 0, 8);
      s.stats.mandatesMissed = (s.stats.mandatesMissed || 0) + 1;
      pushLog(
        s,
        'bad',
        `이사회 목표 미달 — ${s.mandate.text} (${st.format(st.now)} / ${st.format(st.target)}). 신임이 흔들리고 조달 금리가 올랐다.`,
      );
    }
    // 마지막 정산에서는 새 목표를 발령하지 않는다 — 끝난 판에 20분기짜리 숙제가
    // 남으면 회고 화면이 존재하지 않는 미래를 가리킨다.
    if (final) s.mandate = null;
    else issueMandate(s, rng);
  }

  // ─────────────────────────────── 회생 수단 ───────────────────────────────

  /**
   * 증자 — 현금을 지분으로 바꾼다.
   *
   * 파산 외의 출구가 없으면 자금난은 곧 게임 종료다(측정: 파산 64%). 증자는
   * 살아남는 길을 주되 공짜가 아니다 — 희석된 지분만큼 최종 점수가 깎인다.
   * 조달 조건은 평판과 실적에서 나온다. 잘 나갈 때 미리 당겨 두는 편이 싸다.
   */
  function raiseEquity(s, amount) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    const rounds = s.equityRounds || 0;
    if (rounds >= 3) return { ok: false, error: '더 이상 증자할 수 없습니다 (최대 3회).' };
    const take = Math.round(Math.max(0, amount));
    if (take <= 0) return { ok: false, error: '증자 금액이 올바르지 않습니다.' };

    const cap = equityCapacity(s);
    if (take > cap.max) return { ok: false, error: `지금 시장이 받아줄 수 있는 한도는 ${fmtMoney(cap.max)}입니다.` };

    const dilution = (take / cap.max) * cap.dilutionAtMax;
    s.cash += take;
    s.equityRounds = rounds + 1;
    s.equityDilution = Math.min(0.65, (s.equityDilution || 0) + dilution);
    pushLog(
      s,
      'info',
      `증자로 ${fmtMoney(take)}을 조달했다. 지분이 ${(dilution * 100).toFixed(1)}%p 희석돼 누적 ${(s.equityDilution * 100).toFixed(1)}%가 됐다.`,
    );
    return { ok: true };
  }

  /** 지금 증자로 받을 수 있는 최대 금액과 그때의 희석률. 평판·실적이 좋을수록 유리하다. */
  function equityCapacity(s) {
    const worth = netWorth(s);
    const rep = clamp(s.reputation / 100, 0, 1);
    const base = Math.max(700, worth * 0.35 + 900);
    const max = Math.round(base * (0.6 + rep * 0.9) * (1 - (s.equityRounds || 0) * 0.18));
    // 회사가 좋을수록 같은 금액에 지분을 덜 내준다.
    const dilutionAtMax = clamp(0.34 - rep * 0.16 + (worth < 0 ? 0.12 : 0), 0.08, 0.5);
    return { max: Math.max(300, max), dilutionAtMax };
  }

  /**
   * 개발 중인 프로그램을 경쟁사에 매각한다.
   *
   * 현금이 마르면 개발 동결 말고는 손이 없었다. 매각은 즉시 현금을 만들지만
   * 우리 설계가 경쟁사 손에 들어간다 — 그 세그먼트 경쟁이 실제로 세진다.
   */
  function sellProgram(s, programId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    ensureShape(s);
    const p = s.programs.find((x) => x.id === programId);
    if (!p) return { ok: false, error: '없는 프로그램입니다.' };
    if (p.phase !== 'dev' && p.phase !== 'cert') {
      return { ok: false, error: '개발·인증 단계의 프로그램만 매각할 수 있습니다.' };
    }

    // 진척이 있을수록 값이 나간다. 그래도 들인 돈보다는 늘 적다 — 헐값 매각이다.
    const value = Math.round(p.spent * (0.35 + (p.progress / 100) * 0.3));
    s.cash += value;
    s.pending.revenue += value;
    p.phase = 'sold';
    adjustReputation(s, -5);
    voidOrdersFor(s, p, '프로그램 매각');

    // 사는 쪽은 그 시장에 이미 들어와 있는 제조사다 — 남의 도면을 살 이유가 있는 곳.
    // 그 시장에서 가장 약한 축이 따라잡으려 산다고 보는 편이 자연스럽다.
    const seg = p.segment;
    const year = yearOf(s.turn);
    const active = new Set(availableTypes(seg, year).filter((t) => !(s.playerMakers || []).includes(t.maker) && !(s.acquiredTypes || {})[t.id]).map((t) => t.maker));
    const candidates = s.competitors.filter((c) => active.has(c.id));
    const buyer =
      (candidates.length
        ? candidates.reduce((a, b) => ((b.drift[seg] || 0) < (a.drift[seg] || 0) ? b : a))
        : s.competitors[0]) || null;
    // 도면 인수는 일회성 실력 상승이다 — 가격 공세(reaction)가 아니라 이벤트 보정에 얹는다.
    if (buyer) buyer.drift[seg] = Math.min(RIVAL_DRIFT_LIMIT, (buyer.drift[seg] || 0) + 2);
    const buyerName = buyer ? (MANUFACTURERS.find((m) => m.id === buyer.id) || {}).name || buyer.id : '경쟁사';

    pushLog(s, 'bad', `${p.name} 프로그램을 ${fmtMoney(value)}에 매각했다. 도면은 ${buyerName}로 넘어갔다.`);
    // 시나리오의 기둥을 팔았다면 그 자리에서 알린다.
    tickScenario(s);
    return { ok: true, value, buyer: buyerName };
  }

  /**
   * 경쟁사 프로그램 인수 — 결함 파동으로 흔들리는 경쟁사의 기종을 사 온다.
   *
   * 에어버스가 C시리즈를 1달러에 가져간 그 구조다: 통째 인수('full')는 헐값이지만
   * 저마진 승계 계약·저율 생산 라인·높아진 결함 위험이 따라오고, 도면·인증만
   * 사면('blueprint') 깨끗하지만 몇 배 비싸고 라인·실적 없이 시작한다.
   * 인수한 기종은 경쟁 카탈로그에서 빠진다 — 이제 그 시장 지위는 우리 것이다.
   */
  function acquireProgram(s, typeId, mode, opts) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    ensureShape(s);
    const t = AIRCRAFT.find((x) => x.id === typeId);
    if (!t) return { ok: false, error: '없는 기종입니다.' };
    if (s.acquiredTypes[typeId]) return { ok: false, error: '이미 인수한 기종입니다.' };
    const seg = SEGMENTS[t.segment];
    const full = mode !== 'blueprint';
    const price = Math.round(seg.devBase * (full ? TAKEOVER.fullRate : TAKEOVER.blueprintRate));
    if (s.cash < price) return { ok: false, error: `인수 대금 ${fmtMoney(price)}이 부족합니다.` };

    const year = yearOf(s.turn);
    // 설계 세대는 취항 연도에서 유추한다 — 카탈로그 power 는 입찰 척도라 기술이 아니다.
    const tech = Math.min(70, Math.max(40, Math.round(35 + (t.eis - 1990) * 1.2)));
    // 남의 설계라 우리 연구 성과는 안 붙는다 — researchContext 를 섞지 않는다.
    const ev = evaluate({ segment: t.segment, seats: t.seats, range: t.range, tech, material: 'aluminum', year });
    const p = {
      id: 'prog-' + s.nextId++,
      name: t.name,
      ...ev,
      phase: 'production',
      progress: 100,
      spent: price,
      certRemaining: 0,
      qualityInvests: 0,
      share: 0,
      // 통째 인수는 치구·라인과 함께 기존 생산분의 학습곡선도 넘어온다.
      produced: full ? Math.max(6, Math.round(Math.max(0, year - t.eis) * 6)) : 0,
      delivered: 0,
      stock: 0,
      launchTurn: s.turn,
      // 인수한 기체는 이미 그 엔진을 달고 온다 — 장착 시점은 인수 분기다.
      engineTurn: s.turn,
      certTurn: s.turn,
      derivedFrom: null,
      acquired: true,
    };
    // 기존 운용 선단의 지원은 우리 몫이 된다 — 애프터마켓이 그만큼 는다.
    if (full) p.delivered = p.produced;
    // 승계 인도분의 기준선 — 시나리오(광동체의 꿈)가 "우리가 인도한 몫"만 세는 근거.
    // 성숙한 광동체를 통째 인수하는 것만으로 목표가 차면 산을 산 것이지 오른 게 아니다.
    p.acquiredDelivered = p.delivered;
    // 남의 설계는 도면 밖의 사정을 모른다 — 결함 위험이 그 값이다. 위기 중 인수면 더 높다.
    p.defectRisk = Math.round(
      Math.min(CONFIG.defectRiskMax, ev.defectRisk * (full ? TAKEOVER.riskMult : TAKEOVER.riskMultBlueprint)) * 1000,
    ) / 1000;

    s.cash -= price;
    // 도면과 형식증명을 사는 돈이다 — 개발 자산 취득이므로 R&D 로 분류한다.
    s.pending.rdCost += price;
    s.programs.push(p);
    s.acquiredTypes[typeId] = true;
    // 그 기종의 결함 파동은 이제 우리 문제다 — 경쟁력 감점 장부에서는 지운다.
    if (s.rivalCrises && s.rivalCrises[typeId]) delete s.rivalCrises[typeId];

    if (full) {
      s.lines.push({
        id: 'line-' + s.nextId++,
        programId: p.id,
        capacity: Math.max(1, Math.round(seg.lineMaxRate * TAKEOVER.lineCapRate)),
        capMult: TAKEOVER.lineCapRate,
        ramp: 0.6,
        partial: 0,
        idle: false,
        builtTurn: s.turn,
        grade: 'standard',
        paidCost: 0,
      });
      // 전 소유자가 손해 보며 받아 둔 계약 — 물량은 있지만 이문이 없다. 이게 헐값의 조건이다.
      const qty = (opts && opts.backlogQty) || TAKEOVER.backlogQty[0];
      s.backlog.push({
        id: 'ord-' + s.nextId++,
        airlineId: 'takeover',
        airlineName: '승계 계약 (전 고객사)',
        programId: p.id,
        programName: p.name,
        qty,
        remaining: qty,
        unitPrice: Math.round(ev.unitCostBase * TAKEOVER.backlogPriceRate),
        wonTurn: s.turn,
      });
      // 감항 이관·통합 — 그동안 인도가 멈춘다. 인수는 서류 한 장으로 끝나지 않는다.
      s.effects.grounded[p.id] = Math.max(s.effects.grounded[p.id] || 0, TAKEOVER.integrationQuarters);
    }

    const maker = MANUFACTURERS.find((m) => m.id === t.maker);
    pushLog(
      s,
      'program',
      `${maker ? maker.name : t.maker} ${t.name} 프로그램을 ${fmtMoney(price)}에 인수했다` +
        (full
          ? ` — 라인·승계 계약·기존 선단 지원까지 통째로. 감항 이관에 ${TAKEOVER.integrationQuarters}분기, 남의 설계라 결함 위험 ${(p.defectRisk * 100).toFixed(1)}%.`
          : ` — 도면과 형식증명만. 라인은 우리가 세워야 하고, 결함 위험 ${(p.defectRisk * 100).toFixed(1)}%.`),
    );
    return { ok: true, program: p, price };
  }

  /**
   * 이 속도면 몇 분기 뒤에 현금이 마르나. 경고 화면이 읽는다.
   * 최근 4분기 평균 순현금흐름으로 재고, 흑자면 null(마르지 않는다).
   */
  function cashRunway(s) {
    const recent = (s.history || []).slice(-4);
    if (recent.length < 2) return null;
    const avg = recent.reduce((a, h) => a + h.net, 0) / recent.length;
    if (avg >= 0) return null;
    return Math.max(0, Math.floor(s.cash / -avg));
  }

  // ─────────────────────────────── 결정 사건 ───────────────────────────────

  /**
   * 결정 사건이 쓰는 헬퍼. 이벤트 헬퍼와 겹치는 부분이 많지만 항공사 관계·수주
   * 생성처럼 결정에서만 필요한 손잡이가 더 있다.
   *
   * memo 는 상태에 저장된다 — 사건 문구를 만들 때 뽑은 대상(어느 기종, 어느 항공사)을
   * 선택지 apply 와 몇 분기 뒤 지연 결과가 같이 봐야 하기 때문이다. 다시 뽑으면
   * "델타가 제안했는데 에어아스타나와 계약됐다" 같은 어긋남이 생긴다.
   */
  function decisionHelpers(s, rng, memo, opts) {
    return {
      rng,
      fmt: fmtMoney,
      // 종료 정산이라 다음 분기가 없다는 뜻. 유예로 닫으면 안 되는 약속이
      // 이 값을 보고 그 자리에서 결말을 낸다.
      final: !!(opts && opts.final),
      remember: (k, v) => {
        memo[k] = v;
        return v;
      },
      recall: (k, fallback) => (memo[k] === undefined ? fallback : memo[k]),
      reputation: (d) => adjustReputation(s, d),
      relation: (airlineId, d) => {
        if (!airlineId) return;
        s.relations[airlineId] = clamp((s.relations[airlineId] ?? 40) + d, 0, 100);
      },
      income: (amt) => {
        s.cash += amt;
        s.pending.revenue += amt;
      },
      expense: (amt) => {
        s.cash -= amt;
        s.pending.overhead += amt;
      },
      /**
       * 개발 성격의 지출 — 분기 보고서의 R&D 줄에 실린다. 특수기 개조 개발처럼
       * "개발비"라고 말하는 돈을 간접비로 분류하면 경력 보고서의 R&D 총액이 샌다.
       */
      rdExpense: (amt) => {
        s.cash -= amt;
        s.pending.rdCost += amt;
      },
      /**
       * 특별 근무 같은 긴급 생산. 재고만 얹으면 학습곡선도 원가도 건너뛴 공짜 기체가
       * 되어 곧바로 팔 수 있다 — 생산 경제 전체가 무너진다. 정규 생산과 같은 방식으로
       * 번호를 매기고 원가를 문다(급하게 뽑는 만큼 할증까지).
       */
      rushProduce: (program, units, premium) => {
        // 인증 전 기체는 특별 근무로도 못 뽑는다 — 선주문이 생기면서 백로그에
        // 개발·인증 중 기종의 주문이 섞이므로, 여기서 거르지 않으면 사건 하나가
        // 형식증명을 우회해 종이 비행기를 실물로 만든다.
        if (!program || program.phase !== 'production') return 0;
        let cost = 0;
        for (let i = 0; i < units; i++) {
          // currentUnitCost 는 "다음에 만들 1기"(produced+1 번째)의 원가다. 번호를
          // 먼저 올리면 방금 찍은 N 번기를 N+1 번기 값에 매겨 학습곡선만큼 덜 문다.
          cost += currentUnitCost(s, program) * (premium || 1);
          program.produced++;
        }
        cost = Math.round(cost);
        program.stock += units;
        s.cash -= cost;
        s.pending.productionCost += cost;
        return cost;
      },
      /** 기종을 몇 분기 세운다 — 인도가 밀린다고 광고한 선택지가 실제로 밀리도록. */
      ground: (programId, quarters) => {
        if (!programId || !(quarters > 0)) return;
        // 정비성 설계는 정지도 짧다 — 접근 패널이 있는 기체는 고치기도 빠르다.
        const p = s.programs.find((x) => x.id === programId);
        const dur = p && p.maintainable ? Math.max(1, quarters - 1) : quarters;
        s.effects.grounded[programId] = Math.max(s.effects.grounded[programId] || 0, dur);
      },
      /** 결정으로 성사된 수주. 입찰을 거치지 않으므로 착수금도 여기서 받는다. */
      order: ({ airlineId, airlineName, program, qty, unitPrice, reqEtops, gov }) => {
        const deposit = Math.round(qty * unitPrice * CONFIG.depositRate);
        s.cash += deposit;
        s.pending.revenue += deposit;
        s.stats.ordersWon += qty;
        s.pending.ordersWon = (s.pending.ordersWon || 0) + qty;
        const order = {
          id: 'ord-' + s.nextId++,
          airlineId,
          airlineName,
          programId: program.id,
          programName: program.name,
          qty,
          remaining: qty,
          unitPrice,
          wonTurn: s.turn,
          // 대양 노선 계약이면 인도 게이트가 지켜야 한다 — 입찰 주문과 같은 표식.
          reqEtops: !!reqEtops,
          // 정부 계약 표식 — 항공사발 취소 충격(발주 취소·9·11·연쇄 파산)이 비켜 간다.
          gov: !!gov,
        };
        s.backlog.push(order);
        return order;
      },
      /**
       * 이번 분기 공고 목록에 한 장을 보탠다. 에어쇼 부스처럼 "지금 현장에서
       * 수주전이 열린다"가 다음 분기 갱신을 기다리면, 고른 자리와 입찰 자리가 어긋난다.
       */
      rfp: (plan) => {
        const rfp = makeRfp(s, rng, plan);
        s.rfps.push(rfp);
        return rfp;
      },
    };
  }

  /**
   * 이번 분기의 결정 사건을 뽑는다.
   *
   * 빈 분기를 메우는 게 목적이라 확률이 높지만, 매 분기 결정을 강요하면 피로해진다.
   * 직전 분기에 사건이 있었으면 이번에는 건너뛴다(연속 방지).
   */
  function rollDecision(s, rng) {
    if (!Decisions) return null;
    if (s.turn < 2) return null;
    if (s.lastDecisionTurn === s.turn - 1) return null;
    if (!rng.chance(0.62)) return null;

    const weightOf = (d) => (typeof d.weight === 'function' ? d.weight(s) : d.weight || 0);
    // 최근에 본 사건은 잠시 빼 둔다. 같은 협상이 매번 돌아오면 사건이 아니라 세금이다.
    const recent = new Set((s.recentDecisions || []).slice(-4));
    let pool = Decisions.DECISIONS.filter((d) => weightOf(d) > 0 && !recent.has(d.id));
    if (!pool.length) pool = Decisions.DECISIONS.filter((d) => weightOf(d) > 0);
    if (!pool.length) return null;

    const total = pool.reduce((a, d) => a + weightOf(d), 0);
    let r = rng.next() * total;
    const chosen = pool.find((d) => (r -= weightOf(d)) <= 0) || pool[0];

    const memo = {};
    const text = chosen.text(s, decisionHelpers(s, rng, memo));

    s.lastDecisionTurn = s.turn;
    s.recentDecisions = [...(s.recentDecisions || []), chosen.id].slice(-6);
    return {
      id: chosen.id,
      name: chosen.name,
      text,
      memo,
      turn: s.turn,
      options: chosen.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })),
    };
  }

  /** 플레이어가 선택지를 고른다. 고른 즉시 정산되고 지연 결과는 예약된다. */
  function decide(s, optionId) {
    if (s.gameOver) return { ok: false, error: '게임이 종료되었습니다.' };
    if (!s.decision) return { ok: false, error: '지금 결정할 사건이 없습니다.' };
    const def = Decisions.get(s.decision.id);
    const opt = Decisions.optionOf(s.decision.id, optionId);
    if (!def || !opt) return { ok: false, error: '없는 선택지입니다.' };

    const rng = rngFor(s);
    const text = applyDecisionOption(s, s.decision, opt, rng);
    saveRng(s, rng);
    s.decision = null;
    return { ok: true, text };
  }

  function applyDecisionOption(s, decision, opt, rng) {
    const memo = decision.memo || {};
    const text = opt.apply(s, decisionHelpers(s, rng, memo));
    pushLog(s, 'event', `[${decision.name}] ${opt.label} — ${text}`);
    if (opt.after) {
      s.pendingOutcomes.push({
        turn: s.turn + opt.after.quarters,
        id: decision.id,
        optionId: opt.id,
        memo,
      });
    }
    return text;
  }

  /**
   * 답하지 않고 분기를 넘긴 사건을 정산한다. 무대응도 선택이라, 조용히 사라지게
   * 두면 "고르지 않는 것"이 언제나 최선의 수가 된다.
   */
  function resolveOpenDecision(s, rng) {
    if (!s.decision) return;
    const opt = Decisions.fallbackOf(s.decision.id);
    if (!opt) {
      s.decision = null;
      return;
    }
    applyDecisionOption(s, s.decision, opt, rng);
    s.decision = null;
  }

  /** 예약된 지연 결과 중 이번 분기 몫을 정산한다. */
  function resolvePendingOutcomes(s, rng, opts) {
    // 종료 정산에서는 기한이 남은 것까지 전부 닫는다 — 미뤄 둔 대가가 게임이
    // 끝난다는 이유로 사라지면 종료 직전의 선택이 언제나 공짜가 된다.
    const final = !!(opts && opts.final);
    const due = (s.pendingOutcomes || []).filter((x) => final || x.turn <= s.turn);
    if (!due.length) return;
    s.pendingOutcomes = final ? [] : s.pendingOutcomes.filter((x) => x.turn > s.turn);
    for (const item of due) {
      const opt = Decisions.optionOf(item.id, item.optionId);
      const def = Decisions.get(item.id);
      if (!opt || !opt.after || !def) continue;
      const memo = item.memo || {};
      const out = opt.after.apply(s, decisionHelpers(s, rng, memo, { final }));
      // 결과가 { text, retryIn } 을 내면 아직 끝난 게 아니라 미뤄진 것이다.
      // 조건이 안 맞았다고 그냥 버리면 상환 의무 같은 약속이 공짜로 사라진다.
      const text = typeof out === 'string' ? out : out && out.text;
      // 종료 정산에서는 다시 예약해 봐야 정산할 분기가 없다. 이때 retryIn 이 돌아온다면
      // 그 선택지가 h.final 을 보고 결말을 내지 않았다는 뜻이고, 약속은 여기서 사라진다.
      if (!final && out && typeof out === 'object' && out.retryIn > 0) {
        s.pendingOutcomes.push({ turn: s.turn + out.retryIn, id: item.id, optionId: item.optionId, memo });
      }
      if (text) pushLog(s, 'event', `[${def.name}] ${text}`);
    }
  }

  function rollEvents(s, rng) {
    const fired = [];

    const helpersFor = (rng) => ({
      rng,
      fmt: fmtMoney,
      reputation: (d) => adjustReputation(s, d),
      income: (amt) => {
        s.cash += amt;
        s.pending.revenue += amt;
      },
      expense: (amt) => {
        s.cash -= amt;
        s.pending.overhead += amt;
      },
      delayCert: (p, quarters) => delayCertification(p, quarters),
      pickWeighted: (arr, weightOf) => {
        const w = arr.map((x) => Math.max(1e-4, weightOf(x)));
        const total = w.reduce((a, b) => a + b, 0);
        let r = rng.next() * total;
        for (let i = 0; i < arr.length; i++) {
          r -= w[i];
          if (r <= 0) return arr[i];
        }
        return arr[arr.length - 1];
      },
    });

    // 충격은 일정표대로 온다. 무작위 추첨보다 먼저 적용해 그 분기의 시장 상태
    // (수요·유가)가 곧바로 반영되게 한다.
    for (const slot of (s.shocks || []).filter((x) => x.turn === s.turn)) {
      const def =
        slot.kind === 'historical'
          ? HISTORICAL.find((h) => (h.id || 'hist-' + h.turn) === slot.id)
          : FICTIONAL_SHOCKS.find((f) => f.id === slot.id);
      if (!def) continue;
      const text = def.apply(s, helpersFor(rng));
      fired.push({ id: slot.id, name: def.name, text, shock: slot.kind });
      pushLog(s, 'event', `[${def.name}] ${text}`);
      if (isInsolvent(s)) return fired;
    }

    // 분기당 0~2건. 초반 몇 분기는 조용하게 둔다.
    if (s.turn < 3) return fired;
    let draws = rng.chance(0.55) ? 1 : 0;
    if (rng.chance(0.15)) draws++;

    for (let i = 0; i < draws; i++) {
      // weight 는 숫자 또는 상태 함수 — 결함처럼 발생 빈도가 게임 상태에 따라
      // 달라져야 하는 이벤트가 있다.
      const weightOf = (e) => (typeof e.weight === 'function' ? e.weight(s) : e.weight);
      const pool = EVENTS.filter((e) => (!e.condition || e.condition(s)) && weightOf(e) > 0);
      if (!pool.length) break;
      const totalW = pool.reduce((a, e) => a + weightOf(e), 0);
      let r = rng.next() * totalW;
      const chosen = pool.find((e) => (r -= weightOf(e)) <= 0) || pool[0];

      const text = chosen.apply(s, helpersFor(rng));
      fired.push({ id: chosen.id, name: chosen.name, text });
      pushLog(s, 'event', `[${chosen.name}] ${text}`);

      // 한 분기에 이벤트가 둘 이상 뽑힐 수 있다. 첫 이벤트가 회사를 지급불능으로
      // 만들었는데 계속 추첨하면, 뒤이은 지원금이 파산을 되돌린다.
      if (isInsolvent(s)) break;
    }
    return fired;
  }

  // ─────────────────────────────── 시나리오 ───────────────────────────────

  /**
   * 시나리오 목표의 진행도와 판정. 화면(개요 카드·종료 화면)과 종료 정산이 같이 쓴다.
   *
   *   progress/target : 진행도 막대용 숫자
   *   achieved        : 목표 자체를 채웠나 (파산 여부는 종료 정산이 따로 본다)
   *   failed          : 되돌릴 수 없이 실패했나 (무결점의 첫 운항 정지처럼)
   *   finalOnly       : 종료 시점에만 판정이 서는 목표 (점수·무결점) — 중간 기념이 없다
   */
  function scenarioStatus(s) {
    const scen = s.scenario ? SCENARIOS.find((x) => x.id === s.scenario) : null;
    if (!scen) return null;
    const out = { id: scen.id, name: scen.name, goalText: scen.goalText, failed: false, finalOnly: false };
    switch (scen.id) {
      case 'wide_dream': {
        // 인수 기종의 승계 인도분은 전 주인의 실적이다 — 인수 이후 우리가 인도한 몫만 센다.
        out.progress = s.programs
          .filter((p) => p.segment === 'wide')
          .reduce((a, p) => a + Math.max(0, (p.delivered || 0) - (p.acquiredDelivered || 0)), 0);
        // 목표치는 데이터에 산다 — 캘리브레이션이 data.js 만 만지면 되도록.
        out.target = scen.targetDelivered;
        out.unit = '기';
        break;
      }
      case 'phoenix': {
        // 잿더미의 증명은 점수가 아니라 인도다 — 회생 증자를 써도 기체는 진짜다.
        out.progress = s.stats.delivered;
        out.target = scen.targetDelivered;
        out.unit = '기';
        break;
      }
      case 'red_star': {
        // 서랍에서 물려받은 그 프로그램이라야 한다 — 이름으로 찾는다(시딩이 고정한다).
        const ssj = s.programs.find((p) => p.name === scen.targetProgramName);
        out.progress = ssj ? ssj.delivered || 0 : 0;
        out.target = scen.targetDelivered;
        out.unit = '기';
        // 목표 전에 팔거나 접었으면 끝이다 — 도면이 없는 꿈은 이룰 수 없다.
        // 목표를 채운 뒤에는 무엇이 일어나든 기록을 무르지 않는다. (양산 기종은
        // 현재 규칙상 매각할 수 없어 사실상 도달하지 않는 경로지만, 판정은 상태
        // 어디서 와도 옳아야 한다 — 세이브 수술이나 미래 기능이 이 가드를 믿는다.)
        out.failed = (!ssj || ssj.phase === 'sold' || ssj.phase === 'cancelled') && out.progress < out.target;
        break;
      }
      case 'clean_sheet': {
        out.finalOnly = true;
        out.progress = s.stats.delivered;
        out.target = scen.targetDelivered;
        out.unit = '기';
        // 운항 정지는 되돌릴 수 없다 — 첫 번째에 시나리오가 끝난다.
        out.failed = (s.stats.majorDefects || 0) > 0;
        break;
      }
      case 'successor': {
        // 백지 설계라야 한다 — 파생·승계·인수는 후계가 아니라 연명이다.
        const clean = s.programs.filter(
          (p) => p.segment === 'narrow' && !p.derivedFrom && !p.legacy && !p.acquired && p.certTurn !== null && p.certTurn !== undefined,
        );
        out.progress = clean.length ? Math.max(...clean.map((p) => p.delivered || 0)) : 0;
        out.target = scen.targetDelivered;
        out.unit = '기';
        break;
      }
      default:
        return null;
    }
    out.achieved = !out.failed && out.progress >= out.target;
    return out;
  }

  /**
   * 시나리오 분기 판정 — 단조 증가 목표는 채우는 순간 기념한다.
   * 최종 성패는 종료 정산이 확정한다: 파산하면 어떤 목표든 실패다.
   */
  function tickScenario(s) {
    const st = scenarioStatus(s);
    if (!st) return;
    // 표식은 분기 번호라 0 도 유효하다 — truthiness 로 보면 턴 0 의 판정이 매 분기 다시 남는다.
    if (st.failed && s.scenarioFailedTurn === undefined) {
      s.scenarioFailedTurn = s.turn;
      pushLog(s, 'bad', `[시나리오 · ${st.name}] 목표가 무너졌다 — ${st.goalText}은(는) 더 이상 이룰 수 없다.`);
      return;
    }
    if (!st.finalOnly && st.achieved && s.scenarioAchievedTurn === undefined) {
      s.scenarioAchievedTurn = s.turn;
      pushLog(s, 'good', `[시나리오 · ${st.name}] 목표 달성! ${st.goalText} — 이제 이 판은 기록으로 남는다. 종료까지 파산만 피하면 된다.`);
    }
  }

  /** 종료 정산 — 성패를 확정해 gameOver 에 싣는다. 파산은 무조건 실패다. */
  function settleScenario(s, bankrupt) {
    const st = scenarioStatus(s);
    if (!st) return null;
    return { id: st.id, name: st.name, goalText: st.goalText, progress: st.progress, target: st.target, unit: st.unit, achieved: !bankrupt && st.achieved };
  }

  /** 남은 차입 여유까지 끌어와도 음수면 지급불능. */
  function isInsolvent(s) {
    return s.cash + Math.max(0, CONFIG.maxDebt - s.debt) < 0;
  }

  /** 지급불능 판정 — 종료됐으면 true. */
  function checkBankrupt(s, lastTurnOverride) {
    if (s.gameOver) return true;
    // 부채가 한도에 1M 못 미친 채 이벤트로 현금이 -741M 이 된 상태도 잡아야 하므로
    // debt >= maxDebt 가 아니라 "남은 여유까지 합쳐 음수인가"로 본다.
    if (isInsolvent(s)) {
      const lastTurn = typeof lastTurnOverride === 'number' ? lastTurnOverride : s.turn;
      s.gameOver = { reason: 'bankrupt', lastTurn, ...finalScore(s, true), scenario: settleScenario(s, true) };
      pushLog(s, 'bad', '자금이 완전히 고갈되고 차입 한도도 소진됐다. 회사는 법정관리에 들어간다.');
      return true;
    }
    return false;
  }

  function finishGame(s) {
    if (s.gameOver) return;
    // turn 은 이미 다음 인덱스(80)로 올라가 있다. 그대로 표시하면 존재하지 않는
    // 2018년 1분기가 뜨므로, 마지막으로 경영한 분기를 따로 남긴다.
    const lastTurn = Math.max(0, s.turn - 1);
    s.gameOver = { reason: 'complete', lastTurn, ...finalScore(s, false), scenario: settleScenario(s, false) };
    s.log.unshift({
      turn: lastTurn,
      label: turnLabel(lastTurn),
      kind: 'info',
      text: '20년의 경영이 끝났다. 최종 성적을 정산한다.',
    });
  }

  // ─────────────────────────────── 파생 지표 ───────────────────────────────

  function totalBacklog(s) {
    return s.backlog.reduce((a, o) => a + o.remaining, 0);
  }

  function backlogValue(s) {
    // 선수금 확대로 계약한 주문은 이미 30%를 받았다. 고정 15%로 빼면 남은 대금을
    // 계약가의 15%만큼 부풀려 보여 준다. 조건이 없던 옛 주문만 기본값을 쓴다.
    return s.backlog.reduce(
      (a, o) => a + o.remaining * o.unitPrice * (1 - (typeof o.depositRate === 'number' ? o.depositRate : CONFIG.depositRate)),
      0,
    );
  }

  /** 인도된 군용 특수기 대수 — 민항 시장 통계에서 빼야 하는 몫. */
  function govDelivered(s) {
    return Object.values((s.fleets || {}).gov || {}).reduce((a, b) => a + b, 0);
  }

  function marketShare(s) {
    // 군용 인도는 민항 시장 밖이다 — 경쟁사 물량이 민항 카탈로그에서만 나오므로,
    // 특수기까지 세면 점유율·순위·이사회 목표가 군 계약만으로 공짜로 오른다.
    const mine = Math.max(0, s.stats.delivered - govDelivered(s));
    const total = mine + s.stats.rivalDelivered;
    return total > 0 ? mine / total : 0;
  }

  /**
   * 신용등급 — 부채비율과 최근 수익성에서 산출해 차입 금리에 직접 연동한다.
   * 초반에 한도까지 당겨쓰면 이자가 비싸져 더 빨리 마르고, 흑자를 내면 조달이 싸진다.
   * 재무가 "차입 한도까지는 공짜"에서 "쓸수록 비싸지는 자원"으로 바뀐다.
   */
  const RATINGS = [
    { grade: 'AA', mult: 0.78 },
    { grade: 'A', mult: 0.88 },
    { grade: 'BBB', mult: 1.0 },
    { grade: 'BB', mult: 1.14 },
    { grade: 'B', mult: 1.3 },
    { grade: 'CCC', mult: 1.5 },
  ];

  function creditRating(s) {
    // 신용평가는 청산가치(netWorth)가 아니라 계속기업 가치로 본다. 개발 중인
    // 프로그램에 넣은 돈은 곧 형식증명을 받을 자산이지 사라진 돈이 아니다.
    // 이걸 빼면 개발 기간 내내(= 게임의 본편) 자동으로 최하등급이 되어,
    // 가장 현금이 마른 시점에 이자까지 올리는 사망 나선이 만들어진다.
    // 인증에 성공한 순간 이 값이 0이 되면, 현금도 자산도 그대로인데 등급만 떨어져
    // 이자가 오른다. 양산 전이는 자산이 사라지는 사건이 아니므로 인도량에 따라
    // 상각한다(약 300기에 걸쳐 소멸) — 회계상 개발비 자본화와 같은 취급이다.
    const programValue = s.programs
      // 매각한 프로그램은 대금을 이미 현금으로 받았다. 자산으로도 계속 세면 같은
      // 가치를 두 번 세어 등급이 부당하게 올라가고 이자가 싸진다.
      .filter((p) => p.phase !== 'cancelled' && p.phase !== 'sold')
      .reduce((a, p) => {
        const amortized = p.phase === 'production' ? Math.max(0, 1 - p.delivered / 300) : 1;
        return a + p.spent * 0.6 * amortized;
      }, 0);
    const equity = Math.max(1, netWorth(s) + programValue);
    // 부채/자기자본은 자기자본이 얇아지면 발산해, 어려운 회사를 자동으로 CCC로 밀어
    // 이자까지 올리는 사망 나선을 만든다. 0~1로 유계인 부채비율을 쓴다.
    const leverage = s.debt / (s.debt + equity);
    // 최근 4분기 손익 평균을 자기자본 대비로 본다.
    // 개발비 차감 전 손익으로 본다 — 신제품에 투자 중인 회사를 적자로 읽지 않도록.
    // rd 가 없던 옛 이력은 net 안에 개발비가 그대로 들어 있어, 그대로 쓰면
    // 세이브를 불러온 것만으로 등급이 떨어진다. 복원할 수 없는 값이므로 제외한다.
    const recent = s.history.slice(-4).filter((h) => typeof h.rd === 'number');
    const profit = recent.length ? recent.reduce((a, h) => a + h.net + h.rd, 0) / recent.length : 0;
    const profitability = profit / equity;

    // 0(최악) ~ 1(최고) 점수로 합성.
    const levScore = clamp(1 - leverage / 0.75, 0, 1);
    const proScore = clamp(0.5 + profitability * 12, 0, 1);
    const score = levScore * 0.65 + proScore * 0.35;

    const idx = Math.min(RATINGS.length - 1, Math.floor((1 - score) * RATINGS.length));
    return RATINGS[idx];
  }

  /**
   * 이번 분기에 실제로 적용될 이자율 — 기본금리 × 신용등급 배수 + 신용경색 가산.
   * 정산과 화면이 반드시 같은 값을 쓰도록 여기 한 곳에만 둔다. 화면이 따로
   * 계산하면 등급이 BBB 가 아닐 때 표시와 청구가 어긋난다.
   */
  function interestRate(s) {
    // 가산(위기·목표 미달)과 감면(차환)은 슬롯을 따로 쓴다. 한 칸을 공유하면
    // 차환 0.25%p 감면이 금융위기 1.2%p 가산을 통째로 지워 버리고, 남은 기간 동안
    // 오히려 할인 금리가 된다.
    const bump = s.effects.rateBumpQuarters > 0 ? s.effects.rateBump : 0;
    const discount = s.effects.rateCutQuarters > 0 ? s.effects.rateCut : 0;
    const base = CONFIG.interestPerQuarter * creditRating(s).mult;
    return Math.max(CONFIG.interestPerQuarter * 0.4, base + bump - discount);
  }

  /** 이번 분기에 실제로 청구될 이자율 — 분기 시작 시 고정된 값. 화면은 이걸 보여준다. */
  function quarterRate(s) {
    return typeof s.rateForQuarter === 'number' ? s.rateForQuarter : interestRate(s);
  }

  /** 그 이자율을 만든 등급. 지금 차입해도 이번 분기 청구는 이 등급 기준이다. */
  function quarterGrade(s) {
    return typeof s.ratingForQuarter === 'string' ? s.ratingForQuarter : creditRating(s).grade;
  }

  /**
   * 이 기종의 지금 대당 생산원가 — 학습곡선 + 조달 전략까지 반영한 값.
   * 화면과 정산이 반드시 같은 값을 쓰도록 여기 한 곳에만 둔다. 화면이 따로
   * 계산하면 외주 수준에 따라 최대 9% 어긋난 마진을 보고 가격을 정하게 된다.
   */
  function currentUnitCost(s, p) {
    const sourcing = OUTSOURCING[s.outsourcing] || OUTSOURCING.mid;
    // 생산 루프는 p.produced 를 먼저 올리고 그 번호로 원가를 매기므로,
    // "다음에 만들 1기"의 원가는 produced+1 번째다. 가격 결정은 이 값을 봐야 한다.
    return unitCostAt(p.unitCostBase, p.produced + 1, unitPremium(s)) * sourcing.costMult;
  }

  function netWorth(s) {
    const assetValue =
      s.programs.reduce((a, p) => a + p.stock * p.unitCostBase, 0) +
      // 라인 자산은 **실제로 치른 건설비**의 40%다. 등급 배수를 빼고 세그먼트
      // 기준가로 매기면, $1.54B 짜리 고속 라인과 $634M 짜리 재래식 라인이 똑같이
      // $352M 로 잡혀 비싼 등급을 고를수록 신용등급·최종점수가 손해를 본다.
      s.lines.reduce((a, l) => {
        const p = s.programs.find((x) => x.id === l.programId);
        if (!p) return a;
        const paid = typeof l.paidCost === 'number' ? l.paidCost : SEGMENTS[p.segment].lineCost;
        return a + paid * 0.4;
      }, 0);
    // 자체 금융으로 넘긴 대금은 아직 못 받았을 뿐 우리 자산이다. 빼면 vendor 금융을
    // 쓰는 순간 순자산·신용등급이 실제보다 나빠져, 조건을 고를 이유가 사라진다.
    const receivable = (s.receivables || []).reduce((a, r) => a + r.amount, 0);
    return s.cash + assetValue + receivable - s.debt;
  }

  /**
   * 인도 점수의 급별 가중 — 리저널기와 광동체가 같은 1기일 수는 없다.
   * 협동체가 종전 계수(1.2) 그대로라, 협동체 중심의 기존 판 점수·등급 문턱은
   * 움직이지 않는다. 광동체 가중은 사다리를 오른 값의 마지막 몫이다.
   */
  const DELIVERED_SCORE_WEIGHT = { regional: 0.7, narrow: 1.2, wide: 3.2 };

  function deliveredScore(s) {
    return s.programs.reduce((a, p) => a + (p.delivered || 0) * (DELIVERED_SCORE_WEIGHT[p.segment] ?? 1.2), 0);
  }

  /**
   * 순자산 항목을 뺀 제조사 점수 — 통합 모드 전용.
   *
   * 그룹 성적은 자본을 **연결 기준으로 한 번만** 센다. 제조사 점수의 순자산 항목과
   * 항공사 점수의 자본 성장 항목을 그대로 더하면 같은 돈이 두 번 세어지고, 게다가
   * 계열 간 값을 어떻게 매기느냐로 두 항목의 비중이 갈린다 — 이전가격으로 성적을
   * 만들 길이 열린다. 여기 남는 것은 계열 간 거래가 닿지 않는 항목뿐이다.
   */
  function operatingScore(s) {
    const ownership = 1 - (s.equityDilution || 0);
    // **자회사에 넘긴 대수는 뺀다.** 시장에서 이긴 것이 아니라 왼손이 오른손에 준
    // 것이다 — 안 빼면 자기한테 팔아 점유율과 인도 점수를 만들 수 있다.
    const inHouse = (s.stats && s.stats.inHouseDelivered) || 0;
    const mine = Math.max(0, s.stats.delivered - govDelivered(s) - inHouse);
    const total = mine + s.stats.rivalDelivered;
    const share = total > 0 ? mine / total : 0;
    // 급별 가중이 다르므로 프로그램마다 그 프로그램의 가중으로 뺀다.
    const delivered = s.programs.reduce(
      (acc, p) =>
        acc +
        Math.max(0, (p.delivered || 0) - (p.inHouseDelivered || 0)) * (DELIVERED_SCORE_WEIGHT[p.segment] ?? 1.2),
      0,
    );
    return Math.round((delivered + share * 4000 + s.reputation * 12) * ownership * (s.scoreMult || 1));
  }

  function finalScore(s, bankrupt) {
    const share = marketShare(s);
    const worth = netWorth(s);
    // 증자로 살아남았다면 그만큼은 우리 성과가 아니다. 회생 수단이 공짜가 되면
    // "위험해지면 찍어낸다"가 언제나 정답이 된다.
    const ownership = 1 - (s.equityDilution || 0);
    // 회사 환산 배수 — 보잉으로 시작한 판의 점수를 데네브 눈금에 맞춘다.
    // 거인의 출발선은 이미 절반의 승리라, 그대로 재면 등급이 난이도표가 아니라
    // 회사 선택표가 된다.
    const score = Math.round(
      (deliveredScore(s) + share * 4000 + Math.max(0, worth) * 0.08 + s.reputation * 12) * ownership * (s.scoreMult || 1),
    );
    // 파산은 아무리 많이 팔았어도 실패다 — 등급으로 성적을 덮지 않는다.
    // 문턱은 시뮬레이션으로 잡는다. 회생 수단이 생기기 전에는 파산 아니면 A·S 뿐이라
    // B·C·D 가 한 판도 안 나왔고, 지분 희석이 들어온 뒤 중간 등급이 생겼다.
    // 지금 값은 "웬만큼 하는 플레이" 40판의 점수 분포(중앙값 약 5,000)에서 잡은 것이다.
    let grade = 'F';
    if (!bankrupt) {
      grade = 'D';
      if (score >= 7000) grade = 'S';
      else if (score >= 4600) grade = 'A';
      else if (score >= 3000) grade = 'B';
      else if (score >= 1700) grade = 'C';
    }
    return { score, grade, share, worth, delivered: s.stats.delivered };
  }

  /** 최종 점수를 만든 항목들. 등급만 던지면 무엇을 잘하고 못했는지가 남지 않는다. */
  function scoreBreakdown(s) {
    const share = marketShare(s);
    const worth = netWorth(s);
    const own = 1 - (s.equityDilution || 0);
    const rows = [
      { label: '누적 인도', detail: `${s.stats.delivered}기 (급별 가중 — 광동체 ×3.2)`, points: Math.round(deliveredScore(s)) },
      { label: '시장 점유율', detail: `${(share * 100).toFixed(1)}% × 4,000`, points: Math.round(share * 4000) },
      { label: '순자산', detail: `${fmtMoney(Math.max(0, worth))} × 0.08`, points: Math.round(Math.max(0, worth) * 0.08) },
      { label: '평판', detail: `${Math.round(s.reputation)} × 12`, points: Math.round(s.reputation * 12) },
    ];
    if (own < 1) {
      const gross = rows.reduce((a, r) => a + r.points, 0);
      rows.push({
        label: '지분 희석',
        detail: `증자 ${s.equityRounds}회 · 우리 몫 ${(own * 100).toFixed(0)}%`,
        points: Math.round(gross * own) - gross,
      });
    }
    const mult = s.scoreMult || 1;
    if (mult !== 1) {
      const gross = rows.reduce((a, r) => a + r.points, 0);
      rows.push({
        label: '회사 환산',
        detail: `${s.company} 출발선 보정 ×${mult}`,
        points: Math.round(gross * mult) - gross,
      });
    }
    return rows;
  }

  /**
   * 20년 회고 — 종료 화면이 읽는 경영 요약.
   *
   * 상태에서 그때그때 계산한다. 종료 시점에 통째로 얼려 저장하면 세이브가 커지고,
   * 옛 세이브를 불러왔을 때 없는 필드가 되어 화면이 비어 버린다.
   */
  function careerReport(s) {
    const hist = s.history || [];
    const settled = hist.filter((h) => typeof h.net === 'number');
    const best = settled.reduce((a, h) => (!a || h.net > a.net ? h : a), null);
    const worst = settled.reduce((a, h) => (!a || h.net < a.net ? h : a), null);
    const peakShare = hist.reduce(
      (a, h) => (typeof h.share === 'number' && h.share > a ? h.share : a),
      Math.max(s.stats.peakShare || 0, marketShare(s)),
    );
    const peakDebt = hist.reduce((a, h) => (h.debt > a ? h.debt : a), Math.max(s.stats.peakDebt || 0, s.debt));
    const totalRevenue = settled.reduce((a, h) => a + h.revenue, 0);
    const totalRd = settled.reduce((a, h) => a + (h.rd || 0), 0);

    const programs = s.programs
      .map((p) => ({
        name: p.name,
        segment: SEGMENTS[p.segment].name,
        seats: p.seats,
        range: p.range,
        phase: p.phase,
        legacy: !!p.legacy,
        engineName: p.engineName || null,
        // 승계 기종의 launchTurn 은 음수다(-40 = 1988년). 0으로 누르면 새 판마다
        // "DN-150 1998년 1분기 착수"라는 틀린 연표가 된다.
        launched: turnLabel(p.launchTurn ?? 0),
        launchTurn: p.launchTurn ?? 0,
        delivered: p.delivered || 0,
        backlog: s.backlog.filter((o) => o.programId === p.id).reduce((a, o) => a + o.remaining, 0),
      }))
      .sort((a, b) => b.delivered - a.delivered || a.launchTurn - b.launchTurn);

    // 항공사가 아닌 선단 주인들 — 원시 키('gov')가 보고서에 그대로 새면 안 된다.
    // 특수기 선단은 기관별로 쪼개지 않고 한 계정으로 묶는다(지원 수익 정산 단위).
    // 'state' 는 국영 항공사 발주 계정이다 — 군('gov')과 달리 **민항 선단**이라
    // 점유율에도 애프터마켓 단골에도 정상적으로 들어간다. 여기서는 이름만 준다.
    const FLEET_OWNER_NAMES = { gov: '정부·군 (특수기)', state: '국영 항공사', lessor: '국제 리스사', leasing: '글로벌 리스' };
    const customers = Object.entries(s.fleets || {})
      .map(([airlineId, byProgram]) => {
        const airline = AIRLINES.find((a) => a.id === airlineId);
        return {
          id: airlineId,
          name: airline ? airline.name : FLEET_OWNER_NAMES[airlineId] || airlineId,
          units: Object.values(byProgram).reduce((a, n) => a + n, 0),
          relation: Math.round(s.relations[airlineId] ?? 0),
        };
      })
      .filter((c) => c.units > 0)
      .sort((a, b) => b.units - a.units);

    return {
      best,
      worst,
      peakShare,
      peakDebt,
      totalRevenue,
      totalRd,
      programs,
      customers,
      standings: makerStandings(s),
      duels: duelRecords(s),
      breakdown: scoreBreakdown(s),
      history: hist,
    };
  }

  /**
   * 현재 인력 배분 기준으로 개발 완료까지 남은 분기 수.
   * 설계 시 표시되는 "예상 N분기"는 인력이 100% 충족됐을 때의 값이라,
   * 실제로는 훨씬 오래 걸릴 수 있다. 그 간극을 플레이어에게 정직하게 보여준다.
   */
  function projectedQuarters(s, p) {
    if (p.phase !== 'dev') return 0;
    if (p.share <= 0) return Infinity; // 동결
    const active = s.programs.filter((x) => x.phase === 'dev' && x.share > 0);
    const totalShare = active.reduce((a, x) => a + x.share, 0);
    if (!totalShare) return Infinity;
    const allocated = s.engineers * (p.share / totalShare);
    const effective = Math.min(1.4, allocated / p.engineersNeeded);
    if (effective <= 0) return Infinity;
    const gain = (100 / p.devQuarters) * effective;
    return Math.ceil((100 - p.progress) / gain);
  }

  /** 현재 열린 RFP에 대해 입찰 가능한 기종 목록 */
  /**
   * 응찰 가능 단계 — 양산 중이거나 **인증 심사 중**(설계 동결, 시제기 비행 중).
   *
   * 선주문은 실제 항공업의 자금 구조다: 787 은 초도비행 전에 800대를 팔았고
   * 그 선수금이 인증을 먹여 살렸다. 게임에서도 광동체 개발 막바지 — 부채 한도에
   * 목이 졸리는 바로 그 구간 — 을 선수금으로 버티는 게 사다리의 마지막 칸이다.
   * 미인증 기체는 입찰 점수에서 신뢰 감점을 받는다(bidding.js).
   */
  function biddablePhase(p) {
    // 개발 40%부터 — 설계가 잡히고 항공사에 팔 수 있는 구체적 제원이 나온 시점.
    // A350 XWB 가 실물 없이 팔린 게 이 단계다. 멀수록 감점이 크다(bidding.js).
    return p.phase === 'production' || p.phase === 'cert' || (p.phase === 'dev' && p.progress >= 40);
  }

  function eligiblePrograms(s, rfp) {
    return s.programs
      .filter((p) => biddablePhase(p) && p.segment === rfp.segment)
      .map((p) => ({ program: p, score: scoreBid(s, rfp, p, s.bids[rfp.id]?.discount ?? 0) }));
  }

  /**
   * 이 공고에 애초에 제출이 가능한가 — 해당 세그먼트 양산 기종이 있고, 그중 하나라도
   * 제원 실격을 면하는가. 무응찰 감점(resolveBids)과 UI 확인창이 같은 기준을 쓰도록
   * 여기 한 곳에만 둔다. 둘이 갈라지면 대응 불가능한 공고로 사용자를 괴롭히게 된다.
   */
  function canBid(s, rfp) {
    // 감점·확인창의 기준은 **양산 기종**이다. 선주문(개발·인증 중)은 응찰할 수 있는
    // 선택지일 뿐 의무가 아니다 — 종이 비행기를 안 팔았다고 관계가 깎이면, 개발이
    // 40%를 넘는 순간부터 모든 해당 세그먼트 공고가 벌금 고지서가 된다.
    return s.programs.some(
      (p) => p.phase === 'production' && p.segment === rfp.segment && !scoreBid(s, rfp, p, 0).blocked,
    );
  }

  root.AirlinerEngine = {
    newGame,
    placeInHouseOrder,
    inHouseQuote,
    operatingScore,
    dropAirlineRfps,
    cancelInHouseOrders,
    PLAYABLE_COMPANIES,
    launchProgram,
    companyExperience,
    companyTrait,
    homeAirlines,
    launchAidRate,
    designContext,
    derivativeSpec,
    programSpec,
    investQuality,
    investWindTunnel,
    WIND_TUNNEL_COST_RATE,
    investLaunchAid,
    engineDealContext,
    LAUNCH_AID_RATE,
    LAUNCH_AID_ROYALTY,
    LAUNCH_AID_PAYBACK,
    ENGINE_DEAL_REBATE,
    ENGINE_DEAL_QUARTERS,
    TRADE_TARIFF_RATE,
    addTestAircraft,
    delayCertification,
    startEarlyEtops,
    startForeignCert,
    startLocalEngine,
    fundLocalEngine,
    cancelLocalEngine,
    localEngineSpec,
    localEngineTargets,
    localEngineCost,
    localEngineQuarters,
    turnLabel,
    localEngineImpact,
    localEnginePreview,
    hasDomesticEngine,
    foreignCertSpec,
    foreignCertified,
    testAircraftCost,
    certQuartersLeft,
    cancelProgram,
    voidRefundFor,
    buildLine,
    retoolLine,
    retoolCompatibility,
    setOutsourcing,
    upgradeAftermarket,
    startFreighter,
    startUpgrade,
    UPGRADES,
    loyaltyTier,
    serviceIncome,
    flushTerminalQuarter,
    researchContext,
    startResearch,
    stopResearch,
    acquireProgram,
    rollMarketNews,
    scenarioStatus,
    closeLine,
    toggleLine,
    sellStock,
    hireEngineers,
    borrow,
    repay,
    raiseEquity,
    equityCapacity,
    sellProgram,
    mandateStatus,
    cashRunway,
    setBid,
    setBidTerms,
    decide,
    endTurn,
    eligiblePrograms,
    canBid,
    totalBacklog,
    backlogValue,
    marketShare,
    netWorth,
    currentUnitCost,
    effectiveOutput,
    creditRating,
    interestRate,
    quarterRate,
    quarterGrade,
    finalScore,
    careerReport,
    scoreBreakdown,
    makerStandings,
    duelRecords,
    projectedQuarters,
    ensureShape,
    addToFleet,
    fmtMoney,
    turnLabel,
    yearOf,
    buildShockSchedule,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
