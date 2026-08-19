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

  const { AIRLINES, CONFIG, SEGMENTS } = root.AirlinerData;

  const money = (m) => {
    const v = Math.round(m);
    if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(2)}B`;
    return `$${v}M`;
  };

  /** 양산 중인 기종이 있나 — 생산·고객 관련 사건의 공통 전제. */
  function hasProduction(s) {
    return s.programs.some((p) => p.phase === 'production');
  }

  function inDevelopment(s) {
    return s.programs.filter((p) => p.phase === 'dev');
  }

  /** 우리 기체를 가장 많이 굴리는 항공사 — 없으면 관계가 가장 좋은 곳. */
  function topCustomer(s) {
    const byUnits = Object.entries(s.fleets || {})
      .map(([id, byProgram]) => ({ id, units: Object.values(byProgram).reduce((a, n) => a + n, 0) }))
      .filter((x) => x.units > 0)
      .sort((a, b) => b.units - a.units)[0];
    const id = byUnits
      ? byUnits.id
      : Object.entries(s.relations || {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    return AIRLINES.find((a) => a.id === id) || AIRLINES[0];
  }

  function biggestProgram(s) {
    const prod = s.programs.filter((p) => p.phase === 'production');
    if (!prod.length) return null;
    return prod.reduce((a, b) => (b.delivered > a.delivered ? b : a));
  }

  /**
   * "앞당겨 인도"를 팔 수 있는 주문인가 — 양산 중이고 인도 게이트에 안 막혀
   * 있어야 한다. ETOPS 게이트에 막힌 주문은 특별 근무로 기체를 더 뽑아도
   * 인도가 안 되므로, 사건이 집으면 돈만 쓰는 거짓 선택지가 된다.
   */
  function rushableOrder(s, order) {
    const p = s.programs.find((x) => x.id === order.programId);
    if (!p || p.phase !== 'production') return false;
    if (order.reqEtops && !p.etopsCertified) return false;
    return true;
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
        return `${a.name}이 개발 중인 <b>${p.name}</b>의 런치 커스터머를 자청했다. 단, 초도 물량을 대폭 할인해 달라는 조건이다.`;
      },
      options: [
        {
          id: 'take',
          label: '받아들인다',
          detail: '개발비 일부를 선납받고 관계가 크게 오른다. 그 기종 정가는 낮아진다',
          apply: (s, h) => {
            const p = s.programs.find((x) => x.id === h.recall('program'));
            const a = AIRLINES.find((x) => x.id === h.recall('airline'));
            if (!p || !a) return '제안은 흐지부지됐다.';
            const advance = Math.round(p.devCost * 0.12);
            h.income(advance);
            h.relation(a.id, 18);
            p.listPrice = Math.round(p.listPrice * 0.94);
            return `${a.name}에서 선급금 ${money(advance)}을 받았다. 대신 ${p.name}의 정가가 6% 낮아졌다.`;
          },
        },
        {
          id: 'counter',
          label: '조건을 낮춰 역제안한다',
          detail: '선급금은 적지만 정가를 지킨다. 거절당할 수도 있다',
          apply: (s, h) => {
            const p = s.programs.find((x) => x.id === h.recall('program'));
            const a = AIRLINES.find((x) => x.id === h.recall('airline'));
            if (!p || !a) return '제안은 흐지부지됐다.';
            if (h.rng.chance(0.5)) {
              const advance = Math.round(p.devCost * 0.05);
              h.income(advance);
              h.relation(a.id, 8);
              return `${a.name}이 역제안을 받아들였다. 선급금 ${money(advance)}, 정가는 지켰다.`;
            }
            h.relation(a.id, -6);
            return `${a.name}이 역제안을 걷어찼다. 런치 커스터머 이야기는 없던 일이 됐다.`;
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
      text: () => '국제 에어쇼가 열린다. 출품은 비싸지만 항공사 경영진이 한자리에 모이는 자리다.',
      options: [
        {
          id: 'full',
          label: '대형 부스로 나간다',
          detail: '비싸다. 관계와 평판이 함께 오른다',
          apply: (s, h) => {
            const cost = 260;
            h.expense(cost);
            h.reputation(4);
            for (const a of AIRLINES) h.relation(a.id, 3);
            return `${money(cost)}을 들여 대형 부스를 냈다. 모든 항공사와의 관계가 조금씩 올랐다.`;
          },
        },
        {
          id: 'targeted',
          label: '주요 고객만 따로 만난다',
          detail: '싸게 간다. 효과는 한 곳에 몰린다',
          apply: (s, h) => {
            const cost = 70;
            h.expense(cost);
            const a = topCustomer(s);
            h.relation(a.id, 12);
            return `${money(cost)}만 쓰고 ${a.name} 경영진과 따로 만났다. 관계가 크게 올랐다.`;
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
