/*
 * 수주전 — RFP 생성과 입찰 점수 계산.
 *
 * 점수는 0~100 스케일이며 경쟁사 점수와 직접 비교한다. 항목 가중치가 시장 상황
 * (연료지수·항공사 성향)에 따라 움직이는 게 이 게임의 핵심 긴장이다.
 */
(function (root) {
  'use strict';

  const { SEGMENTS, AIRLINES, CONFIG, RIVAL_STRENGTH_CAP, RIVAL_STRENGTH_FLOOR, FIELD_REQUIREMENT, ETOPS_RANGE_KM, UPGAUGE_PER_YEAR, BID_PLEDGES, BID_FINANCING } =
    root.AirlinerData;
  const Engines = root.AirlinerEngines;
  const { clamp } = root.AirlinerDesign;
  const Fleet = root.AirlinerFleet;
  const Airframe = root.AirlinerAirframe;

  const SEGMENT_IDS = Object.keys(SEGMENTS);

  function airlineOf(id) {
    return AIRLINES.find((a) => a.id === id) || {};
  }

  /**
   * 경쟁사 응찰 우위. 카탈로그 점수는 "기종의 실력"일 뿐이고, 실제 수주전에서
   * 기존 기종은 개발비를 이미 회수했기 때문에 가격 공세 여지가 크다 — 그만큼 문턱을 올린다.
   *
   * 밸런스상 중요: 예전에는 경쟁사마다 난수를 뽑아 최댓값을 쓰는 방식이라 경쟁사 수(3)에서
   * 오는 +5점 정도의 편향이 문턱에 섞여 있었다. 지금은 제조사가 8곳이라 그 방식을 쓰면
   * 문턱이 제조사 수에 따라 멋대로 오르므로, 추첨은 한 번만 하고 편향을 이 상수로 명시한다.
   *
   * 항공사에 노선망을 주고 나서 4 → 6 으로 올렸다. 요구사양이 세그먼트 대역에서
   * 균등하게 뽑히던 시절에는 플레이어의 제원 적합도가 평균적으로 낮아 이기기가
   * 어려웠는데, 수요가 특정 대역에 몰리자 맞춤 설계의 적합도가 80%대로 뛰면서
   * 평균 마진이 +3 이 됐다. 기성 기종의 기득권을 그만큼 더 인정한다.
   */
  const RIVAL_BID_EDGE = 6;

  /** 선단 공통성이 줄 수 있는 최대 가산점 (입찰 점수 0~100 척도). */
  const COMMONALITY_BONUS = 6;

  /**
   * 항공사 선호 엔진 가산 — 영국항공은 롤스로이스를, 라이언에어는 CFM 을 원한다.
   * 정비 인프라·훈련·부품 재고가 그 공급사에 맞춰져 있기 때문이다.
   * 이중화(dual-source) 기체는 어느 쪽이든 달아 줄 수 있어 더 넓게 맞는다.
   */
  const ENGINE_PREF_BONUS = 2;
  /** 낯선 공급사 감점 — 부품 재고·정비 훈련을 새로 갖춰야 한다. 이중화는 면제. */
  const ENGINE_PREF_MISS = -1;

  function enginePrefBonus(rfp, program) {
    const pref = airlineOf(rfp.airlineId).enginePref;
    if (!pref) return 0;
    const prim = (Engines.get(program.engine) || {}).maker;
    const alt = program.altEngine ? (Engines.get(program.altEngine) || {}).maker : null;
    if (pref === prim || pref === alt) return ENGINE_PREF_BONUS;
    // 이중화 기체는 낯선 감점을 면한다 — 선택지를 주는 것 자체가 성의다.
    return alt ? 0 : ENGINE_PREF_MISS;
  }

  /** 미인증 기체 선주문의 기본 신뢰 감점. 결함 위험에 비례해 커진다. */
  const PREORDER_PENALTY = 9;

  /**
   * 플래그십 후광 — 광동체를 인증까지 만들어 본 제조사는 모든 수주전에서 신뢰를
   * 더 받는다. 777 이 737 을 팔았다는 말이 이것이다. 광동체가 직접 마진으로는
   * 늦게 시작해 회수가 빠듯하므로, 사다리의 값 절반은 이 후광으로 돌아온다.
   */
  const FLAGSHIP_BONUS = 2.5;

  function flagshipBonus(state) {
    return state.programs.some((p) => p.segment === 'wide' && p.phase === 'production' && !p.legacy)
      ? FLAGSHIP_BONUS
      : 0;
  }

  /** 해당 분기에 새로 뜨는 RFP 목록을 만든다. */
  /**
   * 항공사 선단 계획.
   *
   * 예전에는 매 분기 항공사를 무작위로 뽑아 무작위 규모의 공고를 냈다. 그래서 공고가
   * 서로 아무 관계가 없었고 — 같은 항공사가 두 분기 연속 같은 급을 부르거나, 20년
   * 내내 한 번도 안 부르거나 — 시장이 배경 소음이었다.
   *
   * 이제 항공사마다 **필요분이 쌓인다**. 노후기가 매 분기 퇴역하고(교체 수요),
   * 수요지수에 따라 노선이 늘거나 준다(성장 수요). 쌓인 필요분이 발주 단위를 넘으면
   * 그때 공고가 나오고 필요분은 0 으로 돌아간다. 그래서:
   *
   *   - 공고 규모가 난수가 아니라 "그동안 쌓인 만큼"이다
   *   - 방금 대량 발주한 항공사는 한동안 조용하다
   *   - 불황에는 발주를 미루고, 회복하면 미뤄 둔 필요분이 한꺼번에 터진다
   *
   * 마지막 성질이 실제 항공업의 사이클이다 — 2001·2008 이후 발주가 얼어붙었다가
   * 회복기에 몰린 것이 그거다.
   */
  const FLEET_PLAN = {
    /**
     * 세그먼트별 분기 신규 수요 (대). 수요지수가 곱해진다.
     * 항공사마다 세 칸이 각각 쌓이므로, 한 칸이던 시절보다 총 수요가 커진다 —
     * 파산률이 목표(회생 안 씀 기준 10/40 언저리)에 오도록 다시 잡은 값이다.
     */
    perQuarter: { regional: 2.15, narrow: 2.92, wide: 1.46 },
    /** 이만큼 쌓이면 발주한다 — 곧 공고 규모이기도 하다. */
    lot: { regional: 18, narrow: 26, wide: 10 },
    /** 주력 밖 세그먼트의 적립 속도. 새 급 진출은 드물어야 한다. */
    offProfileRate: 0.05,
    /** 이 정도 쌓이면 발주 가능성이 생기고, ripeSpan 만큼 더 쌓이면 거의 확실해진다. */
    ripeFrom: 0.55,
    ripeSpan: 0.9,
    /** 불황에 실제로 미룰 확률. 1.0 이면 침체 구간이 통째로 비어 버린다. */
    deferChance: 0.72,
    /** 수요지수가 이보다 낮으면 발주를 미룬다. 필요분은 계속 쌓인다. */
    deferBelow: 0.82,
    /** 다만 이 배수를 넘게 쌓이면 더는 못 미룬다 — 기체가 정말 낡았다. */
    deferCap: 2.2,
  };

  /**
   * 항공사별 계획을 확보한다. 옛 세이브는 빈 상태에서 시작한다.
   *
   * 필요분은 **세그먼트별로** 쌓는다. 한 칸으로 두면 주력 세그먼트 규모로 적립한
   * 필요분이 노선망 밖 발주에서 다른 급 공고로 새고, 그 자리에서 통째로 지워진다 —
   * 광동체 교체 10대가 리저널 10대 공고가 되는 식이다. 칸을 나누면 노선망 밖
   * 진출도 그 급에 맞는 규모로 나온다.
   *
   * 첫 적립분을 흩뜨리는 것도 중요하다. 전부 0 에서 같은 속도로 쌓으면 같은 급의
   * 항공사들이 **동기화돼** 한 분기에 몰려 나오고 그 사이는 통째로 빈다 —
   * 공고 수는 그대로인데 할 일 없는 분기만 늘어난다. 실제 항공사의 교체 주기가
   * 서로 맞을 이유도 없다.
   */
  function planFor(state, airline, rng) {
    if (!state.airlinePlans) state.airlinePlans = {};
    const cur = state.airlinePlans[airline.id];
    if (!cur || !cur.need || typeof cur.need !== 'object') {
      const need = {};
      const deferred = {};
      for (const seg of SEGMENT_IDS) {
        need[seg] = rng ? rng.next() * FLEET_PLAN.lot[seg] : 0;
        deferred[seg] = 0;
      }
      state.airlinePlans[airline.id] = { need, deferred, lastOrderTurn: -99 };
    }
    return state.airlinePlans[airline.id];
  }

  /**
   * 이번 분기 공고. 항공사마다 필요분을 적립하고, 발주 단위를 넘긴 곳이 공고를 낸다.
   *
   * 난수는 규모의 흔들림에만 쓴다 — 어느 항공사가 언제 부를지는 계획이 정한다.
   * 그래야 "저 항공사는 슬슬 교체할 때가 됐다"가 읽히는 정보가 된다.
   */
  function generateRfps(state, rng) {
    const rfps = [];
    const demand = clamp(state.market.demandIndex, 0.3, 2.0);

    for (const airline of AIRLINES) {
      const plan = planFor(state, airline, rng);

      for (const seg of SEGMENT_IDS) {
        // 주력 세그먼트가 대부분이고, 노선망 밖은 천천히 쌓인다 — 항공사가 새 급에
        // 진출하는 건 드문 일이라 그만큼 오래 걸려야 한다.
        const weight = seg === airline.bias ? 1 : FLEET_PLAN.offProfileRate;
        // 교체 수요는 경기와 무관하게 쌓이고(기체는 계속 낡는다), 성장 수요만 경기를 탄다.
        const replace = FLEET_PLAN.perQuarter[seg] * 0.55;
        const grow = FLEET_PLAN.perQuarter[seg] * 0.45 * demand;
        plan.need[seg] += (replace + grow) * weight;

        const lot = FLEET_PLAN.lot[seg];
        // 발주 시점은 문턱이 아니라 확률로 푼다. 딱 떨어지는 문턱을 쓰면 같은 급의
        // 항공사들이 같은 속도로 쌓다가 한 분기에 몰려 나오고 — 이연이 그 동기화를
        // 매번 되살린다 — 공고 수는 맞는데 빈 분기만 늘어난다.
        // 많이 쌓일수록 확률이 오르므로 "슬슬 교체할 때가 됐다"는 성질은 그대로다.
        const ripeness = plan.need[seg] / lot;
        const chance = clamp((ripeness - FLEET_PLAN.ripeFrom) / FLEET_PLAN.ripeSpan, 0, 0.9);
        if (!rng.chance(chance)) continue;

        // 불황에는 미룬다. 다만 전부 얼어붙지는 않는다 — 최소한의 교체는 돌아간다.
        // 확정 이연으로 두면 침체 구간이 통째로 빈 분기가 되어 할 일이 사라진다.
        // 너무 낡으면 더는 못 미룬다.
        if (demand < FLEET_PLAN.deferBelow && ripeness < FLEET_PLAN.deferCap && rng.chance(FLEET_PLAN.deferChance)) {
          plan.deferred[seg]++;
          continue;
        }

        // 규모는 쌓인 만큼 ±15%. 미뤘던 필요분이 한꺼번에 나오면 대형 발주가 된다.
        const qty = Math.max(3, Math.round(plan.need[seg] * rng.range(0.85, 1.15)));
        rfps.push(makeRfp(state, rng, { airline, segment: seg, qty, deferred: plan.deferred[seg] }));
        plan.need[seg] = 0;
        plan.deferred[seg] = 0;
        plan.lastOrderTurn = state.turn;
      }
    }
    return rfps;
  }

  function makeRfp(state, rng, plan) {
    // 계획이 있으면 그 항공사·규모로 낸다. 없으면(테스트·옛 호출) 예전처럼 무작위.
    const airline = (plan && plan.airline) || rng.pick(AIRLINES);
    // 대부분은 자기 노선망 안에서 발주하고, 가끔 인접 세그먼트로 넘어간다.
    // 노선망 밖 발주는 **반드시 다른 세그먼트**여야 한다 — 자기 급을 뽑아 놓고
    // 대역·활주로 제약만 일반값으로 덮으면, 산악 공항 항공사가 이착륙 요건 0인
    // 공고를 내는 모순이 생긴다(노선 설명은 그대로 붙은 채로).
    //
    // 다만 선단 계획이 낸 발주는 자기 급에 머문다. 쌓인 필요분은 그 항공사의
    // **주력 세그먼트** 규모로 적립된 것이라, 다른 급으로 새면 광동체 교체 10대가
    // 리저널 10대 공고가 되고 그 자리에서 광동체 필요분이 통째로 지워진다.
    const segmentId = plan && plan.segment ? plan.segment : rng.next() < 0.85 ? airline.bias : rng.pick(SEGMENT_IDS.filter((id) => id !== airline.bias));
    const onProfile = segmentId === airline.bias;
    const seg = SEGMENTS[segmentId];

    let seats;
    let range;
    if (onProfile && airline.seatBand) {
      // 노선망 안의 발주 — 선호 대역 안에서 뽑는다. 이게 설계 포지셔닝을 베팅으로 만든다.
      // 대역은 해마다 조금씩 커진다(업게이지). 승계 기종이 시간이 갈수록 작아진다.
      const up = 1 + (state.turn / 4) * UPGAUGE_PER_YEAR;
      seats = Math.round(rng.range(airline.seatBand[0], airline.seatBand[1]) * up);
      range = Math.round(rng.range(airline.rangeBand[0], airline.rangeBand[1]));
    } else {
      // 노선망 밖 발주 — 그 세그먼트의 일반적인 범위.
      seats = Math.round(rng.range(seg.seats.min * 1.05, seg.seats.max * 0.92));
      range = Math.round(rng.range(seg.range.min * 1.1, seg.range.max * 0.88));
    }
    seats = Math.round(clamp(seats, seg.seats.min, seg.seats.max));
    range = Math.round(clamp(range, seg.range.min, seg.range.max));

    // 활주로 제약은 항공사 본거지의 성질이므로 노선망 안 발주에만 붙는다.
    const fieldKind = onProfile ? airline.field || 'normal' : 'normal';
    const reqField = FIELD_REQUIREMENT[fieldKind] || 0;
    const reqEtops = range >= ETOPS_RANGE_KM;
    // 노선 설명도 마찬가지다. 본거지 노선명을 그대로 붙이면 "단거리 지선 · 짧은
    // 활주로"라고 적힌 광동체 공고가 요구 이착륙 성능 0으로 나가 서로 모순된다.
    const route = onProfile ? airline.route || '' : `${seg.name} 신규 진출 (노선망 밖)`;

    // 발주 규모: 선단 계획이 쌓아 온 필요분이다. 계획 없이 부르면 예전 방식으로 뽑는다.
    let qty;
    if (plan && plan.qty > 0) {
      qty = plan.qty;
    } else {
      const baseQty = segmentId === 'regional' ? rng.int(8, 45) : segmentId === 'narrow' ? rng.int(10, 70) : rng.int(4, 26);
      qty = Math.max(3, Math.round(baseQty * clamp(state.market.demandIndex, 0.4, 1.8)));
    }

    const relation = state.relations[airline.id] ?? 40;

    return {
      id: 'rfp-' + state.nextId++,
      turn: state.turn,
      airlineId: airline.id,
      airlineName: airline.name,
      home: airline.home,
      segment: segmentId,
      segmentName: seg.name,
      reqSeats: seats,
      reqRange: range,
      reqField,
      fieldKind,
      reqEtops,
      route,
      qty,
      // 왜 지금 이 공고가 나왔는가 — 화면이 읽는다.
      reason: plan && plan.deferred > 0 ? 'deferred' : 'plan',
      deferredQuarters: (plan && plan.deferred) || 0,
      priceSensitivity: airline.priceSensitivity,
      prestige: airline.prestige,
      relation,
      deadline: state.turn, // 이번 분기 안에 결정
      // 경쟁사 최고 점수는 입찰 확정 시점에 계산한다(플레이어가 미리 못 봄).
      rivalHint: rivalBand(state, segmentId, seats, range),
    };
  }

  /**
   * 플레이어에게 보여줄 대략적 경쟁 강도 — 정확한 숫자는 감추되,
   * 어느 회사의 어느 기종과 붙는지는 알려준다(현실에서도 그건 안다).
   */
  function rivalBand(state, segmentId, reqSeats, reqRange) {
    const offer = bestOffering(state, segmentId, reqSeats, reqRange);
    // 실제 판정에는 응찰 우위(RIVAL_BID_EDGE)가 얹히므로 힌트도 같은 기대값을 써야 한다.
    // 카탈로그 점수만 쓰면 강도 구간(10점 폭)이 통째로 한 칸 물렁하게 표시된다.
    const best = offer
      ? clamp(offer.score + RIVAL_BID_EDGE, RIVAL_STRENGTH_FLOOR, RIVAL_STRENGTH_CAP)
      : RIVAL_STRENGTH_FLOOR;
    const rival = offer ? offer.name : '—';
    if (best >= 70) return { label: '매우 치열', level: 4, rival };
    if (best >= 60) return { label: '치열', level: 3, rival };
    if (best >= 50) return { label: '보통', level: 2, rival };
    return { label: '느슨', level: 1, rival };
  }

  /**
   * 우리 기체 한 종의 입찰 점수를 계산한다.
   * @returns {{total:number, parts:object, blocked:string|null, price:number}}
   */
  /**
   * 그 노선에 이 기체를 넣었을 때의 편당 운용원가 (지수).
   *
   * 항공사는 기체 가격만 보지 않는다. 20년을 굴리면 자본비보다 운용비가 크고,
   * 그래서 실제 기종 선정은 **편당 원가**와 **좌석마일 원가** 두 숫자로 한다.
   *
   *   연료 — 크기·거리에 비례하고 연비에 반비례한다. 유가가 비쌀수록 이 항이 지배한다
   *   고정 — 승무·정비·착륙료. 거리에 덜 민감하고 편당으로 붙는다
   *
   * 감톤 운항이 여기서 제값을 한다: 연료는 기체 크기대로 태우는데 태울 수 있는
   * 승객은 줄어드니, 좌석마일 원가가 그만큼 나빠진다.
   */
  function tripCostOf(seats, distance, efficiency, fuelIndex, maintFactor = 1) {
    const eff = clamp(efficiency, 5, 99);
    const fuel = Math.pow(seats, 0.9) * distance * (60 / eff) * clamp(fuelIndex, 0.4, 2.4);
    // fixed 는 정비·승무·지상 처리 같은 편당 고정비다. 정비성 설계는 여기가 내려간다 —
    // 연비(연료 항)와 다른 축이라, 유가가 낮은 시대에도 제값을 한다.
    const fixed = Math.pow(seats, 0.7) * (900 + distance * 0.22) * maintFactor;
    return fuel + fixed;
  }

  /** 비교 기준이 되는 "그 공고에 딱 맞는 평범한 기체"의 연비 지수. */
  const REF_EFFICIENCY = 58;

  /**
   * 가격 점수의 절편 — 좌석당 기준가와 같으면 (절편 − 1) 점이 된다.
   *
   * 좌석당으로 견주기 전에는 기체당으로 쟀는데, 그때는 **요구보다 작은 기체를 넣으면
   * 싸 보여서 가산점**을 받았다(185석 기체가 225석 공고에서 가격 54점). 업게이지로
   * 공고가 커지는 후반에 그 보너스가 점수의 큰 몫이었고, 좌석당으로 고치면서 통째로
   * 사라졌다 — 그만큼 눈금을 올려 수주량을 예전 수준으로 되돌린다.
   * 값을 만지면 수주량이 급하게 움직인다: 1.6 → 10.6천기, 1.75 → 18.0천기 (20판 합).
   */
  const PRICE_INTERCEPT = 1.69;

  /** 이 할인까지는 점수에 그대로 반영되고, 그 위로는 체감한다. */
  const DISCOUNT_KNEE = 0.2;
  const DISCOUNT_FADE = 0.3;

  /**
   * 그 기종의 payload-range 곡선. 옛 세이브에는 없으므로 설계 항속에서 되만든다.
   * 없다고 만석 항속만 보면, 마이그레이션된 기체가 감톤 능력을 통째로 잃는다.
   */
  function payloadRangeOf(program) {
    if (program.payloadRange && program.payloadRange.full > 0) return program.payloadRange;
    return Airframe.payloadRange(program.range, program.wing === undefined ? 45 : program.wing, program.fuelMargin);
  }

  /** 입찰 조건을 정규화한다. 옛 세이브·기본 호출은 표준 조건으로 본다. */
  function normalizeTerms(terms) {
    const t = terms || {};
    return {
      pledge: BID_PLEDGES[t.pledge] ? t.pledge : 'standard',
      financing: BID_FINANCING[t.financing] ? t.financing : 'normal',
    };
  }

  function scoreBid(state, rfp, program, discount, terms) {
    const seg = SEGMENTS[rfp.segment];

    // 세그먼트가 다르면 애초에 후보가 아니다.
    if (program.segment !== rfp.segment) {
      return { total: 0, parts: {}, blocked: '세그먼트 불일치', price: 0 };
    }
    // 짧은 활주로·고온고지 노선은 이착륙 성능이 모자라면 애초에 못 뛴다.
    if (rfp.reqField && (program.fieldPerf ?? 100) < rfp.reqField) {
      return { total: 0, parts: {}, blocked: '이착륙 성능 미달', price: 0 };
    }
    // 장거리 노선은 ETOPS 인증이 없으면 취항 자체가 불가능하다.
    // 설계만으로는 부족하다 — 실제로 인증을 가진 기종만 대양 노선에 들어간다.
    // 선주문(인증 심사 중)은 예외다: 항공사는 "취항 시점에 인증이 있을 것"을 믿고
    // 미리 계약한다. 못 지키면 인도 지연 위약금이 그 믿음의 값을 청구한다.
    const preorder = program.phase !== 'production';
    // 4발은 ETOPS 규정 밖이다 — 인증 없이 대양 노선에 응찰한다. 그게 4발의 값이고,
    // 그 값을 연비 감점(설계)과 유가 민감도(casm)로 치른다.
    if (rfp.reqEtops && !program.etopsCertified && program.engines !== 4 && !(preorder && program.etops)) {
      return { total: 0, parts: {}, blocked: 'ETOPS 미인증', price: 0 };
    }

    // ── 탑재-항속 ──
    // 설계 항속보다 먼 노선이라고 실격은 아니다. 연료를 더 싣고 승객을 내리면 뛴다.
    // 그래서 "몇 석짜리 기체인가"가 아니라 **이 노선에서 몇 석을 채울 수 있는가**로 잰다.
    const pr = payloadRangeOf(program);
    const seatFactor = Airframe.seatFactorAt(pr, rfp.reqRange);
    const usableSeats = program.seats * seatFactor;

    // 좌석 적합도: 모자라도, 지나치게 커도 감점(공석은 곧 비용).
    // 분자가 실좌석이라, 항속이 모자란 기체는 여기서 자연히 수송력 미달로 잡힌다.
    const seatDelta = (usableSeats - rfp.reqSeats) / rfp.reqSeats;
    const seatFit = seatDelta >= 0 ? clamp(1 - seatDelta * 1.35, 0, 1) : clamp(1 + seatDelta * 2.2, 0, 1);

    // 항속 적합도: 이제 부족분은 좌석 쪽에서 값을 치르므로 여기서는 **과한 항속만**
    // 본다 — 안 쓸 연료탱크와 구조를 지고 다니는 낭비다.
    const rangeDelta = (program.range - rfp.reqRange) / rfp.reqRange;
    const rangeFit = clamp(1 - Math.max(0, rangeDelta - 0.1) * 0.9, 0, 1);

    // 감톤 운항 자체의 부담 — 역풍·고온에 날마다 여유가 없고, 화물을 못 싣는다.
    // 좌석 수로 이미 값을 치른 위에 얹는 별도 감점이라 작게 잡는다.
    const restricted = 1 - clamp(seatFactor, 0, 1);

    const specFit = clamp(seatFit * 0.62 + rangeFit * 0.38 - restricted * 0.15, 0, 1);

    // 가격: 동급 기준가 대비 실효가격 — 단, **좌석당**으로 견준다.
    // 기체당으로 재면 요구보다 작고 싼 기체가 어느 노선에서나 가격 점수를 쓸어간다.
    // 항공사가 사는 건 기체가 아니라 수송력이라, 같은 임무를 작은 기체로 하려면
    // 더 많이 사거나 더 자주 띄워야 한다. 감톤으로 못 채우는 좌석은 여기서도 안 쳐준다.
    const refPrice = seg.listPriceBase * Math.pow(rfp.reqSeats / seg.seats.ref, 0.95);
    const effPrice = program.listPrice * (1 - discount);
    // 계약가는 그대로 깎이지만, **점수로 쳐주는 할인은 체감한다**.
    // 어느 선을 넘으면 항공사가 그 가격을 그대로 신뢰하지 않는다 — 20년을 함께 갈
    // 제조사가 원가 밑으로 파는 건 부품·지원의 불안 요인이고, 경쟁사도 그쯤이면
    // 맞불을 놓는다. 이 체감이 없으면 "최대한 깎기"가 언제나 정답이 되어 할인이
    // 결정이 아니라 슬라이더가 된다.
    const scored = discount <= DISCOUNT_KNEE ? discount : DISCOUNT_KNEE + (discount - DISCOUNT_KNEE) * DISCOUNT_FADE;
    const scoredPrice = program.listPrice * (1 - scored);
    const pricePerSeat = scoredPrice / Math.max(1, usableSeats);
    const refPerSeat = refPrice / Math.max(1, rfp.reqSeats);
    const priceScore = clamp(PRICE_INTERCEPT - pricePerSeat / refPerSeat, 0, 1);

    // ── 운용 경제성 ──
    // 편당 원가와 좌석마일 원가를 따로 잰다. 어느 쪽이 중요한지는 노선이 정한다.
    const fuelIndex = state.market.fuelIndex;
    const tripCost = tripCostOf(program.seats, rfp.reqRange, program.efficiency, fuelIndex, program.maintainable ? 0.88 : 1);
    const refTrip = tripCostOf(rfp.reqSeats, rfp.reqRange, REF_EFFICIENCY, fuelIndex);
    const tripScore = clamp(1.6 - tripCost / refTrip, 0, 1);

    // 좌석마일은 **채울 수 있는** 좌석으로 나눈다 — 감톤 운항의 대가가 여기서 드러난다.
    const casm = tripCost / Math.max(1, usableSeats);
    const refCasm = refTrip / Math.max(1, rfp.reqSeats);
    const casmScore = clamp(1.6 - casm / refCasm, 0, 1);

    // 노선 밀도: 좌석이 크고 거리가 짧을수록 굵은 노선이다.
    // 굵은 노선은 좌석마일로 싸움이 나고(빈 자리가 안 생긴다), 얇은 장거리 노선은
    // 편당 원가가 결정한다(못 채울 걸 아니까 큰 기체를 띄우는 것 자체가 손해다).
    const density = (rfp.reqSeats / seg.seats.ref) / clamp(rfp.reqRange / seg.range.ref, 0.35, 3);
    const casmWeight = clamp(0.28 + density * 0.34, 0.22, 0.78);
    const opScore = casmScore * casmWeight + tripScore * (1 - casmWeight);

    const comfortScore = clamp(program.comfort / 100, 0, 1);
    const repScore = clamp(state.reputation / 100, 0, 1);
    const relScore = clamp((state.relations[rfp.airlineId] ?? 40) / 100, 0, 1);

    // 선단 공통성 — 이미 우리 기체를 굴리는 항공사는 정비·훈련·부품 재고를 공유할 수
    // 있어 강하게 선호한다. 현실에서 항공사가 한 제조사에 묶이는 가장 큰 이유이고,
    // 게임에서는 초반 한 건의 수주가 복리로 불어나게 만드는 장치다.
    // 같은 기종이면 최대, 우리 다른 기종이라도 부분 인정(조종석 공통성).
    const fleet = (state.fleets && state.fleets[rfp.airlineId]) || {};
    const sameType = fleet[program.id] || 0;
    const anyOurs = Object.values(fleet).reduce((a, b) => a + b, 0);

    // 같은 패밀리는 조종석·정비가 공통이라 사실상 같은 기종에 가깝다.
    // 패밀리 선투자가 개발비뿐 아니라 영업에서도 회수되는 지점이다.
    let famUnits = 0;
    if (program.familyId) {
      for (const [pid, n] of Object.entries(fleet)) {
        if (pid === program.id) continue;
        const other = state.programs.find((x) => x.id === pid);
        if (other && other.familyId === program.familyId) famUnits += n;
      }
    }
    const effectiveSame = sameType + famUnits * 0.7;
    const commonality =
      clamp(effectiveSame / 25, 0, 1) * 0.75 + clamp((anyOurs - sameType - famUnits) / 60, 0, 1) * 0.25;

    // 가중치를 시장 상황에 맞춰 재배분한 뒤 합이 1이 되도록 정규화한다.
    const w = {
      spec: 0.3,
      price: 0.27 * rfp.priceSensitivity,
      // 유가 민감도는 편당 원가 안으로 들어갔다 — 여기서 또 곱하면 이중 계상이다.
      op: 0.2,
      comfort: 0.07 * rfp.prestige,
      rep: 0.12,
      rel: 0.09,
    };
    const wsum = Object.values(w).reduce((a, b) => a + b, 0);

    const total =
      (100 *
        (specFit * w.spec +
          priceScore * w.price +
          opScore * w.op +
          comfortScore * w.comfort +
          repScore * w.rep +
          relScore * w.rel)) /
        wsum +
      // 공통성은 가중치 항목이 아니라 가산점이다. 가중합에 넣으면 분모(wsum)가 커져
      // "우리 기체가 없는 항공사" 점수가 일괄로 깎이는데, 그건 신규 계정을 뚫는 걸
      // 더 어렵게 만들 뿐 공통성의 취지(기존 계정이 유리하다)와 반대다.
      // 단일 기종 독트린(라이언에어 같은 저비용사)은 공통성을 남들보다 크게 쳐 준다 —
      // 그 항공사를 한 번 뚫으면 이후 수주전이 실제로 더 기운다.
      commonality * COMMONALITY_BONUS * (airlineOf(rfp.airlineId).commonalityMult || 1);

    // 입찰 조건도 가산점이다. 항공사가 원하는 건 기체만이 아니라 **언제 받고 어떻게
    // 치르느냐**이기도 하다. 조건은 공짜가 아니라 라인 여력과 현금흐름을 담보로 잡는다.
    const t = normalizeTerms(terms);
    const pledge = BID_PLEDGES[t.pledge];
    const financing = BID_FINANCING[t.financing];
    const termBonus = pledge.bonus + financing.bonus;

    // 선주문 감점 — 아직 하늘에 없는 기체다. 항공사는 종이 비행기를 믿는 대신
    // 값을 깎아 위험을 산다(런치 커스터머가 실제로 받는 게 그 할인이다).
    // 결함 위험이 높은 설계일수록 신뢰 격차가 크다.
    // 기본 감점: 시제기(인증)는 상수, 종이(개발)는 진행도가 낮을수록 크다.
    // 그 위에 결함 위험 배수가 **두 단계 모두에** 곱해진다 — 중첩 삼항에 배수를
    // 붙여 두니 리뷰 봇이 "cert 는 위험 무관"으로 잘못 읽었다. 사람도 그럴 것이다.
    let preorderPenalty = 0;
    if (preorder) {
      const base =
        program.phase === 'cert'
          ? PREORDER_PENALTY
          : PREORDER_PENALTY + 3 + 8 * (1 - clamp((program.progress || 0) / 100, 0, 1));
      preorderPenalty = base * (1 + (program.defectRisk || 0));
    }

    // 가산점을 얹은 뒤에도 0~100 계약을 지킨다. 경쟁사 점수는 별도로 상한이
    // 걸려 있어, 여기만 106까지 나가면 비교 척도가 어긋난다.
    const prefBonus = enginePrefBonus(rfp, program);
    const bounded = clamp(total + termBonus + flagshipBonus(state) + prefBonus - preorderPenalty, 0, 100);

    return {
      total: Math.round(bounded * 10) / 10,
      parts: {
        spec: Math.round(specFit * 100),
        price: Math.round(priceScore * 100),
        op: Math.round(opScore * 100),
        comfort: Math.round(comfortScore * 100),
        rep: Math.round(repScore * 100),
        rel: Math.round(relScore * 100),
        common: Math.round(commonality * 100),
      },
      // 왜 그 점수가 나왔는지 화면이 풀어 쓸 수 있게 근거를 함께 싣는다.
      economics: {
        seatFactor: Math.round(seatFactor * 1000) / 1000,
        usableSeats: Math.round(usableSeats),
        trip: Math.round(tripScore * 100),
        casm: Math.round(casmScore * 100),
        casmWeight: Math.round(casmWeight * 100),
      },
      preorder,
      terms: t,
      termBonus: Math.round(termBonus * 10) / 10,
      enginePref: prefBonus,
      blocked: null,
      price: Math.round(effPrice * 10) / 10,
    };
  }

  /**
   * 이 시점·이 요구사양에서 경쟁사들이 실제로 내놓을 수 있는 최고의 제안.
   * 난수를 쓰지 않는다 — 경쟁사 수가 늘어도 문턱이 따라 오르지 않도록,
   * 불확실성은 rivalScore 에서 딱 한 번만 얹는다.
   *
   * @param {number|null} reqSeats null 이면 적합도를 빼고 세그먼트 대표 기종만 고른다
   */
  function bestOffering(state, segmentId, reqSeats, reqRange) {
    const year = Fleet.yearAt(state.turn, CONFIG.startYear);
    // 이 판의 개발 지연을 얹은 달력으로 본다 — 밀린 기종은 밀린 날부터 문턱이 된다.
    const pool = Fleet.availableTypes(segmentId, year, state.rivalDelays);

    let best = null;
    for (const c of state.competitors) {
      // 이벤트 보정 + 가격 공세. 둘은 슬롯이 다르다 — 반격의 감쇠가 이벤트 보정을
      // 지우지 않도록 나눠 두고, 실제 경쟁력은 여기서 합친다.
      const drift = ((c.drift && c.drift[segmentId]) || 0) + ((c.reaction && c.reaction[segmentId]) || 0);
      for (const type of pool) {
        if (type.maker !== c.id) continue;
        // 초기 결함 파동 중인 기종은 그 기간만큼 약하다 — 항공사가 세워 둔 기종을
        // 제값에 사 주지 않는다. 파동이 지나면 원래 실력으로 돌아온다.
        const crisis = (state.rivalCrises && state.rivalCrises[type.id] && state.rivalCrises[type.id].amount) || 0;
        const score = Fleet.typeScore(type, state.market.fuelIndex, reqSeats, reqRange) + drift - crisis;
        if (!best || score > best.score) best = { maker: c, type, score };
      }
    }
    if (!best) return null;

    return {
      maker: best.maker,
      type: best.type,
      name: `${best.maker.name} ${best.type.name}`,
      score: clamp(best.score, RIVAL_STRENGTH_FLOOR, RIVAL_STRENGTH_CAP),
    };
  }

  function rivalScore(state, rfp, rng) {
    const offer = bestOffering(state, rfp.segment, rfp.reqSeats, rfp.reqRange);
    // 그 시점 그 세그먼트에 아무도 없으면(카탈로그 공백) 시장 평균이 문턱이 된다.
    if (!offer) return { name: '—', makerId: null, typeName: null, score: RIVAL_STRENGTH_FLOOR };

    const score = clamp(offer.score + rng.normal(RIVAL_BID_EDGE, 6), RIVAL_STRENGTH_FLOOR, RIVAL_STRENGTH_CAP);
    // 누가 이겼는지를 제조사 단위로 남긴다 — 표시용 이름만 넘기면 수주전 전적을
    // 회사별로 쌓을 수 없어 "보잉에 다섯 번 밀렸다" 같은 서사가 만들어지지 않는다.
    return {
      name: offer.name,
      makerId: offer.maker.id,
      typeName: offer.type.name,
      score: Math.round(score * 10) / 10,
    };
  }

  /**
   * 입찰 결과 판정.
   * 근소한 차이(±4점)면 물량을 나눠 갖는다 — 실제 수주전처럼 완패/완승이 드물게.
   */
  function resolveBid(state, rfp, bid, rng) {
    const rival = rivalScore(state, rfp, rng);
    const margin = bid.score.total - rival.score;

    let outcome;
    let qty = 0;
    if (margin > 4) {
      outcome = 'win';
      qty = rfp.qty;
    } else if (margin >= -4) {
      outcome = 'split';
      qty = Math.max(1, Math.round(rfp.qty * 0.5));
    } else {
      outcome = 'lose';
    }

    return {
      outcome,
      qty,
      rivalName: rival.name,
      rivalMaker: rival.makerId,
      rivalType: rival.typeName,
      rivalScore: rival.score,
      margin: Math.round(margin * 10) / 10,
    };
  }

  root.AirlinerBidding = { generateRfps, makeRfp, scoreBid, resolveBid, rivalScore, rivalBand, bestOffering, normalizeTerms, CONFIG };
})(typeof globalThis !== 'undefined' ? globalThis : this);
