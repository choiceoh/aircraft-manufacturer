/*
 * 차트 — 상태 배열을 SVG 문자열로 바꾸는 순수 함수 모음.
 *
 * DOM도 라이브러리도 쓰지 않는다. 패널 렌더러가 다른 카드와 똑같이 문자열로 이어
 * 붙일 수 있어야 하고, Node 테스트에서 브라우저 없이 검증할 수 있어야 하기 때문이다.
 *
 * 좌표계는 viewBox 고정(600×H)이다. 세로만 H 픽셀로 못 박고 가로는 컨테이너를 채우게
 * 늘린다(preserveAspectRatio="none") — 비율을 유지하면 폭이 좁은 화면에서 차트 높이가
 * 같이 짜부라져 곡선도 축 라벨도 읽을 수 없게 된다. 시계열은 가로로 늘어나도 읽히지만
 * 세로로 눌리면 못 읽는다. 대신 선 굵기는 non-scaling-stroke 로 고정한다.
 *
 * 축 라벨은 SVG 밖 HTML 로 빼서, 차트가 좁아져도 글자 크기는 유지한다.
 */
(function (root) {
  'use strict';

  const W = 600;
  // 축 라벨은 SVG 밖 HTML 로 뺀다. viewBox 안에 두면 컨테이너 폭에 비례해 글자가
  // 같이 줄어들어, 2단 그리드에 들어간 차트에서는 읽을 수 없을 만큼 작아진다.
  const PAD = { l: 2, r: 2, t: 6, b: 6 };

  function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /**
   * 값 범위 → 그리기 좌표 변환기.
   * 값이 전부 같으면(개발 중이라 손익이 0으로 평평한 구간 등) 범위가 0이 되어
   * 0으로 나누게 되므로, 그때는 임의 폭을 줘서 선이 중앙에 오게 한다.
   */
  function scaler(values, height, opts) {
    const nums = values.filter(isNum);
    let min = nums.length ? Math.min(...nums) : 0;
    let max = nums.length ? Math.max(...nums) : 1;
    if (opts && opts.zero) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    if (max - min < 1e-9) {
      const pad = Math.max(1, Math.abs(max) * 0.1);
      min -= pad;
      max += pad;
    } else {
      const pad = (max - min) * 0.08;
      min -= pad;
      max += pad;
    }
    const top = PAD.t;
    const bottom = height - PAD.b;
    return {
      min,
      max,
      y: (v) => bottom - ((v - min) / (max - min)) * (bottom - top),
    };
  }

  function xAt(i, n) {
    if (n <= 1) return PAD.l;
    return PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  }

  /**
   * 꺾은선 차트.
   * @param {object} o
   *   series: [{name, values:[number|null], cls, fill}]  cls 는 CSS 색 클래스
   *   labels: 각 점의 x 라벨 (양 끝만 표시한다)
   *   height: viewBox 높이
   *   format: y축 라벨 포매터
   *   zero:   0을 반드시 범위에 포함할지
   */
  function line(o) {
    const series = (o.series || []).filter((s) => s.values && s.values.length);
    if (!series.length) return empty(o.emptyText);
    const height = o.height || 170;
    const n = Math.max(...series.map((s) => s.values.length));
    const all = series.flatMap((s) => s.values);
    const sc = scaler(all, height, { zero: o.zero });
    const fmt = o.format || ((v) => Math.round(v));

    const grid = [sc.max, (sc.max + sc.min) / 2, sc.min]
      .map(
        (v) =>
          `<line class="c-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sc.y(v).toFixed(1)}" y2="${sc.y(v).toFixed(1)}" vector-effect="non-scaling-stroke"/>`,
      )
      .join('');

    // 0선은 손익 차트에서 흑자/적자의 경계라 따로 강조한다.
    const zeroLine =
      o.zero && sc.min < 0 && sc.max > 0
        ? `<line class="c-zero" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sc.y(0).toFixed(1)}" y2="${sc.y(0).toFixed(1)}" vector-effect="non-scaling-stroke"/>`
        : '';

    const paths = series
      .map((s) => {
        const pts = [];
        for (let i = 0; i < s.values.length; i++) {
          if (!isNum(s.values[i])) continue;
          pts.push(`${xAt(i, n).toFixed(1)},${sc.y(s.values[i]).toFixed(1)}`);
        }
        if (!pts.length) return '';
        const area = s.fill
          ? `<polygon class="c-area ${s.cls || ''}" points="${PAD.l},${height - PAD.b} ${pts.join(' ')} ${xAt(s.values.length - 1, n).toFixed(1)},${height - PAD.b}"/>`
          : '';
        const last = pts[pts.length - 1].split(',');
        // 끝점 표시는 세로 눈금으로 그린다. 원을 쓰면 가로로 늘어난 좌표계에서 타원이 된다.
        return (
          area +
          `<polyline class="c-line ${s.cls || ''}" points="${pts.join(' ')}" vector-effect="non-scaling-stroke"/>` +
          `<line class="c-dot ${s.cls || ''}" x1="${last[0]}" x2="${last[0]}" y1="${(Number(last[1]) - 3.5).toFixed(1)}" y2="${(Number(last[1]) + 3.5).toFixed(1)}" vector-effect="non-scaling-stroke"/>`
        );
      })
      .join('');

    return box({
      title: o.title || '추이 그래프',
      height,
      yLabels: [fmt(sc.max), fmt((sc.max + sc.min) / 2), fmt(sc.min)],
      xLabels: o.labels || [],
      inner: grid + zeroLine + paths,
    });
  }

  /**
   * 차트 한 벌 — 왼쪽 y 라벨, 그림, 아래 x 라벨.
   * 라벨이 HTML 이라 컨테이너가 좁아져도 글자 크기는 그대로다.
   */
  function box(o) {
    const y = o.yLabels.map((t) => `<span>${esc(t)}</span>`).join('');
    const xs = o.xLabels;
    const x =
      xs.length > 1 ? `<span>${esc(xs[0])}</span><span>${esc(xs[xs.length - 1])}</span>` : '';
    return (
      `<div class="chartbox">` +
      `<div class="c-y">${y}</div>` +
      `<svg class="chart" viewBox="0 0 ${W} ${o.height}" preserveAspectRatio="none" style="height:${o.height}px" role="img" aria-label="${esc(o.title)}">${o.inner}</svg>` +
      `<div class="c-x">${x}</div>` +
      '</div>'
    );
  }

  /** 막대 차트 — 분기 손익처럼 부호가 갈리는 값에 쓴다. */
  function bars(o) {
    const values = o.values || [];
    if (!values.length) return empty(o.emptyText);
    const height = o.height || 150;
    const sc = scaler(values, height, { zero: true });
    const fmt = o.format || ((v) => Math.round(v));
    const n = values.length;
    const slot = (W - PAD.l - PAD.r) / n;
    const bw = Math.max(1.5, Math.min(14, slot * 0.7));
    const y0 = sc.y(0);

    const rects = values
      .map((v, i) => {
        if (!isNum(v)) return '';
        const x = PAD.l + slot * i + (slot - bw) / 2;
        const y = sc.y(v);
        const top = Math.min(y, y0);
        const h = Math.max(1, Math.abs(y - y0));
        return `<rect class="c-bar ${v >= 0 ? 'up' : 'down'}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"><title>${esc((o.labels && o.labels[i]) || '')} ${esc(fmt(v))}</title></rect>`;
      })
      .join('');

    const grid =
      `<line class="c-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${sc.y(sc.max).toFixed(1)}" y2="${sc.y(sc.max).toFixed(1)}" vector-effect="non-scaling-stroke"/>` +
      `<line class="c-zero" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" vector-effect="non-scaling-stroke"/>`;

    return box({
      title: o.title || '분기별 막대 그래프',
      height,
      yLabels: [fmt(sc.max), fmt(sc.min)],
      xLabels: o.labels || [],
      inner: grid + rects,
    });
  }

  /** 통계 카드에 들어가는 초소형 꺾은선 — 축도 라벨도 없다. */
  function spark(values, cls) {
    const nums = (values || []).filter(isNum);
    if (nums.length < 2) return '';
    const h = 26;
    const w = 90;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const span = max - min < 1e-9 ? 1 : max - min;
    const pts = nums
      .map((v, i) => `${((i / (nums.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`)
      .join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline class="c-line ${cls || ''}" points="${pts}" vector-effect="non-scaling-stroke"/></svg>`;
  }

  /** 점유율처럼 합이 100%인 값 — 가로 막대 목록. HTML 이라 라벨 정렬이 편하다. */
  function shareBars(rows) {
    if (!rows || !rows.length) return '';
    const max = Math.max(...rows.map((r) => r.value)) || 1;
    return `<ul class="sharebars">${rows
      .map(
        (r) => `<li class="${r.highlight ? 'me' : ''}">
          <span class="sb-name">${esc(r.name)}</span>
          <span class="sb-track"><span class="sb-fill" style="width:${((r.value / max) * 100).toFixed(1)}%"></span></span>
          <span class="sb-value">${esc(r.text)}</span>
        </li>`,
      )
      .join('')}</ul>`;
  }

  function empty(text) {
    return `<p class="muted chart-empty">${esc(text || '아직 그릴 기록이 없다.')}</p>`;
  }

  root.AirlinerCharts = { line, bars, spark, shareBars };
})(typeof globalThis !== 'undefined' ? globalThis : this);
