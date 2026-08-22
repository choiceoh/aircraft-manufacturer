/*
 * 결정 사건 — 선택지가 있는 분기 사건.
 *
 * 무작위 이벤트(js/data.js)는 결과를 통보만 한다. 플레이어는 읽고 확인할 뿐이라,
 * 설계·수주·생산에 손댈 게 없는 분기는 "분기 종료"만 누르는 빈 분기가 된다
 * (측정치: 80분기 중 36분기). 여기 사건들은 반대로 **고르게** 만든다.
 *
 * 설계 규칙 세 가지:
 *   1. 모든 선택지에 대가가 있다. "공짜로 좋은" 선택지는 결정이 아니라 버튼이다.
 *   2. 적어도 하나는 **나중에** 값을 치른다(`after`). 그래야 "그때 그 선택"이
 *      서사가 된다 — 즉시 정산되면 그냥 자원 교환이다.
 *   3. 아무것도 고르지 않고 분기를 넘길 수 있다. 그때는 `fallback` 선택지가
 *      적용된다 — 무대응도 하나의 선택이고, 대개 가장 나쁘지도 좋지도 않다.
 *
 * 상태에는 함수를 저장할 수 없으므로(세이브는 JSON), 화면에 필요한 문자열만
 * 남기고 실제 효과는 여기 카탈로그에서 id 로 다시 찾는다.
 */
(function (root) {
  'use strict';

  const { AIRLINES, CONFIG, SEGMENTS, FIELD_REQUIREMENT, ETOPS_RANGE_KM, GOV_MISSIONS, GOV_BID_MODES, GOV_PROPOSAL_COST, TAKEOVER } = root.AirlinerData;
  const Fleet = root.AirlinerFleet;
  const Engines = root.AirlinerEngines;

  const money = (m) => {
    const v = Math.round(m);
    if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(2)}B`;
    return `$${v}M`;
  };

  /** 양산 중인 기종이 있나 — 생산·고객 관련 사건의 공통 전제. */
  function hasProduction(s) {
    return s.programs.some((p) => p.phase === 'production');
  }

  /**
   * 핵심 고객(누적 60기+) 중 우리 양산 기종이 자기 대역에 맞는 항공사 — 수의계약
   * 사건의 전제다. 엔진의 loyaltyTier 와 같은 문턱을 쓴다(로드 순서상 여기서 직접 센다).
   */
  /**
   * 수의계약의 임무 적합 — 입찰(RFP)과 같은 기준. 제안 시점과 **수락 시점** 둘 다
   * 이 함수를 지난다: 제안만 걸러 두면 이 검사가 없던 시절의 세이브에 열려 있는
   * 사건이 검사 없이 수락되고, 제안과 수락 사이에 사정이 바뀌어도(운항 정지 등)
   * 옛 조건으로 서명된다.
   */
  function loyalDealFit(a, p) {
    if (!a || !p || p.phase !== 'production') return null;
    const needEtops = a.rangeBand[0] >= ETOPS_RANGE_KM;
    const ok =
      p.segment === a.bias &&
      p.seats >= a.seatBand[0] * 0.85 &&
      p.seats <= a.seatBand[1] * 1.15 &&
      p.range >= a.rangeBand[0] * 0.9 &&
      (p.fieldPerf || 0) >= (FIELD_REQUIREMENT[a.field] || 0) &&
      // 4발은 ETOPS 규정 밖 — 입찰·인도 게이트와 같은 면제를 여기도 적용한다.
      (!needEtops || p.etopsCertified || p.engines === 4);
    return ok ? { needEtops } : null;
  }

  function pickLoyalDeal(s) {
    for (const a of AIRLINES) {
      const fleet = (s.fleets && s.fleets[a.id]) || {};
      const units = Object.values(fleet).reduce((x, y) => x + y, 0);
      if (units < 60) continue;
      // 수의계약도 그 항공사의 노선을 날 기체라야 한다 — 이걸 빼면 에미레이트(초장거리·
      // ETOPS)가 단거리 미인증 기체를 전화로 주문하는, 입찰로는 막힌 뒷문이 열린다.
      const p = s.programs.find((x) => loyalDealFit(a, x));
      if (p) return { airline: a, program: p, needEtops: loyalDealFit(a, p).needEtops };
    }
    return null;
  }

  /**
   * 국가 발주(trait.stateOrders)를 받을 만한 기종 — 양산 중이고, 그 국가가 사는 급.
   * 인도 실적을 따지지 않는다: 국가는 검증이 아니라 자국 산업을 사기 때문이다.
   * 그래서 실적이 없어 어느 시장에도 못 들어가는 신형이 여기서 첫 물량을 얻는다.
   */
  function stateOrderPick(s) {
    const spec = (s.trait || {}).stateOrders;
    if (!spec) return null;
    const segs = spec.segments || ['regional', 'narrow', 'wide'];
    const eligible = s.programs.filter((p) => p.phase === 'production' && segs.includes(p.segment));
    if (!eligible.length) return null;
    // 국가는 자국 산업의 **최신** 기체를 민다 — 낡은 기종에 물량을 얹는 것이 아니라
    // 새 기종을 띄우는 것이 산업 정책이다. 승계기는 마지막 순위다.
    const rank = (p) => (p.legacy ? 0 : 1e9) + (p.launchTurn || 0);
    return eligible.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  }

  function inDevelopment(s) {
    return s.programs.filter((p) => p.phase === 'dev');
  }

  /** 우리 기체를 가장 많이 굴리는 항공사 — 없으면 관계가 가장 좋은 곳. */
  function topCustomer(s) {
    // 선단 장부에는 항공사가 아닌 계정도 있다 — 군용 특수기('gov')와 국영 항공사
    // 발주('state'). 그 계정이 최다가 되면 `AIRLINES.find` 가 빗나가 조용히
    // AIRLINES[0](대한항공)로 떨어지고, 런치 커스터머·에어쇼가 실제 최대 고객이
    // 아니라 명단 첫 줄을 집는다. 순위를 매기기 전에 **실존 항공사만** 남긴다.
    const isAirline = (id) => AIRLINES.some((a) => a.id === id);
    const byUnits = Object.entries(s.fleets || {})
      .filter(([id]) => isAirline(id))
      .map(([id, byProgram]) => ({ id, units: Object.values(byProgram).reduce((a, n) => a + n, 0) }))
      .filter((x) => x.units > 0)
      .sort((a, b) => b.units - a.units)[0];
    const id = byUnits
      ? byUnits.id
      : Object.entries(s.relations || {})
          .filter(([aid]) => isAirline(aid))
          .sort((a, b) => b[1] - a[1])[0]?.[0];
    return AIRLINES.find((a) => a.id === id) || AIRLINES[0];
  }

  function biggestProgram(s) {
    const prod = s.programs.filter((p) => p.phase === 'production');
    if (!prod.length) return null;
    return prod.reduce((a, b) => (b.delivered > a.delivered ? b : a));
  }

  /** 선주문·입찰이 열리는 단계 — 엔진의 biddablePhase 와 같은 문턱. */
  function biddableProgram(p) {
    return p && (p.phase === 'production' || p.phase === 'cert' || (p.phase === 'dev' && p.progress >= 40));
  }

  /**
   * 부스에 내놓을 기체와 그 급의 손님. 점수는 관계로만 고른다 — 난수를 쓰면
   * 출품을 고른 판의 본류가 재편된다.
   */
  function showFloor(s) {
    const shown = s.programs
      .filter(biddableProgram)
      .slice()
      .sort((a, b) => {
        const rank = (p) => (p.phase === 'production' ? 3 : p.phase === 'cert' ? 2 : 1) * 1e6 + (p.delivered || 0);
        return rank(b) - rank(a);
      })[0];
    if (!shown) return null;
    const guests = AIRLINES.filter((a) => a.bias === shown.segment);
    const pool = guests.length ? guests : AIRLINES;
    const airline = pool.reduce((a, b) => ((s.relations[b.id] || 0) > (s.relations[a.id] || 0) ? b : a));
    return { program: shown, airline };
  }

  function launchBatch(h, p, a, qty) {
    const needEtops = a.rangeBand[0] >= ETOPS_RANGE_KM && p.engines !== 4;
    p.launchAirlineId = a.id;
    return h.order({
      airlineId: a.id,
      airlineName: a.name,
      program: p,
      qty,
      unitPrice: p.listPrice,
      reqEtops: needEtops,
    });
  }

  /**
   * "앞당겨 인도"를 팔 수 있는 주문인가 — 양산 중이고 인도 게이트에 안 막혀
   * 있어야 한다. ETOPS 게이트에 막힌 주문은 특별 근무로 기체를 더 뽑아도
   * 인도가 안 되므로, 사건이 집으면 돈만 쓰는 거짓 선택지가 된다.
   */
  function rushableOrder(s, order) {
    const p = s.programs.find((x) => x.id === order.programId);
    if (!p || p.phase !== 'production') return false;
    if (order.reqEtops && !p.etopsCertified && p.engines !== 4) return false;
    // 운항 정지 중인 기종도 마찬가지다 — 인도 게이트(runDeliveries)에 막혀 있는
    // 주문에 특별 근무를 팔면 돈만 쓰는 거짓 선택지가 된다.
    if (((s.effects && s.effects.grounded) || {})[p.id] > 0) return false;
    return true;
  }


  /** 인도 실적이 가장 두터운 엔진 공급사 — 독점 계약 제안의 주체. */
  function topEngineMaker(s) {
    // 우리 자회사(국산 엔진 공급사)는 거래처가 아니다. 빼지 않으면 국산화한
    // 회사가 자기 자회사와 "독점 공급 계약"을 맺고, 자기 돈으로 자기에게
    // 리베이트를 주면서 다른 공급사 설계에 8% 할증을 무는 계약을 사게 된다.
    const domestic = new Set(Engines.ENGINES.filter((e) => e.domestic).map((e) => e.maker));
    const entries = Object.entries(s.engineRelations || {}).filter(([maker]) => !domestic.has(maker));
    if (!entries.length) return null;
    const [maker, units] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    return { maker, units };
  }

  /**
   * 런칭 파트너를 제안할 만한 엔진 — 정식 취항 3년 안쪽의 신형 중, 우리와 거래가
   * 쌓인 공급사 것. 가중치·본문이 같은 것을 가리키도록 결정적으로 고른다.
   */
  function upcomingEngineFor(s) {
    const year = CONFIG.startYear + Math.floor(s.turn / 4);
    return (
      Engines.ENGINES.filter(
        (e) =>
          // 국산 엔진은 런칭 파트너의 대상이 아니다. 독점 공급 계약과 같은 이유로
          // 우리 자회사는 제3자 공급사가 아니고, 무엇보다 **분담금으로는 안 열린다**:
          // 조기 접근은 `engineEarlyAccess` 만 채우는데 국산 엔진의 문은 `localEngines`
          // 가 잡는다. 그대로 두면 $403M 을 내고 아무것도 못 쓰는 계약이 되고, 열리게
          // 만들면 $2.9B·14분기짜리 2세대 사업에 옆문이 생긴다.
          !e.domestic &&
          e.eis > year &&
          e.eis - year <= 3 &&
          !(s.engineEarlyAccess || {})[e.id] &&
          ((s.engineRelations || {})[e.maker] || 0) >= 20,
      ).sort((a, b) => a.eis - b.eis || b.eff - a.eff)[0] || null
    );
  }

  /** 받침 유무로 조사를 고른다 — 발주처가 공군(이/과)일 수도 정부(가/와)일 수도 있다. */
  function batchim(word) {
    const c = word.charCodeAt(word.length - 1);
    return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0;
  }
  const iGa = (w) => w + (batchim(w) ? '이' : '가');
  const gwaWa = (w) => w + (batchim(w) ? '과' : '와');

  /**
   * 인수 매물 — 결함 파동(양수 위기) 중인 경쟁 기종. 가중치와 문구가 같은 것을
   * 가리키도록 결정적으로 고른다(첫 번째 위기 기종).
   */
  function takeoverTarget(s) {
    for (const [typeId, c] of Object.entries(s.rivalCrises || {})) {
      if (!(c && c.amount > 0)) continue;
      if ((s.acquiredTypes || {})[typeId]) continue;
      const t = Fleet.AIRCRAFT.find((x) => x.id === typeId);
      // 이미 우리 제조사의 기종이면(플레이어블 제조사) 매물이 아니다.
      if (t && !(s.playerMakers || []).includes(t.maker)) return t;
    }
    return null;
  }

  /**
   * 정부 특수기 사업 — 이 임무에 응모할 수 있는 우리 기종.
   * "검증된 기체"가 자격이다: 세그먼트·항속에 더해 인도 실적 문턱이 있다.
   * 같은 기종은 평생 한 사업만 한다(개조 라인이 그 임무에 묶인다).
   */
  function govFit(s, m) {
    if ((m.minReputation || 0) > (s.reputation || 0)) return null;
    // 사풍 — 군을 오래 상대한 회사는 더 적은 실적으로도 후보에 오른다. 항속·평판
    // 문턱은 그대로다: 그건 회사의 이력이 아니라 임무가 요구하는 물리다.
    const govT = ((s.trait || {}).gov) || {};
    // 배수 0 은 유효한 값이다 ("실적을 따지지 않는다"). ||는 그것을 1 로 되살려
    // 문턱을 통째로 되돌린다 — 이 사풍 체계는 이미 tensionMult: 0 을 쓰고 있다.
    const minDelivered = Math.ceil(m.minDelivered * (govT.deliveredMult ?? 1));
    const eligible = s.programs.filter(
      (p) =>
        p.phase === 'production' &&
        !p.govMission &&
        m.segments.includes(p.segment) &&
        p.range >= m.minRange &&
        (p.delivered || 0) >= minDelivered,
    );
    if (!eligible.length) return null;
    // 실적이 가장 두터운 기종이 유력 후보다 — 정부는 검증을 산다.
    return eligible.reduce((a, b) => ((b.delivered || 0) > (a.delivered || 0) ? b : a));
  }

  /**
   * 이번에 공고될 임무. 늘 같은 임무만 오면 단조로우니 분기에 따라 순서를 돌린다 —
   * 가중치 계산과 문구 생성이 같은 것을 가리키도록 결정적이어야 한다.
   */
  function govMissionPick(s) {
    const n = GOV_MISSIONS.length;
    const start = Math.floor(s.turn / 7) % n;
    for (let i = 0; i < n; i++) {
      const m = GOV_MISSIONS[(start + i) % n];
      const p = govFit(s, m);
      if (p) return { mission: m, program: p };
    }
    return null;
  }

  /** 낙찰 확률 — 입찰 방식이 기본값을, 평판이 보정을 정한다. */
  function govWinChance(s, mode) {
    const base = (GOV_BID_MODES[mode] || GOV_BID_MODES.fixed).winBase;
    // 사풍 — 심사관이 아는 이름인가. 방산이 집인 회사는 유리하고, 여객기만
    // 만들어 온 회사는 같은 제안서로도 밀린다.
    const bonus = (((s.trait || {}).gov) || {}).winBonus || 0;
    // 평판 0은 유효한 값(최악)이다 — ||는 0을 50으로 되살려 바닥 평판이 보정을 피해 간다.
    return Math.max(0.15, Math.min(0.85, base + bonus + ((s.reputation ?? 50) - 50) * 0.005));
  }

  /**
   * 입찰 제출 — 두 방식이 공유한다. 제안 비용을 내고 심사를 기다린다.
   * 낙찰 발표(2분기 뒤)와 개조 완료는 아래 govAward 가 단계를 나눠 정산한다.
   */
  function govApply(mode) {
    return (s, h) => {
      const m = GOV_MISSIONS.find((x) => x.id === h.recall('mission'));
      const p = s.programs.find((x) => x.id === h.recall('program'));
      if (!m || !p) return '공고는 흐지부지됐다.';
      h.expense(GOV_PROPOSAL_COST);
      h.remember('mode', mode);
      const label = GOV_BID_MODES[mode].name;
      return `${m.name} 사업에 ${label} 조건으로 제안서를 냈다 (제안 비용 ${money(GOV_PROPOSAL_COST)}). 발표는 2분기 뒤다.`;
    };
  }

  /**
   * 낙찰 발표 → 개조 개발 → 수주·인도 개시의 다단계 정산.
   * 같은 after 가 retryIn 으로 두 번 불리므로 memo.stage 로 단계를 가른다.
   */
  function govAward(s, h) {
    const m = GOV_MISSIONS.find((x) => x.id === h.recall('mission'));
    const p = s.programs.find((x) => x.id === h.recall('program'));
    const mode = h.recall('mode', 'fixed');
    if (!m) return '';
    const stage = h.recall('stage', 'award');

    // 그 사이 기종이 죽었으면 사업도 죽는다 — 정부는 도면이 아니라 기체를 산다.
    if (!p || p.phase !== 'production') {
      if (stage === 'convert') h.reputation(-4);
      return `${p ? p.name : '후보 기체'}가 시장에서 사라지면서 ${m.name} 사업도 무산됐다.`;
    }

    if (stage === 'award') {
      // 종료 정산이면 발표 자체가 없다 — 여기서 낙찰시키면 개조비만 물고 끝난다.
      if (h.final) return `${m.name} 사업 발표가 나기 전에 경영이 끝났다.`;
      if (!h.rng.chance(govWinChance(s, mode))) {
        h.reputation(-1);
        const rival = h.recall('rival', '경쟁사');
        return `${m.name} 사업에서 떨어졌다. ${rival} 기체가 선정됐다 — 제안 비용만 남았다.`;
      }
      const convCost = Math.round(p.devCost * m.convRate);
      // 개조 "개발비"는 R&D 다 — expense 로 내면 분기 보고서·경력 총계의 R&D 줄이 샌다.
      h.rdExpense(convCost);
      h.reputation(3);
      h.remember('stage', 'convert');
      return {
        text: `${m.name} 사업 낙찰! ${p.name} 개조 개발에 ${money(convCost)}을 투입한다 — 완료까지 ${m.convQuarters}분기.`,
        retryIn: m.convQuarters,
      };
    }

    // stage === 'convert' — 개조 완료. 고정가라면 여기서 청구서가 날아올 수 있다.
    if (h.final) return `${p.name} ${m.name} 개조가 끝나기 전에 경영이 끝났다. 개발비는 매몰됐다.`;
    const qty = h.recall('qty', m.qty[0]);
    let unitPrice = h.recall('unitPrice', Math.round(p.listPrice * m.priceMult));
    if (GOV_BID_MODES[mode].priceMult) unitPrice = Math.round(unitPrice * GOV_BID_MODES[mode].priceMult);
    let overrunText = '';
    if (mode === 'fixed' && h.rng.chance(m.overrunChance)) {
      const convCost = Math.round(p.devCost * m.convRate);
      const overrun = Math.round(convCost * h.rng.range(m.overrunRange[0], m.overrunRange[1]));
      h.rdExpense(overrun);
      h.reputation(-2);
      overrunText = ` 군용 개조는 만만치 않았다 — 고정가 계약이라 초과 비용 ${money(overrun)}은 전부 우리 몫이다.`;
    }
    p.govMission = m.id;
    h.order({ airlineId: 'gov', airlineName: m.customer, program: p, qty, unitPrice, gov: true });
    h.reputation(2);
    return `${p.name} ${m.name} 개조 완료. ${gwaWa(m.customer)} ${qty}기 계약 (대당 ${money(unitPrice)}) — 인도된 기체는 퇴역까지 분기마다 지원 수익을 낸다.${overrunText}`;
  }

  const DECISIONS = [
    // ── 공급망 ──
    {
      id: 'supplier_squeeze',
      name: '공급업체 단가 인상 통보',
      weight: (s) => (hasProduction(s) && s.lines.length ? 10 : 0),
      text: (s, h) => {
        const pct = h.rng.int(5, 9);
        h.remember('pct', pct);
        return `1차 협력사가 원자재값을 이유로 부품 단가 ${pct}% 인상을 통보했다. 계약서상 우리가 거부할 근거는 약하다.`;
      },
      options: [
        {
          id: 'accept',
          label: '수용한다',
          detail: '생산 원가 상승. 대신 공급은 안정된다',
          fallback: true,
          apply: (s, h) => {
            const pct = h.recall('pct', 6);
            for (const p of s.programs) p.unitCostBase = Math.round(p.unitCostBase * (1 + pct / 200));
            return `단가 인상을 받아들였다. 전 기종 생산 원가가 ${(pct / 2).toFixed(1)}% 올랐다.`;
          },
        },
        {
          id: 'fight',
          label: '재협상으로 버틴다',
          detail: '원가는 지키지만 납품이 흔들릴 수 있다',
          apply: (s, h) => {
            if (h.rng.chance(0.45)) {
              s.effects.supplyQuarters = Math.max(s.effects.supplyQuarters || 0, h.rng.int(2, 3));
              return `협상이 깨졌다. 협력사가 납품을 늦추면서 ${s.effects.supplyQuarters}개 분기 동안 생산율이 깎인다.`;
            }
            return '버텼다. 협력사가 인상안을 철회했다 — 이번에는 우리 쪽 계약서가 더 단단했다.';
          },
        },
        {
          id: 'switch',
          label: '공급처를 바꾼다',
          detail: '전환 비용을 지금 치르고 뒤에 원가를 낮춘다',
          apply: (s, h) => {
            const cost = Math.round(240 + s.lines.length * 90);
            h.expense(cost);
            return `전환 비용 ${money(cost)}을 치렀다. 새 협력사의 물량이 붙기까지는 시간이 걸린다.`;
          },
          after: {
            quarters: 3,
            apply: (s) => {
              for (const p of s.programs) p.unitCostBase = Math.round(p.unitCostBase * 0.96);
              return '새 공급처가 자리를 잡았다. 전 기종 생산 원가가 4% 내렸다.';
            },
          },
        },
      ],
    },

    // ── 고객 ──
    {
      id: 'launch_customer',
      name: '런치 커스터머 제안',
      weight: (s) => (inDevelopment(s).length ? 11 : 0),
      text: (s, h) => {
        const p = h.rng.pick(inDevelopment(s));
        const a = topCustomer(s);
        h.remember('program', p.id);
        h.remember('airline', a.id);
        return `${iGa(a.name)} 개발 중인 <b>${p.name}</b>의 런치 커스터머를 자청했다. 단, 초도 물량을 대폭 할인해 달라는 조건이다.`;
      },
      options: [
        {
          id: 'take',
          label: '받아들인다',
          detail: '선급금과 관계. 정가가 낮아지고, 초도 8기가 지금 선주문으로 들어온다',
          apply: (s, h) => {
            const p = s.programs.find((x) => x.id === h.recall('program'));
            const a = AIRLINES.find((x) => x.id === h.recall('airline'));
            if (!p || !a) return '제안은 흐지부지됐다.';
            const advance = Math.round(p.devCost * 0.12);
            h.income(advance);
            h.relation(a.id, 18);
            p.listPrice = Math.round(p.listPrice * 0.94);
            const o = launchBatch(h, p, a, 8);
            const qty = (o && o.qty) || 8;
            return `${a.name}에서 선급금 ${money(advance)}을 받았다. ${p.name} 정가가 6% 낮아졌고, 초도 ${qty}기가 선주문으로 올라왔다.`;
          },
        },
        {
          id: 'counter',
          label: '조건을 낮춰 역제안한다',
          detail: '선급금은 적지만 정가를 지킨다. 받아들여지면 초도 5기다',
          apply: (s, h) => {
            const p = s.programs.find((x) => x.id === h.recall('program'));
            const a = AIRLINES.find((x) => x.id === h.recall('airline'));
            if (!p || !a) return '제안은 흐지부지됐다.';
            if (h.rng.chance(0.5)) {
              const advance = Math.round(p.devCost * 0.05);
              h.income(advance);
              h.relation(a.id, 8);
              const o = launchBatch(h, p, a, 5);
              const qty = (o && o.qty) || 5;
              return `${iGa(a.name)} 역제안을 받아들였다. 선급금 ${money(advance)}, 정가는 지켰다. 초도 ${qty}기가 선주문이다.`;
            }
            h.relation(a.id, -6);
            return `${iGa(a.name)} 역제안을 걷어찼다. 런치 커스터머 이야기는 없던 일이 됐다.`;
          },
        },
        {
          id: 'decline',
          label: '거절한다',
          detail: '정가를 온전히 지킨다. 관계는 식는다',
          fallback: true,
          apply: (s, h) => {
            const a = AIRLINES.find((x) => x.id === h.recall('airline'));
            if (a) h.relation(a.id, -4);
            return '런치 커스터머 제안을 거절했다. 개발비는 온전히 우리 몫이다.';
          },
        },
      ],
    },

    // ── 품질 ──
    {
      id: 'quiet_defect',
      name: '내부 시험에서 발견된 결함',
      weight: (s) => (hasProduction(s) ? 9 : 0),
      text: (s, h) => {
        const p = biggestProgram(s);
        h.remember('program', p ? p.id : null);
        return `사내 시험에서 <b>${p ? p.name : '주력기'}</b>의 결함 징후가 잡혔다. 아직 아무도 모른다. 지금 손보면 조용히 끝나지만 인도가 밀린다.`;
      },
      options: [
        {
          id: 'fix',
          label: '자발적으로 손본다',
          detail: '비용과 시간을 지금 쓴다. 위험이 확실히 줄어든다',
          apply: (s, h) => {
            const p = s.programs.find((x) => x.id === h.recall('program'));
            if (!p) return '해당 기종이 없다.';
            const cost = Math.round(p.devCost * 0.05 + 120);
            h.expense(cost);
            p.defectRisk = Math.round(p.defectRisk * 0.72 * 1000) / 1000;
            h.reputation(2);
            // 시간도 쓴다고 광고했으면 실제로 써야 한다. 한 분기 인도를 세운다 —
            // 돈만 내고 끝나면 안전한 선택지가 대가 없이 우월해진다.
            h.ground(p.id, 1);
            return `${money(cost)}을 들여 조용히 개선했다. ${p.name}의 결함 위험이 ${(p.defectRisk * 100).toFixed(1)}%로 내려갔고, 개수 작업으로 한 분기 인도가 멈춘다.`;
          },
        },
        {
          id: 'monitor',
          label: '지켜본다',
          detail: '지금은 아무것도 잃지 않는다. 뒤에 터질 수 있다',
          fallback: true,
          apply: () => '경과를 지켜보기로 했다. 기록에는 남겨 두었다.',
          after: {
            quarters: 4,
            apply: (s, h) => {
              const p = s.programs.find((x) => x.id === h.recall('program')) || s.programs[0];
              if (!p) return '';
              if (h.rng.chance(0.45)) {
                const cost = Math.round(p.devCost * 0.11 + 260);
                h.expense(cost);
                h.reputation(-7);
                p.defectRisk = Math.round(Math.min(CONFIG.defectRiskMax, p.defectRisk * 1.15) * 1000) / 1000;
                return `묻어 뒀던 ${p.name}의 결함이 운항 중에 드러났다. 대응 비용 ${money(cost)}, 평판이 크게 상했다.`;
              }
              return `${p.name}의 결함 징후는 결국 아무 일도 아니었다. 운이 좋았다.`;
            },
          },
        },
      ],
    },

    // ── 인력 ──
    {
      id: 'poach_team',
      name: '경쟁사 설계팀 영입 기회',
      weight: (s) => (s.cash > 600 ? 8 : 0),
      text: () =>
        '경쟁사 구조설계팀이 통째로 이직을 타진해 왔다. 개발 속도를 끌어올릴 수 있지만 몸값이 만만치 않고, 업계에 소문도 난다.',
      options: [
        {
          id: 'hire',
          label: '영입한다',
          detail: '엔지니어가 늘고 개발이 빨라진다. 비용과 뒷말이 따른다',
          apply: (s, h) => {
            const heads = 400;
            const cost = Math.round(heads * CONFIG.engineerHireCost * 1.6);
            if (s.cash < cost) return '자금이 모자라 영입은 무산됐다.';
            h.expense(cost);
            s.engineers += heads;
            for (const p of inDevelopment(s)) p.progress = Math.min(99, p.progress + 4);
            h.reputation(-2);
            return `${money(cost)}을 들여 ${heads}명을 데려왔다. 개발 중인 기종의 진척이 한 번에 붙었다.`;
          },
        },
        {
          id: 'pass',
          label: '보내 준다',
          detail: '돈도 뒷말도 없다',
          fallback: true,
          apply: () => '영입을 포기했다. 그들은 다른 곳으로 갔다.',
        },
      ],
    },
    {
      id: 'loyal_direct_order',
      name: '핵심 고객의 수의계약',
      // 단골의 진짜 보상 — 입찰 없이 전화가 온다. 실제로도 대량 운용사는 입찰
      // 대신 기존 제조사와 조용히 추가분을 계약한다(사우스웨스트가 그랬다).
      // 상시 후보면 로테이션을 통째로 채워 다른 사건(대개 더 쓴 것)을 밀어낸다 —
      // 측정: 이 사건 하나로 기준 하네스 파산이 12→6/40 으로 반토막 났다.
      // 쿨다운 12분기 + 낮은 가중치로 "가끔 오는 전화"로 만든다.
      weight: (s) => (pickLoyalDeal(s) && s.turn - (s.lastLoyalDealTurn ?? -99) >= 12 ? 4 : 0),
      text: (s, h) => {
        const deal = pickLoyalDeal(s);
        h.remember('airline', deal.airline.id);
        h.remember('airlineName', deal.airline.name);
        h.remember('program', deal.program.id);
        h.remember('qty', h.rng.int(6, 12));
        return `${iGa(deal.airline.name)} 입찰 없이 ${deal.program.name} ${h.recall('qty')}기 추가 도입을 타진해 왔다 — 오래 거래한 사이라 조건만 맞으면 바로 계약하겠다고 한다. 대신 단골값을 기대한다.`;
      },
      options: [
        {
          id: 'accept',
          label: '단골값에 계약한다',
          detail: '정가의 92% — 입찰 비용 없이 물량과 관계를 얻는다',
          apply: (s, h) => {
            s.lastLoyalDealTurn = s.turn;
            const p = s.programs.find((x) => x.id === h.recall('program'));
            const a = AIRLINES.find((x) => x.id === h.recall('airline'));
            // memo 를 믿지 않고 수락 시점에 다시 재검한다 — 검사가 없던 시절의
            // 세이브에 열려 있던 사건이 옛 조건으로 서명되는 걸 막는다.
            const fit = loyalDealFit(a, p);
            if (!fit) return '그 기종은 이 항공사의 노선에 맞지 않아 계약이 무산됐다.';
            const qty = h.recall('qty', 8);
            const unitPrice = Math.round(p.listPrice * 0.92);
            h.order({ airlineId: h.recall('airline'), airlineName: h.recall('airlineName'), program: p, qty, unitPrice, reqEtops: fit.needEtops });
            h.relation(h.recall('airline'), 4);
            return `${h.recall('airlineName')}과 ${qty}기 수의계약 (대당 ${money(unitPrice)}). 오래된 거래가 또 한 장 쌓였다.`;
          },
        },
        {
          id: 'hold_price',
          label: '정가를 고수한다',
          detail: '성사되면 이문이 크지만, 단골이 서운해할 수 있다',
          apply: (s, h) => {
            s.lastLoyalDealTurn = s.turn;
            const p = s.programs.find((x) => x.id === h.recall('program'));
            const a = AIRLINES.find((x) => x.id === h.recall('airline'));
            const fit = loyalDealFit(a, p);
            if (!fit) return '그 기종은 이 항공사의 노선에 맞지 않아 계약이 무산됐다.';
            if (h.rng.chance(0.55)) {
              const qty = h.recall('qty', 8);
              const unitPrice = p.listPrice;
              h.order({ airlineId: h.recall('airline'), airlineName: h.recall('airlineName'), program: p, qty, unitPrice, reqEtops: fit.needEtops });
              return `${h.recall('airlineName')}이 결국 정가에 서명했다 (대당 ${money(unitPrice)}).`;
            }
            h.relation(h.recall('airline'), -3);
            return `${h.recall('airlineName')}이 제안을 거둬들였다 — "단골한테 이러기냐"는 말이 남았다.`;
          },
        },
        {
          id: 'decline',
          label: '지금은 라인이 빠듯하다',
          detail: '정중히 미룬다. 관계가 조금 상한다',
          fallback: true,
          apply: (s, h) => {
            s.lastLoyalDealTurn = s.turn;
            h.relation(h.recall('airline'), -1);
            return `${h.recall('airlineName', '고객사')}에 다음 기회를 기약했다.`;
          },
        },
      ],
    },
    {
      id: 'rival_crisis_talent',
      name: '결함 파동 — 흩어지는 인력',
      // 경쟁사 결함 파동(양수 위기) 중에만 온다 — 호평(음수)은 사람이 빠져나올
      // 이유가 없다. 파동은 벌이 아니라 기회로 설계돼 있고, 이 사건이 그 손잡이다.
      weight: (s) =>
        Object.values(s.rivalCrises || {}).some((c) => c.amount > 0) && s.cash > 200 ? 7 : 0,
      text: (s, h) => {
        const typeId = Object.entries(s.rivalCrises).find(([, c]) => c.amount > 0)[0];
        const t = (Fleet && Fleet.AIRCRAFT.find((x) => x.id === typeId)) || null;
        const maker = t && Fleet.MAKER_BY_ID[t.maker];
        h.remember('makerName', maker ? maker.name : '경쟁사');
        h.remember('typeName', t ? t.name : '문제 기종');
        return `${maker ? maker.name : '경쟁사'}의 ${t ? t.name : '신기종'} 결함 파동으로 그쪽 엔지니어들이 이력서를 돌리고 있다. 평소보다 싸게, 소문 없이 데려올 수 있는 창이다.`;
      },
      options: [
        {
          id: 'wave',
          label: '크게 받아들인다',
          detail: '엔지니어 400명을 평시보다 싸게. 급여 부담은 늘어난다',
          apply: (s, h) => {
            const heads = 400;
            // 위기 이직은 웃돈이 없다 — 평시 영입(×1.6)과 달리 제값의 70%.
            const cost = Math.round(heads * CONFIG.engineerHireCost * 0.7);
            if (s.cash < cost) return '자금이 모자라 창을 놓쳤다.';
            h.expense(cost);
            s.engineers += heads;
            return `${money(cost)}에 ${heads}명이 넘어왔다 — ${h.recall('makerName', '경쟁사')} 사정이 그렇다. 평판 손상 없이 조직이 커졌다.`;
          },
        },
        {
          id: 'select',
          label: '그 결함을 아는 사람만',
          detail: '수습팀 핵심 몇을 산다 — 개발 중 기종의 결함 위험이 준다',
          apply: (s, h) => {
            const cost = 180;
            if (s.cash < cost) return '자금이 모자라 접촉을 접었다.';
            h.expense(cost);
            const targets = s.programs.filter((p) => p.phase === 'dev' || p.phase === 'cert');
            if (!targets.length) return `${money(cost)}을 썼지만 배운 교훈을 쓸 개발 기종이 없다.`;
            for (const p of targets) p.defectRisk = Math.round(p.defectRisk * 0.92 * 1000) / 1000;
            return `${h.recall('typeName', '그 기종')} 수습팀 핵심을 데려왔다 (${money(cost)}). 남의 실패가 우리 결함 위험을 깎았다.`;
          },
        },
        {
          id: 'pass',
          label: '지켜본다',
          detail: '남의 불행에 손대지 않는다',
          fallback: true,
          apply: () => '창이 닫히게 두었다. 그들은 다른 회사로 흩어졌다.',
        },
      ],
    },
    {
      id: 'union_talks',
      name: '노사 임금 협상',
      weight: (s) => (s.engineers > 1200 ? 9 : 0),
      text: (s, h) => {
        const pct = h.rng.int(6, 12);
        h.remember('pct', pct);
        return `조립·설계 인력이 임금 ${pct}% 인상을 요구했다. 거부하면 파업 가능성이 있다.`;
      },
      options: [
        {
          id: 'accept',
          label: '요구를 수용한다',
          detail: '인건비가 오른다. 현장은 조용해진다',
          apply: (s, h) => {
            const pct = h.recall('pct', 8);
            const cost = Math.round(s.engineers * CONFIG.engineerCostPerQuarter * (pct / 100) * 4);
            h.expense(cost);
            h.reputation(1);
            return `임금 인상에 합의했다. 향후 1년치 추가 인건비 ${money(cost)}을 선반영했다.`;
          },
        },
        {
          id: 'refuse',
          label: '거부한다',
          detail: '돈은 아끼지만 파업 위험을 진다',
          fallback: true,
          apply: (s, h) => {
            if (h.rng.chance(0.5)) {
              s.effects.strikeQuarters = Math.max(s.effects.strikeQuarters || 0, h.rng.int(1, 2));
              h.reputation(-3);
              return `협상이 결렬되고 파업에 들어갔다. ${s.effects.strikeQuarters}개 분기 동안 생산이 반토막 난다.`;
            }
            return '요구를 물렸다. 현장의 불만은 남았지만 라인은 돌아간다.';
          },
        },
        {
          id: 'share',
          label: '성과 연동으로 바꾼다',
          detail: '지금은 적게 준다. 이익이 나면 그만큼 나눠야 한다',
          apply: (s, h) => {
            const cost = Math.round(s.engineers * CONFIG.engineerCostPerQuarter * 0.02 * 4);
            h.expense(cost);
            return `기본 인상은 최소화하고 성과 연동제에 합의했다. 당장은 ${money(cost)}만 나간다.`;
          },
          after: {
            quarters: 4,
            apply: (s, h) => {
              const recent = (s.history || []).slice(-4);
              const profit = recent.reduce((a, x) => a + (x.net || 0), 0);
              if (profit > 0) {
                const share = Math.round(profit * 0.08);
                h.expense(share);
                return `성과 연동 약정에 따라 최근 1년 이익의 8%인 ${money(share)}을 지급했다.`;
              }
              h.reputation(-1);
              return '적자라 성과급은 없었다. 현장의 기대가 꺾였다.';
            },
          },
        },
      ],
    },

    // ── 규제·정책 ──
    {
      id: 'emission_rule',
      name: '배출 규제 예고',
      weight: (s) => (s.turn > 20 ? 8 : 0),
      text: () =>
        '규제 당국이 몇 해 뒤 발효될 배출 기준 초안을 공개했다. 지금 대응하면 비싸지만, 기준이 확정된 뒤에는 더 비싸진다.',
      options: [
        {
          id: 'early',
          label: '선제 대응한다',
          detail: '지금 비용을 치르고 뒤에 남들이 못 하는 걸 한다',
          apply: (s, h) => {
            const cost = 420;
            h.expense(cost);
            return `${money(cost)}을 배출 저감 설계에 미리 넣었다. 아직 아무 효과도 눈에 보이지 않는다.`;
          },
          after: {
            quarters: 6,
            apply: (s, h) => {
              h.reputation(6);
              for (const p of s.programs.filter((x) => x.phase === 'production')) {
                p.listPrice = Math.round(p.listPrice * 1.03);
              }
              return '배출 기준이 발효됐다. 미리 대응한 우리 기종은 프리미엄을 받는다.';
            },
          },
        },
        {
          id: 'wait',
          label: '확정을 기다린다',
          detail: '지금은 한 푼도 안 쓴다. 확정되면 급히 맞춰야 한다',
          fallback: true,
          apply: () => '규제 초안을 지켜보기로 했다.',
          after: {
            quarters: 6,
            apply: (s, h) => {
              const cost = Math.round(300 + s.programs.filter((p) => p.phase === 'production').length * 220);
              h.expense(cost);
              return `배출 기준이 발효됐다. 뒤늦게 맞추느라 ${money(cost)}이 급하게 나갔다.`;
            },
          },
        },
      ],
    },
    {
      id: 'gov_grant',
      name: '정부 개발 지원 제안',
      weight: (s) => (inDevelopment(s).length ? 8 : 0),
      text: (s, h) => {
        // 어느 프로그램을 지원받았는지 남긴다. "아무 신형이나 양산되면 상환"으로 두면
        // 지원 전부터 있던 기종이 인증되는 것만으로 기술료를 물게 된다.
        const p = h.rng.pick(inDevelopment(s));
        h.remember('program', p ? p.id : null);
        return `산업부가 <b>${p ? p.name : '차세대 여객기'}</b> 개발 지원을 제안했다. 조건이 붙는다 — 국내 협력사 사용 의무, 그리고 그 기종이 시장에 나오면 기술료 상환.`;
      },
      options: [
        {
          id: 'take',
          label: '지원을 받는다',
          detail: '지금 현금이 들어온다. 나중에 갚는다',
          apply: (s, h) => {
            const grant = 900;
            h.income(grant);
            return `개발 지원금 ${money(grant)}을 받았다. 성공하면 기술료로 돌려줘야 한다.`;
          },
          after: {
            quarters: 8,
            apply: (s, h) => {
              const p = s.programs.find((x) => x.id === h.recall('program'));
              // 그 기종이 죽었으면 상환할 성공이 없다.
              if (!p || p.phase === 'cancelled' || p.phase === 'sold') {
                return '지원받은 프로그램이 사라졌다. 산업부가 기술료를 물리지 않기로 했다.';
              }
              if (p.phase !== 'production') {
                // 유예이지 면제가 아니다. 다시 예약하지 않으면 개발이 8분기보다
                // 오래 걸리는 흔한 경우에 지원금이 통째로 공짜가 된다.
                const waited = h.recall('grantWaited', 0) + 1;
                h.remember('grantWaited', waited);
                if (waited >= 6) return `${p.name}이 끝내 시장에 나오지 못했다. 산업부가 기술료를 면제했다.`;
                // 종료 정산에는 미룰 다음 분기가 없다. 유예로 닫으면 지원금이 통째로
                // 공짜가 되므로(종료 직전에 받고 튀는 수가 생긴다), 성공하지 못한
                // 지원은 원금을 회수당한다 — 기술료가 아니라 지원금 자체다.
                if (h.final) {
                  const clawback = 900;
                  h.expense(clawback);
                  return `${p.name}이 시장에 나오지 못한 채 경영이 끝났다. 산업부가 개발 지원금 ${money(clawback)}을 회수했다.`;
                }
                return { text: `${p.name}이 아직 시장에 없다. 기술료 상환이 4분기 유예됐다.`, retryIn: 4 };
              }
              const fee = 1150;
              h.expense(fee);
              return `${p.name}이 양산에 들어가면서 기술료 ${money(fee)}을 상환했다.`;
            },
          },
        },
        {
          id: 'refuse',
          label: '독자적으로 간다',
          detail: '돈은 없지만 손발이 묶이지 않는다',
          fallback: true,
          apply: () => '지원을 사양했다. 협력사 선택은 우리 뜻대로 한다.',
        },
      ],
    },

    // ── 시장·영업 ──
    {
      id: 'airshow',
      name: '에어쇼 출품 결정',
      weight: () => 7,
      text: () =>
        '국제 에어쇼가 열린다. 출품은 비싸지만 항공사 실무진이 모이고, 부스에서 본 기체로 현장 공고가 열리기도 한다.',
      options: [
        {
          id: 'full',
          label: '대형 부스로 나간다',
          detail: '비싸다. 관계·평판이 오르고, 내놓을 기체가 있으면 이번 분기 현장 공고가 열린다',
          apply: (s, h) => {
            const cost = 260;
            h.expense(cost);
            h.reputation(4);
            for (const a of AIRLINES) h.relation(a.id, 3);
            const floor = showFloor(s);
            if (!floor || !h.rfp) {
              h.reputation(-2);
              return `${money(cost)}을 들여 대형 부스를 냈지만 살 수 있는 비행기가 없었다. 명함만 돌렸다.`;
            }
            const qty = 6 + ((((s.turn % 7) + 7) % 7));
            const rfp = h.rfp({
              airline: floor.airline,
              segment: floor.program.segment,
              qty,
              seats: floor.program.seats,
              range: floor.program.range,
              reason: 'airshow',
            });
            return `${money(cost)}을 들여 ${floor.program.name} 부스를 냈다. ${floor.airline.name}이 현장에서 ${rfp.qty}기 공고를 열었다 — 이번 분기 수주전에서 받아라.`;
          },
        },
        {
          id: 'targeted',
          label: '주요 고객만 따로 만난다',
          detail: '싸게 간다. 양산기와 관계가 있으면 그 자리에서 계약하고, 아니면 견적만 가져간다',
          apply: (s, h) => {
            const cost = 70;
            h.expense(cost);
            const a = topCustomer(s);
            h.relation(a.id, 12);
            const p = s.programs.find((x) => x.phase === 'production' && x.segment === a.bias) || biggestProgram(s);
            if (p && (s.relations[a.id] ?? 0) >= 52) {
              const qty = 4;
              const unitPrice = Math.round(p.listPrice * 0.9);
              const needEtops = a.rangeBand[0] >= ETOPS_RANGE_KM && p.engines !== 4;
              h.order({ airlineId: a.id, airlineName: a.name, program: p, qty, unitPrice, reqEtops: needEtops });
              return `${money(cost)}만 쓰고 ${a.name}과 따로 만났다. 자리에서 ${p.name} ${qty}기를 계약했다.`;
            }
            h.relation(a.id, -3);
            return `${money(cost)}만 쓰고 ${a.name} 경영진과 만났다. 그들은 조건을 적어 다른 제작사와 비교하러 갔다.`;
          },
        },
        {
          id: 'skip',
          label: '나가지 않는다',
          detail: '한 푼도 안 쓴다. 존재감도 없다',
          fallback: true,
          apply: (s, h) => {
            h.reputation(-2);
            return '에어쇼를 건너뛰었다. 경쟁사 부스만 붐볐다.';
          },
        },
      ],
    },
    {
      id: 'lessor_bulk',
      name: '리스사 대량 발주 타진',
      weight: (s) => (hasProduction(s) ? 9 : 0),
      text: (s, h) => {
        const p = biggestProgram(s);
        const qty = h.rng.int(18, 34);
        h.remember('program', p ? p.id : null);
        h.remember('qty', qty);
        return `대형 리스사가 <b>${p ? p.name : '주력기'}</b> ${qty}기를 한 번에 사겠다고 한다. 단가는 정가의 70% 수준이다.`;
      },
      options: [
        {
          id: 'accept',
          label: '받는다',
          detail: '잔고와 점유율이 단숨에 는다. 단가가 낮고 라인이 묶인다',
          apply: (s, h) => {
            const p = s.programs.find((x) => x.id === h.recall('program'));
            if (!p) return '해당 기종이 없다.';
            const qty = h.recall('qty', 20);
            const unitPrice = Math.round(p.listPrice * 0.7);
            h.order({ airlineId: 'lessor', airlineName: '국제 리스사', program: p, qty, unitPrice });
            return `${p.name} ${qty}기를 대당 ${money(unitPrice)}에 계약했다. 잔고가 단숨에 늘었다.`;
          },
        },
        {
          id: 'half',
          label: '물량을 줄여 받는다',
          detail: '라인 여력을 남긴다. 단가는 조금 낫다',
          apply: (s, h) => {
            const p = s.programs.find((x) => x.id === h.recall('program'));
            if (!p) return '해당 기종이 없다.';
            const qty = Math.max(4, Math.round(h.recall('qty', 20) / 2));
            const unitPrice = Math.round(p.listPrice * 0.78);
            h.order({ airlineId: 'lessor', airlineName: '국제 리스사', program: p, qty, unitPrice });
            return `물량을 ${qty}기로 줄이는 대신 대당 ${money(unitPrice)}으로 올려 받았다.`;
          },
        },
        {
          id: 'refuse',
          label: '거절한다',
          detail: '정가를 지킨다. 잔고는 그대로다',
          fallback: true,
          apply: () => '리스사의 저가 대량 발주를 거절했다. 정가 질서를 지켰다.',
        },
      ],
    },
    {
      id: 'delivery_slip',
      name: '인도 지연 통보',
      // 양산 중이고 인도 게이트에 안 막힌 주문만 — 선주문(개발·인증 중)이나
      // ETOPS 대기 주문은 "특별 근무로 앞당겨 뽑는" 선택지가 성립하지 않는다.
      weight: (s) => (s.backlog.some((o) => o.remaining > 0 && rushableOrder(s, o)) ? 8 : 0),
      text: (s, h) => {
        const o = h.rng.pick(s.backlog.filter((x) => x.remaining > 0 && rushableOrder(s, x)));
        h.remember('airline', o.airlineId);
        h.remember('airlineName', o.airlineName);
        h.remember('orderId', o.id);
        return `${o.airlineName}의 ${o.programName} ${o.remaining}기 인도가 밀리고 있다. 먼저 알릴지, 특별 연장 근무로 메울지 정해야 한다.`;
      },
      options: [
        {
          id: 'overtime',
          label: '특별 근무로 만회한다',
          detail: '비용을 쓰고 그 주문을 앞당겨 넘긴다. 기한도 다시 맞춘다',
          apply: (s, h) => {
            const cost = Math.round(s.engineers * CONFIG.engineerCostPerQuarter * 0.12 + 60);
            h.expense(cost);
            h.relation(h.recall('airline'), 6);

            // 돈만 쓰고 끝나면 같은 분기에 곧바로 지연 위약금을 문다 — 광고한 효과와
            // 정반대다. 특별 근무는 실제로 기체를 더 뽑고 기한을 다시 맞춘다.
            const order = s.backlog.find((o) => o.id === h.recall('orderId'));
            if (!order || order.remaining <= 0) return `${money(cost)}을 들여 라인을 돌렸지만 그 주문은 이미 정리됐다.`;
            const p = s.programs.find((x) => x.id === order.programId);
            const rushed = Math.max(1, Math.ceil(order.remaining * 0.35));
            // 재고만 얹으면 학습곡선도 원가도 건너뛴 공짜 기체가 된다 — 곧바로 팔면
            // 생산 경제가 통째로 무너진다. 정규 생산과 같이 번호를 매기고 원가를 문다.
            const buildCost = p ? h.rushProduce(p, rushed, 1.15) : 0;
            if (typeof order.dueTurn === 'number') order.dueTurn += 2;
            order.lastPenaltyTurn = undefined;
            return `${money(cost + buildCost)}을 들여 ${rushed}기를 앞당겨 뽑고 ${h.recall('airlineName', '고객사')}과 기한을 다시 맞췄다. (생산 원가 ${money(buildCost)} 포함, 급행 할증 15%)`;
          },
        },
        {
          id: 'notify',
          label: '미리 알리고 양해를 구한다',
          detail: '돈은 안 쓴다. 관계가 상한다',
          fallback: true,
          apply: (s, h) => {
            h.relation(h.recall('airline'), -8);
            h.reputation(-1);
            return `${h.recall('airlineName', '고객사')}에 지연을 미리 알렸다. 항의가 돌아왔지만 은폐보다는 낫다.`;
          },
        },
      ],
    },

    // ── 재무 ──
    {
      id: 'refinance',
      name: '차환 제안',
      weight: (s) => (s.debt > 2000 ? 9 : 0),
      text: (s) =>
        `주거래 은행이 부채 ${money(s.debt)}의 차환을 제안했다. 지금 수수료를 내면 당분간 이자가 싸진다.`,
      options: [
        {
          id: 'refi',
          label: '차환한다',
          detail: '수수료를 지금 낸다. 몇 분기 이자가 내려간다',
          apply: (s, h) => {
            const fee = Math.round(s.debt * 0.015);
            h.expense(fee);
            // 감면은 가산과 다른 슬롯이다. 같은 칸을 쓰면 금융위기 가산을 지우고
            // 남은 기간 내내 할인 금리가 되어 버린다.
            s.effects.rateCut = Math.max(s.effects.rateCut || 0, 0.0025);
            s.effects.rateCutQuarters = Math.max(s.effects.rateCutQuarters || 0, 6);
            return `수수료 ${money(fee)}을 내고 차환했다. 6분기 동안 이자율이 0.25%p 내려간다.`;
          },
        },
        {
          id: 'keep',
          label: '그대로 둔다',
          detail: '수수료를 아낀다',
          fallback: true,
          apply: () => '차환 제안을 넘겼다. 조건이 나쁘지는 않았지만 현금을 아꼈다.',
        },
      ],
    },
    {
      id: 'analyst_pressure',
      name: '투자자 설명회',
      weight: (s) => (s.turn > 8 ? 7 : 0),
      text: (s) => {
        const last = (s.history || [])[s.history.length - 1];
        const tone = last && last.net < 0 ? '적자가 이어지는 이유' : '개발비 지출 계획';
        return `분기 설명회에서 애널리스트들이 ${tone}을 캐물었다. 어떻게 답할지가 곧 조달 비용이 된다.`;
      },
      options: [
        {
          id: 'candid',
          label: '있는 그대로 말한다',
          detail: '단기 평판은 깎이지만 신뢰가 쌓인다',
          fallback: true,
          apply: (s, h) => {
            h.reputation(-1);
            return '숨김없이 설명했다. 주가는 눌렸지만 장부는 깨끗하다.';
          },
          after: {
            quarters: 3,
            apply: (s, h) => {
              h.reputation(4);
              return '정직했던 설명이 뒤늦게 평가받았다. 시장의 신뢰가 올라갔다.';
            },
          },
        },
        {
          id: 'spin',
          label: '낙관적으로 포장한다',
          detail: '지금 평판이 오른다. 어긋나면 대가가 크다',
          apply: (s, h) => {
            h.reputation(3);
            return '장밋빛 전망을 내놨다. 시장이 환호했다.';
          },
          after: {
            quarters: 4,
            apply: (s, h) => {
              const recent = (s.history || []).slice(-4);
              const profit = recent.reduce((a, x) => a + (x.net || 0), 0);
              if (profit >= 0) return '내놨던 전망이 실적으로 뒷받침됐다. 시장이 조용하다.';
              h.reputation(-7);
              s.effects.rateBump = Math.max(s.effects.rateBump || 0, 0.006);
              s.effects.rateBumpQuarters = Math.max(s.effects.rateBumpQuarters || 0, 4);
              return '약속한 실적이 나오지 않았다. 신뢰가 무너지고 조달 금리가 올랐다.';
            },
          },
        },
      ],
    },

    // ── 엔진 공급사 ──
    {
      id: 'engine_exclusive',
      name: '엔진 독점 공급 제안',
      // 상시 제안은 결정 순환에서 더 매서운 사건을 밀어낸다(수의계약에서 배운 것).
      // 실적 문턱을 높이고, 한 번 오간 제안은 한동안 다시 오지 않는다.
      weight: (s) => {
        if (s.engineDeal) return 0;
        if (s.turn - (s.lastEngineDealOfferTurn ?? -99) < 10) return 0;
        const best = topEngineMaker(s);
        return best && best.units >= 60 ? 4 : 0;
      },
      text: (s, h) => {
        const best = topEngineMaker(s);
        s.lastEngineDealOfferTurn = s.turn;
        h.remember('maker', best ? best.maker : null);
        return `<b>${best.maker}</b>가 독점 공급 계약을 제안했다. 4년간 자기 엔진 인도분의 부품값 2%를 돌려주고 공급 차질 때 우선 배정을 약속한다 — 대신 그 사이 다른 공급사 엔진으로 설계하면 통합 지원 없이 개발비를 8% 더 쓴다.`;
      },
      options: [
        {
          id: 'sign',
          label: '서명한다',
          detail: '인도 리베이트 2% · 공급 우선권. 4년간 타사 엔진 설계는 개발비 +8%',
          apply: (s, h) => {
            const maker = h.recall('maker');
            if (!maker) return '제안은 흐지부지됐다.';
            // 16분기 = 4년. engine.js 의 ENGINE_DEAL_QUARTERS 와 같은 값이다.
            s.engineDeal = { maker, until: s.turn + 16 };
            return `${maker}와 독점 공급 계약을 맺었다. 인도마다 리베이트가 돌아오고, 엔진이 모자라면 우리 라인이 먼저 받는다.`;
          },
        },
        {
          id: 'decline',
          label: '거절한다',
          detail: '어느 엔진이든 자유롭게 고른다. 리베이트는 없다',
          fallback: true,
          apply: () => '설계의 자유를 지키기로 했다. 공급사는 아쉬운 얼굴로 돌아갔다.',
        },
      ],
    },
    {
      id: 'engine_launch_partner',
      name: '신엔진 런칭 파트너 제안',
      weight: (s) => (upcomingEngineFor(s) ? 5 : 0),
      text: (s, h) => {
        const e = upcomingEngineFor(s);
        const cost = Math.round(420 * e.costMult);
        h.remember('engine', e.id);
        h.remember('cost', cost);
        return `${e.maker}가 <b>${e.name}</b>(정식 취항 ${e.eis}년)의 런칭 파트너를 제안했다. 개발 분담금 ${money(cost)}을 내면 남들보다 ${Engines.EARLY_ACCESS_YEARS}년 먼저 이 엔진으로 설계할 수 있다 — 초기 결함 위험도 그만큼 먼저 떠안는다.`;
      },
      options: [
        {
          id: 'join',
          label: '분담금을 낸다',
          detail: '이 엔진을 2년 먼저 쓴다. 성숙도 위험은 온전히 우리 몫',
          apply: (s, h) => {
            const engId = h.recall('engine');
            const cost = h.recall('cost', 420);
            const e = Engines.get(engId);
            if (!e) return '제안은 흐지부지됐다.';
            h.expense(cost);
            s.engineEarlyAccess = s.engineEarlyAccess || {};
            s.engineEarlyAccess[engId] = true;
            return `${money(cost)}을 분담했다. ${e.name}이 우리 설계 카탈로그에 ${Engines.EARLY_ACCESS_YEARS}년 먼저 올라온다.`;
          },
        },
        {
          id: 'decline',
          label: '기다린다',
          detail: '정식 취항 후에 성숙한 엔진을 쓴다',
          fallback: true,
          apply: () => '남들이 초기 트러블을 겪어 주기를 기다리기로 했다.',
        },
      ],
    },

    // ── 정부 특수기 사업 ──
    {
      id: 'gov_special',
      name: '정부 특수기 사업 공고',
      // 검증된 양산 기종이 있어야 공고가 온다. 상시 후보면 결정 순환에서 더 매서운
      // 사건을 밀어내므로(수의계약에서 배운 것) 긴 쿨다운을 둔다 — 국방 사업은
      // 원래 몇 년에 한 번 오는 것이기도 하다.
      weight: (s) => {
        // 게임 막판에는 안 온다 — 발표·개조·인도가 들어갈 시간이 없는 공고는 함정이다.
        if (s.turn < 12 || s.turn > CONFIG.totalTurns - 12) return 0;
        if (s.turn - (s.lastGovBidTurn ?? -99) < 14) return 0;
        return govMissionPick(s) ? 5 : 0;
      },
      text: (s, h) => {
        const pick = govMissionPick(s);
        s.lastGovBidTurn = s.turn;
        const { mission: m, program: p } = pick;
        const qty = h.rng.int(m.qty[0], m.qty[1]);
        const unitPrice = Math.round(p.listPrice * m.priceMult);
        const convCost = Math.round(p.devCost * m.convRate);
        // 경쟁 상대 — 그 세그먼트에서 실제로 팔고 있는 제조사가 맞불을 놓는다.
        const year = CONFIG.startYear + Math.floor(s.turn / 4);
        const rivals = Fleet.availableTypes(p.segment, year).filter((t) => !(s.playerMakers || []).includes(t.maker) && !(s.acquiredTypes || {})[t.id]);
        const rivalType = rivals.length ? rivals.reduce((a, b) => (b.power > a.power ? b : a)) : null;
        const rivalMaker = rivalType && Fleet.MAKER_BY_ID[rivalType.maker];
        h.remember('mission', m.id);
        h.remember('program', p.id);
        h.remember('qty', qty);
        h.remember('unitPrice', unitPrice);
        h.remember('rival', rivalMaker ? `${rivalMaker.name} ${rivalType.name} 개조안` : '경쟁사 개조안');
        return (
          `${iGa(m.customer)} <b>${m.name}</b> ${qty}기 도입 사업을 공고했다. 실적이 두터운 우리 <b>${p.name}</b>이 유력 후보다 — ` +
          `낙찰되면 대당 ${money(unitPrice)}(정가의 ${Math.round(m.priceMult * 100)}%)에 개조 개발비 ${money(convCost)}이 든다.` +
          (rivalMaker ? ` ${rivalMaker.name}도 ${rivalType.name} 개조안으로 뛰어들었다.` : '')
        );
      },
      options: [
        {
          id: 'fixed',
          label: '고정가로 입찰한다',
          detail: '이길 확률이 높다. 개조가 꼬이면 초과 비용은 전부 우리 몫이다',
          apply: govApply('fixed'),
          after: { quarters: 2, apply: govAward },
        },
        {
          id: 'costplus',
          label: '원가보전으로 입찰한다',
          detail: '초과 비용은 정부가 진다. 대신 심의에서 밀리기 쉽고 단가도 10% 짜다',
          apply: govApply('costplus'),
          after: { quarters: 2, apply: govAward },
        },
        {
          id: 'pass',
          label: '응모하지 않는다',
          detail: '여객 사업에 집중한다. 공고는 몇 년 뒤에나 다시 온다',
          fallback: true,
          apply: () => '특수기 사업을 넘겼다. 개조 라인을 세울 여력은 여객기에 쓴다.',
        },
      ],
    },

    // ── 경쟁사 프로그램 인수 — A220 이야기 ──
    {
      id: 'rival_takeover',
      name: '흔들리는 프로그램 — 인수 제안',
      // 결함 파동(양수 위기) 중인 경쟁 기종만 매물로 나온다. 몇 년에 한 번 오는
      // 큰 기회라 쿨다운이 길다 — 상시 후보면 위기 자체가 쇼핑 목록이 된다.
      weight: (s) => {
        if (s.turn - (s.lastTakeoverOfferTurn ?? -99) < TAKEOVER.cooldown) return 0;
        if (s.cash < 1200) return 0;
        return takeoverTarget(s) ? 6 : 0;
      },
      text: (s, h) => {
        const t = takeoverTarget(s);
        s.lastTakeoverOfferTurn = s.turn;
        const maker = Fleet.MAKER_BY_ID[t.maker];
        const seg = SEGMENTS[t.segment];
        const fullPrice = Math.round(seg.devBase * TAKEOVER.fullRate);
        const bpPrice = Math.round(seg.devBase * TAKEOVER.blueprintRate);
        const qty = h.rng.int(TAKEOVER.backlogQty[0], TAKEOVER.backlogQty[1]);
        h.remember('type', t.id);
        h.remember('qty', qty);
        return (
          `결함 파동에 짓눌린 ${iGa(maker ? maker.name : t.maker)} <b>${t.name}</b> 프로그램(${seg.name} ${t.seats}석 · ${t.range.toLocaleString('en-US')}km)을 매물로 내놨다. ` +
          `통째 인수는 ${money(fullPrice)} — 라인과 손해 보는 승계 계약 ${qty}기, 남의 설계라는 위험까지 함께다. ` +
          `도면·형식증명만 사면 ${money(bpPrice)}. 에어버스가 C시리즈를 이렇게 가져갔다.`
        );
      },
      options: [
        {
          id: 'full',
          label: '통째로 인수한다',
          detail: '헐값. 라인·기존 선단 지원이 딸려오지만, 저마진 승계 계약과 높은 결함 위험도 함께다',
          apply: (s, h) => {
            const r = root.AirlinerEngine.acquireProgram(s, h.recall('type'), 'full', { backlogQty: h.recall('qty') });
            return r.ok
              ? `계약서에 서명했다. ${r.program.name}은 이제 우리 기종이다 — 통합이 끝나면 인도가 시작된다.`
              : `인수는 무산됐다 — ${r.error}`;
          },
        },
        {
          id: 'blueprint',
          label: '도면과 형식증명만 산다',
          detail: '몇 배 비싸다. 대신 부채 없이 깨끗하게 시작한다 — 라인은 우리가 세운다',
          apply: (s, h) => {
            const r = root.AirlinerEngine.acquireProgram(s, h.recall('type'), 'blueprint');
            return r.ok
              ? `${r.program.name}의 도면과 형식증명을 가져왔다. 라인을 세우는 것부터가 우리 일이다.`
              : `인수는 무산됐다 — ${r.error}`;
          },
        },
        {
          id: 'pass',
          label: '지나가게 둔다',
          detail: '남의 위기에 손대지 않는다. 프로그램은 다른 곳으로 넘어가거나 사라진다',
          fallback: true,
          apply: () => '매물을 넘겼다. 그 프로그램의 운명은 남의 이야기로 남는다.',
        },
      ],
    },

    // ── 본국 정부 ──
    {
      id: 'state_order',
      name: '국영 항공사 발주',
      /**
       * 국가가 자국 제조사의 라인을 채워 준다. 수출이 막혀도 곳간의 바닥은 받쳐 주되,
       * 단가가 짜서 여기에 기대면 살아는 남고 크지는 못한다.
       *
       * 곳간이 마를수록 자주 온다 — 실제로도 국가 발주는 산업이 흔들릴 때 나온다.
       * 그게 이 사건을 "가끔 오는 보너스"가 아니라 **구제금융의 얼굴**로 만든다.
       */
      weight: (s) => {
        const spec = (s.trait || {}).stateOrders;
        if (!spec || !stateOrderPick(s)) return 0;
        if (s.turn - (s.lastStateOrderTurn ?? -99) < (spec.cooldown || 11)) return 0;
        // 현금이 넉넉하면 굳이 오지 않는다. 마를수록 문을 두드린다.
        //
        // 가중치가 큰 이유: 결정 순환은 사건 20종이 나눠 갖는 자리라, 이 사건이
        // 실제로 몇 번 오는지는 가중치가 아니라 **쿨다운**(11분기)이 정한다.
        // 처음 잡았던 9/6/3 은 80분기를 완주해도 평균 1.8회에 그쳐, 사건 설명
        // ("곳간이 마를수록 자주 온다")과 실제가 어긋났다. 지금 값은 완주 판에서
        // 3~4회 — 5년에 한 번쯤 오는 국가 조달 주기다.
        //
        // 이 값이 다른 회사의 순환을 밀어낼 걱정은 없다: stateOrders 를 가진 회사가
        // UAC 하나뿐이라 사정거리가 정확히 한 회사다.
        return s.cash < 1500 ? 26 : s.cash < 4000 ? 17 : 8;
      },
      text: (s, h) => {
        const spec = s.trait.stateOrders;
        const p = stateOrderPick(s);
        const qty = h.rng.int(spec.qty[0], spec.qty[1]);
        // 국산 엔진을 단 기체는 정부가 더 쳐 준다 — 발주의 명분이 "자국 산업"이라
        // 국산화율이 곧 값이다. 두 사업(UEC 국산화 · 국가 발주)이 만나는 지점이고,
        // 국산 엔진이 연비로 치르는 값을 여기서 일부 돌려받는다.
        const domestic = !!(Engines.get(p.engine) || {}).domestic;
        const bonus = domestic ? ((s.trait.localEngine || {}).stateBonus || 0) : 0;
        const rate = spec.priceMult + bonus;
        const unitPrice = Math.round(p.listPrice * rate);
        h.remember('program', p.id);
        h.remember('qty', qty);
        h.remember('unitPrice', unitPrice);
        h.remember('customer', spec.customer);
        return (
          `산업부가 ${spec.customer}를 통해 <b>${p.name}</b> ${qty}기를 입찰 없이 사겠다고 한다. ` +
          `대당 ${money(unitPrice)} — 정가의 ${Math.round(rate * 100)}%다. ` +
          (domestic
            ? `국산 엔진을 단 기체라 단가를 ${Math.round(bonus * 100)}%p 더 쳐 줬다. `
            : '') +
          `"자국 라인을 놀릴 수는 없지 않느냐"는 것이 명분이고, 실제로 라인은 놀고 있다.`
        );
      },
      options: [
        {
          id: 'take_all',
          label: '전량 받는다',
          detail: '라인이 채워지고 선수금이 들어온다. 대신 국영 물량으로 사는 회사로 읽힌다',
          apply: (s, h) => {
            s.lastStateOrderTurn = s.turn;
            const p = s.programs.find((x) => x.id === h.recall('program'));
            if (!p || p.phase !== 'production') return '그 사이 기체가 양산에서 빠지면서 발주가 무산됐다.';
            const qty = h.recall('qty', 8);
            const unitPrice = h.recall('unitPrice', Math.round(p.listPrice * 0.78));
            // gov 표식 — 항공사발 취소 충격(9·11·연쇄 파산)이 비켜 간다. 산업 정책으로
            // 넣은 발주는 불황이라고 거둬들이지 않는다(그러라고 넣는 물량이다). 다만
            // 선단은 's.fleets.state' 로 쌓여 **민항 점유율에도 애프터마켓에도 정상 반영**된다 —
            // 군용 특수기('gov' 선단)와 달리 이건 여객기를 여객 노선에 파는 일이다.
            h.order({ airlineId: 'state', airlineName: h.recall('customer', '국영 항공사'), program: p, qty, unitPrice, gov: true });
            // 국영 물량으로 라인을 채우는 회사는 서방 항공사의 심사 목록에서 뒤로 밀린다.
            // 평판은 곧 서방의 벽이 녹는 속도라, 이 감점이 "지금 살고 나중에 못 나간다"가 된다.
            h.reputation(-2);
            return `${h.recall('customer', '국영 항공사')}와 ${qty}기 계약 (대당 ${money(unitPrice)}). 라인은 채웠다 — 다만 업계지는 "국영 발주로 연명"이라고 썼다.`;
          },
          after: {
            quarters: 4,
            apply: (s, h) => {
              // 다음 해 예산 심의. 국가 발주의 진짜 성질은 물량이 아니라 **예산의 변덕**이다.
              //
              // 종료 정산(h.final)에서 그냥 닫으면 안 된다. 마지막 네 분기에 전량
              // 수락하면 선수금은 챙기고 광고한 하방(예산 삭감)만 영영 피해 가는,
              // "늦게 고를수록 이득"인 구멍이 생긴다 — gov_grant 가 같은 이유로
              // 종료 시 원금을 회수한다. 다만 **상방은 종료에서 값을 못 한다**:
              // 추가 발주를 넣어 봐야 인도할 분기가 없다. 그래서 종료 정산은
              // 같은 주사위를 굴리되 상방은 물량 없이 문장으로만 닫고, 하방은
              // 그대로 청구한다.
              const p = s.programs.find((x) => x.id === h.recall('program'));
              const passed = h.rng.chance(0.55) && p && p.phase === 'production';
              if (passed) {
                if (h.final) return `다음 해 예산이 통과됐지만, 인도할 분기가 남지 않은 채 경영이 끝났다.`;
                const extra = Math.max(2, Math.round(h.recall('qty', 8) * 0.4));
                const unitPrice = h.recall('unitPrice', Math.round(p.listPrice * 0.78));
                h.order({ airlineId: 'state', airlineName: h.recall('customer', '국영 항공사'), program: p, qty: extra, unitPrice, gov: true });
                return `다음 해 예산이 통과되면서 ${p.name} ${extra}기가 추가 발주됐다.`;
              }
              const cut = Math.round(h.recall('qty', 8) * h.recall('unitPrice', 40) * 0.08);
              h.expense(cut);
              return `예산 심의에서 항공 예산이 깎였다. 이미 시작한 물량의 대금 일부(${money(cut)})가 우리 부담으로 넘어왔다.`;
            },
          },
        },
        {
          id: 'take_half',
          label: '절반만 받는다',
          detail: '라인의 절반은 수출용으로 비워 둔다 — 물량은 적지만 평판은 지킨다',
          fallback: true,
          apply: (s, h) => {
            s.lastStateOrderTurn = s.turn;
            const p = s.programs.find((x) => x.id === h.recall('program'));
            if (!p || p.phase !== 'production') return '그 사이 기체가 양산에서 빠지면서 발주가 무산됐다.';
            const qty = Math.max(1, Math.floor(h.recall('qty', 8) / 2));
            const unitPrice = h.recall('unitPrice', Math.round(p.listPrice * 0.78));
            h.order({ airlineId: 'state', airlineName: h.recall('customer', '국영 항공사'), program: p, qty, unitPrice, gov: true });
            return `${h.recall('customer', '국영 항공사')}와 ${qty}기만 계약했다. 나머지 슬롯은 수출 상담용으로 비워 뒀다.`;
          },
        },
        {
          id: 'refuse',
          label: '전량 거절한다',
          detail: '수출에만 집중한다. 산업부가 서운해하고, 다음 발주는 한참 뒤다',
          apply: (s, h) => {
            const spec = s.trait.stateOrders || {};
            // 거절의 값은 "다음이 늦어진다"다. 쿨다운의 기준점을 미래로 밀어 둔다.
            s.lastStateOrderTurn = s.turn + Math.round((spec.cooldown || 11) * 0.8);
            h.reputation(1);
            return '산업부의 제안을 사양했다. 라인은 비었지만 우리 이름은 국영 발주 명단에 없다 — 다음 제안은 한참 뒤에나 올 것이다.';
          },
        },
      ],
    },
  ];

  const BY_ID = Object.fromEntries(DECISIONS.map((d) => [d.id, d]));

  function get(id) {
    return BY_ID[id] || null;
  }

  function optionOf(decisionId, optionId) {
    const d = get(decisionId);
    if (!d) return null;
    return d.options.find((o) => o.id === optionId) || null;
  }

  function fallbackOf(decisionId) {
    const d = get(decisionId);
    if (!d) return null;
    return d.options.find((o) => o.fallback) || d.options[d.options.length - 1];
  }

  root.AirlinerDecisions = { DECISIONS, get, optionOf, fallbackOf };
})(typeof globalThis !== 'undefined' ? globalThis : this);
