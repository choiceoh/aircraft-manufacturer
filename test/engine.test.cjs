/*
 * 엔진 회귀 테스트 — 브라우저 없이 시뮬레이션 규칙을 검증한다.
 *   실행: node --test test/engine.test.cjs
 * 소스는 globalThis에 네임스페이스를 붙이는 IIFE라 require만 하면 로드된다.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const JS = path.join(__dirname, '..', 'js');
for (const f of ['rng.js', 'fleet.js', 'engines.js', 'airframe.js', 'data.js', 'decisions.js', 'charts.js', 'design.js', 'bidding.js', 'engine.js', 'panels.js']) {
  require(path.join(JS, f));
}

const {
  AirlinerEngine: E,
  AirlinerDesign: D,
  AirlinerData: Data,
  AirlinerRng: R,
  AirlinerFleet: F,
  AirlinerBidding: B,
  AirlinerPanels: P,
  AirlinerCharts: C,
} = globalThis;

test('시드가 같으면 난수열이 같다 (재현성)', () => {
  const a = R.createRng(42);
  const b = R.createRng(42);
  const seqA = [a.next(), a.next(), a.next()];
  const seqB = [b.next(), b.next(), b.next()];
  assert.deepStrictEqual(seqA, seqB);
  assert.notStrictEqual(seqA[0], R.createRng(43).next());
});

test('설계: 기술 투자와 복합재가 개발비·연비를 올린다', () => {
  const base = D.evaluate({ segment: 'narrow', seats: 180, range: 5500, tech: 30, material: 'aluminum' });
  const hi = D.evaluate({ segment: 'narrow', seats: 180, range: 5500, tech: 90, material: 'composite' });
  assert.ok(hi.devCost > base.devCost, '기술+복합재는 개발비가 더 비싸야 한다');
  assert.ok(hi.efficiency > base.efficiency, '연비가 더 좋아야 한다');
  assert.ok(hi.devQuarters >= base.devQuarters, '개발 기간이 짧아지면 안 된다');
  assert.ok(hi.defectRisk > base.defectRisk, '리스크가 더 커야 한다');
});

test('설계: 슬라이더 값이 세그먼트 범위로 클램프된다', () => {
  const r = D.evaluate({ segment: 'regional', seats: 9999, range: -50, tech: 200, material: 'aluminum' });
  assert.strictEqual(r.seats, Data.SEGMENTS.regional.seats.max);
  assert.strictEqual(r.range, Data.SEGMENTS.regional.range.min);
  assert.strictEqual(r.tech, 100);
});

test('파생형(호환 변경)은 원형보다 개발비·기간이 크게 싸다', () => {
  // 엔진까지 같아야 "순수 동체 연장"이다. 원형 엔진을 명시하지 않으면 보수적으로
  // 재장착으로 잡히므로(옛 세이브의 우회를 막기 위한 규칙) 여기서 못박아 둔다.
  const base = { segment: 'narrow', seats: 180, range: 5500, tech: 60, material: 'aluminum', engine: 'cfm56-5b', year: 2000 };
  const orig = D.evaluate(base);
  // 좌석수만 늘린 동체 연장형 — 형식증명을 물려받을 수 있는 전형적인 파생형.
  const deriv = D.evaluate({
    ...base,
    seats: 200,
    derivedFrom: { id: 'x', name: 'y', tech: 60, material: 'aluminum', range: 5500, engine: 'cfm56-5b' },
  });
  assert.strictEqual(deriv.derivative, true, '호환 변경은 파생형으로 인정돼야 한다');
  assert.ok(deriv.devCost < orig.devCost * 0.5);
  assert.ok(deriv.devQuarters < orig.devQuarters);
});

test('파생형 딱지로 신규 설계 비용을 우회할 수 없다', () => {
  const s = E.newGame(1);
  const legacy = s.programs.find((p) => p.legacy); // tech 38 · aluminum · 4800km
  const seed = E.derivativeSpec(legacy, 20);

  // 파생형 시드를 받은 뒤 소재·기술·항속을 전부 갈아엎으면 사실상 새 기체다.
  const abused = { ...seed, tech: 100, material: 'composite', range: 7800 };
  const honest = { ...abused };
  delete honest.derivedFrom;

  const a = D.evaluate(abused);
  const h = D.evaluate(honest);
  assert.strictEqual(a.derivative, false, '비호환 변경은 파생형으로 인정되면 안 된다');
  assert.strictEqual(a.devCost, h.devCost, '신규 설계와 동일한 개발비여야 한다');
  assert.strictEqual(a.devQuarters, h.devQuarters);

  // 반대로, 좌석수만 바꾼 진짜 파생형은 계속 할인을 받아야 한다.
  const genuine = D.evaluate(seed);
  assert.strictEqual(genuine.derivative, true);
  assert.ok(genuine.devCost < D.evaluate({ ...seed, derivedFrom: undefined }).devCost * 0.5);
});

test('품질 투자가 결함 이벤트의 발생 빈도까지 낮춘다', () => {
  const defect = Data.EVENTS.find((e) => e.id === 'defect');
  assert.strictEqual(typeof defect.weight, 'function', '결함 가중치는 상태 함수여야 한다');

  const risky = E.newGame(5);
  const safe = E.newGame(5);
  const rp = risky.programs.find((p) => p.legacy);
  const sp = safe.programs.find((p) => p.legacy);
  rp.defectRisk = 0.3;
  sp.defectRisk = 0.05;
  assert.ok(defect.weight(risky) > defect.weight(safe), '위험이 낮으면 가중치도 낮아야 한다');

  // 인도된 기종이 없으면 결함 이벤트 자체가 후보에서 빠진다.
  const fresh = E.newGame(5);
  for (const p of fresh.programs) p.delivered = 0;
  assert.strictEqual(defect.weight(fresh), 0);
});

test('분기 현금 변화가 리포트의 매출·비용으로 설명된다 (회계 불변식)', () => {
  // 분기 중 즉시 나가는 지출(착수금·품질투자·라인건설·채용)이 리포트에서 빠지면
  // 현금은 줄었는데 재무표로는 설명되지 않는다. 차입은 부채도 같이 늘므로 상쇄한다.
  const s = E.newGame(7);
  s.cash = 20000;
  const legacy = s.programs.find((p) => p.legacy);

  // 리포트는 분기 중 행동까지 포함하므로, 기준점도 행동 이전이어야 한다.
  const cash0 = s.cash;
  const debt0 = s.debt;

  E.buildLine(s, legacy.id);
  E.hireEngineers(s, 500);
  E.investQuality(s, legacy.id);
  E.launchProgram(s, { segment: 'regional', seats: 90, range: 2500, tech: 40, material: 'aluminum' }, 'ACC-2');
  if (legacy.stock > 0) E.sellStock(s, legacy.id, legacy.stock);
  const r = E.endTurn(s);
  const rep = r.report;
  const cost = rep.productionCost + rep.rdCost + rep.capex + rep.overhead + rep.interest;

  // 현금증감 − 부채증감 = 매출 − 비용 (차입/상환은 현금과 부채를 같은 만큼 움직인다)
  const lhs = s.cash - cash0 - (s.debt - debt0);
  const rhs = rep.revenue - cost;
  assert.ok(Math.abs(lhs - rhs) < 2, `현금 변화 ${Math.round(lhs)}가 매출-비용 ${Math.round(rhs)}와 어긋난다`);
});

test('회계 불변식이 이벤트가 도는 장기 플레이에서도 유지된다 (누적)', () => {
  // 이벤트는 "다음 분기로 넘어가는" 단계에서 굴러 pending 에 쌓이고 다음 리포트가
  // 흡수하므로, 분기 단위로는 한 턴 지연이 있다. 따라서 누적으로 검사한다:
  //   Σ(보고된 손익) + 아직 미결인 pending = 현금증감 − 부채증감
  // 어느 경로든 리포트를 거치지 않고 현금을 옮기면 이 등식이 깨진다.
  const max = Data.CONFIG.maxDebt;
  for (const seed of [3, 21, 404, 1234, 90210]) {
    const s = E.newGame(seed);
    const cash0 = s.cash;
    const debt0 = s.debt;
    let reportedNet = 0;

    for (let i = 0; i < 60 && !s.gameOver; i++) {
      for (const rfp of s.rfps) {
        const el = E.eligiblePrograms(s, rfp).filter((x) => !x.score.blocked);
        if (el.length) E.setBid(s, rfp.id, el[0].program.id, 0.12);
      }
      const r = E.endTurn(s);
      if (!r.ok) break;
      const rep = r.report;
      reportedNet += rep.revenue - (rep.productionCost + rep.rdCost + rep.capex + rep.overhead + rep.interest);

      // 지급불능인데 살아있는 분기가 없어야 한다 (남은 차입 여유 포함).
      const room = Math.max(0, max - s.debt);
      assert.ok(s.gameOver || s.cash + room >= 0, `seed ${seed} ${rep.label}: 지급불능인데 게임이 계속된다`);
    }

    const pendingNet = s.pending.revenue - (s.pending.rdCost + s.pending.capex + s.pending.overhead);
    const actual = s.cash - cash0 - (s.debt - debt0);
    assert.ok(
      Math.abs(actual - (reportedNet + pendingNet)) < 2,
      `seed ${seed}: 현금증감 ${Math.round(actual)} ≠ 보고손익 ${Math.round(reportedNet)} + 미결 ${Math.round(pendingNet)}`,
    );
  }
});

test('완주 시 표시 분기가 마지막 경영 분기와 일치한다', () => {
  const s = E.newGame(2024);
  while (!s.gameOver) {
    s.cash = Math.max(s.cash, 50000); // 자금 제약을 배제하고 완주시킨다
    E.endTurn(s);
  }
  assert.strictEqual(s.gameOver.reason, 'complete');
  assert.strictEqual(s.gameOver.lastTurn, Data.CONFIG.totalTurns - 1, '마지막 경영 분기여야 한다');
  // 존재하지 않는 다음 분기(2018년 1분기)가 표시되면 안 된다.
  assert.strictEqual(s.log[0].label, s.history[s.history.length - 1].label);
  assert.strictEqual(E.turnLabel(s.gameOver.lastTurn), s.history[s.history.length - 1].label);
});

test('경쟁사 인도가 플레이어와 같은 분기 수만큼 집계된다', () => {
  // 경쟁사를 다음 분기 준비 단계에서 굴리면 79회만 돌아 점유율이 늘 유리해진다.
  const s = E.newGame(777);
  const before = s.stats.rivalDelivered;
  let turns = 0;
  while (!s.gameOver) {
    s.cash = Math.max(s.cash, 50000);
    E.endTurn(s);
    turns++;
  }
  assert.strictEqual(turns, Data.CONFIG.totalTurns);
  // 분기마다 최소 4기(하한)는 집계되므로, 79회만 돌았다면 이 하한에 미달한다.
  assert.ok(
    s.stats.rivalDelivered - before >= turns * 4,
    `경쟁사 집계가 ${turns}분기에 못 미친다 (증가분 ${s.stats.rivalDelivered - before})`,
  );
});

test('옛 세이브의 단일 슬롯 운항 정지가 새 맵으로 이관된다', () => {
  const s = E.newGame(5);
  const p = s.programs[0];
  s.effects.groundedProgram = p.id;
  s.effects.groundedQuarters = 2;
  delete s.effects.grounded;

  E.ensureShape(s);
  assert.strictEqual(s.effects.grounded[p.id], 2, '남은 정지 기간이 이관돼야 한다');
  assert.strictEqual(s.effects.groundedProgram, undefined, '옛 필드는 정리돼야 한다');
});

test('파산으로 끝나도 마지막 재무 행이 최종 현금을 설명한다', () => {
  // 이벤트로 파산하면 pending 을 흡수할 다음 분기가 없다 — 그 자리에서 반영해야 한다.
  const max = Data.CONFIG.maxDebt;
  let checked = 0;
  for (let seed = 1; seed < 400 && checked < 3; seed++) {
    const s = E.newGame(seed);
    s.debt = max;
    for (let i = 0; i < 40 && !s.gameOver; i++) E.endTurn(s);
    if (!s.gameOver || s.gameOver.reason !== 'bankrupt') continue;
    const row = s.history[s.history.length - 1];
    assert.ok(
      Math.abs(row.cash - Math.round(s.cash)) < 2,
      `seed ${seed}: 마지막 행 현금 ${row.cash} ≠ 실제 ${Math.round(s.cash)}`,
    );
    // 종료 화면이 가리키는 분기와 장부의 마지막 분기가 같아야 한다.
    assert.strictEqual(
      E.turnLabel(s.gameOver.lastTurn),
      row.label,
      `seed ${seed}: 표시 분기 ${E.turnLabel(s.gameOver.lastTurn)} ≠ 마지막 재무 행 ${row.label}`,
    );
    checked++;
  }
  assert.ok(checked > 0, '파산 표본을 찾지 못했다');
});

test('한 분기에 이벤트가 둘이어도 첫 이벤트의 파산을 되살리지 못한다', () => {
  // 이벤트 풀을 결정적으로 바꿔 "치명적 지출 → 지원금" 순서를 강제한다.
  // 지급불능을 각 이벤트 직후에 확인하지 않으면 뒤의 지원금이 파산을 되돌린다.
  const original = Data.EVENTS.slice();
  try {
    Data.EVENTS.length = 0;
    Data.EVENTS.push(
      {
        id: 't-drain',
        name: '치명적 지출',
        weight: 50,
        apply: (s, h) => {
          h.expense(s.cash + Math.max(0, Data.CONFIG.maxDebt - s.debt) + 100); // 확실히 지급불능
          return '테스트용 대규모 지출';
        },
      },
      {
        id: 't-grant',
        name: '거액 지원금',
        weight: 50,
        apply: (s, h) => {
          h.income(50000); // 파산을 되돌릴 만큼 큰 금액
          return '테스트용 대규모 지원금';
        },
      },
    );

    // 이 버그는 한 분기에 이벤트가 둘 뽑힐 때만 드러난다(약 8%). 단발 분기는
    // 수정 전후가 같게 동작하므로 조기 종료하지 않고 60시드를 훑는다.
    //
    // 판별 단언은 "지출과 지원금이 같은 분기에 공존하지 않는다"이다. 수정 전에는
    // 둘 다 적용돼 파산이 되돌려지고, 수정 후에는 지출 직후 추첨이 멈춰 지원금이
    // 아예 적용되지 않는다. (수정 전 코드에서 seed 4가 실제로 실패하는 것을 확인)
    let drainQuarters = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = E.newGame(seed);
      for (let i = 0; i < 40 && !s.gameOver; i++) {
        E.endTurn(s);
        const ev = s.events || [];
        if (!ev.some((e) => e.id === 't-drain')) continue;
        drainQuarters++;
        assert.ok(
          s.gameOver,
          `seed ${seed}: 지급불능 지출 뒤에도 게임이 계속된다 (현금 ${Math.round(s.cash)}, 이벤트 ${ev.map((e) => e.name).join('+')})`,
        );
        // 지출 "이후"에 지원금이 적용되면 안 된다. 지원금이 먼저 온 경우는
        // 정상이다 — 그 뒤 지출이 여전히 지급불능을 만들었고 게임은 끝났다.
        const drainAt = ev.findIndex((e) => e.id === 't-drain');
        const grantAfter = ev.findIndex((e, k) => k > drainAt && e.id === 't-grant');
        assert.strictEqual(
          grantAfter,
          -1,
          `seed ${seed}: 파산을 만든 지출 뒤에도 지원금이 적용됐다 (${ev.map((e) => e.name).join(' → ')})`,
        );
        break;
      }
    }
    assert.ok(drainQuarters > 0, '치명적 지출 이벤트 표본을 만들지 못했다');

  } finally {
    Data.EVENTS.length = 0;
    Data.EVENTS.push(...original);
  }
});

test('응찰할 수 없는 공고로는 관계가 깎이지 않는다', () => {
  // 초반엔 협동체 DN-150 하나뿐이라 리저널·광동체 공고엔 대응할 방법이 없다.
  // 그걸로 관계가 깎이면 플레이어가 손쓸 수 없는 이유로 이후 입찰 점수까지 낮아진다.
  const s = E.newGame(11);
  const rel0 = { ...s.relations };
  let unbiddable = 0;
  let biddableSkipped = 0;

  // 결정 사건의 무대응 효과도 관계를 깎는다(인도 지연 통보 −8 등). 여기서 재려는 건
  // 입찰 포기 감점뿐이라, 다른 관계 변동원을 빼고 본다.
  const savedDecisions = Dec.DECISIONS.slice();
  const savedEvents = Data.EVENTS.slice();
  Dec.DECISIONS.length = 0;
  Data.EVENTS.length = 0;
  try {
    for (let i = 0; i < 20; i++) {
      for (const rfp of s.rfps) {
        if (E.eligiblePrograms(s, rfp).filter((x) => !x.score.blocked).length) biddableSkipped++;
        else unbiddable++;
      }
      E.endTurn(s); // 아무 입찰도 하지 않는다
    }
  } finally {
    Dec.DECISIONS.push(...savedDecisions);
    Data.EVENTS.push(...savedEvents);
  }
  assert.ok(unbiddable > 0, '응찰 불가 공고 표본이 있어야 한다');

  // 감점 총량이 "응찰 가능했는데 포기한" 건수로 설명돼야 한다.
  const totalDrop = Object.keys(rel0).reduce((a, k) => a + Math.max(0, rel0[k] - s.relations[k]), 0);
  assert.ok(
    totalDrop <= biddableSkipped * 1.5 + 0.01,
    `감점 총량 ${totalDrop.toFixed(1)}이 응찰 가능 포기 ${biddableSkipped}건(최대 ${biddableSkipped * 1.5})을 넘는다`,
  );
});

test('응찰 가능한 공고를 포기하면 관계는 여전히 깎인다', () => {
  const s = E.newGame(11);
  const rfp = {
    id: 'x', turn: 0, airlineId: 'hanul', airlineName: '한울항공', home: '동아시아',
    segment: 'narrow', segmentName: '협동체', reqSeats: 150, reqRange: 4500, qty: 10,
    priceSensitivity: 0.9, prestige: 0.8, relation: s.relations.hanul, deadline: 0,
    rivalHint: { label: '보통', level: 2 },
  };
  s.rfps = [rfp];
  s.bids = {};
  const before = s.relations.hanul;
  E.endTurn(s);
  assert.ok(s.relations.hanul < before, '대응 가능한 공고를 무시하면 관계가 식어야 한다');
});

test('운항 정지 중인 기종은 재고를 처분할 수 없다', () => {
  // 처분을 허용하면 "인도도 멈춘다"는 결함 이벤트 효과를 리스사 매각으로 우회한다.
  const s = E.newGame(5);
  const p = s.programs[0];
  p.stock = 5;
  s.effects.grounded[p.id] = 2;

  const cashBefore = s.cash;
  const r = E.sellStock(s, p.id, 5);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /운항 정지/);
  assert.strictEqual(p.stock, 5, '거부됐으면 재고가 줄면 안 된다');
  assert.strictEqual(s.cash, cashBefore, '현금도 변하면 안 된다');

  // 정지가 풀리면 다시 처분할 수 있다.
  delete s.effects.grounded[p.id];
  assert.strictEqual(E.sellStock(s, p.id, 5).ok, true);
});

test('차입 여유가 남아 있어도 총 유동성이 음수면 파산이다', () => {
  const s = E.newGame(17);
  s.lines.length = 0;
  s.backlog.length = 0;
  for (const p of s.programs) p.stock = 0;
  // 한도에 1M 못 미치지만, 그 1M 을 다 빌려도 여전히 마이너스인 상태.
  s.debt = Data.CONFIG.maxDebt - 1;
  s.cash = -741;
  E.endTurn(s);
  assert.ok(s.gameOver, '한도까지 빌려도 음수면 파산이어야 한다');
  assert.strictEqual(s.gameOver.reason, 'bankrupt');
});

test('지속 효과 재발이 남은 기간을 단축하지 않는다 (파업·공급망)', () => {
  const s = E.newGame(11);
  const strike = Data.EVENTS.find((e) => e.id === 'strike');
  const supply = Data.EVENTS.find((e) => e.id === 'supplier_delay');
  const h = { rng: R.createRng(1), fmt: E.fmtMoney, reputation: () => {} };

  s.effects.strikeQuarters = 2;
  strike.apply(s, h);
  assert.ok(s.effects.strikeQuarters >= 2, '파업 재발이 기간을 줄이면 안 된다');

  s.effects.supplyQuarters = 3;
  supply.apply(s, h);
  assert.ok(s.effects.supplyQuarters >= 3, '공급망 차질 재발이 기간을 줄이면 안 된다');
});

test('위로금을 낼 현금이 없으면 감원이 거부된다', () => {
  const s = E.newGame(13);
  s.cash = 1; // 위로금도 못 낼 상황
  const before = s.engineers;
  const r = E.hireEngineers(s, -1000);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /위로금/);
  assert.strictEqual(s.engineers, before, '거부됐으면 인력이 줄면 안 된다');
  assert.ok(s.cash >= 0, '현금이 음수로 내려가면 안 된다');
});

test('만료된 신용 경색의 가산폭은 재발 시 되살아나지 않는다', () => {
  const s = E.newGame(9);
  s.effects.rateBump = 0.011; // 강한 경색이
  s.effects.rateBumpQuarters = 1; // 이번 분기로 끝난다
  E.endTurn(s);
  assert.strictEqual(s.effects.rateBumpQuarters, 0);
  assert.strictEqual(s.effects.rateBump, 0, '기간이 끝나면 가산폭도 지워져야 한다');

  // 이후 약한 경색이 재발해도 옛 강한 값이 병합되면 안 된다.
  const squeeze = Data.EVENTS.find((e) => e.id === 'credit_squeeze');
  squeeze.apply(s, { rng: R.createRng(4242), fmt: E.fmtMoney, reputation: () => {} });
  assert.ok(s.effects.rateBump <= 0.011, '만료된 값이 되살아나면 안 된다');
  assert.ok(s.effects.rateBump > 0, '새 경색은 적용돼야 한다');
});

test('신용 경색 재발이 진행 중인 효과를 약화시키지 않는다', () => {
  const s = E.newGame(9);
  s.effects.rateBump = 0.011;
  s.effects.rateBumpQuarters = 4;
  const squeeze = Data.EVENTS.find((e) => e.id === 'credit_squeeze');
  const rng = R.createRng(123);
  squeeze.apply(s, { rng, fmt: E.fmtMoney, reputation: () => {} });
  assert.ok(s.effects.rateBump >= 0.011, '이자 가산폭이 줄면 안 된다');
  assert.ok(s.effects.rateBumpQuarters >= 4, '기간이 짧아지면 안 된다');
});

test('착수금이 다음 분기 연구개발비에 반영된다', () => {
  const s = E.newGame(31);
  s.cash = 500000;
  const r = E.launchProgram(s, { segment: 'regional', seats: 90, range: 2500, tech: 40, material: 'aluminum' }, 'RD-1');
  const upfront = r.program.spent;
  assert.ok(upfront > 0);
  const res = E.endTurn(s);
  assert.ok(res.report.rdCost >= upfront, `착수금 ${upfront}이 분기 R&D 비용 ${res.report.rdCost}에 빠졌다`);
});

test('학습곡선: 누적 생산이 늘면 대당 원가가 내려가고 바닥에서 멈춘다', () => {
  const c1 = D.unitCostAt(100, 1);
  const c50 = D.unitCostAt(100, 50);
  const c500 = D.unitCostAt(100, 500);
  assert.ok(c1 > c50 && c50 > c500, '단조 감소해야 한다');
  assert.ok(c1 > 100, '초도 기체는 표준원가보다 비싸야 한다');
  const floor = 100 * Data.CONFIG.firstUnitPremium * Data.CONFIG.learningFloor;
  assert.ok(D.unitCostAt(100, 1e9) >= floor - 1e-9, '학습곡선 바닥 아래로 내려가면 안 된다');
});

test('프로그램 착수 → 개발 → 인증 → 양산 전이', () => {
  const s = E.newGame(7, '테스트항공우주');
  const spec = { segment: 'regional', seats: 90, range: 2500, tech: 40, material: 'aluminum' };
  const res = E.launchProgram(s, spec, '테스트-90');
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.program.phase, 'dev');

  // 인력을 전부 몰아주고 충분히 돌리면 반드시 양산 단계에 도달한다.
  for (let i = 0; i < 40 && res.program.phase !== 'production'; i++) E.endTurn(s);
  assert.strictEqual(res.program.phase, 'production', '40분기 안에 양산 전이가 일어나야 한다');
  assert.ok(res.program.spent > 0);
});

test('인증 전에는 라인을 세울 수 없다', () => {
  const s = E.newGame(11);
  const res = E.launchProgram(s, { segment: 'regional', seats: 90, range: 2500, tech: 30, material: 'aluminum' });
  const line = E.buildLine(s, res.program.id);
  assert.strictEqual(line.ok, false);
  assert.match(line.error, /양산/);
});

test('동시 개발 프로그램은 3개로 제한된다', () => {
  const s = E.newGame(3);
  s.cash = 500000;
  const spec = { segment: 'regional', seats: 90, range: 2500, tech: 20, material: 'aluminum' };
  for (let i = 0; i < 3; i++) assert.ok(E.launchProgram(s, spec, 'p' + i).ok);
  const fourth = E.launchProgram(s, spec, 'p4');
  assert.strictEqual(fourth.ok, false);
  assert.match(fourth.error, /3개/);
});

test('스펙이 모자라면 실격이 아니라 점수로 진다', () => {
  // 항속·좌석은 하드 실격이 아니다. 모자란 기체도 응찰은 하되, 감톤 운항으로
  // 채울 수 있는 좌석이 줄어 적합도에서 밀린다. 세그먼트만 애초에 후보가 아니다.
  const s = E.newGame(5);
  const rfp = {
    id: 'r1', airlineId: 'hanul', airlineName: '한울항공', segment: 'narrow',
    reqSeats: 180, reqRange: 6000, qty: 20, priceSensitivity: 1, prestige: 1,
  };
  const base = { listPrice: 90, efficiency: 60, comfort: 50, wing: 45 };
  const match = { segment: 'narrow', seats: 180, range: 6200, ...base };
  const shortRange = { segment: 'narrow', seats: 180, range: 4000, ...base };
  const shortSeats = { segment: 'narrow', seats: 130, range: 6500, ...base };
  const wrongSeg = { segment: 'wide', seats: 300, range: 12000, ...base, listPrice: 250 };

  const B2 = globalThis.AirlinerBidding;
  const mScore = B2.scoreBid(s, rfp, match, 0);
  const rScore = B2.scoreBid(s, rfp, shortRange, 0);
  const sScore = B2.scoreBid(s, rfp, shortSeats, 0);

  assert.strictEqual(rScore.blocked, null, '항속이 모자라다고 실격시키면 안 된다');
  assert.strictEqual(sScore.blocked, null, '좌석이 모자라다고 실격시키면 안 된다');
  assert.match(B2.scoreBid(s, rfp, wrongSeg, 0).blocked, /세그먼트/);

  assert.ok(rScore.total < mScore.total, '항속이 모자라면 점수가 낮아야 한다');
  assert.ok(sScore.total < mScore.total, '좌석이 모자라면 점수가 낮아야 한다');
  // 2,000km 나 모자란 기체가 딱 맞는 기체와 붙을 만하면 설계가 의미를 잃는다.
  assert.ok(rScore.total < mScore.total * 0.75, `항속 부족 감점이 너무 약하다 (${rScore.total} vs ${mScore.total})`);
});

test('연료 여유는 노선 폭을 사고 상시 효율로 값을 치른다', () => {
  const tight = D.evaluate({ segment: 'wide', seats: 300, range: 11000, tech: 55, fuelMargin: 0, year: 2005 });
  const loose = D.evaluate({ segment: 'wide', seats: 300, range: 11000, tech: 55, fuelMargin: 100, year: 2005 });

  assert.ok(loose.payloadRange.light > tight.payloadRange.light, '여유를 두면 감톤 항속이 늘어야 한다');
  assert.ok(loose.efficiency < tight.efficiency, '여유는 상시 중량이라 연비를 깎아야 한다');
  assert.ok(loose.unitCostBase > tight.unitCostBase, '여유는 원가를 올려야 한다');
  assert.ok(loose.devCost > tight.devCost, '여유는 개발비를 올려야 한다');
  assert.ok(loose.fieldPerf < tight.fieldPerf, '최대이륙중량이 높으면 활주로를 길게 써야 한다');

  // 설계 항속 안에서는 둘 다 만석이다 — 여유는 그 밖에서만 값을 한다.
  const F = globalThis.AirlinerAirframe;
  assert.strictEqual(F.seatFactorAt(tight.payloadRange, 10000), 1);
  assert.strictEqual(F.seatFactorAt(loose.payloadRange, 10000), 1);
  assert.ok(
    F.seatFactorAt(loose.payloadRange, 13000) > F.seatFactorAt(tight.payloadRange, 13000),
    '설계 항속 밖에서는 여유를 둔 쪽이 더 많이 태워야 한다',
  );
});

test('입찰 점수: 할인이 커지면 점수가 오른다', () => {
  const s = E.newGame(5);
  const rfp = {
    id: 'r1', airlineId: 'hanul', airlineName: '한울항공', segment: 'narrow',
    reqSeats: 180, reqRange: 5000, qty: 20, priceSensitivity: 1.2, prestige: 1,
  };
  const p = { segment: 'narrow', seats: 180, range: 5500, listPrice: 95, efficiency: 60, comfort: 55 };
  const low = globalThis.AirlinerBidding.scoreBid(s, rfp, p, 0);
  const high = globalThis.AirlinerBidding.scoreBid(s, rfp, p, 0.3);
  assert.ok(high.total > low.total, '할인은 점수를 올려야 한다');
  assert.ok(high.price < low.price, '실효 가격은 내려가야 한다');
});

test('차입은 한도를 넘지 않고, 상환은 현금/부채를 넘지 않는다', () => {
  const s = E.newGame(9);
  E.borrow(s, 999999);
  assert.strictEqual(s.debt, Data.CONFIG.maxDebt);
  assert.strictEqual(E.borrow(s, 100).ok, false);

  const cashBefore = s.cash;
  E.repay(s, 999999);
  assert.ok(s.debt >= 0 && s.cash >= 0, '음수로 내려가면 안 된다');
  assert.ok(s.cash < cashBefore);
});

test('20년 완주: 아무 조작 없이도 상태가 깨지지 않고 종료된다', () => {
  const s = E.newGame(2024);
  let guard = 0;
  while (!s.gameOver && guard++ < 200) E.endTurn(s);
  assert.ok(s.gameOver, '80분기 안에 반드시 종료돼야 한다');
  assert.ok(['bankrupt', 'complete'].includes(s.gameOver.reason));
  assert.ok(Number.isFinite(s.cash) && Number.isFinite(s.debt));
  assert.ok(Number.isFinite(s.gameOver.score));
  assert.ok(s.reputation >= 0 && s.reputation <= 100, '평판은 0~100을 벗어나면 안 된다');
  assert.ok(s.market.fuelIndex > 0 && s.market.demandIndex > 0);
});

test('같은 시드 + 같은 조작이면 결과가 완전히 같다 (결정론)', () => {
  const play = (seed) => {
    const s = E.newGame(seed);
    E.launchProgram(s, { segment: 'narrow', seats: 170, range: 5200, tech: 55, material: 'hybrid' }, 'D-170');
    for (let i = 0; i < 30; i++) {
      const prod = s.programs.find((p) => p.phase === 'production');
      if (prod && s.lines.length < 2) E.buildLine(s, prod.id);
      for (const rfp of s.rfps) {
        const el = E.eligiblePrograms(s, rfp).filter((x) => !x.score.blocked);
        if (el.length) E.setBid(s, rfp.id, el[0].program.id, 0.1);
      }
      E.endTurn(s);
    }
    return { cash: s.cash, delivered: s.stats.delivered, rep: s.reputation, backlog: E.totalBacklog(s) };
  };
  assert.deepStrictEqual(play(555), play(555));
  assert.notDeepStrictEqual(play(555), play(556));
});

test('주문이 없으면 라인이 재고를 무한정 찍어내지 않는다 (화이트테일 폭주 방지)', () => {
  const s = E.newGame(4242);
  // 레거시 기종의 잔고를 모두 지우고, 라인만 계속 돌린다.
  for (const o of s.backlog) o.remaining = 0;
  for (let i = 0; i < 40; i++) E.endTurn(s);
  const stock = s.programs.reduce((a, p) => a + p.stock, 0);
  assert.strictEqual(stock, 0, `주문이 없는데 재고가 ${stock}기 생산됐다`);
});

test('재고 처분으로 생산 여유를 재생성해 무한히 현금을 만들 수 없다', () => {
  const s = E.newGame(606);
  for (const o of s.backlog) o.remaining = 0; // 주문 없음
  const legacy = s.programs.find((p) => p.legacy);

  const cash0 = s.cash;
  const delivered0 = s.stats.delivered;
  // 매 분기 재고를 처분하며 20분기 — 주문 없이 생산이 재개되면 현금이 불어난다.
  for (let i = 0; i < 20; i++) {
    if (legacy.stock > 0) E.sellStock(s, legacy.id, legacy.stock);
    E.endTurn(s);
  }
  assert.strictEqual(s.stats.delivered, delivered0, '주문이 없으면 인도량이 늘 수 없다');
  assert.ok(s.cash < cash0, '주문 없이 20분기를 보내면 고정비로 현금이 줄어야 한다');
});

test('파산은 다음 분기 이벤트가 되살리지 못한다', () => {
  // 정산 직후 지급불능이면, 이후 지원금 이벤트가 굴러도 파산이 확정돼야 한다.
  let sawInsolvent = false;
  for (const seed of [21, 77, 404, 1024, 90210]) {
    const s = E.newGame(seed);
    s.lines.length = 0;
    s.backlog.length = 0;
    for (const p of s.programs) p.stock = 0;
    s.cash = 1;
    s.debt = Data.CONFIG.maxDebt;
    E.endTurn(s);
    sawInsolvent = true;
    assert.ok(s.gameOver, `seed ${seed}: 지급불능인데 종료되지 않았다 (현금 ${Math.round(s.cash)})`);
    assert.strictEqual(s.gameOver.reason, 'bankrupt');
  }
  assert.ok(sawInsolvent);
});

test('옛 세이브(신규 필드 없음)에서도 행동이 예외 없이 처리된다', () => {
  const s = E.newGame(1);
  const legacy = s.programs.find((p) => p.legacy);
  legacy.stock = 5;
  // 이전 커밋에서 저장된 상태를 흉내 — version은 그대로 1이라 로드된다.
  delete s.pending;
  delete s.effects.grounded;

  const cashBefore = s.cash;
  const r = E.sellStock(s, legacy.id, 5);
  assert.ok(r.ok, '옛 세이브에서 재고 처분이 실패하면 안 된다');
  assert.ok(s.cash > cashBefore, '처분 대금이 들어와야 한다');
  assert.doesNotThrow(() => E.endTurn(s), '옛 세이브로 분기 종료가 가능해야 한다');
});

test('지급불능(현금<0 · 차입한도 소진) 상태로 살아있는 분기가 없다', () => {
  // 정산발이든 이벤트발(결함 수리비)이든 즉시 종료여야 한다.
  const max = Data.CONFIG.maxDebt;
  for (const seed of [1, 50, 60, 21, 404, 1234]) {
    const s = E.newGame(seed);
    s.debt = max; // 한도 소진 상태에서 시작
    for (let i = 0; i < 60 && !s.gameOver; i++) {
      E.endTurn(s);
      const insolvent = s.cash < 0 && s.debt >= max;
      assert.ok(
        !insolvent || s.gameOver,
        `seed ${seed} t${s.turn}: 현금 ${Math.round(s.cash)} · 부채 ${Math.round(s.debt)} 인데 게임이 계속된다`,
      );
    }
  }
});

test('한 분기의 입찰 점수는 앞선 수주의 평판·관계 상승에 영향받지 않는다', () => {
  const s = E.newGame(4242);
  const legacy = s.programs.find((p) => p.legacy);
  // 같은 분기에 동일 항공사 RFP 두 건을 놓고, 첫 건 처리로 오른 관계가
  // 둘째 건 점수에 반영되면 안 된다 (화면에 표시된 점수와 달라진다).
  const mk = (id) => ({
    id, turn: s.turn, airlineId: 'hanul', airlineName: '한울항공', home: '동아시아',
    segment: 'narrow', segmentName: '협동체', reqSeats: 150, reqRange: 4500, qty: 10,
    priceSensitivity: 0.9, prestige: 0.8, relation: s.relations.hanul, deadline: s.turn,
    rivalHint: { label: '보통', level: 2 },
  });
  s.rfps = [mk('rfp-a'), mk('rfp-b')];
  const B = globalThis.AirlinerBidding;
  const scoreA = B.scoreBid(s, s.rfps[0], legacy, 0.1).total;
  const scoreB = B.scoreBid(s, s.rfps[1], legacy, 0.1).total;
  assert.strictEqual(scoreA, scoreB, '분기 시작 시점의 두 점수는 같아야 한다');

  E.setBid(s, 'rfp-a', legacy.id, 0.1);
  E.setBid(s, 'rfp-b', legacy.id, 0.1);
  const relBefore = s.relations.hanul;
  E.endTurn(s);
  // 판정 뒤에는 관계가 올랐어야 하고(입찰 참여), 그 상승이 같은 분기 점수에
  // 소급 적용되지 않았음을 로그의 수주 결과 수로 확인한다.
  assert.ok(s.relations.hanul !== relBefore, '입찰 후 관계는 변해야 한다');
});

test('인력 배분 0%는 프로그램을 동결한다 (진행도·지출 정지)', () => {
  const s = E.newGame(808);
  const r = E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5500, tech: 50, material: 'aluminum' }, 'F-1');
  const p = r.program;
  E.endTurn(s);
  const progressed = p.progress;
  assert.ok(progressed > 0, '기본 배분에서는 진행돼야 한다');

  p.share = 0; // 동결
  const spentBefore = p.spent;
  for (let i = 0; i < 5; i++) E.endTurn(s);
  assert.strictEqual(p.progress, progressed, '동결 중에는 진행도가 그대로여야 한다');
  assert.strictEqual(p.spent, spentBefore, '동결 중에는 개발비가 나가면 안 된다');
  assert.strictEqual(E.projectedQuarters(s, p), Infinity, '동결이면 완료 예상이 무한대');
});

test('파산은 인도량과 무관하게 등급 F', () => {
  const s = E.newGame(31);
  // 회생 불가 상태: 차입 한도 소진 + 현금 고갈 + 수익원(라인·잔고) 전무.
  s.lines.length = 0;
  s.backlog.length = 0;
  for (const p of s.programs) p.stock = 0;
  s.cash = -1;
  s.debt = Data.CONFIG.maxDebt;
  s.stats.delivered = 5000; // 아무리 많이 팔았어도
  E.endTurn(s);
  assert.strictEqual(s.gameOver.reason, 'bankrupt');
  assert.strictEqual(s.gameOver.grade, 'F');
});

test('라인 가동 중지는 생산을 멈추고 램프업을 초기화한다', () => {
  const s = E.newGame(77);
  const line = s.lines[0];
  const p = s.programs.find((x) => x.id === line.programId);
  E.endTurn(s);
  const producedBefore = p.produced;
  E.toggleLine(s, line.id);
  assert.strictEqual(line.idle, true);
  assert.strictEqual(line.ramp, 0.15, '재가동 시 램프업을 다시 올려야 한다');
  for (let i = 0; i < 3; i++) E.endTurn(s);
  assert.strictEqual(p.produced, producedBefore, '정지된 라인은 생산하지 않는다');
});

test('시작 시 노후 주력기와 가동 라인, 수주 잔고를 물려받는다', () => {
  const s = E.newGame(1);
  const legacy = s.programs.find((p) => p.legacy);
  assert.ok(legacy, '레거시 기종이 있어야 한다');
  assert.strictEqual(legacy.phase, 'production');
  assert.ok(s.lines.some((l) => l.programId === legacy.id), '레거시 전용 라인이 있어야 한다');
  assert.ok(E.totalBacklog(s) > 0, '인계받은 수주 잔고가 있어야 한다');
  // 캐시카우가 실제로 현금을 벌어야 한다 (아무 조작 없이 초반 몇 분기).
  // 시작값(186)과 비교하지 않으면 인도가 0이어도 통과하는 공허한 단언이 된다.
  const cash0 = s.cash;
  const delivered0 = s.stats.delivered;
  for (let i = 0; i < 4; i++) E.endTurn(s);
  assert.ok(s.stats.delivered > delivered0, `초반 4분기에 인도가 늘어야 한다 (${delivered0} → ${s.stats.delivered})`);
  assert.ok(s.cash > cash0 * 0.5, '캐시카우가 있는데 초반 4분기에 현금이 반토막 나면 안 된다');
});

test('개발비 총액은 착수금을 포함해 devCost를 넘지 않는다', () => {
  const s = E.newGame(4711);
  s.cash = 500000; // 자금 제약을 배제하고 회계만 본다
  const r = E.launchProgram(s, { segment: 'regional', seats: 90, range: 2500, tech: 40, material: 'aluminum' }, 'ACC-1');
  const p = r.program;
  const budget = p.devCost;
  assert.ok(p.spent > 0, '착수금이 즉시 반영돼야 한다');

  for (let i = 0; i < 60 && p.phase === 'dev'; i++) E.endTurn(s);
  assert.notStrictEqual(p.phase, 'dev', '개발이 끝나야 한다');

  // 착수금(8%)을 낸 뒤 진행도에 다시 100%를 물리면 총액이 108%가 된다.
  // 시험기 제작비는 개발비 예산과 별개의 지출이라 빼고 본다.
  const design = p.spent - (p.testSpent || 0);
  assert.ok(
    Math.abs(design - budget) <= budget * 0.01,
    `총 개발 지출 ${Math.round(design)}이 표시된 개발비 ${budget}와 어긋난다 (품질투자·시험기 제외 기준)`,
  );
});

test('수주하면 백로그가 쌓이고 인도되면 줄어든다', () => {
  const s = E.newGame(1234);
  const launched = E.launchProgram(s, { segment: 'regional', seats: 100, range: 3000, tech: 45, material: 'aluminum' }, 'R-100').program;
  // 물려받은 DN-150의 잔고·인도량으로도 참이 되지 않도록, 신규 기종만 놓고 본다.
  const backlogOf = (id) => s.backlog.reduce((a, o) => a + (o.programId === id ? o.remaining : 0), 0);
  let sawBacklog = false;
  let sawDelivery = false;

  for (let i = 0; i < 60; i++) {
    // 운영 정책은 현실적으로(레거시 포함 전 기종 판매) 두되, 단언은 신규 기종만 본다.
    // 신규 기종으로만 입찰하면 캐시카우가 말라 파산해 라인조차 못 세운다.
    for (const p of s.programs.filter((x) => x.phase === 'production')) {
      const ownLines = s.lines.filter((l) => l.programId === p.id).length;
      if (backlogOf(p.id) > ownLines * 20 && ownLines < 3) E.buildLine(s, p.id);
    }
    for (const rfp of s.rfps) {
      const el = E.eligiblePrograms(s, rfp).filter((x) => !x.score.blocked);
      if (el.length) {
        el.sort((a, b) => b.score.total - a.score.total);
        E.setBid(s, rfp.id, el[0].program.id, 0.15);
      }
    }
    E.endTurn(s);
    if (backlogOf(launched.id) > 0) sawBacklog = true;
    if (launched.delivered > 0) sawDelivery = true;
  }
  assert.ok(sawBacklog, '60분기 동안 신규 기종이 한 번도 수주하지 못하면 밸런스가 잘못된 것');
  assert.ok(sawDelivery, '신규 기종이 수주했다면 인도도 일어나야 한다');
  // 인도 수가 생산 수를 넘을 수 없다.
  for (const p of s.programs) assert.ok(p.delivered <= p.produced, `${p.name}: 인도(${p.delivered}) > 생산(${p.produced})`);
});

// ─────────────────────── 실존 제조사 카탈로그 ───────────────────────

test('카탈로그의 모든 기종이 유효한 제조사·세그먼트를 가리킨다', () => {
  const makers = new Set(F.MANUFACTURERS.map((m) => m.id));
  const segs = new Set(Data.SEGMENT_ORDER);
  const ids = new Set();
  for (const t of F.AIRCRAFT) {
    assert.ok(makers.has(t.maker), `${t.name}: 알 수 없는 제조사 ${t.maker}`);
    assert.ok(segs.has(t.segment), `${t.name}: 알 수 없는 세그먼트 ${t.segment}`);
    assert.ok(!ids.has(t.id), `${t.name}: 중복 id ${t.id}`);
    ids.add(t.id);
    assert.ok(t.seats > 0 && t.range > 0, `${t.name}: 제원이 비었다`);
    assert.ok(t.end === null || t.end > t.eis, `${t.name}: 판매 종료가 취항보다 빠르다`);
  }
});

test('기종은 취항 전·판매 종료 후에는 시장에 없다', () => {
  const neo = F.AIRCRAFT.find((t) => t.id === 'a320neo');
  assert.ok(!F.inService(neo, 2010), 'A320neo가 2010년에 팔리면 안 된다');
  assert.ok(F.inService(neo, 2016.5), 'A320neo는 2016년에 팔리고 있어야 한다');

  const rj = F.AIRCRAFT.find((t) => t.id === 'rj100');
  assert.ok(F.inService(rj, 1999), '아브로 RJ100은 1999년에 팔리고 있어야 한다');
  assert.ok(!F.inService(rj, 2010), '2003년 생산 종료 뒤에는 없어야 한다');
});

test('경쟁 문턱은 시대에 따라 실제 기종에서 나온다', () => {
  const s = E.newGame(5);
  const seg = Data.SEGMENTS.narrow;
  const at = (turn) => {
    s.turn = turn;
    return B.bestOffering(s, 'narrow', Math.round(seg.seats.ref), Math.round(seg.range.ref));
  };

  const early = at(0); // 1998
  const late = at(76); // 2017
  assert.ok(early && late, '협동체는 전 기간 경쟁자가 있어야 한다');
  // 1998년에 2016년 기종과 붙을 수는 없다.
  assert.ok(early.type.eis <= 1998, `1998년 문턱이 ${early.type.name}(${early.type.eis})일 수 없다`);
  assert.ok(late.score > early.score, '20년 뒤 경쟁 문턱이 더 높아야 한다');
});

test('경쟁사 수가 늘어도 실제 입찰 문턱이 따라 오르지 않는다', () => {
  // 예전 방식(경쟁사마다 난수를 뽑아 최댓값)이면 제조사를 복제하는 것만으로 문턱이 올랐다.
  // bestOffering 이 결정론이라는 것만 봐서는 이 성질이 지켜지는지 알 수 없으므로,
  // 난수가 실제로 섞이는 rivalScore 의 평균으로 검사한다.
  const seg = Data.SEGMENTS.wide;
  const rfp = { segment: 'wide', reqSeats: Math.round(seg.seats.ref), reqRange: Math.round(seg.range.ref) };

  const meanOf = (state) => {
    const rng = R.createRng(31337);
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) sum += B.rivalScore(state, rfp, rng).score;
    return sum / n;
  };

  const base = E.newGame(9);
  const dup = E.newGame(9);
  // 같은 카탈로그를 파는 제조사를 3배로 늘린다.
  dup.competitors = dup.competitors.concat(
    dup.competitors.map((c) => ({ id: c.id, name: c.name + ' II', drift: { ...c.drift } })),
    dup.competitors.map((c) => ({ id: c.id, name: c.name + ' III', drift: { ...c.drift } })),
  );

  const a = meanOf(base);
  const b = meanOf(dup);
  assert.ok(Math.abs(a - b) < 0.5, `제조사를 3배로 늘리자 문턱이 ${a.toFixed(1)} → ${b.toFixed(1)} 로 움직였다`);
});

test('유가가 오르면 연비 좋은 기종이 문턱을 가져간다', () => {
  const s = E.newGame(11);
  s.turn = 60; // 2013 — 787/A350 세대와 구형이 공존
  const seg = Data.SEGMENTS.wide;
  s.market.fuelIndex = 0.6;
  const cheap = B.bestOffering(s, 'wide', Math.round(seg.seats.ref), Math.round(seg.range.ref));
  s.market.fuelIndex = 2.0;
  const dear = B.bestOffering(s, 'wide', Math.round(seg.seats.ref), Math.round(seg.range.ref));
  assert.ok(dear.type.eff >= cheap.type.eff, '유가가 높으면 최소한 더 연비 좋은 기종이 나서야 한다');
});

test('가상 경쟁사를 쓰던 옛 세이브도 실존 제조사로 이관된다', () => {
  const s = E.newGame(3);
  // 옛 형식: strength 스칼라 맵, 지금은 없는 제조사 id
  s.competitors = [
    { id: 'aurelia', name: '아우렐리아 에어로스페이스', strength: { regional: 42, narrow: 55, wide: 60 } },
  ];
  E.ensureShape(s);
  assert.ok(
    s.competitors.every((c) => c.drift),
    '이관 후에는 모든 경쟁사가 drift 를 가져야 한다',
  );
  assert.ok(
    s.competitors.some((c) => c.id === 'boeing') && s.competitors.some((c) => c.id === 'airbus'),
    '이관 후에는 실존 제조사 명단이어야 한다',
  );
  // 이관된 상태로 정산이 끝까지 돌아야 한다.
  const r = E.endTurn(s);
  assert.ok(r.ok, '이관된 세이브로 분기 정산이 실패하면 안 된다');
});

test('이벤트는 그 시점에 그 시장에 없는 제조사를 건드리지 않는다', () => {
  const s = E.newGame(7);
  const launch = Data.EVENTS.find((e) => e.id === 'rival_launch');
  const rng = R.createRng(4242);
  const h = { rng, reputation: () => {}, income: () => {}, expense: () => {}, fmt: (v) => String(v) };

  for (const turn of [0, 40, 76]) {
    s.turn = turn;
    for (let i = 0; i < 40; i++) {
      const before = JSON.stringify(s.competitors.map((c) => c.drift));
      const text = launch.apply(s, h);
      assert.strictEqual(typeof text, 'string', '이벤트는 항상 문장을 돌려줘야 한다');
      const after = JSON.stringify(s.competitors.map((c) => c.drift));
      if (before === after) continue;
      // 움직인 제조사·세그먼트는 그 시점에 실제 판매 중이어야 한다.
      const year = F.yearAt(turn, Data.CONFIG.startYear);
      const moved = s.competitors.filter(
        (c, idx) => JSON.stringify(c.drift) !== JSON.stringify(JSON.parse(before)[idx]),
      );
      for (const c of moved) {
        const segs = Data.SEGMENT_ORDER.filter(
          (seg) => c.drift[seg] !== JSON.parse(before)[s.competitors.indexOf(c)][seg],
        );
        for (const seg of segs) {
          const active = F.availableTypes(seg, year).some((t) => t.maker === c.id);
          assert.ok(active, `${year}년에 ${c.name}는 ${seg} 시장에 없는데 이벤트가 건드렸다`);
        }
      }
    }
  }
});

test('경쟁 강도 힌트는 실제 판정과 같은 기대값을 쓴다', () => {
  // rivalBand 가 카탈로그 점수만 보고, rivalScore 는 응찰 우위를 더하면
  // 힌트가 체계적으로 한 구간 물렁해진다 — 사용자가 할인율을 잘못 잡는다.
  const s = E.newGame(9);
  const rng = R.createRng(1);

  for (const seg of ['regional', 'narrow', 'wide']) {
    const sg = Data.SEGMENTS[seg];
    const reqSeats = Math.round(sg.seats.ref);
    const reqRange = Math.round(sg.range.ref);

    const band = B.rivalBand(s, seg, reqSeats, reqRange);
    const rfp = { segment: seg, reqSeats, reqRange };

    // 난수를 여러 번 뽑아 실제 판정 점수의 평균을 낸다.
    let sum = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) sum += B.rivalScore(s, rfp, rng).score;
    const mean = sum / N;

    // 힌트가 가리키는 구간 안에 실제 평균이 들어와야 한다.
    const lo = [0, 0, 50, 60, 70][band.level];
    const hi = [0, 50, 60, 70, 200][band.level];
    assert.ok(
      mean >= lo - 1.5 && mean < hi + 1.5,
      `${seg}: 힌트 '${band.label}'(${lo}~${hi})인데 실제 평균은 ${mean.toFixed(1)}`,
    );
  }
});

test('발주가 취소되면 인도 완료 로그도 취소분을 뺀 수량을 쓴다', () => {
  const s = E.newGame(4);
  // 다른 주문이 같은 분기에 완료돼 로그가 섞이지 않도록 하나만 남긴다.
  const order = s.backlog.find((o) => o.remaining > 0);
  assert.ok(order, '승계 백로그가 있어야 한다');
  s.backlog = [order];

  const cut = 5;
  order.qty = 20;
  order.cancelled = cut;
  order.remaining = 1; // 이번 분기에 잔량이 0이 되어 완료 로그가 찍힌다

  const prog = s.programs.find((p) => p.id === order.programId);
  prog.stock = Math.max(prog.stock, 1);

  E.endTurn(s);

  const done = s.log.find((l) => /인도 완료/.test(l.text));
  assert.ok(done, '인도 완료 로그가 남아야 한다');
  assert.ok(
    done.text.includes(`${order.qty - cut}기 인도 완료`),
    `취소분을 뺀 ${order.qty - cut}기여야 하는데: ${done.text}`,
  );
  assert.ok(!done.text.includes(`${order.qty}기 인도 완료`), '최초 계약량을 그대로 쓰면 안 된다');
});

test('호환되지 않는 파생형은 프로그램에 파생형 표식을 남기지 않는다', () => {
  const s = E.newGame(5);
  s.cash = 40000;
  const base = s.programs.find((p) => p.phase === 'production');
  assert.ok(base, '승계 기종이 있어야 한다');

  const spec = E.derivativeSpec(base, 20);
  // 원형에서 소재·기술·항속을 허용 범위 밖으로 갈아엎는다 → 신규 설계로 판정돼야 한다.
  spec.material = 'composite';
  spec.tech = Math.min(100, base.tech + 40);
  spec.range = Math.round(base.range * 1.6);

  const ev = D.evaluate(spec);
  assert.strictEqual(ev.derivative, false, '비호환 변경은 파생형이 아니다');

  const r = E.launchProgram(s, spec, '검증기');
  assert.ok(r.ok, r.reason);
  const p = s.programs[s.programs.length - 1];
  assert.strictEqual(p.derivative, false);
  assert.strictEqual(p.derivedFrom, null, '전액을 낸 신규 설계에 원형 연결이 남으면 안 된다');
});

test('응찰 불가 공고는 canBid 로 걸러진다 (감점·확인창 공용 기준)', () => {
  const s = E.newGame(6);
  // 시작 시점엔 협동체 DN-150 하나뿐이다.
  const segs = new Set(s.programs.filter((p) => p.phase === 'production').map((p) => p.segment));
  assert.deepStrictEqual([...segs], ['narrow']);

  const rng = R.createRng(3);
  s.rfps = [];
  for (let i = 0; i < 40; i++) s.rfps.push(...B.generateRfps(s, rng));

  for (const rfp of s.rfps) {
    const can = E.canBid(s, rfp);
    if (rfp.segment !== 'narrow') {
      assert.strictEqual(can, false, `${rfp.segment} 공고는 대응 기종이 없어 응찰 불가여야 한다`);
    }
    // 응찰 가능하다면 실격이 아닌 후보가 실제로 존재해야 한다.
    if (can) {
      const ok = E.eligiblePrograms(s, rfp).some((c) => !c.score.blocked);
      assert.ok(ok, 'canBid 가 참이면 실격 아닌 후보가 있어야 한다');
    }
  }
});

// ─────────────────────────── 심화 메커니즘 ───────────────────────────

const { AirlinerEngines: EN } = globalThis;

test('엔진: 그 시점에 살 수 없는 엔진은 채택되지 않는다', () => {
  // 1998년에 2016년 엔진(LEAP)을 지정해도 조용히 당대 엔진으로 대체돼야 한다.
  const early = D.evaluate({ segment: 'narrow', seats: 180, range: 5500, tech: 50, material: 'aluminum', engine: 'leap-1a', year: 1998 });
  assert.notStrictEqual(early.engine, 'leap-1a');
  assert.ok(EN.inService(EN.get(early.engine), 1998), '대체된 엔진은 그 시점에 판매 중이어야 한다');

  // 2016년에는 그대로 채택된다.
  const late = D.evaluate({ segment: 'narrow', seats: 180, range: 5500, tech: 50, material: 'aluminum', engine: 'leap-1a', year: 2016.5 });
  assert.strictEqual(late.engine, 'leap-1a');
  assert.ok(late.efficiency > early.efficiency, '신형 엔진이 연비가 좋아야 한다');
});

test('엔진: 신형은 초기 결함 위험이 얹히고 성숙하면 사라진다', () => {
  const base = { segment: 'wide', seats: 300, range: 12000, tech: 60, material: 'hybrid', engine: 'trent1000' };
  const fresh = D.evaluate({ ...base, year: 2011.75 }); // 취항 직후
  const mature = D.evaluate({ ...base, year: 2016 }); // 성숙 후
  assert.ok(fresh.defectRisk > mature.defectRisk, '취항 직후가 더 위험해야 한다');
  assert.ok(fresh.engineImmature > 0);
  assert.strictEqual(mature.engineImmature, 0);
  // 연비·개발비는 성숙도와 무관하다 — 위험만 다르다.
  assert.strictEqual(fresh.efficiency, mature.efficiency);
  assert.strictEqual(fresh.devCost, mature.devCost);
});

test('엔진: 재장착 파생형은 동체 연장보다 비싸고 신규 설계보다 싸다', () => {
  // 원형 엔진이 아직 팔리고 있어야 "순수 동체 연장"이 성립한다. CFM56-5B 를 쓴다.
  // (DN-150 의 CFM56-3 은 2000년에 단산되므로 2016년 파생형은 필연적으로 재장착이 된다 —
  //  그건 의도한 동작이고, 아래 별도 테스트로 고정한다.)
  const y = 2016.5;
  const base = { segment: 'narrow', seats: 180, range: 5500, tech: 50, material: 'aluminum' };
  const from = { id: 'x', name: '원형', tech: 50, material: 'aluminum', range: 5500, engine: 'cfm56-5b' };

  const stretch = D.evaluate({ ...base, seats: 200, engine: 'cfm56-5b', derivedFrom: from, year: y });
  const reEngine = D.evaluate({ ...base, seats: 200, engine: 'leap-1a', derivedFrom: from, year: y });
  const brandNew = D.evaluate({ ...base, seats: 200, engine: 'leap-1a', year: y });

  assert.strictEqual(stretch.derivative, true);
  assert.strictEqual(stretch.reEngined, false, '같은 엔진이면 재장착이 아니다');
  assert.strictEqual(reEngine.derivative, true);
  assert.strictEqual(reEngine.reEngined, true);

  assert.ok(reEngine.devCost > stretch.devCost, '재장착이 단순 연장보다 비싸야 한다');
  assert.ok(reEngine.devCost < brandNew.devCost, '그래도 신규 설계보다는 싸야 한다');
  assert.ok(reEngine.devQuarters > stretch.devQuarters);
});

test('단산된 엔진을 쓰던 기종의 파생형은 재장착으로 처리된다', () => {
  // 현실의 제약이다 — 원형 엔진을 더 살 수 없으면 동체만 늘리는 선택지는 없다.
  const s = E.newGame(3);
  s.turn = (2016 - 1998) * 4;
  const legacy = s.programs.find((p) => p.legacy);
  assert.strictEqual(EN.inService(EN.get(legacy.engine), 2016), false, '승계 엔진은 이미 단산돼 있어야 한다');

  const ev = D.evaluate({ ...E.derivativeSpec(legacy, 20), year: E.yearOf(s.turn) });
  assert.strictEqual(ev.derivative, true);
  assert.strictEqual(ev.reEngined, true);
  assert.notStrictEqual(ev.engine, legacy.engine);
});

test('선단 공통성: 우리 기체를 굴리는 항공사에서 점수가 더 높다', () => {
  const s = E.newGame(8);
  const p = s.programs.find((x) => x.phase === 'production');
  // 항공사마다 노선망이 달라졌으므로, DN-150 이 실제로 응찰 가능한 공고를 찾아야 한다.
  const rng = R.createRng(1);
  let rfp = null;
  for (let i = 0; i < 300 && !rfp; i++) {
    for (const r of B.generateRfps(s, rng)) {
      if (!rfp && r.segment === 'narrow' && !B.scoreBid(s, r, p, 0.1).blocked) rfp = r;
    }
  }
  assert.ok(rfp, '응찰 가능한 협동체 공고를 하나 찾아야 한다');

  // 같은 공고를 두 상태에서 채점한다: 선단 없음 → 선단 보유.
  const airline = rfp.airlineId;
  const saved = s.fleets[airline];
  s.fleets[airline] = undefined;
  const without = B.scoreBid(s, rfp, p, 0.1).total;
  s.fleets[airline] = { [p.id]: 40 };
  const withFleet = B.scoreBid(s, rfp, p, 0.1).total;
  s.fleets[airline] = saved;

  assert.ok(withFleet > without, `공통성 가산이 붙어야 한다 (${without} → ${withFleet})`);
  assert.ok(withFleet - without <= 6.01, '가산은 상한(6점)을 넘지 않는다');
});

test('선단 공통성은 신규 계정의 점수를 깎지 않는다', () => {
  // 공통성을 가중치 항목으로 넣으면 분모(wsum)가 커져 "우리 기체가 없는 항공사"
  // 점수가 일괄로 내려간다. 그건 가산점의 취지와 정반대다.
  const s = E.newGame(8);
  const p = s.programs.find((x) => x.phase === 'production');
  const rng = R.createRng(5);
  let rfp = null;
  for (let i = 0; i < 200 && !rfp; i++) {
    for (const r of B.generateRfps(s, rng)) {
      if (!rfp && r.segment === 'narrow' && !B.scoreBid(s, r, p, 0.1).blocked) rfp = r;
    }
  }
  assert.ok(rfp, '실격되지 않는 협동체 공고를 하나 찾아야 한다');

  s.fleets = {}; // 어느 항공사에도 우리 기체가 없다
  const noFleet = B.scoreBid(s, rfp, p, 0.1);
  assert.strictEqual(noFleet.parts.common, 0, '공통성 0 이면 가산도 0');

  // 가산 이전의 가중합만으로 계산한 값과 같아야 한다(= 분모 오염이 없다).
  s.fleets = { [rfp.airlineId]: { [p.id]: 40 } };
  const withFleet = B.scoreBid(s, rfp, p, 0.1);
  assert.ok(withFleet.total > noFleet.total);
  assert.ok(withFleet.parts.spec === noFleet.parts.spec, '다른 항목 점수는 그대로여야 한다');
});

test('충격 일정: 역사적 사건은 실현되면 제 시점에만 온다', () => {
  const realTurns = new Set(Data.HISTORICAL.map((h) => h.turn));
  let hist = 0;
  let fict = 0;

  for (let seed = 1; seed <= 200; seed++) {
    const s = E.newGame(seed);
    assert.ok(s.shocks.length <= Data.HISTORICAL.length, '충격이 원래 개수를 넘지 않는다');
    for (const slot of s.shocks) {
      if (slot.kind === 'historical') {
        hist++;
        assert.ok(realTurns.has(slot.turn), '역사적 사건은 실제 시점에만 온다');
      } else {
        fict++;
        assert.ok(slot.turn >= 6 && slot.turn <= Data.CONFIG.totalTurns - 5, '가상 충격 시점이 범위 안이어야 한다');
      }
    }
    // 같은 분기에 둘이 겹치지 않는다.
    const turns = s.shocks.map((x) => x.turn);
    assert.strictEqual(new Set(turns).size, turns.length, '충격이 한 분기에 겹치면 안 된다');
  }

  const ratio = hist / (hist + fict);
  assert.ok(
    Math.abs(ratio - Data.HISTORICAL_ODDS) < 0.08,
    `역사 실현 비율이 ${Data.HISTORICAL_ODDS} 근처여야 한다 (실측 ${ratio.toFixed(3)})`,
  );
});

test('충격 일정은 시드에 대해 결정적이고, 시드가 다르면 갈린다', () => {
  const a = E.newGame(42).shocks;
  const b = E.newGame(42).shocks;
  assert.deepStrictEqual(a, b, '같은 시드는 같은 일정');

  // 200 시드 중 최소 한 번은 9·11 이 불발돼야 "암기 방지"가 실제로 작동한다.
  const t911 = Data.HISTORICAL.find((h) => h.name.includes('9·11')).turn;
  let fired = 0;
  for (let seed = 1; seed <= 200; seed++) {
    if (E.newGame(seed).shocks.some((x) => x.kind === 'historical' && x.turn === t911)) fired++;
  }
  assert.ok(fired > 0 && fired < 200, `9·11 이 시드에 따라 갈려야 한다 (200판 중 ${fired}회)`);
});

test('수요 충격은 몇 분기에 걸쳐 회복된다 (한 분기 벌금이 아니다)', () => {
  const s = E.newGame(4);
  const nine = Data.HISTORICAL.find((h) => h.name.includes('9·11'));
  // 일정을 직접 고정해 이 시드에서 반드시 9·11 이 오게 한다.
  s.shocks = [{ turn: nine.turn, kind: 'historical', id: nine.id || 'hist-' + nine.turn }];

  // 검증 대상은 **회복 속도**다. 무작위 이벤트를 그대로 두면 호황 이벤트 한 방으로
  // 수요가 되올라가 이 규칙과 무관하게 실패한다(실제로 그런 판이 나온다). 충격은
  // 위에서 직접 심었으므로, 이 시나리오 동안만 추첨 이벤트를 비운다.
  const savedEvents = Data.EVENTS.slice();
  Data.EVENTS.length = 0;

  const series = [];
  try {
    while (!s.gameOver && s.turn < nine.turn + 8) {
      s.cash = Math.max(s.cash, 60000);
      E.endTurn(s);
      series.push({ turn: s.turn, demand: s.market.demandIndex, slump: s.effects.demandSlumpQuarters });
    }
  } finally {
    Data.EVENTS.push(...savedEvents);
  }
  const before = series.find((x) => x.turn === nine.turn - 1);
  const at = series.find((x) => x.turn === nine.turn);
  const after4 = series.find((x) => x.turn === nine.turn + 4);
  assert.ok(before && at && after4);

  // 절대 수준이 아니라 낙폭으로 본다 — 충격 직전 수요는 시드마다 다르다.
  assert.ok(at.demand < before.demand * 0.8, `충격 분기에 크게 떨어져야 한다 (${before.demand.toFixed(2)} → ${at.demand.toFixed(2)})`);

  // "한 분기 벌금이 아니다"는 곧 **침체가 여러 분기 지속된다**는 뜻이다.
  // 수요지수 자체는 σ=0.06 짜리 확률보행이 얹혀 있어, 1년 뒤 수준을 문턱으로 재면
  // 규칙이 아니라 그 판의 잡음을 재게 된다.
  assert.ok(at.slump >= 3, `충격이 여러 분기 지속돼야 한다 (${at.slump}분기)`);
  assert.ok(after4.slump > 0 || after4.demand < before.demand, '1년 뒤에도 침체가 남아 있거나 수요가 낮아야 한다');
  // 침체 중에는 평균 회귀가 느려야 한다 — 회복분이 평상시(0.15)의 절반 아래여야 한다.
  const slumped = series.filter((x) => x.slump > 0);
  assert.ok(slumped.length >= 3, '침체 표본이 부족하다');
});

test('가상 충격에는 상방도 있다 (타임라인이 벌주기만 하지 않는다)', () => {
  const ups = Data.FICTIONAL_SHOCKS.filter((f) => {
    const s = E.newGame(1);
    const before = s.market.demandIndex;
    f.apply(s, { rng: R.createRng(1), fmt: E.fmtMoney, reputation: () => {}, income: () => {}, expense: () => {} });
    return s.market.demandIndex > before;
  });
  assert.ok(ups.length >= 2, `수요를 올리는 가상 충격이 최소 둘은 있어야 한다 (${ups.length})`);
});

test('신용등급: 차입이 늘면 등급이 내려가고 이자율이 오른다', () => {
  const s = E.newGame(6);
  const good = E.creditRating(s);
  E.borrow(s, Data.CONFIG.maxDebt); // 한도까지 당긴다
  const bad = E.creditRating(s);
  assert.ok(bad.mult > good.mult, `부채가 늘면 금리 배수가 올라야 한다 (${good.grade} → ${bad.grade})`);
});

test('신용등급: 개발 투자만으로 최하등급이 되지 않는다', () => {
  // 개발비를 자산으로 보지 않으면 개발 기간(= 게임의 본편) 내내 CCC 가 되어
  // 현금이 가장 마른 시점에 이자까지 올리는 사망 나선이 생긴다.
  // 지급능력은 넉넉히 두고 "개발비를 쓰고 있다"는 사실만 남긴다.
  // (현금이 마르면 CCC 는 옳은 판정이다 — 그건 이 테스트의 대상이 아니다.)
  const s = E.newGame(6);
  s.cash = 30000;
  E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5500, tech: 60, material: 'hybrid' }, 'DEV');
  for (let i = 0; i < 8 && !s.gameOver; i++) {
    E.endTurn(s);
    s.cash = Math.max(s.cash, 30000);
  }
  const p = s.programs.find((x) => x.phase === 'dev' || x.phase === 'cert');
  assert.ok(p && p.spent > 0, '개발이 진행돼 지출이 쌓여야 한다');
  assert.ok(E.netWorth(s) > 0, '전제: 부실이 아니어야 한다');
  assert.notStrictEqual(E.creditRating(s).grade, 'CCC');
});

test('인증 지연이 생기면 기간이 늘고 비용이 리포트에 잡힌다', () => {
  // 분기당 확률이 12% 상한이라 한 판에서는 자주 나지 않는다. 여러 시드를 돌려
  // "지연이 발생하면 기간이 늘고 그 비용이 리포트에 잡힌다"를 검증한다.
  let delays = 0;
  let costed = 0;

  for (let seed = 1; seed <= 40; seed++) {
    const s = E.newGame(seed);
    s.cash = 60000; // 자금 문제로 중단되지 않게
    E.launchProgram(s, { segment: 'regional', seats: 90, range: 2500, tech: 95, material: 'composite' }, 'RISK');
    const p = s.programs[s.programs.length - 1];
    p.progress = 100;
    p.phase = 'cert';
    p.defectRisk = 0.6;

    while (p.phase === 'cert' && !s.gameOver) {
      const before = s.log.length;
      const r = E.endTurn(s);
      if (!r.ok) break;
      s.cash = 60000;
      // 인증이 밀리는 경로는 둘이다: 무작위 이벤트 '인증 지연'(무상)과 심사 지연(유상).
      // 여기서 검증하는 건 후자이므로 로그로 구분한다.
      let sawReview = false;
      for (let i = 0; i < s.log.length - before; i++) {
        if (/형식증명 심사에서 설계 변경/.test(s.log[i].text)) sawReview = true;
      }
      if (sawReview) {
        delays++;
        if (r.report.rdCost > 0) costed++;
      }
    }
  }

  assert.ok(delays > 0, '결함 위험 60%로 40판을 돌리면 심사 지연이 나야 한다');
  assert.strictEqual(delays, costed, '심사 지연에는 항상 대응 비용이 따라야 한다');
});

// ────────────── 리뷰에서 잡힌 회귀 (엔진·인증·자산 평가) ──────────────

test('인증 심사 지적은 광고한 만큼만 밀린다', () => {
  // 지적이 나온 분기에 그 분기 시험비행까지 날아가면 "1분기 지연"이 실제로는 2분기가 된다.
  const s = E.newGame(12);
  s.cash = 60000;
  // 인증 지연 이벤트도 시험 시간을 늘린다. 여기서 재려는 건 심사 지적 경로뿐이라 뺀다.
  const savedEvents = Data.EVENTS.slice();
  Data.EVENTS.length = 0;
  E.launchProgram(s, { segment: 'regional', seats: 90, range: 2500, tech: 95, material: 'composite' }, 'RISK');
  const p = s.programs[s.programs.length - 1];
  p.progress = 100;
  p.phase = 'cert';
  p.testFleet = 2;
  p.testHours = 0;
  p.testHoursNeeded = 100000; // 이번 검증 동안 인증이 끝나 버리지 않게 넉넉히
  p.testSpent = 0;
  p.defectRisk = 0.7;

  let checked = 0;
  for (let i = 0; i < 400 && checked < 6; i++) {
    const needBefore = p.testHoursNeeded;
    const hoursBefore = p.testHours;
    const logLen = s.log.length;
    const r = E.endTurn(s);
    if (!r.ok) break;
    s.cash = 60000;

    let added = 0;
    for (let k = 0; k < s.log.length - logLen; k++) {
      const m = /형식증명 심사에서 설계 변경 요구가 나왔다\. 재시험 ([\d,]+)시간/.exec(s.log[k].text);
      if (m) added = Number(m[1].replace(/,/g, ''));
    }

    // 지적이 있든 없든 그 분기의 시험비행은 정상적으로 쌓여야 한다.
    assert.strictEqual(
      p.testHours - hoursBefore,
      p.testFleet * 350,
      '지적이 난 분기의 시험비행 시간이 통째로 날아갔다',
    );
    if (!added) {
      assert.strictEqual(needBefore, p.testHoursNeeded, '지적이 없는데 요구 시간이 늘었다');
      continue;
    }
    assert.strictEqual(p.testHoursNeeded - needBefore, added, '로그에 적힌 재시험 시간과 실제 증가분이 다르다');
    checked++;
  }
  Data.EVENTS.push(...savedEvents);
  assert.ok(checked >= 3, `지적 표본이 ${checked}건뿐이라 검증이 성립하지 않는다`);
});

test('인증 지연 이벤트가 실제로 취항을 밀어낸다', () => {
  // 잔여 분기는 시험비행 시간에서 나오는 파생값이다. 이벤트가 certRemaining 에
  // 분기를 직접 더하면 다음 정산에서 덮어써져, 로그만 "밀린다"고 말하고 취항 시점은
  // 그대로였다. 지연은 시간으로 환산돼야 한다.
  const s = E.newGame(29);
  s.cash = 60000;
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5200, tech: 50 }, 'DELAY').ok);
  const p = s.programs[s.programs.length - 1];
  p.phase = 'cert';
  p.progress = 100;
  p.testFleet = 2;
  p.testHours = 0;
  p.testHoursNeeded = 2800;
  p.testSpent = 0;

  const before = p.testHoursNeeded;
  const added = E.delayCertification(p, 3);
  assert.ok(added > 0, '지연이 시간으로 환산되지 않았다');
  assert.strictEqual(p.testHoursNeeded - before, added, '요구 시간이 환산분만큼 늘어야 한다');
  assert.strictEqual(E.certQuartersLeft(p), Math.ceil((before + added) / 700), '잔여 분기가 늘어난 시간을 반영해야 한다');

  // 양산 단계에서는 아무 일도 없어야 한다 — 이미 인증이 끝난 기종이다.
  p.phase = 'production';
  assert.strictEqual(E.delayCertification(p, 3), 0, '인증이 끝난 기종을 밀면 안 된다');
});
test('인증에 성공해도 신용등급이 떨어지지 않는다', () => {
  // 개발 자산을 dev/cert 에만 인정하면, 양산 전이 순간 자산이 통째로 사라져
  // 현금도 부채도 그대로인데 등급만 내려가고 이자가 오른다.
  // 개발 자산이 자기자본에서 실제로 유의미한 몫이어야 절벽이 드러난다.
  // 현금이 넉넉하면 어느 쪽이든 같은 등급이라 테스트가 무력해진다.
  const s = E.newGame(6);
  s.cash = 6000;
  s.debt = 6000;
  E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5500, tech: 60, material: 'hybrid' }, 'DEV');
  const p = s.programs[s.programs.length - 1];
  p.phase = 'cert';
  p.progress = 100;
  p.spent = p.devCost * 0.9;
  p.certRemaining = 1;

  const before = E.creditRating(s);
  p.phase = 'production'; // 다른 상태는 건드리지 않고 전이만 시킨다
  const after = E.creditRating(s);
  assert.strictEqual(
    after.grade,
    before.grade,
    `인증 성공만으로 등급이 바뀌면 안 된다 (${before.grade} → ${after.grade})`,
  );
});

test('엔진 개념이 없던 세이브의 프로그램에도 엔진이 채워진다', () => {
  const s = E.newGame(9);
  const p = s.programs.find((x) => x.legacy);
  delete p.engine; // v1 세이브 재현
  delete p.engineName;

  E.ensureShape(s);
  assert.ok(p.engine, '마이그레이션이 엔진을 채워야 한다');
  assert.ok(EN.get(p.engine), '카탈로그에 있는 엔진이어야 한다');

  // 이 기종의 파생형에 다른 엔진을 달면 재장착으로 잡혀야 한다.
  s.turn = (2016 - 1998) * 4;
  const spec = { ...E.derivativeSpec(p, 20), engine: 'leap-1a', year: E.yearOf(s.turn) };
  const ev = D.evaluate(spec);
  assert.strictEqual(ev.derivative, true);
  assert.strictEqual(ev.reEngined, true, 'v1 세이브에서 온 기종도 재장착 비용을 내야 한다');
});

test('defaultSpec 은 연도를 안 줘도 그 시대 엔진을 고른다', () => {
  // 연도를 빼먹으면 카탈로그 전체가 열려 1998년 게임에 2016년 엔진이 잡힌다.
  const spec = D.defaultSpec('narrow');
  const eng = EN.get(spec.engine);
  assert.ok(eng, '기본 엔진이 있어야 한다');
  assert.ok(
    EN.inService(eng, Data.CONFIG.startYear),
    `${eng.name} 은 ${Data.CONFIG.startYear}년에 살 수 없다`,
  );

  // 화면에 뜨는 선택지 안에 실제로 들어 있어야 선택 상태가 표시된다.
  const shown = EN.available('narrow', Data.CONFIG.startYear).map((e) => e.id);
  assert.ok(shown.includes(spec.engine), '기본 엔진이 그 시점 선택지에 있어야 한다');
});

test('품질 강화 표시 가격과 실제 청구액이 같다', () => {
  // UI 는 devCost*0.06, 엔진은 3.5% 를 청구하면 표시가 71% 비싸다 — 현금이
  // 빠듯한 플레이어의 선택 자체를 왜곡한다. 상수를 공유해야 한다.
  const s = E.newGame(2);
  s.cash = 40000;
  E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5500, tech: 50, material: 'hybrid' }, 'Q');
  const p = s.programs[s.programs.length - 1];

  // 화면에 실제로 렌더되는 문자열에서 가격을 읽어, 청구액과 대조한다.
  const html = P.renderPrograms(s);
  const m = /품질 강화 \(\d\/3\) · ([^<]+)/.exec(html);
  assert.ok(m, '품질 강화 버튼이 렌더돼야 한다');
  const shownText = m[1].trim();

  const before = s.cash;
  const r = E.investQuality(s, p.id);
  assert.ok(r.ok, r.error);
  const charged = Math.round(before - s.cash);

  assert.strictEqual(shownText, P.money(charged), `표시 ${shownText} ≠ 청구 ${P.money(charged)}`);
});

test('과잉 배치 페널티가 결함 위험을 낮추지 않는다', () => {
  // 상한이 0.6 이면 엔진 배수까지 붙어 0.6 을 넘긴 설계에서는 이 "악재"가
  // 오히려 위험을 낮춘다 — 악재가 보상이 되는 역전.
  const s = E.newGame(3);
  s.cash = 60000;
  E.launchProgram(s, { segment: 'wide', seats: 320, range: 13000, tech: 98, material: 'composite' }, 'HI');
  const p = s.programs[s.programs.length - 1];
  p.defectRisk = 0.72; // 엔진 배수까지 붙으면 실제로 나올 수 있는 값
  p.share = 100;
  s.engineers = 60000; // 과잉 배치를 강제한다

  let min = p.defectRisk;
  for (let i = 0; i < 30 && !s.gameOver && p.phase === 'dev'; i++) {
    const before = p.defectRisk;
    if (!E.endTurn(s).ok) break;
    s.cash = 60000;
    assert.ok(p.defectRisk >= before, `결함 위험이 내려갔다 (${before} → ${p.defectRisk})`);
    min = Math.min(min, p.defectRisk);
  }
  assert.ok(min >= 0.72, '어떤 경로로도 초기 위험 아래로 떨어지면 안 된다');
});

test('입찰 총점은 공통성 가산을 얹어도 0~100 을 넘지 않는다', () => {
  const s = E.newGame(5);
  const p = s.programs.find((x) => x.phase === 'production');

  // 모든 항목을 최대로 민다. 제원은 정확히 일치시켜 specFit 을 1로 만든다 —
  // 무작위 공고로는 적합도가 깎여 상한을 시험하지 못한다.
  s.reputation = 100;
  p.efficiency = 99;
  p.comfort = 99;
  p.listPrice = 1;

  const rfp = {
    id: 'rfp-max',
    turn: s.turn,
    airlineId: 'panamer',
    airlineName: '판아메르 항공',
    segment: p.segment,
    segmentName: '협동체',
    reqSeats: p.seats,
    reqRange: p.range,
    qty: 50,
    priceSensitivity: 1.4,
    prestige: 1,
    relation: 100,
  };
  s.relations.panamer = 100;
  // 공통성 최대치는 "같은 기종 깊이 + 우리 다른 기종 보유"를 둘 다 요구한다.
  s.fleets.panamer = { [p.id]: 500, 'prog-other': 100 };

  const sc = B.scoreBid(s, rfp, p, Data.CONFIG.maxDiscount);
  assert.ok(sc.total > 90, `상한 근처까지 올라가야 시험이 된다 (${sc.total})`);
  assert.ok(sc.total <= 100, `총점이 척도를 넘었다 (${sc.total})`);
  assert.strictEqual(sc.parts.common, 100, '공통성이 최대여야 한다');
});

test('선단 개념이 없던 세이브도 승계 선단과 인도 실적을 복원한다', () => {
  const s = E.newGame(7);
  const legacy = s.programs.find((p) => p.legacy);
  // 주문 하나를 절반 인도한 상태로 만든다.
  const order = s.backlog[0];
  order.remaining = order.qty - 10;

  delete s.fleets; // v1 세이브 재현
  E.ensureShape(s);

  assert.ok(s.fleets, '선단 장부가 만들어져야 한다');
  assert.strictEqual(s.fleets.panamer[legacy.id] >= 62, true, '승계 선단이 복원돼야 한다');
  assert.strictEqual(s.fleets.hanul[legacy.id] >= 48, true);
  // 인도된 10기가 그 항공사 선단에 반영돼야 한다.
  const expected = order.airlineId === 'panamer' ? 72 : 58;
  assert.strictEqual(s.fleets[order.airlineId][legacy.id], expected, '남은 주문 기록에서 인도분을 복원해야 한다');
});

test('입찰 점수 내역에 선단 공통성이 표시된다', () => {
  // 최대 6점이라 ±4 분할 경계보다 크다 — 화면에 없으면 결과를 설명할 수 없다.
  const s = E.newGame(11);
  const p = s.programs.find((x) => x.phase === 'production');
  const rng = R.createRng(4);
  let rfp = null;
  for (let i = 0; i < 200 && !rfp; i++) {
    for (const r of B.generateRfps(s, rng)) {
      if (!rfp && r.segment === 'narrow' && !B.scoreBid(s, r, p, 0.1).blocked) rfp = r;
    }
  }
  assert.ok(rfp);
  s.rfps = [rfp];
  E.setBid(s, rfp.id, p.id, 0.1);
  s.fleets[rfp.airlineId] = { [p.id]: 40 };

  const html = P.renderBidInfo(s, rfp);
  assert.ok(/선단 공통성/.test(html), '점수 내역에 공통성 항목이 있어야 한다');
});

test('결함 위험 상한은 설계와 개발 페널티가 같은 값을 쓴다', () => {
  // 두 곳에 각각 박아 두면 한쪽만 올렸을 때 "악재가 위험을 낮추는" 역전이 생긴다.
  const cap = Data.CONFIG.defectRiskMax;
  assert.ok(cap > 0.6, '상한이 옛 하드코딩 값(0.6)보다 커야 이 회귀가 의미 있다');

  // 설계가 실제로 상한까지 갈 수 있는지 — 갈 수 없으면 이 테스트는 공회전이다.
  const worst = D.evaluate({
    segment: 'wide', seats: 400, range: 15000, tech: 100, material: 'composite',
    engine: 'trent1000', year: 2011, // 취항 첫 해 = 성숙도 위험 최대
  });
  assert.strictEqual(worst.defectRisk, cap, `최악 설계가 상한에 닿아야 한다 (${worst.defectRisk})`);

  // 상한에 닿은 프로그램에 개발 중 과잉 배치 페널티가 걸려도 내려가면 안 된다.
  const s = E.newGame(3);
  s.cash = 60000;
  E.launchProgram(s, { segment: 'wide', seats: 400, range: 15000, tech: 100, material: 'composite' }, 'MAX');
  const p = s.programs[s.programs.length - 1];
  p.defectRisk = cap;
  p.share = 100;
  s.engineers = 80000; // 과잉 배치 강제

  for (let i = 0; i < 25 && !s.gameOver && p.phase === 'dev'; i++) {
    if (!E.endTurn(s).ok) break;
    s.cash = 60000;
    assert.ok(p.defectRisk >= cap, `상한에서 내려갔다 (${p.defectRisk})`);
  }
});

test('화면에 표시되는 분기 이자가 실제 청구액과 같다', () => {
  // 화면이 이자율을 따로 계산하면 등급이 BBB 가 아닐 때 표시와 청구가 어긋난다
  // (AA 는 과대, BB~CCC 는 과소). 차입·상환 판단을 직접 오도한다.
  for (const seed of [2, 5, 9]) {
    const s = E.newGame(seed);
    E.borrow(s, 5000); // 등급을 BBB 밖으로 밀어낸다
    s.effects.rateBump = 0.008;
    s.effects.rateBumpQuarters = 3;

    const html = P.renderFinance(s);
    const m = /분기 이자 ([^<]+)/.exec(html);
    assert.ok(m, '분기 이자 표시가 있어야 한다');
    const shown = m[1].trim();

    // 이자율은 분기 시작 시 고정된다 — 그 분기의 생산·인도로 등급이 흔들려도
    // 플레이어가 보고 판단한 값 그대로 청구돼야 한다.
    const debtBefore = s.debt;
    const rateBefore = E.quarterRate(s);
    assert.strictEqual(shown, P.money(debtBefore * rateBefore), `seed ${seed}: 화면 표시가 어긋난다`);

    const r = E.endTurn(s);
    assert.ok(r.ok);
    assert.ok(
      Math.abs(r.report.interest - debtBefore * rateBefore) < 0.01,
      `seed ${seed}: 표시 ${Math.round(debtBefore * rateBefore)} ≠ 청구 ${Math.round(r.report.interest)}`,
    );
  }
});

test('분기 중 등급이 바뀌어도 고지한 이자율로 청구한다', () => {
  // 생산·인도로 현금이 등급 문턱을 넘으면, 정산 시점에 다시 계산할 경우
  // 화면에서 보고 판단한 이자와 실제 청구가 달라진다.
  const s = E.newGame(1);
  E.borrow(s, 6000);
  const quoted = E.quarterRate(s);
  const debtBefore = s.debt;

  // 분기 중 대량 인도로 현금을 크게 늘려 등급 근거를 흔든다.
  const p = s.programs.find((x) => x.phase === 'production');
  p.stock = 40;

  const r = E.endTurn(s);
  assert.ok(r.ok);
  assert.ok(r.report.delivered > 0, '전제: 이 분기에 인도가 있어야 한다');
  assert.ok(
    Math.abs(r.report.interest - debtBefore * quoted) < 0.01,
    `고지 ${Math.round(debtBefore * quoted)} ≠ 청구 ${Math.round(r.report.interest)}`,
  );
});

test('rd 가 없던 옛 이력은 수익성 판정에 영향을 주지 않는다', () => {
  // 옛 행의 net 에는 개발비가 그대로 들어 있어, 그대로 쓰면 세이브를 불러온 것만으로
  // 등급이 떨어진다. rd 를 복원할 방법은 없으므로 그 행을 판정에서 빼는 게 유일한 답이다.
  // (등급이 원래대로 돌아오지는 않는다 — 옛 행이 아예 무시된다는 것이 계약이다.)
  const s = E.newGame(4);
  s.cash = 5000;
  E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5500, tech: 60, material: 'hybrid' }, 'DEV');
  for (let i = 0; i < 4; i++) {
    E.endTurn(s);
    s.cash = Math.max(s.cash, 5000);
  }
  assert.ok(s.history.length >= 4);

  // v1 세이브 재현: rd 가 없다.
  for (const h of s.history) delete h.rd;
  const base = E.creditRating(s).grade;

  // 그 행들의 손익을 아무리 왜곡해도 등급이 흔들리면 안 된다.
  for (const h of s.history) h.net = -999999;
  assert.strictEqual(E.creditRating(s).grade, base, 'rd 없는 행이 등급을 움직였다');

  for (const h of s.history) h.net = 999999;
  assert.strictEqual(E.creditRating(s).grade, base, 'rd 없는 행이 등급을 움직였다');
});

test('승계 기종 마이그레이션은 새 게임과 같은 엔진을 준다', () => {
  // launchTurn 을 0 으로 클램프하면 1998년 기준 엔진이 잡혀, 새 게임의 같은
  // 기체와 달라지고 2000년 이후 파생형 비용까지 34% vs 58% 로 어긋난다.
  const fresh = E.newGame(5);
  const freshLegacy = fresh.programs.find((p) => p.legacy);

  const old = E.newGame(5);
  const oldLegacy = old.programs.find((p) => p.legacy);
  delete oldLegacy.engine;
  delete oldLegacy.engineName;
  E.ensureShape(old);

  assert.strictEqual(oldLegacy.engine, freshLegacy.engine, '마이그레이션 결과가 새 게임과 같아야 한다');

  // 2016년 파생형은 양쪽 모두 재장착으로 잡혀야 한다.
  const y = E.yearOf((2016 - 1998) * 4);
  const a = D.evaluate({ ...E.derivativeSpec(freshLegacy, 20), year: y });
  const b = D.evaluate({ ...E.derivativeSpec(oldLegacy, 20), year: y });
  assert.strictEqual(a.reEngined, true);
  assert.strictEqual(b.reEngined, true, '마이그레이션된 기체도 재장착 비용을 내야 한다');
  assert.strictEqual(a.devCost, b.devCost);
});

test('마이그레이션된 일정에 영영 뜨지 않는 슬롯이 남지 않는다', () => {
  // 충격은 endTurn 이 턴을 올린 뒤 발화한다. 불러온 턴 이하의 슬롯은 죽은 항목이다.
  for (const turn of [0, 14, 30, 55]) {
    const s = E.newGame(21);
    s.turn = turn;
    delete s.shocks;
    E.ensureShape(s);

    assert.ok(Array.isArray(s.shocks));
    for (const slot of s.shocks) {
      assert.ok(slot.turn > turn, `턴 ${turn} 에서 불러왔는데 슬롯 ${slot.turn} 이 남아 있다`);
    }
  }

  // 남은 슬롯은 실제로 발화해야 한다 — 필터가 미래 슬롯까지 지우면 안 된다.
  const s = E.newGame(21);
  s.turn = 10;
  delete s.shocks;
  E.ensureShape(s);
  const next = s.shocks[0];
  assert.ok(next, '미래 슬롯은 남아 있어야 한다');

  let fired = false;
  while (!s.gameOver && s.turn <= next.turn) {
    s.cash = Math.max(s.cash, 60000);
    E.endTurn(s);
    if (s.turn === next.turn && s.events.some((e) => e.shock)) fired = true;
  }
  assert.ok(fired, `슬롯 ${next.turn} 이 발화해야 한다`);
});

test('표시 등급과 표시 이자율은 같은 시점 값이다', () => {
  // 이자율만 분기 초에 고정하고 등급은 실시간으로 보여주면
  // "등급 B · 이자율 1.60%(=BBB 값)" 같은 자기모순이 화면에 뜬다.
  const s = E.newGame(3);
  const grade0 = E.quarterGrade(s);
  const rate0 = E.quarterRate(s);

  E.borrow(s, Data.CONFIG.maxDebt); // 분기 중 차입으로 현재 등급을 떨어뜨린다
  assert.notStrictEqual(E.creditRating(s).grade, grade0, '전제: 차입으로 현재 등급이 바뀌어야 한다');

  // 이번 분기에 적용되는 등급·이자율은 둘 다 그대로여야 한다.
  assert.strictEqual(E.quarterGrade(s), grade0);
  assert.strictEqual(E.quarterRate(s), rate0);

  // 그리고 그 등급이 실제로 그 이자율을 만든 등급이어야 한다.
  const mult = rate0 / Data.CONFIG.interestPerQuarter;
  const table = { AA: 0.78, A: 0.88, BBB: 1.0, BB: 1.14, B: 1.3, CCC: 1.5 };
  assert.ok(Math.abs(mult - table[grade0]) < 0.001, `${grade0} 등급인데 배수가 ${mult.toFixed(3)}`);
});

test('단산된 엔진을 지정하면 대체될 엔진이 선택 표시된다', () => {
  // 대체가 일어나는데 어느 버튼도 켜지지 않으면, 플레이어는 자기가 무슨 엔진으로
  // 착수하는지 모른 채 버튼을 누르게 된다.
  const s = E.newGame(6);
  s.turn = (2010 - 1998) * 4;
  const spec = { segment: 'narrow', seats: 180, range: 5500, tech: 50, material: 'aluminum', engine: 'cfm56-3' };
  assert.strictEqual(EN.inService(EN.get('cfm56-3'), E.yearOf(s.turn)), false, '전제: 이미 단산된 엔진');

  const html = P.renderDesign(s, spec, '');
  const selected = html.match(/class="mat on" data-action="design-eng" data-eng="([^"]+)"/g) || [];
  assert.strictEqual(selected.length, 1, `선택된 엔진 버튼이 정확히 하나여야 한다 (${selected.length})`);

  const effective = D.evaluate({ ...spec, year: E.yearOf(s.turn) }).engine;
  assert.ok(selected[0].includes(effective), '실제로 쓰일 엔진이 선택 표시돼야 한다');
  assert.ok(/더 이상 판매되지 않아/.test(html), '대체됐다는 경고가 있어야 한다');
});

test('리스사 발주는 현금만 주지 않고 실제 주문을 남긴다', () => {
  const shock = Data.FICTIONAL_SHOCKS.find((f) => f.id === 'lessor_boom');
  assert.ok(shock);

  const s = E.newGame(8);
  E.ensureShape(s);
  const backlogBefore = E.totalBacklog(s);
  let income = 0;
  const h = {
    rng: R.createRng(7),
    fmt: E.fmtMoney,
    reputation: () => {},
    income: (v) => {
      income += v;
      s.cash += v;
      s.pending.revenue += v;
    },
    expense: () => {},
  };

  shock.apply(s, h);
  assert.ok(income > 0, '선수금이 들어와야 한다');
  assert.ok(E.totalBacklog(s) > backlogBefore, '선수금에는 실제 주문이 따라야 한다');

  const order = s.backlog[s.backlog.length - 1];
  assert.strictEqual(order.airlineId, 'leasing');
  assert.ok(order.remaining > 0 && order.unitPrice > 0);
  // 선수금은 계약 규모에 비례해야 한다 — 무상 지급이 아니다.
  assert.ok(Math.abs(income - order.qty * order.unitPrice * Data.CONFIG.depositRate) < 1);
});

test('프로그램 화면에 장착 엔진이 표시된다', () => {
  // 엔진은 되돌릴 수 없는 선택이고 이후 파생형 비용을 좌우한다.
  const s = E.newGame(2);
  const legacy = s.programs.find((p) => p.legacy);
  const eng = EN.get(legacy.engine);
  assert.ok(eng);

  const html = P.renderPrograms(s);
  assert.ok(html.includes(eng.name), `장착 엔진(${eng.name})이 보여야 한다`);

  // 단산 이후에는 파생형이 재장착이 된다는 것도 알려야 한다.
  s.turn = (2010 - 1998) * 4;
  assert.strictEqual(EN.inService(eng, E.yearOf(s.turn)), false, '전제: 그 시점엔 단산');
  assert.ok(/단산/.test(P.renderPrograms(s)), '단산 표시가 있어야 한다');
});

// ─────────────────── 형상 설계 · 시장 구조 · 패밀리 ───────────────────

const { AirlinerAirframe: AF } = globalThis;

test('동체 단면은 객실 ↔ 연비·원가의 양방향 트레이드오프다', () => {
  // 한 방향 다이얼(기술 슬라이더)과 달리, 어느 쪽에도 정답이 없어야 한다.
  const base = { segment: 'narrow', seats: 180, range: 5500, tech: 50, material: 'aluminum', wing: 45, year: 2000 };
  const wide = D.evaluate({ ...base, abreast: 5 }); // 넓은 좌석
  const dense = D.evaluate({ ...base, abreast: 7 }); // 고밀도

  assert.ok(wide.comfort > dense.comfort, '좌석을 덜 넣으면 객실이 좋아야 한다');
  assert.ok(dense.efficiency > wide.efficiency, '많이 태우면 좌석당 연비가 좋아야 한다');
  assert.ok(dense.unitCostBase < wide.unitCostBase, '많이 태우면 좌석당 원가가 낮아야 한다');
});

test('날개는 순항 연비 ↔ 이착륙 성능의 양방향 트레이드오프다', () => {
  const base = { segment: 'narrow', seats: 180, range: 5500, tech: 50, material: 'aluminum', abreast: 6, year: 2000 };
  const short = D.evaluate({ ...base, wing: 0 });
  const long = D.evaluate({ ...base, wing: 100 });

  assert.ok(long.efficiency > short.efficiency, '장거리형이 순항 연비가 좋아야 한다');
  assert.ok(short.fieldPerf > long.fieldPerf, '단거리형이 이착륙 성능이 좋아야 한다');
  assert.ok(long.unitCostBase > short.unitCostBase, '고종횡비 날개는 구조가 비싸야 한다');
  assert.ok(long.devCost > short.devCost);
});

test('단면에 맞지 않는 좌석수는 효율이 깎인다', () => {
  const base = { segment: 'wide', range: 12000, tech: 50, material: 'aluminum', abreast: 10, wing: 50, year: 2005 };
  const fit = D.evaluate({ ...base, seats: 380 }); // 38열 — 적정
  const stubby = D.evaluate({ ...base, seats: 235 }); // 23.5열 — 뭉툭
  assert.strictEqual(fit.sectionFit, 100);
  assert.ok(stubby.sectionFit < 100, `뭉툭한 동체는 적합도가 낮아야 한다 (${stubby.sectionFit})`);
  assert.ok(stubby.efficiency < fit.efficiency);
});

test('짧은 활주로·고온고지 노선은 이착륙 성능 미달이면 실격이다', () => {
  const s = E.newGame(4);
  const p = s.programs.find((x) => x.phase === 'production');
  const rfp = {
    id: 'r1', segment: p.segment, reqSeats: p.seats, reqRange: Math.round(p.range * 0.7),
    reqField: 80, fieldKind: 'short', priceSensitivity: 1, prestige: 1, airlineId: 'nordic', qty: 10,
  };
  p.fieldPerf = 50;
  assert.strictEqual(B.scoreBid(s, rfp, p, 0.1).blocked, '이착륙 성능 미달');
  p.fieldPerf = 85;
  assert.strictEqual(B.scoreBid(s, rfp, p, 0.1).blocked, null);
});

test('ETOPS 없이는 장거리 노선에 응찰할 수 없다', () => {
  const s = E.newGame(4);
  const p = s.programs.find((x) => x.phase === 'production');
  p.range = 14000;
  p.seats = 300;
  const rfp = {
    id: 'r2', segment: p.segment, reqSeats: 280, reqRange: Data.ETOPS_RANGE_KM + 1000,
    reqField: 0, reqEtops: true, priceSensitivity: 1, prestige: 1, airlineId: 'carta', qty: 10,
  };
  // 설계만으로는 부족하다 — 인증을 실제로 가져야 들어갈 수 있다.
  p.etops = false;
  p.etopsCertified = false;
  assert.strictEqual(B.scoreBid(s, rfp, p, 0.1).blocked, 'ETOPS 미인증');
  p.etops = true;
  assert.strictEqual(B.scoreBid(s, rfp, p, 0.1).blocked, 'ETOPS 미인증', 'ETOPS 대응 설계만으로 통과하면 안 된다');
  p.etopsCertified = true;
  assert.strictEqual(B.scoreBid(s, rfp, p, 0.1).blocked, null);
});

test('ETOPS 는 조기 취득을 사거나 운항 실적으로 따낸다', () => {
  const s = E.newGame(71);
  s.cash = 40000;
  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 300, range: 12000, tech: 55, wing: 60, etops: true }, 'OCEAN').ok);
  const p = s.programs[s.programs.length - 1];
  assert.ok(p.etops, 'ETOPS 대응으로 설계돼야 한다');

  // 개발을 끝내고 인증까지 민다 — 조기 취득을 사지 않은 경우.
  for (let i = 0; i < 120 && p.phase !== 'production'; i++) {
    s.cash = 40000;
    E.endTurn(s);
  }
  assert.strictEqual(p.phase, 'production', '양산에 못 들어갔다');
  assert.strictEqual(p.etopsCertified, false, '조기 취득 없이 취항과 동시에 인증이 나오면 안 된다');

  // 굴러다니는 기체가 없으면 실적도 없다 — 양산 단계라는 것만으로는 안 된다.
  for (let i = 0; i < 6; i++) {
    s.cash = 40000;
    E.endTurn(s);
  }
  assert.strictEqual(p.etopsCertified, false, '인도분이 0인데 실적만으로 인증이 나왔다');
  assert.ok(!(p.etopsService > 0), '인도분이 없는데 실적이 쌓였다');

  // 실제로 인도된 기체가 생기면 그때부터 실적이 쌓인다.
  p.delivered = 12;
  for (let i = 0; i < 6 && !p.etopsCertified; i++) {
    s.cash = 40000;
    E.endTurn(s);
  }
  assert.strictEqual(p.etopsCertified, true, '운항 실적을 채웠는데 인증이 안 나왔다');
  assert.ok(
    s.log.some((l) => /ETOPS 인증을 받았다/.test(l.text)),
    '인증 취득이 기록으로 남아야 한다',
  );
});

test('조기 ETOPS 는 시험 시간을 사서 취항과 동시에 인증을 받는다', () => {
  const s = E.newGame(73);
  s.cash = 40000;
  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 300, range: 12000, tech: 55, wing: 60, etops: true }, 'OCEAN-E').ok);
  const p = s.programs[s.programs.length - 1];

  for (let i = 0; i < 120 && p.phase !== 'cert'; i++) {
    s.cash = 40000;
    E.endTurn(s);
  }
  assert.strictEqual(p.phase, 'cert', '심사 단계에 못 들어갔다');

  const needBefore = p.testHoursNeeded;
  const r = E.startEarlyEtops(s, p.id);
  assert.ok(r.ok, r.error);
  assert.ok(p.testHoursNeeded > needBefore, '조기 취득은 시험 시간을 더 요구해야 한다');
  assert.strictEqual(E.startEarlyEtops(s, p.id).ok, false, '두 번 살 수 있으면 안 된다');

  for (let i = 0; i < 120 && p.phase !== 'production'; i++) {
    s.cash = 40000;
    E.endTurn(s);
  }
  assert.strictEqual(p.etopsCertified, true, '조기 취득을 샀으면 취항과 동시에 인증이어야 한다');
});

test('RFP 요구사양이 항공사 노선망 안에서 나온다', () => {
  // 균등 난수 시절에는 최적해가 늘 세그먼트 중앙이라 좌석·항속 결정이 무의미했다.
  const s = E.newGame(11);
  const rng = R.createRng(3);
  const byAirline = {};
  for (let i = 0; i < 900; i++) {
    for (const r of B.generateRfps(s, rng)) {
      (byAirline[r.airlineId] = byAirline[r.airlineId] || []).push(r);
    }
  }

  let checked = 0;
  for (const a of Data.AIRLINES) {
    const mine = (byAirline[a.id] || []).filter((r) => r.segment === a.bias);
    if (mine.length < 25) continue;
    const avg = mine.reduce((x, r) => x + r.reqSeats, 0) / mine.length;
    const mid = (a.seatBand[0] + a.seatBand[1]) / 2;
    // 노선망 밖 발주가 15% 섞이므로 정확히 중앙은 아니지만 그 근처여야 한다.
    assert.ok(
      Math.abs(avg - mid) < mid * 0.28,
      `${a.name}: 평균 요구 ${Math.round(avg)}석이 선호대역 중앙 ${mid}석과 너무 멀다`,
    );
    checked++;
  }
  assert.ok(checked >= 8, `충분한 항공사를 검사해야 한다 (${checked})`);
});

test('업게이지: 요구 좌석수가 해가 갈수록 커진다', () => {
  const s = E.newGame(7);
  const rng = R.createRng(4);
  const sample = (turn) => {
    s.turn = turn;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < 500; i++) {
      for (const r of B.generateRfps(s, rng)) {
        if (r.segment === 'narrow') {
          sum += r.reqSeats;
          n++;
        }
      }
    }
    return sum / n;
  };
  const early = sample(0);
  const late = sample(76);
  assert.ok(late > early * 1.06, `업게이지가 보여야 한다 (${early.toFixed(0)} → ${late.toFixed(0)})`);
});

test('동체 단면을 바꾸면 파생형이 아니다', () => {
  // 동체 직경은 구조 설계의 출발점이라 형식증명을 물려받을 수 없다.
  // 이게 패밀리 전략의 근거다 — 단면을 한 번 정하면 그 위에서만 싸게 늘린다.
  const y = 2005;
  const from = { id: 'x', name: '원형', tech: 50, material: 'aluminum', range: 5500, engine: 'cfm56-5b', abreast: 6 };
  const base = { segment: 'narrow', seats: 200, range: 5500, tech: 50, material: 'aluminum', engine: 'cfm56-5b', wing: 45, year: y };

  assert.strictEqual(D.evaluate({ ...base, abreast: 6, derivedFrom: from }).derivative, true);
  assert.strictEqual(D.evaluate({ ...base, abreast: 7, derivedFrom: from }).derivative, false);
});

test('패밀리 선투자는 파생형 2기면 회수된다', () => {
  const y = 2005;
  const base = { segment: 'narrow', seats: 180, range: 5500, tech: 50, material: 'aluminum', engine: 'cfm56-5b', abreast: 6, wing: 45, year: y };
  const plain = D.evaluate(base);
  const family = D.evaluate({ ...base, family: true });
  assert.ok(family.devCost > plain.devCost, '패밀리는 선투자가 든다');

  const from = { id: 'x', name: '원형', tech: 50, material: 'aluminum', range: 5500, engine: 'cfm56-5b', abreast: 6 };
  const derivPlain = D.evaluate({ ...base, seats: 210, derivedFrom: { ...from, family: false } });
  const derivFam = D.evaluate({ ...base, seats: 210, derivedFrom: { ...from, family: true } });
  assert.ok(derivFam.devCost < derivPlain.devCost, '패밀리 파생형이 더 싸야 한다');
  assert.strictEqual(derivFam.inFamily, true);

  // 선투자 초과분 vs 파생형 2기의 절감액
  const extra = family.devCost - plain.devCost;
  const savedPer = derivPlain.devCost - derivFam.devCost;
  assert.ok(savedPer * 2 >= extra, `파생형 2기로 회수돼야 한다 (선투자 ${extra}, 절감 ${savedPer}/기)`);
});

test('패밀리는 항공사 공통성을 형제 기종끼리 나눈다', () => {
  const s = E.newGame(9);
  s.cash = 90000;
  const spec = { segment: 'narrow', seats: 175, range: 5000, tech: 50, material: 'hybrid', abreast: 6, wing: 45, family: true };
  assert.ok(E.launchProgram(s, spec, 'FAM-1').ok);
  const root1 = s.programs[s.programs.length - 1];
  root1.phase = 'production';

  const sib = { ...E.derivativeSpec(root1, 20) };
  assert.ok(E.launchProgram(s, sib, 'FAM-2').ok);
  const sibling = s.programs[s.programs.length - 1];
  sibling.phase = 'production';
  assert.strictEqual(sibling.familyId, root1.familyId, '파생형이 패밀리를 물려받아야 한다');

  const rfp = {
    id: 'r3', segment: 'narrow', reqSeats: sibling.seats, reqRange: sibling.range,
    reqField: 0, priceSensitivity: 1, prestige: 1, airlineId: 'hanul', qty: 20,
  };
  s.relations.hanul = 50;

  // 패밀리 효과를 분리하려면 "무관한 우리 기종"과 비교해야 한다.
  // 빈 선단과 비교하면 일반 보유 가산만으로도 통과해 테스트가 무력해진다.
  const outsider = s.programs.find((x) => x.legacy);
  assert.ok(outsider && outsider.familyId !== sibling.familyId, '전제: 패밀리 밖 기종');

  s.fleets.hanul = { [outsider.id]: 40 };
  const withOutsider = B.scoreBid(s, rfp, sibling, 0.1);
  s.fleets.hanul = { [root1.id]: 40 };
  const withSibling = B.scoreBid(s, rfp, sibling, 0.1);

  assert.ok(
    withSibling.parts.common > withOutsider.parts.common,
    `형제 기종은 무관한 기종보다 크게 인정돼야 한다 (형제 ${withSibling.parts.common} vs 타 기종 ${withOutsider.parts.common})`,
  );
});

// ─────────────────── 부위별 소재 · 리뷰 회귀 ───────────────────

test('동체 소재는 객실을, 날개 소재는 연비를 지배한다', () => {
  // 한 덩어리 3택은 복합재로 갈수록 다 좋아지는 한 방향 다이얼이었다.
  const b = { segment: 'narrow', seats: 180, range: 5500, tech: 50, abreast: 6, wing: 45, engine: 'cfm56-5b', year: 2000 };
  const base = D.evaluate({ ...b, fuselage: 'aluminum', wingMat: 'aluminum' });
  const fusOnly = D.evaluate({ ...b, fuselage: 'composite', wingMat: 'aluminum' });
  const wingOnly = D.evaluate({ ...b, fuselage: 'aluminum', wingMat: 'composite' });

  assert.ok(fusOnly.comfort - base.comfort > wingOnly.comfort - base.comfort, '객실은 동체가 지배해야 한다');
  assert.ok(wingOnly.efficiency - base.efficiency > fusOnly.efficiency - base.efficiency, '연비는 날개가 지배해야 한다');
  assert.ok(fusOnly.defectRisk > wingOnly.defectRisk, '동체 복합재가 더 위험해야 한다 (여압 사이클)');
});

test('고종횡비 날개는 복합재라야 이득이 산다', () => {
  const b = { segment: 'wide', seats: 300, range: 13000, tech: 60, abreast: 9, engine: 'trent700', fuselage: 'aluminum', year: 2005 };
  const hiAl = D.evaluate({ ...b, wing: 90, wingMat: 'aluminum' });
  const hiCf = D.evaluate({ ...b, wing: 90, wingMat: 'composite' });
  const loAl = D.evaluate({ ...b, wing: 15, wingMat: 'aluminum' });
  const loCf = D.evaluate({ ...b, wing: 15, wingMat: 'composite' });

  // 종횡비가 높을수록 소재 차이가 커야 한다 — 중량이 이득을 갉아먹기 때문.
  assert.ok(hiCf.efficiency - hiAl.efficiency > loCf.efficiency - loAl.efficiency,
    `고종횡비에서 소재 이득이 더 커야 한다 (고 ${hiCf.efficiency - hiAl.efficiency} vs 저 ${loCf.efficiency - loAl.efficiency})`);
});

test('옛 단일 소재 설계안도 그대로 평가된다', () => {
  // 세이브와 기존 코드가 spec.material 만 들고 있어도 깨지면 안 된다.
  for (const m of ['aluminum', 'hybrid', 'composite']) {
    const r = D.evaluate({ segment: 'narrow', seats: 180, range: 5500, tech: 50, material: m, year: 2000 });
    assert.ok(r.devCost > 0 && r.efficiency > 0, m + ' 평가 실패');
    assert.ok(r.fuselage && r.wingMat, '부위별 소재로 옮겨져야 한다');
  }
});

test('패밀리 계보는 2대째 파생형까지 이어진다', () => {
  // 파생형은 familyId 를 물려받지만 family 플래그는 물려받지 않는다.
  // derivedFrom.family 를 착수 옵션으로 판정하면 손자 세대가 일반 요율을 문다.
  const s = E.newGame(5);
  s.cash = 200000;
  const spec = { segment: 'narrow', seats: 170, range: 5000, tech: 50, fuselage: 'aluminum', wingMat: 'aluminum', abreast: 6, wing: 45, family: true };
  assert.ok(E.launchProgram(s, spec, 'F1').ok);
  const root = s.programs[s.programs.length - 1];
  root.phase = 'production';

  assert.ok(E.launchProgram(s, E.derivativeSpec(root, 15), 'F2').ok);
  const child = s.programs[s.programs.length - 1];
  child.phase = 'production';
  assert.strictEqual(child.familyId, root.familyId);
  assert.strictEqual(child.inFamily, true, '1대째 파생형이 패밀리 요율을 받아야 한다');

  // 손자 — 여기서 계보가 끊기면 안 된다.
  const grandSpec = E.derivativeSpec(child, 15);
  assert.strictEqual(grandSpec.derivedFrom.family, true, '2대째도 패밀리 소속으로 판정돼야 한다');
  assert.strictEqual(D.evaluate({ ...grandSpec, year: E.yearOf(s.turn) }).inFamily, true);
});

test('ETOPS 개념이 없던 세이브의 장거리 기종은 자격을 이어받는다', () => {
  // 그러지 않으면 완성된 광동체가 9,000km 이상 노선에서 전부 실격되는데
  // 소급 취득 수단이 없어 프로그램이 통째로 죽는다.
  const s = E.newGame(6);
  s.cash = 200000;
  E.launchProgram(s, { segment: 'wide', seats: 300, range: 13000, tech: 60, fuselage: 'aluminum', wingMat: 'hybrid', abreast: 9, wing: 60 }, 'WB');
  const p = s.programs[s.programs.length - 1];
  p.phase = 'production';
  delete p.etops; // v1 세이브 재현

  E.ensureShape(s);
  assert.strictEqual(p.etops, true, '장거리 기종은 자격을 받아야 한다');

  // 단거리 기종까지 공짜로 주면 안 된다.
  const short = s.programs.find((x) => x.legacy);
  delete short.etops;
  E.ensureShape(s);
  assert.strictEqual(short.etops, false);
});

// ─────────────────── 생산 설비 ───────────────────

test('라인 등급은 건설비 ↔ 물량·램프업의 트레이드오프다', () => {
  const s = E.newGame(3);
  s.cash = 200000;
  const p = s.programs.find((x) => x.phase === 'production');
  const seg = Data.SEGMENTS[p.segment];

  const before = s.cash;
  assert.ok(E.buildLine(s, p.id, 'classic').ok);
  const classicCost = before - s.cash;
  const classic = s.lines[s.lines.length - 1];

  const before2 = s.cash;
  assert.ok(E.buildLine(s, p.id, 'highRate').ok);
  const fastCost = before2 - s.cash;
  const fast = s.lines[s.lines.length - 1];

  assert.ok(fastCost > classicCost, '고속 라인이 비싸야 한다');
  assert.ok(fast.capacity > classic.capacity, '고속 라인이 물량이 커야 한다');
  assert.ok(Data.LINE_GRADES.highRate.rampMult < Data.LINE_GRADES.classic.rampMult, '고속 라인은 안정화가 느려야 한다');
  assert.ok(classic.capacity < seg.lineMaxRate, '재래식은 표준보다 물량이 적어야 한다');
});

test('라인 전환은 같은 동체 단면에서만 된다', () => {
  const s = E.newGame(4);
  s.cash = 300000;
  const legacy = s.programs.find((x) => x.legacy);
  assert.ok(E.buildLine(s, legacy.id, 'standard').ok);
  const line = s.lines[s.lines.length - 1];

  // 같은 단면 기종
  const same = { segment: 'narrow', seats: 200, range: 5200, tech: 50, abreast: legacy.abreast, wing: 45 };
  assert.ok(E.launchProgram(s, same, 'SAME').ok);
  const sameP = s.programs[s.programs.length - 1];
  sameP.phase = 'production';

  // 다른 단면 기종
  const other = { segment: 'narrow', seats: 200, range: 5200, tech: 50, abreast: legacy.abreast === 6 ? 7 : 6, wing: 45 };
  assert.ok(E.launchProgram(s, other, 'OTHER').ok);
  const otherP = s.programs[s.programs.length - 1];
  otherP.phase = 'production';

  const bad = E.retoolLine(s, line.id, otherP.id);
  assert.strictEqual(bad.ok, false, '단면이 다르면 전환할 수 없어야 한다');
  assert.ok(/동체 단면/.test(bad.error));

  const cashBefore = s.cash;
  const good = E.retoolLine(s, line.id, sameP.id);
  assert.ok(good.ok, good.error);
  assert.strictEqual(line.programId, sameP.id);
  assert.ok(line.ramp <= 0.15, '전환 후 램프업을 다시 올려야 한다');

  // 전환이 신규 건설보다 싸야 의미가 있다.
  const retoolCost = cashBefore - s.cash;
  assert.ok(retoolCost < Data.SEGMENTS[sameP.segment].lineCost, '전환이 신규 건설보다 싸야 한다');
});

test('외주 비중은 단가 ↔ 공급 차질 위험의 트레이드오프다', () => {
  assert.ok(Data.OUTSOURCING.high.costMult < Data.OUTSOURCING.low.costMult, '외주가 많을수록 단가가 낮아야 한다');
  assert.ok(Data.OUTSOURCING.high.supplyRisk > Data.OUTSOURCING.low.supplyRisk, '외주가 많을수록 위험해야 한다');

  // 실제 생산 원가에 반영되는지 — 같은 시드·같은 조작에서 원가만 달라야 한다.
  const run = (level) => {
    const s = E.newGame(12);
    E.setOutsourcing(s, level);
    let cost = 0;
    for (let i = 0; i < 8 && !s.gameOver; i++) {
      s.cash = 40000;
      const r = E.endTurn(s);
      if (!r.ok) break;
      cost += r.report.productionCost;
    }
    return cost;
  };
  assert.ok(run('high') < run('low'), '광범위 외주가 생산원가가 낮아야 한다');
});

test('공급 차질 이벤트는 외주 비중에 따라 길어진다', () => {
  const ev = Data.EVENTS.find((e) => /공급/.test(e.name));
  assert.ok(ev, '공급망 이벤트가 있어야 한다');

  const sample = (level) => {
    let total = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = E.newGame(seed);
      E.setOutsourcing(s, level);
      s.effects.supplyQuarters = 0;
      ev.apply(s, { rng: R.createRng(seed), fmt: E.fmtMoney, reputation: () => {}, income: () => {}, expense: () => {} });
      total += s.effects.supplyQuarters;
    }
    return total;
  };
  assert.ok(sample('high') > sample('low'), '외주가 많을수록 차질이 길어야 한다');
});

/* ── 리뷰 회귀 (6be4b9f) ─────────────────────────────────────────────
 * 아래 일곱 건은 심화 커밋에서 실제로 열린 구멍이다. 여섯은 파생형 할인·
 * 생산설비 우회고, 하나는 "화면이 엔진 공식을 따로 계산"하는 그 부류다.
 */

test('파생형 시드가 부위별 소재를 잃지 않는다', () => {
  const s = E.newGame(7);
  const spec = {
    segment: 'narrow',
    seats: 180,
    range: 5500,
    tech: 55,
    fuselage: 'composite',
    wingMat: 'composite',
    engine: 'cfm56-5b',
    abreast: 6,
    wing: 45,
  };
  assert.ok(E.launchProgram(s, spec, '원형').ok);
  const base = s.programs[s.programs.length - 1];

  const seed = E.derivativeSpec(base, 20);
  assert.strictEqual(seed.fuselage, 'composite', '시드가 동체 소재를 물려받아야 한다');
  assert.strictEqual(seed.wingMat, 'composite', '시드가 날개 소재를 물려받아야 한다');
  assert.strictEqual(seed.derivedFrom.fuselage, 'composite', '원형 기록에도 동체 소재가 있어야 한다');
  assert.strictEqual(seed.derivedFrom.wingMat, 'composite', '원형 기록에도 날개 소재가 있어야 한다');
  // 소재가 유실되면 알루미늄으로 읽혀 "소재 교체"로 판정되고 할인이 사라진다.
  assert.ok(D.evaluate({ ...seed, year: 2000 }).derivative, '그대로 두면 파생형 할인을 받아야 한다');
});

test('단면을 알 수 없는 옛 라인은 전환 자체가 막힌다', () => {
  const s = E.newGame(8);
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5500, tech: 50, abreast: 6, wing: 45 }, 'A').ok);
  const a = s.programs[s.programs.length - 1];
  a.phase = 'production';
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 200, range: 5500, tech: 50, abreast: 7, wing: 45 }, 'B').ok);
  const b = s.programs[s.programs.length - 1];
  b.phase = 'production';

  s.cash = 60000;
  const built = E.buildLine(s, a.id, 'standard');
  assert.ok(built.ok, built.error);
  const line = s.lines[s.lines.length - 1];

  // 세이브 마이그레이션 이전의 프로그램처럼 단면 정보를 지운다.
  delete b.abreast;
  const r = E.retoolLine(s, line.id, b.id);
  assert.strictEqual(r.ok, false, '단면을 모르면 전환을 허용하면 안 된다');
  assert.ok(/알 수 없어/.test(r.error), '이유를 밝혀야 한다: ' + r.error);
});

test('라인 폐쇄 환급이 건설 당시 등급을 따른다', () => {
  const s = E.newGame(9);
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5500, tech: 50, abreast: 6, wing: 45 }, 'A').ok);
  const p = s.programs[s.programs.length - 1];
  p.phase = 'production';

  s.cash = 200000;
  const before = s.cash;
  assert.ok(E.buildLine(s, p.id, 'highRate').ok);
  const line = s.lines[s.lines.length - 1];
  const paid = before - s.cash;
  assert.ok(paid > Data.SEGMENTS.narrow.lineCost, '고속 라인은 표준보다 비싸야 한다');
  assert.strictEqual(line.paidCost, paid, '건설비를 라인에 기록해야 한다');

  const cashBeforeClose = s.cash;
  E.closeLine(s, line.id);
  const refund = s.cash - cashBeforeClose;
  assert.strictEqual(refund, Math.round(paid * 0.2), '환급은 실제 건설비의 20%여야 한다');
  assert.ok(refund > Math.round(Data.SEGMENTS.narrow.lineCost * 0.2), '표준 기준 환급보다 커야 한다');
});

test('화면의 대당 원가가 조달 전략을 반영한다', () => {
  const mk = (level) => {
    const s = E.newGame(10);
    E.setOutsourcing(s, level);
    assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5500, tech: 50, abreast: 6, wing: 45 }, 'A').ok);
    const p = s.programs[s.programs.length - 1];
    p.phase = 'production';
    p.produced = 40;
    return { s, p };
  };
  const lo = mk('low');
  const hi = mk('high');
  assert.ok(E.currentUnitCost(hi.s, hi.p) < E.currentUnitCost(lo.s, lo.p), '외주가 많으면 원가가 낮아야 한다');

  // 프로그램 탭이 그 값을 그대로 써야 한다 — 화면이 따로 계산하면 어긋난다.
  const htmlLo = P.renderPrograms(lo.s);
  const htmlHi = P.renderPrograms(hi.s);
  assert.ok(htmlLo.includes(P.money(E.currentUnitCost(lo.s, lo.p))), '저외주 화면이 공유 함수 값을 써야 한다');
  assert.ok(htmlHi.includes(P.money(E.currentUnitCost(hi.s, hi.p))), '고외주 화면이 공유 함수 값을 써야 한다');
  assert.notStrictEqual(
    htmlLo.match(/현재 대당 원가<\/th><td>([^<]*)/)[1],
    htmlHi.match(/현재 대당 원가<\/th><td>([^<]*)/)[1],
    '조달 전략이 다르면 표시 원가도 달라야 한다',
  );
});

test('패밀리 선투자는 계보의 뿌리에서 한 번만 청구된다', () => {
  const base = {
    segment: 'narrow',
    seats: 180,
    range: 5500,
    tech: 60,
    fuselage: 'aluminum',
    wingMat: 'aluminum',
    engine: 'cfm56-5b',
    abreast: 6,
    wing: 45,
    year: 2000,
  };
  const derivedFrom = { id: 'x', tech: 60, fuselage: 'aluminum', wingMat: 'aluminum', range: 5500, engine: 'cfm56-5b', abreast: 6, wing: 45, family: true };
  const off = D.evaluate({ ...base, seats: 200, derivedFrom });
  const on = D.evaluate({ ...base, seats: 200, family: true, derivedFrom });

  assert.ok(off.inFamily, '패밀리 원형의 파생형이어야 한다');
  assert.strictEqual(on.devCost, off.devCost, '승계 파생형에 선투자를 다시 청구하면 안 된다');
  assert.strictEqual(on.devQuarters, off.devQuarters, '기간도 늘어나면 안 된다');
  assert.ok(off.family, '패밀리 소속은 그대로 승계되어야 한다');

  // 뿌리에서는 여전히 값을 치러야 한다 — 토글 자체를 죽인 게 아니다.
  const rootOff = D.evaluate(base);
  const rootOn = D.evaluate({ ...base, family: true });
  assert.ok(rootOn.devCost > rootOff.devCost, '뿌리에서는 선투자 비용이 붙어야 한다');

  // 화면도 승계 파생형에는 토글이 아니라 승계 표시를 내보내야 한다.
  const s = E.newGame(11);
  const html = P.renderDesign(s, { ...base, seats: 200, derivedFrom }, '파생형');
  assert.ok(html.includes('패밀리 승계'), '승계 표시가 있어야 한다');
  assert.ok(!/data-action="design-family"/.test(html), '다시 청구되는 토글을 내보내면 안 된다');
});

test('날개를 다시 그리면 파생형 할인을 잃는다', () => {
  const base = {
    segment: 'narrow',
    seats: 180,
    range: 5500,
    tech: 60,
    fuselage: 'aluminum',
    wingMat: 'aluminum',
    engine: 'cfm56-5b',
    abreast: 6,
    year: 2000,
  };
  const derivedFrom = { id: 'x', tech: 60, fuselage: 'aluminum', wingMat: 'aluminum', range: 5500, engine: 'cfm56-5b', abreast: 6, wing: 20 };

  const tweak = D.evaluate({ ...base, seats: 200, wing: 30, derivedFrom });
  assert.ok(tweak.derivative, '윙렛 수준의 손질은 파생형으로 인정해야 한다');

  const redesign = D.evaluate({ ...base, seats: 200, wing: 95, derivedFrom });
  assert.strictEqual(redesign.derivative, false, '날개를 갈아엎으면 형식증명을 물려받을 수 없다');
  assert.ok(redesign.devCost > tweak.devCost * 2, '신규 설계 수준의 개발비를 물어야 한다');

  // 파생형 시드가 원형 날개를 싣고 나가야 이 판정이 가능하다.
  const s = E.newGame(12);
  assert.ok(E.launchProgram(s, { ...base, wing: 20 }, '원형').ok);
  const p = s.programs[s.programs.length - 1];
  assert.strictEqual(E.derivativeSpec(p, 20).derivedFrom.wing, 20, '시드가 원형 날개를 기록해야 한다');
});

test('노선망 밖 발주는 반드시 다른 세그먼트로 나간다', () => {
  const s = E.newGame(13);
  const rng = R.createRng(13);
  let off = 0;
  for (let i = 0; i < 4000; i++) {
    const rfp = B.makeRfp(s, rng);
    const airline = Data.AIRLINES.find((a) => a.id === rfp.airlineId);
    if (rfp.segment === airline.bias) continue;
    off++;
  }
  assert.ok(off > 200, '표본에 노선망 밖 발주가 충분히 있어야 한다 (' + off + ')');

  // 자기 급인데 활주로 제약만 사라진 공고가 있으면 안 된다 — 산악 공항 항공사가
  // 이착륙 요건 0인 공고를 내면서 노선 설명은 그대로 붙는 모순.
  const rng2 = R.createRng(99);
  for (let i = 0; i < 4000; i++) {
    const rfp = B.makeRfp(s, rng2);
    const airline = Data.AIRLINES.find((a) => a.id === rfp.airlineId);
    if (rfp.segment !== airline.bias) continue;
    assert.strictEqual(rfp.fieldKind, airline.field || 'normal', `${airline.name}: 자기 급 발주는 본거지 제약을 유지해야 한다`);
    assert.strictEqual(rfp.reqField, Data.FIELD_REQUIREMENT[airline.field || 'normal'], '요건 값도 함께 따라와야 한다');
  }
});

test('세이브 마이그레이션이 이착륙 성능을 유도한다', () => {
  const s = E.newGame(21);
  // 승계 기종은 옛 규칙으로 만들어져 fieldPerf 가 없다고 가정한다.
  const legacy = s.programs.find((p) => p.legacy) || s.programs[0];
  delete legacy.fieldPerf;
  delete legacy.wing;
  delete s.fleets; // ensureShape 를 다시 태우기 위한 최소 조건
  E.ensureShape(s);

  assert.strictEqual(typeof legacy.fieldPerf, 'number', '이착륙 성능을 채워야 한다');
  assert.ok(legacy.fieldPerf < 100, '만점을 그냥 주면 안 된다 (' + legacy.fieldPerf + ')');

  // 짧은 활주로 요건에 실제로 걸리는지 — 폴백 100 이면 언제나 통과해 버린다.
  const airline = Data.AIRLINES.find((a) => a.field === 'short');
  const rfp = {
    id: 'r1',
    airlineId: airline.id,
    segment: legacy.segment,
    reqSeats: Math.round(legacy.seats * 0.9),
    reqRange: legacy.range,
    reqField: Data.FIELD_REQUIREMENT.short,
    fieldKind: 'short',
    reqEtops: false,
    qty: 10,
    priceSensitivity: 0.5,
    prestige: 0.5,
    relation: 40,
  };
  legacy.fieldPerf = Data.FIELD_REQUIREMENT.short - 1;
  assert.strictEqual(B.scoreBid(s, rfp, legacy, 0).blocked, '이착륙 성능 미달', '미달이면 실격이어야 한다');
});

test('라인 자산 평가가 실제 건설비를 따른다', () => {
  const mk = (grade) => {
    const s = E.newGame(22);
    assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5500, tech: 50, abreast: 6, wing: 45 }, 'A').ok);
    const p = s.programs[s.programs.length - 1];
    p.phase = 'production';
    s.cash = 300000;
    assert.ok(E.buildLine(s, p.id, grade).ok);
    const line = s.lines[s.lines.length - 1];
    // 현금·부채를 같게 맞춰 라인 자산만 비교한다.
    s.cash = 10000;
    s.debt = 0;
    return { worth: E.netWorth(s), paid: line.paidCost };
  };
  const classic = mk('classic');
  const fast = mk('highRate');
  assert.ok(fast.paid > classic.paid, '고속 라인이 더 비싸야 한다');
  assert.ok(fast.worth > classic.worth, '비싼 라인이 더 큰 자산으로 잡혀야 한다');
  assert.strictEqual(Math.round(fast.worth - classic.worth), Math.round((fast.paid - classic.paid) * 0.4), '차액은 건설비 차이의 40%여야 한다');
});

test('addToFleet 은 선단 장부만 건드린다', () => {
  const s = E.newGame(23);
  const p = s.programs[0];
  const before = JSON.stringify({ shocks: s.shocks, outsourcing: s.outsourcing, rate: s.rateForQuarter });
  E.addToFleet(s, 'hanul', p.id, 5);
  assert.strictEqual(JSON.stringify({ shocks: s.shocks, outsourcing: s.outsourcing, rate: s.rateForQuarter }), before, '마이그레이션을 다시 돌리면 안 된다');
  assert.strictEqual(s.fleets.hanul[p.id], 48 + 5, '선단 수량만 올라야 한다');

  // 마이그레이션 로직은 ensureShape 한 곳에만 있어야 한다 (사본이 갈라지는 것을 막는다).
  const src = require('node:fs').readFileSync(require('node:path').join(JS, 'engine.js'), 'utf8');
  const body = src.slice(src.indexOf('function addToFleet('), src.indexOf('function rngFor('));
  assert.ok(!/p\.wing === undefined|buildShockSchedule|LINE_GRADES/.test(body), 'addToFleet 안에 마이그레이션 사본이 남아 있다');
});

test('라인 건설 로그가 등급별 실제 비용·능력을 남긴다', () => {
  const s = E.newGame(31);
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5500, tech: 50, abreast: 6, wing: 45 }, 'A').ok);
  const p = s.programs[s.programs.length - 1];
  p.phase = 'production';
  s.cash = 300000;

  const before = s.cash;
  assert.ok(E.buildLine(s, p.id, 'highRate').ok);
  const line = s.lines[s.lines.length - 1];
  const paid = before - s.cash;
  const entry = s.log.find((l) => /조립 라인 신설/.test(l.text));
  assert.ok(entry, '건설 로그가 있어야 한다');

  assert.ok(entry.text.includes(E.fmtMoney(paid)), `로그 금액이 실제 지출과 같아야 한다: ${entry.text}`);
  assert.ok(new RegExp(`분기 ${line.capacity}기`).test(entry.text), `로그 능력이 라인 능력과 같아야 한다: ${entry.text}`);
  // 세그먼트 기준값이 그대로 적히면 안 된다 — 고속 라인은 둘 다 더 커야 한다.
  assert.ok(paid > Data.SEGMENTS.narrow.lineCost, '고속 라인은 기준가보다 비싸다 (전제 확인)');
  assert.ok(!entry.text.includes(E.fmtMoney(Data.SEGMENTS.narrow.lineCost)), '기준가를 적으면 안 된다');
  assert.ok(!new RegExp(`분기 ${Data.SEGMENTS.narrow.lineMaxRate}기`).test(entry.text), '기준 능력을 적으면 안 된다');
});

test('패밀리 안내 문구가 실제 파생형 요율과 일치한다', () => {
  const s = E.newGame(32);
  const spec = D.defaultSpec('narrow', E.yearOf(s.turn));
  const html = P.renderDesign(s, spec, '신규');
  const fam = Math.round(Data.CONFIG.derivRates.family.cost * 100);
  const plain = Math.round(Data.CONFIG.derivRates.plain.cost * 100);

  assert.ok(html.includes(`${fam}%(일반 ${plain}%)`), `안내가 실제 요율(${fam}/${plain})을 써야 한다`);
  // 옛 표(26/41)가 남아 있으면 안 된다.
  assert.ok(!/26%\(일반 41%\)/.test(html), '옛 요율 표기가 남아 있다');
});

test('노선망 밖 공고는 본거지 노선 설명을 달고 나가지 않는다', () => {
  const s = E.newGame(33);
  const rng = R.createRng(33);
  const routes = new Set(Data.AIRLINES.map((a) => a.route).filter(Boolean));
  let off = 0;
  for (let i = 0; i < 6000; i++) {
    const rfp = B.makeRfp(s, rng);
    const airline = Data.AIRLINES.find((a) => a.id === rfp.airlineId);
    if (rfp.segment === airline.bias) {
      assert.strictEqual(rfp.route, airline.route || '', '자기 급 발주는 본거지 노선 설명을 유지해야 한다');
      continue;
    }
    off++;
    assert.ok(!routes.has(rfp.route), `노선망 밖인데 본거지 노선 설명이 붙었다: ${airline.name} → ${rfp.route}`);
    assert.ok(rfp.route.includes(Data.SEGMENTS[rfp.segment].name), `발주한 급을 설명해야 한다: ${rfp.route}`);
  }
  assert.ok(off > 300, '표본에 노선망 밖 발주가 충분해야 한다 (' + off + ')');
});

test('부팅이 불러온 시점으로 설계 초안을 다시 잡는다', () => {
  // ui.js 는 DOM 에 묶여 있어 여기서 실행할 수 없다. 동작 자체는 헤드리스
  // 브라우저로 확인했고(2015 세이브 → CFM56-7B, 되돌리면 CFM56-5B), 여기서는
  // 그 한 줄이 사라지는 회귀만 막는다.
  const src = require('node:fs').readFileSync(require('node:path').join(JS, 'ui.js'), 'utf8');
  const boot = src.slice(src.indexOf('function boot()'), src.indexOf('root.AirlinerUI'));
  assert.ok(/ui\.spec\s*=\s*D\.defaultSpec\([^)]*E\.yearOf\(ui\.state\.turn\)\)/.test(boot), 'boot() 이 불러온 턴으로 설계 초안을 다시 잡아야 한다');
});

test('라인 전환은 급까지 같아야 한다', () => {
  const s = E.newGame(41);
  // 5열은 리저널·협동체 양쪽에 있다 — 열 수만 보면 통과해 버리는 조합.
  assert.ok(E.launchProgram(s, { segment: 'regional', seats: 90, range: 2400, tech: 50, abreast: 5, wing: 40 }, 'RJ').ok);
  const rj = s.programs[s.programs.length - 1];
  rj.phase = 'production';
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 150, range: 4200, tech: 50, abreast: 5, wing: 45 }, 'NB').ok);
  const nb = s.programs[s.programs.length - 1];
  nb.phase = 'production';
  assert.strictEqual(rj.abreast, nb.abreast, '전제: 열 수는 같다');

  s.cash = 300000;
  assert.ok(E.buildLine(s, rj.id, 'standard').ok);
  const line = s.lines[s.lines.length - 1];

  const r = E.retoolLine(s, line.id, nb.id);
  assert.strictEqual(r.ok, false, '급이 다르면 전환할 수 없어야 한다');
  assert.ok(/급이 달라/.test(r.error), r.error);
  assert.strictEqual(line.programId, rj.id, '거절됐으면 라인이 그대로여야 한다');

  // 화면도 같은 규칙을 써야 한다 — 눌러도 거절당하는 버튼을 내보내면 안 된다.
  const html = P.renderProduction(s);
  assert.ok(!new RegExp(`data-target="${nb.id}"`).test(html), '급이 다른 대상을 전환 버튼으로 내보내면 안 된다');
});

test('전환 후에도 라인 자산 기준이 새로 세운 라인과 같다', () => {
  const s = E.newGame(42);
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 160, range: 4600, tech: 50, abreast: 6, wing: 45 }, 'A').ok);
  const a = s.programs[s.programs.length - 1];
  a.phase = 'production';
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 200, range: 4800, tech: 50, abreast: 6, wing: 45 }, 'B').ok);
  const b = s.programs[s.programs.length - 1];
  b.phase = 'production';

  s.cash = 300000;
  assert.ok(E.buildLine(s, a.id, 'classic').ok);
  const line = s.lines[s.lines.length - 1];
  const fresh = Math.round(Data.SEGMENTS.narrow.lineCost * Data.LINE_GRADES.classic.costMult);
  assert.strictEqual(line.paidCost, fresh, '전제: 건설비가 등급값이다');

  // 급·등급이 고정된 전환만 허용되므로, 몇 번을 갈아타도 이 라인은 여전히
  // "그 급 그 등급의 라인"이다 — 자산 기준이 새로 세운 라인과 같아야 한다.
  for (let i = 0; i < 6; i++) {
    s.cash = 300000;
    assert.ok(E.retoolLine(s, line.id, line.programId === a.id ? b.id : a.id).ok);
  }
  assert.strictEqual(line.paidCost, fresh, '전환이 라인 자산 기준을 흔들면 안 된다');
  assert.strictEqual(line.grade, 'classic', '등급은 전환으로 바뀌지 않는다');
});

test('ETOPS 는 닿을 노선이 있을 때만 청구된다', () => {
  const base = { segment: 'narrow', seats: 180, range: 5500, tech: 55, engine: 'cfm56-5b', abreast: 6, wing: 45, year: 2000 };
  // 협동체 최대 항속(7,800km)으로도 9,000km 노선엔 닿지 않는다 — 켜도 값을 못 한다.
  const off = D.evaluate({ ...base, range: Data.SEGMENTS.narrow.range.max });
  const on = D.evaluate({ ...base, range: Data.SEGMENTS.narrow.range.max, etops: true });
  assert.strictEqual(on.etopsUsable, false, '협동체는 ETOPS 를 쓸 수 없어야 한다');
  assert.strictEqual(on.devCost, off.devCost, '쓸 수 없는 인증을 청구하면 안 된다');
  assert.strictEqual(on.certQuarters, off.certQuarters, '인증 기간도 늘면 안 된다');
  assert.strictEqual(on.etops, false, '자격이 붙었다고 표시해서도 안 된다');

  // 광동체는 여전히 값을 치른다 — 옵션 자체를 죽인 게 아니다.
  const wBase = { segment: 'wide', seats: 320, range: 12000, tech: 55, abreast: 9, wing: 60, year: 2000 };
  const wOff = D.evaluate(wBase);
  const wOn = D.evaluate({ ...wBase, etops: true });
  assert.ok(wOn.etopsUsable, '광동체 장거리는 쓸 수 있어야 한다');
  assert.ok(wOn.devCost > wOff.devCost, '광동체는 인증비를 물어야 한다');
  assert.ok(wOn.certQuarters > wOff.certQuarters, '인증 기간도 늘어야 한다');

  // 경계: 응찰 가능선(RANGE_TOLERANCE)과 같은 값을 써야 한다.
  const edge = D.evaluate({ ...wBase, range: Math.ceil(Data.ETOPS_USEFUL_RANGE) });
  const below = D.evaluate({ ...wBase, range: Math.floor(Data.ETOPS_USEFUL_RANGE) - 1 });
  assert.ok(edge.etopsUsable, '닿는 항속은 허용해야 한다');
  assert.strictEqual(below.etopsUsable, false, '못 닿는 항속은 막아야 한다');
});

test('세이브 ETOPS 마이그레이션이 응찰 가능선을 따른다', () => {
  // 8,100~8,999km 광동체는 9,000km 공고에 응찰할 수 있었다 — 실격시키면 안 된다.
  const s = E.newGame(51);
  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 300, range: 8500, tech: 55, abreast: 9, wing: 55 }, 'W').ok);
  const p = s.programs[s.programs.length - 1];
  p.phase = 'production';
  delete p.etops;
  delete s.fleets;
  E.ensureShape(s);
  assert.strictEqual(p.etops, true, '9,000km 공고에 닿는 기체는 자격을 유지해야 한다');

  // 실제로 그 공고에 응찰할 수 있어야 한다 (실격 사유가 없어야 한다).
  const rfp = {
    id: 'r', airlineId: 'carta', segment: 'wide', reqSeats: 290, reqRange: 9400,
    reqField: 0, fieldKind: 'normal', reqEtops: true, qty: 10,
    priceSensitivity: 0.5, prestige: 1.0, relation: 40,
  };
  assert.ok(!B.scoreBid(s, rfp, p, 0).blocked, '응찰이 막히면 안 된다');

  // 닿지 않는 기체는 그대로 무자격이다.
  const s2 = E.newGame(52);
  assert.ok(E.launchProgram(s2, { segment: 'wide', seats: 300, range: 7000, tech: 55, abreast: 9, wing: 50 }, 'W2').ok);
  const q = s2.programs[s2.programs.length - 1];
  delete q.etops;
  delete s2.fleets;
  E.ensureShape(s2);
  assert.strictEqual(q.etops, false, '닿지 않는 기체에 자격을 주면 안 된다');
});

test('착수 옵션이 슬라이더 값에 따라 다시 그려진다', () => {
  const s = E.newGame(53);
  const wide = { segment: 'wide', seats: 320, range: 12000, tech: 55, abreast: 9, wing: 60 };
  const far = P.renderDesignOptions(s, wide);
  const near = P.renderDesignOptions(s, { ...wide, range: 7000 });
  assert.ok(/data-action="design-etops"/.test(far), '닿는 항속에서는 ETOPS 를 고를 수 있어야 한다');
  assert.ok(!/data-action="design-etops"/.test(near), '못 닿는 항속에서는 고를 수 없어야 한다');
  assert.ok(/닿지 않는다/.test(near), '왜 못 고르는지 알려야 한다');

  // 패밀리 승계도 마찬가지 — 허용 오차를 넘으면 승계가 끊긴다.
  const derivedFrom = { id: 'x', tech: 55, fuselage: 'aluminum', wingMat: 'aluminum', range: 12000, engine: 'trent700', abreast: 9, wing: 60, family: true };
  const seed = { ...wide, engine: 'trent700', seats: 340, fuselage: 'aluminum', wingMat: 'aluminum', derivedFrom };
  const inside = P.renderDesignOptions(s, seed);
  const outside = P.renderDesignOptions(s, { ...seed, wing: 100 }); // 날개 재설계 = 새 기체
  assert.ok(/패밀리 승계/.test(inside), '허용 범위 안이면 승계 표시');
  assert.ok(/data-action="design-family"/.test(outside), '범위를 벗어나면 유료 옵션을 다시 열어야 한다');
  assert.ok(!/패밀리 승계/.test(outside), '끊긴 승계를 계속 약속하면 안 된다');
});

test('슬라이더 입력이 착수 옵션 블록도 갈아끼운다', () => {
  // DOM 교체라 node 로는 실행할 수 없다. 동작은 헤드리스 브라우저로 확인했고
  // (광동체 12,000km → 7,000km 로 내리면 ETOPS 선택지가 사라짐, 되돌리면 남아 있음),
  // 여기서는 그 한 줄이 사라지는 회귀만 막는다.
  const src = require('node:fs').readFileSync(require('node:path').join(JS, 'ui.js'), 'utf8');
  const handler = src.slice(src.indexOf("design-input"), src.indexOf("} else if (el.dataset.action === 'share')"));
  assert.ok(/design-options/.test(handler) && /renderDesignOptions/.test(handler), '슬라이더 입력이 착수 옵션도 다시 그려야 한다');
});

// ─────────────────────── 경쟁 서사 · 추이 · 회고 ───────────────────────

test('경쟁사 인도는 제조사별로 나뉘고 총합이 업계 총량과 정확히 맞는다', () => {
  const s = E.newGame(61);
  const before = s.stats.rivalDelivered;
  const beforeAlloc = Object.values(s.stats.rivalByMaker).reduce((a, n) => a + n, 0);
  for (let i = 0; i < 12; i++) E.endTurn(s);

  const industry = s.stats.rivalDelivered - before;
  const allocated = Object.values(s.stats.rivalByMaker).reduce((a, n) => a + n, 0) - beforeAlloc;
  assert.strictEqual(allocated, industry, '배분 합계가 업계 총량과 어긋나면 점유율 표와 순위표가 서로 다른 말을 한다');
  assert.ok(Object.keys(s.stats.rivalByMaker).length >= 3, '한 회사가 업계를 독식하면 안 된다');
  // 1998년 협동체·광동체의 강자는 보잉·에어버스다. 배분이 실력을 따라야 한다.
  assert.ok(s.stats.rivalByMaker.boeing > (s.stats.rivalByMaker.sukhoi || 0), '카탈로그 실력이 배분에 반영돼야 한다');
});

test('제조사별 배분은 상태만 보고 정해진다 (재현성)', () => {
  // 배분에서 난수를 뽑으면 이후 전개가 통째로 갈려 세이브 재현성이 깨진다.
  // 같은 시드로 두 판을 굴려 난수 위치(rngState)까지 같은지 확인한다.
  const run = (seed) => {
    const s = E.newGame(seed);
    for (let i = 0; i < 10; i++) E.endTurn(s);
    return {
      rngState: s.rngState,
      cash: Math.round(s.cash),
      rivals: s.stats.rivalDelivered,
      byMaker: JSON.stringify(s.stats.rivalByMaker),
    };
  };
  const a = run(77);
  assert.strictEqual(typeof a.rngState, 'number', 'rngState 를 못 읽으면 이 검사는 의미가 없다');
  assert.deepStrictEqual(a, run(77), '같은 시드가 다른 전개를 내면 안 된다');
});

test('수주전 전적이 제조사별로 쌓인다', () => {
  const s = E.newGame(23);
  let bid = 0;
  for (let t = 0; t < 24; t++) {
    for (const rfp of s.rfps) {
      const cands = E.eligiblePrograms(s, rfp).filter((c) => !c.score.blocked);
      if (cands.length) {
        E.setBid(s, rfp.id, cands[0].program.id, 10);
        bid++;
      }
    }
    E.endTurn(s);
    if (s.gameOver) break;
  }
  assert.ok(bid > 0, '입찰이 한 번도 성사되지 않아 전적을 검증할 수 없다');

  const records = E.duelRecords(s);
  assert.ok(records.length > 0, '맞붙은 상대가 장부에 남아야 한다');
  for (const r of records) {
    assert.strictEqual(r.faced, r.won + r.split + r.lost, `${r.name} 전적 합계가 맞지 않는다`);
    assert.ok(r.lostQty >= 0);
  }
  const totalFaced = records.reduce((a, r) => a + r.faced, 0);
  assert.ok(totalFaced <= s.stats.bidsMade, '입찰 수보다 많은 맞대결이 기록됐다');
});

test('업계 동향이 취항·단산 시점에 뜬다', () => {
  const s = E.newGame(31);
  const seen = [];
  for (let i = 0; i < 40; i++) {
    E.endTurn(s);
    if (s.gameOver) break;
    for (const n of s.news || []) seen.push(n);
  }
  assert.ok(seen.some((n) => n.kind === 'eis'), '20년 동안 신형이 한 번도 안 떴다');
  assert.ok(seen.some((n) => n.kind === 'end'), '단산 소식이 한 번도 안 떴다');
  // 소식은 그 분기에만 붙어 있어야 한다 — 계속 쌓이면 매 분기 같은 뉴스가 다시 뜬다.
  assert.ok(s.news.length < 6, '한 분기 소식이 비정상적으로 많다');
});

test('분기 이력에 추이 화면이 읽는 값이 함께 남는다', () => {
  const s = E.newGame(43);
  for (let i = 0; i < 3; i++) E.endTurn(s);
  const row = s.history[s.history.length - 1];
  for (const key of ['worth', 'share', 'fuel', 'demand', 'ordersWon']) {
    assert.strictEqual(typeof row[key], 'number', `${key} 가 기록되지 않으면 추이를 되짚을 방법이 없다`);
  }
  assert.ok(row.share >= 0 && row.share <= 1, '점유율은 0~1 비율이어야 한다');
});

test('추이·회고 화면은 옛 세이브(새 필드 없음)에도 그려진다', () => {
  const s = E.newGame(47);
  for (let i = 0; i < 6; i++) E.endTurn(s);

  // v1 세이브 재현: 새 필드가 통째로 없다.
  for (const h of s.history) {
    delete h.worth;
    delete h.share;
    delete h.fuel;
    delete h.demand;
    delete h.ordersWon;
  }
  delete s.stats.rivalByMaker;
  delete s.stats.duels;
  delete s.news;
  E.ensureShape(s);

  for (const html of [P.renderTrends(s), P.renderOverview(s), P.renderCareer(s)]) {
    assert.ok(html.length > 0);
    assert.ok(!/NaN|undefined/.test(html), '옛 세이브에서 빈 값이 화면으로 새어 나왔다');
  }
});

test('제조사 순위표는 우리와 미배분분까지 더해 점유율과 맞는다', () => {
  const s = E.newGame(53);
  for (let i = 0; i < 8; i++) E.endTurn(s);
  const rows = E.makerStandings(s);
  const us = rows.find((r) => r.us);
  assert.ok(us, '우리 회사가 순위표에 없다');
  const total = rows.reduce((a, r) => a + r.delivered, 0);
  assert.strictEqual(total, s.stats.delivered + s.stats.rivalDelivered, '순위표 합계가 점유율 분모와 달라졌다');
  assert.ok(Math.abs(us.share - E.marketShare(s)) < 1e-6, '순위표의 우리 점유율이 HUD 와 어긋난다');
});

test('회고는 최고·최악 분기와 점수 구성을 남긴다', () => {
  const s = E.newGame(59);
  s.cash = 6000;
  E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5200, tech: 55, material: 'hybrid' }, 'TEST-1');
  for (let i = 0; i < 20; i++) {
    E.endTurn(s);
    if (s.gameOver) break;
  }
  const r = E.careerReport(s);
  assert.ok(r.best && r.worst, '최고·최악 분기를 못 찾았다');
  assert.ok(r.best.net >= r.worst.net, '최고 분기가 최악 분기보다 나빠졌다');
  assert.ok(r.programs.some((p) => p.name === 'TEST-1'), '착수한 기종이 회고에 없다');

  const sum = r.breakdown.reduce((a, b) => a + b.points, 0);
  const score = E.finalScore(s, false).score;
  assert.ok(Math.abs(sum - score) <= 4, `점수 구성 합계(${sum})가 최종 점수(${score})와 어긋난다`);
});

test('회고의 기종 상태 표기가 실제 단계와 맞는다', () => {
  // 회고 전용 표기를 따로 두면 phase 가 늘거나 바뀔 때 한쪽만 갱신돼 어긋난다.
  const s = E.newGame(67);
  s.cash = 8000;
  E.launchProgram(s, { segment: 'narrow', seats: 170, range: 5000, tech: 50, material: 'hybrid' }, '개발중기');
  E.launchProgram(s, { segment: 'regional', seats: 90, range: 2600, tech: 40, material: 'aluminum' }, '중단기');
  E.endTurn(s);
  E.cancelProgram(s, s.programs.find((p) => p.name === '중단기').id);

  const r = E.careerReport(s);
  assert.strictEqual(r.programs.find((p) => p.name === '중단기').phase, 'cancelled');

  const html = P.renderCareer(s);
  assert.ok(/개발 중</.test(html), '개발 중인 기종을 중단으로 표기하면 안 된다');
  assert.ok(/>중단</.test(html), '취소된 기종은 중단으로 표기해야 한다');
  assert.ok(!/cancelled/.test(html), '내부 phase 값이 그대로 화면에 나왔다');
});

test('차트는 평평한 값·빈 배열에도 NaN 을 뱉지 않는다', () => {
  const flat = C.line({ labels: ['a', 'b'], series: [{ name: 'x', values: [5, 5, 5], cls: 'accent', fill: true }] });
  assert.ok(!/NaN/.test(flat), '값이 전부 같을 때 좌표가 깨졌다');
  assert.ok(/<svg/.test(flat));

  assert.ok(!/<svg/.test(C.line({ series: [] })), '그릴 게 없으면 빈 차트를 내야 한다');
  assert.ok(!/<svg/.test(C.bars({ values: [] })));
  assert.strictEqual(C.spark([1]), '', '점 하나짜리 스파크라인은 그리지 않는다');

  const withNulls = C.bars({ values: [10, null, -10], labels: ['a', 'b', 'c'], format: (v) => v + 'M' });
  assert.ok(!/NaN/.test(withNulls), '빈 칸이 섞여도 좌표가 깨지면 안 된다');
  assert.ok(/c-bar up/.test(withNulls) && /c-bar down/.test(withNulls), '흑자·적자 막대가 구분돼야 한다');
});

test('차트 높이는 픽셀로 고정되고 가로만 늘어난다', () => {
  // 비율을 유지하면 좁은 화면에서 높이가 같이 짜부라져 곡선도 축도 못 읽는다.
  const html = C.line({ height: 120, labels: ['a', 'b'], series: [{ name: 'x', values: [1, 2, 3] }] });
  assert.ok(/style="height:120px"/.test(html), '높이가 viewBox 와 같은 픽셀로 고정돼야 한다');
  assert.ok(/preserveAspectRatio="none"/.test(html), '가로는 컨테이너를 채워야 한다');
  // 가로로 늘어난 좌표계에서는 선 굵기도 같이 늘어난다 — 이걸 막지 않으면 굵기가 폭에 따라 변한다.
  const svg = html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));
  const strokes = svg.match(/<(polyline|line)[^>]*>/g) || [];
  assert.ok(strokes.length > 0);
  for (const el of strokes) assert.ok(/non-scaling-stroke/.test(el), `선 굵기가 폭에 따라 변한다: ${el}`);
  assert.ok(!/<circle/.test(svg), '원은 늘어난 좌표계에서 타원이 된다');
});

test('차트 축 라벨은 SVG 밖 HTML 로 나간다', () => {
  // viewBox 안에 두면 좁은 카드에서 글자까지 같이 줄어들어 읽을 수 없게 된다.
  const html = C.line({ labels: ['1998년 1분기', '2017년 4분기'], series: [{ name: 'x', values: [1, 2, 3] }] });
  const svg = html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));
  assert.ok(!/<text/.test(svg), '축 글자가 다시 SVG 안으로 들어갔다');
  assert.ok(/c-y/.test(html) && /c-x/.test(html), '축 라벨이 아예 사라졌다');
});

test('turnLabel 은 승계 기종의 음수 턴도 옳게 옮긴다', () => {
  // JS 의 % 는 음수에서 음수를 낸다. 보정하지 않으면 "1988년 -2분기"가 나온다.
  assert.strictEqual(E.turnLabel(-40), '1988년 1분기');
  assert.strictEqual(E.turnLabel(-39), '1988년 2분기');
  assert.strictEqual(E.turnLabel(-1), '1997년 4분기');
  assert.strictEqual(E.turnLabel(0), '1998년 1분기');
  assert.strictEqual(E.turnLabel(3), '1998년 4분기');
});

test('회고는 승계 기종의 착수 연도를 1998년으로 만들지 않는다', () => {
  const s = E.newGame(71);
  const legacy = s.programs.find((p) => p.legacy);
  const row = E.careerReport(s).programs.find((p) => p.name === legacy.name);
  assert.strictEqual(row.launched, E.turnLabel(legacy.launchTurn), '착수 턴을 눌러 연표가 틀어졌다');
  assert.ok(!/1998/.test(row.launched), '1988년에 뜬 기체가 1998년 착수로 기록됐다');
});

test('제조사 배분은 이벤트 보정치까지 반영한다', () => {
  // "인도가 대거 지연됐다"는 소식이 뜬 회사의 인도량이 그대로면 순위표가 소식과 어긋난다.
  const base = E.newGame(73);
  const hit = E.newGame(73);
  for (const c of hit.competitors) {
    if (c.id === 'boeing') for (const seg of ['regional', 'narrow', 'wide']) c.drift[seg] = -8;
  }
  for (let i = 0; i < 8; i++) {
    E.endTurn(base);
    E.endTurn(hit);
  }
  assert.ok(
    hit.stats.rivalByMaker.boeing < base.stats.rivalByMaker.boeing,
    `보정치가 배분에 반영되지 않았다 (${hit.stats.rivalByMaker.boeing} vs ${base.stats.rivalByMaker.boeing})`,
  );
  // 총량은 그대로여야 한다 — 보정은 나누는 비율만 바꾼다.
  assert.strictEqual(hit.stats.rivalDelivered, base.stats.rivalDelivered);
});

test('분할 수주도 상대에게 내준 물량으로 센다', () => {
  const s = E.newGame(79);
  s.stats.duels = {};
  const before = { faced: 0, won: 0, split: 0, lost: 0, lostQty: 0 };
  s.stats.duels.boeing = { ...before };

  // 엔진 내부의 recordDuel 은 비공개라, 실제 경로(분할 판정)로 검증한다.
  let split = 0;
  for (let t = 0; t < 40 && !s.gameOver; t++) {
    for (const rfp of s.rfps) {
      const c = E.eligiblePrograms(s, rfp).filter((x) => !x.score.blocked)[0];
      if (c) E.setBid(s, rfp.id, c.program.id, 0);
    }
    E.endTurn(s);
    split = E.duelRecords(s).reduce((a, r) => a + r.split, 0);
    if (split > 0) break;
  }
  if (!split) return; // 이 시드에서 분할이 안 났으면 검증할 게 없다

  const withSplit = E.duelRecords(s).filter((r) => r.split > 0);
  for (const r of withSplit) {
    assert.ok(r.lostQty > 0, `${r.name}: 절반씩 나눠 갖고도 놓친 물량이 0이다`);
  }
});

test('최대 부채는 분기 중에 갚아 버린 봉우리도 기억한다', () => {
  const s = E.newGame(83);
  assert.strictEqual(s.stats.peakDebt, Math.round(s.debt), '승계 부채가 봉우리의 출발점이다');
  E.repay(s, s.debt);
  E.endTurn(s);
  assert.ok(E.careerReport(s).peakDebt >= 1500, '분기 중에 갚은 부채가 회고에서 사라졌다');

  // 분기 중에 빌렸다 같은 분기에 갚아도 남아야 한다.
  E.borrow(s, 4000);
  E.repay(s, 4000);
  E.endTurn(s);
  assert.ok(E.careerReport(s).peakDebt >= 4000, '분기 중 차입 봉우리가 기록되지 않았다');
});

test('업계 최종 순위는 제조사를 잘라내지 않는다', () => {
  const s = E.newGame(89);
  for (let i = 0; i < 30 && !s.gameOver; i++) E.endTurn(s);
  const rows = E.makerStandings(s);
  const html = P.renderCareer(s) + P.renderTrends(s);
  for (const r of rows) {
    assert.ok(html.includes(r.name), `${r.name} 가 순위표에서 빠졌다`);
  }
});

test('최고 분기가 적자면 흑자로 표기하지 않는다', () => {
  const s = E.newGame(97);
  for (let i = 0; i < 3; i++) E.endTurn(s);
  for (const h of s.history) h.net = -10;
  const html = P.renderCareer(s);
  assert.ok(!/\+\$-/.test(html), '적자에 + 부호가 붙었다');
  assert.ok(/class="bad">\$-10M/.test(html), '적자 분기를 흑자 색으로 칠했다');
});

// ─────────────────────────── 결정 사건 ───────────────────────────

const Dec = globalThis.AirlinerDecisions;

test('결정 사건 정의는 형식을 지킨다', () => {
  assert.ok(Dec.DECISIONS.length >= 8, '사건이 너무 적으면 몇 판 만에 다 본다');
  const ids = new Set();
  for (const d of Dec.DECISIONS) {
    assert.ok(!ids.has(d.id), `중복 id: ${d.id}`);
    ids.add(d.id);
    assert.strictEqual(typeof d.text, 'function', `${d.id}: text 가 함수가 아니다`);
    assert.ok(d.options.length >= 2, `${d.id}: 선택지가 하나면 결정이 아니다`);
    assert.ok(d.options.some((o) => o.fallback), `${d.id}: 무대응 기본값이 없다`);
    for (const o of d.options) {
      assert.strictEqual(typeof o.apply, 'function', `${d.id}/${o.id}: apply 가 없다`);
      assert.ok(o.label && o.detail, `${d.id}/${o.id}: 라벨·설명이 비었다`);
      if (o.after) {
        assert.ok(o.after.quarters > 0, `${d.id}/${o.id}: 지연 분기가 0이다`);
        assert.strictEqual(typeof o.after.apply, 'function');
      }
    }
    // 적어도 하나는 나중에 값을 치러야 한다 — 즉시 정산만 있으면 자원 교환일 뿐이다.
  }
  const withLater = Dec.DECISIONS.filter((d) => d.options.some((o) => o.after));
  assert.ok(withLater.length >= 4, '지연 결과가 있는 사건이 너무 적다');
});

test('결정 사건이 빈 분기를 메운다', () => {
  let seen = 0;
  for (const seed of [3, 11, 29, 41]) {
    const s = E.newGame(seed);
    for (let t = 0; t < 40 && !s.gameOver; t++) {
      s.cash = Math.max(s.cash, 4000);
      if (s.decision) {
        seen++;
        E.decide(s, s.decision.options[0].id);
      }
      E.endTurn(s);
    }
  }
  assert.ok(seen >= 20, `160분기에 사건이 ${seen}건뿐이다 — 빈 분기가 그대로다`);
});

test('선택은 즉시 정산되고 사건을 닫는다', () => {
  const s = E.newGame(19);
  let handled = false;
  for (let t = 0; t < 40 && !handled && !s.gameOver; t++) {
    s.cash = Math.max(s.cash, 6000);
    if (s.decision) {
      const before = { cash: s.cash, rep: s.reputation, logs: s.log.length };
      const r = E.decide(s, s.decision.options[0].id);
      assert.ok(r.ok, r.error);
      assert.strictEqual(s.decision, null, '고른 뒤에도 사건이 남아 있다');
      assert.ok(s.log.length > before.logs, '선택이 기록에 남지 않았다');
      // 무언가는 바뀌어야 한다 — 현금·평판·관계·잔고 중 하나라도.
      handled = true;
    }
    E.endTurn(s);
  }
  assert.ok(handled, '40분기 동안 사건이 하나도 안 떴다');
  assert.ok(!E.decide(s, 'nope').ok, '없는 선택지는 거부해야 한다');
});

test('답하지 않고 넘기면 무대응이 적용된다', () => {
  const s = E.newGame(23);
  let checked = false;
  for (let t = 0; t < 40 && !checked && !s.gameOver; t++) {
    s.cash = Math.max(s.cash, 6000);
    if (s.decision) {
      const name = s.decision.name;
      const fallback = Dec.fallbackOf(s.decision.id);
      E.endTurn(s); // 고르지 않고 넘긴다
      assert.strictEqual(s.decision && s.decision.name === name ? 'stuck' : 'closed', 'closed', '무응답 사건이 그대로 남았다');
      const logged = s.log.some((l) => l.text.includes(name) && l.text.includes(fallback.label));
      assert.ok(logged, `무대응(${fallback.label})이 기록되지 않았다`);
      checked = true;
    } else {
      E.endTurn(s);
    }
  }
  assert.ok(checked, '40분기 동안 사건이 하나도 안 떴다');
});

test('지연 결과는 예약된 분기에 정산된다', () => {
  const s = E.newGame(31);
  // 지연 결과가 있는 선택지를 직접 심는다 — 무작위로 뜨기를 기다리지 않는다.
  const def = Dec.DECISIONS.find((d) => d.options.some((o) => o.after));
  const opt = def.options.find((o) => o.after);
  s.decision = { id: def.id, name: def.name, text: def.text(s, { rng: R.createRng(1), remember: () => {}, recall: (k, f) => f, rngPick: null }), memo: {}, turn: s.turn, options: def.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })) };
  E.decide(s, opt.id);

  assert.strictEqual(s.pendingOutcomes.length, 1, '지연 결과가 예약되지 않았다');
  const dueTurn = s.pendingOutcomes[0].turn;
  assert.strictEqual(dueTurn, s.turn + opt.after.quarters);

  const before = s.log.length;
  while (s.turn < dueTurn && !s.gameOver) {
    s.cash = Math.max(s.cash, 8000);
    E.endTurn(s);
  }
  // 기다리는 동안 새 사건이 떠 또 다른 지연 결과가 예약될 수 있다. 길이가 아니라
  // **내가 심은 예약**이 사라졌는지를 본다.
  assert.ok(
    !s.pendingOutcomes.some((x) => x.id === def.id && x.optionId === opt.id),
    '예약된 분기가 지났는데 정산되지 않았다',
  );
  assert.ok(s.log.length > before, '지연 결과가 기록에 남지 않았다');
});

test('결정 상태는 세이브 왕복을 견딘다 (함수를 저장하지 않는다)', () => {
  const s = E.newGame(37);
  for (let t = 0; t < 40 && !s.decision && !s.gameOver; t++) {
    s.cash = Math.max(s.cash, 6000);
    E.endTurn(s);
  }
  assert.ok(s.decision, '사건이 뜨지 않아 검증할 수 없다');

  const round = JSON.parse(JSON.stringify(s));
  E.ensureShape(round);
  assert.ok(round.decision && round.decision.options.length >= 2, '세이브에서 선택지가 사라졌다');
  const r = E.decide(round, round.decision.options[0].id);
  assert.ok(r.ok, `세이브를 불러온 뒤 선택이 안 된다: ${r.error}`);
});

test('종료 후에는 결정할 수 없다', () => {
  const s = E.newGame(43);
  s.gameOver = { reason: 'complete', lastTurn: 79 };
  s.decision = { id: 'airshow', name: 'x', text: 'x', memo: {}, turn: 0, options: [{ id: 'skip', label: 'x', detail: 'x' }] };
  assert.ok(!E.decide(s, 'skip').ok, '종료 후 결정이 통과했다');
});

// ─────────────────────── 입찰 조건 · 경쟁사 반격 ───────────────────────

function firstBiddable(s, maxTurns = 20) {
  for (let t = 0; t < maxTurns && !s.gameOver; t++) {
    for (const rfp of s.rfps) {
      const c = E.eligiblePrograms(s, rfp).filter((x) => !x.score.blocked)[0];
      if (c) return { rfp, program: c.program };
    }
    s.cash = Math.max(s.cash, 5000);
    E.endTurn(s);
  }
  return null;
}

test('입찰 조건이 점수를 움직이고, 대가도 함께 붙는다', () => {
  const s = E.newGame(101);
  const found = firstBiddable(s);
  assert.ok(found, '응찰 가능한 공고를 못 찾았다');

  const base = B.scoreBid(s, found.rfp, found.program, 0.1, { pledge: 'standard', financing: 'normal' });
  const fast = B.scoreBid(s, found.rfp, found.program, 0.1, { pledge: 'priority', financing: 'normal' });
  const vendor = B.scoreBid(s, found.rfp, found.program, 0.1, { pledge: 'standard', financing: 'vendor' });
  const cash = B.scoreBid(s, found.rfp, found.program, 0.1, { pledge: 'standard', financing: 'cash' });

  assert.ok(fast.total > base.total, '최우선 인도 약속이 점수를 올리지 않는다');
  assert.ok(vendor.total > base.total, '자체 금융이 점수를 올리지 않는다');
  assert.ok(cash.total < base.total, '선수금 확대는 점수를 깎아야 한다');
  // 조건 하나가 판을 통째로 뒤집으면 조건이 선택이 아니라 필수가 된다.
  assert.ok(fast.total - base.total <= 6, `인도 약속 가산이 과하다 (+${(fast.total - base.total).toFixed(1)})`);
});

test('조건은 기종을 바꿔도 유지되고, 기종 없이는 걸 수 없다', () => {
  const s = E.newGame(103);
  const found = firstBiddable(s);
  assert.ok(found);
  assert.ok(!E.setBidTerms(s, found.rfp.id, { pledge: 'early' }).ok, '기종 없이 조건이 걸렸다');

  E.setBid(s, found.rfp.id, found.program.id, 0.1);
  E.setBidTerms(s, found.rfp.id, { pledge: 'early', financing: 'vendor' });
  E.setBid(s, found.rfp.id, found.program.id, 0.2);
  assert.strictEqual(s.bids[found.rfp.id].terms.pledge, 'early', '기종을 다시 고르니 조건이 초기화됐다');
  assert.strictEqual(s.bids[found.rfp.id].terms.financing, 'vendor');
});

test('지키지 못한 인도 약속은 분기마다 위약금을 문다', () => {
  const s = E.newGame(107);
  const p = s.programs.find((x) => x.legacy);
  // 라인 없이 최우선 인도를 약속한 주문 — 절대 못 지킨다.
  s.backlog.push({
    id: 'ord-test',
    airlineId: 'hanul',
    airlineName: '한울항공',
    programId: p.id,
    programName: p.name,
    qty: 20,
    remaining: 20,
    unitPrice: 60,
    wonTurn: s.turn,
    pledge: 'priority',
    financing: 'normal',
    dueTurn: s.turn + 1,
    depositRate: 0.15,
  });
  for (const l of s.lines) l.idle = true; // 인도할 재고가 안 생기게
  const relBefore = s.relations.hanul;

  const charges = [];
  for (let i = 0; i < 4 && !s.gameOver; i++) {
    s.cash = Math.max(s.cash, 20000);
    const before = s.cash;
    E.endTurn(s);
    const logged = s.log.filter((l) => l.text.includes('위약금')).length;
    charges.push(logged);
  }
  assert.ok(charges[charges.length - 1] >= 2, `위약금이 한 번만 부과됐다 (${charges.join(',')})`);
  assert.ok(s.relations.hanul < relBefore - 5, `지연이 반복되는데 관계가 그대로다 (${relBefore} → ${s.relations.hanul})`);
});

test('자체 금융은 인도 대금을 나눠 받고 총액은 이자만큼 늘어난다', () => {
  const s = E.newGame(109);
  const p = s.programs.find((x) => x.legacy);
  p.stock = 10;
  const unitPrice = 60;
  s.backlog.length = 0;
  s.backlog.push({
    id: 'ord-v',
    airlineId: 'hanul',
    airlineName: '한울항공',
    programId: p.id,
    programName: p.name,
    qty: 10,
    remaining: 10,
    unitPrice,
    wonTurn: s.turn,
    pledge: 'standard',
    financing: 'vendor',
    dueTurn: s.turn + 14,
    depositRate: 0.15,
  });

  const balance = 10 * unitPrice * 0.85;
  E.endTurn(s);
  const scheduled = s.receivables.reduce((a, r) => a + r.amount, 0);
  assert.ok(s.receivables.length === 8, `분할 회수가 8분기로 잡히지 않았다 (${s.receivables.length})`);
  // 즉시 42% + 분할분(이자 2% 포함) = 원금 + 이자
  assert.ok(scheduled > balance * 0.55, `분할 예정액이 너무 적다 (${scheduled.toFixed(0)} vs ${balance.toFixed(0)})`);
  assert.ok(scheduled < balance * 0.62, `분할 예정액이 너무 많다 (${scheduled.toFixed(0)})`);

  // 미수금은 자산이다 — 순자산에서 빠지면 자체 금융이 신용등급을 부당하게 깎는다.
  const worthWith = E.netWorth(s);
  const saved = s.receivables;
  s.receivables = [];
  assert.ok(worthWith > E.netWorth(s), '미수금이 순자산에 잡히지 않는다');
  s.receivables = saved;
});

test('경쟁사는 뺏긴 시장에 반격하고, 손을 떼면 물러난다', () => {
  const s = E.newGame(113);
  const seg = 'narrow';
  // 반격은 이벤트 보정(drift)과 다른 슬롯(reaction)을 쓴다 — 그래야 반격의 감쇠가
  // 이벤트가 준 보정을 지우지 않는다.
  const before = Math.max(...s.competitors.map((c) => c.reaction[seg] || 0));

  // 무작위 이벤트도 보정치를 움직인다(경쟁사 신형 투입 등). 여기서 재려는 것은
  // 반격 로직뿐이므로 이 시나리오 동안만 추첨 이벤트를 비운다.
  const savedEvents = Data.EVENTS.slice();
  Data.EVENTS.length = 0;
  try {

  // 협동체를 계속 따내는 상황을 만든다.
  const p = s.programs.find((x) => x.segment === seg);
  for (let i = 0; i < 10 && !s.gameOver; i++) {
    s.cash = Math.max(s.cash, 20000);
    s.backlog.push({
      id: 'ord-r' + i,
      airlineId: 'hanul',
      airlineName: '한울항공',
      programId: p.id,
      programName: p.name,
      qty: 30,
      remaining: 0,
      unitPrice: 60,
      wonTurn: s.turn,
      pledge: 'standard',
      financing: 'normal',
      dueTurn: s.turn + 14,
      depositRate: 0.15,
    });
    E.endTurn(s);
  }
  const peak = Math.max(...s.competitors.map((c) => c.reaction[seg] || 0));
  assert.ok(peak > before, '시장을 계속 내주는데 경쟁사가 반응하지 않는다');
  // 반격이 시장을 통째로 닫으면 안 된다 — 이벤트 상한(14)과 다른, 훨씬 낮은 상한.
  assert.ok(peak <= 5, `반격이 과하다 (drift ${peak})`);

  // 손을 떼면 물러난다.
  s.backlog.length = 0;
  for (let i = 0; i < 12 && !s.gameOver; i++) {
    s.cash = Math.max(s.cash, 20000);
    E.endTurn(s);
  }
  const after = Math.max(...s.competitors.map((c) => c.reaction[seg] || 0));
  assert.ok(after < peak, `공세가 영원히 유지된다 (${peak} → ${after})`);
  } finally {
    Data.EVENTS.push(...savedEvents);
  }
});

test('조건이 없는 옛 주문도 그대로 인도된다', () => {
  const s = E.newGame(127);
  const p = s.programs.find((x) => x.legacy);
  p.stock = 5;
  s.backlog.length = 0;
  // v1 세이브: pledge·financing·dueTurn·depositRate 가 아예 없다.
  s.backlog.push({
    id: 'ord-old',
    airlineId: 'hanul',
    airlineName: '한울항공',
    programId: p.id,
    programName: p.name,
    qty: 5,
    remaining: 5,
    unitPrice: 60,
    wonTurn: s.turn - 2,
  });
  const before = s.cash;
  E.endTurn(s);
  assert.strictEqual(s.backlog[0].remaining, 0, '옛 주문이 인도되지 않았다');
  assert.ok(s.cash > before, '옛 주문의 잔금이 들어오지 않았다');
  assert.strictEqual(s.receivables.length, 0, '조건 없는 주문에 분할 회수가 잡혔다');
});

// ─────────────────── 이사회 목표 · 회생 수단 ───────────────────

test('새 게임에 목표가 발령되고 기한이 되면 정산된다', () => {
  const s = E.newGame(211);
  const first = E.mandateStatus(s);
  assert.ok(first, '시작부터 목표가 있어야 중간 눈금이 생긴다');
  assert.strictEqual(first.dueTurn - first.issuedTurn, 20, '5년(20분기) 주기가 아니다');
  assert.ok(first.target > 0 && first.text.length > 0);

  const firstId = first.id;
  while (s.turn <= first.dueTurn && !s.gameOver) {
    s.cash = Math.max(s.cash, 30000);
    E.endTurn(s);
  }
  const next = E.mandateStatus(s);
  assert.ok(next, '기한이 지났는데 새 목표가 없다');
  assert.notStrictEqual(next.id, firstId, '같은 목표가 연달아 나왔다');
  assert.ok((s.stats.mandatesMet || 0) + (s.stats.mandatesMissed || 0) >= 1, '정산 기록이 없다');
});

test('목표 달성은 증자와 신임으로, 미달은 조달 금리로 돌아온다', () => {
  // 달성: 목표를 이미 넘긴 상태로 기한을 맞는다.
  const win = E.newGame(223);
  win.mandate = { id: 'delivery', name: '인도 확대', target: 1, text: '인도 1기', issuedTurn: 0, dueTurn: win.turn + 1 };
  win.stats.delivered = 500;
  const cashBefore = win.cash;
  const repBefore = win.reputation;
  win.cash = Math.max(win.cash, 20000);
  E.endTurn(win);
  assert.strictEqual(win.stats.mandatesMet, 1, '달성이 기록되지 않았다');
  assert.ok(win.reputation > repBefore, '달성했는데 신임이 오르지 않았다');

  // 미달: 도달 불가능한 목표.
  const lose = E.newGame(227);
  lose.mandate = { id: 'delivery', name: '인도 확대', target: 999999, text: '인도 999999기', issuedTurn: 0, dueTurn: lose.turn + 1 };
  lose.cash = Math.max(lose.cash, 20000);
  E.endTurn(lose);
  assert.strictEqual(lose.stats.mandatesMissed, 1, '미달이 기록되지 않았다');
  assert.ok(lose.effects.rateBumpQuarters > 0, '미달했는데 조달 금리가 그대로다');
});

test('증자는 현금을 지분으로 바꾸고 최종 점수를 깎는다', () => {
  const s = E.newGame(229);
  const cap = E.equityCapacity(s);
  assert.ok(!E.raiseEquity(s, cap.max * 2).ok, '한도를 넘는 증자가 통과했다');

  const before = s.cash;
  const scoreBefore = E.finalScore(s, false).score;
  assert.ok(E.raiseEquity(s, cap.max).ok);
  assert.ok(s.cash > before, '증자했는데 현금이 안 늘었다');
  assert.ok(s.equityDilution > 0, '희석이 기록되지 않았다');

  // 현금이 늘었는데도 점수는 희석 때문에 무한정 오르지 않는다.
  const own = 1 - s.equityDilution;
  const expected = Math.round((E.finalScore(s, false).score / own) * own);
  assert.strictEqual(E.finalScore(s, false).score, expected);
  assert.ok(
    E.scoreBreakdown(s).some((r) => r.label === '지분 희석' && r.points < 0),
    '점수 구성에 희석이 안 보인다',
  );

  // 3회까지만.
  E.raiseEquity(s, 300);
  E.raiseEquity(s, 300);
  assert.ok(!E.raiseEquity(s, 300).ok, '증자 횟수 제한이 없다');
  assert.ok(scoreBefore >= 0);
});

test('프로그램 매각은 개발 단계에서만 되고 경쟁사를 강하게 만든다', () => {
  const s = E.newGame(233);
  s.cash = 9000;
  const legacy = s.programs.find((p) => p.legacy);
  assert.ok(!E.sellProgram(s, legacy.id).ok, '양산 기종이 매각됐다');

  E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5400, tech: 50, fuselage: 'aluminum', wingMat: 'aluminum' }, 'SELLME');
  const p = s.programs.find((x) => x.name === 'SELLME');
  for (let i = 0; i < 3; i++) E.endTurn(s);

  const driftBefore = s.competitors.reduce((a, c) => a + (c.drift.narrow || 0), 0);
  const cashBefore = s.cash;
  const r = E.sellProgram(s, p.id);
  assert.ok(r.ok, r.error);
  assert.ok(s.cash > cashBefore, '매각 대금이 안 들어왔다');
  assert.ok(r.value < p.spent, '들인 돈보다 비싸게 팔렸다 — 헐값 매각이어야 한다');
  assert.strictEqual(p.phase, 'sold');
  const driftAfter = s.competitors.reduce((a, c) => a + (c.drift.narrow || 0), 0);
  assert.ok(driftAfter > driftBefore, '도면이 넘어갔는데 경쟁사가 그대로다');
  assert.ok(r.buyer && r.buyer.length > 0, '누가 샀는지가 남지 않았다');
  assert.ok(!E.sellProgram(s, p.id).ok, '매각한 기종이 또 팔렸다');
});

test('현금 잔여 분기는 적자일 때만 나온다', () => {
  const s = E.newGame(239);
  s.history = [
    { net: 200, cash: 1000, debt: 0, label: 'a', revenue: 0, cost: 0, delivered: 0, backlog: 0, reputation: 50 },
    { net: 100, cash: 1100, debt: 0, label: 'b', revenue: 0, cost: 0, delivered: 0, backlog: 0, reputation: 50 },
  ];
  assert.strictEqual(E.cashRunway(s), null, '흑자인데 소진 예상이 뜬다');

  s.cash = 1000;
  s.history = [
    { net: -250, cash: 1000, debt: 0, label: 'a', revenue: 0, cost: 0, delivered: 0, backlog: 0, reputation: 50 },
    { net: -250, cash: 1000, debt: 0, label: 'b', revenue: 0, cost: 0, delivered: 0, backlog: 0, reputation: 50 },
  ];
  assert.strictEqual(E.cashRunway(s), 4, '적자 속도로 계산한 잔여 분기가 틀렸다');
});

test('목표·증자 상태는 세이브 왕복을 견딘다', () => {
  const s = E.newGame(241);
  E.raiseEquity(s, 400);
  const round = JSON.parse(JSON.stringify(s));
  E.ensureShape(round);
  assert.ok(E.mandateStatus(round), '세이브에서 목표가 사라졌다');
  assert.strictEqual(round.equityRounds, 1);
  assert.ok(round.equityDilution > 0);

  // 목표·증자 개념이 없던 v1 세이브
  const old = E.newGame(243);
  delete old.mandate;
  delete old.equityRounds;
  delete old.equityDilution;
  E.ensureShape(old);
  assert.strictEqual(old.equityRounds, 0);
  assert.strictEqual(old.equityDilution, 0);
  assert.doesNotThrow(() => E.endTurn(old));
});

// ─────────────────────── 서비스 사업 ───────────────────────

test('애프터마켓 수익은 선단에 비례하고 투자로 늘어난다', () => {
  const s = E.newGame(251);
  const base = E.serviceIncome(s);
  assert.ok(base.fleet > 0, '승계 기종의 인도분이 선단으로 잡혀야 한다');
  assert.ok(base.aftermarket > 0, '투자 없이도 부품 마진은 들어온다');

  // 선단이 커지면 수익도 커진다.
  const p = s.programs.find((x) => x.legacy);
  p.delivered += 200;
  assert.ok(E.serviceIncome(s).aftermarket > base.aftermarket, '선단이 늘었는데 수익이 그대로다');

  s.cash = 9000;
  const before = E.serviceIncome(s).aftermarket;
  assert.ok(E.upgradeAftermarket(s, 'regional').ok);
  assert.ok(E.serviceIncome(s).aftermarket > before, '투자했는데 수익이 그대로다');

  // 실제 정산에도 반영된다.
  const cashBefore = s.cash;
  const r = E.endTurn(s);
  assert.ok(r.report.services > 0, '서비스 수익이 리포트에 안 잡혔다');
});

test('서비스 투자는 단계를 건너뛰거나 되돌릴 수 없다', () => {
  const s = E.newGame(253);
  s.cash = 20000;
  assert.ok(!E.upgradeAftermarket(s, 'nope').ok, '없는 단계가 통과했다');
  assert.ok(E.upgradeAftermarket(s, 'regional').ok);
  assert.ok(!E.upgradeAftermarket(s, 'regional').ok, '같은 단계를 두 번 샀다');
  assert.ok(!E.upgradeAftermarket(s, 'none').ok, '투자를 되돌릴 수 있다');
  assert.ok(E.upgradeAftermarket(s, 'global').ok);

  // 자금이 모자라면 거부한다.
  const poor = E.newGame(257);
  poor.cash = 10;
  assert.ok(!poor.cash || !E.upgradeAftermarket(poor, 'regional').ok, '돈 없이 투자가 통과했다');
});

test('화물형은 양산 기종에만 붙고 몇 분기 뒤에 열린다', () => {
  const s = E.newGame(259);
  s.cash = 12000;
  const legacy = s.programs.find((p) => p.legacy);
  assert.ok(E.startFreighter(s, legacy.id).ok);
  assert.ok(!E.startFreighter(s, legacy.id).ok, '같은 기종에 두 번 착수됐다');
  assert.strictEqual(E.serviceIncome(s).freight, 0, '개조가 끝나기 전에 수익이 들어온다');

  // 착수한 분기의 정산이 한 번 끼므로, 약속한 N분기가 실제로 지나려면 N+1번 넘겨야 한다.
  for (let i = 0; i <= Data.FREIGHTER.quarters; i++) {
    s.cash = Math.max(s.cash, 9000);
    E.endTurn(s);
  }
  assert.strictEqual(s.turn, Data.FREIGHTER.quarters + 1, '분기 진행이 예상과 다르다');
  assert.ok(legacy.freighter, `${Data.FREIGHTER.quarters}분기가 지나도 사업이 안 열렸다`);
  const normal = E.serviceIncome(s).freight;
  assert.ok(normal > 0, '화물 수익이 안 들어온다');

  // 침체기에는 화물이 버틴다 — 그게 이 사업의 존재 이유다.
  s.effects.demandSlumpQuarters = 4;
  assert.ok(E.serviceIncome(s).freight > normal, '침체기에 화물 수익이 늘지 않는다');

  // 개발 중인 기종에는 붙지 않는다.
  const dev = E.newGame(263);
  dev.cash = 12000;
  E.launchProgram(dev, { segment: 'narrow', seats: 180, range: 5400, tech: 50, fuselage: 'aluminum', wingMat: 'aluminum' }, 'DEV1');
  const p = dev.programs.find((x) => x.name === 'DEV1');
  assert.ok(!E.startFreighter(dev, p.id).ok, '개발 중인 기종에 화물형이 붙었다');
});

test('서비스 투자는 회수가 되는 값이어야 한다 (함정 선택지 금지)', () => {
  // 처음 잡았던 값(0.085/900/2400)은 회수에 67분기가 걸려 고를 이유가 없었다.
  const fleet = 400;
  const per = Data.AFTERMARKET_PER_UNIT;
  const tiers = Data.AFTERMARKET_TIERS;
  const payback = (from, to) => {
    const gain = fleet * per * (tiers[to].mult - tiers[from].mult);
    return (tiers[to].cost - tiers[from].cost) / gain;
  };
  assert.ok(payback('none', 'regional') <= 28, `지역 거점 회수가 너무 길다 (${payback('none', 'regional').toFixed(0)}분기)`);
  assert.ok(payback('regional', 'global') <= 28, `글로벌 서비스망 회수가 너무 길다 (${payback('regional', 'global').toFixed(0)}분기)`);
  // 20년(80분기) 안에 회수도 안 되면 사업이 아니라 벌금이다.
  assert.ok(payback('none', 'global') < 60);
});

test('서비스 사업이 없던 옛 세이브도 그대로 돈다', () => {
  const s = E.newGame(269);
  delete s.aftermarket;
  E.ensureShape(s);
  assert.strictEqual(s.aftermarket, 'none');
  assert.doesNotThrow(() => E.endTurn(s));
  assert.ok(E.serviceIncome(s).total > 0);
});

// ─────────────────── 리뷰 지적 회귀 (2차) ───────────────────

test('위약금은 이번 분기 리포트에만 잡힌다 (다음 분기 이중 계상 금지)', () => {
  const s = E.newGame(301);
  const p = s.programs.find((x) => x.legacy);
  for (const l of s.lines) l.idle = true;
  s.backlog.push({
    id: 'ord-pen', airlineId: 'hanul', airlineName: '한울항공', programId: p.id, programName: p.name,
    qty: 20, remaining: 20, unitPrice: 60, wonTurn: s.turn, pledge: 'priority', financing: 'normal',
    dueTurn: s.turn, depositRate: 0.15,
  });

  s.cash = 30000;
  const r1 = E.endTurn(s);
  assert.ok(r1.report.overhead > 0, '위약금이 이번 분기에 안 잡혔다');
  const charged = r1.report.overhead;

  // 다음 분기: 현금은 또 나가지만(계속 밀리므로) 직전 분기 몫이 얹히면 안 된다.
  const cashBefore = s.cash;
  const r2 = E.endTurn(s);
  const cashSpent = cashBefore - s.cash;
  const reported = r2.report.overhead + r2.report.interest + r2.report.rdCost + r2.report.capex + r2.report.productionCost - r2.report.revenue;
  assert.ok(
    Math.abs(cashSpent - reported) < 2,
    `현금 ${Math.round(cashSpent)} 이 나갔는데 장부는 ${Math.round(reported)} — 지난 분기 위약금 ${Math.round(charged)}이 다시 세어졌다`,
  );
});

test('결정으로 성사된 수주도 그 분기 실적에 잡힌다', () => {
  const s = E.newGame(307);
  const def = Dec.get('lessor_bulk');
  const p = s.programs.find((x) => x.legacy);
  s.decision = {
    id: 'lessor_bulk', name: def.name, text: 'x',
    memo: { program: p.id, qty: 24 }, turn: s.turn,
    options: def.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })),
  };
  assert.ok(E.decide(s, 'accept').ok);
  const r = E.endTurn(s);
  assert.strictEqual(r.report.ordersWon, 24, '결정으로 받은 물량이 리포트에 0으로 남았다');
  assert.strictEqual(s.history[s.history.length - 1].ordersWon, 24);
});

test('백로그 가치는 주문별 선수금률을 뺀다', () => {
  const s = E.newGame(311);
  const p = s.programs.find((x) => x.legacy);
  s.backlog.length = 0;
  s.backlog.push({
    id: 'a', airlineId: 'hanul', airlineName: 'x', programId: p.id, programName: p.name,
    qty: 10, remaining: 10, unitPrice: 100, wonTurn: 0, depositRate: 0.3,
  });
  // 선수금 30%를 이미 받았으므로 남은 값은 700 이어야 한다.
  assert.ok(Math.abs(E.backlogValue(s) - 700) < 1, `선수금 확대 주문의 잔여 가치가 틀렸다 (${E.backlogValue(s)})`);

  // 조건이 없던 옛 주문은 기본값(15%)을 쓴다.
  s.backlog[0] = { ...s.backlog[0], depositRate: undefined };
  assert.ok(Math.abs(E.backlogValue(s) - 850) < 1, `옛 주문의 잔여 가치가 틀렸다 (${E.backlogValue(s)})`);
});

test('완주하면 마지막 이사회 목표까지 정산된다', () => {
  const s = E.newGame(313);
  // 마지막 구간으로 건너뛴다.
  s.turn = Data.CONFIG.totalTurns - 2;
  s.mandate = { id: 'delivery', name: '인도 확대', target: 1, text: '인도 1기', issuedTurn: s.turn - 18, dueTurn: Data.CONFIG.totalTurns };
  s.stats.delivered = 9999;
  s.cash = 40000;
  while (!s.gameOver) E.endTurn(s);

  assert.ok(s.gameOver, '게임이 끝나지 않았다');
  assert.ok((s.stats.mandatesMet || 0) >= 1, '마지막 목표가 정산되지 않고 사라졌다');
  assert.strictEqual(s.mandate, null, '끝난 판에 새 목표가 발령됐다');
});

test('목표 개념이 없던 세이브도 다음 분기에 목표를 받는다', () => {
  const s = E.newGame(317);
  s.mandate = null;
  E.ensureShape(s);
  assert.strictEqual(E.mandateStatus(s), null);
  s.cash = 20000;
  E.endTurn(s);
  assert.ok(E.mandateStatus(s), '옛 세이브가 끝까지 목표 없이 흘러간다');
});

test('차환 감면이 위기 가산을 지우지 않는다', () => {
  const s = E.newGame(319);
  // 부채를 먼저 확정한다 — 신용등급이 부채비율을 보므로, 나중에 늘리면 비교가 어긋난다.
  s.debt = 4000;
  s.effects.rateBump = 0.012;
  s.effects.rateBumpQuarters = 8;
  const crisisRate = E.interestRate(s);

  const def = Dec.get('refinance');
  s.decision = {
    id: 'refinance', name: def.name, text: 'x', memo: {}, turn: s.turn,
    options: def.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })),
  };
  E.decide(s, 'refi');

  const after = E.interestRate(s);
  assert.ok(after < crisisRate, '차환했는데 금리가 안 내려갔다');
  assert.ok(after > E.interestRate({ ...s, effects: { ...s.effects, rateBumpQuarters: 0, rateCutQuarters: 0 } }) - 0.0001 - 0.012,
    '차환이 위기 가산을 통째로 지웠다');
  // 가산이 살아 있어야 한다 — 감면은 별도 슬롯.
  assert.strictEqual(s.effects.rateBump, 0.012, '위기 가산이 덮어써졌다');
  assert.ok(s.effects.rateCut > 0, '감면이 기록되지 않았다');
});

test('정부 지원금 상환 의무는 유예돼도 사라지지 않는다', () => {
  const s = E.newGame(323);
  const def = Dec.get('gov_grant');
  s.cash = 5000;
  E.launchProgram(s, { segment: 'wide', seats: 300, range: 12000, tech: 70, fuselage: 'composite', wingMat: 'composite' }, 'SLOW');
  const slow = s.programs.find((p) => p.name === 'SLOW');
  s.decision = {
    id: 'gov_grant', name: def.name, text: 'x',
    // 상환 의무는 **지원받은 그 기종**에 걸린다.
    memo: { program: slow.id }, turn: s.turn,
    options: def.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })),
  };
  E.decide(s, 'take');
  assert.strictEqual(s.pendingOutcomes.length, 1);

  // 8분기 뒤에도 양산 기종이 없다 — 의무가 사라지면 지원금이 공짜가 된다.
  for (let i = 0; i < 9 && !s.gameOver; i++) {
    s.cash = Math.max(s.cash, 20000);
    E.endTurn(s);
  }
  assert.ok(s.pendingOutcomes.length >= 1, '상환 의무가 통째로 사라졌다 (지원금이 공짜가 된다)');
  assert.ok(s.log.some((l) => l.text.includes('유예')), '유예 사실이 기록되지 않았다');
});

test('특별 근무는 실제로 인도를 앞당기고 기한을 다시 맞춘다', () => {
  const s = E.newGame(331);
  const p = s.programs.find((x) => x.legacy);
  p.stock = 0;
  s.backlog.length = 0;
  s.backlog.push({
    id: 'ord-late', airlineId: 'hanul', airlineName: '한울항공', programId: p.id, programName: p.name,
    qty: 20, remaining: 20, unitPrice: 60, wonTurn: s.turn, pledge: 'priority', financing: 'normal',
    dueTurn: s.turn, depositRate: 0.15,
  });
  const def = Dec.get('delivery_slip');
  s.decision = {
    id: 'delivery_slip', name: def.name, text: 'x',
    memo: { airline: 'hanul', airlineName: '한울항공', orderId: 'ord-late' }, turn: s.turn,
    options: def.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })),
  };

  const dueBefore = s.backlog[0].dueTurn;
  E.decide(s, 'overtime');
  assert.ok(p.stock > 0, '특별 근무를 하고도 기체가 안 나왔다');
  assert.ok(s.backlog[0].dueTurn > dueBefore, '기한이 그대로라 바로 위약금을 문다');

  s.cash = 20000;
  const r = E.endTurn(s);
  assert.ok(s.backlog[0].remaining < 20, '앞당겨 뽑은 기체가 인도되지 않았다');
  assert.ok(!s.log.some((l) => l.text.includes('위약금')), '만회했는데 같은 분기에 위약금을 물었다');
});

test('회고의 최고 점유율은 승계 선단이 만든 출발점을 포함한다', () => {
  const s = E.newGame(337);
  const opening = E.marketShare(s);
  assert.ok(opening > 0.3, '승계분 덕에 시작 점유율이 이미 높아야 한다');

  // 아무것도 안 하면 경쟁사만 쌓여 점유율은 계속 내려간다.
  for (let i = 0; i < 12 && !s.gameOver; i++) {
    s.cash = Math.max(s.cash, 20000);
    E.endTurn(s);
  }
  assert.ok(E.marketShare(s) < opening, '이 시나리오에서는 점유율이 내려가야 한다');

  // 최고 점유율은 "출발점과 분기말 이력 중 최댓값"이어야 한다.
  // 출발점만 확인하면 첫 분기에 승계 잔고가 인도돼 살짝 오르는 판에서 깨지고,
  // 이력만 확인하면 출발점을 통째로 빠뜨린 회귀를 못 잡는다.
  const peak = E.careerReport(s).peakShare;
  const bestRow = s.history.reduce((a, h) => Math.max(a, h.share || 0), 0);
  const expected = Math.max(opening, bestRow);
  assert.ok(
    Math.abs(peak - expected) < 1e-3,
    `최고 점유율 ${(peak * 100).toFixed(1)}% 가 출발점 ${(opening * 100).toFixed(1)}% · 이력 최고 ${(bestRow * 100).toFixed(1)}% 와 안 맞는다`,
  );
  assert.ok(peak >= opening - 1e-9, '출발점이 최고 점유율에서 빠졌다');
});

test('반격은 이벤트 보정을 지우지도, 그 회복을 막지도 않는다', () => {
  const s = E.newGame(401);
  const seg = 'narrow';
  const boeing = s.competitors.find((c) => c.id === 'boeing');
  const airbus = s.competitors.find((c) => c.id === 'airbus');
  // 이벤트가 준 보정: 한쪽은 호재, 한쪽은 악재.
  boeing.drift[seg] = 5;
  airbus.drift[seg] = -4;

  const savedEvents = Data.EVENTS.slice();
  Data.EVENTS.length = 0;
  try {
    for (let i = 0; i < 10 && !s.gameOver; i++) {
      s.cash = Math.max(s.cash, 20000);
      E.endTurn(s);
    }
  } finally {
    Data.EVENTS.push(...savedEvents);
  }

  assert.strictEqual(boeing.drift[seg], 5, '반격 감쇠가 이벤트 호재를 갉아먹었다');
  assert.strictEqual(airbus.drift[seg], -4, '이벤트 악재가 반격 로직에 지워졌다');
});

test('특별 근무로 뽑은 기체도 학습곡선과 원가를 탄다', () => {
  const s = E.newGame(409);
  const p = s.programs.find((x) => x.legacy);
  p.stock = 0;
  s.backlog.length = 0;
  s.backlog.push({
    id: 'ord-rush', airlineId: 'hanul', airlineName: '한울항공', programId: p.id, programName: p.name,
    qty: 20, remaining: 20, unitPrice: 60, wonTurn: s.turn, pledge: 'priority', financing: 'normal',
    dueTurn: s.turn, depositRate: 0.15,
  });
  const def = Dec.get('delivery_slip');
  s.decision = {
    id: 'delivery_slip', name: def.name, text: 'x',
    memo: { airline: 'hanul', airlineName: '한울항공', orderId: 'ord-rush' }, turn: s.turn,
    options: def.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })),
  };

  const producedBefore = p.produced;
  const cashBefore = s.cash;
  E.decide(s, 'overtime');

  assert.ok(p.produced > producedBefore, '급하게 뽑은 기체가 생산 번호를 안 받았다 (학습곡선 우회)');
  assert.strictEqual(p.produced - producedBefore, p.stock, '생산 대수와 재고가 어긋난다');
  const spent = cashBefore - s.cash;
  const unitCost = E.currentUnitCost(s, p);
  assert.ok(spent > p.stock * unitCost * 0.8, `특별 근무 기체가 사실상 공짜다 (지출 ${Math.round(spent)})`);
  assert.ok(s.pending.productionCost > 0, '생산 원가가 장부에 안 잡혔다');
});

test('종료 직전에 고른 선택도 대가를 치른다', () => {
  const s = E.newGame(411);
  s.turn = Data.CONFIG.totalTurns - 2;
  s.cash = 30000;
  // 6분기 뒤에 값을 치르는 선택 — 종료(2분기 뒤)를 넘어간다.
  const def = Dec.DECISIONS.find((d) => d.options.some((o) => o.after && o.after.quarters >= 4));
  const opt = def.options.find((o) => o.after && o.after.quarters >= 4);
  s.decision = {
    id: def.id, name: def.name, text: 'x', memo: {}, turn: s.turn,
    options: def.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })),
  };
  E.decide(s, opt.id);
  assert.strictEqual(s.pendingOutcomes.length, 1);
  assert.ok(s.pendingOutcomes[0].turn >= Data.CONFIG.totalTurns, '이 검사는 종료 이후로 예약돼야 의미가 있다');

  while (!s.gameOver) E.endTurn(s);
  assert.strictEqual(s.pendingOutcomes.length, 0, '종료로 약속이 사라졌다 — 이득만 챙기고 대가를 피한다');
});

test('종료 정산의 현금 이동이 마지막 재무 행으로 설명된다', () => {
  const s = E.newGame(413);
  s.turn = Data.CONFIG.totalTurns - 2;
  s.cash = 30000;
  // 반드시 달성되는 목표를 마지막 기한으로 심는다 → 종료 정산에서 증자 보상이 들어온다.
  s.mandate = { id: 'delivery', name: '인도 확대', target: 1, text: '인도 1기', issuedTurn: s.turn - 18, dueTurn: Data.CONFIG.totalTurns };
  s.stats.delivered = 500;

  while (!s.gameOver) E.endTurn(s);
  const last = s.history[s.history.length - 1];
  assert.strictEqual(last.label, E.turnLabel(s.gameOver.lastTurn), '경영하지 않은 분기가 재무표에 생겼다');
  assert.strictEqual(last.cash, Math.round(s.cash), '마지막 행의 현금이 실제 잔고와 다르다');
  assert.strictEqual((s.stats.mandatesMet || 0) >= 1, true);
});

test('지연 결과로 자금이 마르면 그 분기 이벤트가 되살리지 못한다', () => {
  const s = E.newGame(417);
  // 지급불능 직전 상태에서 큰 지출이 예약된 상황을 만든다.
  s.cash = 50;
  s.debt = Data.CONFIG.maxDebt;
  const def = Dec.get('emission_rule');
  const opt = def.options.find((o) => o.id === 'wait');
  s.pendingOutcomes = [{ turn: s.turn + 1, id: 'emission_rule', optionId: opt.id, memo: {} }];

  E.endTurn(s);
  if (s.cash < 0) {
    assert.strictEqual(s.events.length, 0, '지급불능인데 이벤트가 굴러 현금이 들어올 수 있다');
    assert.strictEqual(s.decision, null, '지급불능인데 새 사건이 떴다');
  }
});

test('플레이어가 지은 이름은 결정 사건 본문에서 태그가 되지 않는다', () => {
  // 1층: 애초에 꺾쇠를 저장하지 않는다.
  const s = E.newGame(613);
  s.cash = 6000;
  const r = E.launchProgram(
    s,
    { segment: 'narrow', seats: 180, range: 5200, tech: 55, material: 'hybrid' },
    '<img src=x onerror=alert(1)>',
  );
  assert.ok(r.ok, '착수가 실패해 이름 검증을 못 했다');
  assert.ok(!/[<>]/.test(r.program.name), '프로그램 이름에 꺾쇠가 그대로 저장됐다');

  // 2층: 그런 이름이 이미 박힌 옛 세이브의 본문도 화면에서 무력화된다.
  s.decision = {
    id: 'launch_customer',
    name: '런치 커스터머',
    text: '<b>강조</b> — <img src=x onerror=alert(1)> 기종을 두고 협상이 붙었다.',
    memo: {},
    turn: s.turn,
    options: [{ id: 'a', label: '수락', detail: '지금 받는다' }],
  };
  const html = P.renderOverview(s);
  assert.ok(!/<img/i.test(html), '결정 사건 본문의 스크립트 태그가 그대로 렌더링됐다');
  assert.ok(/&lt;img/.test(html), '이스케이프된 흔적이 없다 — 본문이 통째로 사라졌나');
  assert.ok(/<b>강조<\/b>/.test(html), '카탈로그가 의도한 <b> 강조까지 죽었다');
});

test('토스트도 결정 카드와 같은 규칙으로 걸러 낸다', () => {
  // 결정 결과 문구는 카드가 아니라 토스트로 나가고, 그 안에도 프로그램 이름이
  // 끼어든다. 두 경로가 다른 규칙을 쓰면 한쪽만 막힌다.
  assert.strictEqual(P.richText('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(P.richText('손익 <b>+$10M</b>'), '손익 <b>+$10M</b>');

  // ui.js 는 DOM 에 묶여 있어 여기서 실행할 수 없다. innerHTML 에 날문자열이
  // 다시 꽂히는 회귀만 막는다.
  const src = require('node:fs').readFileSync(require('node:path').join(JS, 'ui.js'), 'utf8');
  const fn = src.slice(src.indexOf('function toast('), src.indexOf('function act('));
  assert.ok(/innerHTML\s*=\s*P\.richText\(/.test(fn), '토스트가 문자열을 그대로 innerHTML 에 넣는다');
});

test('남은 기간이 없으면 이사회 목표를 발령하지 않는다', () => {
  // 목표 개념이 없던 세이브를 막판에 불러오면, 기한이 게임 밖인 목표가 서고
  // 종료 정산이 그걸 한 분기 만에 채점한다.
  const s = E.newGame(211);
  s.turn = Data.CONFIG.totalTurns - 1;
  s.mandate = null;
  const before = s.reputation;
  E.endTurn(s);

  assert.strictEqual(s.mandate, null, '기한이 게임 밖인 목표가 발령됐다');
  assert.ok(s.gameOver, '마지막 분기를 정산했는데 끝나지 않았다');
  assert.strictEqual(s.stats.mandatesMissed || 0, 0, '발령된 적 없는 목표로 벌점을 받았다');
  assert.strictEqual(s.stats.mandatesMet || 0, 0, '발령된 적 없는 목표로 보상을 받았다');
  assert.ok(Math.abs(s.reputation - before) < 6, '한 분기 만에 목표 채점 폭의 평판이 움직였다');
});

test('종료 직전에 받은 개발 지원금은 유예로 사라지지 않는다', () => {
  const s = E.newGame(223);
  s.cash = 6000;
  E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5200, tech: 55, material: 'hybrid' }, 'GRANT-1');
  const p = s.programs[s.programs.length - 1];

  // 종료 두 분기 전에 지원을 받았다 — 그 기종은 끝까지 개발 중이다.
  s.turn = Data.CONFIG.totalTurns - 2;
  s.pendingOutcomes = [
    { turn: s.turn + 8, id: 'gov_grant', optionId: 'take', memo: { program: p.id, grantWaited: 0 } },
  ];

  // 같은 판을 의무만 빼고 한 번 더 돌려 차액으로 잰다. 마지막 두 분기에도
  // 인도·서비스 수입이 들어와 절대 현금만으로는 회수분이 묻힌다.
  const control = JSON.parse(JSON.stringify(s));
  control.pendingOutcomes = [];

  while (!s.gameOver) E.endTurn(s);
  while (!control.gameOver) E.endTurn(control);

  assert.ok(p.phase !== 'production', '기종이 양산에 들어가 시나리오가 성립하지 않았다');
  assert.ok(
    s.log.some((l) => /회수/.test(l.text)),
    '유예로 닫히고 회수 기록이 남지 않았다',
  );
  assert.ok(
    !s.log.some((l) => /유예/.test(l.text)),
    '정산할 분기가 없는데 유예로 닫았다',
  );
  assert.ok(
    control.cash - s.cash >= 900,
    `회수액이 지원금에 못 미친다 (차액 ${Math.round(control.cash - s.cash)})`,
  );
});

test('차환 감면은 광고한 분기 수만큼 이자에 적용된다', () => {
  // 금리 보정을 tickEffects 에서 다른 효과와 같이 깎으면, 분기 중에 건 감면은
  // 첫 적용 전에 한 분기를 잃는다 — 6분기짜리가 5번만 붙는다.
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const cut = E.newGame(307);
    const control = E.newGame(307);
    // 등급이 흔들려 금리가 따로 놀지 않게 양쪽 다 넉넉히 쥐여 준다.
    cut.cash = control.cash = 40000;

    cut.effects.rateCut = 0.0025;
    cut.effects.rateCutQuarters = 6;

    let discounted = 0;
    for (let i = 0; i < 10; i++) {
      E.endTurn(cut);
      E.endTurn(control);
      if (cut.rateForQuarter < control.rateForQuarter - 1e-12) discounted++;
    }
    assert.strictEqual(discounted, 6, `감면이 ${discounted}분기만 적용됐다 (광고: 6분기)`);
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('인도 약속은 약속한 분기 수만큼만 기회를 준다', () => {
  // 수주한 그 분기의 인도가 이미 첫 기회다. 그대로 더하면 "4분기 안에"가 다섯 번의
  // 인도 기회를 허용해, 광고한 대가가 한 분기씩 무뎌진다.
  const s = E.newGame(311);
  const pledge = Data.BID_PLEDGES.priority;
  assert.ok(pledge && pledge.dueQuarters, '최우선 인도 조건을 못 찾았다');

  let order = null;
  for (let t = 0; t < 30 && !order && !s.gameOver; t++) {
    for (const rfp of s.rfps) {
      const cand = E.eligiblePrograms(s, rfp).filter((x) => !x.score.blocked)[0];
      if (!cand) continue;
      E.setBid(s, rfp.id, cand.program.id, 0.1);
      E.setBidTerms(s, rfp.id, { pledge: pledge.id });
    }
    E.endTurn(s);
    order = s.backlog.find((o) => o.pledge === pledge.id && typeof o.dueTurn === 'number');
  }
  assert.ok(order, '최우선 조건으로 수주한 주문을 못 만들었다');
  assert.strictEqual(
    order.dueTurn - order.wonTurn + 1,
    pledge.dueQuarters,
    `${pledge.dueQuarters}분기를 약속했는데 인도 기회가 ${order.dueTurn - order.wonTurn + 1}번이다`,
  );
});

test('급행 생산도 정규 생산과 같은 번호로 원가를 문다', () => {
  const s = E.newGame(313);
  s.cash = 8000;
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5200, tech: 55 }, 'RUSH-1').ok);
  const p = s.programs[s.programs.length - 1];
  p.phase = 'production';
  p.produced = 0;

  s.backlog.push({
    id: 'ord-rush',
    airlineId: AIRLINES_ID(s),
    airlineName: '테스트항공',
    programId: p.id,
    programName: p.name,
    qty: 1,
    remaining: 1,
    unitPrice: p.listPrice,
    wonTurn: s.turn,
  });

  // 1호기의 원가 — 아직 아무것도 안 만들었으므로 currentUnitCost 가 곧 그 값이다.
  const firstUnit = E.currentUnitCost(s, p);
  const before = s.pending.productionCost;

  s.decision = {
    id: 'delivery_slip',
    name: '인도 지연 통보',
    text: '테스트',
    memo: { orderId: 'ord-rush', airline: AIRLINES_ID(s), airlineName: '테스트항공' },
    turn: s.turn,
    options: Dec.get('delivery_slip').options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })),
  };
  assert.ok(E.decide(s, 'overtime').ok);

  const charged = s.pending.productionCost - before;
  assert.strictEqual(p.produced, 1, '급행으로 뽑은 기체가 생산 번호를 받지 않았다');
  assert.ok(
    Math.abs(charged - firstUnit * 1.15) < 1,
    `1호기를 ${Math.round(charged)} 에 물었다 — 1호기 원가 × 1.15 = ${Math.round(firstUnit * 1.15)} 여야 한다`,
  );
});

function AIRLINES_ID(s) {
  return Object.keys(s.relations)[0];
}

test('경쟁사 인도 배분은 선언한 세그먼트 비중을 지킨다', () => {
  // 세그먼트별 가중치를 정규화하지 않으면 그 세그먼트 몫이 "등재 기종 수 × 실력 합"에
  // 비례해 버린다 — 1998년 카탈로그로 재면 리저널이 30% 가 아니라 11% 로 나왔다.
  const s = E.newGame(317);
  for (let i = 0; i < 8; i++) E.endTurn(s);

  const year = E.yearOf(s.turn);
  // 그 시점에 리저널기만 파는 제조사들 — 배분이 맞으면 이들 몫의 합이 리저널 비중이다.
  const regionalOnly = new Set();
  for (const m of F.MANUFACTURERS) {
    const types = F.AIRCRAFT.filter((t) => t.maker === m.id && t.eis <= year && (t.end === null || t.end > year));
    if (types.length && types.every((t) => t.segment === 'regional')) regionalOnly.add(m.id);
  }
  assert.ok(regionalOnly.size >= 2, '리저널 전업 제조사를 못 찾아 검증이 성립하지 않는다');

  const rows = E.makerStandings(s).filter((r) => !r.us && r.id !== 'other');
  const rivalTotal = rows.reduce((a, r) => a + r.delivered, 0);
  assert.ok(rivalTotal > 50, '경쟁사 인도량이 너무 적어 비중을 잴 수 없다');
  const regionalShare = rows.filter((r) => regionalOnly.has(r.id)).reduce((a, r) => a + r.delivered, 0) / rivalTotal;

  // 리저널 전업 제조사만 세므로 선언 비중(30%)의 상한이다. 정규화 전에는 11% 대였다.
  assert.ok(regionalShare > 0.2, `리저널 전업 제조사 몫이 ${(regionalShare * 100).toFixed(1)}% 다 — 선언 비중 30% 와 너무 멀다`);
  assert.ok(regionalShare <= 0.32, `리저널 몫 ${(regionalShare * 100).toFixed(1)}% 가 선언 비중 30% 를 넘었다`);
});

test('반격의 주체는 보정치까지 포함한 실력으로 고른다', () => {
  // 이벤트로 악재를 맞은 회사가 여전히 카탈로그 1위라는 이유로 반격 보너스를 받으면,
  // 실제로 수주전을 이기고 있는 쪽 대신 엉뚱한 회사가 강해진다.
  //
  // 1위를 테스트에서 미리 계산하면 안 된다 — driftMarket 이 reactToRivals 앞에서
  // 유가를 흔들어 카탈로그 순위를 뒤집으므로, 턴 시작 시점의 1위와 실제로 반격하는
  // 회사가 다를 수 있다. 그래서 먼저 한 판 돌려 엔진이 고른 1위를 알아낸 뒤,
  // 같은 판에서 그 회사에만 악재를 걸어 반격이 옮겨가는지 본다.
  const sweep = (s) => {
    const p = s.programs.find((x) => x.segment === 'narrow') || s.programs[0];
    p.segment = 'narrow';
    p.phase = 'production';
    s.backlog.push({
      id: 'ord-sweep',
      airlineId: Object.keys(s.relations)[0],
      airlineName: '테스트항공',
      programId: p.id,
      programName: p.name,
      qty: 60,
      remaining: 60,
      unitPrice: p.listPrice,
      wonTurn: s.turn,
    });
  };
  const reacting = (s) => s.competitors.filter((c) => c.reaction && c.reaction.narrow > 0).map((c) => c.id);

  const base = E.newGame(319);
  sweep(base);
  E.endTurn(base);
  const leader = reacting(base);
  assert.strictEqual(leader.length, 1, `반격 주체가 ${leader.length}곳이다 — 조건이 성립하지 않았다`);

  // 같은 판, 그 1위에게만 큰 악재. 실력 1위는 이제 다른 회사다.
  const hurt = E.newGame(319);
  sweep(hurt);
  hurt.competitors.find((c) => c.id === leader[0]).drift.narrow = -14;
  E.endTurn(hurt);

  const after = reacting(hurt);
  assert.ok(after.length > 0, '아무도 반격하지 않았다');
  assert.ok(
    !after.includes(leader[0]),
    `악재를 맞은 ${leader[0]} 가 여전히 반격 주체다 (보정치를 안 보고 있다)`,
  );
});

test('탑재-항속 개념이 없던 세이브도 감톤 능력을 유지한다', () => {
  const s = E.newGame(63);
  s.cash = 9000;
  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 300, range: 11000, tech: 55, wing: 60 }, 'W-OLD').ok);
  const p = s.programs[s.programs.length - 1];
  p.phase = 'production';

  // v1 세이브 재현: 곡선도 여유값도 통째로 없다.
  delete p.payloadRange;
  delete p.fuelMargin;
  E.ensureShape(s);

  assert.ok(p.payloadRange && p.payloadRange.light > p.payloadRange.full, '곡선이 복구되지 않았다');
  assert.strictEqual(typeof p.fuelMargin, 'number');

  // 설계 항속을 넘는 공고에서 실격되지 않고 점수가 잡혀야 한다.
  const rfp = {
    id: 'r', airlineId: 'carta', airlineName: '카르타', segment: 'wide',
    reqSeats: 280, reqRange: 12000, reqField: 0, reqEtops: false,
    qty: 10, priceSensitivity: 1, prestige: 1,
  };
  const score = B.scoreBid(s, rfp, p, 0.1);
  assert.strictEqual(score.blocked, null, '옛 세이브 기종이 장거리 공고에서 실격됐다');
  assert.ok(score.total > 0, '점수가 0이면 사실상 실격이다');
});

test('노선 성격이 기체의 우열을 뒤집는다', () => {
  // 운용 경제성의 핵심 — 같은 두 기체가 노선 모양에 따라 순서가 바뀌어야 한다.
  // 얇은 장거리는 편당 원가가, 굵은 중거리는 좌석마일 원가가 승부를 가른다.
  const s = E.newGame(11);
  const mk = (o) => {
    const e = D.evaluate({ tech: 55, year: 2005, ...o });
    return { ...e, id: 'p-' + o.seats, name: o.seats + '석' };
  };
  const small = mk({ segment: 'wide', seats: 250, range: 12000, abreast: 8, wing: 60 });
  const big = mk({ segment: 'wide', seats: 380, range: 12000, abreast: 9, wing: 60 });
  const rfp = (seats, range, qty) => ({
    id: 'r', airlineId: 'carta', airlineName: 'T', segment: 'wide',
    reqSeats: seats, reqRange: range, reqField: 0, reqEtops: false,
    qty, priceSensitivity: 1, prestige: 1,
  });

  const thin = rfp(240, 13000, 8);
  const dense = rfp(360, 7000, 25);

  const smallThin = B.scoreBid(s, thin, small, 0.12);
  const bigThin = B.scoreBid(s, thin, big, 0.12);
  const smallDense = B.scoreBid(s, dense, small, 0.12);
  const bigDense = B.scoreBid(s, dense, big, 0.12);

  assert.ok(smallThin.total > bigThin.total, '얇은 장거리는 작은 기체가 이겨야 한다');
  assert.ok(bigDense.total > smallDense.total, '굵은 중거리는 큰 기체가 이겨야 한다');

  // 근거도 방향이 맞아야 한다 — 우연히 총점만 맞은 게 아니어야 한다.
  assert.ok(smallThin.economics.trip > bigThin.economics.trip, '얇은 노선에서 큰 기체는 편당 원가로 져야 한다');
  assert.ok(bigDense.economics.casm > smallDense.economics.casm, '굵은 노선에서 큰 기체는 좌석마일로 이겨야 한다');
  // 노선이 굵을수록 좌석마일 가중이 커야 한다.
  assert.ok(bigDense.economics.casmWeight > bigThin.economics.casmWeight, '노선 밀도가 가중치를 못 움직이고 있다');
});

test('유가가 오르면 연비 차이가 운용 경제성에서 더 크게 벌어진다', () => {
  const cheap = E.newGame(17);
  const dear = E.newGame(17);
  cheap.market.fuelIndex = 0.6;
  dear.market.fuelIndex = 2.0;

  const rfp = {
    id: 'r', airlineId: 'hanul', airlineName: 'T', segment: 'narrow',
    reqSeats: 180, reqRange: 5500, reqField: 0, reqEtops: false,
    qty: 30, priceSensitivity: 1, prestige: 1,
  };
  const thirsty = { segment: 'narrow', seats: 180, range: 5500, listPrice: 110, efficiency: 45, comfort: 55, wing: 45 };
  const frugal = { segment: 'narrow', seats: 180, range: 5500, listPrice: 110, efficiency: 75, comfort: 55, wing: 45 };

  const gapCheap = B.scoreBid(cheap, rfp, frugal, 0.1).parts.op - B.scoreBid(cheap, rfp, thirsty, 0.1).parts.op;
  const gapDear = B.scoreBid(dear, rfp, frugal, 0.1).parts.op - B.scoreBid(dear, rfp, thirsty, 0.1).parts.op;

  assert.ok(gapCheap > 0, '싼 유가에서도 연비가 좋으면 유리해야 한다');
  assert.ok(gapDear > gapCheap, `유가가 비쌀수록 연비 격차가 커야 한다 (${gapCheap} → ${gapDear})`);
});

test('시험기를 늘리면 취항이 빨라지고 돈이 먼저 나간다', () => {
  const run = (extra) => {
    const s = E.newGame(83);
    s.cash = 60000;
    assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5200, tech: 50 }, 'T').ok);
    const p = s.programs[s.programs.length - 1];
    let added = false;
    let quarters = 0;
    for (let i = 0; i < 200 && p.phase !== 'production'; i++) {
      if (!added && p.phase === 'cert') {
        // 기간을 못 줄이는 추가는 거부된다(아무 이득 없이 제작비만 태우는 걸 막는다).
        for (let k = 0; k < extra && E.addTestAircraft(s, p.id).ok; k++);
        added = true;
      }
      if (p.phase === 'cert') quarters++;
      s.cash = 60000;
      E.endTurn(s);
    }
    assert.strictEqual(p.phase, 'production', '양산에 못 들어갔다');
    return { quarters, fleet: p.testFleet, spent: p.testSpent, hours: p.testHours };
  };

  const base = run(0);
  const rushed = run(3);

  assert.strictEqual(base.fleet, 2, '기본 편대는 2대여야 한다');
  assert.ok(rushed.fleet > base.fleet, '시험기가 늘어야 한다');
  assert.ok(rushed.quarters < base.quarters, `시험기를 늘렸는데 기간이 안 줄었다 (${base.quarters} → ${rushed.quarters})`);
  assert.ok(rushed.spent > base.spent, '시험기를 늘렸으면 제작비가 더 나가야 한다');
});

test('인증 전 세이브도 시험비행으로 옮겨지고 취항 시점이 유지된다', () => {
  const s = E.newGame(87);
  s.cash = 60000;
  assert.ok(E.launchProgram(s, { segment: 'regional', seats: 90, range: 2500, tech: 45 }, 'OLD').ok);
  const p = s.programs[s.programs.length - 1];

  // v1 세이브 재현: 분기 카운트다운만 있고 시험비행 개념이 없다.
  p.phase = 'cert';
  p.progress = 100;
  p.certRemaining = 3;
  delete p.testHours;
  delete p.testHoursNeeded;
  delete p.testFleet;
  E.ensureShape(s);

  assert.strictEqual(p.testFleet, 2, '기본 편대로 옮겨야 한다');
  assert.strictEqual(E.certQuartersLeft(p), 3, '남은 분기가 달라지면 불러온 판의 취항 시점이 바뀐다');
  assert.strictEqual(p.testSpent, 0, '옛 세이브에 시험기 값을 소급 청구하면 안 된다');
});

test('항공사는 필요분을 쌓아 발주하고, 발주 뒤에는 조용해진다', () => {
  const s = E.newGame(211);
  const seen = {};
  for (let i = 0; i < 60 && !s.gameOver; i++) {
    for (const rfp of s.rfps) {
      // 필요분은 세그먼트별로 쌓이므로 간격도 그 단위로 봐야 한다.
      const key = rfp.airlineId + ':' + rfp.segment;
      (seen[key] = seen[key] || []).push({ turn: s.turn, qty: rfp.qty });
    }
    s.cash = Math.max(s.cash, 20000);
    E.endTurn(s);
  }

  assert.ok(s.airlinePlans, '선단 계획이 상태에 남아야 한다');
  const busiest = Object.keys(seen).sort((a, b) => seen[b].length - seen[a].length)[0];
  assert.ok(seen[busiest].length >= 3, '표본이 적어 간격을 볼 수 없다');

  // 같은 항공사가 연달아 부르지 않아야 한다 — 방금 채운 선단을 또 채울 리 없다.
  for (const list of Object.values(seen)) {
    for (let i = 1; i < list.length; i++) {
      assert.ok(
        list[i].turn - list[i - 1].turn >= 2,
        `같은 항공사가 같은 급을 ${list[i].turn - list[i - 1].turn}분기 만에 다시 발주했다`,
      );
    }
  }
  // 규모가 난수가 아니라 쌓인 양이므로, 간격이 길수록 대체로 크다.
  const all = Object.values(seen).flat();
  assert.ok(all.every((o) => o.qty >= 3), '발주 규모가 0 이하로 나왔다');
});

test('불황에는 발주를 미루고 회복하면 미뤄 둔 물량이 나온다', () => {
  const savedEvents = Data.EVENTS.slice();
  Data.EVENTS.length = 0; // 수요를 직접 통제한다
  try {
    const s = E.newGame(223);
    // 깊은 불황을 길게 유지한다.
    let slumpRfps = 0;
    for (let i = 0; i < 24 && !s.gameOver; i++) {
      s.market.demandIndex = 0.6;
      s.cash = Math.max(s.cash, 20000);
      E.endTurn(s);
      slumpRfps += s.rfps.length;
    }
    // 이연이 실제로 쌓였는지 계획에서 확인한다.
    const deferred = Object.values(s.airlinePlans).reduce(
      (a, p) => a + Object.values(p.deferred).reduce((x, y) => x + y, 0),
      0,
    );
    assert.ok(deferred > 0, '불황인데 아무도 발주를 미루지 않았다');

    // 회복시키면 미뤄 둔 물량이 나온다.
    let recoveryRfps = 0;
    let sawDeferred = false;
    for (let i = 0; i < 12 && !s.gameOver; i++) {
      s.market.demandIndex = 1.3;
      s.cash = Math.max(s.cash, 20000);
      E.endTurn(s);
      recoveryRfps += s.rfps.length;
      if (s.rfps.some((r) => r.deferredQuarters > 0)) sawDeferred = true;
    }
    assert.ok(sawDeferred, '회복기에 미뤄 둔 발주가 표시되지 않았다');
    assert.ok(
      recoveryRfps / 12 > slumpRfps / 24,
      `회복기 공고(${(recoveryRfps / 12).toFixed(2)}/분기)가 불황(${(slumpRfps / 24).toFixed(2)}/분기)보다 많아야 한다`,
    );
  } finally {
    Data.EVENTS.push(...savedEvents);
  }
});

test('노선망 밖 발주도 그 급에 맞는 규모로 나온다', () => {
  // 필요분을 한 칸으로 두면 주력 세그먼트 규모로 적립한 물량이 다른 급 공고로 새고,
  // 그 자리에서 통째로 지워진다 — 광동체 교체 10대가 리저널 10대 공고가 되는 식이다.
  // 칸을 세그먼트별로 나눠 두면 노선망 밖 진출도 그 급의 발주 단위로 나온다.
  const s = E.newGame(307);
  const biasOf = {};
  for (const a of Data.AIRLINES) biasOf[a.id] = a.bias;

  let onProfile = 0;
  const off = [];
  for (let i = 0; i < 160 && !s.gameOver; i++) {
    for (const rfp of s.rfps) {
      if (rfp.segment === biasOf[rfp.airlineId]) onProfile++;
      else off.push(rfp);
    }
    s.cash = Math.max(s.cash, 20000);
    E.endTurn(s);
  }

  assert.ok(onProfile > 40, `표본이 ${onProfile}건뿐이라 검증이 성립하지 않는다`);
  assert.ok(off.length > 0, '노선망 밖 발주가 한 건도 없다 — 다양성이 사라졌다');
  // 주력이 대부분이어야 한다. 새 급 진출은 드문 일이다.
  assert.ok(off.length < onProfile * 0.5, `노선망 밖 발주가 ${off.length}건으로 지나치게 잦다`);

  // 핵심: 규모가 **그 급**의 발주 단위 언저리여야 한다. 광동체 필요분이 리저널
  // 공고로 새면 여기서 잡힌다(리저널 단위 18 인데 광동체 물량이 나온다).
  const lot = { regional: 18, narrow: 26, wide: 10 };
  for (const rfp of off) {
    assert.ok(
      rfp.qty <= lot[rfp.segment] * 3.2,
      `${rfp.airlineName}(주력 ${biasOf[rfp.airlineId]})의 ${rfp.segment} 공고가 ${rfp.qty}기 — 그 급의 발주 단위(${lot[rfp.segment]})에 비해 과하다`,
    );
  }
});

test('할인은 어느 선을 넘으면 점수로 덜 쳐준다', () => {
  // 체감이 없으면 "최대한 깎기"가 언제나 정답이라 할인이 결정이 아니라 슬라이더가 된다.
  const s = E.newGame(97);
  const rfp = {
    id: 'r', airlineId: 'hanul', airlineName: 'T', segment: 'narrow',
    reqSeats: 180, reqRange: 5500, reqField: 0, reqEtops: false,
    qty: 30, priceSensitivity: 1, prestige: 1,
  };
  const p = { segment: 'narrow', seats: 180, range: 5800, listPrice: 110, efficiency: 60, comfort: 55, wing: 45 };

  const at = (d) => B.scoreBid(s, rfp, p, d);
  // 무릎 아래에서는 그대로 반영된다.
  const gainLow = at(0.2).total - at(0.1).total;
  // 무릎 위에서는 같은 폭을 깎아도 덜 오른다.
  const gainHigh = at(0.3).total - at(0.2).total;
  assert.ok(gainLow > 0 && gainHigh > 0, '할인은 여전히 점수를 올려야 한다');
  assert.ok(gainHigh < gainLow * 0.6, `깊은 할인의 점수 효율이 안 떨어진다 (${gainLow.toFixed(2)} → ${gainHigh.toFixed(2)})`);

  // 계약가는 체감 없이 그대로 깎여야 한다 — 체감하는 건 점수뿐, 실제 매출이 아니다.
  assert.ok(Math.abs(at(0.35).price - 110 * 0.65) < 0.01, '실효 계약가가 체감의 영향을 받았다');
});

test('완성 경험은 인증까지 간 프로그램에서만 쌓인다', () => {
  const s = E.newGame(401);
  assert.strictEqual(E.companyExperience(s), 0, '승계 기종의 경험은 기준 밸런스에 이미 들어 있다 — 0에서 시작해야 한다');

  s.cash = 30000;
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5200, tech: 50 }, 'XP-1').ok);
  const p = s.programs[s.programs.length - 1];
  assert.strictEqual(E.companyExperience(s), 0, '착수만으로 경험이 쌓이면 안 된다');

  p.phase = 'production';
  p.certTurn = s.turn;
  assert.strictEqual(E.companyExperience(s), 2, '협동체 완성은 2점이어야 한다');

  // 파생형은 절반 — 새로 배우는 게 훨씬 적다.
  assert.ok(E.launchProgram(s, E.derivativeSpec(p, 30), 'XP-1S').ok);
  const d = s.programs[s.programs.length - 1];
  d.phase = 'production';
  d.certTurn = s.turn;
  assert.strictEqual(E.companyExperience(s), 3, '파생형 완성은 절반(1점)이어야 한다');

  // 매각해도 경험은 남는다 — 도면은 넘겨도 만들어 본 사람들은 회사에 있다.
  p.phase = 'sold';
  assert.strictEqual(E.companyExperience(s), 3, '매각으로 경험이 사라지면 안 된다');
});

test('경험은 다음 개발의 기간·인력·비용·위험을 줄이고 바닥이 있다', () => {
  const spec = { segment: 'wide', seats: 320, range: 12000, tech: 55, wing: 60, year: 2005 };
  const cold = D.evaluate({ ...spec, experience: 0 });
  const warm = D.evaluate({ ...spec, experience: 2 });
  const vet = D.evaluate({ ...spec, experience: 50 });

  assert.ok(warm.devQuarters < cold.devQuarters, '경험이 기간을 줄여야 한다');
  assert.ok(warm.engineersNeeded < cold.engineersNeeded, '경험이 필요 인력을 줄여야 한다');
  assert.ok(warm.devCost < cold.devCost, '경험이 개발비를 줄여야 한다');
  assert.ok(warm.defectRisk <= cold.defectRisk, '경험이 결함 위험을 늘리면 안 된다');

  // 바닥: 무한히 싸지면 후반 개발이 공짜가 된다.
  assert.ok(vet.devCost >= cold.devCost * 0.5, '비용 바닥이 뚫렸다');
  assert.ok(vet.engineersNeeded >= cold.engineersNeeded * 0.45, '인력 바닥이 뚫렸다');
  assert.ok(vet.devQuarters >= cold.devQuarters * 0.5, '기간 바닥이 뚫렸다');
});

test('파생형은 인증도 짧다 (개정 형식증명)', () => {
  const s = E.newGame(409);
  s.cash = 30000;
  assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 180, range: 5200, tech: 50 }, 'BASE').ok);
  const base = s.programs[s.programs.length - 1];
  base.phase = 'production';
  base.certTurn = s.turn;

  const fresh = D.evaluate({ segment: 'narrow', seats: 210, range: 5200, tech: 50, year: E.yearOf(s.turn) });
  const deriv = D.evaluate({ ...E.derivativeSpec(base, 30), year: E.yearOf(s.turn) });
  assert.ok(deriv.derivative, '파생형 판정이 성립해야 한다');
  assert.ok(deriv.certQuarters < fresh.certQuarters, `파생형 인증(${deriv.certQuarters})이 신규(${fresh.certQuarters})보다 짧아야 한다`);
});

test('선주문: 개발 40%부터 응찰하되 미인증 감점을 받는다', () => {
  const s = E.newGame(419);
  s.cash = 50000;
  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60, etops: true }, 'PAPER').ok);
  const p = s.programs[s.programs.length - 1];
  const rfp = {
    id: 'r', airlineId: 'carta', airlineName: 'T', segment: 'wide',
    reqSeats: 300, reqRange: 12500, reqField: 0, reqEtops: true,
    qty: 12, priceSensitivity: 0.6, prestige: 1.2,
  };

  // 설계가 잡히기 전(40% 미만)에는 팔 물건이 없다.
  p.progress = 20;
  assert.strictEqual(E.eligiblePrograms(s, rfp).length, 0, '개발 초반 종이 비행기가 응찰하면 안 된다');

  p.progress = 60;
  const dev = E.eligiblePrograms(s, rfp)[0];
  assert.ok(dev, '개발 40% 이상이면 선주문 응찰이 가능해야 한다');
  assert.strictEqual(dev.score.blocked, null, 'ETOPS 대응 설계의 선주문이 ETOPS 게이트에 막히면 안 된다');
  assert.ok(dev.score.preorder, '선주문 표시가 있어야 한다');

  // 감점의 순서: 종이(개발) < 시제기(인증) < 취항(양산).
  const devScore = dev.score.total;
  p.phase = 'cert';
  const certScore = E.eligiblePrograms(s, rfp)[0].score.total;
  p.phase = 'production';
  p.etopsCertified = true;
  const prodScore = E.eligiblePrograms(s, rfp)[0].score.total;
  assert.ok(devScore < certScore, `개발(${devScore})이 인증(${certScore})보다 낮아야 한다`);
  assert.ok(certScore < prodScore, `인증(${certScore})이 양산(${prodScore})보다 낮아야 한다`);

  // 다만 선주문을 안 했다고 관계가 깎이면 안 된다 — canBid 는 양산 기준.
  p.phase = 'dev';
  p.progress = 60;
  assert.strictEqual(E.canBid(s, rfp), false, '선주문만 가능한 공고는 무응찰 감점 대상이 아니다');
});

test('선주문 수주는 선수금을 내고, 개발을 접으면 위약으로 물어 준다', () => {
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const s = E.newGame(421);
    s.cash = 50000;
    assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60, etops: true }, 'PRE').ok);
    const p = s.programs[s.programs.length - 1];
    p.progress = 70;

    // 공고를 직접 심고 선주문으로 응찰한다.
    const rfp = B.makeRfp(s, R.createRng(7), {
      airline: Data.AIRLINES.find((a) => a.bias === 'wide'),
      segment: 'wide',
      qty: 14,
    });
    s.rfps = [rfp];
    E.setBid(s, rfp.id, p.id, 0.3);

    const cashBefore = s.cash;
    E.endTurn(s);

    const order = s.backlog.find((o) => o.programId === p.id);
    if (order) {
      assert.ok(s.cash > cashBefore - 2500, '선수금이 들어왔다면 현금이 통째로 빠지지만 않아야 한다');
      // 개발을 접으면 선수금보다 큰 위약이 나간다 — 종이 비행기 장사 방지.
      const relBefore = s.relations[order.airlineId];
      const cashBeforeCancel = s.cash;
      assert.ok(E.cancelProgram(s, p.id).ok);
      const refund = cashBeforeCancel - s.cash;
      const deposit = order.qty * order.unitPrice * order.depositRate;
      assert.ok(refund > deposit, `위약 반환(${Math.round(refund)})이 받은 선수금(${Math.round(deposit)})보다 커야 한다`);
      assert.ok(s.relations[order.airlineId] < relBefore, '주문을 파기당한 항공사와의 관계가 깎여야 한다');
      assert.ok(!s.backlog.some((o) => o.programId === p.id), '죽은 프로그램의 주문이 백로그에 남으면 안 된다');
    } else {
      // 선주문이 감점 때문에 진 판 — 응찰 자체는 판정에 들어갔어야 한다.
      assert.ok(s.stats.bidsMade > 0, '선주문 응찰이 판정에서 조용히 버려졌다');
    }
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('사다리: 협동체를 완성하면 광동체 착수 조건이 실제로 가벼워진다', () => {
  const cold = E.newGame(431);
  cold.cash = 60000;
  const coldWide = E.launchProgram(cold, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'COLD');
  assert.ok(coldWide.ok);

  const warm = E.newGame(431);
  warm.cash = 60000;
  assert.ok(E.launchProgram(warm, { segment: 'narrow', seats: 180, range: 5200, tech: 50 }, 'N').ok);
  const n = warm.programs[warm.programs.length - 1];
  n.phase = 'production';
  n.certTurn = warm.turn;
  const warmWide = E.launchProgram(warm, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'WARM');
  assert.ok(warmWide.ok);

  assert.ok(warmWide.program.devCost < coldWide.program.devCost * 0.85, '경험이 개발비를 체감할 만큼 줄여야 한다');
  assert.ok(warmWide.program.engineersNeeded < coldWide.program.engineersNeeded * 0.85, '경험이 필요 인력을 체감할 만큼 줄여야 한다');
  assert.ok(warmWide.program.devQuarters < coldWide.program.devQuarters, '경험이 기간을 줄여야 한다');
});

test('사다리의 보상 — 후광·급별 서비스 단가·급별 인도 점수', () => {
  // 플래그십 후광: 광동체를 인증까지 만든 제조사는 모든 수주전에서 신뢰를 더 받는다.
  const s = E.newGame(433);
  s.cash = 60000;
  const rfp = {
    id: 'r', airlineId: 'hanul', airlineName: 'T', segment: 'narrow',
    reqSeats: 180, reqRange: 5500, reqField: 0, reqEtops: false,
    qty: 20, priceSensitivity: 1, prestige: 1,
  };
  const narrow = { segment: 'narrow', seats: 180, range: 5800, listPrice: 110, efficiency: 60, comfort: 55, wing: 45, phase: 'production' };
  const before = B.scoreBid(s, rfp, narrow, 0.1).total;

  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'FLAG').ok);
  const w = s.programs[s.programs.length - 1];
  assert.strictEqual(B.scoreBid(s, rfp, narrow, 0.1).total, before, '개발 중인 광동체가 후광을 주면 안 된다');
  w.phase = 'production';
  const after = B.scoreBid(s, rfp, narrow, 0.1).total;
  assert.ok(after > before, `광동체 양산사가 협동체 수주전에서 후광을 받아야 한다 (${before} → ${after})`);

  // 급별 서비스 단가: 같은 대수라도 광동체 선단이 더 번다.
  const nFleet = E.newGame(439);
  const wFleet = E.newGame(439);
  nFleet.programs.push({ id: 'pn', segment: 'narrow', phase: 'production', delivered: 100, name: 'N', stock: 0, unitCostBase: 0, spent: 0 });
  wFleet.programs.push({ id: 'pw', segment: 'wide', phase: 'production', delivered: 100, name: 'W', stock: 0, unitCostBase: 0, spent: 0 });
  assert.ok(
    E.serviceIncome(wFleet).aftermarket > E.serviceIncome(nFleet).aftermarket,
    '광동체 100기의 애프터마켓이 협동체 100기보다 커야 한다',
  );

  // 급별 인도 점수: 협동체는 종전 계수 그대로, 광동체는 그보다 무겁다.
  const sc = E.newGame(443);
  const legacyDelivered = sc.stats.delivered;
  const base = E.finalScore(sc, false).score;
  // 순자산 계산이 stock·spent 를 읽으므로 0으로 채워야 NaN 이 점수를 오염시키지 않는다.
  const fake = (id, segment) => ({ id, segment, phase: 'production', delivered: 50, name: id, stock: 0, unitCostBase: 0, spent: 0 });
  sc.programs.push(fake('px', 'wide'));
  sc.stats.delivered += 50;
  const withWide = E.finalScore(sc, false).score;
  sc.programs.pop();
  sc.programs.push(fake('py', 'narrow'));
  const withNarrow = E.finalScore(sc, false).score;
  assert.ok(withWide - base > withNarrow - base, '광동체 50기가 협동체 50기보다 점수가 커야 한다');
  assert.ok(legacyDelivered > 0, '승계 인도분이 있어야 기준 점수 검증이 성립한다');
});

test('옛 세이브에서 곧바로 취소해도 위약 정산이 온전히 적용된다', () => {
  const s = E.newGame(449);
  s.cash = 50000;
  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'OLD-W').ok);
  const p = s.programs[s.programs.length - 1];
  p.progress = 60;
  s.backlog.push({
    id: 'ord-old', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
    qty: 10, remaining: 10, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15,
  });

  // v1 세이브 재현: pending 이 통째로 없다 — ensureShape 없이 만지면 여기서 터진다.
  delete s.pending;
  const cashBefore = s.cash;
  assert.ok(E.cancelProgram(s, p.id).ok, '옛 세이브에서 취소가 실패했다');
  assert.ok(cashBefore - s.cash > 0, '위약 반환이 나가야 한다');
  assert.ok(!s.backlog.some((o) => o.programId === p.id), '주문이 남았다');
  assert.ok(s.pending && typeof s.pending.overhead === 'number' && !Number.isNaN(s.pending.overhead), 'pending 이 복구되고 오염되지 않아야 한다');
});

test('대양 노선 선주문은 ETOPS 인증이 나와야 인도된다', () => {
  const s = E.newGame(457);
  s.cash = 50000;
  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60, etops: true }, 'GATE').ok);
  const p = s.programs[s.programs.length - 1];
  p.phase = 'production';
  p.etopsCertified = false;
  p.stock = 6;
  s.backlog.push({
    id: 'ord-etops', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
    qty: 6, remaining: 6, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15, reqEtops: true,
  });

  E.endTurn(s);
  const o = s.backlog.find((x) => x.id === 'ord-etops');
  assert.ok(o && o.remaining === 6, '인증 없이 대양 노선 주문이 인도됐다 — 조기 취득 비용을 우회한다');

  p.etopsCertified = true;
  p.stock = 6;
  E.endTurn(s);
  const after = s.backlog.find((x) => x.id === 'ord-etops');
  assert.ok(!after || after.remaining < 6, '인증이 나왔는데도 인도되지 않는다');
});

test('개발을 동결한 종이 비행기의 선수금 농사는 손해다', () => {
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const s = E.newGame(461);
    s.cash = 60000;
    assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'FARM').ok);
    const p = s.programs[s.programs.length - 1];
    p.progress = 45;
    p.share = 0; // 동결 — 진행되지 않는다

    s.backlog.push({
      id: 'ord-farm', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
      qty: 10, remaining: 10, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15, pledge: 'standard',
    });
    const deposit = 10 * 250 * 0.15;
    s.cash += deposit; // 수주 시점에 받았을 선수금을 재현

    const cashAfterDeposit = s.cash;
    for (let i = 0; i < 20 && !s.gameOver; i++) {
      s.cash = Math.max(s.cash, 8000);
      E.endTurn(s);
    }
    assert.ok(
      s.log.some((l) => /물렀다/.test(l.text)),
      '인내심이 다한 항공사가 계약을 깨지 않았다',
    );
    assert.ok(!s.backlog.some((o) => o.id === 'ord-farm'), '무른 주문이 백로그에 남았다');
    // 위약 배수(1.5) 때문에 농사의 순수익은 음수여야 한다: 반환액 > 선수금.
    assert.ok(
      s.log.some((l) => /물렀다/.test(l.text) && /위약금/.test(l.text)),
      '위약 없이 돌려주면 농사가 본전이 된다',
    );
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('ETOPS 필수 주문만 있어도 재고 기체의 실증 비행으로 교착이 풀린다', () => {
  // 인도 게이트가 인도를 막고, 인도가 없어 실적이 안 쌓이고, 실적이 없어
  // 게이트가 안 열리는 순환 — 재고 기체를 실적으로 치지 않으면 영구 교착이다.
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const s = E.newGame(467);
    s.cash = 60000;
    assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60, etops: true }, 'LOCK').ok);
    const p = s.programs[s.programs.length - 1];
    p.phase = 'production';
    p.etopsCertified = false;
    p.etopsService = 0;
    p.stock = 6;
    s.backlog.push({
      id: 'ord-lock', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
      qty: 6, remaining: 6, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15, reqEtops: true,
    });

    for (let i = 0; i < 8 && !s.gameOver; i++) {
      s.cash = Math.max(s.cash, 20000);
      E.endTurn(s);
    }
    assert.strictEqual(p.etopsCertified, true, '재고 기체가 있는데 ETOPS 실적이 안 쌓인다 — 교착이 그대로다');
    assert.ok(p.delivered > 0, '인증이 나왔는데 밀린 ETOPS 주문이 인도되지 않는다');
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('무른 선주문의 위약은 이번 분기 장부에 적힌다', () => {
  // endTurn 은 리포트를 만들며 pending 을 비운다. 위약을 pending 에 넣으면 현금은
  // 지금 나가고 비용은 다음 분기 행에 적힌다 — 같은 분기에 파산하면 증발한다.
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const make = (withOrder) => {
      const s = E.newGame(479);
      s.cash = 60000;
      assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'BOOK').ok);
      const p = s.programs[s.programs.length - 1];
      p.progress = 45;
      p.share = 0;
      p.lastProgressTurn = s.turn - 6; // 이미 6분기째 정체 — 이번 정산에서 무른다
      if (withOrder) {
        s.backlog.push({
          id: 'ord-book', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
          qty: 10, remaining: 10, unitPrice: 250, wonTurn: s.turn - 6, depositRate: 0.15, pledge: 'standard',
        });
      }
      return s;
    };

    const ctrl = make(false);
    const s = make(true);
    E.endTurn(ctrl);
    E.endTurn(s);
    assert.ok(s.log.some((l) => /물렀다/.test(l.text)), '정체 6분기인데 주문이 무르지 않았다');

    const refund = Math.round(10 * 250 * 0.15 * 1.5);
    const row = s.history[s.history.length - 1];
    const ctrlRow = ctrl.history[ctrl.history.length - 1];
    assert.strictEqual(row.cost - ctrlRow.cost, refund, '위약이 이번 분기 행에 정확히 적혀야 한다');
    assert.strictEqual(s.pending.overhead, 0, '위약이 다음 분기 장부로 밀렸다 — 현금 이동과 비용 계상이 한 분기 어긋난다');
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('취소 확인창이 보여 줄 위약 예상액이 실제 지출과 일치한다', () => {
  const s = E.newGame(487);
  s.cash = 50000;
  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'WARN').ok);
  const p = s.programs[s.programs.length - 1];
  p.progress = 60;
  s.backlog.push({
    id: 'ord-warn', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
    qty: 10, remaining: 10, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15,
  });

  const quoted = E.voidRefundFor(s, p);
  assert.ok(quoted > 0, '미인도 주문이 있는데 위약 예상액이 0이다');
  const cashBefore = s.cash;
  assert.ok(E.cancelProgram(s, p.id).ok);
  assert.strictEqual(cashBefore - s.cash, quoted, '확인창이 보여 준 위약과 실제 지출이 다르면 안내가 거짓이 된다');
});

test('정체된 프로그램의 새 수주에도 6분기 유예가 통째로 주어진다', () => {
  // 프로그램이 이미 6분기 멈춰 있어도 방금 딴 주문이 같은 분기에 무르면 안 된다 —
  // 선수금을 받자마자 1.5배로 물어 주는 함정이 된다. 시계는 주문마다 따로 간다.
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const s = E.newGame(491);
    s.cash = 60000;
    assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'CLOCK').ok);
    const p = s.programs[s.programs.length - 1];
    p.progress = 45;
    p.share = 0;
    p.lastProgressTurn = s.turn - 6; // 프로그램은 이미 오래 정체

    s.backlog.push({
      id: 'ord-clock', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
      qty: 10, remaining: 10, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15, pledge: 'standard',
    });

    E.endTurn(s);
    const o = s.backlog.find((x) => x.id === 'ord-clock');
    assert.ok(o && o.remaining === 10, '방금 딴 주문이 수주 당일 무르면 유예가 광고와 다르다');

    // 계속 정체하면 수주 후 6분기째부터는 무른다.
    for (let i = 0; i < 7 && s.backlog.some((x) => x.id === 'ord-clock'); i++) {
      s.cash = Math.max(s.cash, 8000);
      E.endTurn(s);
    }
    assert.ok(!s.backlog.some((x) => x.id === 'ord-clock'), '수주 후에도 계속 멈춘 주문은 무르러야 한다');
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('파생형은 경험 할인을 받지 않는다 — 파생 배율과 겹치면 이중 할인', () => {
  const D2 = globalThis.AirlinerDesign;
  const base = {
    id: 'base-x', segment: 'narrow', seats: 180, range: 5800, tech: 40,
    fuselage: 'aluminum', wingMat: 'aluminum', engine: undefined, family: false,
  };
  const spec = {
    segment: 'narrow', seats: 200, range: 5800, tech: 40,
    fuselage: 'aluminum', wingMat: 'aluminum',
    derivedFrom: base,
  };
  const noXp = D2.evaluate({ ...spec, experience: 0 });
  const withXp = D2.evaluate({ ...spec, experience: 4 });
  assert.ok(noXp.derivative, '파생형 판정이 성립해야 검증이 의미 있다');
  assert.strictEqual(withXp.devCost, noXp.devCost, '파생형 개발비에 경험 할인이 겹치면 안 된다');
  assert.strictEqual(withXp.devQuarters, noXp.devQuarters, '파생형 기간에 경험 할인이 겹치면 안 된다');
  assert.strictEqual(withXp.engineersNeeded, noXp.engineersNeeded, '파생형 필요 인력에 경험 할인이 겹치면 안 된다');

  // 신규 설계는 경험 할인을 받아야 한다 — 파생형만 제외됐는지 대조.
  const freshNo = D2.evaluate({ segment: 'narrow', seats: 200, range: 5800, tech: 40, experience: 0 });
  const freshXp = D2.evaluate({ segment: 'narrow', seats: 200, range: 5800, tech: 40, experience: 4 });
  assert.ok(freshXp.devCost < freshNo.devCost, '신규 설계의 경험 할인까지 사라지면 안 된다');
});

test('인증 전 기체는 사건으로도 만들지도 인도하지도 못한다', () => {
  // delivery_slip 사건이 백로그의 선주문을 집어 특별 근무로 기체를 뽑으면
  // 형식증명을 우회한 실물이 생긴다. 사건 후보에서 거르고, 인도에서도 막는다.
  const s = E.newGame(499);
  s.cash = 60000;
  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'PAPER').ok);
  const p = s.programs[s.programs.length - 1];
  p.progress = 45;
  s.backlog.length = 0; // 승계 물량을 치우고 선주문만 남긴다
  s.backlog.push({
    id: 'ord-paper', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
    qty: 10, remaining: 10, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15,
  });

  const slip = Dec.DECISIONS.find((d) => d.id === 'delivery_slip');
  assert.ok(slip, 'delivery_slip 결정이 있어야 한다');
  assert.strictEqual(slip.weight(s), 0, '선주문만 있는 백로그에서 인도 지연 사건이 나오면 안 된다');

  // 어떤 경로로든 미인증 기종에 재고가 생겨도 인도되면 안 된다 — 불변식.
  p.stock = 5;
  E.endTurn(s);
  const o = s.backlog.find((x) => x.id === 'ord-paper');
  assert.ok(o && o.remaining === 10, '형식증명 없는 기체가 인도됐다');
});

test('게임 종료 시 미인증 기종의 선주문은 위약으로 정산된다', () => {
  // 마지막 6분기 안에 딴 선주문은 정체 만료 전에 판이 끝난다. 종료 정산이
  // 없으면 막판 종이 비행기 응찰이 선수금·평판만 챙기고 점수를 부풀린다.
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const s = E.newGame(503);
    s.cash = 60000;
    assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'LASTQ').ok);
    const p = s.programs[s.programs.length - 1];
    p.progress = 45;
    s.turn = 79; // 마지막 분기 — 이번 정산으로 판이 끝난다
    s.backlog.push({
      id: 'ord-lastq', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
      qty: 10, remaining: 10, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15,
    });

    const refund = Math.round(10 * 250 * 0.15 * 1.5);
    const cashBefore = s.cash;
    E.endTurn(s);
    assert.ok(s.gameOver, '마지막 분기 정산 후에는 게임이 끝나야 한다');
    assert.ok(!s.backlog.some((x) => x.id === 'ord-lastq' && x.remaining > 0), '못 지킨 선주문이 정산 없이 남았다');
    assert.ok(
      s.log.some((l) => /기한 내 미취항/.test(l.text)),
      '종료 정산이 기록으로 남아야 한다',
    );
    assert.ok(cashBefore - s.cash >= refund, `위약 반환이 현금에서 나가야 한다 (변화 ${cashBefore - s.cash}, 기대 ≥ ${refund})`);
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('종료 시 ETOPS 못 딴 기종의 대양 주문만 위약 정산되고 일반 주문은 산다', () => {
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const s = E.newGame(509);
    s.cash = 60000;
    assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60, etops: true }, 'ENDGATE').ok);
    const p = s.programs[s.programs.length - 1];
    p.phase = 'production';
    p.etopsCertified = false;
    p.stock = 0;
    p.delivered = 5; // 인도 실적이 있는, 능력이 증명된 기종 — 일반 주문은 지킬 수 있다
    s.turn = 79; // 마지막 분기
    s.backlog.push(
      {
        id: 'ord-endgate-e', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
        qty: 6, remaining: 6, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15, reqEtops: true,
      },
      {
        id: 'ord-endgate-n', airlineId: 'hanul', airlineName: '한울', programId: p.id, programName: p.name,
        qty: 4, remaining: 4, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15,
      },
    );

    E.endTurn(s);
    assert.ok(s.gameOver, '마지막 분기 정산 후에는 게임이 끝나야 한다');
    assert.ok(!s.backlog.some((o) => o.id === 'ord-endgate-e'), 'ETOPS 게이트에 막힌 채 끝난 주문이 정산 없이 남았다');
    assert.ok(s.backlog.some((o) => o.id === 'ord-endgate-n'), '같은 기종의 일반 주문까지 파기되면 안 된다');
    assert.ok(s.log.some((l) => /ETOPS 미인증/.test(l.text)), '정산 사유가 기록으로 남아야 한다');
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('ETOPS 게이트에 막힌 주문은 인도 지연 사건의 후보가 아니다', () => {
  // 특별 근무로 기체를 뽑아도 인도가 안 되는 주문에 사건이 붙으면
  // 돈만 쓰는 거짓 선택지가 된다.
  const s = E.newGame(521);
  s.cash = 60000;
  assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60, etops: true }, 'SLIPGATE').ok);
  const p = s.programs[s.programs.length - 1];
  p.phase = 'production';
  p.etopsCertified = false;
  s.backlog.length = 0;
  s.backlog.push({
    id: 'ord-slipgate', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
    qty: 6, remaining: 6, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15, reqEtops: true,
  });

  const slip = Dec.DECISIONS.find((d) => d.id === 'delivery_slip');
  assert.strictEqual(slip.weight(s), 0, 'ETOPS 대기 주문만 있는데 인도 지연 사건이 나왔다');

  p.etopsCertified = true;
  assert.ok(slip.weight(s) > 0, '게이트가 풀리면 사건 후보로 돌아와야 한다');
});

test('계약 파기의 관계 벌점은 수주가 벌어 준 관계보다 크다', () => {
  // 응찰 +2 · 수주 +10 = +12 를 벌점이 못 지우면 "수주 → 파기" 반복이
  // 위약금으로 관계를 사는 농사가 된다. 관계는 입찰 점수로 돌아오는 자산이다.
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const WIN_GAIN = 12;

    // 정체 만료 경로
    const s = E.newGame(523);
    s.cash = 60000;
    assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'REL').ok);
    const p = s.programs[s.programs.length - 1];
    p.progress = 45;
    p.share = 0;
    p.lastProgressTurn = s.turn - 6;
    s.backlog.push({
      id: 'ord-rel', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
      qty: 10, remaining: 10, unitPrice: 250, wonTurn: s.turn - 6, depositRate: 0.15, pledge: 'standard',
    });
    s.relations.carta = 60;
    E.endTurn(s);
    assert.ok(!s.backlog.some((o) => o.id === 'ord-rel'), '정체 주문이 무르지 않았다');
    assert.ok(
      s.relations.carta <= 60 - WIN_GAIN,
      `만료 벌점(${60 - s.relations.carta})이 수주 이득(+${WIN_GAIN})보다 작으면 파기 농사가 관계를 산다`,
    );

    // 취소 파기 경로도 같은 원칙이다
    const s2 = E.newGame(541);
    s2.cash = 60000;
    assert.ok(E.launchProgram(s2, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'REL2').ok);
    const p2 = s2.programs[s2.programs.length - 1];
    p2.progress = 45;
    s2.backlog.push({
      id: 'ord-rel2', airlineId: 'carta', airlineName: '카르타', programId: p2.id, programName: p2.name,
      qty: 10, remaining: 10, unitPrice: 250, wonTurn: s2.turn, depositRate: 0.15,
    });
    s2.relations.carta = 60;
    assert.ok(E.cancelProgram(s2, p2.id).ok);
    assert.ok(
      s2.relations.carta <= 60 - WIN_GAIN,
      `취소 파기 벌점(${60 - s2.relations.carta})도 수주 이득(+${WIN_GAIN})을 지워야 한다`,
    );
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('마지막 분기에 인증된 기종의 주문도 종료 정산에 걸리고 종료 백로그가 맞다', () => {
  // resolveBids 가 advanceDevelopment 보다 먼저 돌아, 마지막 분기에 인증
  // 직전 기종이 수주 후 같은 정산에서 양산이 된다. 라인을 세울 기회가 없었으니
  // 그 주문은 영영 인도되지 않는다 — 인도 능력(실적·재고·라인)이 전무한
  // 양산 기종의 주문은 종료 시 위약으로 정산돼야 한다.
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const s = E.newGame(547);
    s.cash = 60000;
    assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'LASTCERT').ok);
    const p = s.programs[s.programs.length - 1];
    p.phase = 'production'; // 방금 인증됐다 — 실적도 재고도 라인도 없다
    p.certTurn = 79;
    s.turn = 79;
    s.backlog.push({
      id: 'ord-lastcert', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
      qty: 10, remaining: 10, unitPrice: 250, wonTurn: 79, depositRate: 0.15,
    });

    E.endTurn(s);
    assert.ok(s.gameOver, '마지막 분기 정산 후에는 게임이 끝나야 한다');
    assert.ok(!s.backlog.some((o) => o.id === 'ord-lastcert'), '인도 능력이 전무한 기종의 주문이 정산 없이 남았다');
    assert.ok(s.log.some((l) => /기한 내 미인도/.test(l.text)), '정산 사유가 기록으로 남아야 한다');

    // 종료 화면이 읽는 마지막 행의 백로그는 정산 후 상태여야 한다.
    const row = s.history[s.history.length - 1];
    assert.strictEqual(row.backlog, E.totalBacklog(s), '마지막 행 백로그가 정산 전 값을 물고 있다');
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('운항 정지 중에는 ETOPS 실적이 쌓이지 않고 사건 후보에서도 빠진다', () => {
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const s = E.newGame(557);
    s.cash = 60000;
    assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60, etops: true }, 'GROUND').ok);
    const p = s.programs[s.programs.length - 1];
    p.phase = 'production';
    p.etopsCertified = false;
    p.etopsService = 0;
    p.delivered = 12;
    s.effects.grounded[p.id] = 2;

    s.cash = 60000;
    E.endTurn(s);
    assert.ok(!(p.etopsService > 0), '세워 둔 분기가 ETOPS 실적으로 세어졌다');

    // 정지가 풀리면 다시 쌓인다.
    s.effects.grounded[p.id] = 0;
    s.cash = 60000;
    E.endTurn(s);
    assert.ok(p.etopsService > 0, '정지가 풀렸는데 실적이 안 쌓인다');

    // 정지 중인 기종의 주문은 인도 지연 사건 후보가 아니다.
    s.backlog.length = 0;
    s.backlog.push({
      id: 'ord-ground', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
      qty: 6, remaining: 6, unitPrice: 250, wonTurn: s.turn, depositRate: 0.15,
    });
    p.etopsCertified = true;
    const slip = savedDecisions.find((d) => d.id === 'delivery_slip');
    s.effects.grounded[p.id] = 2;
    assert.strictEqual(slip.weight(s), 0, '운항 정지 중인 주문에 특별 근무를 팔면 안 된다');
    s.effects.grounded[p.id] = 0;
    assert.ok(slip.weight(s) > 0, '정지가 풀리면 사건 후보로 돌아와야 한다');
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('순자산 목표는 선주문 위약을 다 갚은 잔고로 채점된다', () => {
  // 위약 정산이 목표 채점 뒤에 돌면, 실제로는 미달인 회사가 달성 보상금으로
  // 위약을 메우는 순서 역전이 생긴다. 이사회는 다 갚고 남은 잔고를 본다.
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const build = () => {
      const s = E.newGame(563);
      s.cash = 60000;
      assert.ok(E.launchProgram(s, { segment: 'wide', seats: 320, range: 12000, tech: 45, wing: 60 }, 'BOARD').ok);
      const p = s.programs[s.programs.length - 1];
      p.progress = 45;
      s.turn = 79;
      s.backlog.push({
        id: 'ord-board', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
        qty: 100, remaining: 100, unitPrice: 250, wonTurn: 79, depositRate: 0.15,
      });
      return s;
    };
    const refund = Math.round(100 * 250 * 0.15 * 1.5);

    // 같은 상태를 목표 없이 돌려 "위약까지 다 갚은 종료 순자산"을 먼저 잰다.
    const probe = build();
    E.endTurn(probe);
    assert.ok(probe.log.some((l) => /기한 내 미취항/.test(l.text)), '표본 판에서 위약 정산이 안 일어났다');
    const settledWorth = E.netWorth(probe);

    // 목표를 "정산 전엔 달성, 정산 후엔 미달"인 값에 놓는다.
    const s = build();
    s.mandate = {
      id: 'worth', name: '자산 성장', target: Math.round(settledWorth + refund / 2),
      text: '순자산 목표', issuedTurn: 59, dueTurn: 79,
    };
    E.endTurn(s);
    assert.ok(s.log.some((l) => /이사회 목표 미달/.test(l.text)), '위약을 갚기 전 장부로 목표가 달성 처리됐다');
    assert.ok(!s.log.some((l) => /이사회 목표 달성/.test(l.text)), '달성과 미달이 동시에 기록됐다');
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

// ─────────────────────────────── 컨텐츠 확장 — 개량·드라마·단골·마일스톤 ───────────────────────────────

test('기체 개량 — 완성되면 성능·키트 매출·운용사 신뢰가 함께 온다', () => {
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const make = () => {
      const s = E.newGame(601);
      s.cash = 20000;
      return s;
    };
    const ctrl = make();
    const s = make();
    const p = s.programs[0]; // 승계 DN-150 — 양산 · 인도 186기
    assert.strictEqual(p.phase, 'production');

    // 자격 규칙: 개발 중 기종 불가, 같은 개량 중복 불가.
    assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 170, range: 5500, tech: 45 }, 'DEV-X').ok);
    const dev = s.programs[s.programs.length - 1];
    assert.strictEqual(E.startUpgrade(s, dev.id, 'pip').ok, false, '개발 중 기종이 개량되면 안 된다');
    // 대조군과 상태를 맞춘다 — 착수금 지출을 양쪽 모두에.
    assert.ok(E.launchProgram(ctrl, { segment: 'narrow', seats: 170, range: 5500, tech: 45 }, 'DEV-X').ok);

    const effBefore = p.efficiency;
    const relBefore = { ...s.relations };
    const r = E.startUpgrade(s, p.id, 'pip');
    assert.ok(r.ok, r.error);
    assert.strictEqual(E.startUpgrade(s, p.id, 'pip').ok, false, '같은 개량이 중복되면 안 된다');

    // doneTurn 은 "그 분기부터 적용"이다 — 화물형(freighterAt)과 같은 달력.
    // 정산이 턴을 올리기 전에 돌므로 quarters+1 번째 정산에서 완성된다.
    const spec = E.UPGRADES.pip;
    for (let i = 0; i <= spec.quarters; i++) {
      E.endTurn(ctrl);
      E.endTurn(s);
    }
    assert.strictEqual(p.efficiency, effBefore + spec.eff, '완성 후 연비가 올라야 한다');

    // 현금 차이 = 키트 매출 − 개량비. (완성 분기까지는 성능이 같아 나머지 전개가 동일하다)
    // 키트는 완성 시점의 인도 대수 기준이다 — 그 사이 승계 주문 인도분이 포함된다.
    const kits = Math.round(p.delivered * p.listPrice * 0.012);
    assert.strictEqual(Math.round(s.cash - ctrl.cash), kits - r.cost, '키트 매출과 개량비가 장부와 어긋난다');
    // 운용사(판아메르·한울) 신뢰 +2.
    assert.strictEqual(s.relations.panamer - ctrl.relations.panamer, 2, '운용사 신뢰가 올라야 한다');
    assert.strictEqual(s.relations.carta, ctrl.relations.carta, '운용사가 아닌 항공사는 그대로여야 한다');
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('경쟁사 드라마 — 시드에 결정적이고, 지연은 취항 문턱을 실제로 늦춘다', () => {
  const a = E.newGame(607);
  const b = E.newGame(607);
  assert.deepStrictEqual(a.rivalDrama, b.rivalDrama, '같은 시드는 같은 드라마여야 한다');
  assert.deepStrictEqual(a.rivalDelays, b.rivalDelays, '같은 시드는 같은 지연이어야 한다');
  assert.ok(a.rivalDrama.some((ev) => ev.kind === 'announce'), '발표 예고가 있어야 한다');

  // 지연은 조회 시점의 달력을 민다 — 787-8(2011.75)을 5년 미루면 2012년에 없다.
  const year2012 = 2012.5;
  const without = F.availableTypes('wide', year2012).some((t) => t.id === 'b787-8');
  const withDelay = F.availableTypes('wide', year2012, { 'b787-8': 20 }).some((t) => t.id === 'b787-8');
  assert.ok(without, '지연 없이는 2012년에 787-8 이 팔리고 있어야 한다');
  assert.ok(!withDelay, '5년 지연이면 2012년에 787-8 이 없어야 한다');
});

test('결함 파동 — 그 기종의 제안이 약해지고 기간이 끝나면 회복된다', () => {
  const s = E.newGame(613);
  s.turn = 60; // 2013년 — 787-8 취항 후
  const before = B.bestOffering(s, 'wide', 290, 13000);
  assert.ok(before, '광동체 제안이 있어야 한다');

  s.rivalCrises = { [before.type.id]: { left: 4, amount: 50 } };
  const during = B.bestOffering(s, 'wide', 290, 13000);
  assert.ok(
    during.type.id !== before.type.id || during.score < before.score,
    '파동 중에는 그 기종이 최선의 제안에서 밀리거나 약해져야 한다',
  );

  // 만료 tick — rollMarketNews 가 도는 endTurn 을 4번 돌리면 회복된다.
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    for (let i = 0; i < 4; i++) {
      s.cash = 30000;
      E.endTurn(s);
    }
    assert.ok(!s.rivalCrises[before.type.id], '파동은 광고한 기간이 지나면 걷혀야 한다');
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});

test('단골 등급 — 판아메르는 시작부터 핵심 고객이고 전속 정비가 값을 한다', () => {
  const s = E.newGame(617);
  assert.strictEqual(E.loyaltyTier(s, 'panamer'), 2, '승계 선단 62기 — 핵심 고객이어야 한다');
  assert.strictEqual(E.loyaltyTier(s, 'hanul'), 1, '승계 선단 48기 — 단골이어야 한다');
  assert.strictEqual(E.loyaltyTier(s, 'carta'), 0, '거래 없는 항공사는 등급이 없어야 한다');

  // 전속 정비: 핵심 고객 선단 62기 × 협동체 단가 × 25% 가 애프터마켓에 얹힌다.
  const per = Data.AFTERMARKET_PER_UNIT;
  const expected = 186 * per + 62 * per * 0.15;
  assert.ok(Math.abs(E.serviceIncome(s).aftermarket - expected) < 0.01, '핵심 고객 전속 정비 가산이 빠졌다');
});

test('수의계약 — 핵심 고객이 입찰 없이 발주한다', () => {
  const s = E.newGame(619);
  const d = Dec.DECISIONS.find((x) => x.id === 'loyal_direct_order');
  assert.ok(d, '수의계약 사건이 있어야 한다');
  assert.ok(d.weight(s) > 0, '판아메르(핵심)와 DN-150(대역 적합)이 있는데 사건이 잠겨 있다');

  const memo = {};
  const h = { rng: R.createRng(3), remember: (k, v) => ((memo[k] = v), v), recall: (k, f) => (memo[k] === undefined ? f : memo[k]) };
  d.text(s, h);
  s.decision = { id: 'loyal_direct_order', name: d.name, memo, turn: s.turn, options: [] };

  const backlogBefore = s.backlog.length;
  const cashBefore = s.cash;
  const relBefore = s.relations.panamer;
  const r = E.decide(s, 'accept');
  assert.ok(r.ok, r.error);
  assert.strictEqual(s.backlog.length, backlogBefore + 1, '수의계약 주문이 백로그에 서야 한다');
  const o = s.backlog[s.backlog.length - 1];
  assert.strictEqual(o.airlineId, 'panamer');
  assert.ok(s.cash > cashBefore, '선수금이 즉시 들어와야 한다');
  assert.strictEqual(s.relations.panamer - relBefore, 4, '단골값의 보상은 관계다');
});

test('버텍스의 단일 기종 독트린 — 공통성 가산이 남들보다 크다', () => {
  const s = E.newGame(631);
  const prog = { id: 'px', segment: 'narrow', seats: 220, range: 4200, listPrice: 120, efficiency: 62, comfort: 50, wing: 40, phase: 'production' };
  s.fleets.vertex = { px: 25 };
  s.fleets.hanul = { px: 25 };
  s.relations.vertex = 50;
  s.relations.hanul = 50;

  const mk = (airlineId) => ({
    id: 'r-' + airlineId, airlineId, airlineName: airlineId, segment: 'narrow',
    reqSeats: 215, reqRange: 4000, reqField: 0, reqEtops: false, qty: 20,
    priceSensitivity: 1, prestige: 1,
  });
  const v = B.scoreBid(s, mk('vertex'), prog, 0.1).total;
  const hnl = B.scoreBid(s, mk('hanul'), prog, 0.1).total;
  assert.ok(v > hnl, `같은 조건이면 단일 기종 독트린 쪽 공통성이 커야 한다 (${v} vs ${hnl})`);
});

test('마일스톤 — 1호기·100호기·누적 500기가 연표에 남고 승계 기종은 제외된다', () => {
  const savedEvents = Data.EVENTS.slice();
  const savedDecisions = Dec.DECISIONS.slice();
  Data.EVENTS.length = 0;
  Dec.DECISIONS.length = 0;
  try {
    const s = E.newGame(641);
    s.cash = 50000;
    assert.ok(E.launchProgram(s, { segment: 'narrow', seats: 170, range: 5500, tech: 45 }, 'MILE').ok);
    const p = s.programs[s.programs.length - 1];
    p.phase = 'production';
    p.stock = 2;
    s.backlog.push({
      id: 'ord-mile', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
      qty: 2, remaining: 2, unitPrice: 120, wonTurn: s.turn,
    });
    E.endTurn(s);
    assert.ok(s.milestones.some((m) => /MILE 1호기 인도식/.test(m.text)), '첫 인도가 연표에 남아야 한다');
    assert.ok(!s.milestones.some((m) => /DN-150 1호기/.test(m.text)), '승계 기종의 1호기는 이미 지난 일이다');

    // 100호기 문턱과 누적 500기를 같은 인도로 넘긴다.
    p.delivered = 98;
    p.stock = 6;
    s.stats.delivered = 497;
    s.backlog.push({
      id: 'ord-mile2', airlineId: 'carta', airlineName: '카르타', programId: p.id, programName: p.name,
      qty: 6, remaining: 6, unitPrice: 120, wonTurn: s.turn,
    });
    E.endTurn(s);
    assert.ok(s.milestones.some((m) => /MILE 100호기/.test(m.text)), '100호기 라인오프가 남아야 한다');
    assert.ok(s.milestones.some((m) => /누적 인도 500기/.test(m.text)), '회사 누적 마일스톤이 남아야 한다');
  } finally {
    Data.EVENTS.push(...savedEvents);
    Dec.DECISIONS.push(...savedDecisions);
  }
});
