/*
 * 기체 설계 계산기 — 설계 입력(좌석/항속/기술/소재)을 개발비·개발기간·성능으로 환산한다.
 * 순수 함수만 둔다. UI의 실시간 미리보기와 engine의 실제 착수가 같은 식을 쓰도록.
 */
(function (root) {
  'use strict';

  const { SEGMENTS, FUSELAGE_MATERIALS, WING_MATERIALS, LEGACY_MATERIAL_MAP, CONFIG } = root.AirlinerData;
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

    // 엔진은 설계의 두 번째 축이다. spec.year(소수 연도)가 있으면 그 시점에 실제로
    // 살 수 있는 엔진으로 좁히고, 갓 나온 엔진이면 성숙도 위험이 얹힌다.
    const eng = Engines.resolve(seg.id, spec.engine, spec.year);
    const engMaturity = eng ? Engines.maturityRisk(eng, spec.year) : 1;

    // 동체 단면과 날개 — 양방향 트레이드오프 두 축.
    const sec = Airframe.section(seg.id, spec.abreast);
    const secFit = Airframe.sectionFit(sec, seats);
    const wing = clamp(spec.wing === undefined ? 45 : spec.wing, 0, 100);

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
      wingP.devMult;

    let devQuarters =
      seg.devQuarters * (1 + (tech / 100) * 0.35) * Math.pow(rangeRatio, 0.12) * fus.devTimeMult * wmat.devTimeMult * eng.timeMult;

    let engineersNeeded = seg.engineersNeeded * Math.pow(seatRatio, 0.5) * (1 + (tech / 100) * 0.4);

    // 파생형: 기존 형식증명을 물려받아 개발비·기간이 크게 준다.
    // 단, 원형의 형식증명을 실제로 재사용할 수 있는 변경일 때만 인정한다.
    // 딱지만 붙인 채 소재·기술·항속을 갈아엎으면 신규 설계를 34% 가격에 사는 셈이라
    // 개발비 제약 자체가 무너진다 (동일 설계 기준 $18.6B → $6.3B).
    const derivative = isCompatibleDerivative(spec, range, tech);
    // 엔진을 갈아 끼운 파생형(재장착)은 형식증명은 물려받지만 개발비가 훨씬 크다.
    // A320neo·737 MAX 가 정확히 이 경우다 — 순수 동체 연장과 같은 값을 매기면 안 된다.
    // 원형 엔진을 알 수 없으면(엔진 개념이 없던 옛 설계안) 보수적으로 재장착으로 본다.
    // 실제로 그 시점 엔진으로 대체되므로 "같은 엔진"이라고 볼 근거가 없다.
    const reEngined = derivative && spec.derivedFrom.engine !== eng.id;
    // 원형이 패밀리로 개발됐으면 파생형이 훨씬 싸다 — 패밀리 선투자의 회수 지점.
    const inFamily = derivative && spec.derivedFrom.family === true;

    // 패밀리로 개발하면 공통 구조·조종석 설계에 선투자한다.
    // 선투자는 계보의 뿌리에서 **한 번만** 한다 — 이미 패밀리를 물려받는 파생형은
    // 공통 설계가 이미 존재하므로, 여기서 또 청구하면 아무것도 사지 않는 돈이 된다.
    const family = inFamily || !!spec.family;
    if (family && !inFamily) {
      devCost *= CONFIG.familyDevMult;
      devQuarters *= CONFIG.familyTimeMult;
    }
    // ETOPS 인증을 함께 받으면 개발비와 인증 기간이 는다.
    const etops = !!spec.etops;
    if (etops) devCost *= CONFIG.etopsDevMult;

    if (derivative) {
      const key = reEngined ? (inFamily ? 'familyReEngined' : 'reEngined') : inFamily ? 'family' : 'plain';
      const rate = CONFIG.derivRates[key];
      devCost *= rate.cost;
      devQuarters *= rate.time;
      engineersNeeded *= rate.eng;
    }

    // 연비 지수(0~100). 기술 투자 + 소재가 좌우하고, 과도한 항속은 구조중량으로 깎인다.
    const rangePenalty = Math.max(0, rangeRatio - 1) * 9;
    const efficiency = clamp(
      (22 + tech * 0.62 + fus.efficiencyBonus + wmat.efficiencyBonus + eng.eff - rangePenalty) * sec.effPerSeat * (0.72 + secFit * 0.28) +
        wingP.cruiseGain,
      5,
      99,
    );

    // 객실 쾌적성 — 항공사 프리미엄 노선 평가에 반영.
    const comfort = clamp(38 + tech * 0.28 + fus.comfortBonus + eng.comfort + sec.comfort * 2.2, 10, 99);

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
      wingP.costMult;

    // 정가: 원가가 아니라 "시장이 값을 쳐주는 가치" 기준으로 만든다.
    const listPrice =
      seg.listPriceBase *
      Math.pow(seatRatio, 0.95) *
      Math.pow(rangeRatio, 0.34) *
      (1 + (tech / 100) * 0.42) *
      (1 + (fus.efficiencyBonus + wmat.efficiencyBonus + eng.eff) / 130);

    // 개발 리스크: 기술을 밀어붙이고 복합재를 쓸수록 결함 확률이 오른다.
    // 엔진 신뢰성과 성숙도가 곱으로 얹힌다 — 신형 엔진 초도 채택이 실제로 위험한 이유.
    const defectRisk = clamp(
      (0.05 + (tech / 100) * 0.22 + fus.riskBonus + wmat.riskBonus) * eng.riskMult * engMaturity,
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
      fieldPerf: wingP.field,
      payloadRange: Airframe.payloadRange(range, wing),
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
      certQuarters: seg.certQuarters + (etops ? CONFIG.etopsCertQuarters : 0),
      family,
      etops,
      inFamily,
      // UI가 "파생형 할인이 적용됐는지"를 그대로 보여줄 수 있게 노출한다.
      derivative,
      reEngined,
    };
  }

  /**
   * 누적 생산 n번째 기체의 실제 원가 — 학습곡선(87%)을 적용한다.
   * 초기 기체는 표준원가를 크게 웃돌아, 램프업 구간에서 적자가 나는 게 정상이다.
   */
  function unitCostAt(unitCostBase, cumulativeUnits) {
    const n = Math.max(1, cumulativeUnits);
    const factor = Math.max(CONFIG.learningFloor, Math.pow(n, CONFIG.learningExponent));
    return unitCostBase * CONFIG.firstUnitPremium * factor;
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
      engine: eng ? eng.id : undefined,
      year: y,
    };
  }

  root.AirlinerDesign = { evaluate, unitCostAt, defaultSpec, clamp, isCompatibleDerivative };
})(typeof globalThis !== 'undefined' ? globalThis : this);
