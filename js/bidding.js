/*
 * 수주전 — RFP 생성과 입찰 점수 계산.
 *
 * 점수는 0~100 스케일이며 경쟁사 점수와 직접 비교한다. 항목 가중치가 시장 상황
 * (연료지수·항공사 성향)에 따라 움직이는 게 이 게임의 핵심 긴장이다.
 */
(function (root) {
  'use strict';

  const { SEGMENTS, AIRLINES, CONFIG, RIVAL_STRENGTH_CAP, RIVAL_STRENGTH_FLOOR, FIELD_REQUIREMENT, ETOPS_RANGE_KM, RANGE_TOLERANCE, UPGAUGE_PER_YEAR, BID_PLEDGES, BID_FINANCING } =
    root.AirlinerData;
  const { clamp } = root.AirlinerDesign;
  const Fleet = root.AirlinerFleet;

  const SEGMENT_IDS = Object.keys(SEGMENTS);

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

  /** 해당 분기에 새로 뜨는 RFP 목록을 만든다. */
  function generateRfps(state, rng) {
    const rfps = [];
    const demand = state.market.demandIndex;
    // 수요지수가 낮으면 입찰 자체가 줄어든다.
    let count = 0;
    if (rng.next() < clamp(demand * 0.85, 0.1, 0.95)) count++;
    if (rng.next() < clamp(demand * 0.55, 0.05, 0.85)) count++;
    if (rng.next() < clamp(demand * 0.22, 0.02, 0.5)) count++;

    for (let i = 0; i < count; i++) {
      rfps.push(makeRfp(state, rng));
    }
    return rfps;
  }

  function makeRfp(state, rng) {
    const airline = rng.pick(AIRLINES);
    // 대부분은 자기 노선망 안에서 발주하고, 가끔 인접 세그먼트로 넘어간다.
    // 노선망 밖 발주는 **반드시 다른 세그먼트**여야 한다 — 자기 급을 뽑아 놓고
    // 대역·활주로 제약만 일반값으로 덮으면, 산악 공항 항공사가 이착륙 요건 0인
    // 공고를 내는 모순이 생긴다(노선 설명은 그대로 붙은 채로).
    const onProfile = rng.next() < 0.85;
    const segmentId = onProfile ? airline.bias : rng.pick(SEGMENT_IDS.filter((id) => id !== airline.bias));
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

    // 발주 규모: 세그먼트가 작을수록 대량. 수요지수가 곱해진다.
    const baseQty = segmentId === 'regional' ? rng.int(8, 45) : segmentId === 'narrow' ? rng.int(10, 70) : rng.int(4, 26);
    const qty = Math.max(3, Math.round(baseQty * clamp(state.market.demandIndex, 0.4, 1.8)));

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
    // 요구 항속의 일정 비율에 못 미치면 노선 자체를 못 뛴다 — 실격.
    if (program.range < rfp.reqRange * RANGE_TOLERANCE) {
      return { total: 0, parts: {}, blocked: '항속거리 부족', price: 0 };
    }
    // 좌석이 요구의 80% 미만이면 수송력 미달 — 실격.
    if (program.seats < rfp.reqSeats * 0.8) {
      return { total: 0, parts: {}, blocked: '좌석수 부족', price: 0 };
    }
    // 짧은 활주로·고온고지 노선은 이착륙 성능이 모자라면 애초에 못 뛴다.
    if (rfp.reqField && (program.fieldPerf ?? 100) < rfp.reqField) {
      return { total: 0, parts: {}, blocked: '이착륙 성능 미달', price: 0 };
    }
    // 장거리 노선은 ETOPS 인증이 없으면 취항 자체가 불가능하다.
    if (rfp.reqEtops && !program.etops) {
      return { total: 0, parts: {}, blocked: 'ETOPS 미인증', price: 0 };
    }

    // 좌석 적합도: 모자라도, 지나치게 커도 감점(공석은 곧 비용).
    const seatDelta = (program.seats - rfp.reqSeats) / rfp.reqSeats;
    const seatFit = seatDelta >= 0 ? clamp(1 - seatDelta * 1.35, 0, 1) : clamp(1 + seatDelta * 2.2, 0, 1);

    // 항속 적합도: 여유는 조금 좋지만 과하면 중량 낭비.
    const rangeDelta = (program.range - rfp.reqRange) / rfp.reqRange;
    const rangeFit = rangeDelta >= 0 ? clamp(1 - Math.max(0, rangeDelta - 0.1) * 0.9, 0, 1) : clamp(1 + rangeDelta * 4, 0, 1);

    const specFit = seatFit * 0.62 + rangeFit * 0.38;

    // 가격: 동급 기준가 대비 실효가격.
    const refPrice = seg.listPriceBase * Math.pow(rfp.reqSeats / seg.seats.ref, 0.95);
    const effPrice = program.listPrice * (1 - discount);
    const priceScore = clamp(1.6 - effPrice / refPrice, 0, 1);

    // 연비: 연료지수가 높을수록 이 항목의 가중치가 커진다.
    const effScore = clamp(program.efficiency / 100, 0, 1);
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
      eff: 0.17 * clamp(state.market.fuelIndex, 0.4, 2.2),
      comfort: 0.07 * rfp.prestige,
      rep: 0.12,
      rel: 0.09,
    };
    const wsum = Object.values(w).reduce((a, b) => a + b, 0);

    const total =
      (100 *
        (specFit * w.spec +
          priceScore * w.price +
          effScore * w.eff +
          comfortScore * w.comfort +
          repScore * w.rep +
          relScore * w.rel)) /
        wsum +
      // 공통성은 가중치 항목이 아니라 가산점이다. 가중합에 넣으면 분모(wsum)가 커져
      // "우리 기체가 없는 항공사" 점수가 일괄로 깎이는데, 그건 신규 계정을 뚫는 걸
      // 더 어렵게 만들 뿐 공통성의 취지(기존 계정이 유리하다)와 반대다.
      commonality * COMMONALITY_BONUS;

    // 입찰 조건도 가산점이다. 항공사가 원하는 건 기체만이 아니라 **언제 받고 어떻게
    // 치르느냐**이기도 하다. 조건은 공짜가 아니라 라인 여력과 현금흐름을 담보로 잡는다.
    const t = normalizeTerms(terms);
    const pledge = BID_PLEDGES[t.pledge];
    const financing = BID_FINANCING[t.financing];
    const termBonus = pledge.bonus + financing.bonus;

    // 가산점을 얹은 뒤에도 0~100 계약을 지킨다. 경쟁사 점수는 별도로 상한이
    // 걸려 있어, 여기만 106까지 나가면 비교 척도가 어긋난다.
    const bounded = clamp(total + termBonus, 0, 100);

    return {
      total: Math.round(bounded * 10) / 10,
      parts: {
        spec: Math.round(specFit * 100),
        price: Math.round(priceScore * 100),
        eff: Math.round(effScore * 100),
        comfort: Math.round(comfortScore * 100),
        rep: Math.round(repScore * 100),
        rel: Math.round(relScore * 100),
        common: Math.round(commonality * 100),
      },
      terms: t,
      termBonus: Math.round(termBonus * 10) / 10,
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
    const pool = Fleet.availableTypes(segmentId, year);

    let best = null;
    for (const c of state.competitors) {
      // 이벤트 보정 + 가격 공세. 둘은 슬롯이 다르다 — 반격의 감쇠가 이벤트 보정을
      // 지우지 않도록 나눠 두고, 실제 경쟁력은 여기서 합친다.
      const drift = ((c.drift && c.drift[segmentId]) || 0) + ((c.reaction && c.reaction[segmentId]) || 0);
      for (const type of pool) {
        if (type.maker !== c.id) continue;
        const score = Fleet.typeScore(type, state.market.fuelIndex, reqSeats, reqRange) + drift;
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
