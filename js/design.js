/*
 * 기체 설계 계산기 — 설계 입력(좌석/항속/기술/소재)을 개발비·개발기간·성능으로 환산한다.
 * 순수 함수만 둔다. UI의 실시간 미리보기와 engine의 실제 착수가 같은 식을 쓰도록.
 */
(function (root) {
  'use strict';

  const { SEGMENTS, FUSELAGE_MATERIALS, WING_MATERIALS, LEGACY_MATERIAL_MAP, CONFIG, ETOPS_USEFUL_RANGE } = root.AirlinerData;
  const Engines = root.AirlinerEngines;
  const Airframe = root.AirlinerAirframe;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /** 파생형 할인 허용 오차 — 이 범위를 벗어나면 사실상 새 기체다. */
  // wing: 날개를 손보되 새로 설계하지는 않는 범위. 실제 파생형도 윙렛을 달거나
  // 익단을 조금 늘리기는 하지만(737NG→MAX), 종횡비를 갈아엎으면 새 날개다.
  const DERIVATIVE_TOLERANCE = { techUp: 5, rangeRatio: 0.15, wing: 12 };

  /**
   * 원형의 형식증명을 물려받을 수 있는 변경인지.
   * 좌석수 변경(동체 연장/단축)은 파생형의 본령이라 허용하고,
   * 소재 교체·기술 상향·항속 대폭 변경은 재설계에 가까우므로 할인 대상이 아니다.
   */
  /** 이중화의 대안 엔진 — 다른 공급사 것 중 성숙 우선, 그중 연비 최고. */
  function bestAltEngine(segmentId, primary, year, earlyIds, domesticIds) {
    const pool = Engines.available(segmentId, year, earlyIds, domesticIds).filter((e) => e.maker !== primary.maker);
    if (!pool.length) return null;
    const mature = pool.filter((e) => Engines.maturityRisk(e, year) === 1);
    const from = mature.length ? mature : pool;
    return from.reduce((a, b) => (b.eff > a.eff ? b : a));
  }

  function isCompatibleDerivative(spec, range, tech) {
    const d = spec.derivedFrom;
    if (!d) return false;
    // 원형 정보가 없는 옛 설계안은 보수적으로 할인하지 않는다.
    if (d.tech === undefined || d.range === undefined) return false;
    if (d.material === undefined && d.fuselage === undefined) return false;
    const dFus = d.fuselage || (LEGACY_MATERIAL_MAP[d.material] || {}).fuselage;
    const dWing = d.wingMat || (LEGACY_MATERIAL_MAP[d.material] || {}).wingMat;
    const sFus = spec.fuselage || (LEGACY_MATERIAL_MAP[spec.material] || {}).fuselage;
    const sWing = spec.wingMat || (LEGACY_MATERIAL_MAP[spec.material] || {}).wingMat;
    if (dFus !== sFus || dWing !== sWing) return false;
    // 동체 단면을 바꾸면 형식증명을 물려받을 수 없다 — 동체 직경은 구조 설계의
    // 출발점이라 사실상 새 기체다. 이게 패밀리 전략의 근거이기도 하다:
    // 단면을 한 번 정하면 그 위에서만 싸게 늘리고 줄일 수 있다.
    if (d.abreast !== undefined && spec.abreast !== undefined && d.abreast !== spec.abreast) return false;
    // 엔진 수를 바꾸면 날개·파일런·계통이 통째로 다시다 — 형식증명을 물려받을 수 없다.
    if (((d.engines || 2) === 4) !== ((spec.engines || 2) === 4)) return false;
    // 날개를 다시 그리면 이착륙 성능·순항 연비·구조 원가가 통째로 달라진다.
    // 형상이 그만큼 바뀌었으면 원형의 시험비행 결과를 물려받을 수 없다.
    if (d.wing !== undefined && spec.wing !== undefined && Math.abs(spec.wing - d.wing) > DERIVATIVE_TOLERANCE.wing) return false;
    if (tech > d.tech + DERIVATIVE_TOLERANCE.techUp) return false;
    if (Math.abs(range - d.range) > d.range * DERIVATIVE_TOLERANCE.rangeRatio) return false;
    return true;
  }

  /**
   * 설계안 평가.
   * @param {{segment:string, seats:number, range:number, tech:number, material:string, derivedFrom?:object}} spec
   * @returns 개발비/기간/성능이 채워진 평가 결과
   */
  function evaluate(spec) {
    const seg = SEGMENTS[spec.segment];
    if (!seg) throw new Error('알 수 없는 세그먼트: ' + spec.segment);

    // 부위별 소재. 옛 단일 선택(spec.material)만 있으면 조합으로 옮긴다.
    const legacy = LEGACY_MATERIAL_MAP[spec.material] || LEGACY_MATERIAL_MAP.aluminum;
    const fus = FUSELAGE_MATERIALS[spec.fuselage || legacy.fuselage] || FUSELAGE_MATERIALS.aluminum;
    const wmat = WING_MATERIALS[spec.wingMat || legacy.wingMat] || WING_MATERIALS.aluminum;

    const seats = clamp(spec.seats, seg.seats.min, seg.seats.max);
    const range = clamp(spec.range, seg.range.min, seg.range.max);
    const tech = clamp(spec.tech, 0, 100);

    // 완료된 장기 연구 — engine.researchContext(s)가 넣어 준다.
    // 효과는 설계 시점에 굳는다: 연구는 미래의 설계를 바꾸지, 나는 기체를 소급하지 않는다.
    const res = spec.research || {};

    // 파생형 판정을 경험 할인보다 먼저 한다 — 파생형은 경험 할인을 받지 않는다.
    // 파생 배율(derivRates)이 "원형의 설계·인증을 물려받는 값"을 이미 전부 담고
    // 있는데, 원형을 완성했다는 사실이 경험으로도 잡히므로 겹치면 이중 할인이다.
    // 광고된 파생 비율보다 훨씬 싸지고, 싼 파생형이 경험을 또 낳는 복리가 돈다.
    const derivative = isCompatibleDerivative(spec, range, tech);

    // ── 설계 심화 세 축 — 성장 여유 · 정비성 · 엔진 수 ──
    // 셋 다 구조 설계의 일부라 파생형은 원형 것을 물려받는다. 엔진 수가 다르면
    // 애초에 파생형이 아니다(호환 판정에서 걸러진다).
    const growth = derivative ? !!(spec.derivedFrom && spec.derivedFrom.growth) : !!spec.growth;
    const maintainable = derivative ? !!(spec.derivedFrom && spec.derivedFrom.maintainable) : !!spec.maintainable;
    const engines = derivative ? (spec.derivedFrom && spec.derivedFrom.engines) || 2 : spec.engines === 4 ? 4 : 2;
    // 4발은 광동체에서만 의미가 있다 — 리저널에 4발을 다는 선택지는 함정일 뿐이다.
    const quad = engines === 4 && seg.id === 'wide';

    // 조직 경험 — 완성해 본 프로그램이 많을수록 다음 **신규** 개발이 빠르고 작은
    // 팀으로 된다. 767→777→787 이 그 계보다: 같은 회사가 다음 기체를 만들 때는
    // 지난 개발의 베테랑들이 조직을 이끈다. 인력이 가장 큰 병목(광동체 7,300명 vs
    // 시작 3,400명)이라 필요 인력 감소 폭을 기간보다 크게 잡았다 — 사다리를 오르는
    // 회사가 채용만으로는 못 넘던 벽을 넘게 하는 것이 이 축의 존재 이유다.
    const xp = derivative ? 0 : Math.max(0, spec.experience || 0);
    const expEng = Math.max(0.5, Math.pow(0.86, xp));
    const expTime = Math.max(0.55, Math.pow(0.9, xp));
    // 비용 절감이 가장 가파르다. 개발비를 터뜨리는 건 재작업이고(787 이 그랬다),
    // 재작업을 피하는 게 정확히 경험의 값이다. 광동체(실비용 ~22B)가 조달 가능
    // 총액(부채+증자 ~17B)을 넘는 게 사다리의 마지막 벽이라, 여기가 세야
    // "경험을 쌓고 도전하면 닿는다"가 실제로 성립한다.
    const expCost = Math.max(0.55, Math.pow(0.88, xp));
    const expRisk = Math.max(0.8, Math.pow(0.96, xp));

    // 엔진은 설계의 두 번째 축이다. spec.year(소수 연도)가 있으면 그 시점에 실제로
    // 살 수 있는 엔진으로 좁히고, 갓 나온 엔진이면 성숙도 위험이 얹힌다.
    // 런칭 파트너 계약(spec.earlyEngines)이 있으면 그 엔진만 몇 년 먼저 열린다.
    // 국산 엔진(spec.domesticEngines)은 해금한 회사에게만 보인다.
    const eng = Engines.resolve(seg.id, spec.engine, spec.year, spec.earlyEngines, spec.domesticEngines);
    const engMaturity = eng ? Engines.maturityRisk(eng, spec.year) : 1;
    // 엔진 이중화 — 한 기체에 두 공급사 엔진 옵션을 인증한다 (A330·777 이 그랬다).
    // 구조(파일런·나셀 두 벌)라 파생형은 원형을 따른다. 대안 공급사는 그 시점
    // 카탈로그에서 결정적으로 고른다: 성숙한 것 우선, 그중 연비 최고.
    const dualWanted = derivative ? !!(spec.derivedFrom && spec.derivedFrom.dualSource) : !!spec.dualSource;
    // 국산 엔진을 주엔진으로 고르면 이중화는 성립하지 않는다. 붙여 두면 국산
    // 원가·국가 발주 우대·공급 차질 면역(셋 다 주엔진만 본다)을 받으면서 서방
    // 대안의 선호 가산(+2)까지 챙기는, 양쪽을 다 갖는 설계가 된다 — 국산화가
    // 파는 것이 정확히 그 수주 경쟁력이다. 완성된 국산화가 대안 인증을 접는
    // 것과 같은 규칙을 설계 단계에도 건다.
    const altEng =
      dualWanted && eng && !eng.domestic
        ? bestAltEngine(seg.id, eng, spec.year, spec.earlyEngines, spec.domesticEngines)
        : null;
    const dual = !!altEng;
    // 독점 공급 계약 중에 다른 공급사 엔진으로 설계하면 통합 지원이 빠져 개발이
    // 비싸다. 이중화는 정의상 다른 공급사가 끼므로 주엔진이 계약사여도 할증이다.
    const exclusiveSurcharge = !!(spec.exclusiveMaker && eng && (eng.maker !== spec.exclusiveMaker || dual));

    // 동체 단면과 날개 — 양방향 트레이드오프 두 축.
    const sec = Airframe.section(seg.id, spec.abreast);
    const secFit = Airframe.sectionFit(sec, seats);
    const wing = clamp(spec.wing === undefined ? 45 : spec.wing, 0, 100);
    // 연료 여유 — 설계 항속 밖 노선을 감톤으로 뛸 수 있는 폭을 산다.
    const fuelMargin = clamp(spec.fuelMargin === undefined ? Airframe.DEFAULT_FUEL_MARGIN : spec.fuelMargin, 0, 100);
    const fm = fuelMargin / 100;

    const seatRatio = seats / seg.seats.ref;
    const rangeRatio = range / seg.range.ref;
    const wingP = Airframe.wingProfile(wing, rangeRatio, wmat.aspectRelief);

    // 개발비: 좌석은 초선형(대형화가 비싸다), 항속은 완만, 기술은 강하게 작용.
    let devCost =
      seg.devBase *
      Math.pow(seatRatio, 1.15) *
      Math.pow(rangeRatio, 0.55) *
      (1 + (tech / 100) * 0.9) *
      fus.devCostMult *
      wmat.devCostMult *
      eng.devMult *
      sec.devMult *
      wingP.devMult *
      (1 + (fm - Airframe.DEFAULT_FUEL_MARGIN / 100) * 0.16) *
      expCost;

    let devQuarters =
      seg.devQuarters *
      (1 + (tech / 100) * 0.35) *
      Math.pow(rangeRatio, 0.12) *
      fus.devTimeMult *
      wmat.devTimeMult *
      eng.timeMult *
      expTime;

    let engineersNeeded = seg.engineersNeeded * Math.pow(seatRatio, 0.5) * (1 + (tech / 100) * 0.4) * expEng;

    // 성장 여유 — 미래의 파생형을 위해 지금 무게와 돈을 태운다. A320 은 다리가
    // 길어 neo 가 쉬웠고, 737 은 짧아 MAX 가 고생했다. 그 차이를 여기서 산다.
    // 설계 프리미엄은 패밀리 선투자처럼 **뿌리에서 한 번만** 문다 — 파생형에도
    // 물리면 광고한 15% 할인(×0.85)이 1.06×0.85 로 희석돼 10%가 된다.
    // (원가 +3%·연비 −1 은 구조 자체의 성질이라 파생형도 그대로 진다.)
    if (growth && !derivative) {
      devCost *= 1.06;
      engineersNeeded *= 1.03;
    }
    // 정비성 설계 — 접근 패널·모듈화 부품. 개발이 비싸지고 기체도 조금 비싸지지만,
    // 항공사의 편당 고정비(정비·지상 시간)가 내려가고 결함도 덜 곪는다.
    if (maintainable) devCost *= 1.05;
    // 4발 — 엔진·나셀·계통이 두 벌 더 붙는다.
    if (quad) {
      devCost *= 1.12;
      engineersNeeded *= 1.05;
    }
    // 이중화 — 통합·인증을 두 번 한다. 설계 프리미엄은 뿌리에서 한 번만
    // (파생형은 인증된 파일런을 물려받는다), 파일런·배관 두 벌은 기체마다 진다.
    if (dual && !derivative) {
      devCost *= 1.1;
      engineersNeeded *= 1.04;
    }
    // 독점 계약을 어기는 설계 — 공급사 통합 지원 없이 우리 돈으로 다 한다.
    if (exclusiveSurcharge) devCost *= 1.08;

    // 파생형: 기존 형식증명을 물려받아 개발비·기간이 크게 준다 (판정은 위에서).
    // 단, 원형의 형식증명을 실제로 재사용할 수 있는 변경일 때만 인정한다.
    // 딱지만 붙인 채 소재·기술·항속을 갈아엎으면 신규 설계를 34% 가격에 사는 셈이라
    // 개발비 제약 자체가 무너진다 (동일 설계 기준 $18.6B → $6.3B).
    // 엔진을 갈아 끼운 파생형(재장착)은 형식증명은 물려받지만 개발비가 훨씬 크다.
    // A320neo·737 MAX 가 정확히 이 경우다 — 순수 동체 연장과 같은 값을 매기면 안 된다.
    // 원형 엔진을 알 수 없으면(엔진 개념이 없던 옛 설계안) 보수적으로 재장착으로 본다.
    // 실제로 그 시점 엔진으로 대체되므로 "같은 엔진"이라고 볼 근거가 없다.
    const reEngined = derivative && spec.derivedFrom.engine !== eng.id;
    // 원형이 패밀리로 개발됐으면 파생형이 훨씬 싸다 — 패밀리 선투자의 회수 지점.
    const inFamily = derivative && spec.derivedFrom.family === true;
    // 재장착 파생 — 원형에 성장 여유가 없으면 신형 대구경 팬이 제대로 안 들어간다.
    // 737 MAX 가 그 타협의 이름이다: 엔진을 위로 앞으로 밀어 달았고 값을 치렀다.
    const reEngineSqueeze = derivative && reEngined && !(spec.derivedFrom && spec.derivedFrom.growth) ? 3 : 0;

    // 패밀리로 개발하면 공통 구조·조종석 설계에 선투자한다.
    // 선투자는 계보의 뿌리에서 **한 번만** 한다 — 이미 패밀리를 물려받는 파생형은
    // 공통 설계가 이미 존재하므로, 여기서 또 청구하면 아무것도 사지 않는 돈이 된다.
    const family = inFamily || !!spec.family;
    if (family && !inFamily) {
      devCost *= CONFIG.familyDevMult;
      devQuarters *= CONFIG.familyTimeMult;
    }
    // ETOPS 인증을 함께 받으면 개발비와 인증 기간이 는다.
    // 단, **닿을 노선이 있어야** 값을 한다. 리저널(최대 4,800km)·협동체(7,800km)는
    // ETOPS 요구 노선(9,000km~)에 애초에 응찰할 수 없으므로, 인증을 켜도 개발비만
    // 늘고 얻는 게 없는 한 방향 지출이 된다 — 그런 결정은 아예 청구하지 않는다.
    const etopsUsable = range >= ETOPS_USEFUL_RANGE;
    // 4발은 ETOPS 자체가 필요 없다 — 규정이 쌍발에만 걸린다. 그게 4발의 존재 이유다.
    const etops = !!spec.etops && etopsUsable && !quad;
    if (etops) devCost *= CONFIG.etopsDevMult;

    if (derivative) {
      const key = reEngined ? (inFamily ? 'familyReEngined' : 'reEngined') : inFamily ? 'family' : 'plain';
      const rate = CONFIG.derivRates[key];
      // 성장 여유를 산 원형은 개조가 싸고 빠르다 — 그 여유가 정확히 이 순간의 값이다.
      const growthEase = spec.derivedFrom && spec.derivedFrom.growth ? 0.85 : 1;
      devCost *= rate.cost * growthEase;
      devQuarters *= rate.time * growthEase;
      engineersNeeded *= rate.eng;
    }

    // 사풍 — 회사마다 잘하는 일이 다르다. 두 축이고, 서로 다른 것을 잰다.
    //
    //   houseFocus : **급**의 특기. 리저널의 장인은 지선 기체를, 광동체의 집은 큰
    //                기체를 싸게 만든다. 원형이든 파생형이든 그 급이면 붙는다 —
    //                파생형에서만 특기가 사라지면 "장인"이 자기 계보를 늘릴 때
    //                남보다 불리해지는, 설명할 수 없는 규칙이 된다.
    //   houseDeriv : **일**의 특기. 늘리고 고쳐 다는 데 이골이 난 회사의 값이라
    //                파생형에만 붙고, 급을 가리지 않는다.
    //
    // 둘 다 가진 회사는 자기 급의 파생형에서 배수를 겹쳐 받는다. 그건 의도다 —
    // CRJ 를 다섯 번 늘려 본 회사가 여섯 번째를 남보다 싸게 하는 것이 계보의 값이고,
    // 그 대신 백지에서 큰 기체를 그리는 값이 비싸게 매겨져 있다.
    const houseFocus = (spec.houseFocus && spec.houseFocus[seg.id]) || null;
    const houseDeriv = derivative ? spec.houseDeriv || null : null;
    for (const house of [houseFocus, houseDeriv]) {
      if (!house) continue;
      // ?? 다 — 배수 0 은 유효한 값이고, ||는 그것을 1 로 되살린다.
      devCost *= house.cost ?? 1;
      devQuarters *= house.time ?? 1;
      engineersNeeded *= house.eng ?? 1;
    }

    // FBW 연구 — 전자식 조종은 설계 반복을 줄인다. 파생형에도 붙는다:
    // 개발 기간의 비율 단축이라 파생 배수와 겹쳐도 이중 할인이 아니다.
    if (res.fbw) devQuarters *= 0.92;

    // 연비 지수(0~100). 기술 투자 + 소재가 좌우하고, 과도한 항속은 구조중량으로 깎인다.
    const rangePenalty = Math.max(0, rangeRatio - 1) * 9;
    // 연료 여유는 공짜가 아니다. 탱크와 보강 구조를 짧은 노선에서도 지고 다닌다 —
    // 이 상시 손해가 "노선 폭"의 값이다.
    //
    // 기준은 0 이 아니라 **기본 여유**다. 0 을 기준으로 잡으면 기본값 설계가 전부
    // 조용히 연비를 잃어, 이 축을 건드리지 않은 플레이어까지 일괄로 약해진다.
    // 기본보다 줄이면 이득, 늘리면 손해 — 그래야 양방향 축이 된다.
    const marginPenalty = (fm - Airframe.DEFAULT_FUEL_MARGIN / 100) * 8;
    // 성장 여유는 상시 구조 중량이고, 4발은 항력·중량·연료 소모 그 자체다.
    // 유가가 오르면 이 감점이 casm 에서 몇 배로 되돌아온다 — 4발이 시대를 타는 이유.
    const efficiency = clamp(
      (22 + tech * 0.62 + fus.efficiencyBonus + wmat.efficiencyBonus + eng.eff - rangePenalty - marginPenalty -
        (growth ? 1 : 0) - (quad ? 7 : 0) - reEngineSqueeze) *
        sec.effPerSeat *
        (0.72 + secFit * 0.28) +
        wingP.cruiseGain +
        (res.aero ? 3 : 0),
      5,
      99,
    );

    // 객실 쾌적성 — 항공사 프리미엄 노선 평가에 반영. FBW 는 비행 품질로도 돌아온다.
    const comfort = clamp(38 + tech * 0.28 + fus.comfortBonus + eng.comfort + sec.comfort * 2.2 + (res.fbw ? 3 : 0), 10, 99);

    // 표준 생산원가: 크기·항속에 비례, 기술/소재가 올린다.
    const unitCostBase =
      seg.unitCostBase *
      Math.pow(seatRatio, 0.92) *
      Math.pow(rangeRatio, 0.3) *
      (1 + (tech / 100) * 0.3) *
      fus.unitCostMult *
      wmat.unitCostMult *
      eng.costMult *
      sec.costPerSeat *
      wingP.costMult *
      (1 + (fm - Airframe.DEFAULT_FUEL_MARGIN / 100) * 0.1) *
      (growth ? 1.03 : 1) *
      (maintainable ? 1.02 : 1) *
      (quad ? 1.08 : 1) *
      (dual ? 1.03 : 1);

    // 정가: 원가가 아니라 "시장이 값을 쳐주는 가치" 기준으로 만든다.
    const listPrice =
      seg.listPriceBase *
      Math.pow(seatRatio, 0.95) *
      Math.pow(rangeRatio, 0.34) *
      (1 + (tech / 100) * 0.42) *
      (1 + (fus.efficiencyBonus + wmat.efficiencyBonus + eng.eff) / 130);

    // 개발 리스크: 기술을 밀어붙이고 복합재를 쓸수록 결함 확률이 오른다.
    // 엔진 신뢰성과 성숙도가 곱으로 얹힌다 — 신형 엔진 초도 채택이 실제로 위험한 이유.
    // 복합재 연구는 소재가 얹는 위험만 깎는다 — 기술을 밀어붙인 위험은 그대로다.
    const matRisk = (fus.riskBonus + wmat.riskBonus) * (res.composite ? 0.6 : 1);
    const defectRisk = clamp(
      (0.05 + (tech / 100) * 0.22 + matRisk) * eng.riskMult * engMaturity * expRisk * (maintainable ? 0.9 : 1),
      0.03,
      CONFIG.defectRiskMax,
    );

    return {
      segment: seg.id,
      seats: Math.round(seats),
      range: Math.round(range),
      tech: Math.round(tech),
      fuselage: fus.id,
      wingMat: wmat.id,
      fuselageName: fus.name,
      wingMatName: wmat.name,
      // 옛 표시 코드 호환: 대략적인 단일 등급으로 접어서도 노출한다.
      material: fus.id === 'composite' ? 'composite' : wmat.id === 'aluminum' ? 'aluminum' : 'hybrid',
      engine: eng.id,
      engineName: eng.name,
      engineMaker: eng.maker,
      abreast: sec.abreast,
      sectionName: sec.name,
      sectionFit: Math.round(secFit * 100),
      wing: Math.round(wing),
      // 위아래 모두 조인다. wingProfile 이 이미 5~99 로 자른 값에 보정을 더하는 구조라,
      // 상한을 안 걸면 그 계약이 우연한 여유(현재 98.55)로만 유지된다.
      fieldPerf: clamp(Math.round(wingP.field - (fm - Airframe.DEFAULT_FUEL_MARGIN / 100) * 13), 5, 99),
      // 화면이 "경험 덕에 얼마나 줄었나"를 보여줄 수 있게 적용치를 노출한다.
      experience: Math.round(xp * 10) / 10,
      expTimeCut: Math.round((1 - expTime) * 100),
      expEngCut: Math.round((1 - expEng) * 100),
      fuelMargin: Math.round(fuelMargin),
      payloadRange: Airframe.payloadRange(range, wing, fuelMargin),
      // 성숙도 위험이 남아 있으면 UI가 경고할 수 있게 노출한다.
      engineImmature: Math.round((engMaturity - 1) * 100) / 100,
      devCost: Math.round(devCost),
      devQuarters: Math.max(2, Math.round(devQuarters)),
      engineersNeeded: Math.round(engineersNeeded),
      efficiency: Math.round(efficiency),
      comfort: Math.round(comfort),
      unitCostBase: Math.round(unitCostBase * 10) / 10,
      listPrice: Math.round(listPrice * 10) / 10,
      defectRisk: Math.round(defectRisk * 1000) / 1000,
      // 파생형은 개정 형식증명이라 심사도 짧다 — 737-300→800 이 다 그랬다.
      // 신규와 같은 시간을 물리면 "패밀리로 빨리 늘린다"는 전략의 절반이 죽는다.
      certQuarters:
        Math.max(1, Math.round(seg.certQuarters * (derivative ? CONFIG.derivRates[reEngined ? (inFamily ? 'familyReEngined' : 'reEngined') : inFamily ? 'family' : 'plain'].time : 1))) +
        (etops ? CONFIG.etopsCertQuarters : 0),
      family,
      etops,
      etopsUsable,
      inFamily,
      // UI가 "파생형 할인이 적용됐는지"를 그대로 보여줄 수 있게 노출한다.
      derivative,
      reEngined,
      growth,
      maintainable,
      // 광동체가 아니면 4발을 무시하고 2발로 접는다 — 감점 없이 엔진 수 딱지만
      // 얻어 ETOPS 면제(엔진 수 게이트)를 공짜로 누리는 스펙 조작을 막는다.
      engines: quad ? 4 : 2,
      // 화면이 "왜 연비가 깎였나"를 설명할 수 있게 타협 폭을 노출한다.
      reEngineSqueeze,
      // 독점 계약 위반 할증이 적용됐는지 — 설계 화면이 경고를 띄운다.
      exclusiveSurcharge,
      dualSource: dual,
      altEngine: altEng ? altEng.id : null,
      altEngineName: altEng ? altEng.name : null,
      altMaker: altEng ? altEng.maker : null,
    };
  }

  /**
   * 누적 생산 n번째 기체의 실제 원가 — 학습곡선(87%)을 적용한다.
   * 초기 기체는 표준원가를 크게 웃돌아, 램프업 구간에서 적자가 나는 게 정상이다.
   */
  function unitCostAt(unitCostBase, cumulativeUnits, firstUnitPremium) {
    const n = Math.max(1, cumulativeUnits);
    const factor = Math.max(CONFIG.learningFloor, Math.pow(n, CONFIG.learningExponent));
    // 린 생산 연구가 초도기 할증을 낮춘다 — 엔진이 회사 상태에서 넘겨준다.
    return unitCostBase * (firstUnitPremium || CONFIG.firstUnitPremium) * factor;
  }

  /** 설계 기본값 — 세그먼트를 고를 때마다 슬라이더를 이 값으로 되돌린다. */
  function defaultSpec(segmentId, year) {
    const seg = SEGMENTS[segmentId];
    // 연도를 빼먹으면 available() 이 카탈로그 전체를 열어 1998년 게임에 2016년
    // 엔진이 기본값으로 잡힌다. 화면에는 선택된 엔진이 없고, 미리보기·착수는
    // 조용히 다른 엔진으로 계산되어 어긋난다. 없으면 게임 시작 연도로 본다.
    const y = year === undefined ? CONFIG.startYear : year;
    const eng = Engines.defaultFor(segmentId, y);
    return {
      segment: segmentId,
      seats: seg.seats.ref,
      range: seg.range.ref,
      tech: 50,
      material: 'aluminum',
      fuselage: 'aluminum',
      wingMat: 'aluminum',
      abreast: Airframe.DEFAULT_ABREAST[segmentId],
      wing: 45,
      fuelMargin: Airframe.DEFAULT_FUEL_MARGIN,
      engine: eng ? eng.id : undefined,
      year: y,
    };
  }

  root.AirlinerDesign = { evaluate, unitCostAt, defaultSpec, clamp, isCompatibleDerivative };
})(typeof globalThis !== 'undefined' ? globalThis : this);
