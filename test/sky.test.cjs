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
for (const f of ['rng.js', 'fleet.js', 'engines.js', 'airframe.js', 'data.js', 'decisions.js', 'charts.js', 'design.js', 'bidding.js', 'engine.js', 'sky/cities.js', 'sky/demand.js', 'sky/types.js', 'sky/economics.js', 'sky/market.js', 'sky/state.js', 'sky/actions.js', 'sky/ai.js', 'panels.js', 'sky/panels.js']) {
  require(path.join(JS, f));
}

const C = globalThis.AirlinerCities;
const D = globalThis.AirlinerDemand;
const T = globalThis.AirlinerSkyTypes;
const Fleet = globalThis.AirlinerFleet;
const Design = globalThis.AirlinerDesign;
const Data = globalThis.AirlinerData;
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
  //
  // 게임이 시작하는 1998년 기준으로 잰다. 여행지수를 빼고 1970년으로 재면 수요가
  // 1.74배 작게 나와 통과 여부가 뒤집힌다 — 이 게임에서 쓰이지 않는 연도다.
  const q = D.quarterly(C.get('tokyo'), C.get('losangeles'), { quarter: 1, travelIndex: D.travelIndex(1998) }).total;
  // 공급도 손으로 적지 않고 실제 기종·채산 모형에서 낸다: 747-400 한 대를
  // 주간 상한까지 굴렸을 때의 분기 좌석.
  const t = TYPES['b747-400'];
  const d = C.distance('tokyo', 'losangeles');
  const seats = (Econ.BALANCE.MAX_WEEKLY_HOURS / Econ.roundTripHours(t, d)) * 2 * 13 * t.seats;
  // 위아래를 함께 박는다. 위만 박으면 여행지수를 빼먹어도(1970년 = 0.52) 통과한다 —
  // 지금 잡힌 자리가 0.90 이라, 아슬아슬하게 못 채우는 것이 이 노선의 성질이다.
  const fill = q / seats;
  assert.ok(fill < 1, `분기 수요 ${Math.round(q)} < 공급 ${Math.round(seats)} 이어야 한다`);
  assert.ok(fill > 0.7, `그렇다고 절반도 못 채우면 안 된다 (${(fill * 100).toFixed(0)}%)`);
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

test('기종: 급 한계를 넘는 실기종도 제 제원대로 값이 매겨진다', () => {
  // 설계 평가기는 좌석·항속을 급별 한계로 자른 뒤 값을 낸다 — 플레이어는 한계 안에서만
  // 설계하므로 문제가 없지만, 실존 기종은 한계를 넘는다. 되돌리지 않으면 A380 이 480석
  // 값으로, 767-200ER 이 광동체 하한 230석 값으로 팔린다.
  const seg = Data.SEGMENTS;
  const over = Fleet.AIRCRAFT.filter(
    (a) => a.seats > seg[a.segment].seats.max || a.seats < seg[a.segment].seats.min ||
           a.range > seg[a.segment].range.max || a.range < seg[a.segment].range.min,
  );
  assert.ok(over.length > 0, '한계 밖 기종이 실제로 있어야 이 테스트가 의미가 있다');

  for (const a of over) {
    const clamped = Design.evaluate({
      segment: a.segment, seats: a.seats, range: a.range,
      tech: T.techFromEis(a.eis), material: 'aluminum', year: a.eis,
    });
    const price = TYPES[a.id].price / 1e6;
    // 잘린 제원보다 큰 기체는 더 비싸고, 작은 기체는 더 싸야 한다.
    if (a.seats > clamped.seats) assert.ok(price > clamped.listPrice, `${a.name}: ${a.seats}석인데 ${clamped.seats}석 값 이하다`);
    if (a.seats < clamped.seats) assert.ok(price < clamped.listPrice, `${a.name}: ${a.seats}석인데 ${clamped.seats}석 값 이상이다`);
  }

  // 광동체 좌석 하한(230석) 아래인 767-200ER 181석이 같은 세대 218석 767-300ER 보다 싸야 한다.
  assert.ok(TYPES['b767-200er'].price < TYPES['b767-300er'].price, '작은 기체가 더 싸야 한다');
  // 좌석 상한(480석) 위인 A380 은 상한값보다 비싸야 한다.
  assert.ok(TYPES['a380'].seats > seg.wide.seats.max, 'A380 이 상한을 넘어야 이 검사가 산다');
});

test('기종: 터보프롭은 제트기 속도로 날지 않는다', () => {
  // 속도를 급별 상수로만 주면 ATR 72 가 815km/h 로 날아 가동률과 노선 공급이 부풀고,
  // 터보프롭이 단거리에서 제트기와 같은 회전수를 낸다.
  const props = Fleet.AIRCRAFT.filter((a) => a.cruise);
  assert.ok(props.length >= 4, '카탈로그에 터보프롭이 있어야 한다');
  for (const a of props) {
    assert.strictEqual(TYPES[a.id].speed, a.cruise, `${a.name} 이 카탈로그 순항속도를 써야 한다`);
    assert.ok(TYPES[a.id].speed < T.SPEED.regional, `${a.name} 이 리저널 제트보다 느려야 한다`);
  }
  // 같은 거리를 도는 데 실제로 더 오래 걸린다.
  const d = C.distance('seoul', 'tokyo');
  assert.ok(Econ.roundTripHours(TYPES['atr72-500'], d) > Econ.roundTripHours(TYPES['erj145'], d), '한 바퀴가 더 길어야 한다');
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

// ─────────────────────── 시장 점유 · 노선 채산 ───────────────────────

const Econ = globalThis.AirlinerSkyEconomics;
const M = globalThis.AirlinerSkyMarket;
const St = globalThis.AirlinerSkyState;
const Act = globalThis.AirlinerSkyActions;
const Ai = globalThis.AirlinerSkyAi;
const SP = globalThis.AirlinerSkyPanels;

/** 기종 표 — 경쟁 카탈로그를 항공사 계층이 쓰는 모양으로. */
const TYPES = {};
for (const a of Fleet.AIRCRAFT) TYPES[a.id] = T.fromRival(a, Design.evaluate);

/** 노선 하나를 굴려 결과와 원가를 낸다. */
function fly(opts) {
  const { from, to, typeId, planes: n, freq, fareMul = 1, rivals = [], home = from, feed = 0 } = opts;
  const airlines = [
    { id: 'me', name: 'me', home, brand: 40, serviceLevel: 3, safety: 1, alive: true, slots: { [from]: freq, [to]: freq } },
  ];
  const routes = [{ id: 1, airlineId: 'me', from, to, freq, fareMul, active: true, serviceExtra: 0 }];
  const planes = Array.from({ length: n }, (_, i) => ({ id: i + 1, typeId, airlineId: 'me', routeId: 1, ageQuarters: 8 }));
  rivals.forEach((r, k) => {
    const id = `r${k}`;
    airlines.push({ id, name: id, home: r.home || to, brand: 40, serviceLevel: 3, safety: 1, alive: true, slots: { [from]: r.freq, [to]: r.freq } });
    routes.push({ id: 10 + k, airlineId: id, from, to, freq: r.freq, fareMul: r.fareMul || 1, active: true, serviceExtra: 0 });
    for (let i = 0; i < r.planes; i++) {
      planes.push({ id: 100 + k * 10 + i, typeId: r.typeId || typeId, airlineId: id, routeId: 10 + k, ageQuarters: 8 });
    }
  });
  const ctx = {
    airlineOf: (id) => airlines.find((a) => a.id === id),
    planesOn: (rid) => planes.filter((p) => p.routeId === rid),
    typeOf: (t) => TYPES[t],
    slotsAt: (aid, c) => (airlines.find((a) => a.id === aid).slots || {})[c] || 0,
    totalSlots: (c) => C.get(c).slots,
    feedCount: (aid) => (aid === 'me' ? feed : 0),
    demand: (a, b) => D.quarterly(a, b, { quarter: 1, travelIndex: D.travelIndex(1998) }),
    inflation: 1,
    oil: 1,
  };
  const outs = M.resolvePair(C.get(from), C.get(to), routes, ctx);
  const mine = outs.find((o) => o.airlineId === 'me');
  const cost = Econ.routeCost(routes[0], planes.filter((p) => p.routeId === 1), {
    typeOf: (t) => TYPES[t], oil: 1, inflation: 1, serviceLevel: 3, pax: mine ? mine.pax : 0, revenue: mine ? mine.revenue : 0,
  });
  return { out: mine, all: outs, cost, margin: mine && mine.revenue > 0 ? (mine.revenue - cost.total) / mine.revenue : 0 };
}

test('시장: 로컬 편차가 종 모양이고 도시쌍마다 고정이다', () => {
  // 분기마다 다시 굴리면 탑승률이 이유 없이 출렁여 경영 판단이 잡음에 묻힌다.
  const vals = C.pairs().map(([a, b]) => M.bellDeviate(C.pairKey(a.id, b.id)));
  const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
  assert.ok(Math.abs(mean) < 0.15, `평균이 0 근처여야 한다 (${mean.toFixed(3)})`);
  assert.ok(Math.abs(sd - 1) < 0.15, `표준편차가 1 근처여야 한다 (${sd.toFixed(3)})`);
  assert.strictEqual(M.bellDeviate('seoul|tokyo'), M.bellDeviate('seoul|tokyo'), '같은 키는 같은 값이다');

  // 3단계 표시가 대략 3:4:3 으로 갈려야 "어디를 뚫을지"가 판단거리가 된다.
  const counts = { 강함: 0, 보통: 0, 약함: 0 };
  for (const [a, b] of C.pairs()) counts[M.localStrengthLabel(a, b)]++;
  for (const k of Object.keys(counts)) {
    const share = counts[k] / 990;
    assert.ok(share > 0.2 && share < 0.45, `${k} 가 ${(share * 100).toFixed(0)}% 다 — 한쪽으로 몰렸다`);
  }
});

test('시장: 로컬은 멀수록 약해진다', () => {
  // 거리에 무관하게 세게 두면 도쿄–LA 같은 간판 간선이 독점인데도 반도 못 찬다.
  const near = M.localStrength(C.get('seoul'), C.get('tokyo'));
  const far = M.localStrength(C.get('tokyo'), C.get('losangeles'));
  assert.ok(far < near, `먼 구간의 로컬이 약해야 한다 (${near.toFixed(2)} → ${far.toFixed(2)})`);
});

test('시장: 독점 간선의 마진이 확장할 맛이 나는 자리에 있다', () => {
  // sky-tycoon 의 목표 밴드 — 너무 낮으면 아무도 안 열고, 너무 높으면 무엇을 해도 남는다.
  for (const c of [
    { from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14 },
    { from: 'newyork', to: 'chicago', typeId: 'b737-800', planes: 4, freq: 18 },
  ]) {
    const r = fly(c);
    assert.ok(r.margin > 0.12 && r.margin < 0.55, `${c.from}–${c.to}: 마진 ${(r.margin * 100).toFixed(0)}%`);
  }
});

test('시장: 경쟁이 붙으면 마진과 탑승률이 확실히 깎인다', () => {
  const solo = fly({ from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14 });
  const duo = fly({
    from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14,
    rivals: [{ planes: 3, freq: 14 }],
  });
  assert.ok(duo.margin < solo.margin - 0.1, `마진이 깎여야 한다 (${(solo.margin * 100).toFixed(0)}% → ${(duo.margin * 100).toFixed(0)}%)`);
  assert.ok(duo.out.loadFactor < solo.out.loadFactor - 0.1, '탑승률도 떨어져야 한다');
});

test('시장: 운임을 올리면 승객을 뺏긴다', () => {
  const base = fly({ from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14, rivals: [{ planes: 3, freq: 14 }] });
  const dear = fly({ from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14, fareMul: 1.3, rivals: [{ planes: 3, freq: 14 }] });
  assert.ok(dear.out.share < base.out.share, `점유가 떨어져야 한다 (${(base.out.share * 100).toFixed(0)}% → ${(dear.out.share * 100).toFixed(0)}%)`);
  assert.ok(dear.out.loadFactor < base.out.loadFactor, '탑승률도 떨어진다');
});

test('시장: 독점이어도 100% 가 아니다 — 로컬이 늘 함께 겨룬다', () => {
  // 점유율 분모가 로컬 몫까지 포함한 시장 전체다. 모델 안 회사끼리만 나누면
  // 혼자 취항한 구간이 언제나 100% 로 뜬다.
  const r = fly({ from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14 });
  assert.ok(r.out.share < 0.95, `독점 점유가 ${(r.out.share * 100).toFixed(0)}% 다 — 로컬이 사라졌다`);
  assert.ok(r.out.share > 0.3, '그렇다고 로컬이 다 가져가도 안 된다');
});

test('시장: 연고와 환승편이 있는 쪽이 확실히 더 채운다', () => {
  // 같은 기재·운임·편수라도 네트워크와 연고가 있는 쪽이 더 채워야 한다.
  const away = fly({ from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14, home: 'london', rivals: [{ planes: 3, freq: 14, home: 'seoul' }] });
  const homeSide = fly({ from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14, home: 'seoul', rivals: [{ planes: 3, freq: 14, home: 'london' }] });
  assert.ok(homeSide.out.share > away.out.share, '연고가 있는 쪽이 더 가져간다');

  const bare = fly({ from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14, rivals: [{ planes: 3, freq: 14 }] });
  const hubbed = fly({ from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14, feed: 2, rivals: [{ planes: 3, freq: 14 }] });
  assert.ok(hubbed.out.share > bare.out.share, '연결편이 있는 쪽이 더 가져간다');
});

test('시장: 뜨는 기재가 없으면 아예 시장에 못 들어간다', () => {
  // 중정비로 기재가 전부 빠진 노선이 좌석을 내놓으면 안 된다.
  const routes = [{ id: 1, airlineId: 'me', from: 'seoul', to: 'tokyo', freq: 14, fareMul: 1, active: true }];
  const ctx = {
    airlineOf: () => ({ id: 'me', home: 'seoul', brand: 40, serviceLevel: 3, safety: 1, alive: true }),
    planesOn: () => [],
    typeOf: (t) => TYPES[t],
    slotsAt: () => 14,
    totalSlots: (c) => C.get(c).slots,
    feedCount: () => 0,
    demand: (a, b) => D.quarterly(a, b, { quarter: 1 }),
  };
  assert.deepStrictEqual(M.resolvePair(C.get('seoul'), C.get('tokyo'), routes, ctx), []);
});

test('시장: 좌석이 모자라 흘린 몫만 다시 돌린다', () => {
  // 로컬을 택한 손님까지 다시 돌리면 라운드를 거듭할수록 바깥 선택지가 무력해져
  // (50% 가 93.75% 가 된다) 이 모델이 통째로 무너진다.
  const offers = [{ remaining: 100, seats: 100 }];
  const plenty = M.allocate(offers.map((o) => ({ ...o })), 1000, 0, () => 0);
  // 로컬 효용 0, 우리 효용 0 → 절반이 우리에게 온다. 좌석이 100 뿐이라 나머지는 흘린다.
  assert.ok(plenty.taken[0] <= 100 + 1e-9, '좌석보다 많이 태울 수 없다');
  assert.ok(plenty.unmet > 0, '못 태운 몫이 남아야 한다');

  // 좌석이 넉넉하면 로컬 몫은 끝까지 로컬에 남는다.
  const roomy = M.allocate([{ remaining: 1e9, seats: 1e9 }], 1000, 0, () => 0);
  assert.ok(roomy.taken[0] < 900, `로컬 몫이 살아 있어야 한다 (${roomy.taken[0].toFixed(0)}/1000)`);
});

test('채산: 거리를 안 타는 원가가 있어 단거리는 편수를 욕심내면 적자다', () => {
  // 기본요금이 없으면 짧은 노선일수록 고정비를 못 건진다 — 그래서 표준운임에
  // 0km 기본요금이 있고, 편수를 최대로 밀면 좌석이 로컬에 밀려 남지 않는다.
  const sane = fly({ from: 'london', to: 'paris', typeId: 'b737-800', planes: 3, freq: 20 });
  const greedy = fly({ from: 'london', to: 'paris', typeId: 'b737-800', planes: 12, freq: 80 });
  assert.ok(sane.margin > 0, '적당한 편수는 남아야 한다');
  assert.ok(greedy.margin < sane.margin, `편수를 밀면 마진이 나빠져야 한다 (${(sane.margin * 100).toFixed(0)}% → ${(greedy.margin * 100).toFixed(0)}%)`);
  assert.ok(greedy.out.loadFactor < sane.out.loadFactor, '좌석을 깔수록 로컬에 밀린다');
});

test('시장: 태평양 노선은 한 대를 넘겨 키울 수가 없다', () => {
  // 위의 수요 테스트를 시장 모형으로 다시 말한 것이다 — 로컬 수요만으로는 광동체
  // 한 대가 상한이고, 두 대째를 넣는 순간 탑승률이 반토막 나고 적자로 뒤집힌다.
  // 허브 환승(3b)이 이 천장을 걷어내는 장치다.
  const one = fly({ from: 'tokyo', to: 'losangeles', typeId: 'b747-400', planes: 1, freq: 4 });
  const two = fly({ from: 'tokyo', to: 'losangeles', typeId: 'b747-400', planes: 2, freq: 8 });
  assert.ok(one.out.loadFactor > 0.8, `한 대는 채워져야 한다 (${(one.out.loadFactor * 100).toFixed(0)}%)`);
  assert.ok(two.out.loadFactor < 0.6, `두 대째는 못 채운다 (${(two.out.loadFactor * 100).toFixed(0)}%)`);
  assert.ok(one.margin > 0 && two.margin < 0, `한 대는 흑자, 두 대는 적자여야 한다 (${(one.margin * 100).toFixed(0)}% → ${(two.margin * 100).toFixed(0)}%)`);
});

/** 노선망 하나를 통째로 굴린다 — 1단계(직항) + 2단계(허브 환승). */
function network(legs, opts = {}) {
  const home = opts.home || legs[0].from;
  const airline = { id: 'me', name: 'me', home, brand: 40, serviceLevel: 3, safety: 1, alive: true, slots: {} };
  const routes = [];
  const planes = [];
  let pid = 1;
  legs.forEach((l, k) => {
    routes.push({ id: k + 1, airlineId: 'me', from: l.from, to: l.to, freq: l.freq, fareMul: 1, active: true, serviceExtra: 0 });
    for (let i = 0; i < l.planes; i++) planes.push({ id: pid++, typeId: l.typeId, airlineId: 'me', routeId: k + 1, ageQuarters: 8 });
    airline.slots[l.from] = (airline.slots[l.from] || 0) + l.freq;
    airline.slots[l.to] = (airline.slots[l.to] || 0) + l.freq;
  });
  const ctx = {
    airlineOf: () => airline,
    planesOn: (rid) => planes.filter((p) => p.routeId === rid),
    typeOf: (t) => TYPES[t],
    slotsAt: (_a, c) => airline.slots[c] || 0,
    totalSlots: (c) => C.get(c).slots,
    feedCount: () => 0,
    demand: (a, b) => D.quarterly(a, b, { quarter: 1, travelIndex: D.travelIndex(1998) }),
    inflation: 1,
    oil: 1,
  };
  const out = M.resolveAll(routes, ctx);
  const byLeg = {};
  routes.forEach((r) => (byLeg[`${r.from}-${r.to}`] = out[r.id]));
  return { out, byLeg, routes };
}

/** 도쿄 허브 하나에 스포크를 붙인 표준 배치. 스포크에 빈자리가 남도록 넉넉히 깐다. */
const TOKYO_HUB = [
  { from: 'tokyo', to: 'losangeles', typeId: 'b747-400', planes: 2, freq: 8 },
  { from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 6, freq: 40 },
  { from: 'beijing', to: 'tokyo', typeId: 'b737-800', planes: 6, freq: 40 },
];

test('환승: 허브가 로컬 수요로는 못 채우던 간선을 채운다', () => {
  // 3b 의 존재 이유 그 자체다. 스포크 하나는 로컬만 보면 남아돌고, 간선 하나는 로컬만
  // 보면 반도 못 찬다 — 둘을 물려야 비로소 둘 다 산다.
  const solo = network([TOKYO_HUB[0]], { home: 'tokyo' });
  const hub = network(TOKYO_HUB, { home: 'tokyo' });
  const before = solo.byLeg['tokyo-losangeles'];
  const after = hub.byLeg['tokyo-losangeles'];
  assert.ok(!before.connectPax, '스포크가 없으면 환승도 없다');
  assert.ok(before.loadFactor < 0.6, `단독은 못 채운다 (${(before.loadFactor * 100).toFixed(0)}%)`);
  assert.ok(after.connectPax > 0, '환승 승객이 실려야 한다');
  assert.ok(after.loadFactor > before.loadFactor + 0.3, `허브가 태평양 간선을 채워야 한다 (${(before.loadFactor * 100).toFixed(0)}% → ${(after.loadFactor * 100).toFixed(0)}%)`);
});

test('환승: 한 여정이 두 구간의 좌석을 함께 먹는다', () => {
  // 여정 하나는 A→허브, 허브→C 두 구간을 동시에 쓴다. 한쪽만 깎으면 "한 승객이 두
  // 구간을 쓴다"는 전제가 깨져 허브 수송량이 통째로 부풀려진다.
  const hub = network(TOKYO_HUB, { home: 'tokyo' });
  const trunk = hub.byLeg['tokyo-losangeles'].connectPax;
  const spokes = hub.byLeg['seoul-tokyo'].connectPax + hub.byLeg['beijing-tokyo'].connectPax;
  // 이 배치에서 성립하는 후보는 서울→LA, 베이징→LA 둘뿐이다(서울–베이징은 우회 초과).
  assert.ok(Math.abs(trunk - spokes) < 1e-6, `간선 ${Math.round(trunk)} = 스포크 합 ${Math.round(spokes)} 이어야 한다`);
});

test('환승: 좌석을 넘겨 태우지 않는다', () => {
  const hub = network(TOKYO_HUB, { home: 'tokyo' });
  for (const key of Object.keys(hub.byLeg)) {
    const o = hub.byLeg[key];
    assert.ok(o.pax <= o.seats + 1e-6, `${key}: ${Math.round(o.pax)}명을 ${Math.round(o.seats)}석에 태웠다`);
  }
});

test('환승: 빈자리가 없으면 환승도 없다', () => {
  // 스포크가 로컬 수요로 이미 꽉 차 있으면 물어다 줄 자리가 없다. 이게 안 지켜지면
  // 노선을 늘리는 것만으로 공짜 환승 수입이 생긴다.
  const tight = network(
    [
      { from: 'tokyo', to: 'losangeles', typeId: 'b747-400', planes: 2, freq: 8 },
      { from: 'seoul', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14 },
      { from: 'beijing', to: 'tokyo', typeId: 'b737-800', planes: 3, freq: 14 },
    ],
    { home: 'tokyo' },
  );
  assert.ok(tight.byLeg['seoul-tokyo'].loadFactor > 0.99, '스포크가 꽉 차 있어야 이 검사가 산다');
  assert.ok(!tight.byLeg['tokyo-losangeles'].connectPax, '빈자리가 없으면 환승이 없어야 한다');
});

test('환승: 우회가 심하면 잇지 않는다', () => {
  // 서울–베이징을 도쿄로 돌리면 3.4배다. 이걸 막지 않으면 허브 하나로 온 세계를 잇는다.
  assert.ok(
    (C.distance('seoul', 'tokyo') + C.distance('tokyo', 'beijing')) / C.distance('seoul', 'beijing') >
      M.BALANCE.CONNECT_MAX_DETOUR,
    '서울–베이징이 우회 한계를 넘어야 이 검사가 산다',
  );
  const hub = network(TOKYO_HUB, { home: 'tokyo' });
  // 서울–베이징이 후보였다면 스포크 두 개의 환승 합이 간선의 환승보다 커진다.
  const trunk = hub.byLeg['tokyo-losangeles'].connectPax;
  const spokes = hub.byLeg['seoul-tokyo'].connectPax + hub.byLeg['beijing-tokyo'].connectPax;
  assert.ok(spokes <= trunk + 1e-6, '우회 초과 여정이 섞이면 안 된다');
});

test('환승: 노선을 적어 넣은 순서에 결과가 걸리지 않는다', () => {
  // 도시쌍을 하나씩 끝까지 태우고 넘어가면 먼저 처리된 쌍이 공용 구간의 빈자리를 통째로
  // 먹는다 — 정렬 순서가 곧 허브 경제가 된다. 라운드마다 희망 수요를 모아 비례로 깎는
  // 이유이고, 그 성질이 깨졌는지는 순열로만 잡힌다.
  const legs = TOKYO_HUB.concat([{ from: 'hongkong', to: 'tokyo', typeId: 'b767-300er', planes: 4, freq: 20 }]);
  const base = network(legs, { home: 'tokyo' });
  for (const perm of [
    [3, 1, 0, 2],
    [2, 0, 3, 1],
    [1, 2, 3, 0],
  ]) {
    const other = network(perm.map((i) => legs[i]), { home: 'tokyo' });
    for (const key of Object.keys(base.byLeg)) {
      assert.strictEqual(
        other.byLeg[key].connectPax,
        base.byLeg[key].connectPax,
        `${key}: 순서를 바꾸니 환승이 달라졌다`,
      );
    }
  }
});

test('환승: 공용 구간이 모자라면 도시쌍끼리 비례로 나눈다', () => {
  // 도시쌍을 하나씩 끝까지 태우고 넘어가면 먼저 처리된 쌍이 공용 구간의 빈자리를 통째로
  // 먹는다 — 정렬 순서가 곧 허브 경제가 되어, 도쿄–LA 의 빈자리를 베이징발이 다 가져가고
  // 서울발은 밀리는 식이 된다. 라운드마다 희망 수요를 모아 구간별로 비례 삭감하는 이유다.
  const hub = network(TOKYO_HUB, { home: 'tokyo' });
  assert.ok(hub.byLeg['tokyo-losangeles'].loadFactor > 0.99, '간선이 꽉 차야 경합이 생긴다');
  // 서울–LA 와 베이징–LA 는 수요도 거리도 거의 같다. 둘이 같은 간선을 두고 겨루므로
  // 비례로 깎으면 실린 인원도 비슷해야 한다 — 이름순으로 먹으면 크게 갈린다.
  const seoul = hub.byLeg['seoul-tokyo'].connectPax;
  const beijing = hub.byLeg['beijing-tokyo'].connectPax;
  const gap = Math.abs(seoul - beijing) / Math.max(seoul, beijing);
  assert.ok(gap < 0.1, `대칭인 두 도시쌍이 크게 갈렸다 (서울 ${Math.round(seoul)} vs 베이징 ${Math.round(beijing)})`);
});

test('환승: 직항이 없는 도시쌍에서도 로컬과 겨룬다', () => {
  // 1단계를 안 거친 도시쌍은 로컬을 빼면 경유편이 "안 감"만 상대로 이겨 수요를 대부분
  // 가져간다 — 직항 시장에는 로컬을 깔아 두고 환승 시장만 무주공산으로 두는 셈이라
  // 허브 수송량과 수입이 부푼다.
  //
  // 같은 모양의 허브를 로컬이 센 구간과 약한 구간에 놓고 잰다. 좌석이 병목이 되면
  // 로짓이 아니라 용량이 답을 정하므로, 양쪽 다 넉넉하게 깐다.
  const shape = (a, hub, c) => [
    { from: a, to: hub, typeId: 'b747-400', planes: 14, freq: 18 },
    { from: hub, to: c, typeId: 'b747-400', planes: 14, freq: 18 },
  ];
  const capture = (a, hub, c) => {
    const net = network(shape(a, hub, c), { home: hub });
    const market = D.quarterly(C.get(a), C.get(c), { quarter: 1, travelIndex: D.travelIndex(1998) }).total;
    return net.byLeg[`${a}-${hub}`].connectPax / market;
  };
  // 뉴욕–LA 는 로컬이 억세고(효용 1.4대), 서울–LA 는 거리 탓에 거의 없다(0 근처).
  const strong = M.fringeUtility(C.pairKey('newyork', 'losangeles'), C.distance('newyork', 'losangeles'));
  const weak = M.fringeUtility(C.pairKey('seoul', 'losangeles'), C.distance('seoul', 'losangeles'));
  assert.ok(strong > weak + 1, '두 구간의 로컬 세기가 갈려야 이 검사가 산다');

  const tough = capture('newyork', 'chicago', 'losangeles');
  const easy = capture('seoul', 'tokyo', 'losangeles');
  assert.ok(tough > 0 && easy > 0, '양쪽 다 경유편이 실려야 한다');
  assert.ok(easy < 1, '수요 전체를 가져가면 안 된다');
  assert.ok(tough < easy - 0.05, `로컬이 센 구간이 덜 잡혀야 한다 (${(tough * 100).toFixed(0)}% vs ${(easy * 100).toFixed(0)}%)`);
});

test('환승: 수입이 두 구간에 거리대로 나뉜다', () => {
  // 한쪽 구간에 몰아 주면 스포크가 공짜로 실어 나르는 셈이 되어 허브 채산이 뒤틀린다.
  const hub = network(TOKYO_HUB, { home: 'tokyo' });
  const trunk = hub.byLeg['tokyo-losangeles'];
  const spoke = hub.byLeg['seoul-tokyo'];
  assert.ok(trunk.connectRevenue > 0 && spoke.connectRevenue > 0, '양쪽 다 받아야 한다');
  // 같은 인원인데 간선이 7.6배 길다 — 수입도 간선이 훨씬 커야 한다.
  assert.ok(
    trunk.connectRevenue / trunk.connectPax > (spoke.connectRevenue / spoke.connectPax) * 3,
    '긴 구간이 더 가져가야 한다',
  );
});

test('채산: 큰 기체가 한 바퀴에 더 오래 묶인다', () => {
  const narrow = TYPES['b737-800'];
  const wide = TYPES['b747-400'];
  const d = C.distance('tokyo', 'losangeles');
  assert.ok(Econ.roundTripHours(wide, d) > Econ.roundTripHours(narrow, d), '조업시간이 길다');
  assert.ok(!Econ.canFly(narrow, d), '협동체로는 태평양을 못 건넌다');
  assert.ok(Econ.canFly(wide, d), '광동체는 건넌다');
});

// ── 항공사 상태와 분기 정산 ──

/** n분기를 굴린 판 (AI 없음 — 상태와 정산만 본다). */
function played(seed, quarters) {
  const s = St.newGame(seed);
  for (let i = 0; i < quarters; i++) St.advance(s);
  return s;
}

/** n분기를 굴린 판 (AI 포함 — 실제로 게임이 도는 모양). */
function playedWithAi(seed, quarters) {
  const s = St.newGame(seed);
  for (let i = 0; i < quarters; i++) St.advance(s, { beforeMarket: (st, rng) => Ai.actAll(st, rng) });
  return s;
}

test('상태: 새 판이 굴러가는 회사를 물려준다', () => {
  // 빈 회사로 시작하면 첫 몇 분기가 판단이 아니라 셋업이 된다.
  const s = St.newGame(1234);
  assert.strictEqual(s.airlines.length, Data.AIRLINES.length, '제조사 게임의 항공사가 그대로 온다');
  assert.ok(s.routes.length > 20, `창업 노선망이 있어야 한다 (${s.routes.length})`);
  for (const a of s.airlines) {
    assert.ok(C.get(a.home), `${a.id} 의 모기지가 실재해야 한다`);
    assert.ok(St.planesOf(s, a.id).length > 0, `${a.id} 에 기재가 있어야 한다`);
  }
  for (const r of s.routes) {
    const planes = St.assignedTo(s, r.id);
    assert.ok(planes.length > 0, `${r.from}–${r.to}: 기재 없는 노선이 있으면 안 된다`);
    const d = C.distance(r.from, r.to);
    for (const p of planes) {
      assert.ok(s.types[p.typeId].range >= d, `${r.from}–${r.to}: 항속이 모자란 기재를 붙였다`);
    }
    assert.ok(r.freq > 0, '편수가 0인 노선이 있으면 안 된다');
  }
});

test('상태: 창업 정비 시계가 흩어져 있다', () => {
  // 전부 0 에서 출발하면 창업 기단이 통째로 같은 분기에 입고돼 몇 해 뒤 노선망이
  // 한꺼번에 주저앉는다.
  const s = St.newGame(1234);
  const due = s.planes.map((p) => St.checkProgress(p));
  const spread = Math.max(...due) - Math.min(...due);
  assert.ok(spread > 0.5, `정비 시계가 흩어져야 한다 (폭 ${spread.toFixed(2)})`);
  for (const p of s.planes) assert.ok(!St.checkDue(p), '창업부터 입고 대기인 기체는 없다');
});

test('상태: 같은 시드면 20년을 굴려도 같은 판이다', () => {
  const key = (s) => s.airlines.map((a) => `${a.id}:${a.cash}:${a.alive}`).join('|') + `#${s.routes.length}#${s.planes.length}`;
  assert.strictEqual(key(played(1234, 40)), key(played(1234, 40)), '결정론이 깨졌다');
  assert.notStrictEqual(key(played(1234, 40)), key(played(9999, 40)), '시드가 달라도 같으면 난수를 안 쓰는 것이다');
});

test('상태: 중정비로 묶인 기체는 그 분기에 뜨지 않는다', () => {
  // 예비기 한 대를 놀리는 값이 여기서 나온다. 안 묶이면 기단은 "산 순간부터 영원히
  // 같은 좌석을 내놓는 숫자"라 노선에 딱 맞게 붙여 놓고 잊어도 아무 일이 없다.
  const s = St.newGame(1234);
  const p = s.planes.find((x) => x.routeId !== null);
  p.hoursSinceCheck = St.intervalHours(p.ageQuarters) * 2;
  St.scheduleChecks(s);
  assert.strictEqual(p.checkUntilTurn, s.turn, '입고돼야 한다');
  assert.ok(!St.flyingOn(s, p.routeId).some((x) => x.id === p.id), '뜨는 목록에서 빠져야 한다');
  assert.ok(St.assignedTo(s, p.routeId).some((x) => x.id === p.id), '배속은 유지돼야 한다');
});

test('상태: 굴린 기체가 세워 둔 기체보다 빨리 정비에 들어간다', () => {
  // 비행시간과 달력 중 먼저 차는 쪽으로 잰다 — 가동률에 값이 붙고, 예비기가 공짜
  // 보험이 되지 않는다.
  const s = St.newGame(1234);
  const flying = s.planes.find((p) => p.routeId !== null);
  const idle = s.planes.find((p) => p.routeId === null && p.airlineId === flying.airlineId);
  if (!idle) return; // 유휴기가 없는 판이면 건너뛴다
  flying.hoursSinceCheck = 0;
  idle.hoursSinceCheck = 0;
  for (let i = 0; i < 4; i++) St.advance(s);
  assert.ok(flying.hoursSinceCheck > idle.hoursSinceCheck, '굴린 쪽 시계가 더 돌아야 한다');
  assert.strictEqual(idle.hoursSinceCheck, 0, '세워 둔 기체는 비행시간이 안 쌓인다');
  assert.ok(idle.quartersSinceCheck > 0, '그래도 달력으로는 늙는다');
});

test('상태: 놀리는 슬롯도 임차료가 나간다', () => {
  // 고정비의 정의다. 놀려도 안 나가면 슬롯을 무한히 쥐고 있는 것이 지배 전략이 된다.
  const a = St.newGame(1234);
  const b = St.newGame(1234);
  const target = b.airlines[0];
  target.slots[target.home] += 40; // 아무 노선에도 안 쓰는 슬롯
  St.advance(a);
  St.advance(b);
  const na = a.airlines[0].results[0].net;
  const nb = target.results[0].net;
  assert.ok(nb < na, `놀리는 슬롯이 순익을 깎아야 한다 (${Math.round(na / 1e6)}M → ${Math.round(nb / 1e6)}M)`);
  assert.ok(target.results[0].slotRent > a.airlines[0].results[0].slotRent, '임차료가 늘어야 한다');
});

test('상태: 노선 손익에 그 노선이 문 슬롯값이 실린다', () => {
  // 회사 단위로만 걷으면 화면에도 AI 에게도 "조금 남는 노선"으로 보인다 — 실제로는
  // 슬롯값이 그보다 커서 회사를 갉아먹는데도.
  const s = played(1234, 1);
  const r = s.routes.find((x) => x.last && x.last.revenue > 0);
  const a = St.airline(s, r.airlineId);
  // 결산은 기령이 오르기 **전에** 돈다. 지금 다시 재려면 한 분기를 되돌려야 한다.
  const flying = St.flyingOn(s, r.id).map((p) => Object.assign({}, p, { ageQuarters: p.ageQuarters - 1 }));
  const cap = Econ.capacity(flying, C.distance(r.from, r.to), (t) => s.types[t]);
  const effective = Object.assign({}, r, { freq: Math.min(r.freq, cap.maxFreq) });
  const bare = Econ.routeCost(effective, flying, {
    typeOf: (t) => s.types[t], oil: s.world.oil, inflation: s.world.inflation,
    serviceLevel: a.serviceLevel, pax: r.last.pax, revenue: r.last.revenue,
  });
  assert.ok(r.last.cost > bare.total, '노선 원가가 운항 원가보다 커야 한다');
  const rent = r.freq * (St.slotRent(s, a.id, r.from) + St.slotRent(s, a.id, r.to));
  assert.ok(Math.abs(r.last.cost - bare.total - rent) < 1e-6, '차이가 정확히 슬롯 임차료여야 한다');
});

test('상태: 감가상각은 현금이 나가지 않는다', () => {
  const s = St.newGame(1234);
  const a = s.airlines[0];
  const before = a.cash;
  St.advance(s);
  const r = a.results[0];
  assert.ok(r.depreciation > 0, '상각이 잡혀야 한다');
  assert.ok(Math.abs(a.cash - (before + r.net + r.depreciation)) < 1e-6, '현금흐름 = 순익 + 상각');
});

test('상태: 세금은 흑자에만 붙는다', () => {
  // 규칙은 판 전체에서 지켜져야 하고, 양쪽 경우가 다 나와야 검사가 산다. 흑자 쪽은
  // 그냥 굴리면 나오고, 적자 쪽은 이자를 지워 만든다 (밸런스가 바뀌어도 안 흔들린다).
  const s = playedWithAi(1234, 4);
  let sawProfit = false;
  for (const a of s.airlines) {
    for (const r of a.results) {
      if (r.net > 0) sawProfit = true;
      if (r.net > 0) assert.ok(r.tax > 0, '흑자에는 세금이 붙는다');
      else assert.strictEqual(r.tax, 0, '적자에 세금을 물리면 안 된다');
    }
  }
  assert.ok(sawProfit, '흑자가 하나도 없으면 검사가 반쪽이다');

  const loser = St.newGame(1234);
  const a = loser.airlines[0];
  a.debt = 40e9; // 이자만으로 확실히 적자
  St.advance(loser);
  const r = a.results[0];
  assert.ok(r.net < 0, '적자를 만들었어야 한다');
  assert.strictEqual(r.tax, 0, '적자에 세금을 물리면 안 된다');
});

test('상태: 접힌 회사는 좌석을 내놓지 않는다', () => {
  // 남겨 두면 아무도 값을 치르지 않는 유령 항공사가 시장을 계속 누른다.
  const s = St.newGame(1234);
  const a = s.airlines[0];
  a.negativeQuarters = St.BALANCE.NEGATIVE_QUARTERS_TO_FOLD;
  a.cash = -1e9;
  St.advance(s);
  assert.ok(!a.alive, '접혀야 한다');
  assert.strictEqual(St.routesOf(s, a.id).length, 0, '노선이 남으면 안 된다');
  assert.strictEqual(St.planesOf(s, a.id).length, 0, '기재가 남으면 안 된다');
});

test('상태: 현금이 마르면 기재를 판다', () => {
  const s = St.newGame(1234);
  const a = s.airlines[0];
  const before = St.planesOf(s, a.id).length;
  a.cash = -200e6;
  St.advance(s);
  assert.ok(St.planesOf(s, a.id).length < before, '기재를 팔아 메워야 한다');
  assert.ok(a.cash >= 0 || St.planesOf(s, a.id).length === 0, '팔 게 남았으면 현금이 음수로 안 남는다');
});

test('상태: 해가 바뀌면 물가·여행 보급·도시가 자란다', () => {
  const s = St.newGame(1234);
  const inf0 = s.world.inflation;
  const idx0 = s.world.travelIndex;
  const dev0 = s.cityState.seoul.dev;
  for (let i = 0; i < 4; i++) St.advance(s);
  assert.ok(s.world.inflation > inf0, '물가가 올라야 한다');
  assert.ok(s.world.travelIndex > idx0, '여행 보급이 올라야 한다');
  assert.ok(s.cityState.seoul.dev > dev0, '도시가 자라야 한다');
  assert.strictEqual(St.yearOf(s), s.startYear + 1, '해가 넘어가야 한다');
});

test('상태: 제조사 쪽 유가가 항공사 연료비로 전해진다', () => {
  // 두 계층이 각자 세계를 흔들면 같은 분기에 제조사는 호황, 항공사는 불황인 판이 된다.
  const s = St.newGame(1234);
  const base = s.world.oil;
  St.syncWorld(s, { market: { fuelIndex: 1.6, demandIndex: 0.9 } });
  assert.ok(Math.abs(s.world.oil - base * 1.6) < 1e-9, '유가 지수가 그대로 곱해져야 한다');
  assert.strictEqual(s.world.economy, 0.9, '경기도 함께 온다');

  const cheap = St.newGame(1234);
  const dear = St.newGame(1234);
  St.syncWorld(dear, { market: { fuelIndex: 2, demandIndex: 1 } });
  St.advance(cheap);
  St.advance(dear);
  assert.ok(dear.airlines[0].results[0].fuel > cheap.airlines[0].results[0].fuel, '연료비가 올라야 한다');
});

test('상태: 굴려도 카탈로그를 건드리지 않는다', () => {
  // 상태가 공용 카탈로그를 가리키면 한 판이 다음 판을 오염시킨다.
  const before = JSON.stringify([Fleet.AIRCRAFT, Data.AIRLINES, C.CITIES]);
  played(4321, 12);
  assert.strictEqual(JSON.stringify([Fleet.AIRCRAFT, Data.AIRLINES, C.CITIES]), before, '카탈로그가 바뀌었다');
});

test('상태: 20년을 굴려도 판이 무너지지 않는다', () => {
  // AI 가 없는 채로도(4단계 전) 세계가 스스로 붕괴하면 안 된다 — 붕괴한다면 그건
  // AI 가 못 고치는 구조적 적자라는 뜻이다.
  const s = played(7, 80);
  const alive = s.airlines.filter((a) => a.alive).length;
  assert.ok(alive >= 8, `절반 넘게 살아 있어야 한다 (${alive}/12)`);
  assert.ok(s.routes.length > 10, '노선망이 남아야 한다');
  for (const a of s.airlines) {
    if (!a.alive) continue;
    assert.ok(a.cash >= 0, `${a.id}: 살아 있는데 현금이 음수다`);
    assert.ok(Number.isFinite(a.cash), `${a.id}: 현금이 수가 아니다`);
  }
});

// ── 명령 ──

test('명령: 실패하면 상태를 건드리지 않는다', () => {
  // 반쯤 적용되는 명령이 가장 나쁘다 — 슬롯만 사고 노선은 못 여는 식으로 돈이 샌다.
  const s = St.newGame(1234);
  const a = s.airlines[0];
  const before = JSON.stringify([a.cash, a.slots, s.routes.length, s.planes.map((p) => p.routeId)]);
  const idle = s.planes.filter((p) => p.airlineId === a.id && p.routeId === null);
  const bad = [
    () => Act.openRoute(s, a.id, a.home, a.home, [1], 3, 1),
    () => Act.openRoute(s, a.id, a.home, 'saopaulo', [], 3, 1),
    () => Act.openRoute(s, a.id, a.home, 'saopaulo', idle.length ? [idle[0].id] : [1], 999, 1),
    () => Act.buySlots(s, a.id, a.home, 99999),
    () => Act.buyAircraft(s, a.id, 'b737-800', 99999),
    () => Act.borrow(s, a.id, 1e12),
  ];
  for (const f of bad) assert.strictEqual(f().ok, false, '막혀야 하는 명령이 통과했다');
  assert.strictEqual(JSON.stringify([a.cash, a.slots, s.routes.length, s.planes.map((p) => p.routeId)]), before, '실패한 명령이 상태를 바꿨다');

  // 여러 항목을 한 번에 조정할 때가 특히 위험하다 — 순서대로 적용하면 편수에서 막혀도
  // 운임은 이미 바뀌어 있어, 화면은 "실패"라 말하는데 값은 달라져 있다.
  const r = St.routesOf(s, a.id)[0];
  const snap = JSON.stringify([r.fareMul, r.freq, r.serviceExtra]);
  assert.strictEqual(Act.tuneRoute(s, a.id, r.id, { fareMul: 1.4, serviceExtra: 2, freq: 99999 }).ok, false);
  assert.strictEqual(JSON.stringify([r.fareMul, r.freq, r.serviceExtra]), snap, '실패했는데 운임·서비스가 바뀌었다');
});

test('명령: 슬롯값은 한 자리마다 다시 매긴다', () => {
  // 현재 단가에 개수를 곱하면 실제보다 싸게 잡혀, 예산은 통과했는데 매입이 실패한다.
  // 그때 반대편 슬롯은 이미 사둔 뒤라 노선도 못 열고 슬롯만 놀린다.
  const s = St.newGame(1234);
  const a = s.airlines[0];
  const one = Act.slotPrice(s, a.id, 'frankfurt');
  const ten = Act.slotCost(s, a.id, 'frankfurt', 10);
  assert.ok(ten > one * 10, `열 자리가 한 자리의 열 배보다 비싸야 한다 (${Math.round(ten / 1e6)}M vs ${Math.round((one * 10) / 1e6)}M)`);
  const before = St.slotsAt(a, 'frankfurt');
  Act.slotCost(s, a.id, 'frankfurt', 5);
  assert.strictEqual(St.slotsAt(a, 'frankfurt'), before, '값을 재는 것만으로 슬롯이 늘면 안 된다');
});

test('명령: 항속이 모자라면 취항을 막는다', () => {
  const s = St.newGame(1234);
  const a = St.airline(s, 'nordic'); // 터보프롭·리저널기만 굴린다
  Act.buySlots(s, a.id, 'sydney', 5);
  const idle = s.planes.find((p) => p.airlineId === a.id && p.routeId === null);
  const r = Act.openRoute(s, a.id, a.home, 'sydney', [idle.id], 3, 1);
  assert.strictEqual(r.ok, false, '스톡홀름–시드니를 리저널기로 열면 안 된다');
  assert.ok(/항속/.test(r.msg), `왜 안 되는지 말해야 한다 (${r.msg})`);
});

test('명령: 노선을 접으면 기재가 풀리고 실적은 남는다', () => {
  // 노선을 지우면 이번 분기 결산에서 그 노선의 손익이 통째로 증발한다.
  const s = played(1234, 1);
  const r = s.routes.find((x) => x.active && x.last);
  const n = St.assignedTo(s, r.id).length;
  assert.ok(n > 0);
  assert.strictEqual(Act.closeRoute(s, r.airlineId, r.id).ok, true);
  assert.strictEqual(St.assignedTo(s, r.id).length, 0, '기재가 풀려야 한다');
  assert.ok(s.routes.some((x) => x.id === r.id), '노선 기록은 남아야 한다');
  assert.ok(r.last, '접은 분기의 실적이 남아야 한다');
});

test('명령: 슬롯 반납은 쓰지 않는 자리만 된다', () => {
  const s = St.newGame(1234);
  const a = s.airlines[0];
  const used = Act.usedSlots(s, a.id, a.home);
  const have = St.slotsAt(a, a.home);
  assert.ok(used > 0 && have > used, '쓰는 자리와 노는 자리가 다 있어야 한다');
  assert.strictEqual(Act.sellSlots(s, a.id, a.home, have).ok, false, '쓰는 자리까지 반납하면 안 된다');
  assert.strictEqual(Act.sellSlots(s, a.id, a.home, have - used).ok, true, '노는 자리는 반납된다');
  assert.strictEqual(St.slotsAt(a, a.home), used, '쓰는 만큼만 남아야 한다');
});

test('명령: 발주는 값을 지금 치르고 기재는 나중에 온다', () => {
  const s = St.newGame(1234);
  const a = s.airlines[0];
  const t = s.types['b737-400'];
  const before = { cash: a.cash, planes: St.planesOf(s, a.id).length };
  assert.strictEqual(Act.buyAircraft(s, a.id, 'b737-400', 2).ok, true);
  assert.ok(Math.abs(a.cash - (before.cash - t.price * 2)) < 1e-6, '대금이 바로 나가야 한다');
  assert.strictEqual(St.planesOf(s, a.id).length, before.planes, '기재는 아직 안 온다');
  for (let i = 0; i < Act.ORDER_QUARTERS; i++) St.advance(s);
  assert.strictEqual(St.planesOf(s, a.id).length, before.planes + 2, `${Act.ORDER_QUARTERS}분기 뒤에 와야 한다`);
});

test('명령: 아직 안 나온 기종·단종된 기종은 못 산다', () => {
  const s = St.newGame(1234); // 1998년
  assert.strictEqual(Act.buyAircraft(s, s.airlines[0].id, 'a320neo', 1).ok, false, '2016년 기종을 1998년에 살 수 없다');
  assert.strictEqual(Act.buyAircraft(s, s.airlines[0].id, 'b737-400', 1).ok, true, '당대 기종은 살 수 있다');
  // 취항 시점이 분기 단위라 정수 연도로 재면 안 된다 — 737-800 은 1998년 2분기 취항이다.
  assert.strictEqual(Act.buyAircraft(s, s.airlines[0].id, 'b737-800', 1).ok, false, '1998년 1분기에는 아직 없다');
  St.advance(s);
  assert.strictEqual(Act.buyAircraft(s, s.airlines[0].id, 'b737-800', 1).ok, true, '2분기가 되면 살 수 있다');
});

// ── 노선망 AI ──

test('AI: 20년을 굴리면 세계가 자란다', () => {
  // AI 가 없으면 세계가 창업 노선망에 20년 동안 얼어붙는다 — 요지를 선점하는 것도
  // 늦게 들어가는 것도 아무 뜻이 없어진다.
  const before = St.newGame(1234);
  const after = playedWithAi(1234, 80);
  const grew = after.routes.filter((r) => r.active).length;
  assert.ok(grew > before.routes.length * 3, `노선망이 자라야 한다 (${before.routes.length} → ${grew})`);
  assert.ok(after.planes.length > before.planes.length, '기재도 늘어야 한다');
  const cities = new Set(after.routes.filter((r) => r.active).flatMap((r) => [r.from, r.to]));
  assert.ok(cities.size > 30, `세계 곳곳으로 퍼져야 한다 (${cities.size}개 도시)`);
});

test('AI: 20년을 굴려도 판이 한쪽으로 굳지 않는다', () => {
  // 밸런스의 본체다. 아무도 안 죽으면 결정에 무게가 없고, 한 회사가 세계를 삼키면
  // 나머지 판이 관전이 된다.
  const s = playedWithAi(1234, 80);
  const alive = s.airlines.filter((a) => a.alive);
  assert.ok(alive.length >= 8, `절반 넘게 살아야 한다 (${alive.length}/12)`);
  const eq = alive.map((a) => St.equity(s, a)).sort((x, y) => y - x);
  assert.ok(eq[0] / eq[eq.length - 1] < 60, `1위와 꼴찌가 60배 안쪽이어야 한다 (${(eq[0] / eq[eq.length - 1]).toFixed(0)}배)`);
  for (const a of alive) assert.ok(Number.isFinite(a.cash) && a.cash >= 0, `${a.id}: 현금이 이상하다`);
});

test('AI: 성격이 운임에 드러난다', () => {
  // 두 계층에서 같은 회사가 같은 성격이어야 한다 — 라이언에어는 싸게 많이 깔고,
  // 에미레이트는 비싸게 크게 간다. 성격을 새로 만들면 두 게임이 어긋난다.
  assert.ok(Ai.targetFare('vertex') < Ai.targetFare('hanul'), '저가 항공사가 더 싸게 매겨야 한다');
  assert.ok(Ai.targetFare('carta') > Ai.targetFare('vertex'), '프리미엄이 더 비싸게 매겨야 한다');
  const s = playedWithAi(1234, 40);
  const avg = (id) => {
    const rs = St.routesOf(s, id).filter((r) => r.active);
    return rs.length ? rs.reduce((x, r) => x + r.fareMul, 0) / rs.length : null;
  };
  const cheap = avg('vertex');
  const dear = avg('carta');
  if (cheap !== null && dear !== null) assert.ok(cheap < dear, `실제 운임도 갈려야 한다 (${cheap.toFixed(2)} vs ${dear.toFixed(2)})`);
});

test('AI: 슬롯이 막힌 노선에 기재를 밀어 넣지 않는다', () => {
  // 기재를 늘려도 편수가 못 오르니 값만 나가고, 그 자리가 매 분기 다시 비어 보여
  // AI 가 기재를 무한히 밀어 넣는다 — 실제로 노선당 열한 대까지 갔다.
  const s = playedWithAi(1234, 80);
  for (const r of s.routes) {
    if (!r.active) continue;
    const n = St.assignedTo(s, r.id).length;
    assert.ok(n <= 6, `${r.from}–${r.to}: 한 노선에 ${n}대가 붙었다`);
  }
  const active = s.routes.filter((r) => r.active).length;
  const assigned = s.planes.filter((p) => p.routeId !== null).length;
  assert.ok(assigned / active < 2.5, `노선당 기재가 과하다 (${(assigned / active).toFixed(1)}대)`);
});

test('AI: 오래 노는 슬롯은 내놓되 곧바로 내놓지는 않는다', () => {
  // 쌓아 두는 것만으로 임차료가 나가지만, 그 자리에서 내놓으면 다음 분기에 같은 자리를
  // 더 비싼 값에 되산다(슬롯값은 마를수록 오른다). 즉시 반납으로 두면 20년 자기자본
  // 중앙값이 2,638M 에서 2,337M 로 떨어졌다.
  const s = St.newGame(1234);
  const a = St.airline(s, 'sahara'); // 항속이 짧아 늘어난 슬롯을 곧바로 못 쓴다
  const far = 'saopaulo';
  a.slots[far] = 12;
  const rng = { range: () => 0, chance: () => false };

  Ai.act(s, a.id, rng);
  assert.strictEqual(St.slotsAt(a, far), 12, '한 분기 놀았다고 바로 내놓으면 안 된다');
  for (let i = 1; i < Ai.BALANCE.SHED_AFTER; i++) Ai.act(s, a.id, rng);
  assert.ok(St.slotsAt(a, far) < 12, `${Ai.BALANCE.SHED_AFTER}분기 내리 놀면 내놔야 한다`);

  // 20년을 굴린 판에서도 노는 자리가 쌓여 있으면 안 된다.
  const long = playedWithAi(1234, 80);
  for (const x of long.airlines) {
    if (!x.alive) continue;
    let idle = 0;
    let held = 0;
    for (const c of Object.keys(x.slots)) {
      idle += Math.max(0, Act.freeSlots(long, x.id, c));
      held += x.slots[c];
    }
    assert.ok(idle / Math.max(1, held) < 0.35, `${x.id}: 쥔 슬롯의 ${Math.round((idle / held) * 100)}%가 논다`);
  }
});

test('AI: 밖으로 나간다 — 창업 도시에 갇히지 않는다', () => {
  // 취항 후보를 고를 때 목적지 슬롯 매입비를 빼먹으면 AI 는 창업 때 받은 다섯 도시
  // 밖으로 영영 나가지 못한다.
  const start = St.newGame(1234);
  const s = playedWithAi(1234, 80);
  for (const a of s.airlines) {
    if (!a.alive) continue;
    const home = new Set(Object.keys(St.airline(start, a.id).slots));
    const now = new Set(St.routesOf(s, a.id).filter((r) => r.active).flatMap((r) => [r.from, r.to]));
    const outside = [...now].filter((c) => !home.has(c));
    assert.ok(outside.length > 0, `${a.id}: 창업 도시 밖으로 한 곳도 못 나갔다`);
  }
});

test('AI: 같은 시드면 20년이 통째로 같다', () => {
  const key = (s) =>
    s.airlines.map((a) => `${a.id}:${Math.round(a.cash)}:${a.alive}`).join('|') +
    `#${s.routes.length}#${s.planes.length}#${s.routes.filter((r) => r.active).map((r) => r.freq).join(',')}`;
  assert.strictEqual(key(playedWithAi(1234, 80)), key(playedWithAi(1234, 80)), 'AI 가 결정론을 깼다');
});

test('AI: 플레이어 회사는 건드리지 않는다', () => {
  // 5단계에서 플레이어가 직접 굴릴 회사다. AI 가 같이 손대면 명령이 덮어써진다.
  const s = St.newGame(1234);
  const me = s.airlines[0].id;
  const before = JSON.stringify(St.routesOf(s, me));
  for (let i = 0; i < 8; i++) St.advance(s, { beforeMarket: (st, rng) => Ai.actAll(st, rng, { playerId: me }) });
  const after = St.routesOf(s, me);
  assert.strictEqual(after.length, JSON.parse(before).length, '노선 수가 그대로여야 한다');
  for (const r of after) assert.strictEqual(r.fareMul, 1, 'AI 가 운임을 건드리면 안 된다');
});

// ── 화면 ──

/**
 * 화면 렌더러는 순수 함수라 브라우저 없이 잰다. 실제 조작·레이아웃은 별도로 브라우저에서
 * 확인했고(가로 넘침 0 · 콘솔 오류 없음), 여기서는 **문자열이 깨지지 않는가**만 본다 —
 * 그게 깨지면 화면이 통째로 빈 칸이 되는데 테스트가 없으면 눌러 보기 전에는 모른다.
 */
const SCREENS = [
  ['개요', (s, me, f) => SP.renderOverview(s, me, f)],
  ['노선', (s, me, f) => SP.renderRoutes(s, me, f)],
  ['취항', (s, me, f) => SP.renderOpen(s, me, f)],
  ['기재', (s, me, f) => SP.renderFleet(s, me, f)],
  ['지도', (s, me, f) => SP.renderMap(s, me, f)],
  ['기록', (s, me, f) => SP.renderHistory(s, me, f)],
];

test('화면: 새 판에서도, 20년 굴린 판에서도 그려진다', () => {
  for (const s of [St.newGame(1234), playedWithAi(1234, 80)]) {
    const me = s.airlines.find((a) => a.alive).id;
    for (const [name, render] of SCREENS) {
      const html = render(s, me, new Set());
      assert.ok(html && html.length > 40, `${name}: 화면이 비었다`);
      assert.ok(!/undefined|NaN|\[object/.test(html), `${name}: 화면에 undefined/NaN 이 샜다`);
    }
  }
});

test('화면: 노선도 기재도 없는 회사에서 터지지 않는다', () => {
  // 노선을 전부 접고 기재를 다 판 회사가 실제로 생긴다. 여기서 예외가 나면 화면이
  // 통째로 빈 칸이 되어 되돌릴 방법이 없다.
  const s = St.newGame(1234);
  const me = s.airlines[0].id;
  for (const r of St.routesOf(s, me).slice()) Act.closeRoute(s, me, r.id);
  s.planes = s.planes.filter((p) => p.airlineId !== me);
  for (const [name, render] of SCREENS) {
    const html = render(s, me, new Set());
    assert.ok(html && html.length > 20, `${name}: 빈 회사에서 화면이 비었다`);
  }
});

test('화면: 회사 이름이 태그로 해석되지 않는다', () => {
  // 항공사 이름은 세이브에서 오고, 세이브는 사람이 고칠 수 있다.
  const s = St.newGame(1234);
  const me = s.airlines[0];
  me.name = '<img src=x onerror=alert(1)>';
  const html = SP.renderOverview(s, me.id, new Set());
  assert.ok(!/<img/.test(html), '이름이 태그로 나갔다');
  assert.ok(/&lt;img/.test(html), '이스케이프된 형태로는 있어야 한다');
});

test('화면: 취항 후보가 같은 구간을 두 번 내놓지 않는다', () => {
  // 양쪽 다 슬롯을 가진 구간은 출발지 순회에서 두 번 걸린다.
  const s = St.newGame(1234);
  const me = s.airlines[0].id;
  const seen = new Set();
  // 상한을 크게 준다 — 기본 24개만 보면 중복 쌍이 잘려 나가 검사가 헛돈다.
  for (const c of SP.openCandidates(s, me, 500)) {
    const key = C.pairKey(c.from, c.to);
    assert.ok(!seen.has(key), `${c.from}–${c.to}: 같은 구간이 두 번 나왔다`);
    seen.add(key);
  }
});

test('화면: 후보 비용은 화면과 실제 매입이 같은 값이다', () => {
  // 예산은 통과했는데 매입이 실패하면, 반대편 슬롯은 이미 사둔 뒤라 노선도 못 열고
  // 슬롯만 놀린다. 화면이 보여준 값 그대로 빠져나가야 한다.
  const s = St.newGame(1234);
  const me = s.airlines[0];
  const c = SP.openCandidates(s, me.id).find((x) => x.needFrom + x.needTo > 0);
  assert.ok(c, '슬롯을 사야 하는 후보가 있어야 이 검사가 산다');
  const before = me.cash;
  if (c.needFrom) assert.strictEqual(Act.buySlots(s, me.id, c.from, c.needFrom).ok, true);
  if (c.needTo) assert.strictEqual(Act.buySlots(s, me.id, c.to, c.needTo).ok, true);
  const freq = Math.min(c.freq, Act.freeSlots(s, me.id, c.from), Act.freeSlots(s, me.id, c.to));
  assert.strictEqual(Act.openRoute(s, me.id, c.from, c.to, [c.plane.id], freq, 1).ok, true);
  assert.ok(Math.abs(before - me.cash - c.cost) < 1e-6, `화면 ${Math.round(c.cost / 1e6)}M vs 실제 ${Math.round((before - me.cash) / 1e6)}M`);
});

test('화면: 값을 재는 것만으로 상태가 바뀌지 않는다', () => {
  // 슬롯값을 재려고 슬롯 수를 올렸다 되돌린 적이 있다. 한 번도 안 가진 도시에 `0` 짜리
  // 키가 남아 "슬롯을 가진 도시"가 세계 전체로 불어났고, 취항 후보 화면이 이스탄불을
  // 대한항공의 거점으로 내놨다.
  const s = St.newGame(1234);
  const me = s.airlines[0];
  const before = JSON.stringify([me.slots, me.cash]);
  Act.slotCost(s, me.id, 'saopaulo', 8);
  SP.openCandidates(s, me.id);
  assert.strictEqual(JSON.stringify([me.slots, me.cash]), before, '조회가 상태를 바꿨다');
});

// ── 리뷰에서 잡힌 자리 ──

test('채산: 원가는 기재가 실제로 뛸 수 있는 편수까지만 청구한다', () => {
  // 시장은 기재 한계로 잘라 좌석을 내놓는데 원가가 설정 편수 그대로 청구하면,
  // 중정비로 기체가 빠진 분기마다 멀쩡한 노선이 적자로 뒤집힌다.
  const s = St.newGame(1234);
  const r = St.routesOf(s, s.airlines[0].id)[0];
  const flying = St.flyingOn(s, r.id);
  const dist = C.distance(r.from, r.to);
  const cap = Econ.capacity(flying, dist, (t) => s.types[t]);
  const cost = (freq) =>
    Econ.routeCost(Object.assign({}, r, { freq }), flying, {
      typeOf: (t) => s.types[t], oil: 1, inflation: 1, serviceLevel: 3, pax: 0, revenue: 0,
    }).total;
  assert.ok(cost(r.freq) < cost(cap.maxFreq), '한계까지는 편수를 올릴수록 비싸야 한다');
  assert.strictEqual(cost(cap.maxFreq * 5), cost(cap.maxFreq), '한계를 넘으면 더 청구하면 안 된다');
});

test('채산: 항속이 모자란 기재는 좌석을 만들지 않는다', () => {
  // 명령 계층이 막고 있지만, 수송력을 재는 쪽이 스스로 확인하지 않으면 그 검사를
  // 우회한 경로(옛 세이브, 손으로 넣은 노선)가 곧바로 좌석과 수입을 만든다.
  const s = St.newGame(1234);
  const a = s.airlines[0];
  a.slots.tokyo = 20;
  a.slots.losangeles = 20;
  const p = St.planesOf(s, a.id).find((x) => x.routeId === null);
  assert.ok(!Econ.canFly(s.types[p.typeId], C.distance('tokyo', 'losangeles')), '못 나는 기체여야 검사가 산다');
  s.routes.push({ id: 9001, airlineId: a.id, from: 'tokyo', to: 'losangeles', fareMul: 1, freq: 5, serviceExtra: 0, active: true, last: null });
  p.routeId = 9001;
  const out = M.resolveAll(s.routes, St.marketContext(s));
  assert.ok(!out[9001], '태평양을 못 건너는 기체가 좌석을 내놨다');
});

test('상태: 공항이 닫히면 아예 뜨지 않는다', () => {
  // 수요만 0 으로 두면 빈 비행기가 연료·승무원·착륙료를 그대로 물며 계속 난다.
  const s = St.newGame(1234);
  const r = St.routesOf(s, s.airlines[0].id)[0];
  const plane = St.assignedTo(s, r.id)[0];
  const hours0 = plane.hoursSinceCheck;
  s.cityState[r.to].closedUntilTurn = s.turn + 2;
  St.advance(s);
  assert.strictEqual(r.last.seats, 0, '좌석을 내놓으면 안 된다');
  assert.strictEqual(r.last.cost, 0, '원가가 붙으면 안 된다');
  assert.strictEqual(plane.hoursSinceCheck, hours0, '비행시간도 안 쌓여야 한다');
});

test('상태: 접힌 회사에 기재가 인도되지 않는다', () => {
  // 미인도 발주를 남겨 두면 몇 분기 뒤 이미 없는 회사 앞으로 기체가 들어와,
  // 아무도 결산하지 않고 아무도 치우지 않는 유령 기재가 된다.
  const s = St.newGame(1234);
  const a = s.airlines[0];
  assert.strictEqual(Act.buyAircraft(s, a.id, 'b737-400', 2).ok, true);
  a.negativeQuarters = St.BALANCE.NEGATIVE_QUARTERS_TO_FOLD;
  a.cash = -1e9;
  for (let i = 0; i < 4; i++) St.advance(s);
  assert.ok(!a.alive, '접혀야 한다');
  assert.strictEqual(St.planesOf(s, a.id).length, 0, '유령 기재가 생겼다');
  assert.strictEqual((s.orders || []).filter((o) => o.airlineId === a.id).length, 0, '주문이 남았다');
});

test('상태: 해가 바뀌면 유가 기준선도 옮긴다', () => {
  // 안 옮기면 1998년 값(0.21)이 20년 내내 굳어 2008년 이후의 고유가 구간이 사라진다.
  const s = St.newGame(1234);
  assert.ok(Math.abs(s.world.oil - St.oilFor(1998)) < 1e-9);
  for (let i = 0; i < 48; i++) St.advance(s);
  assert.strictEqual(St.yearOf(s), 2010);
  assert.ok(Math.abs(s.world.oil - St.oilFor(2010)) < 1e-9, `2010년 유가가 ${s.world.oil} 이다`);

  // 제조사 쪽 지수는 해가 바뀌어도 살아남아야 한다 — 두 계층이 한 세계를 산다.
  const t = St.newGame(1234);
  St.syncWorld(t, { market: { fuelIndex: 1.5, demandIndex: 1 } });
  for (let i = 0; i < 4; i++) St.advance(t);
  assert.ok(Math.abs(t.world.oil - St.oilFor(1999) * 1.5) < 1e-9, '연동 지수가 날아갔다');
});

test('상태: 시작 연도에 아직 없는 기종으로 시작하지 않는다', () => {
  // 예전에는 음수 기령이 2분기로 잘려 1990년 판이 A330·777 을 물고 시작했다.
  for (const year of [1990, 1998, 2010]) {
    const s = St.newGame(1234, { startYear: year });
    for (const p of s.planes) {
      const t = s.types[p.typeId];
      assert.ok(t.eis <= year, `${year}년 판이 ${t.name}(${t.eis}년 취항)을 깔았다`);
      assert.ok(p.ageQuarters >= 2, '기령이 2분기 미만일 수 없다');
    }
    assert.ok(s.routes.length > 10, `${year}년 판에 창업 노선망이 있어야 한다`);
  }
});

test('상태: 결산 기록의 잔액이 실제 잔액과 같다', () => {
  // 급한 매각을 기록 뒤에 두면 현금이 마이너스인 채로 기록되고 실제 잔액은 플러스가
  // 되어, 화면의 재무 기록과 상태가 어긋난다.
  const s = St.newGame(1234);
  const a = s.airlines[0];
  a.cash = -200e6;
  St.advance(s);
  const r = a.results[a.results.length - 1];
  assert.ok(a.cash > 0, '매각으로 메웠어야 한다');
  assert.ok(Math.abs(r.cash - a.cash) < 1e-6, `기록 ${Math.round(r.cash / 1e6)}M vs 실제 ${Math.round(a.cash / 1e6)}M`);
  // 자본은 결산 시점 값이라 지금과 딱 같지는 않다 — 그 뒤에 기재가 한 분기 늙었다.
  // 매각 전 값이 남았는지만 가린다: 그러면 자본이 매각액만큼 어긋난다.
  assert.ok(r.equity > 0 && Math.abs(r.equity - St.equity(s, a)) < 20e6, `자본 기록 ${Math.round(r.equity / 1e6)}M 이 매각 전 값이다`);
});

test('상태: 선급 발주가 자기자본을 꺼뜨리지 않는다', () => {
  // 인도 전까지 선급금으로 안 잡으면 대형 발주 한 번에 자본이 두 분기 동안 발주액만큼
  // 꺼졌다가 인도와 함께 되살아난다 — 그동안 차입 한도가 깎이고 자본잠식으로 오인된다.
  const s = St.newGame(1234);
  const a = St.airline(s, 'carta');
  const before = St.equity(s, a);
  const cap = St.debtCap(s, a);
  assert.strictEqual(Act.buyAircraft(s, a.id, 'b747-400', 3).ok, true);
  assert.ok(Math.abs(St.equity(s, a) - before) < 1e-6, '발주만으로 자본이 움직였다');
  assert.ok(Math.abs(St.debtCap(s, a) - cap) < 1e-6, '차입 한도가 움직였다');
});

test('상태: 팔 수 있는 프로그램만 기종 표에 든다', () => {
  // 개발 중이거나 심사 중인 설계는 아직 존재하지 않는 기체다 — 넣으면 항공사가
  // 그걸 발주하고 노선에 붙인다.
  const spec = { id: 'p1', name: '시제기', segment: 'narrow', seats: 180, range: 5000, efficiency: 60, listPrice: 90 };
  // `sold` 는 "다 만들어 팔았다"가 아니라 **개발을 접고 도면을 넘겼다**는 뜻이다 —
  // `sellProgram` 은 dev·cert 단계만 받는다. 완성되지도 않았고 우리 것도 아니다.
  for (const phase of ['dev', 'cert', 'cancelled', 'sold']) {
    assert.ok(!St.typeTable([Object.assign({}, spec, { phase })]).p1, `${phase} 인데 표에 들었다`);
  }
  assert.ok(St.typeTable([Object.assign({}, spec, { phase: 'production' })]).p1, '양산 기종은 들어야 한다');
});

test('화면: 닫힌 공항은 취항 후보에 없다', () => {
  // 누르면 슬롯부터 사고 나서 openRoute 가 폐쇄를 이유로 물린다 — 노선은 못 열고
  // 슬롯값만 치르게 된다. AI 는 이미 거른다.
  const s = St.newGame(1234);
  const me = s.airlines[0];
  const before = SP.openCandidates(s, me.id, 500);
  assert.ok(before.length > 0, '후보가 있어야 검사가 산다');
  const victim = before[0].to;
  s.cityState[victim].closedUntilTurn = s.turn + 2;
  const after = SP.openCandidates(s, me.id, 500);
  assert.ok(!after.some((c) => c.from === victim || c.to === victim), `${victim} 이 닫혔는데 후보에 남았다`);
  assert.ok(after.length < before.length, '후보가 줄어야 한다');

  // 출발지가 닫힌 경우도 마찬가지다.
  s.cityState[victim].closedUntilTurn = -1;
  s.cityState[me.home].closedUntilTurn = s.turn + 2;
  assert.ok(
    !SP.openCandidates(s, me.id, 500).some((c) => c.from === me.home),
    '모기지가 닫혔는데 거기서 뜨는 후보가 남았다',
  );
});

test('상태: 프로그램이 바뀌면 기종 표가 따라간다', () => {
  // 표를 한 번 만들어 두고 잊으면, 새로 나온 기체는 typeOf 가 undefined 를 돌려주고
  // 개량된 기체는 옛 값·옛 연비로 계속 굴러간다.
  const spec = { id: 'p1', name: '신형', phase: 'dev', segment: 'narrow', seats: 180, range: 5000, efficiency: 60, listPrice: 90 };
  const programs = [spec];
  const s = St.newGame(1234, { programs });
  assert.ok(!s.types.p1, '개발 중에는 없어야 한다');
  spec.phase = 'production';
  St.advance(s, { programs });
  assert.ok(s.types.p1, '양산에 들어가면 표에 와야 한다');
  spec.listPrice = 120;
  St.advance(s, { programs });
  assert.strictEqual(s.types.p1.price, 120e6, '값이 바뀌면 따라가야 한다');

  // 이미 굴러다니는 기재의 기종은 표에서 빠져도 남는다 — 단종은 "새로 못 산다"이지
  // "하늘에서 사라진다"가 아니다.
  s.planes.push({ id: 99999, typeId: 'p1', airlineId: s.airlines[0].id, ageQuarters: 4, routeId: null, hoursSinceCheck: 0, quartersSinceCheck: 0, checkUntilTurn: -1 });
  spec.phase = 'cancelled';
  St.refreshTypes(s, programs);
  assert.ok(s.types.p1, '굴러다니는 기체의 기종이 사라졌다');
});

test('기종: 정비 편의 설계가 항공사 계층에서도 값을 한다', () => {
  // 입찰 점수는 이미 운항원가에 0.88 을 걸고 개발비·기체값을 더 받는다. 여기서
  // 빠뜨리면 항공사 계층에서만 그 대가가 공짜가 된다.
  const base = { id: 'x', name: '시험기', segment: 'narrow', seats: 180, range: 5000, efficiency: 60, listPrice: 90 };
  const plain = T.fromProgram(Object.assign({}, base, { maintainable: false }), '회사');
  const maint = T.fromProgram(Object.assign({}, base, { maintainable: true }), '회사');
  assert.ok(maint.maint < plain.maint, '정비비가 싸야 한다');
  assert.ok(maint.turn < plain.turn, '지상조업이 짧아야 한다');
  assert.strictEqual(maint.seats, plain.seats, '제원까지 달라지면 안 된다');
});

test('기종: 우리 터보프롭 설계도 제트기 속도로 날지 않는다', () => {
  // 급별 상수만 쓰면 1998년 리저널 설계가 기본으로 다는 PW127 터보프롭이 815km/h 로
  // 날아, 같은 엔진을 단 ATR 보다 훨씬 많은 편을 뛴다.
  const base = { id: 'x', name: '시험기', segment: 'regional', seats: 70, range: 1800, efficiency: 55, listPrice: 30 };
  const prop = T.fromProgram(Object.assign({}, base, { engine: 'pw127' }), '회사');
  const jet = T.fromProgram(Object.assign({}, base, { engine: 'cf34' }), '회사');
  assert.ok(prop.speed < jet.speed, `터보프롭이 느려야 한다 (${prop.speed} vs ${jet.speed})`);
  assert.ok(prop.speed < T.SPEED.regional, '리저널 제트 상수보다 느려야 한다');
  const d = C.distance('seoul', 'tokyo');
  assert.ok(Econ.roundTripHours(prop, d) > Econ.roundTripHours(jet, d), '한 바퀴가 더 길어야 한다');
});

test('환승: 실제로 뜬 편수로 매력을 잰다', () => {
  // 중정비로 기재가 빠져 주 2회밖에 못 뜨는 노선이 주 100회짜리 매력으로 환승 수요를
  // 끌어가면, 남은 빈자리에 감당 못 할 손님이 몰린다.
  const s = St.newGame(1234);
  const out = M.resolveAll(s.routes, St.marketContext(s));
  for (const r of s.routes) {
    if (!out[r.id]) continue;
    const dist = C.distance(r.from, r.to);
    const cap = Econ.capacity(St.flyingOn(s, r.id), dist, (t) => s.types[t]);
    assert.strictEqual(out[r.id].freq, Math.min(r.freq, cap.maxFreq), `${r.from}–${r.to}: 시장이 내놓은 편수가 한계와 다르다`);
  }
});

test('명령: 수가 아닌 값과 소수를 막는다', () => {
  const s = St.newGame(1234);
  const a = s.airlines[0];
  const r = St.routesOf(s, a.id)[0];
  // 소수 대수를 받으면 값은 1.1대 어치만 받고 인도 루프는 두 대를 만든다.
  assert.strictEqual(Act.buyAircraft(s, a.id, 'b737-400', 1.1).ok, false, '소수 대수');
  assert.strictEqual(Act.buyAircraft(s, a.id, 'b737-400', NaN).ok, false, 'NaN 대수');
  assert.strictEqual(Act.buySlots(s, a.id, a.home, 1.5).ok, false, '소수 슬롯');
  assert.strictEqual(Act.tuneRoute(s, a.id, r.id, { freq: 2.5 }).ok, false, '소수 편수');
  assert.strictEqual(Act.tuneRoute(s, a.id, r.id, { fareMul: NaN }).ok, false, 'NaN 운임');
});

// ── 플레이어가 AI 와 같은 수를 둘 수 있는가 ──

/**
 * 화면 컨트롤러(`js/sky/ui.js`)는 브라우저가 있어야 굴러가므로, 여기서는 **화면이 그
 * 명령을 내놓는가**를 만들어진 HTML 에서 본다. AI 는 쓰는데 화면에 버튼이 없으면
 * 플레이어만 그 수를 못 두고, "같은 문을 쓴다"는 전제가 무너진다.
 */
function screenFor(render, s, me) {
  return render(s, me, new Set());
}

test('화면: AI 가 쓰는 명령은 플레이어에게도 버튼이 있다', () => {
  const s = playedWithAi(1234, 12);
  const me = s.airlines.find((a) => a.alive).id;
  // 노는 슬롯을 만들어 반납 버튼이 뜨는 조건을 세운다.
  const a = St.airline(s, me);
  a.slots.saopaulo = 6;
  const overview = screenFor(SP.renderOverview, s, me);
  assert.ok(/data-action="borrow"/.test(overview), '차입 버튼이 없다 — AI 는 Ai.finance 로 늘 쓴다');
  assert.ok(/data-action="repay"/.test(overview), '상환 버튼이 없다');
  assert.ok(/data-action="shed"/.test(overview), '슬롯 반납 버튼이 없다 — AI 는 shedIdleSlots 로 정리한다');

  // 기재가 둘 이상 붙은 노선에는 떼기가 있어야 한다.
  const r = St.routesOf(s, me).find((x) => x.active && St.assignedTo(s, x.id).length > 1);
  if (r) {
    const routes = screenFor(SP.renderRoutes, s, me);
    assert.ok(/data-action="detach"/.test(routes), '기재 떼기가 없다 — 노선을 접었다 여는 것 말고 방법이 없어진다');
  }
});

test('상태: 이번 분기 입고는 지난 분기 끝에 이미 정해져 있다', () => {
  // advance 안에서 정하면 AI 는 beforeMarket 에서 그걸 보고 예비기를 붙이는데,
  // 플레이어는 화면을 볼 때 멀쩡하던 기재로 계획을 세운 뒤라 그 분기를 손해 본다.
  const s = St.newGame(1234);
  let sawGrounded = false;
  for (let q = 0; q < 20; q++) {
    // 플레이어가 화면을 보는 시점 = advance 를 부르기 직전.
    const known = s.planes.filter((p) => p.checkUntilTurn === s.turn).map((p) => p.id).sort().join(',');
    let seenByAi = null;
    St.advance(s, {
      beforeMarket: (st) => {
        seenByAi = st.planes.filter((p) => p.checkUntilTurn === st.turn).map((p) => p.id).sort().join(',');
      },
    });
    assert.strictEqual(seenByAi, known, `분기 ${q}: AI 가 플레이어보다 늦게 알려진 입고를 봤다`);
    if (known) sawGrounded = true;
  }
  assert.ok(sawGrounded, '입고가 한 번도 없으면 검사가 헛돈다');
});

test('상태: 노선을 접어도 슬롯은 남고, 반납은 따로 한다', () => {
  // 접자마자 반납하면 다시 열 때 그 사이 오른 값을 치른다. 남기되, 노는 자리가
  // 얼마를 먹고 있는지는 화면이 말해 줘야 한다.
  const s = St.newGame(1234);
  const a = s.airlines[0];
  const r = St.routesOf(s, a.id)[0];
  const held = St.slotsAt(a, r.to);
  Act.closeRoute(s, a.id, r.id);
  assert.strictEqual(St.slotsAt(a, r.to), held, '접었다고 슬롯이 사라지면 안 된다');
  assert.strictEqual(Act.freeSlots(s, a.id, r.to), held, '전부 노는 자리가 돼야 한다');
  const html = SP.renderOverview(s, a.id, new Set());
  assert.ok(new RegExp(`data-action="shed" data-city="${r.to}"`).test(html), '반납할 자리가 화면에 없다');
  assert.strictEqual(Act.sellSlots(s, a.id, r.to, held).ok, true);
  assert.strictEqual(St.slotsAt(a, r.to), 0);
});

test('화면: 날짜변경선을 넘는 노선도 그린다', () => {
  // 안 그리면 개수에는 세면서 화면에는 없는 노선이 된다 — 태평양 노선망이 통째로
  // 안 보이는데 "전체 305개"라고 적히는 식이다.
  const s = playedWithAi(1234, 80);
  const me = s.airlines.find((a) => a.alive).id;
  const html = SP.renderMap(s, me, new Set());
  const drawn = (html.match(/<line /g) || []).length;
  const active = s.routes.filter((r) => r.active).length;
  const wrapped = s.routes.filter((r) => {
    if (!r.active) return false;
    const x1 = C.project(C.get(r.from).lat, C.get(r.from).lon).x;
    const x2 = C.project(C.get(r.to).lat, C.get(r.to).lon).x;
    return Math.abs(x1 - x2) > 0.5;
  }).length;
  assert.ok(wrapped > 0, '넘는 노선이 있어야 검사가 산다');
  // 넘는 노선은 지도 양끝에서 잘려 두 토막이 된다.
  assert.strictEqual(drawn, active + wrapped, `선 ${drawn}개, 노선 ${active}개(넘는 것 ${wrapped}개)`);

  // 좌표가 지도 밖으로 나가거나 NaN 이 되면 안 된다.
  for (const m of html.matchAll(/x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g)) {
    for (const v of m.slice(1)) {
      const n = Number(v);
      assert.ok(Number.isFinite(n) && n >= -1 && n <= 1001, `지도 밖 좌표 ${v}`);
    }
  }
});

// ── 최종 성적 ──

test('성적: 창업 규모가 큰 회사가 그것만으로 앞서지 않는다', () => {
  // 에미레이트는 대한항공의 두 배로 시작한다. 자기자본을 절대값으로 재면 등급이
  // 난이도표가 아니라 회사 선택표가 된다 — 제조사 쪽 `scoreMult` 가 막는 것과 같다.
  const s = St.newGame(1234);
  const big = St.airline(s, 'carta');
  const small = St.airline(s, 'hanul');
  assert.ok(big.startEquity > small.startEquity * 1.3, '창업 규모가 갈려야 검사가 산다');
  // 아무것도 안 하고 곧바로 끝내면 둘 다 성장 0 점이다.
  s.turn = s.totalTurns;
  assert.strictEqual(St.finalScore(s, big.id).rows[0].points, 0, '큰 회사가 가만히 있어도 점수를 받았다');
  assert.strictEqual(St.finalScore(s, small.id).rows[0].points, 0, '작은 회사도 마찬가지여야 한다');
});

test('성적: 창업 자본은 판을 열 때 새겨 둔다', () => {
  // 나중에 다시 세면 그동안의 성장이 기준에 섞여 배수가 늘 1 에 붙는다.
  const s = St.newGame(1234);
  const a = s.airlines[0];
  const at0 = a.startEquity;
  assert.ok(at0 > 0, '창업 자본이 새겨져야 한다');
  for (let i = 0; i < 40; i++) St.advance(s, { beforeMarket: (st, rng) => Ai.actAll(st, rng) });
  assert.strictEqual(a.startEquity, at0, '창업 자본이 움직였다');
});

test('성적: 파산은 아무리 실어 날랐어도 F 다', () => {
  const s = St.newGame(1234);
  const a = s.airlines[0];
  for (let i = 0; i < 12; i++) St.advance(s, { beforeMarket: (st, rng) => Ai.actAll(st, rng) });
  const before = St.finalScore(s, a.id);
  assert.ok(before.pax > 0, '승객을 실어 날랐어야 한다');
  // 자산보다 큰 빚을 지운다. 현금만 비우면 기재를 팔아 메우고 살아남는다 — 그게
  // 정상이다(자본잠식이 이어져야 접힌다). 여기서 보려는 건 접힌 뒤의 성적이다.
  a.debt = 20e9;
  for (let i = 0; i <= St.BALANCE.NEGATIVE_QUARTERS_TO_FOLD; i++) {
    St.advance(s, { beforeMarket: (st, rng) => Ai.actAll(st, rng, { playerId: a.id }) });
    if (!a.alive) break;
  }
  assert.ok(!a.alive, '자본잠식이 이어졌는데 안 접혔다');
  const f = St.finalScore(s, a.id);
  assert.strictEqual(f.grade, 'F', '파산인데 F 가 아니다');
  assert.strictEqual(f.score, 0, '파산에 점수가 남으면 안 된다');
});

test('성적: 자동조종 분포가 B 를 한가운데 둔다', () => {
  // 자동조종은 경쟁사를 굴리는 그 AI 다. 중앙값이 B 라는 것은 "기계만큼 하면 B,
  // 더 잘해야 A" 라는 뜻이다. 배점을 건드리면 이 성질이 먼저 깨진다.
  const counts = { S: 0, A: 0, B: 0, C: 0, D: 0, F: 0 };
  const scores = [];
  for (const seed of [1234, 777, 20260822]) {
    const s = playedWithAi(seed, 80);
    for (const a of s.airlines) {
      const f = St.finalScore(s, a.id);
      counts[f.grade]++;
      scores.push(f.score);
    }
  }
  scores.sort((x, y) => x - y);
  const median = scores[Math.floor(scores.length / 2)];
  assert.ok(median >= 3000 && median < 4600, `중앙값이 B 밴드여야 한다 (${median})`);
  assert.ok(counts.S + counts.A < scores.length / 2, `절반 넘게 A 이상이면 등급이 헐겁다 (${counts.S}+${counts.A}/${scores.length})`);
  assert.ok(counts.B > 0 && counts.C > 0, '중간 등급이 실제로 나와야 한다');
});

test('화면: 판이 끝나면 성적표가 뜬다', () => {
  const s = playedWithAi(1234, 80);
  const me = s.airlines.find((a) => a.alive).id;
  const html = SP.renderOverview(s, me, new Set());
  assert.ok(/sky-final/.test(html), '성적표가 없다');
  assert.ok(/자본 성장|누적 승객|노선망/.test(html), '항목별 점수가 없다 — 등급만 던지면 무엇을 잘했는지 안 남는다');

  // 진행 중에는 뜨지 않는다.
  const mid = playedWithAi(1234, 8);
  assert.ok(!/sky-final/.test(SP.renderOverview(mid, me, new Set())), '아직 안 끝났는데 성적표가 떴다');
});
