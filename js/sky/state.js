/*
 * 항공사 계층의 상태 — 회사·노선·기재, 그리고 분기 정산.
 *
 * 이 게임의 본체(제조사)와 같은 규약을 따른다. 상태는 평범한 객체이고, 이 모듈은
 * DOM 을 모르며, 같은 시드에 같은 조작이면 같은 결과가 난다. 두 계층은 **한 세계**를
 * 공유한다 — 유가와 경기는 제조사 쪽 `s.market` 에서 받아 온다(`syncWorld`).
 *
 * sky-tycoon 에서 옮기면서 잘라낸 것: 화물·주식과 인수전·리스·객실 등급·부대사업·
 * 광고·공항 확장. 남긴 것은 **없으면 게임이 무너지는 것**이다 — 슬롯 임차료(놀려도
 * 나가는 고정비), 중정비 입고(예비기 한 대를 놀리는 값), 감가상각과 이자.
 */
(function (root) {
  'use strict';

  const Cities = root.AirlinerCities;
  const Types = root.AirlinerSkyTypes;
  const Econ = root.AirlinerSkyEconomics;
  const Market = root.AirlinerSkyMarket;
  const Fleet = root.AirlinerFleet;
  const Design = root.AirlinerDesign;
  const Data = root.AirlinerData;
  const createRng = root.AirlinerRng.createRng;

  const B = {
    /** 회사 유지 간접비 */
    OVERHEAD_FIXED: 1.6e6,
    OVERHEAD_PER_AIRCRAFT: 120000,
    OVERHEAD_PER_ROUTE: 18000,
    SERVICE_OPEX_PER_LEVEL_PER_PLANE: 32000,

    /** 기재는 15년(60분기)에 걸쳐 턴다 */
    DEPRECIATION_QUARTERS: 60,
    TAX_RATE: 0.4,

    /** 슬롯은 매입이 아니라 임차다 — 놀려도 매 분기 나간다 */
    SLOT_RENT_PER_QUARTER: 0.012e6,
    SLOT_BASE_PRICE: 0.12e6,
    SLOT_HOME_DISCOUNT: 0.6,

    BASE_INTEREST: 0.07,
    /** 자기자본 대비 차입 한도 */
    DEBT_CAP_EQUITY: 2.2,

    // ── 중정비 ──
    /** 비행시간 주기 */
    CHECK_INTERVAL_HOURS: 10000,
    /** 덜 굴려도 이 분기를 넘기면 들어간다 */
    CHECK_MAX_QUARTERS: 20,
    CHECK_MIN_QUARTERS: 5,
    /** 늙을수록 주기가 짧아진다 */
    CHECK_INTERVAL_AGE_DECAY: 0.0055,
    CHECK_INTERVAL_MIN_RATIO: 0.45,
    /** 한 번 값 = 정가 × 이 비율, 기령이 얹는다 */
    CHECK_COST_RATE: 0.06,
    CHECK_COST_AGE_SLOPE: 0.02,
    CHECK_WARN_RATIO: 0.82,

    /** 자본잠식이 이만큼 이어지면 접는다 */
    NEGATIVE_QUARTERS_TO_FOLD: 8,

    /**
     * 공항 처리 능력의 연 성장률.
     *
     * 슬롯 총량이 20년 내내 고정이면 세계가 곧바로 꽉 찬다 — 여행 수요는 해마다 오르는데
     * 활주로가 그대로이니 모든 노선이 만석이 되고, 모두가 운임 상한에서 돈을 찍는다.
     * 실제로 1998~2017년 세계 공항 처리 능력은 크게 늘었다. sky-tycoon 은 이것을
     * 플레이어가 돈을 대는 확장 공사로 풀지만, 여기서는 그 명령을 잘라냈으므로
     * **저절로 자라는 쪽**으로 둔다.
     */
    SLOT_GROWTH_PER_YEAR: 1.035,
  };

  /**
   * 1970년을 1.0 으로 두는 물가 지수.
   *
   * sky-tycoon 의 운임·원가 상수가 전부 1970년 명목가라 그 기준을 그대로 쓴다. 여기서
   * 1 부터 다시 세면 착륙료 $1,000 같은 1970년 값이 1998년에 그대로 청구되어 원가가
   * 3.8배 싸진다. 기체 값과의 척도 차이는 `FARE_SCALE` 하나로 맞춘다.
   */
  function inflationFor(year) {
    let v = 1;
    for (let y = 1970; y < year; y++) {
      v *= y < 1980 ? 1.07 : y < 1990 ? 1.045 : y < 2000 ? 1.028 : y < 2010 ? 1.025 : 1.02;
    }
    return v;
  }

  /** 항공유 가격 (USD/L, 명목). 제조사 쪽 유가 지수가 이 값을 흔든다. */
  function oilFor(year) {
    if (year < 1974) return 0.03;
    if (year < 1979) return 0.092;
    if (year < 1986) return 0.26;
    if (year < 1990) return 0.155;
    if (year < 2000) return 0.21;
    if (year < 2008) return 0.48;
    return 0.8;
  }

  // ── 조회 ──

  const yearOf = (s, turn) => s.startYear + Math.floor((turn === undefined ? s.turn : turn) / 4);
  const quarterOf = (s, turn) => ((turn === undefined ? s.turn : turn) % 4) + 1;
  /**
   * 소수 연도. 카탈로그의 취항·단종 시점이 분기 단위(1998.25 = 1998년 2분기)라,
   * 정수 연도로 재면 그 해 2분기 취항 기종을 1분기에도 못 사거나 살 수 있게 된다.
   */
  const yearFracOf = (s) => s.startYear + s.turn / 4;
  const airline = (s, id) => s.airlines.find((a) => a.id === id) || null;
  const living = (s) => s.airlines.filter((a) => a.alive);
  const routesOf = (s, id) => s.routes.filter((r) => r.airlineId === id);
  const planesOf = (s, id) => s.planes.filter((p) => p.airlineId === id);
  /** 이 노선에 배속된 기재 — 중정비로 묶인 것까지 (배속 화면용). */
  const assignedTo = (s, routeId) => s.planes.filter((p) => p.routeId === routeId);
  /** 그중 **이번 분기에 실제로 뜨는** 기재. 좌석도 원가도 이 목록으로 센다. */
  const flyingOn = (s, routeId) => assignedTo(s, routeId).filter((p) => p.checkUntilTurn !== s.turn);
  const slotsAt = (a, city) => (a.slots || {})[city] || 0;

  /**
   * 이 공항의 지금 슬롯 총량. **다섯 군데서 각자 더하지 않는다** — 한 곳만 빠뜨려도
   * 확장된 공항에서 점유율이 1 을 넘는 식으로 조용히 어긋난다. 한 군데서 답한다.
   */
  function totalSlots(s, city) {
    return Math.round(Cities.get(city).slots * Math.pow(B.SLOT_GROWTH_PER_YEAR, yearOf(s) - s.startYear));
  }

  /** 이 회사가 이 도시에서 **다른 어디로 더 갈 수 있는가** — 환승 매력의 근거. */
  function feedCount(s, airlineId, city, selfRouteId) {
    let n = 0;
    for (const r of s.routes) {
      if (r.airlineId !== airlineId || !r.active || r.id === selfRouteId) continue;
      if (r.from === city || r.to === city) n++;
    }
    return n;
  }

  /**
   * 기종 표 — 경쟁 카탈로그와 플레이어 프로그램을 한 모양으로 모은다.
   *
   * 프로그램은 **양산에 들어간 것만** 넣는다. 개발 중이거나 형식증명 심사 중인 설계는
   * 아직 존재하지 않는 기체다 — 넣으면 항공사가 그걸 발주하고 노선에 붙인다.
   *
   * `sold` 도 뺀다. 이 게임에서 `sold` 는 "다 만들어 팔았다"가 아니라 **개발을 접고
   * 도면을 남에게 넘겼다**는 뜻이다(`sellProgram` 은 `dev`·`cert` 단계만 받는다).
   * 완성되지도 않았고 우리 것도 아니다.
   */
  const SELLABLE_PHASES = new Set(['production']);
  const sellable = (p) => !p.phase || SELLABLE_PHASES.has(p.phase);

  function typeTable(programs) {
    const out = {};
    for (const a of Fleet.AIRCRAFT) out[a.id] = Types.fromRival(a, Design.evaluate);
    for (const p of programs || []) if (sellable(p)) out[p.id] = Types.fromProgram(p);
    return out;
  }

  /**
   * 프로그램이 바뀌었으면 기종 표를 다시 만든다.
   *
   * 제조사 계층은 분기마다 프로그램을 띄우고 인증하고 개량한다. 표를 한 번 만들어 두고
   * 잊으면, 새로 나온 기체는 `typeOf` 가 `undefined` 를 돌려주고(발주·노선이 그 자리에서
   * 깨진다) 개량된 기체는 옛 값·옛 연비로 계속 굴러간다. 이미 굴러다니는 기재가 참조하는
   * 기종은 표에서 빠져도 남겨 둔다 — 단종은 "새로 못 산다"이지 "하늘에서 사라진다"가 아니다.
   */
  function refreshTypes(s, programs) {
    if (programs) s.programs = programs;
    const next = typeTable(s.programs);
    for (const p of s.planes) if (!next[p.typeId] && s.types[p.typeId]) next[p.typeId] = s.types[p.typeId];
    s.types = next;
    return s;
  }

  /** 시장·채산이 상태를 읽는 통로. 두 계층이 만나는 자리는 여기 하나다. */
  function marketContext(s) {
    const types = s.types || typeTable(s.programs);
    return {
      airlineOf: (id) => airline(s, id),
      planesOn: (routeId) => flyingOn(s, routeId),
      typeOf: (id) => types[id],
      slotsAt: (aid, city) => slotsAt(airline(s, aid) || {}, city),
      totalSlots: (city) => totalSlots(s, city),
      feedCount: (aid, city, selfRouteId) => feedCount(s, aid, city, selfRouteId),
      demand: (a, b) => demandFor(s, a, b),
      closed: (city) => isClosed(s.cityState[city] || {}, s.turn),
      inflation: s.world.inflation,
      oil: s.world.oil,
    };
  }

  /** 도시 성장·경기·일시 효과를 얹은 분기 수요. */
  function demandFor(s, a, b) {
    const ca = s.cityState[a.id] || {};
    const cb = s.cityState[b.id] || {};
    return root.AirlinerDemand.quarterly(a, b, {
      quarter: quarterOf(s),
      travelIndex: s.world.travelIndex,
      economy: s.world.economy,
      dev: { [a.id]: ca.dev, [b.id]: cb.dev },
      boost: { [a.id]: boostAt(ca, s.turn), [b.id]: boostAt(cb, s.turn) },
      closed: { [a.id]: isClosed(ca, s.turn), [b.id]: isClosed(cb, s.turn) },
    });
  }

  const isClosed = (cs, turn) => turn <= (cs.closedUntilTurn === undefined ? -1 : cs.closedUntilTurn);

  function boostAt(cs, turn) {
    let v = 1;
    for (const e of cs.effects || []) if (turn <= e.untilTurn) v *= e.mult;
    return Math.min(3, Math.max(0.2, v));
  }

  /** 양끝 중 한 곳이라도 닫혔으면 이 노선은 이번 분기에 안 뜬다. */
  function routeClosed(s, r) {
    return isClosed(s.cityState[r.from] || {}, s.turn) || isClosed(s.cityState[r.to] || {}, s.turn);
  }

  // ── 회계 ──

  function overhead(s, a) {
    const fleet = planesOf(s, a.id).length;
    const routes = routesOf(s, a.id).filter((r) => r.active).length;
    const base = B.OVERHEAD_FIXED + fleet * B.OVERHEAD_PER_AIRCRAFT + routes * B.OVERHEAD_PER_ROUTE;
    const service = fleet * a.serviceLevel * B.SERVICE_OPEX_PER_LEVEL_PER_PLANE;
    return (base + service) * s.world.inflation * Econ.BALANCE.FARE_SCALE;
  }

  /** 슬롯 한 자리의 분기 임차료. 큰 공항일수록, 남의 안방일수록 비싸다. */
  function slotRent(s, airlineId, cityId) {
    const c = Cities.get(cityId);
    const size = (c.standing + c.tour) / 100;
    const a = airline(s, airlineId);
    const home = a && a.home === cityId ? B.SLOT_HOME_DISCOUNT : 1;
    return B.SLOT_RENT_PER_QUARTER * size * c.fee * home * s.world.inflation * Econ.BALANCE.FARE_SCALE;
  }

  function slotRentTotal(s, a) {
    let sum = 0;
    for (const city of Object.keys(a.slots || {})) sum += a.slots[city] * slotRent(s, a.id, city);
    return sum;
  }

  /** 15년(60분기)을 다 굴려도 산 값의 이만큼은 남는다. */
  const RESIDUAL_FLOOR = 0.2;

  /** 기체 잔존가치 — 15년에 걸쳐 산 값의 20% 까지 내려간다. */
  function residual(type, ageQuarters, paid) {
    const left = Math.max(0, 1 - ageQuarters / B.DEPRECIATION_QUARTERS);
    return basis(type, paid) * (RESIDUAL_FLOOR + (1 - RESIDUAL_FLOOR) * left);
  }

  /**
   * 장부의 기준은 **산 값**이다. 정가로 재면 카탈로그가 움직일 때마다 이미 인도된
   * 기단의 자산가치와 상각비가 아무 거래 없이 따라 움직인다. 창업 기단처럼 값을
   * 안 새긴 기체는 정가로 돌린다.
   */
  function basis(type, paid) {
    return typeof paid === 'number' && paid > 0 ? paid : type.price;
  }

  function fleetValue(s, planes) {
    const types = s.types || typeTable(s.programs);
    return planes.reduce((sum, p) => sum + residual(types[p.typeId], p.ageQuarters, p.paid), 0);
  }

  /**
   * 감가상각 — **잔존가치 위의 몫만** 턴다.
   *
   * 장부가는 60분기에 걸쳐 산 값의 20% 까지만 내려가는데(잔존가치), 상각을 100% 로
   * 잡으면 실제 가치 하락(80%)보다 20% 를 더 비용으로 털어낸다. 76M 짜리 기체의
   * 장부가는 61M 만 떨어지는데 상각은 76M 이 나가는 식이다 — 순익이 그만큼 눌리고
   * 있지도 않은 손실에 절세 효과가 붙는다.
   */
  function depreciation(s, planes) {
    const types = s.types || typeTable(s.programs);
    return planes
      .filter((p) => p.ageQuarters < B.DEPRECIATION_QUARTERS)
      .reduce((sum, p) => sum + (basis(types[p.typeId], p.paid) * (1 - RESIDUAL_FLOOR)) / B.DEPRECIATION_QUARTERS, 0);
  }

  /**
   * 자기자본 = 현금 + 기재 + 슬롯 권리금 + **선급 발주** − 부채. 슬롯은 임차라 자산이 아니다.
   *
   * 발주 대금은 이미 현금에서 빠져나갔다. 인도 전까지 선급금으로 잡아 주지 않으면 대형
   * 발주 한 번에 자기자본이 두 분기 동안 발주액만큼 꺼졌다가 인도와 함께 되살아난다 —
   * 그동안 차입 한도가 깎이고 자본잠식으로 오인된다(3대 발주에 자본 2,724M → 1,558M).
   */
  function equity(s, a) {
    let slots = 0;
    for (const city of Object.keys(a.slots || {})) {
      const c = Cities.get(city);
      slots += a.slots[city] * B.SLOT_BASE_PRICE * ((c.standing + c.tour) / 100) * s.world.inflation * 0.5 * Econ.BALANCE.FARE_SCALE;
    }
    // 선급금은 **치른 값**으로 잡는다. 지금 카탈로그 값으로 다시 재면 인도 대기 중에
    // 정가가 오른 것만으로 자본이 불어난다. 옛 세이브(값을 안 새긴 발주)는 카탈로그로 돌린다.
    const prepaid = (s.orders || [])
      .filter((o) => o.airlineId === a.id)
      .reduce(
        (x, o) =>
          x + (typeof o.paid === 'number' ? o.paid : s.types[o.typeId] ? s.types[o.typeId].price * o.count : 0),
        0,
      );
    return a.cash + fleetValue(s, planesOf(s, a.id)) + slots + prepaid - a.debt;
  }

  function interestRate(s, a) {
    const eq = Math.max(1, equity(s, a));
    const lev = Math.min(3, a.debt / eq);
    return s.world.interest + 0.012 + lev * 0.015;
  }

  function debtCap(s, a) {
    return Math.max(0, equity(s, a) * B.DEBT_CAP_EQUITY);
  }

  // ── 중정비 ──

  const shrink = (age) => Math.max(B.CHECK_INTERVAL_MIN_RATIO, 1 - age * B.CHECK_INTERVAL_AGE_DECAY);
  const intervalHours = (age) => B.CHECK_INTERVAL_HOURS * shrink(age);
  const intervalQuarters = (age) => Math.max(B.CHECK_MIN_QUARTERS, Math.floor(B.CHECK_MAX_QUARTERS * shrink(age)));

  /** 다음 입고까지 얼마나 왔나 (1.0 이면 입고). 비행시간과 달력 중 먼저 차는 쪽이다. */
  function checkProgress(p) {
    return Math.max(0, Math.max(p.hoursSinceCheck / intervalHours(p.ageQuarters), p.quartersSinceCheck / intervalQuarters(p.ageQuarters)));
  }

  const checkDue = (p) => checkProgress(p) >= 1;
  const checkSoon = (p) => !checkDue(p) && checkProgress(p) >= B.CHECK_WARN_RATIO;

  function checkCost(s, p) {
    const types = s.types || typeTable(s.programs);
    return basis(types[p.typeId], p.paid) * B.CHECK_COST_RATE * (1 + p.ageQuarters * B.CHECK_COST_AGE_SLOPE);
  }

  /**
   * 이번 분기에 입고할 기재를 정한다. **시장이 열리기 전에** 불러야 한다 — 좌석이
   * 그만큼 줄어든 채로 분기가 굴러가야 하기 때문이다.
   */
  function scheduleChecks(s) {
    for (const p of s.planes) {
      if (p.checkUntilTurn === s.turn) continue;
      if (!checkDue(p)) continue;
      p.checkUntilTurn = s.turn;
      p.hoursSinceCheck = 0;
      p.quartersSinceCheck = 0;
    }
  }


  // ── 새 판 ──

  /**
   * 새 판을 연다. 12개 항공사가 모기지에서 짧은 노선망을 굴리고 있는 채로 시작한다 —
   * 첫 분기부터 판단할 거리가 있어야 하기 때문이다.
   *
   * 창업 설정(모기지·기단·슬롯)은 `js/data.js` 의 `AIRLINES` 에 있다. 제조사 게임이
   * 쓰는 그 표에 얹어 두어, 한 항공사가 두 계층에서 같은 회사이도록 했다.
   */
  function newGame(seed, opts) {
    const o = opts || {};
    const rng = createRng(seed);
    const startYear = o.startYear || 1998;
    const totalTurns = o.totalTurns || 80;
    const inflation = inflationFor(startYear);

    const cityState = {};
    for (const c of Cities.CITIES) {
      cityState[c.id] = { dev: Math.pow(c.growth, startYear - 1970), effects: [], closedUntilTurn: -1 };
    }

    const types = typeTable(o.programs);
    const airlines = [];
    const planes = [];
    let nextId = 1;

    for (const seed2 of Data.AIRLINES) {
      for (const typeId of Object.keys(seed2.startFleet)) {
        const t = eraEquivalent(types, typeId, startYear);
        // 시작 연도에 아직 안 나온 기종은 깔 수 없다. 예전에는 음수 기령이 2분기로
        // 잘려 1990년 판이 A330·777 을 물고 시작했다. 같은 급에서 그 시절에 있던
        // 기체로 바꿔 주고, 그런 것도 없으면 그 회사는 그만큼 작게 시작한다.
        if (!t) continue;
        // 취항 전에 만들어진 기체는 없다 — 1998년에 1996년 취항 기종을 6년 된 것으로
        // 깔면 정비비는 부풀고 자산가치는 깎인다.
        const oldest = Math.max(2, Math.min(26, Math.round((startYear - t.eis) * 4)));
        for (let i = 0; i < seed2.startFleet[typeId]; i++) {
          const age = rng.int(2, oldest);
          planes.push({
            id: nextId++,
            typeId: t.id,
            airlineId: seed2.id,
            ageQuarters: age,
            routeId: null,
            // 정비 시계를 흩어 놓는다. 전부 0 에서 출발하면 창업 기단이 통째로 같은
            // 분기에 입고돼 몇 해 뒤 노선망이 한꺼번에 주저앉는다.
            hoursSinceCheck: intervalHours(age) * rng.next() * 0.9,
            quartersSinceCheck: rng.int(0, intervalQuarters(age) - 1),
            checkUntilTurn: -1,
          });
        }
      }
      airlines.push({
        id: seed2.id,
        name: seed2.name,
        home: seed2.hub,
        // 위신이 곧 브랜드다 — 제조사 게임이 이미 매겨 둔 값을 그대로 쓴다.
        brand: Math.round(seed2.prestige * 34),
        serviceLevel: seed2.prestige >= 1 ? 4 : 3,
        safety: 1,
        cash: Math.round(300e6 * seed2.prestige * inflation),
        debt: 0,
        slots: Object.assign({}, seed2.startSlots),
        alive: true,
        negativeQuarters: 0,
        results: [],
        /**
         * 평생 누적 승객. `results` 는 화면용 80분기 창이라 그것만 더하면 20년보다 긴
         * 판에서 초반 수송량이 통째로 사라진다 — 최종 성적이 마지막 20년만 재게 된다.
         */
        lifetimePax: 0,
        // 창업 자본은 여기서 새긴다. 최종 성적이 이걸 기준으로 성장을 재는데, 나중에
        // 다시 세면 그동안의 성장이 기준에 섞여 배수가 늘 1 에 붙는다.
        startEquity: 0,
      });
    }

    const s = {
      seed,
      rngState: rng.getState(),
      turn: 0,
      startYear,
      totalTurns,
      world: {
        oil: oilFor(startYear),
        economy: 1,
        interest: B.BASE_INTEREST,
        travelIndex: root.AirlinerDemand.travelIndex(startYear),
        inflation,
      },
      cityState,
      airlines,
      routes: [],
      planes,
      nextId,
      programs: o.programs || [],
      types,
    };
    bootstrapRoutes(s, rng);
    for (const a of s.airlines) a.startEquity = equity(s, a);
    // 첫 분기의 입고도 판을 열 때 이미 정해져 있어야 한다.
    scheduleChecks(s);
    s.rngState = rng.getState();
    return s;
  }

  /**
   * 그 시절에 실제로 있던 같은 급 기체를 고른다.
   *
   * 창업 기단은 1998년을 보고 적어 둔 것이라, 시나리오 시작 연도를 앞당기면 아직 나오지
   * 않은 기종이 섞인다. 같은 급에서 그 시점에 살 수 있는 것 중 **가장 최신**을 쓴다 —
   * 창업 기단은 그 회사가 최근까지 사들인 기체라는 뜻이기 때문이다.
   */
  function eraEquivalent(types, typeId, year) {
    const want = types[typeId];
    if (!want) return null;
    const inService = (t) => t.eis <= year && (!t.end || t.end > year);
    if (inService(want)) return want;
    const alt = Object.keys(types)
      .map((id) => types[id])
      .filter((t) => t.segment === want.segment && !t.own && inService(t))
      .sort((x, y) => y.eis - x.eis || (x.id < y.id ? -1 : 1));
    return alt[0] || null;
  }

  /**
   * 창업 노선망 — 슬롯을 가진 도시로 모기지에서 노선을 편다.
   *
   * 가까운 곳부터 붙인다. 멀리부터 붙이면 광동체 한 대가 태평양에 묶여 나머지 슬롯이
   * 통째로 놀고, 회사가 첫 분기부터 간접비만 태운다.
   */
  function bootstrapRoutes(s, rng) {
    for (const a of s.airlines) {
      const pool = planesOf(s, a.id).slice();
      const targets = Object.keys(a.slots)
        .filter((c) => c !== a.home)
        .sort((x, y) => Cities.distance(a.home, x) - Cities.distance(a.home, y));

      for (const dest of targets) {
        if (!pool.length) break;
        const dist = Cities.distance(a.home, dest);
        const idx = pool.findIndex((p) => s.types[p.typeId].range >= dist * 1.05);
        if (idx < 0) continue;
        const plane = pool[idx];
        const cap = Econ.capacity([plane], dist, (t) => s.types[t]);
        if (!cap.usable) continue;
        const usedHome = s.routes
          .filter((r) => r.airlineId === a.id && (r.from === a.home || r.to === a.home))
          .reduce((x, r) => x + r.freq, 0);
        const usedDest = s.routes
          .filter((r) => r.airlineId === a.id && (r.from === dest || r.to === dest))
          .reduce((x, r) => x + r.freq, 0);
        const freq = Math.min(cap.maxFreq, slotsAt(a, a.home) - usedHome, slotsAt(a, dest) - usedDest, 10);
        if (freq <= 0) continue;
        pool.splice(idx, 1);
        const id = s.nextId++;
        plane.routeId = id;
        s.routes.push({
          id,
          airlineId: a.id,
          from: a.home,
          to: dest,
          fareMul: 1,
          freq,
          serviceExtra: 0,
          active: true,
          last: null,
        });
      }
    }
  }


  // ── 분기 정산 ──

  /**
   * 한 분기를 굴린다.
   *
   * **이번 분기의 중정비 입고는 지난 분기 끝에 이미 정해져 있다.** 여기서 정하면 AI 는
   * `beforeMarket` 에서 그걸 보고 예비기를 붙이는데, 플레이어는 화면을 볼 때 아직 멀쩡하던
   * 기재로 계획을 세운 뒤라 그 분기를 통째로 손해 본다 — 같은 정보를 같은 시점에 봐야 한다.
   */
  function advance(s, opts) {
    const o = opts || {};
    const rng = createRng(s.rngState);
    // 제조사 계층이 이번 분기에 무엇을 인증했는지 먼저 반영한다.
    refreshTypes(s, o.programs);
    if (o.beforeMarket) o.beforeMarket(s, rng);

    const outcomes = Market.resolveAll(s.routes, marketContext(s));
    settle(s, outcomes);
    // **기록을 남기기 전에** 급한 매각을 끝낸다. 뒤에 두면 현금이 마이너스인 채로
    // 기록되고 실제 잔액은 플러스가 되어, 화면의 재무 기록과 상태가 어긋난다.
    resolveDistress(s);
    snapshotBalances(s);

    ageFleet(s);
    deliverOrders(s);

    // 해가 바뀌는 경계에서 물가·성장·여행지수를 올린다 — 새해 첫 화면부터 새 값이 보이도록.
    if (s.turn + 1 < s.totalTurns && (s.turn + 1) % 4 === 0) yearTick(s);
    pruneEffects(s);
    s.turn += 1;
    // 다음 분기 입고를 지금 정한다. 화면이 열릴 때 이미 묶여 있어야 플레이어가
    // 예비기를 붙일 시간을 갖는다 — AI 도 같은 시점에 같은 것을 본다.
    scheduleChecks(s);
    s.rngState = rng.getState();
    return s;
  }

  function settle(s, outcomes) {
    for (const r of s.routes) r.last = null;

    for (const a of living(s)) {
      const planes = planesOf(s, a.id);
      let pax = 0;
      let seats = 0;
      let revenue = 0;
      const cost = { fuel: 0, crew: 0, maint: 0, landing: 0, nav: 0, paxService: 0, distribution: 0, total: 0 };

      for (const r of routesOf(s, a.id)) {
        const out = outcomes[r.id];
        const flying = flyingOn(s, r.id);
        if (!out || !flying.length) {
          r.last = { pax: 0, seats: 0, revenue: 0, cost: 0, share: 0, loadFactor: 0 };
          continue;
        }
        const dist = Cities.distance(r.from, r.to);
        const rc = Econ.routeCost(r, flying, {
          typeOf: (t) => s.types[t],
          oil: s.world.oil,
          inflation: s.world.inflation,
          serviceLevel: a.serviceLevel,
          pax: out.pax,
          revenue: out.revenue,
          closed: routeClosed(s, r),
        });

        // 이 노선이 물고 있는 슬롯의 임차료를 노선 손익에 얹는다. 임차료는 회사 단위로
        // 걷히지만 노선에 안 실으면 화면에도 AI 에게도 "조금 남는 노선"으로 보인다 —
        // 실제로는 슬롯값이 그보다 커서 회사를 갉아먹는데도. 주간 왕복 1회에 양 끝
        // 슬롯이 하나씩이므로 편수가 곧 점유 슬롯 수다.
        const occupied = r.freq * (slotRent(s, a.id, r.from) + slotRent(s, a.id, r.to));


        for (const k of Object.keys(cost)) cost[k] += rc[k] || 0;
        pax += out.pax;
        seats += out.seats;
        revenue += out.revenue;
        r.last = {
          pax: out.pax,
          seats: out.seats,
          revenue: out.revenue,
          cost: rc.total + occupied,
          share: out.share,
          loadFactor: out.loadFactor,
          connectPax: out.connectPax || 0,
        };
      }

      const checks = planes.filter((p) => p.checkUntilTurn === s.turn);
      const checkCostTotal = checks.reduce((x, p) => x + checkCost(s, p), 0);
      const over = overhead(s, a);
      // 슬롯은 임차라 매 분기 나간다 — 놀리는 슬롯도 그대로 청구된다.
      const rent = slotRentTotal(s, a);
      const dep = depreciation(s, planes);
      const interest = (a.debt * interestRate(s, a)) / 4;

      const pretax = revenue - cost.total - over - rent - dep - interest - checkCostTotal;
      const tax = pretax > 0 ? pretax * B.TAX_RATE : 0;
      const net = pretax - tax;
      // 감가상각은 현금이 나가지 않는다.
      a.cash += net + dep;

      const eq = equity(s, a);
      a.negativeQuarters = eq < 0 ? a.negativeQuarters + 1 : 0;
      // `|| 0` 으로 두면 카운터가 없던 옛 세이브에서 그때까지의 수송량이 통째로
      // 날아간다 — 마이그레이션 대체값(`lifetimePaxOf`)이 첫 정산에 덮인다.
      a.lifetimePax = lifetimePaxOf(a) + pax;
      a.results.push({
        turn: s.turn,
        revenue,
        fuel: cost.fuel,
        crew: cost.crew,
        maint: cost.maint,
        landing: cost.landing + cost.nav,
        paxService: cost.paxService,
        distribution: cost.distribution,
        checkCost: checkCostTotal,
        overhead: over,
        slotRent: rent,
        depreciation: dep,
        interest,
        tax,
        net,
        pax,
        seats,
        cash: a.cash,
        debt: a.debt,
        equity: eq,
        oil: s.world.oil,
      });
      if (a.results.length > 80) a.results.shift();
    }
  }

  /**
   * 급한 매각까지 끝난 뒤의 잔액을 이번 분기 기록에 다시 새긴다.
   *
   * 손익 항목(수입·연료·세금…)은 매각과 무관하니 그대로 두고, **잔액만** 고친다.
   * 매각 대금을 순익에 넣으면 노선이 돈을 번 것으로 보인다.
   */
  function snapshotBalances(s) {
    for (const a of living(s)) {
      const r = a.results[a.results.length - 1];
      if (!r || r.turn !== s.turn) continue;
      r.cash = a.cash;
      r.debt = a.debt;
      r.equity = equity(s, a);
    }
  }

  function ageFleet(s) {
    for (const p of s.planes) {
      p.ageQuarters += 1;
      if (p.checkUntilTurn === s.turn) continue;
      p.quartersSinceCheck += 1;
      const r = p.routeId === null ? null : s.routes.find((x) => x.id === p.routeId);
      if (!r || !r.active) continue;
      const dist = Cities.distance(r.from, r.to);
      const t = s.types[p.typeId];
      if (!Econ.canFly(t, dist)) continue;
      // 실제로 굴린 만큼만 시계가 돈다 — 세워 둔 기체는 달력으로만 늙는다.
      const flying = flyingOn(s, r.id);
      const freq = Econ.effectiveFreq(r, flying, dist, (x) => s.types[x], routeClosed(s, r));
      const hours = Econ.blockHoursByPlane(flying, freq, dist, (x) => s.types[x]);
      p.hoursSinceCheck += hours[p.id] || 0;
    }
  }

  /**
   * 발주 인도.
   *
   * `s.turn + 1` 로 잰다 — 이 함수는 분기가 넘어가기 **직전**에 돌므로, 인도 분기가
   * 시작될 때 기체가 이미 램프에 서 있으려면 한 칸 앞서 봐야 한다. `<= s.turn` 으로
   * 두면 "2분기 뒤 인도"가 실제로는 3분기가 걸린다.
   */
  function deliverOrders(s) {
    if (!s.orders || !s.orders.length) return;
    const due = s.orders.filter((o) => o.deliverTurn <= s.turn + 1);
    if (!due.length) return;
    for (const o of due) {
      // 죽은 회사에는 인도하지 않는다 (fold 가 지우지 못한 경로가 있어도 여기서 막힌다).
      const a = airline(s, o.airlineId);
      if (!a || !a.alive) continue;
      // 대당 치른 값을 기체에 새긴다. 장부가와 상각을 지금 카탈로그 값으로 다시 재면,
      // 프로그램 정가가 3% 오른 것만으로 이미 인도된 기단의 자산가치와 감가상각비가
      // 통째로 움직인다 — 아무 거래도 없었는데 자본과 차입 한도가 바뀐다.
      const unit = typeof o.paid === 'number' && o.count > 0 ? o.paid / o.count : null;
      for (let i = 0; i < o.count; i++) {
        s.planes.push({
          id: s.nextId++,
          typeId: o.typeId,
          airlineId: o.airlineId,
          paid: unit,
          ageQuarters: 0,
          routeId: null,
          hoursSinceCheck: 0,
          quartersSinceCheck: 0,
          checkUntilTurn: -1,
        });
      }
    }
    s.orders = s.orders.filter((o) => o.deliverTurn > s.turn + 1);
  }

  /**
   * 현금이 마르면 기재를 판다. 그래도 자본잠식이 이어지면 접는다.
   *
   * 파산한 회사의 노선과 기재는 사라진다 — 남겨 두면 좌석은 내놓는데 아무도 값을
   * 치르지 않는 유령 항공사가 시장을 계속 누른다.
   */
  function resolveDistress(s) {
    for (const a of living(s)) {
      while (a.cash < 0) {
        const idle = planesOf(s, a.id).filter((p) => p.routeId === null);
        const pool = idle.length ? idle : planesOf(s, a.id);
        if (!pool.length) break;
        // 가장 늙은 것부터 판다 — 남길 값어치가 가장 적다.
        pool.sort((x, y) => y.ageQuarters - x.ageQuarters || x.id - y.id);
        const p = pool[0];
        a.cash += residual(s.types[p.typeId], p.ageQuarters, p.paid) * 0.8;
        removePlane(s, p);
      }
      if (a.negativeQuarters >= B.NEGATIVE_QUARTERS_TO_FOLD) fold(s, a);
    }
  }

  function removePlane(s, p) {
    s.planes = s.planes.filter((x) => x.id !== p.id);
    if (p.routeId === null) return;
    const r = s.routes.find((x) => x.id === p.routeId);
    if (!r) return;
    const left = assignedTo(s, p.routeId);
    // 마지막 기재가 빠진 노선은 닫는다 — 좌석 없는 노선이 시장에 남으면 안 된다.
    if (!left.length) {
      r.active = false;
      r.freq = 0;
      return;
    }
    // 남은 기재로 못 뛰는 편수는 내린다. 안 내리면 시장은 조용히 잘라 태우는데
    // 슬롯 점유(`usedSlots`)와 화면은 그 편수를 그대로 세, 못 쓰는 슬롯이 잠긴다.
    const cap = Econ.capacity(left, Cities.distance(r.from, r.to), (t) => s.types[t]);
    if (r.freq > cap.maxFreq) r.freq = Math.max(1, cap.maxFreq);
  }

  function fold(s, a) {
    a.alive = false;
    a.cash = 0;
    a.debt = 0;
    a.slots = {};
    s.routes = s.routes.filter((r) => r.airlineId !== a.id);
    s.planes = s.planes.filter((p) => p.airlineId !== a.id);
    // 미인도 발주도 함께 지운다. 남겨 두면 몇 분기 뒤 이미 없는 회사 앞으로 기체가
    // 들어와, 아무도 결산하지 않고 아무도 치우지 않는 유령 기재가 된다.
    if (s.orders) s.orders = s.orders.filter((o) => o.airlineId !== a.id);
  }

  /** 해가 바뀔 때 — 물가·도시 성장·여행 보급이 한 칸씩 오른다. */
  function yearTick(s) {
    const nextYear = s.startYear + Math.floor((s.turn + 1) / 4);
    s.world.inflation = inflationFor(nextYear);
    s.world.travelIndex = root.AirlinerDemand.travelIndex(nextYear);
    // 유가 기준선도 함께 옮긴다. 안 옮기면 1998년 값(0.21)이 20년 내내 굳어
    // 2008년 이후의 고유가 구간이 통째로 사라진다. 제조사 쪽에서 받아 온 지수는
    // 그대로 얹는다 — 두 계층이 한 세계를 살아야 한다.
    const mul = s.world.oil / oilFor(yearOf(s));
    s.world.oil = oilFor(nextYear) * (Number.isFinite(mul) && mul > 0 ? mul : 1);
    for (const c of Cities.CITIES) {
      const cs = s.cityState[c.id];
      if (cs) cs.dev *= c.growth;
    }
  }

  /** 만료된 일시 효과를 털어낸다 — 안 그러면 20년치가 그대로 쌓인다. */
  function pruneEffects(s) {
    for (const id of Object.keys(s.cityState)) {
      const cs = s.cityState[id];
      if (!cs.effects || !cs.effects.length) continue;
      cs.effects = cs.effects.filter((e) => s.turn <= e.untilTurn);
    }
  }

  /**
   * 제조사 계층의 세계를 항공사 계층에 옮긴다 — 두 계층이 한 세계를 살게 하는 자리.
   *
   * 유가 지수와 수요 지수는 제조사 게임이 이미 굴리고 있다. 항공사 쪽에서 따로 흔들면
   * 같은 분기에 제조사는 호황을, 항공사는 불황을 겪는 판이 된다.
   */
  function syncWorld(s, mfg) {
    if (!mfg || !mfg.market) return s;
    s.world.oil = oilFor(yearOf(s)) * mfg.market.fuelIndex;
    s.world.economy = mfg.market.demandIndex;
    return s;
  }

  // ── 최종 성적 ──

  /**
   * 20년의 성적.
   *
   * **자기자본을 절대값이 아니라 창업 대비 배수로 잰다.** 에미레이트는 대한항공의 두 배로
   * 시작하므로, 절대값으로 재면 등급이 난이도표가 아니라 회사 선택표가 된다 — 제조사 쪽
   * `scoreMult` 가 막으려는 것과 같은 문제다.
   *
   * 셋을 함께 본다. 자본만 보면 노선을 안 열고 현금을 깔고 앉는 것이 정답이 되고,
   * 수송량만 보면 적자로 태우는 것이 정답이 된다. 노선망 크기는 "세계를 얼마나 이었나" —
   * 허브 하나에 웅크린 판과 대륙을 잇는 판을 가른다.
   */
  const SCORE = {
    /** 자본이 두 배가 되면 2,000점 */
    GROWTH: 2000,
    /** 누적 승객 2만 5천 명당 1점 */
    PAX_PER_POINT: 25000,
    /** 취항 도시 하나당 */
    PER_CITY: 48,
  };

  /**
   * 등급 문턱은 **제조사 쪽 값을 그대로** 쓴다(S 7,000 · A 4,600 · B 3,000 · C 1,700).
   * 그래야 두 게임의 성적표를 나란히 읽을 수 있다. 대신 위의 배점을 자동조종 120판
   * (열두 회사 × 열 시드)의 분포에 맞춰 잡았다 — 중앙값이 B 한가운데(3,461), 상위
   * 25%가 A(4,959), 상위 10%가 S 문턱 근처에 오도록.
   *
   *   S 10 · A 25 · B 42 · C 23 · D 15 · F 5  (120판)
   *
   * 자동조종은 경쟁사를 굴리는 그 AI 다. 그러니 중앙값이 B 라는 것은 "기계만큼 하면 B,
   * 더 잘해야 A" 라는 뜻이다.
   */
  const GRADE_CUTS = [
    ['S', 7000],
    ['A', 4600],
    ['B', 3000],
    ['C', 1700],
  ];

  function finalScore(s, airlineId) {
    const a = airline(s, airlineId);
    if (!a) return null;
    const pax = lifetimePaxOf(a);
    const routes = routesOf(s, airlineId).filter((r) => r.active);
    const cities = new Set();
    for (const r of routes) {
      cities.add(r.from);
      cities.add(r.to);
    }
    const eq = a.alive ? equity(s, a) : 0;
    // 창업 자본은 판을 열 때 새겨 둔다 — 지금 다시 세면 그동안의 성장이 기준에 섞인다.
    const start = a.startEquity || 1;
    const growth = Math.max(0, eq / start - 1);

    const rows = [
      { label: '자본 성장', detail: `${(eq / start).toFixed(2)}배 (창업 ${Math.round(start / 1e6)}M → ${Math.round(eq / 1e6)}M)`, points: Math.round(growth * SCORE.GROWTH) },
      { label: '누적 승객', detail: `${Math.round(pax / 1e6)}백만 명`, points: Math.round(pax / SCORE.PAX_PER_POINT) },
      { label: '노선망', detail: `${cities.size}개 도시 · ${routes.length}개 노선`, points: cities.size * SCORE.PER_CITY },
    ];
    const score = a.alive ? rows.reduce((x, r) => x + r.points, 0) : 0;

    // 파산은 아무리 많이 실어 날랐어도 실패다 — 등급으로 성적을 덮지 않는다.
    let grade = 'F';
    if (a.alive) {
      grade = 'D';
      for (const [g, cut] of GRADE_CUTS) {
        if (score >= cut) {
          grade = g;
          break;
        }
      }
    }

    // 순위는 같은 잣대로 매긴다 — "나만 잘했나"가 아니라 "누구보다 잘했나".
    // 접힌 회사도 자리를 차지한다(꼴찌로) — 살아남은 것 자체가 성적이기 때문이다.
    const ranked = s.airlines
      .map((x) => ({ id: x.id, score: x.alive ? scoreOf(s, x) : -1 }))
      .sort((p2, q2) => q2.score - p2.score || (p2.id < q2.id ? -1 : 1));

    return {
      score,
      grade,
      rows,
      pax,
      cities: cities.size,
      routes: routes.length,
      equity: eq,
      startEquity: start,
      rank: ranked.findIndex((x) => x.id === airlineId) + 1,
      of: s.airlines.length,
    };
  }

  /** 점수만 — 순위를 매길 때 서로를 부르지 않으려고 따로 둔다. */
  /** 평생 누적 승객. 옛 세이브(카운터가 없던 판)는 남아 있는 기록으로 메운다. */
  function lifetimePaxOf(a) {
    if (typeof a.lifetimePax === 'number') return a.lifetimePax;
    return a.results.reduce((x, r) => x + r.pax, 0);
  }

  function scoreOf(s, a) {
    const pax = lifetimePaxOf(a);
    const cities = new Set();
    for (const r of routesOf(s, a.id)) if (r.active) cities.add(r.from), cities.add(r.to);
    const growth = Math.max(0, equity(s, a) / (a.startEquity || 1) - 1);
    return Math.round(growth * SCORE.GROWTH + pax / SCORE.PAX_PER_POINT + cities.size * SCORE.PER_CITY);
  }

  root.AirlinerSkyState = {
    BALANCE: B,
    inflationFor,
    oilFor,
    yearOf,
    yearFracOf,
    quarterOf,
    airline,
    living,
    routesOf,
    planesOf,
    assignedTo,
    flyingOn,
    slotsAt,
    totalSlots,
    feedCount,
    typeTable,
    refreshTypes,
    marketContext,
    demandFor,
    boostAt,
    isClosed,
    routeClosed,
    overhead,
    slotRent,
    slotRentTotal,
    residual,
    lifetimePaxOf,
    fleetValue,
    depreciation,
    equity,
    interestRate,
    debtCap,
    intervalHours,
    intervalQuarters,
    checkProgress,
    checkDue,
    checkSoon,
    checkCost,
    scheduleChecks,
    finalScore,
    SCORE,
    GRADE_CUTS,
    newGame,
    bootstrapRoutes,
    advance,
    syncWorld,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
