/*
 * 통합 모드 — 제조사와 자체 항공사를 잇는 자리.
 *
 * 두 계층은 서로를 모른다. 제조사 엔진은 노선도 슬롯도 모르고, 항공사 계층은 생산
 * 대기열도 인증도 모른다. 그 사이를 잇는 규칙만 여기 모은다 — 어느 쪽 파일에 넣어도
 * 그쪽이 상대를 알게 되기 때문이다.
 *
 * 잇는 것은 넷이다.
 *
 *   세계     유가·경기는 제조사 게임이 굴린다. 항공사가 따로 흔들면 같은 분기에
 *            제조사는 호황을, 항공사는 불황을 겪는 판이 된다.
 *   자체 발주  계열 항공사는 공고를 내지 않는다. 대신 **줄은 똑같이 선다** —
 *            생산 대기열에서 남의 주문을 제치지 않는다.
 *   불신     내 항공사와 노선에서 겨루는 항공사는 나를 경쟁자로 본다. 이것이
 *            자체 항공사를 갖는 값이다.
 *   성적     합산 자기자본으로 잰다. 합산이라 계열 간 이전가격은 성적을 못 바꾼다 —
 *            한 주머니에서 다른 주머니로 옮길 뿐이다.
 *
 * **돈의 단위가 다르다.** 제조사 엔진은 백만 달러 단위(`cash: 9500` = 95억),
 * 항공사 계층은 달러 단위다. 이 파일이 두 계층 사이에서 돈을 옮길 때마다 `MUSD` 를
 * 지난다 — 한 군데서만 환산해야 어느 쪽이 어느 단위인지 헷갈리지 않는다.
 */
(function (root) {
  'use strict';

  const E = root.AirlinerEngine;
  const St = root.AirlinerSkyState;
  const Cities = root.AirlinerCities;

  /** 제조사 장부의 1 = 항공사 장부의 100만. */
  const MUSD = 1e6;

  /**
   * 노선이 겹치는 항공사가 분기마다 잃는 신뢰.
   *
   * 한 노선에 하나씩이다. 노선 수로 재면 허브 하나에 몰아 넣은 판과 대륙을 잇는 판이
   * 같은 값을 치르는데, 실제로 남의 안방을 밟는 쪽은 뒤엣것이다.
   */
  const RIVALRY_PER_ROUTE = 0.45;
  /** 한 분기에 한 회사가 잃을 수 있는 신뢰의 한계. 없으면 대형 항공사 관계가 몇 해 만에 바닥난다. */
  const RIVALRY_MAX_PER_QUARTER = 3;

  // ── 세계 ──────────────────────────────────────────────────────────

  /** 제조사가 굴리는 유가·경기를 항공사 계층에 옮긴다. 분기마다 부른다. */
  function syncWorld(mfg, sky) {
    if (!mfg || !sky) return;
    St.syncWorld(sky, mfg);
  }

  // ── 자체 발주 ──────────────────────────────────────────────────────

  /**
   * 제조사가 아직 기체를 만들 수 있는가.
   *
   * 문을 닫은 제조사는 `endTurn` 이 늘 거절하므로 생산이 한 발짝도 안 나간다. 그런
   * 상태로 발주를 받으면 착수금만 죽은 장부로 넘어가고, 항공사의 선급금과 발주는
   * 영영 정리되지 않은 채 남는다.
   */
  const makerAlive = (mfg) => !!mfg && !mfg.gameOver;

  /** 자체 항공사가 지금 발주할 수 있는 자사 프로그램. */
  function orderableProgram(mfg, programId) {
    if (!makerAlive(mfg)) return null;
    return (mfg.programs || []).find((p) => p.id === programId && p.phase === 'production') || null;
  }

  function orderablePrograms(mfg) {
    if (!makerAlive(mfg)) return [];
    return (mfg.programs || []).filter((p) => p.phase === 'production');
  }

  /**
   * 자체 항공사가 자사 기체를 발주한다.
   *
   * **양쪽 장부가 같은 값을 반대로 적는다.** 제조사가 착수금을 받고, 항공사가 같은
   * 착수금을 낸다. 합산하면 0 — 실제로 나가는 것은 제조사 쪽 생산비뿐이다. 여기서
   * 값을 깎아도 합산 성적은 그대로라, 이전가격으로 성적을 만들 길은 없다.
   *
   * 실패하면 **어느 쪽 장부도 건드리지 않는다.** 제조사에 먼저 올리고 항공사에서
   * 실패하면 아무도 사지 않은 주문이 생산 대기열을 차지한다.
   */
  function placeOrder(mfg, sky, airlineId, programId, qty) {
    const a = St.airline(sky, airlineId);
    if (!a || !a.alive) return { ok: false, msg: '없는 항공사입니다.' };
    if (!makerAlive(mfg)) return { ok: false, msg: '제조사가 문을 닫아 더 만들 수 없습니다.' };
    const p = orderableProgram(mfg, programId);
    if (!p) return { ok: false, msg: '양산 중인 자사 기종이 아닙니다.' };
    if (!Number.isInteger(qty) || qty < 1) return { ok: false, msg: '대수는 1 이상의 정수여야 합니다.' };

    // 제조사가 매길 값을 **제조사에게 물어서** 항공사가 낼 수 있는지 먼저 본다.
    // 여기서 비율을 따로 알고 있으면 엔진 상수를 바꾼 날 견적과 청구액이 갈린다.
    const quote = E.inHouseQuote(mfg, { programId, qty });
    if (!quote || !quote.orderable) return { ok: false, msg: '양산 중인 자사 기종이 아닙니다.' };
    if (a.cash < quote.deposit * MUSD) {
      return { ok: false, msg: `착수금 ${Math.round(quote.deposit)}M 이 모자랍니다.` };
    }

    const r = E.placeInHouseOrder(mfg, { airlineId, programId, qty });
    if (!r.ok) return { ok: false, msg: r.error };

    a.cash -= r.deposit * MUSD;
    // 발주 장부는 첫 발주에서 만들어진다(`Actions.buyAircraft` 와 같은 규칙).
    if (!sky.orders) sky.orders = [];
    // 인도 전까지는 선급금으로 자기자본에 남는다 — 항공사 계층의 발주와 같은 대우다.
    // `external` 은 "인도 시점을 제조사가 정한다"는 표식이라, 항공사 타이머가 건드리지 않는다.
    sky.orders.push({
      id: sky.nextId++,
      airlineId,
      typeId: programId,
      count: qty,
      paid: r.deposit * MUSD,
      external: true,
      deliverTurn: null,
    });
    return { ok: true, msg: `${p.name} ${qty}기를 자체 발주했습니다.`, deposit: r.deposit * MUSD };
  }

  /**
   * 제조사가 이번 분기에 인도한 자체 발주분을 항공사 기단에 세운다.
   *
   * 항공사는 여기서 잔금을 낸다 — 착수금과 합해 정가다. 제조사 쪽 금융 조건·로열티·
   * 관세는 제조사의 사정이라 계열 항공사가 대신 물지 않는다.
   */
  function receiveDeliveries(mfg, sky, report, airlineId) {
    const list = (report && report.inHouse) || [];
    if (!list.length) return [];
    // **기종표를 먼저 맞춘다.** 항공사 계층은 자기 `advance` 에서만 표를 새로 만드는데,
    // 통합 모드에서는 제조사가 방금 인증·양산한 기종이 그 표에 아직 없다. 없는 기종으로
    // 기체를 세우려다 조용히 실패하면 착수금만 나가고 기체는 오지 않는다.
    St.refreshTypes(sky, mfg && mfg.programs);
    const got = [];
    for (const d of list) {
      if (d.airlineId !== airlineId) continue;
      const a = St.airline(sky, airlineId);
      if (!a || !a.alive) continue;
      // **세우지 못하면 아무것도 건드리지 않는다.** 잔금을 받고 선급금까지 지운 뒤
      // 기체가 안 서면, 낸 돈도 기록도 사라진 채 아무도 그 사실을 모른다.
      const r = St.receiveAircraft(sky, airlineId, d.programId, d.qty, d.unitPrice * MUSD);
      if (!r || !r.ok) continue;
      a.cash -= d.balance * MUSD;
      consumeOrder(sky, airlineId, d.programId, d.qty);
      got.push(d);
    }
    return got;
  }

  /**
   * 인도된 만큼 선급금 기록을 덜어낸다.
   *
   * 안 덜면 인도된 기체가 기단과 선급금 양쪽에 잡혀 자기자본이 두 번 세어진다.
   * 한 발주가 나눠 인도될 수 있으므로(생산 대기열이 재고만큼만 내보낸다) 대수를 깎는다.
   */
  function consumeOrder(sky, airlineId, typeId, qty) {
    if (!sky.orders) return;
    let left = qty;
    for (const o of sky.orders) {
      if (left <= 0) break;
      if (!o.external || o.airlineId !== airlineId || o.typeId !== typeId) continue;
      const take = Math.min(left, o.count);
      const unit = o.count > 0 ? o.paid / o.count : 0;
      o.count -= take;
      o.paid -= unit * take;
      left -= take;
    }
    sky.orders = sky.orders.filter((o) => !o.external || o.count > 0);
  }

  /**
   * 두 장부의 자체 발주 대수를 맞춘다.
   *
   * 제조사 쪽에서 자체 발주가 줄어드는 길은 인도만이 아니다 — 프로그램 취소, 사건,
   * 그 밖에 앞으로 생길 무엇이든 장부를 건드릴 수 있다. 그때 항공사 쪽 선급금을
   * 안 지우면, **오지 않을 기체의 값이 자산으로 남는다.** 실제로 그랬다: 취소 사건이
   * 계열 발주를 물어 제조사 잔고는 줄었는데 항공사는 선급금 3기를 그대로 들고 있었고,
   * 화면에는 영영 오지 않을 "인도 예정"이 떴다.
   *
   * 그래서 **왜 줄었는지 묻지 않고 결과만 맞춘다.** 취소 경로를 하나씩 막는 것으로는
   * 다음에 생길 경로를 못 막는다.
   *
   * 착수금은 돌려주지 않는다 — 제조사 장부에 위약금으로 남는다는 것이 이 게임의 규칙이고,
   * 그룹 합산으로는 한 주머니에서 다른 주머니로 옮긴 것이라 성적도 움직이지 않는다.
   */
  function reconcileOrders(mfg, sky, airlineId) {
    if (!mfg || !sky) return [];
    // **먼저 물어 준 돈을 받는다.** 제조사가 계약을 깨면 선수금과 위약금을 물어 주는데,
    // 그 돈의 상대가 우리 자회사다. 안 받으면 제조사에서는 나갔는데 항공사에는 안
    // 들어와 연결 장부에서 통째로 증발한다 — 그룹 자본이 그만큼 낮게 잡힌다.
    const refund = mfg.inHouseRefund || 0;
    if (refund > 0) {
      const a = St.airline(sky, airlineId);
      // 문 닫은 자회사에는 줄 수 없다 — 그 돈은 제조사에 남는다(파산한 회사는 그룹
      // 자본에서 0 으로 세므로 합산이 어긋나지도 않는다). **다만 기록은 그때만 지운다** —
      // 살아 있는데 못 준 경우까지 지우면 돈이 조용히 사라진다.
      if (a && a.alive) {
        a.cash += refund * MUSD;
        mfg.inHouseRefund = 0;
      } else if (a && !a.alive) {
        mfg.inHouseRefund = 0;
      }
    }
    if (!sky.orders || !sky.orders.length) return [];
    const live = {};
    for (const o of mfg.backlog || []) {
      if (o.inHouse && o.airlineId === airlineId && o.remaining > 0) {
        live[o.programId] = (live[o.programId] || 0) + o.remaining;
      }
    }
    const lost = [];
    const mine = {};
    for (const o of sky.orders) {
      if (o.external && o.airlineId === airlineId) mine[o.typeId] = (mine[o.typeId] || 0) + o.count;
    }
    for (const typeId of Object.keys(mine)) {
      const gap = mine[typeId] - (live[typeId] || 0);
      if (gap > 0) {
        consumeOrder(sky, airlineId, typeId, gap);
        lost.push({ typeId, count: gap });
      }
    }
    return lost;
  }

  // ── 불신 ──────────────────────────────────────────────────────────

  /**
   * 내 항공사와 노선에서 겨루는 항공사가 나를 경쟁자로 본다.
   *
   * 자체 항공사를 갖는 값이다. 기체를 파는 상대가 곧 노선에서 싸우는 상대라, 노선망을
   * 넓힐수록 제조사의 영업이 좁아진다 — 1934년 항공우편법으로 해체된 United Aircraft
   * & Transport 가 실제로 걸었던 길이다.
   *
   * 겹치는 **노선 수**로 잰다. 회사 수로 재면 남의 안방에 한 편 넣은 것과 노선망을
   * 통째로 겹쳐 놓은 것이 같은 값이 된다.
   */
  function applyRivalry(mfg, sky, airlineId) {
    if (!mfg || !sky || !mfg.relations) return [];
    const mine = St.routesOf(sky, airlineId).filter((r) => r.active);
    if (!mine.length) return [];
    const mineKeys = new Set(mine.map((r) => Cities.pairKey(r.from, r.to)));

    const hit = [];
    for (const a of sky.airlines) {
      if (a.id === airlineId || !a.alive) continue;
      if (mfg.relations[a.id] === undefined) continue;
      let overlap = 0;
      for (const r of St.routesOf(sky, a.id)) {
        if (r.active && mineKeys.has(Cities.pairKey(r.from, r.to))) overlap += 1;
      }
      if (!overlap) continue;
      const drop = Math.min(RIVALRY_MAX_PER_QUARTER, overlap * RIVALRY_PER_ROUTE);
      mfg.relations[a.id] = Math.max(0, mfg.relations[a.id] - drop);
      hit.push({ airlineId: a.id, overlap, drop });
    }
    return hit;
  }

  // ── 성적 ──────────────────────────────────────────────────────────

  /**
   * 합산 성적.
   *
   * **계열 간 선급금은 상계한다.** 자체 발주의 착수금은 항공사 장부에서 선급금(자산)이
   * 되고 제조사 장부에서는 현금이 된다 — 같은 돈이 두 번 세어진다. 상계하지 않으면
   * 자체 발주를 넣었다 뺐다 하는 것만으로 그룹 자기자본이 불어난다(3기 발주에 38M).
   *
   * 상계하고 나면 계열 간 거래는 합계를 움직이지 못한다. 이전가격을 어떻게 매기든
   * 성적이 그대로여야 한다는 것이 이 모드의 규칙이고, 그 규칙이 사는 자리가 여기다.
   *
   * 제조사 쪽은 재고·라인까지 세는 엔진의 순자산을 그대로 쓴다 — 현금에서 빚만 뺀
   * 값으로 재면 라인을 지은 분기마다 그룹이 가난해진 것처럼 보인다.
   */
  function combinedEquity(mfg, sky, airlineId) {
    const a = sky && St.airline(sky, airlineId);
    const air = a && a.alive ? St.equity(sky, a) : 0;
    const maker = mfg ? E.netWorth(mfg) * MUSD : 0;
    const internal = internalPrepaid(sky, airlineId);
    return { maker, airline: air, internal, total: maker + air - internal };
  }

  /**
   * 그룹 자본 배점 — **창업 대비 배수가 아니라 절대값이다.**
   *
   * 처음에는 항공사 쪽처럼 성장 배수로 쟀다. 두 가지가 무너졌다.
   *
   * 하나, **기준선이 0 을 지날 수 있다.** UAC 는 창업 순자산이 −1,016M 이라 자회사를
   * 누구로 고르느냐에 따라 합산 기준선이 85M 이 되기도 하고 음수가 되기도 한다 — 앞은
   * 85M 오를 때마다 2,000점이고 뒤는 성장 항목이 통째로 사라진다. 성적을 가르는 것이
   * 경영이 아니라 자회사 선택이 된다.
   *
   * 둘, 옛 세이브는 제조사 창업 순자산을 모르는데 항공사 것만 알고 있어서, 둘을 합친
   * 기준선이 항공사 몫만 남는다 — 있지도 않은 성장이 잡힌다.
   *
   * 그래서 제조사 게임이 이미 쓰는 방식을 그대로 쓴다: 순자산 × 0.08. 기준선을 나누지
   * 않으니 0 근처에서 터질 일이 없고, 두 게임과 같은 자로 읽힌다.
   */
  const GROUP_EQUITY_RATE = 0.08;
  /** 등급 문턱은 두 게임과 같다. 세 성적표를 나란히 읽을 수 있어야 한다. */
  const GROUP_CUTS = [['S', 7000], ['A', 4600], ['B', 3000], ['C', 1700]];

  /**
   * 통합 모드의 최종 성적.
   *
   * **자본은 연결 기준으로 한 번만 센다.** 제조사 점수의 순자산 항목과 항공사 점수의
   * 자본 성장 항목을 그대로 더하면 같은 돈이 두 번 세어지고, 계열 간 값을 어떻게
   * 매기느냐로 두 항목의 비중이 갈린다 — 이전가격으로 성적을 만들 길이 열린다.
   * 그래서 각 계층에서는 **계열 간 거래가 닿지 않는 항목만** 가져오고(`operatingScore`),
   * 자본은 상계까지 마친 그룹 자기자본 하나로 잰다.
   *
   * 어느 한쪽이 문을 닫으면 그룹도 실패다(F). 제조사가 무너진 채 항공사만 굴러가는
   * 판을 "잘한 경영"으로 부를 수는 없다 — 통합 모드는 둘을 함께 지고 가는 판이다.
   *
   * **배점은 두 게임에서 그대로 물려받은 것이지 새로 잰 값이 아니다.** 제조사 쪽에는
   * 자동조종이 없어 이 모드의 점수 분포를 시뮬레이션으로 확인하지 못했다. 각 항목은
   * 제 게임에서 이미 보정된 눈금이고 문턱도 공유하지만, 합쳐 놓은 분포는 미측정이다.
   */
  function groupScore(mfg, sky, airlineId) {
    if (!mfg || !sky || !airlineId) return null;
    const a = St.airline(sky, airlineId);
    if (!a) return null;

    // **여기서도 이력을 옮긴다.** 이관은 `beforeTurns` 에서 도는데, 이미 끝난 판(마지막
    // 분기이거나 한쪽이 파산한 판)은 분기를 더 넘기지 않으므로 그 자리가 영영 안 온다 —
    // 옛 세이브의 자체 인도분이 성적표에 그대로 시장 성과로 남는다. 표식이 있어 두 번
    // 돌지는 않는다.
    migrateInHouseCounters(mfg, sky, airlineId);
    const eq = combinedEquity(mfg, sky, airlineId);
    const alive = !!a.alive && !(mfg.gameOver && mfg.gameOver.reason === 'bankrupt');
    // 증자로 불린 자본은 그만큼 우리 몫이 아니다 — 제조사 점수가 이미 쓰는 규칙이다.
    // 안 걸면 "성적을 깎는다"고 안내된 증자가 그룹 점수를 되레 올린다.
    const ownership = 1 - (mfg.equityDilution || 0);
    // **회사 환산 배수도 건다.** 제조사 게임이 순자산 항목에 거는 그 배수다(보잉 0.45 ·
    // 엠브라에르 1.5) — 물려받은 대차대조표가 회사마다 판이하니 그대로 재면 등급이
    // 난이도표가 아니라 회사 선택표가 된다. 운영 항목에만 걸고 정작 더 큰 자본 항목을
    // 빼 두면, 거인을 고르는 것만으로 보정 없는 수백 점을 얻는다.
    const mult = mfg.scoreMult || 1;

    const rows = [
      {
        label: '그룹 자본',
        detail: `${Math.round(eq.total / MUSD)}M × ${GROUP_EQUITY_RATE}${
          ownership < 1 ? ` · 우리 몫 ${(ownership * 100).toFixed(0)}%` : ''
        }${mult !== 1 ? ` · 회사 환산 ×${mult}` : ''}${eq.internal ? ' · 계열 상계 후' : ''}`,
        points: Math.round((Math.max(0, eq.total) / MUSD) * GROUP_EQUITY_RATE * ownership * mult),
      },
    ];
    rows.push({
      label: '제조사 운영',
      detail: '누적 인도 · 시장 점유율 · 평판 (순자산은 그룹 자본에서 센다)',
      points: E.operatingScore(mfg),
    });
    // **자회사 운영 항목에도 같은 희석을 건다.** 증자는 모회사의 지분을 파는 일이고,
    // 자회사는 그 모회사가 통째로 가진 회사다 — 여기만 원값으로 두면 승객과 노선망에
    // 점수를 몰아 "성적을 깎는다"고 안내된 증자를 피해 갈 수 있다.
    const air = St.operatingScore(sky, airlineId);
    for (const r of air.rows) {
      rows.push({
        label: `항공사 ${r.label}`,
        detail: r.detail + (ownership < 1 ? ` · 우리 몫 ${(ownership * 100).toFixed(0)}%` : ''),
        points: Math.round(r.points * ownership),
      });
    }

    const score = alive ? rows.reduce((x, r) => x + r.points, 0) : 0;
    let grade = 'F';
    if (alive) {
      grade = 'D';
      for (const [g, cut] of GROUP_CUTS) {
        if (score >= cut) {
          grade = g;
          break;
        }
      }
    }
    return { score, grade, alive, rows, equity: eq };
  }

  /**
   * 이 기종의 자체 발주 중 **이미 만들어 둔 재고로 덮이는 대수**.
   *
   * `runDeliveries` 는 수주 장부를 우선순위와 수주 시점으로 한 줄로 세우고 앞에서부터
   * 재고를 꺼내 준다. 그러니 재고를 통째로 내 몫으로 치면 앞선 외부 주문이 다 가져갈
   * 때도 "막힌 기체 0" 이라 안심시키고, 거꾸로 남의 주문을 전부 빼면 내 주문이 더
   * 앞줄일 때도 "영영 안 온다"고 겁을 준다 — 둘 다 비싼 라인을 잘못 세우게 만든다.
   * 그래서 세는 대신 **인도가 쓰는 그 줄을 그대로 걸어 본다**(`E.deliveryQueue`).
   */
  function coveredByStock(mfg, programId) {
    const p = (mfg.programs || []).find((x) => x.id === programId);
    if (!p) return 0;
    let stock = p.stock || 0;
    let mine = 0;
    for (const o of E.deliveryQueue(mfg)) {
      if (stock <= 0) break;
      if (o.programId !== programId) continue;
      const n = Math.min(o.remaining, stock);
      stock -= n;
      if (o.inHouse) mine += n;
    }
    return mine;
  }

  /** 아직 인도되지 않은 자체 발주의 선급금 — 그룹 안에서만 오간 돈이다. */
  function internalPrepaid(sky, airlineId) {
    if (!sky || !sky.orders) return 0;
    return sky.orders
      .filter((o) => o.external && o.airlineId === airlineId)
      .reduce((x, o) => x + (o.paid || 0), 0);
  }

  // ── 분기 글루 ──────────────────────────────────────────────────────

  /**
   * 두 계층이 정산되기 **전**에 도는 일.
   *
   * **세계를 여기서 맞춘다.** 제조사의 `endTurn` 은 정산 끝에 `driftMarket` 으로 다음
   * 분기 유가·수요를 굴린다. 정산 뒤에 옮기면 항공사가 **이번 분기**를 다음 분기
   * 지수로 결산한다 — 둘 다 0분기에서 시작했는데 항공사의 첫 결산만 1분기 유가를
   * 쓴다. 두 계층의 같은 분기 리포트는 같은 조건에서 나와야 한다.
   */
  /**
   * 옛 세이브의 자체 인도 이력을 옮긴다.
   *
   * 자체 인도 대수를 세기 시작한 것은 나중이라, 그전에 만든 통합 판에는 계수가 없다.
   * 그대로 두면 이미 자회사에 넘긴 기체가 전부 **시장에서 이긴 것**으로 세어져 점유율과
   * 인도 점수를 그냥 가져간다.
   *
   * 지금 남은 자료로 셀 수 있는 것은 자회사가 **아직 굴리고 있는** 자사 기체뿐이다 —
   * 팔았거나 잃은 기체는 되짚을 수 없으니 이 값은 하한이다. 그래도 전부 시장 성과로
   * 세는 것보다는 참에 가깝다. 한 번만 돌도록 표식을 남긴다.
   */
  function migrateInHouseCounters(mfg, sky, airlineId) {
    if (!mfg || !sky) return;
    // 어느 회사가 계열인지는 표식과 무관하게 매번 맞춘다 — 옛 세이브에는 이 값이 없고,
    // 없으면 계열 선단의 정비 수익이 그대로 그룹 자본에 들어간다.
    mfg.inHouseAirlineId = airlineId;
    if (mfg.inHouseMigrated) return;
    mfg.inHouseMigrated = true;
    if (mfg.stats && typeof mfg.stats.inHouseDelivered === 'number') return;
    const own = new Set((mfg.programs || []).map((p) => p.id));
    const byType = {};
    for (const p of sky.planes || []) {
      if (p.airlineId === airlineId && own.has(p.typeId)) byType[p.typeId] = (byType[p.typeId] || 0) + 1;
    }
    let total = 0;
    for (const p of mfg.programs || []) {
      const n = byType[p.id] || 0;
      if (!n) continue;
      // 실제로 인도된 것보다 많이 뺄 수는 없다.
      const capped = Math.min(n, p.delivered || 0);
      p.inHouseDelivered = (p.inHouseDelivered || 0) + capped;
      total += capped;
    }
    if (!mfg.stats) mfg.stats = {};
    mfg.stats.inHouseDelivered = (mfg.stats.inHouseDelivered || 0) + total;
  }

  function beforeTurns(mfg, sky, airlineId) {
    if (!mfg || !sky || !airlineId) return;
    migrateInHouseCounters(mfg, sky, airlineId);
    // 이 판이 통합 판이라는 표식. 명령 계층은 껍데기를 모르지만, 자사 기종을 일반
    // 발주로 살 수 없다는 규칙은 알아야 한다.
    sky.groupAirlineId = airlineId;
    // 제조사가 띄운 기종을 항공사 계층이 볼 수 있게 한다. 통합 모드에서 항공사의
    // `advance` 는 프로그램을 받지 않으므로, 여기서 넘기지 않으면 자사 기종이 영영
    // 항공사 기종표에 들어오지 않는다 — 발주는 되는데 인도가 안 된다.
    St.refreshTypes(sky, mfg.programs);
    syncWorld(mfg, sky);
    // 자회사는 공고를 내지 않는다. `generateRfps` 는 `AIRLINES` 를 전부 도므로
    // 여기서 걷어내지 않으면 자회사가 계속 공고를 내고 그 물량이 낙찰된다.
    E.dropAirlineRfps(mfg, airlineId);
  }

  /**
   * 제조사 정산과 항공사 정산 **사이**에 도는 일.
   *
   * 인도만 한다 — 이번 분기에 받은 기체가 이번 분기 노선에 설 수 있어야, 화면에 뜬
   * 기재와 시장이 걷어가는 좌석이 같은 목록이 된다. 세계는 `beforeTurns` 에서 맞췄다.
   */
  function betweenTurns(mfg, sky, airlineId, report) {
    if (!mfg || !sky || !airlineId) return [];
    // 인도된 기체가 방금 인증된 기종일 수 있다 — 표를 한 번 더 맞춘다.
    St.refreshTypes(sky, mfg.programs);
    const got = receiveDeliveries(mfg, sky, report, airlineId);
    // **두 장부를 여기서 맞춘다 — 항공사가 정산하기 전에.** 제조사가 계약을 깨며
    // 물어 준 돈이 뒤늦게 들어오면, 자회사는 그 돈 없이 한 분기를 나야 한다 — 멀쩡한
    // 기재를 급매로 팔거나 자본잠식 문턱을 넘어 문을 닫는다. 닫고 나면 줄 상대가
    // 없어져 그 돈은 영영 전달되지 않는다.
    reconcileOrders(mfg, sky, airlineId);
    return got;
  }

  /**
   * 두 계층이 다 정산된 **뒤**에 도는 일.
   *
   * 불신은 이번 분기에 실제로 굴린 노선망으로 잰다 — 정산 전에 재면 이번 분기에 접은
   * 노선까지 값을 치른다.
   */
  function afterTurns(mfg, sky, airlineId) {
    if (!mfg || !sky || !airlineId) return [];
    // 이번 분기 정산 끝에 새로 뽑힌 공고에도 자회사가 섞여 있다.
    E.dropAirlineRfps(mfg, airlineId);
    // 정산 중에 또 사라진 자체 발주가 있으면 여기서 한 번 더 맞춘다. (본 대조는
    // 항공사 정산 **전**인 `betweenTurns` 에서 돈다 — 위 주석 참조.)
    reconcileOrders(mfg, sky, airlineId);
    // 자회사가 문을 닫았으면 제조사 장부의 자체 발주도 지운다. 남겨 두면 몇 분기 뒤
    // 받을 상대 없이 인도되면서 잔금이 매출로 잡힌다.
    const a = St.airline(sky, airlineId);
    if (!a || !a.alive) {
      E.cancelInHouseOrders(mfg, airlineId);
      if (sky.orders) sky.orders = sky.orders.filter((o) => !(o.external && o.airlineId === airlineId));
      return [];
    }
    return applyRivalry(mfg, sky, airlineId);
  }

  root.AirlinerSkyGroup = {
    MUSD,
    quote: (mfg, programId, qty) => E.inHouseQuote(mfg, { programId, qty }),
    RIVALRY_PER_ROUTE,
    RIVALRY_MAX_PER_QUARTER,
    syncWorld,
    orderablePrograms,
    orderableProgram,
    placeOrder,
    receiveDeliveries,
    consumeOrder,
    reconcileOrders,
    migrateInHouseCounters,
    applyRivalry,
    combinedEquity,
    coveredByStock,
    groupScore,
    GROUP_EQUITY_RATE,
    GROUP_CUTS,
    internalPrepaid,
    beforeTurns,
    betweenTurns,
    afterTurns,
    makerAlive,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
