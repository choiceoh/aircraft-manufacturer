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
    LINE_GRADES,
    RETOOL_COST_RATE,
    OUTSOURCING,
    WING_MATERIALS,
    LEGACY_MATERIAL_MAP,
  } = root.AirlinerData;
  const { MANUFACTURERS } = root.AirlinerFleet;
  const { evaluate, unitCostAt, clamp } = root.AirlinerDesign;
  const { generateRfps, scoreBid, resolveBid } = root.AirlinerBidding;
  const { createRng } = root.AirlinerRng;

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
    const q = (turn % 4) + 1;
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
      stats: { delivered: 0, revenue: 0, rivalDelivered: 240, ordersWon: 0, bidsMade: 0 },
      // 분기 중 즉시 발생한 실적(재고 처분 등) — 다음 endTurn 리포트가 흡수한다.
      pending: { revenue: 0, delivered: 0, rdCost: 0, capex: 0, overhead: 0 },
      events: [],
      // 조달 전략 — 원가 ↔ 공급 차질 위험.
      outsourcing: 'mid',
      // 이번 판의 충격 일정표 (역사 실현분 + 가상 대체분). newGame 에서 확정된다.
      shocks: [],
      gameOver: null,
    };
    for (const a of AIRLINES) s.relations[a.id] = 34 + (a.prestige < 0.8 ? 10 : 0);

    seedLegacyProgram(s);

    const rng = rngFor(s);
    s.shocks = buildShockSchedule(s, rng);
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
      drift: { regional: 0, narrow: 0, wide: 0 },
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
    if (!s.pending) s.pending = { revenue: 0, delivered: 0, rdCost: 0, capex: 0, overhead: 0 };
    for (const k of ['revenue', 'delivered', 'rdCost', 'capex', 'overhead']) {
      if (typeof s.pending[k] !== 'number') s.pending[k] = 0;
    }
    if (!s.stats) s.stats = { delivered: 0, revenue: 0, rivalDelivered: 240, ordersWon: 0, bidsMade: 0 };
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

    // ETOPS 개념이 없던 세이브의 장거리 기종에 자격을 준다. 그러지 않으면 이미
    // 완성된 광동체가 9,000km 이상 노선에서 전부 실격되는데, 소급 취득 수단이 없다.
    for (const p of s.programs) {
      if (p.etops === undefined) p.etops = p.range >= ETOPS_RANGE_KM;
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
      for (const seg of ['regional', 'narrow', 'wide']) {
        if (typeof c.drift[seg] !== 'number') c.drift[seg] = 0;
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

  /** 신규 프로그램 착수. 착수금(개발비의 8%)을 즉시 지출한다. */
  function launchProgram(s, spec, name) {
    const evalSpec = evaluate({ ...spec, year: yearOf(s.turn) });
    const upfront = Math.round(evalSpec.devCost * CONFIG.launchUpfrontRate);
    if (s.cash < upfront) {
      return { ok: false, error: `착수금 ${fmtMoney(upfront)}이 부족합니다.` };
    }
    if (s.programs.filter((p) => p.phase === 'dev' || p.phase === 'cert').length >= 3) {
      return { ok: false, error: '동시에 개발 가능한 프로그램은 3개까지입니다.' };
    }

    const program = {
      id: 'prog-' + s.nextId++,
      name: name || `${SEGMENTS[evalSpec.segment].name}-${s.programs.length + 1}`,
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
    const p = s.programs.find((x) => x.id === programId);
    if (!p || p.phase === 'production' || p.phase === 'cancelled') {
      return { ok: false, error: '취소할 수 없는 프로그램입니다.' };
    }
    p.phase = 'cancelled';
    adjustReputation(s, -4);
    pushLog(s, 'bad', `${p.name} 개발 중단. 매몰비용 ${fmtMoney(p.spent)}, 업계 신뢰가 흔들린다.`);
    return { ok: true };
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
  function retoolLine(s, lineId, targetProgramId) {
    const line = s.lines.find((l) => l.id === lineId);
    if (!line) return { ok: false, error: '라인을 찾을 수 없습니다.' };
    const from = s.programs.find((x) => x.id === line.programId);
    const to = s.programs.find((x) => x.id === targetProgramId);
    if (!to || to.phase !== 'production') return { ok: false, error: '양산 가능한 기종이 아닙니다.' };
    if (to.id === line.programId) return { ok: false, error: '이미 그 기종의 라인입니다.' };
    if (from === undefined || from.abreast === undefined || to.abreast === undefined) {
      return { ok: false, error: '동체 단면을 알 수 없어 치구 재활용 여부를 판단할 수 없습니다.' };
    }
    if (from.abreast !== to.abreast) {
      return { ok: false, error: '동체 단면이 달라 치구를 재활용할 수 없습니다. 새 라인을 세워야 합니다.' };
    }

    const seg = SEGMENTS[to.segment];
    const grade = LINE_GRADES[line.grade] || LINE_GRADES.standard;
    const cost = Math.round(seg.lineCost * grade.costMult * RETOOL_COST_RATE);
    if (s.cash < cost) return { ok: false, error: `전환 비용 ${fmtMoney(cost)}이 부족합니다.` };

    ensureShape(s);
    s.cash -= cost;
    s.pending.capex += cost;
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
    pushLog(s, 'info', `${fmtMoney(take)} 차입. 총 부채 ${fmtMoney(s.debt)}.`);
    return { ok: true };
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
  function setBid(s, rfpId, programId, discount) {
    if (!programId) {
      delete s.bids[rfpId];
      return { ok: true };
    }
    s.bids[rfpId] = { programId, discount: clamp(discount, 0, CONFIG.maxDiscount) };
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
    const report = {
      label: turnLabel(s.turn),
      revenue: s.pending.revenue,
      productionCost: 0,
      rdCost: s.pending.rdCost,
      capex: s.pending.capex,
      overhead: s.pending.overhead,
      interest: 0,
      delivered: s.pending.delivered,
      ordersWon: 0,
    };
    s.pending = { revenue: 0, delivered: 0, rdCost: 0, capex: 0, overhead: 0 };

    resolveBids(s, rng, report);
    advanceDevelopment(s, rng, report);
    runProduction(s, report);
    runDeliveries(s, report);
    // 경쟁사 인도도 이 분기 몫으로 집계한다. 다음 분기 준비 단계에서 굴리면
    // 플레이어는 80분기, 경쟁사는 79분기가 되어 점유율이 늘 유리해진다.
    simulateRivals(s, rng);
    settleFinance(s, report);

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
      finishGame(s);
      saveRng(s, rng);
      return { ok: true, report };
    }

    tickEffects(s);
    driftMarket(s, rng);
    s.events = rollEvents(s, rng);
    s.rfps = generateRfps(s, rng);
    s.bids = {};

    // 다음 분기에 적용될 이자율과 등급을 지금 함께 확정한다. 둘을 따로 두면
    // 분기 중 차입으로 등급만 바뀌어 "등급 B · 이자율 1.60%(=BBB 값)" 같은
    // 자기모순이 화면에 뜬다.
    s.ratingForQuarter = creditRating(s).grade;
    s.rateForQuarter = interestRate(s);

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
      if (!program || program.phase !== 'production') continue;

      const score = scoreBid(s, rfp, program, bid.discount);
      if (score.blocked) continue;
      queued.push({ rfp, program, score });
    }

    // 2단계: 고정된 점수로 판정하고 보상·감점을 적용한다.
    for (const airlineId of noBidAirlines) {
      s.relations[airlineId] = clamp((s.relations[airlineId] ?? 40) - 1.5, 0, 100);
    }
    for (const { rfp, program, score } of queued) {
      s.stats.bidsMade++;
      const result = resolveBid(s, rfp, { score }, rng);
      s.relations[rfp.airlineId] = clamp((s.relations[rfp.airlineId] ?? 40) + 2, 0, 100);

      if (result.outcome === 'lose') {
        pushLog(
          s,
          'bad',
          `${rfp.airlineName} ${rfp.qty}기 수주 실패 — ${result.rivalName}에 밀렸다. (우리 ${score.total} vs ${result.rivalScore})`,
        );
        continue;
      }

      const unitPrice = score.price;
      const deposit = Math.round(result.qty * unitPrice * CONFIG.depositRate);
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
      });

      const verb = result.outcome === 'win' ? '단독 수주' : '분할 수주';
      pushLog(
        s,
        'good',
        `${rfp.airlineName} ${verb}! ${program.name} ${result.qty}기, 대당 ${fmtMoney(unitPrice)} (총 ${fmtMoney(result.qty * unitPrice)}). 선수금 ${fmtMoney(deposit)} 입금.`,
      );
    }
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
      // 착수금으로 이미 낸 몫을 빼고 남은 개발비만 진행도에 비례해 집행한다.
      // (전액을 다시 배분하면 실제 지출이 표시된 총 개발비의 108%가 된다.)
      const spend = p.devCost * (1 - CONFIG.launchUpfrontRate) * ((p.progress - before) / 100);
      p.spent += spend;
      s.cash -= spend;
      report.rdCost += spend;

      if (p.progress >= 100) {
        p.phase = 'cert';
        pushLog(s, 'program', `${p.name} 설계 동결 및 초도 비행 성공. 형식증명 심사에 들어간다 (예상 ${p.certRemaining}분기).`);
      }
    }

    // 개발 루프에서 방금 cert로 전환된 프로그램은 제외한다. 포함하면 개발에 그 분기를
    // 다 쓰고도 인증 1분기가 함께 지나가, 3분기짜리 인증이 실제로는 2분기에 끝난다.
    for (const p of certifyingBefore) {
      // 인증 지연 — 결함 위험이 높은 설계(고기술·복합재·미성숙 엔진)일수록 심사에서
      // 제동이 걸린다. 품질 투자는 이 확률을 함께 낮춘다.
      // 이 판정이 없으면 기술 슬라이더는 "비싸지만 확정된 이득"이라 도박이 아니게 된다.
      if (rng.chance(clamp(p.defectRisk * 0.26, 0.01, 0.12))) {
        const delay = rng.int(1, 2);
        const cost = Math.round(p.devCost * 0.03 * delay);
        p.certRemaining += delay;
        p.spent += cost;
        s.cash -= cost;
        report.rdCost += cost;
        pushLog(
          s,
          'bad',
          `${p.name} 형식증명 심사에서 설계 변경 요구가 나왔다. ${delay}분기 지연, 대응 비용 ${fmtMoney(cost)}.`,
        );
        // continue 로 아래 감소분까지 건너뛰면 "1분기 지연"이 실제로는 2분기가 된다.
        // 이번 분기 심사는 정상적으로 소진되고, 순증이 delay 만큼이어야 광고와 맞는다.
      }

      p.certRemaining -= 1;
      if (p.certRemaining <= 0) {
        p.phase = 'production';
        p.certTurn = s.turn;
        adjustReputation(s, 5);
        pushLog(
          s,
          'good',
          `${p.name} 형식증명 취득! 이제 조립 라인을 세워 양산할 수 있다. (정가 ${fmtMoney(p.listPrice)}, 연비지수 ${p.efficiency})`,
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
    // 오래된 수주부터 인도한다.
    const orders = s.backlog.filter((o) => o.remaining > 0).sort((a, b) => a.wonTurn - b.wonTurn);
    for (const o of orders) {
      const p = s.programs.find((x) => x.id === o.programId);
      if (!p || p.stock <= 0) continue;
      if ((s.effects.grounded[p.id] || 0) > 0) continue;

      const n = Math.min(o.remaining, p.stock);
      const revenue = n * o.unitPrice * (1 - CONFIG.depositRate);
      o.remaining -= n;
      p.stock -= n;
      p.delivered += n;
      addToFleet(s, o.airlineId, p.id, n);
      s.cash += revenue;
      s.stats.delivered += n;
      s.stats.revenue += revenue;
      report.revenue += revenue;
      report.delivered += n;

      if (o.remaining === 0) {
        adjustReputation(s, 1);
        // 취소분을 빼야 실제 인도량이다. o.qty 를 쓰면 10기 중 5기가 취소되고 5기만
        // 인도돼도 "10기 인도 완료"로 기록돼 경영 기록이 실적과 어긋난다.
        const shipped = o.qty - (o.cancelled || 0);
        pushLog(s, 'good', `${o.airlineName} ${o.programName} ${shipped}기 인도 완료. 잔금 정산.`);
      }
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
    const cost = p.rdCost + p.capex + p.overhead;
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
    });
    if (s.history.length > 120) s.history.shift();
    s.pending = { revenue: 0, delivered: 0, rdCost: 0, capex: 0, overhead: 0 };
  }

  function tickEffects(s) {
    const e = s.effects;
    if (e.strikeQuarters > 0) e.strikeQuarters--;
    if (e.supplyQuarters > 0) e.supplyQuarters--;
    if (e.demandSlumpQuarters > 0) e.demandSlumpQuarters--;
    if (e.demandBoomQuarters > 0) e.demandBoomQuarters--;
    if (e.fuelShockQuarters > 0) e.fuelShockQuarters--;
    if (e.rateBumpQuarters > 0) {
      e.rateBumpQuarters--;
      // 기간이 끝나면 가산폭도 함께 지운다. 남겨두면 나중에 약한 경색이
      // 재발할 때 max() 병합이 만료된 높은 값을 되살린다.
      if (e.rateBumpQuarters === 0) e.rateBump = 0;
    }
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
  function checkBankrupt(s) {
    if (s.gameOver) return true;
    // 부채가 한도에 1M 못 미친 채 이벤트로 현금이 -741M 이 된 상태도 잡아야 하므로
    // debt >= maxDebt 가 아니라 "남은 여유까지 합쳐 음수인가"로 본다.
    if (isInsolvent(s)) {
      s.gameOver = { reason: 'bankrupt', lastTurn: s.turn, ...finalScore(s, true) };
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
    return s.backlog.reduce((a, o) => a + o.remaining * o.unitPrice * (1 - CONFIG.depositRate), 0);
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
      .filter((p) => p.phase !== 'cancelled')
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
    return (
      CONFIG.interestPerQuarter * creditRating(s).mult +
      (s.effects.rateBumpQuarters > 0 ? s.effects.rateBump : 0)
    );
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
    return s.cash + assetValue - s.debt;
  }

  function finalScore(s, bankrupt) {
    const share = marketShare(s);
    const worth = netWorth(s);
    const score = Math.round(
      s.stats.delivered * 1.2 + share * 4000 + Math.max(0, worth) * 0.08 + s.reputation * 12,
    );
    // 파산은 아무리 많이 팔았어도 실패다 — 등급으로 성적을 덮지 않는다.
    let grade = 'F';
    if (!bankrupt) {
      grade = 'D';
      if (score >= 5200) grade = 'S';
      else if (score >= 3600) grade = 'A';
      else if (score >= 2400) grade = 'B';
      else if (score >= 1400) grade = 'C';
    }
    return { score, grade, share, worth, delivered: s.stats.delivered };
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
  function eligiblePrograms(s, rfp) {
    return s.programs
      .filter((p) => p.phase === 'production' && p.segment === rfp.segment)
      .map((p) => ({ program: p, score: scoreBid(s, rfp, p, s.bids[rfp.id]?.discount ?? 0) }));
  }

  /**
   * 이 공고에 애초에 제출이 가능한가 — 해당 세그먼트 양산 기종이 있고, 그중 하나라도
   * 제원 실격을 면하는가. 무응찰 감점(resolveBids)과 UI 확인창이 같은 기준을 쓰도록
   * 여기 한 곳에만 둔다. 둘이 갈라지면 대응 불가능한 공고로 사용자를 괴롭히게 된다.
   */
  function canBid(s, rfp) {
    return s.programs.some(
      (p) => p.phase === 'production' && p.segment === rfp.segment && !scoreBid(s, rfp, p, 0).blocked,
    );
  }

  root.AirlinerEngine = {
    newGame,
    launchProgram,
    derivativeSpec,
    investQuality,
    cancelProgram,
    buildLine,
    retoolLine,
    setOutsourcing,
    closeLine,
    toggleLine,
    sellStock,
    hireEngineers,
    borrow,
    repay,
    setBid,
    endTurn,
    eligiblePrograms,
    canBid,
    totalBacklog,
    backlogValue,
    marketShare,
    netWorth,
    currentUnitCost,
    creditRating,
    interestRate,
    quarterRate,
    quarterGrade,
    finalScore,
    projectedQuarters,
    ensureShape,
    addToFleet,
    fmtMoney,
    turnLabel,
    yearOf,
    buildShockSchedule,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
