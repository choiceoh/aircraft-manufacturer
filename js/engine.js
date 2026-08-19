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
    RIVAL_DRIFT_LIMIT,
  } = root.AirlinerData;
  const { MANUFACTURERS, AIRCRAFT, availableTypes, typeScore } = root.AirlinerFleet;
  const { evaluate, unitCostAt, clamp } = root.AirlinerDesign;
  const { generateRfps, scoreBid, resolveBid, normalizeTerms } = root.AirlinerBidding;
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

  function newGame(seed, companyName) {
    const s = {
      version: 1,
      seed: seed >>> 0,
      rngState: seed >>> 0,
      company: companyName || '데네브 항공우주',
      turn: 0,
      nextId: 1,
      cash: CONFIG.startCash,
      debt: CONFIG.startDebt,
      reputation: CONFIG.startReputation,
      engineers: CONFIG.startEngineers,
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
      competitors: newCompetitors(),
      rfps: [],
      bids: {},
      log: [],
      history: [],
      stats: {
        delivered: 0,
        revenue: 0,
        rivalDelivered: 240,
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
      // 5년 단위 이사회 목표. newGame 에서 첫 목표를 발령한다.
      mandate: null,
      // 증자 횟수와 누적 지분 희석 — 최종 점수에서 그만큼 우리 몫이 아니다.
      equityRounds: 0,
      equityDilution: 0,
      // 조달 전략 — 원가 ↔ 공급 차질 위험.
      outsourcing: 'mid',
      // 이번 판의 충격 일정표 (역사 실현분 + 가상 대체분). newGame 에서 확정된다.
      shocks: [],
      gameOver: null,
    };
    for (const a of AIRLINES) s.relations[a.id] = 34 + (a.prestige < 0.8 ? 10 : 0);
    // 승계 부채가 봉우리의 출발점이다. 첫 정산 전에 갚아 버리면 이력에 한 번도 안 남는다.
    markDebtPeak(s);

    seedLegacyProgram(s);
    // 승계 선단(186기)이 들어온 **뒤에** 재야 시작 점유율(43.7%)이 잡힌다.
    s.stats.peakShare = marketShare(s);

    const rng = rngFor(s);
    s.shocks = buildShockSchedule(s, rng);
    issueMandate(s, rng);
    s.rfps = generateRfps(s, rng);
    s.ratingForQuarter = creditRating(s).grade;
    s.rateForQuarter = interestRate(s);
    saveRng(s, rng);

    pushLog(
      s,
      'info',
      `${s.company} 경영을 인계받았다. 자본금 ${fmtMoney(s.cash)}, 차입금 ${fmtMoney(s.debt)}. 주력기 DN-150이 아직 현금을 벌어다 주지만, 설계는 이미 낡았다.`,
    );
    pushLog(s, 'info', '20년 안에 후속기를 띄워 시장을 잡아라. DN-150의 수명은 길지 않다.');
    return s;
  }

  /**
   * 시작 시점의 "노후 주력기". 이 게임의 출발점은 창업이 아니라 승계다.
   * 개발에는 5년 넘게 걸리는데 신생사는 그 사이 현금이 말라 죽으므로,
   * 플레이어에게 후속기 개발을 버텨낼 캐시카우를 쥐여준다.
   * 대신 연비가 낮아 유가가 오르거나 경쟁사가 신형을 내면 급속히 경쟁력을 잃는다.
   */
  function seedLegacyProgram(s) {
    // 1990년대 초 설계라 그 시절 엔진을 달고 있다 — 지금 기준으로는 연비가 처진다.
    const spec = { segment: 'narrow', seats: 150, range: 4800, tech: 38, material: 'aluminum', engine: 'cfm56-3', year: yearOf(0) };
    const ev = evaluate(spec);
    const p = {
      id: 'prog-' + s.nextId++,
      name: 'DN-150',
      ...ev,
      phase: 'production',
      progress: 100,
      spent: ev.devCost,
      certRemaining: 0,
      qualityInvests: 1,
      share: 0,
      produced: 186, // 이미 학습곡선을 상당히 내려온 상태
      delivered: 186,
      stock: 0,
      launchTurn: -40,
      certTurn: -8,
      derivedFrom: null,
      legacy: true,
    };
    // 오랜 운용으로 초기 결함은 대부분 잡혔다.
    p.defectRisk = Math.round(p.defectRisk * 0.7 * 1000) / 1000;
    s.programs.push(p);

    s.lines.push({
      id: 'line-' + s.nextId++,
      programId: p.id,
      capacity: SEGMENTS.narrow.lineMaxRate,
      ramp: 1,
      partial: 0,
      idle: false,
      builtTurn: -8,
    });

    s.stats.delivered = p.delivered;

    // 인계받은 수주 잔고 — 초반 몇 년치 현금흐름.
    // 이미 인도된 186기 중 상당수가 이 두 항공사에 있다. 선단 공통성 가산이 여기서
    // 시작되므로, 이 두 계정은 지켜야 할 자산이고 나머지는 새로 뚫어야 할 시장이다.
    // (남은 물량은 이미 퇴역했거나 더는 기체를 사지 않는 사업자에게 있다고 본다.)
    s.fleets = { panamer: { [p.id]: 62 }, hanul: { [p.id]: 48 } };

    for (const o of [
      { id: 'panamer', name: '판아메르 항공', qty: 24 },
      { id: 'hanul', name: '한울항공', qty: 16 },
    ]) {
      s.backlog.push({
        id: 'ord-' + s.nextId++,
        airlineId: o.id,
        airlineName: o.name,
        programId: p.id,
        programName: p.name,
        qty: o.qty,
        remaining: o.qty,
        unitPrice: Math.round(p.listPrice * 0.92 * 10) / 10,
        wonTurn: -4,
      });
      s.relations[o.id] = 58;
    }
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
  function newCompetitors() {
    return MANUFACTURERS.map((m) => ({
      id: m.id,
      name: m.name,
      // drift 는 이벤트가 얹는 보정치, reaction 은 우리 성적에 대한 가격 공세다.
      // 한 칸을 같이 쓰면 반격의 감쇠가 이벤트 보정을 지우고, 이벤트가 준 마이너스
      // 보정은 반격 로직의 감쇠 경로에 걸리지 않아 영원히 남는다.
      drift: { regional: 0, narrow: 0, wide: 0 },
      reaction: { regional: 0, narrow: 0, wide: 0 },
    }));
  }

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
      s.competitors = newCompetitors();
    }
    for (const c of s.competitors) {
      if (!c.reaction) c.reaction = {};
      for (const seg of ['regional', 'narrow', 'wide']) {
        if (typeof c.drift[seg] !== 'number') c.drift[seg] = 0;
        if (typeof c.reaction[seg] !== 'number') c.reaction[seg] = 0;
      }
    }
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

  /** 인도된 기체를 항공사 선단에 올린다 — 이후 그 항공사 입찰에서 공통성 가산이 붙는다. */
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
      if (p.legacy || p.certTurn === null || p.certTurn === undefined) continue;
      const pts = EXPERIENCE_POINTS[p.segment] || 1;
      xp += p.derivedFrom ? pts * 0.5 : pts;
    }
    return xp;
  }

  /** 신규 프로그램 착수. 착수금(개발비의 8%)을 즉시 지출한다. */
  function launchProgram(s, spec, name) {
    const evalSpec = evaluate({ ...spec, year: yearOf(s.turn), experience: companyExperience(s) });
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
      certTurn: null,
      // 호환성 판정을 통과했을 때만 원형 연결을 남긴다. 원형에서 소재·기술·항속을
      // 갈아엎어 신규 설계 비용을 전액 낸 설계에 파생형 딱지가 붙으면 안 된다.
      derivedFrom: evalSpec.derivative ? spec.derivedFrom : null,
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

  /** 파생형 착수용 설계 시드 — 원형의 기술/소재를 물려받는다. */
  function derivativeSpec(base, seatDelta) {
    const seg = SEGMENTS[base.segment];
    return {
      segment: base.segment,
      seats: clamp(base.seats + seatDelta, seg.seats.min, seg.seats.max),
      range: base.range,
      tech: base.tech,
      material: base.material,
      fuselage: base.fuselage,
      wingMat: base.wingMat,
      engine: base.engine,
      abreast: base.abreast,
      wing: base.wing,
      fuelMargin: base.fuelMargin,
      etops: base.etops,
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
    line.capacity = Math.max(1, Math.round(seg.lineMaxRate * grade.rateMult));
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
    p.stock -= n;
    p.delivered += n;
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
    tickEtopsService(s);
    // 경쟁사 인도도 이 분기 몫으로 집계한다. 다음 분기 준비 단계에서 굴리면
    // 플레이어는 80분기, 경쟁사는 79분기가 되어 점유율이 늘 유리해진다.
    simulateRivals(s, rng);
    settleFinance(s, report);

    s.stats.peakShare = Math.max(s.stats.peakShare || 0, marketShare(s));

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
        if (!p.etopsCertified) {
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
  function enterCertification(s, p, report) {
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

      if (p.progress >= 100) enterCertification(s, p, report);
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
      line.ramp = Math.min(1, line.ramp + CONFIG.rampPerQuarter * grade.rampMult);
      const raw = line.capacity * line.ramp * mult + line.partial;
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
        cost += unitCostAt(p.unitCostBase, p.produced) * sourcing.costMult;
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
      if (o.reqEtops && !p.etopsCertified) continue;

      const n = Math.min(o.remaining, p.stock);
      // 선수금을 이미 받은 만큼을 뺀 잔금이 인도 대금이다.
      const balance = n * o.unitPrice * (1 - (typeof o.depositRate === 'number' ? o.depositRate : CONFIG.depositRate));
      const financing = BID_FINANCING[o.financing] || BID_FINANCING.normal;
      const now = balance * financing.onDelivery;
      const later = balance - now;
      const revenue = now;
      o.remaining -= n;
      p.stock -= n;
      p.delivered += n;
      addToFleet(s, o.airlineId, p.id, n);
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
      CONFIG.fixedOverheadPerQuarter +
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
      const pool = availableTypes(seg, year);
      if (!pool.length) continue;
      const segWeight = SEGMENT_UNIT_SHARE[seg];
      // 요구사양 없이 부르면 적합도 감점 없는 순수 카탈로그 실력이다.
      // 이벤트 보정치(drift)까지 얹어야 입찰과 같은 실력으로 나뉜다 — 빼면 "인도가
      // 대거 지연됐다"는 소식이 뜬 회사의 인도량이 그대로인 모순이 생긴다.
      const powers = pool.map((type) => ({
        maker: type.maker,
        w: Math.pow(Math.max(0, typeScore(type, s.market.fuelIndex, null, null) + driftOf(s, type.maker, seg) - 30), 2),
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
    rows.push({ id: 'us', name: s.company, delivered: s.stats.delivered, us: true });
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

      // 그 시장에서 지금 가장 강한 제조사가 공세의 주체다.
      const pool = availableTypes(seg, year);
      let leader = null;
      for (const t of pool) {
        // 입찰·인도 배분과 같은 실력(보정치 포함)으로 봐야 한다. 카탈로그 점수만
        // 보면 "인도가 대거 지연됐다"는 악재를 맞은 회사가 반격의 주체로 뽑혀,
        // 실제로 수주전을 이기고 있는 쪽 대신 엉뚱한 회사에 공세 보너스가 붙는다.
        const power = typeScore(t, s.market.fuelIndex, null, null) + driftOf(s, t.maker, seg);
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
      const maker = MANUFACTURERS.find((m) => m.id === t.maker);
      if (!maker) continue;
      if (t.eis > prev && t.eis <= now) {
        news.push({
          kind: 'eis',
          text: `${maker.name} ${t.name} 취항 — ${SEGMENTS[t.segment].name} ${t.seats}석 · ${fmtNum(t.range)}km.`,
        });
      }
      if (t.end !== null && t.end > prev && t.end <= now) {
        news.push({ kind: 'end', text: `${maker.name} ${t.name} 신규 판매 종료.` });
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
      if (p.freighter) freight += (p.delivered || 0) * FREIGHTER.perUnit;
    }
    // 여객이 얼어붙어도 화물은 돈다. 침체기의 버팀목이 화물 사업의 존재 이유다.
    if (s.effects.demandSlumpQuarters > 0) freight *= FREIGHTER.slumpMult;

    const total = Math.round(after + freight);
    if (total <= 0) return;
    s.cash += total;
    s.stats.revenue += total;
    report.revenue += total;
    report.services = total;
  }

  /** 급별 단가로 계산한 선단의 분기 기본 서비스 수익 (투자 배수 적용 전). */
  function aftermarketBase(s) {
    return s.programs.reduce(
      (a, p) => a + (p.delivered || 0) * (AFTERMARKET_PER_UNIT_BY_SEG[p.segment] ?? AFTERMARKET_PER_UNIT),
      0,
    );
  }

  /** 화면이 읽는 서비스 수익 내역. */
  function serviceIncome(s) {
    const tier = AFTERMARKET_TIERS[s.aftermarket] || AFTERMARKET_TIERS.none;
    const fleet = s.programs.reduce((a, p) => a + (p.delivered || 0), 0);
    const after = aftermarketBase(s) * tier.mult;
    let freight = s.programs.filter((p) => p.freighter).reduce((a, p) => a + (p.delivered || 0) * FREIGHTER.perUnit, 0);
    if (s.effects.demandSlumpQuarters > 0) freight *= FREIGHTER.slumpMult;
    return { fleet, aftermarket: after, freight, total: after + freight, tier };
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
    const active = new Set(availableTypes(seg, year).map((t) => t.maker));
    const candidates = s.competitors.filter((c) => active.has(c.id));
    const buyer =
      (candidates.length
        ? candidates.reduce((a, b) => ((b.drift[seg] || 0) < (a.drift[seg] || 0) ? b : a))
        : s.competitors[0]) || null;
    // 도면 인수는 일회성 실력 상승이다 — 가격 공세(reaction)가 아니라 이벤트 보정에 얹는다.
    if (buyer) buyer.drift[seg] = Math.min(RIVAL_DRIFT_LIMIT, (buyer.drift[seg] || 0) + 2);
    const buyerName = buyer ? (MANUFACTURERS.find((m) => m.id === buyer.id) || {}).name || buyer.id : '경쟁사';

    pushLog(s, 'bad', `${p.name} 프로그램을 ${fmtMoney(value)}에 매각했다. 도면은 ${buyerName}로 넘어갔다.`);
    return { ok: true, value, buyer: buyerName };
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
   * "판아메르가 제안했는데 코스모와 계약됐다" 같은 어긋남이 생긴다.
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
        s.effects.grounded[programId] = Math.max(s.effects.grounded[programId] || 0, quarters);
      },
      /** 결정으로 성사된 수주. 입찰을 거치지 않으므로 착수금도 여기서 받는다. */
      order: ({ airlineId, airlineName, program, qty, unitPrice }) => {
        const deposit = Math.round(qty * unitPrice * CONFIG.depositRate);
        s.cash += deposit;
        s.pending.revenue += deposit;
        s.stats.ordersWon += qty;
        s.pending.ordersWon = (s.pending.ordersWon || 0) + qty;
        s.backlog.push({
          id: 'ord-' + s.nextId++,
          airlineId,
          airlineName,
          programId: program.id,
          programName: program.name,
          qty,
          remaining: qty,
          unitPrice,
          wonTurn: s.turn,
        });
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
      s.gameOver = { reason: 'bankrupt', lastTurn, ...finalScore(s, true) };
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
    s.gameOver = { reason: 'complete', lastTurn, ...finalScore(s, false) };
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

  function marketShare(s) {
    const total = s.stats.delivered + s.stats.rivalDelivered;
    return total > 0 ? s.stats.delivered / total : 0;
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
    return unitCostAt(p.unitCostBase, p.produced + 1) * sourcing.costMult;
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

  function finalScore(s, bankrupt) {
    const share = marketShare(s);
    const worth = netWorth(s);
    // 증자로 살아남았다면 그만큼은 우리 성과가 아니다. 회생 수단이 공짜가 되면
    // "위험해지면 찍어낸다"가 언제나 정답이 된다.
    const ownership = 1 - (s.equityDilution || 0);
    const score = Math.round(
      (deliveredScore(s) + share * 4000 + Math.max(0, worth) * 0.08 + s.reputation * 12) * ownership,
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

    const customers = Object.entries(s.fleets || {})
      .map(([airlineId, byProgram]) => {
        const airline = AIRLINES.find((a) => a.id === airlineId);
        return {
          id: airlineId,
          name: airline ? airline.name : airlineId,
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
    launchProgram,
    companyExperience,
    derivativeSpec,
    investQuality,
    addTestAircraft,
    delayCertification,
    startEarlyEtops,
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
    serviceIncome,
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
