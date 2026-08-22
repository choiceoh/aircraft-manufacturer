/*
 * 도시쌍 수요 — 누가 어디로 얼마나 나는가.
 *
 * sky-tycoon 의 `core/sim/Demand.kt` 와 그 밸런스 상수를 옮겨 왔다. 이 게임에서 이게
 * 하는 일은 저쪽과 다르다: 저쪽은 항공사가 노선을 열지 말지를 이걸로 정하고, 이쪽은
 * **항공사가 어떤 기체를 필요로 하는지**가 여기서 나온다. 지금까지 `AIRLINES[].seatBand`
 * 처럼 손으로 적어 둔 표가 하던 일이다.
 *
 * 상태도 난수도 보지 않는 순수 함수다 — 결정론에 영향이 없다.
 *
 * 승객 1명은 현실의 여러 명에 해당하는 **추상 단위**다. 실제 여객 수를 그대로 쓰면
 * 간선 하나가 항공사 여럿을 먹여 살리는 게임 스케일이 안 나온다.
 */
(function (root) {
  'use strict';

  const Cities = root.AirlinerCities;

  const B = {
    /** 수요 스케일 — 이 값 하나가 세계 전체의 크기를 정한다 */
    K: 1500,
    /** 출장 수요는 양끝 경제력의 곱에 이 지수로 붙는다 */
    BIZ_EXP: 0.55,
    LEISURE_W: 1.2,
    /** 이 거리에서 수요가 절반이 된다 */
    DIST_HALF: 1800,
    /**
     * 거리 감쇠 지수 — 레저가 비즈니스보다 커야 한다.
     *
     * 장거리일수록 승객이 출장 쪽으로 기울어야 대형기 장거리 노선의 채산이 선다.
     * 반대로 두면 장거리가 관광 위주가 되어 수익계수 낮은 손님만 태우고 마진이 바닥을 긴다.
     */
    BIZ_DECAY_EXP: 0.35,
    LEI_DECAY_EXP: 1.15,
    /** 같은 권역끼리는 수요가 조금 더 붙는다 */
    SAME_REGION: 1.18,
    /** 이보다 가까우면 철도·고속도로에 승객을 뺏긴다 */
    RAIL_RANGE: 800,
    RAIL_EXP: 0.5,
    /** 항공여행 보급 지수의 연간 성장 — 도시 성장과는 별개의 저변 확대 */
    TRAVEL_GROWTH: 1.02,
    /** 분기별 계절성. 3분기에 관광이 몰리고 출장은 그때 쉰다 */
    SEASON_LEISURE: [0.86, 1.02, 1.32, 0.8],
    SEASON_BIZ: [1.02, 1.06, 0.86, 1.06],
    /** 불황이 오면 관광이 먼저 죽고 출장은 비교적 버틴다 */
    BIZ_ECON_EXP: 0.8,
    LEI_ECON_EXP: 1.3,
  };

  /**
   * 도시 규모·관광 매력·거리만으로 정해지는 **연간** 기초 수요.
   *
   * 거리에 따라 승객의 **구성**이 바뀐다. 짧은 구간은 관광객이 흔하지만, 대륙을 건너는
   * 노선은 그 값과 시간을 감당하는 쪽 — 출장·상용 수요가 중심이 된다.
   *
   * @param devA/devB 그 도시의 누적 성장 배율 (기본 1)
   */
  function annualBase(a, b, devA, devB) {
    const dA = devA === undefined ? 1 : devA;
    const dB = devB === undefined ? 1 : devB;
    const d = Cities.distance(a.id, b.id);
    if (d < 1) return { business: 0, leisure: 0, total: 0 };

    const econA = a.standing * dA;
    const econB = b.standing * dB;
    const tourA = a.tour * Math.sqrt(dA);
    const tourB = b.tour * Math.sqrt(dB);

    const bizCore = Math.pow(econA * econB, B.BIZ_EXP);
    const leiCore = B.LEISURE_W * Math.sqrt(tourA * tourB);

    const bizDecay = 1 / (1 + Math.pow(d / B.DIST_HALF, B.BIZ_DECAY_EXP));
    const leiDecay = 1 / (1 + Math.pow(d / B.DIST_HALF, B.LEI_DECAY_EXP));

    const rail = d < B.RAIL_RANGE ? Math.pow(d / B.RAIL_RANGE, B.RAIL_EXP) : 1;
    const regional = a.region === b.region ? B.SAME_REGION : 1;
    const k = B.K * rail * regional;

    return pair(k * bizCore * bizDecay, k * leiCore * leiDecay);
  }

  function pair(business, leisure) {
    return {
      business,
      leisure,
      total: business + leisure,
      get businessShare() {
        return this.total <= 0 ? 0 : this.business / this.total;
      },
    };
  }

  /**
   * 이번 **분기** 수요 — 계절·경기·도시 성장·일시 효과까지.
   *
   * `ctx` 는 세계 상태를 받아 온다. 이 게임에는 이미 유가·불황 체계가 있으므로
   * sky-tycoon 의 `World` 를 통째로 옮기지 않고, 부르는 쪽이 그 값을 환산해 넣는다.
   *
   * @param ctx {quarter:1~4, dev:{[cityId]:배율}, travelIndex, economy, regionEconomy:{}, boost:{[cityId]:배율}, closed:{[cityId]:bool}}
   */
  function quarterly(a, b, ctx) {
    const c = ctx || {};
    const closed = c.closed || {};
    if (closed[a.id] || closed[b.id]) return pair(0, 0);

    const dev = c.dev || {};
    const base = annualBase(a, b, dev[a.id], dev[b.id]);
    const q = ((c.quarter || 1) - 1) % 4;

    const regionEcon = c.regionEconomy || {};
    const regionMul = Math.sqrt((regionEcon[a.region] ?? 1) * (regionEcon[b.region] ?? 1));

    // 양끝의 배율을 합칠 때 최댓값만 쓰면 한쪽만 꺾인 이벤트가 반대쪽의 1.0 에 가려
    // 통째로 사라진다. 상승은 큰 쪽을, 하락은 작은 쪽을 각각 살린다.
    const boost = c.boost || {};
    const modA = boost[a.id] ?? 1;
    const modB = boost[b.id] ?? 1;
    const swing = Math.max(1, modA, modB) * Math.min(1, modA, modB);

    // 연간 수요를 네 분기로 나눈다.
    const common = ((c.travelIndex ?? 1) * regionMul * swing) / 4;
    const economy = c.economy ?? 1;

    return pair(
      base.business * common * Math.pow(economy, B.BIZ_ECON_EXP) * B.SEASON_BIZ[q],
      base.leisure * common * Math.pow(economy, B.LEI_ECON_EXP) * B.SEASON_LEISURE[q],
    );
  }

  /** 그 해의 항공여행 보급 지수 — 1970년을 1로 둔다 (sky-tycoon 의 기준연도). */
  function travelIndex(year) {
    return Math.pow(B.TRAVEL_GROWTH, year - 1970);
  }

  root.AirlinerDemand = { BALANCE: B, annualBase, quarterly, travelIndex };
})(typeof globalThis !== 'undefined' ? globalThis : this);
