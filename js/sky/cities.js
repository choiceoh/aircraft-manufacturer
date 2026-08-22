/*
 * 세계 지도 — 45개 도시와 그 사이의 거리.
 *
 * sky-tycoon(choiceoh/sky-tycoon)의 `core/data/Cities.kt` 와 `core/sim/Geo.kt` 를 옮겨 왔다.
 * 저쪽은 항공사를 굴리는 게임이고 이쪽은 그 항공사에 기체를 파는 게임이라, 같은 세계를
 * 두 번 만들 이유가 없다. 값은 손대지 않았다 — 저쪽 밸런스가 이 숫자들 위에서 잡혀 있어서,
 * 여기서 조정하면 두 게임이 조용히 다른 세계가 된다.
 *
 * 이 파일은 **순수 데이터와 순수 함수**다. 상태도 난수도 보지 않으므로 결정론에 영향이 없다.
 *
 * standing : 경제·정치 비중 (출장 수요의 근원). 수도는 정부·외교·국영기업 통행이 붙어
 *            경제 규모만으로 매기지 않는다 — 그래서 모스크바가 상파울루보다 위다.
 * tour     : 관광 매력 (레저 수요의 근원)
 * slots    : 주간 슬롯 총량. 모든 항공사가 나눠 갖는다
 * fee      : 착륙료 배수
 * growth   : 연간 도시 성장률
 */
(function (root) {
  'use strict';

  /** 권역 — 같은 권역끼리는 수요가 조금 더 붙고, 홈 프리미엄이 절반 인정된다. */
  const REGIONS = { AS: '아시아', ME: '중동', EU: '유럽', NA: '북미', SA: '남미', AF: '아프리카', OC: '오세아니아' };

  const CITIES = [
    // ── 아시아 ──
    { id: 'seoul', name: '서울', code: 'SEL', lat: 37.55, lon: 126.97, region: 'AS', standing: 62, tour: 55, slots: 62, fee: 1.0, growth: 1.062 },
    { id: 'tokyo', name: '도쿄', code: 'TYO', lat: 35.68, lon: 139.69, region: 'AS', standing: 95, tour: 70, slots: 92, fee: 1.6, growth: 1.032 },
    { id: 'osaka', name: '오사카', code: 'OSA', lat: 34.69, lon: 135.5, region: 'AS', standing: 60, tour: 52, slots: 54, fee: 1.4, growth: 1.03 },
    // 수도라 상하이보다 위여야 한다 — 경제 규모만 재면 뒤집힌다.
    { id: 'beijing', name: '베이징', code: 'PEK', lat: 39.9, lon: 116.41, region: 'AS', standing: 64, tour: 66, slots: 58, fee: 0.8, growth: 1.081 },
    { id: 'shanghai', name: '상하이', code: 'SHA', lat: 31.23, lon: 121.47, region: 'AS', standing: 54, tour: 54, slots: 60, fee: 0.8, growth: 1.085 },
    { id: 'hongkong', name: '홍콩', code: 'HKG', lat: 22.32, lon: 114.17, region: 'AS', standing: 70, tour: 72, slots: 56, fee: 1.3, growth: 1.045 },
    { id: 'taipei', name: '타이베이', code: 'TPE', lat: 25.03, lon: 121.57, region: 'AS', standing: 45, tour: 44, slots: 44, fee: 1.0, growth: 1.05 },
    { id: 'bangkok', name: '방콕', code: 'BKK', lat: 13.75, lon: 100.5, region: 'AS', standing: 42, tour: 86, slots: 56, fee: 0.75, growth: 1.06 },
    { id: 'singapore', name: '싱가포르', code: 'SIN', lat: 1.35, lon: 103.82, region: 'AS', standing: 60, tour: 66, slots: 60, fee: 1.1, growth: 1.055 },
    { id: 'delhi', name: '델리', code: 'DEL', lat: 28.61, lon: 77.21, region: 'AS', standing: 52, tour: 60, slots: 50, fee: 0.7, growth: 1.072 },
    { id: 'manila', name: '마닐라', code: 'MNL', lat: 14.6, lon: 120.98, region: 'AS', standing: 30, tour: 46, slots: 40, fee: 0.7, growth: 1.05 },
    { id: 'jakarta', name: '자카르타', code: 'CGK', lat: -6.21, lon: 106.85, region: 'AS', standing: 33, tour: 44, slots: 42, fee: 0.7, growth: 1.065 },
    // 우랄 동쪽은 지리대로 아시아에 둔다 — 모스크바와 권역이 갈리지만 홈 프리미엄은
    // 끝점 기준이라 국내선 경쟁력에는 영향이 없다.
    { id: 'novosibirsk', name: '노보시비르스크', code: 'OVB', lat: 55.01, lon: 82.94, region: 'AS', standing: 22, tour: 14, slots: 34, fee: 0.6, growth: 1.03 },
    { id: 'tashkent', name: '타슈켄트', code: 'TAS', lat: 41.31, lon: 69.24, region: 'AS', standing: 20, tour: 26, slots: 32, fee: 0.6, growth: 1.045 },

    // ── 중동 ──
    { id: 'dubai', name: '두바이', code: 'DXB', lat: 25.2, lon: 55.27, region: 'ME', standing: 38, tour: 58, slots: 70, fee: 0.65, growth: 1.09 },
    { id: 'telaviv', name: '텔아비브', code: 'TLV', lat: 32.09, lon: 34.78, region: 'ME', standing: 32, tour: 55, slots: 34, fee: 1.1, growth: 1.045 },

    // ── 유럽 ──
    { id: 'london', name: '런던', code: 'LON', lat: 51.51, lon: -0.13, region: 'EU', standing: 92, tour: 90, slots: 88, fee: 1.75, growth: 1.028 },
    { id: 'paris', name: '파리', code: 'PAR', lat: 48.86, lon: 2.35, region: 'EU', standing: 84, tour: 95, slots: 76, fee: 1.5, growth: 1.028 },
    { id: 'frankfurt', name: '프랑크푸르트', code: 'FRA', lat: 50.11, lon: 8.68, region: 'EU', standing: 80, tour: 48, slots: 76, fee: 1.4, growth: 1.03 },
    { id: 'amsterdam', name: '암스테르담', code: 'AMS', lat: 52.31, lon: 4.77, region: 'EU', standing: 60, tour: 66, slots: 66, fee: 1.3, growth: 1.03 },
    { id: 'rome', name: '로마', code: 'ROM', lat: 41.9, lon: 12.5, region: 'EU', standing: 54, tour: 88, slots: 54, fee: 1.2, growth: 1.026 },
    { id: 'madrid', name: '마드리드', code: 'MAD', lat: 40.42, lon: -3.7, region: 'EU', standing: 50, tour: 72, slots: 56, fee: 1.1, growth: 1.035 },
    { id: 'zurich', name: '취리히', code: 'ZRH', lat: 47.38, lon: 8.54, region: 'EU', standing: 55, tour: 56, slots: 40, fee: 1.55, growth: 1.028 },
    // 제2세계의 정치 수도. 소비 시장은 서방보다 작았지만 국가·군수·행정 통행량이 막대했고,
    // 공항도 셰레메티예보·도모데도보·브누코보로 나뉜 다공항 체제였다.
    { id: 'moscow', name: '모스크바', code: 'MOW', lat: 55.76, lon: 37.62, region: 'EU', standing: 62, tour: 52, slots: 64, fee: 0.9, growth: 1.035 },
    { id: 'istanbul', name: '이스탄불', code: 'IST', lat: 41.01, lon: 28.98, region: 'EU', standing: 38, tour: 70, slots: 52, fee: 0.8, growth: 1.072 },
    { id: 'stockholm', name: '스톡홀름', code: 'ARN', lat: 59.33, lon: 18.07, region: 'EU', standing: 40, tour: 48, slots: 36, fee: 1.3, growth: 1.03 },
    // 소련 국내선. 모스크바 하나만 두면 그 거대한 국내 수요가 지도에서 통째로 사라진다.
    { id: 'stpetersburg', name: '상트페테르부르크', code: 'LED', lat: 59.94, lon: 30.31, region: 'EU', standing: 30, tour: 54, slots: 40, fee: 0.75, growth: 1.032 },

    // ── 북미 ──
    { id: 'newyork', name: '뉴욕', code: 'NYC', lat: 40.71, lon: -74.01, region: 'NA', standing: 100, tour: 88, slots: 96, fee: 1.8, growth: 1.028 },
    { id: 'chicago', name: '시카고', code: 'CHI', lat: 41.88, lon: -87.63, region: 'NA', standing: 74, tour: 54, slots: 86, fee: 1.3, growth: 1.025 },
    { id: 'losangeles', name: '로스앤젤레스', code: 'LAX', lat: 34.05, lon: -118.24, region: 'NA', standing: 82, tour: 80, slots: 82, fee: 1.4, growth: 1.035 },
    { id: 'sanfrancisco', name: '샌프란시스코', code: 'SFO', lat: 37.77, lon: -122.42, region: 'NA', standing: 64, tour: 70, slots: 60, fee: 1.4, growth: 1.038 },
    { id: 'dallas', name: '댈러스', code: 'DFW', lat: 32.78, lon: -96.8, region: 'NA', standing: 55, tour: 34, slots: 72, fee: 1.0, growth: 1.04 },
    { id: 'miami', name: '마이애미', code: 'MIA', lat: 25.76, lon: -80.19, region: 'NA', standing: 48, tour: 78, slots: 60, fee: 1.2, growth: 1.04 },
    { id: 'toronto', name: '토론토', code: 'YYZ', lat: 43.65, lon: -79.38, region: 'NA', standing: 52, tour: 50, slots: 56, fee: 1.2, growth: 1.03 },
    { id: 'mexicocity', name: '멕시코시티', code: 'MEX', lat: 19.43, lon: -99.13, region: 'NA', standing: 40, tour: 60, slots: 50, fee: 0.8, growth: 1.055 },
    { id: 'honolulu', name: '호놀룰루', code: 'HNL', lat: 21.31, lon: -157.86, region: 'NA', standing: 24, tour: 92, slots: 46, fee: 1.0, growth: 1.035 },

    // ── 남미 ──
    { id: 'saopaulo', name: '상파울루', code: 'GRU', lat: -23.55, lon: -46.63, region: 'SA', standing: 45, tour: 44, slots: 52, fee: 0.9, growth: 1.05 },
    { id: 'buenosaires', name: '부에노스아이레스', code: 'EZE', lat: -34.6, lon: -58.38, region: 'SA', standing: 34, tour: 52, slots: 44, fee: 0.85, growth: 1.04 },
    { id: 'lima', name: '리마', code: 'LIM', lat: -12.05, lon: -77.04, region: 'SA', standing: 22, tour: 48, slots: 34, fee: 0.7, growth: 1.05 },

    // ── 아프리카 ──
    { id: 'cairo', name: '카이로', code: 'CAI', lat: 30.04, lon: 31.24, region: 'AF', standing: 28, tour: 76, slots: 46, fee: 0.65, growth: 1.05 },
    { id: 'johannesburg', name: '요하네스버그', code: 'JNB', lat: -26.2, lon: 28.05, region: 'AF', standing: 32, tour: 46, slots: 44, fee: 0.8, growth: 1.045 },
    { id: 'nairobi', name: '나이로비', code: 'NBO', lat: -1.29, lon: 36.82, region: 'AF', standing: 17, tour: 62, slots: 30, fee: 0.6, growth: 1.06 },
    { id: 'lagos', name: '라고스', code: 'LOS', lat: 6.52, lon: 3.38, region: 'AF', standing: 22, tour: 24, slots: 34, fee: 0.7, growth: 1.06 },

    // ── 오세아니아 ──
    { id: 'sydney', name: '시드니', code: 'SYD', lat: -33.87, lon: 151.21, region: 'OC', standing: 55, tour: 80, slots: 56, fee: 1.25, growth: 1.035 },
    { id: 'auckland', name: '오클랜드', code: 'AKL', lat: -36.85, lon: 174.76, region: 'OC', standing: 25, tour: 62, slots: 34, fee: 1.1, growth: 1.035 },
  ];

  const BY_ID = Object.fromEntries(CITIES.map((c) => [c.id, c]));

  const EARTH_R = 6371;
  const rad = (d) => (d * Math.PI) / 180;

  /** 대권거리 (km) */
  function greatCircle(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const s =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** 도시쌍의 정렬된 열쇠 — 어느 순서로 물어도 같은 값이 나와야 캐시가 맞는다. */
  function pairKey(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  // 도시쌍이 990개(45×44/2)뿐이라 한 번 잰 거리는 판이 끝날 때까지 유효하다.
  const distCache = new Map();

  /** 도시 id 두 개 사이의 거리 (km) */
  function distance(a, b) {
    const key = pairKey(a, b);
    let d = distCache.get(key);
    if (d === undefined) {
      d = greatCircle(BY_ID[a], BY_ID[b]);
      distCache.set(key, d);
    }
    return d;
  }

  /**
   * 도시 **객체** 두 개 사이의 거리.
   *
   * 카탈로그에 있는 도시면 캐시를 타고, 아니면 그 자리에서 잰다. 수요 모델을
   * 합성 도시로 시험할 수 있어야 거리에 따른 성질(철도 억제 등)을 실제 도시쌍의
   * 규모 차이에 가리지 않고 볼 수 있다.
   */
  function between(a, b) {
    if (BY_ID[a.id] && BY_ID[b.id]) return distance(a.id, b.id);
    return greatCircle(a, b);
  }

  /** 등장방형 투영 — 0~1 로 정규화된 지도 좌표 */
  function project(lat, lon) {
    return { x: (lon + 180) / 360, y: (90 - lat) / 180 };
  }

  function get(id) {
    return BY_ID[id] || null;
  }

  function name(id) {
    return (BY_ID[id] || {}).name || id;
  }

  function inRegion(region) {
    return CITIES.filter((c) => c.region === region);
  }

  /** 모든 도시쌍 — 순서가 고정이라 반복해도 같은 목록이다. */
  function pairs() {
    const out = [];
    for (let i = 0; i < CITIES.length; i++) {
      for (let j = i + 1; j < CITIES.length; j++) out.push([CITIES[i], CITIES[j]]);
    }
    return out;
  }

  root.AirlinerCities = { REGIONS, CITIES, get, name, inRegion, pairs, distance, between, greatCircle, pairKey, project };
})(typeof globalThis !== 'undefined' ? globalThis : this);
