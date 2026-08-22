/*
 * 항공사 계층 회귀 테스트 — sky-tycoon 에서 옮겨 온 세계·수요·노선 시뮬레이션.
 *   실행: node --test test/sky.test.cjs
 *
 * 엔진 테스트(test/engine.test.cjs)와 파일을 나눈 이유는 이 계층이 제조사 게임과
 * 독립으로 검증되기 때문이다 — 순수 함수라 판을 만들지 않고도 값을 잴 수 있다.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const JS = path.join(__dirname, '..', 'js');
// 기종 어댑터는 설계 평가기로 값을 매기므로 제조사 쪽 모듈이 먼저 있어야 한다.
for (const f of ['rng.js', 'fleet.js', 'engines.js', 'airframe.js', 'data.js', 'decisions.js', 'charts.js', 'design.js', 'bidding.js', 'engine.js', 'sky/cities.js', 'sky/demand.js', 'sky/types.js']) {
  require(path.join(JS, f));
}

const C = globalThis.AirlinerCities;
const D = globalThis.AirlinerDemand;
const T = globalThis.AirlinerSkyTypes;
const Fleet = globalThis.AirlinerFleet;
const Design = globalThis.AirlinerDesign;
const E = globalThis.AirlinerEngine;

// ─────────────────────────────── 세계 ───────────────────────────────

test('세계: 도시 45곳이 모두 다른 id 와 범위 안의 좌표를 갖는다', () => {
  assert.strictEqual(C.CITIES.length, 45);
  assert.strictEqual(new Set(C.CITIES.map((c) => c.id)).size, 45, 'id 가 겹치면 거리 캐시가 엉킨다');
  for (const c of C.CITIES) {
    assert.ok(c.lat >= -90 && c.lat <= 90, `${c.name}: 위도`);
    assert.ok(c.lon >= -180 && c.lon <= 180, `${c.name}: 경도`);
    assert.ok(c.standing > 0 && c.tour > 0 && c.slots > 0, `${c.name}: 규모 값`);
    assert.ok(C.REGIONS[c.region], `${c.name}: 알 수 없는 권역 ${c.region}`);
  }
  assert.strictEqual(C.pairs().length, (45 * 44) / 2);
});

test('세계: 거리가 실제와 맞고, 어느 순서로 물어도 같다', () => {
  // 실측 대권거리와 ±3% 안. 좌표를 잘못 옮기면 여기서 먼저 걸린다.
  const known = [
    ['seoul', 'tokyo', 1153],
    ['london', 'newyork', 5570],
    ['tokyo', 'losangeles', 8817],
    ['seoul', 'singapore', 4670],
    ['sydney', 'auckland', 2159],
  ];
  for (const [a, b, expected] of known) {
    const d = C.distance(a, b);
    assert.ok(Math.abs(d - expected) / expected < 0.03, `${C.name(a)}–${C.name(b)}: ${Math.round(d)} vs ${expected}`);
    assert.strictEqual(C.distance(a, b), C.distance(b, a), '방향이 있으면 안 된다');
  }
  assert.strictEqual(Math.round(C.distance('seoul', 'seoul')), 0);
  assert.strictEqual(C.pairKey('tokyo', 'seoul'), C.pairKey('seoul', 'tokyo'));
});

// ─────────────────────────────── 수요 ───────────────────────────────

test('수요: 멀수록 출장 비중이 오른다', () => {
  // 이 성질이 장거리 대형기의 채산을 만든다 — 뒤집히면 장거리가 수익계수 낮은
  // 관광 수요 위주가 되어 마진이 바닥을 긴다.
  const legs = [
    ['seoul', 'tokyo'],
    ['seoul', 'singapore'],
    ['london', 'newyork'],
    ['tokyo', 'losangeles'],
    ['seoul', 'saopaulo'],
  ];
  const shares = legs.map(([a, b]) => D.annualBase(C.get(a), C.get(b)).businessShare);
  for (let i = 1; i < shares.length; i++) {
    assert.ok(
      shares[i] > shares[i - 1],
      `${C.name(legs[i][0])}–${C.name(legs[i][1])} 의 출장 비중이 더 낮다 (${shares[i - 1].toFixed(2)} → ${shares[i].toFixed(2)})`,
    );
  }
});

test('수요: 800km 아래는 육상교통에 뺏긴다', () => {
  // 앞서 쓴 검사는 억제를 걷어낸 값을 **결과에서 되나눠** 만들어서, 철도항이 통째로
  // 빠져도 통과하는 항진명제였다. 대신 억제가 있어야만 성립하는 성질을 잰다:
  //
  //   거리만 놓고 보면 수요는 가까울수록 커야 한다(감쇠가 작으니까). 그런데 철도
  //   억제가 걸리면 800km 아래에서 그 방향이 뒤집혀, 수요 곡선이 **정확히 800km 에서
  //   봉우리**를 이룬다. 억제를 빼면 이 봉우리가 사라지고 단조 감소가 된다.
  //
  // 실제 도시로는 규모 차이에 가려 안 보이므로, 같은 규모의 도시를 자오선 위에
  // 늘어놓아 거리만 바꾼다.
  const at = (km) => ({
    id: `probe-${km}`,
    name: `probe ${km}`,
    lat: km / 111.195, // 적도에서 위도 1도 ≈ 111.195km
    lon: 0,
    region: 'EU',
    standing: 50,
    tour: 50,
    slots: 40,
    fee: 1,
    growth: 1,
  });
  const origin = at(0);
  const demandAt = (km) => D.annualBase(origin, at(km)).total;

  const near = [100, 200, 400, 600, 800];
  for (let i = 1; i < near.length; i++) {
    assert.ok(
      demandAt(near[i]) > demandAt(near[i - 1]),
      `${near[i - 1]}km → ${near[i]}km: 억제가 풀리며 늘어야 한다 (${demandAt(near[i - 1]).toFixed(0)} → ${demandAt(near[i]).toFixed(0)})`,
    );
  }
  const far = [800, 1000, 1500, 3000, 8000];
  for (let i = 1; i < far.length; i++) {
    assert.ok(
      demandAt(far[i]) < demandAt(far[i - 1]),
      `${far[i - 1]}km → ${far[i]}km: 억제가 없으므로 거리대로 줄어야 한다`,
    );
  }
  // 봉우리는 철도 구간의 끝이다.
  assert.ok(demandAt(800) > demandAt(790) && demandAt(800) > demandAt(810), '봉우리가 800km 에 있어야 한다');
});

test('수요: 같은 도시끼리도 다른 경로와 같은 모양으로 돌려준다', () => {
  // 맨 객체를 돌려주면 businessShare 가 undefined 가 되어, 0 을 기대한 쪽이 조용히 어긋난다.
  const a = C.get('seoul');
  const zero = D.annualBase(a, a);
  const real = D.annualBase(a, C.get('tokyo'));
  assert.deepStrictEqual(Object.keys(zero).sort(), Object.keys(real).sort());
  assert.strictEqual(zero.total, 0);
  assert.strictEqual(zero.businessShare, 0, 'undefined 가 아니라 0 이어야 한다');
});

test('수요: 같은 권역끼리 조금 더 붙는다', () => {
  // 도쿄–서울(같은 권역)과 도쿄–시드니를 견주는 대신, 같은 짝에 권역만 바꿔 넣는다.
  const a = C.get('seoul');
  const b = C.get('tokyo');
  const far = { ...b, region: 'OC' };
  const same = D.annualBase(a, b).total;
  const cross = D.annualBase(a, far).total;
  assert.ok(same > cross, '같은 권역이 더 커야 한다');
  assert.ok(Math.abs(same / cross - 1.18) < 0.01, `배수가 1.18 이어야 한다 (${(same / cross).toFixed(3)})`);
});

test('수요: 3분기에 관광이 몰리고 출장은 그때 쉰다', () => {
  const a = C.get('bangkok');
  const b = C.get('sydney');
  const q = (n) => D.quarterly(a, b, { quarter: n });
  const lei = [1, 2, 3, 4].map((n) => q(n).leisure);
  const biz = [1, 2, 3, 4].map((n) => q(n).business);
  assert.strictEqual(lei.indexOf(Math.max(...lei)), 2, '관광 성수기는 3분기다');
  assert.strictEqual(biz.indexOf(Math.min(...biz)), 2, '출장은 3분기에 쉰다');
});

test('수요: 불황은 관광을 먼저 죽인다', () => {
  const a = C.get('paris');
  const b = C.get('rome');
  const good = D.quarterly(a, b, { quarter: 1, economy: 1 });
  const bad = D.quarterly(a, b, { quarter: 1, economy: 0.8 });
  const leiDrop = 1 - bad.leisure / good.leisure;
  const bizDrop = 1 - bad.business / good.business;
  assert.ok(leiDrop > bizDrop, `관광이 더 많이 빠져야 한다 (관광 ${leiDrop.toFixed(3)} vs 출장 ${bizDrop.toFixed(3)})`);
});

test('수요: 공항이 닫히면 그 도시쌍은 0 이다', () => {
  const a = C.get('cairo');
  const b = C.get('london');
  assert.ok(D.quarterly(a, b, { quarter: 1 }).total > 0);
  assert.strictEqual(D.quarterly(a, b, { quarter: 1, closed: { cairo: true } }).total, 0);
});

test('수요: 한쪽만 꺾인 사건이 반대쪽의 1.0 에 가려 사라지지 않는다', () => {
  // 최댓값만 쓰면 사스 폭락이 붐에 먹히고, 최솟값만 쓰면 붐이 사라진다.
  const a = C.get('hongkong');
  const b = C.get('london');
  const plain = D.quarterly(a, b, { quarter: 1 }).total;
  const crash = D.quarterly(a, b, { quarter: 1, boost: { hongkong: 0.6 } }).total;
  const boom = D.quarterly(a, b, { quarter: 1, boost: { hongkong: 1.5 } }).total;
  const both = D.quarterly(a, b, { quarter: 1, boost: { hongkong: 0.6, london: 1.5 } }).total;
  assert.ok(crash < plain, '폭락이 반영돼야 한다');
  assert.ok(boom > plain, '붐이 반영돼야 한다');
  assert.ok(Math.abs(both / plain - 0.6 * 1.5) < 1e-9, '둘이 겹치면 각각 살아남아야 한다');
});

test('수요: 도쿄–LA 는 747 한 대가 내놓는 좌석을 못 채운다', () => {
  // sky-tycoon 이 허브 환승을 두는 이유 그 자체다 — 로컬 수요만으로는 장거리
  // 광동체가 애초에 안 찬다. 이 성질이 깨지면 환승 모델이 필요 없어진다.
  const q = D.quarterly(C.get('tokyo'), C.get('losangeles'), { quarter: 1 }).total;
  // 747-100 366석, 주3왕복(8,817km 를 한 대로 굴릴 수 있는 최대치), 분기 13주.
  const seats = 366 * 3 * 2 * 13;
  assert.ok(q < seats, `분기 수요 ${Math.round(q)} < 공급 ${seats} 이어야 한다`);
});

test('수요: 같은 입력이면 같은 값이고, 입력을 건드리지 않는다', () => {
  const a = C.get('delhi');
  const b = C.get('dubai');
  const before = JSON.stringify([a, b]);
  const first = D.annualBase(a, b).total;
  const second = D.annualBase(a, b).total;
  assert.strictEqual(first, second, '순수 함수여야 한다');
  assert.strictEqual(JSON.stringify([a, b]), before, '도시를 건드리면 안 된다');
});

test('수요: 도시 성장이 수요를 밀어 올린다', () => {
  const a = C.get('shanghai');
  const b = C.get('tokyo');
  const flat = D.annualBase(a, b).total;
  const grown = D.annualBase(a, b, 1.5, 1.0).total;
  assert.ok(grown > flat, '성장한 도시가 더 큰 수요를 낸다');
});

// ─────────────────────────── 기종 어댑터 ───────────────────────────

test('기종: sky-tycoon 이 손으로 적은 값과 어긋나지 않는다', () => {
  // 유도식(좌석·급·세대)이 저쪽 카탈로그를 얼마나 재현하나. 이게 벌어지면 노선
  // 채산이 저쪽 밸런스와 다른 세계로 간다.
  const SKY = {
    'b737-800': { fuel: 2.9, maint: 420, crew: 440, turn: 0.6 },
    a320: { fuel: 3.0, maint: 470, crew: 450, turn: 0.65 },
    'b777-200er': { fuel: 7.9, maint: 900, crew: 800, turn: 1.3 },
    'b747-400': { fuel: 11.5, maint: 1360, crew: 1080, turn: 1.7 },
    'b787-9': { fuel: 5.7, maint: 700, crew: 780, turn: 1.1 },
    'a350-900': { fuel: 5.9, maint: 720, crew: 810, turn: 1.2 },
    'b767-300er': { fuel: 5.6, maint: 780, crew: 690, turn: 1.1 },
  };
  const errors = [];
  for (const [id, want] of Object.entries(SKY)) {
    const a = Fleet.AIRCRAFT.find((x) => x.id === id);
    assert.ok(a, `${id}: 카탈로그에 있어야 한다`);
    const got = T.fromRival(a, Design.evaluate);
    for (const key of ['fuel', 'maint', 'crew', 'turn']) {
      const err = Math.abs(got[key] - want[key]) / want[key];
      assert.ok(err < 0.25, `${a.name} ${key}: ${got[key]} vs ${want[key]} (${(err * 100).toFixed(0)}%)`);
      errors.push(err);
    }
  }
  const mean = errors.reduce((x, y) => x + y, 0) / errors.length;
  assert.ok(mean < 0.1, `평균 오차가 10% 안이어야 한다 (${(mean * 100).toFixed(1)}%)`);
});

test('기종: 광동체가 좌석당 연료를 더 먹는다', () => {
  // 멀리 빨리 나는 값이다. 뒤집히면 장거리에 협동체를 깔면 그만인 게임이 된다.
  const narrow = T.fromRival(Fleet.AIRCRAFT.find((a) => a.id === 'b737-800'), Design.evaluate);
  const wide = T.fromRival(Fleet.AIRCRAFT.find((a) => a.id === 'b777-200er'), Design.evaluate);
  assert.ok(wide.fuel / wide.seats > narrow.fuel / narrow.seats, '광동체가 좌석당 더 먹어야 한다');
  assert.ok(wide.speed > narrow.speed, '대신 더 빠르다');
  assert.strictEqual(wide.widebody, true);
  assert.strictEqual(narrow.widebody, false);
});

test('기종: 세대가 좋을수록 연료·정비가 준다', () => {
  const old = Fleet.AIRCRAFT.find((a) => a.id === 'b747-400'); // eff 0.88
  const neo = Fleet.AIRCRAFT.find((a) => a.id === 'b787-9'); // eff 1.20
  const a = T.fromRival(old, Design.evaluate);
  const b = T.fromRival(neo, Design.evaluate);
  assert.ok(b.fuel / b.seats < a.fuel / a.seats, '신형이 좌석당 덜 먹어야 한다');
  assert.ok(b.maint / b.seats < a.maint / a.seats, '정비도 마찬가지다');
  // 승무원비는 세대를 타지 않는다 — 사람 값을 기술로 깎을 수는 없다.
  assert.ok(Math.abs(b.crew / b.seats - a.crew / a.seats) < 0.35, '승무원비는 좌석에만 붙는다');
});

test('기종: 우리 기체와 남의 기체가 같은 모양으로 나온다', () => {
  const rival = T.fromRival(Fleet.AIRCRAFT.find((a) => a.id === 'b737-800'), Design.evaluate);
  const s = E.newGame(5001, 'deneb');
  const p = s.programs.find((x) => x.segment === 'narrow');
  const mine = T.fromProgram(p, '데네브');
  assert.deepStrictEqual(Object.keys(rival).sort(), Object.keys(mine).sort(), '항공사 계층은 출처를 몰라도 된다');
  assert.strictEqual(mine.own, true);
  assert.strictEqual(rival.own, false);
  for (const k of ['seats', 'range', 'speed', 'fuel', 'maint', 'crew', 'turn', 'price']) {
    assert.ok(Number.isFinite(mine[k]) && mine[k] > 0, `${k} 가 성해야 한다 (${mine[k]})`);
  }
});

test('기종: 값은 이 게임의 정가를 그대로 옮긴다 — 환율이 없다', () => {
  // 두 게임의 기체 값은 모양이 달라 환율 하나로 못 누른다(0.29~0.73). 기체 값을
  // 정하는 것이 이 게임의 본체이므로 그쪽을 기준으로 두고, 운임을 거기 맞춘다.
  const s = E.newGame(5002, 'deneb');
  const p = s.programs[0];
  const t = T.fromProgram(p, '데네브');
  assert.strictEqual(t.price, p.listPrice * 1e6, '정가에 배수가 끼면 안 된다');
});

test('기종: 취항 연도가 늦을수록 기술 수준이 높다', () => {
  assert.ok(T.techFromEis(2017) > T.techFromEis(1998), '시대를 타야 한다');
  assert.strictEqual(T.techFromEis(1998), 50, '1998년을 기준으로 둔다');
  // 창 밖 연도로도 값이 폭주하지 않는다.
  assert.ok(T.techFromEis(1950) >= 30 && T.techFromEis(2100) <= 100);
});

test('수요: 세계의 크기가 고정돼 있다', () => {
  // 성질 검사(거리에 따른 비중·계절·봉우리)는 전부 **비율**만 보므로, K 나 거리
  // 감쇠가 통째로 바뀌어도 다 통과한다. 그러면 게임 스케일이 조용히 다른 세계가 된다.
  // 대표 도시쌍의 절대값을 기준으로 박아 둔다 — 이 숫자가 움직이면 항공사 계층의
  // 노선 채산·기재 소요가 전부 함께 움직인다는 뜻이다.
  const REFERENCE = {
    'seoul|tokyo': 195393,
    'london|newyork': 125711,
    'tokyo|losangeles': 94188,
    'seoul|saopaulo': 41945,
    'london|paris': 214269,
  };
  for (const [key, want] of Object.entries(REFERENCE)) {
    const [a, b] = key.split('|');
    const got = D.annualBase(C.get(a), C.get(b)).total;
    const err = Math.abs(got - want) / want;
    assert.ok(err < 0.01, `${C.name(a)}–${C.name(b)}: ${Math.round(got)} vs 기준 ${want} (${(err * 100).toFixed(1)}%)`);
  }
});

test('수요: 항공여행 보급 지수가 기준연도와 성장률에 묶여 있다', () => {
  // 기준연도가 한 해 어긋나거나 성장률이 바뀌면 그 뒤 모든 분기 수요가 조용히 움직인다.
  assert.strictEqual(D.travelIndex(1970), 1, '1970년이 기준이다');
  assert.ok(Math.abs(D.travelIndex(1971) - 1.02) < 1e-9, '연 2% 성장이다');
  assert.ok(Math.abs(D.travelIndex(1998) - Math.pow(1.02, 28)) < 1e-9);
  assert.ok(D.travelIndex(2017) > D.travelIndex(1998), '시대를 타야 한다');
});
