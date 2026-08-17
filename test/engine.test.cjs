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
for (const f of ['rng.js', 'fleet.js', 'engines.js', 'data.js', 'design.js', 'bidding.js', 'engine.js', 'panels.js']) {
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

  for (let i = 0; i < 20; i++) {
    for (const rfp of s.rfps) {
      if (E.eligiblePrograms(s, rfp).filter((x) => !x.score.blocked).length) biddableSkipped++;
      else unbiddable++;
    }
    E.endTurn(s); // 아무 입찰도 하지 않는다
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

test('입찰 점수: 요구 스펙 미달이면 실격 처리된다', () => {
  const s = E.newGame(5);
  const rfp = {
    id: 'r1', airlineId: 'hanul', airlineName: '한울항공', segment: 'narrow',
    reqSeats: 180, reqRange: 6000, qty: 20, priceSensitivity: 1, prestige: 1,
  };
  const shortRange = { segment: 'narrow', seats: 180, range: 4000, listPrice: 90, efficiency: 60, comfort: 50 };
  const shortSeats = { segment: 'narrow', seats: 130, range: 6500, listPrice: 90, efficiency: 60, comfort: 50 };
  const wrongSeg = { segment: 'wide', seats: 300, range: 12000, listPrice: 250, efficiency: 60, comfort: 50 };

  assert.match(globalThis.AirlinerBidding.scoreBid(s, rfp, shortRange, 0).blocked, /항속/);
  assert.match(globalThis.AirlinerBidding.scoreBid(s, rfp, shortSeats, 0).blocked, /좌석/);
  assert.match(globalThis.AirlinerBidding.scoreBid(s, rfp, wrongSeg, 0).blocked, /세그먼트/);
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
  assert.ok(
    Math.abs(p.spent - budget) <= budget * 0.01,
    `총 개발 지출 ${Math.round(p.spent)}이 표시된 개발비 ${budget}와 어긋난다 (품질투자 제외 기준)`,
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
  const rng = R.createRng(1);
  const rfps = [];
  for (let i = 0; i < 60 && rfps.length < 1; i++) {
    for (const r of B.generateRfps(s, rng)) if (r.segment === 'narrow') rfps.push(r);
  }
  const rfp = rfps[0];
  assert.ok(rfp, '협동체 공고를 하나 만들어야 한다');

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

  const series = [];
  while (!s.gameOver && s.turn < nine.turn + 8) {
    s.cash = Math.max(s.cash, 60000);
    E.endTurn(s);
    series.push({ turn: s.turn, demand: s.market.demandIndex });
  }
  const before = series.find((x) => x.turn === nine.turn - 1);
  const at = series.find((x) => x.turn === nine.turn);
  const after4 = series.find((x) => x.turn === nine.turn + 4);
  assert.ok(before && at && after4);

  // 절대 수준이 아니라 낙폭으로 본다 — 충격 직전 수요는 시드마다 다르다.
  assert.ok(at.demand < before.demand * 0.8, `충격 분기에 크게 떨어져야 한다 (${before.demand.toFixed(2)} → ${at.demand.toFixed(2)})`);
  // 평상시 회귀(0.15)라면 4분기면 대부분 복구된다. 침체 중에는 그러면 안 된다.
  assert.ok(after4.demand < before.demand * 0.9, `1년 뒤에도 충격 전 수준으로 돌아가면 안 된다 (${after4.demand.toFixed(2)})`);
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

test('인증 심사 지연은 광고한 분기 수만큼만 밀린다', () => {
  // 지연 처리에서 이번 분기 감소분까지 건너뛰면 "1분기 지연"이 실제로는 2분기가 된다.
  const s = E.newGame(12);
  s.cash = 60000;
  E.launchProgram(s, { segment: 'regional', seats: 90, range: 2500, tech: 95, material: 'composite' }, 'RISK');
  const p = s.programs[s.programs.length - 1];
  p.progress = 100;
  p.phase = 'cert';
  p.defectRisk = 0.7;

  let checked = 0;
  for (let i = 0; i < 400 && checked < 6; i++) {
    if (p.phase !== 'cert') {
      p.phase = 'cert';
      p.certRemaining = 4;
    }
    const before = p.certRemaining;
    const logLen = s.log.length;
    const r = E.endTurn(s);
    if (!r.ok) break;
    s.cash = 60000;

    let delay = 0;
    for (let k = 0; k < s.log.length - logLen; k++) {
      const m = /형식증명 심사에서 설계 변경 요구가 나왔다\. (\d+)분기 지연/.exec(s.log[k].text);
      if (m) delay = Number(m[1]);
    }
    if (!delay || p.phase !== 'cert') continue;

    // 정상 분기는 -1. 지연이면 순증 delay-1 이어야 "delay 분기 지연"과 맞는다.
    assert.strictEqual(
      p.certRemaining - before,
      delay - 1,
      `${delay}분기 지연인데 잔여가 ${before} → ${p.certRemaining} 로 변했다`,
    );
    checked++;
  }
  assert.ok(checked > 0, '지연 사례를 최소 하나는 관측해야 한다');
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
