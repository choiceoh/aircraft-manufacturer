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
for (const f of ['sky/cities.js', 'sky/demand.js']) require(path.join(JS, f));

const C = globalThis.AirlinerCities;
const D = globalThis.AirlinerDemand;

// ─────────────────────────────── 세계 ───────────────────────────────

test('세계: 도시 45곳이 모두 다른 id 와 성한 좌표를 갖는다', () => {
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
  // 같은 도시로 거리만 바꿔 잴 수 없으니, 철도 구간을 지나는 짝과 그 바로 위를 견준다.
  const near = C.pairs().filter(([a, b]) => C.distance(a.id, b.id) < 800);
  assert.ok(near.length > 0, '철도 구간에 드는 도시쌍이 있어야 이 검사가 의미가 있다');
  for (const [a, b] of near) {
    const d = C.distance(a.id, b.id);
    const got = D.annualBase(a, b).total;
    // 억제를 걷어낸 값 — 거리 감쇠는 그대로 두고 철도 몫만 되돌린다.
    const bare = got / Math.pow(d / 800, 0.5);
    assert.ok(got < bare, `${a.name}–${b.name}: 억제가 걸려야 한다`);
  }
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
