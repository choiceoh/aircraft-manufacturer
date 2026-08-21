/*
 * 탭별 화면 렌더러 — 상태를 받아 HTML 문자열을 돌려주는 순수 함수 모음.
 * DOM 이벤트 배선은 ui.js가 위임 방식으로 처리한다(재렌더에도 핸들러가 살아있도록).
 */
(function (root) {
  'use strict';

  const { SEGMENTS, SEGMENT_ORDER, FUSELAGE_MATERIALS, WING_MATERIALS, LEGACY_MATERIAL_MAP, CONFIG, ETOPS_RANGE_KM, ETOPS_USEFUL_RANGE, AIRLINES, UPGAUGE_PER_YEAR, LINE_GRADES, OUTSOURCING, RETOOL_COST_RATE, BID_PLEDGES, BID_FINANCING, AFTERMARKET_TIERS, FREIGHTER } = root.AirlinerData;
  const E = root.AirlinerEngine;
  const Engines = root.AirlinerEngines;
  const Airframe = root.AirlinerAirframe;
  const D = root.AirlinerDesign;
  const B = root.AirlinerBidding;
  const C = root.AirlinerCharts;
  const Fleet = root.AirlinerFleet;

  const money = E.fmtMoney;
  const num = (n) => Math.round(n).toLocaleString('ko-KR');
  const esc = (t) =>
    String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /**
   * 카탈로그가 심은 <b> 강조만 살리고 나머지는 전부 이스케이프한다.
   * 결정 사건 본문에는 플레이어가 지은 프로그램 이름이 그대로 끼어들기 때문에,
   * 통째로 innerHTML 에 넣으면 그 이름이 태그로 해석된다. 이스케이프를 먼저 하고
   * 허용 태그만 되돌리는 순서라야, 이미 저장된 세이브의 이름도 여기서 무력화된다.
   */
  const richText = (t) => esc(t).replace(/&lt;(\/?b)&gt;/g, '<$1>');

  function bar(pct, cls) {
    const v = Math.max(0, Math.min(100, pct));
    return `<div class="bar"><span class="${cls || ''}" style="width:${v}%"></span></div>`;
  }

  /**
   * 접이 섹션 — 열려 있는지는 ui.folds 가 기억한다.
   *
   * folds 는 "기본값과 다른 것"만 담는 토글 집합이다. 그래야 기본 펼침 섹션(접어 둔 것을
   * 기억해야 한다)과 기본 접힘 섹션(펼쳐 둔 것을 기억해야 한다)이 집합 하나로 굴러간다.
   */
  function foldOpen(folds, id, defaultOpen) {
    const toggled = !!(folds && folds.has(id));
    return defaultOpen ? !toggled : toggled;
  }

  /**
   * 카드 한 장을 통째로 접는다 — 제목 줄이 그대로 여닫이가 된다.
   * 접어도 **지금 고른 값은 제목 옆에 남긴다**. 접힌 섹션이 무엇을 감추고 있는지
   * 모르면 열어 보는 것 말고는 확인할 방법이 없고, 그러면 접은 의미가 없다.
   */
  function foldCard(folds, id, title, value, body, defaultOpen) {
    return `<section class="card fold-card">
        <details class="fold"${foldOpen(folds, id, defaultOpen) ? ' open' : ''}>
          <summary data-fold="${id}"><b>${title}</b>${value ? `<span class="fold-val">${value}</span>` : ''}</summary>
          <div class="fold-body">${body}</div>
        </details>
      </section>`;
  }

  function phaseLabel(p) {
    return { dev: '개발 중', cert: '형식증명 심사', production: '양산', cancelled: '중단', sold: '매각' }[p.phase] || p.phase;
  }

  /** 기종별 미인도 주문 잔량 */
  function orderedBy(s, programId) {
    return s.backlog.reduce((a, o) => a + (o.programId === programId ? o.remaining : 0), 0);
  }

  // ─────────────────────────────── 개요 ───────────────────────────────

  /** 그 항공사가 굴리는 우리 기체 요약 — 선단 공통성 가산의 근거를 보여준다. */
  function fleetSummary(s, airlineId) {
    const f = (s.fleets && s.fleets[airlineId]) || {};
    const parts = Object.entries(f)
      .filter(([, n]) => n > 0)
      .map(([pid, n]) => {
        const p = s.programs.find((x) => x.id === pid);
        return `${esc(p ? p.name : '기존 기종')} ${n}기`;
      });
    return parts.length ? parts.join(' · ') : '<span class="muted">없음 (신규 계정)</span>';
  }

  /** 항공사별 수요 프로필 — 설계를 어디에 맞출지 정하는 근거다. */
  function airlineDemandTable(s) {
    // 표시 대역에도 업게이지를 반영한다. 1998년 값을 그대로 두면 후반에
    // 이 표를 보고 설계한 기체가 실제 발주와 한 급 어긋난다.
    const up = 1 + (s.turn / 4) * UPGAUGE_PER_YEAR;
    const rows = AIRLINES.map((a) => {
      const seg = SEGMENTS[a.bias];
      const lo = Math.round(Math.min(seg.seats.max, Math.max(seg.seats.min, a.seatBand[0] * up)));
      const hi = Math.round(Math.min(seg.seats.max, Math.max(seg.seats.min, a.seatBand[1] * up)));
      const rel = Math.round(s.relations[a.id] ?? 40);
      const ours = Object.values((s.fleets && s.fleets[a.id]) || {}).reduce((x, y) => x + y, 0);
      const constraint =
        a.field === 'short' ? '짧은 활주로' : a.field === 'hot' ? '고온고지' : a.rangeBand[1] >= ETOPS_RANGE_KM ? 'ETOPS' : '—';
      // 사풍의 지리를 표에 얹는다. 본국 고객과 "벽이 선 시장"이 어디인지는 매 분기
      // 입찰 점수에 들어가는 값이라, 화면 어딘가에 한 번은 적혀 있어야 한다.
      const trait = s.trait || {};
      const homeTag = (trait.home || []).includes(a.id) ? ' <span class="good">본국</span>' : '';
      const wallTag =
        !homeTag && trait.foreignBid && (trait.foreignBid.regions || []).includes(a.home)
          ? ' <span class="bad">낯선 시장</span>'
          : '';
      return `<tr>
          <td>${esc(a.name)}${homeTag}${wallTag}</td>
          <td>${SEGMENTS[a.bias].name}</td>
          <td>${lo}~${hi}석</td>
          <td>${num(a.rangeBand[0])}~${num(a.rangeBand[1])}km</td>
          <td>${constraint}</td>
          <td>${rel}</td>
          <td>${ours ? num(ours) + '기' : '<span class="muted">—</span>'}</td>
        </tr>`;
    }).join('');
    return `<table class="hist">
        <tr><th>항공사</th><th>주력</th><th>좌석대 <span class="muted">(현재)</span></th><th>항속대</th><th>제약</th><th>관계</th><th>보유</th></tr>
        ${rows}
      </table>`;
  }

  /** 시나리오 목표 카드 — 오르는 산이 어디까지 왔나. 자유 경영이면 아무것도 없다. */
  function scenarioCard(s) {
    const st = E.scenarioStatus(s);
    if (!st) return '';
    const pct = Math.max(0, Math.min(100, Math.round((st.progress / st.target) * 100)));
    // 종료된 판은 확정된 판정을 보여준다 — 목표를 채운 분기에 파산했다면
    // 진행 중 표식(달성)과 최종 판정(실패)이 어긋날 수 있다. 확정이 이긴다.
    const finalVerdict = s.gameOver && s.gameOver.scenario;
    const state = finalVerdict
      ? finalVerdict.achieved
        ? '<span class="tag good">🏆 목표 달성</span>'
        : '<span class="tag" style="color:var(--bad)">목표 실패</span>'
      : st.failed
        ? '<span class="tag" style="color:var(--bad)">실패 확정</span>'
        : s.scenarioAchievedTurn !== undefined
          ? '<span class="tag good">목표 달성 — 파산만 피하면 된다</span>'
          : st.finalOnly
            ? '<span class="muted">판정은 종료 시점에</span>'
            : '';
    return `
      <section class="card">
        <h3>시나리오 — ${esc(st.name)}</h3>
        <p class="muted">${esc(st.goalText)} ${state}</p>
        <div class="row between"><b>${num(st.progress)} / ${num(st.target)}${esc(st.unit || '')}</b><span class="muted">${pct}%</span></div>
        ${bar(pct, 'accent')}
      </section>`;
  }

  /**
   * 지금 손봐야 할 일 — 탭 배지와 하단 액션 바가 이 목록 하나를 같이 쓴다.
   *
   * 개요의 "경영 경고"와 내용이 겹치지만 이쪽에는 **어느 탭으로 가야 하는지**가 붙어 있다.
   * 좁은 화면에서는 경고를 읽으러 개요까지 스크롤하는 것 자체가 비용이라, 화면 어디에
   * 있든 남은 일의 개수가 보이고 눌러서 그 탭으로 바로 건너뛸 수 있어야 한다.
   */
  function todoList(s) {
    if (!s || s.gameOver) return [];
    const out = [];
    if (s.decision) out.push({ tab: 'overview', text: `"${s.decision.name}" 결정에 답하지 않았다` });

    // 응찰 가능한 공고만 센다 — 엔진의 무응찰 감점과 같은 기준이다. 초반처럼 고를 기종이
    // 없는 공고까지 세면 매 분기 손댈 수 없는 할 일이 배지에 남는다.
    const unbid = (s.rfps || []).filter((r) => !s.bids[r.id] && E.canBid(s, r)).length;
    if (unbid) out.push({ tab: 'rfps', text: `응찰할 수 있는 공고 ${unbid}건이 비어 있다` });

    for (const p of s.programs.filter((x) => x.phase === 'production')) {
      if (orderedBy(s, p.id) > 0 && !s.lines.some((l) => l.programId === p.id)) {
        out.push({ tab: 'production', text: `${p.name} 수주 잔고가 있는데 조립 라인이 없다` });
      }
    }
    for (const p of s.programs.filter((x) => x.phase === 'dev' && x.share <= 0)) {
      out.push({ tab: 'programs', text: `${p.name} 개발이 동결됐다 — 인력을 배분하라` });
    }
    const idle = s.lines.filter((l) => l.idle).length;
    if (idle) out.push({ tab: 'production', text: `가동 중지된 라인이 ${idle}개 — 유지비는 계속 나간다` });

    const runway = E.cashRunway(s);
    if (runway !== null && runway <= 4) {
      out.push({
        tab: 'finance',
        text: runway <= 0 ? '이번 분기 지출을 감당할 현금이 없다' : `${runway}분기 뒤 현금이 마른다`,
      });
    }
    if (s.debt >= CONFIG.maxDebt * 0.9) out.push({ tab: 'finance', text: '차입이 한도에 근접했다' });
    return out;
  }

  /**
   * 회사 특성(사풍) — 이 회사가 남들과 다르게 적용받는 규칙들.
   *
   * 값이 화면에 없으면 없는 규칙이나 마찬가지다: 개발비가 왜 싼지, 왜 저 항공사에서만
   * 점수가 잘 나오는지 플레이어가 설명할 수 없으면 그건 특색이 아니라 잡음이다.
   * 그래서 프리셋의 배수를 그대로 문장으로 풀어 쓴다 — 숫자가 바뀌면 문장도 바뀐다.
   */
  function houseCard(s, folds) {
    const t = s.trait || {};
    if (!t.name) return '';

    const pct = (m) => `${m > 1 ? '+' : '−'}${Math.round(Math.abs(m - 1) * 100)}%`;
    const items = [];

    for (const [segId, f] of Object.entries(t.focus || {})) {
      const bits = [];
      if (f.cost !== undefined && f.cost !== 1) bits.push(`개발비 ${pct(f.cost)}`);
      if (f.time !== undefined && f.time !== 1) bits.push(`기간 ${pct(f.time)}`);
      if (bits.length) {
        items.push({
          good: (f.cost ?? 1) < 1,
          label: `${SEGMENTS[segId].name} 설계`,
          text: bits.join(' · '),
        });
      }
    }
    if (t.deriv) {
      const bits = [];
      if (t.deriv.cost !== undefined && t.deriv.cost !== 1) bits.push(`개발비 ${pct(t.deriv.cost)}`);
      if (t.deriv.time !== undefined && t.deriv.time !== 1) bits.push(`기간 ${pct(t.deriv.time)}`);
      if (bits.length) items.push({ good: (t.deriv.cost ?? 1) < 1, label: '파생형 개발', text: bits.join(' · ') });
    }
    if ((t.home || []).length) {
      const names = t.home.map((id) => (AIRLINES.find((a) => a.id === id) || {}).name).filter(Boolean);
      items.push({ good: true, label: '본국·전통 고객', text: `${names.join(' · ')} — 수주전 +${B.HOME_BID_BONUS}점` });
    }
    if (t.foreignBid) {
      // 지금 남은 감점을 그대로 보여 준다. "평판을 올리면 녹는다"가 숫자로 보여야
      // 그게 벽이 아니라 숙제라는 것이 전달된다. 표본 항공사는 그 지역에서 찾는다 —
      // 특정 id 를 박아 두면 지역 목록을 손보는 순간 조용히 0 을 보여주게 된다.
      const now = currentWallPenalty(s);
      items.push({
        good: false,
        label: `${(t.foreignBid.regions || []).join('·')} 항공사`,
        text: `수주전 −${t.foreignBid.penalty}점에서 시작해 평판 ${t.foreignBid.fadeTo}에서 사라진다 — 지금 −${now}점`,
      });
      const cert = t.foreignBid.certification;
      if (cert) {
        // 평판을 기다리는 길 옆의 지름길. 몇 기종이 이미 뚫었는지 함께 보여 준다 —
        // "살 수 있다"보다 "이만큼 샀다"가 판단에 필요한 정보다.
        const done = s.programs.filter((p) => p.foreignCert && p.foreignCert.done).length;
        const busy = s.programs.filter((p) => p.foreignCert && !p.foreignCert.done).length;
        items.push({
          good: true,
          label: '서방 형식증명',
          text:
            `기종당 개발비의 ${Math.round(cert.costRate * 100)}% · ${cert.quarters}분기를 내면 그 기종만 벽을 면제받는다` +
            (done || busy ? ` — 취득 ${done}종${busy ? ` · 심사 중 ${busy}종` : ''}` : ''),
        });
      }
    }
    if (t.stateOrders) {
      const so = t.stateOrders;
      items.push({
        good: true,
        label: `${so.customer} 발주`,
        text: `입찰 없이 ${so.qty[0]}~${so.qty[1]}기 · 정가의 ${Math.round(so.priceMult * 100)}% — 곳간이 마를수록 자주 온다`,
      });
    }
    const aid = t.aid || {};
    if (aid.rateMult !== undefined && aid.rateMult !== 1) {
      items.push({
        good: aid.rateMult > 1,
        label: '정부 런치 에이드',
        text: `개발비의 ${Math.round(E.launchAidRate(s) * 100)}% (기준 ${Math.round(E.LAUNCH_AID_RATE * 100)}%)${
          aid.tensionMult === 0 ? ' · 무역 긴장 없음' : aid.tensionMult !== undefined && aid.tensionMult !== 1 ? ` · 무역 긴장 ×${aid.tensionMult}` : ''
        }`,
      });
    }
    const gov = t.gov || {};
    if (gov.deliveredMult !== undefined || gov.winBonus !== undefined || gov.sustainMult !== undefined) {
      const bits = [];
      if (gov.deliveredMult !== undefined && gov.deliveredMult !== 1) bits.push(`자격 실적 문턱 ×${gov.deliveredMult}`);
      if (gov.winBonus) bits.push(`낙찰 확률 ${gov.winBonus > 0 ? '+' : '−'}${Math.abs(Math.round(gov.winBonus * 100))}%p`);
      if (gov.sustainMult !== undefined && gov.sustainMult !== 1) bits.push(`지원 수익 ×${gov.sustainMult}`);
      if (bits.length) items.push({ good: (gov.winBonus ?? 0) >= 0 && (gov.sustainMult ?? 1) >= 1, label: '정부 특수기 사업', text: bits.join(' · ') });
    }

    const list = items.length
      ? `<ul class="events">${items
          .map((i) => `<li><b class="${i.good ? 'good' : 'bad'}">${esc(i.label)}</b> — ${esc(i.text)}</li>`)
          .join('')}</ul>`
      : '<p class="muted">보정 없는 기준선이다 — 모든 규칙이 표준값 그대로 적용된다.</p>';

    // 사풍은 한 판 내내 바뀌지 않는 규칙이라 매 분기 스크롤로 지나칠 이유가 없다.
    // 대신 어느 회사로 굴리는 중인지는 접힌 제목에 그대로 남는다.
    return foldCard(
      folds,
      'ov-house',
      '회사 특성',
      esc(t.name),
      `<p class="muted">${esc(t.note || '')}</p>
       ${list}`,
    );
  }

  /**
   * 서방 형식증명 버튼 — 벽이 선 회사에만 나온다.
   *
   * 인증 심사 단계와 양산 단계 모두에서 신청할 수 있다: 상대 당국이 보는 것은
   * 시험 결과이지 취항 여부가 아니고, 실제로 SSJ-100 도 취항 뒤에 EASA 를 받았다.
   */
  function foreignCertControl(s, p) {
    const spec = E.foreignCertSpec(s);
    if (!spec) return '';
    const fc = p.foreignCert;
    const cost = money(p.devCost * spec.costRate);
    if (fc && fc.done) {
      return '<button disabled>서방 형식증명 ✓</button>';
    }
    if (fc) {
      return `<button disabled>서방 형식증명 심사 중 · ${fc.left}분기</button>`;
    }
    // 지금 벽이 0이면 사도 당장 오르는 점수가 없다. 막지는 않는다 — 인증은
    // 영구적이고 평판은 오르내리므로(국영 발주를 받을 때마다 −2), 평판이 높을 때
    // 사 두는 것은 보험으로서 유효하다. 대신 **지금은 값을 하지 않는다**는 사실을
    // 라벨에 적는다: 막으면 "잘 나갈 때 미리 사 두는" 정상적인 수가 사라진다.
    const inert = currentWallPenalty(s) === 0;
    return `<button data-action="foreign-cert" data-id="${p.id}">서방 형식증명 · ${cost} · ${spec.quarters}분기${inert ? ' <span class="muted">(지금은 벽 0 — 보험)</span>' : ''}</button>`;
  }

  /** 지금 이 회사에 남아 있는 벽 감점의 크기 (인증 안 받은 기종 기준). */
  function currentWallPenalty(s) {
    const wall = (s.trait || {}).foreignBid;
    if (!wall) return 0;
    const sample = AIRLINES.find((a) => (wall.regions || []).includes(a.home));
    if (!sample) return 0;
    return Math.abs(B.homeBias({ trait: { foreignBid: wall }, reputation: s.reputation }, { airlineId: sample.id }));
  }

  /** 벽이 선 회사에서만 뜨는 안내 — 이 기종이 낯선 시장에서 어떤 처지인가. */
  function foreignCertHint(s, p) {
    const spec = E.foreignCertSpec(s);
    if (!spec) return '';
    const wall = (s.trait || {}).foreignBid || {};
    const regions = (wall.regions || []).join('·');
    if (p.foreignCert && p.foreignCert.done) {
      return `<p class="hint good">${esc(regions)} 항공사 앞에서 이 기종은 더 이상 낯선 제조사가 아니다 — 벽 감점이 면제된다. 평판이 떨어져도 이 기종만은 그대로다.</p>`;
    }
    const left = currentWallPenalty(s);
    if (left === 0) {
      // 벽이 0인데 버튼이 그냥 열려 있으면 "사면 좋아지겠지"로 읽힌다. 지금 값이
      // 0이라는 것과, 그럼에도 살 이유가 무엇인지를 같이 적는다.
      return `<p class="hint">평판 ${Math.round(s.reputation)}이라 ${esc(regions)} 벽은 지금 <b>0</b>이다 — 인증을 사도 당장 오르는 점수는 없다. 다만 인증은 영구적이고 평판은 내려갈 수 있다(국영 발주를 받을 때마다 −2). 지금 사는 것은 그때를 위한 보험이다.</p>`;
    }
    return `<p class="hint">${esc(regions)} 항공사는 우리 인증을 믿지 않는다 — 지금 <b>−${left}점</b>. 평판 ${wall.fadeTo}까지 올려 회사 전체의 벽을 녹이거나, <b>이 기종 하나만</b> 상대 당국의 형식증명을 사서 지금 뚫어라.</p>`;
  }

  function renderOverview(s, folds) {
    const warnings = [];

    for (const p of s.programs.filter((x) => x.phase === 'production')) {
      const ordered = orderedBy(s, p.id);
      const lines = s.lines.filter((l) => l.programId === p.id).length;
      if (ordered > 0 && lines === 0) {
        warnings.push(
          `<b>${esc(p.name)}</b> 수주 잔고 ${ordered}기가 있는데 <b>조립 라인이 없다</b>. 라인을 세우기 전에는 한 대도 인도할 수 없다.`,
        );
      }
    }
    for (const p of s.programs.filter((x) => x.phase === 'dev' && x.share <= 0)) {
      warnings.push(`<b>${esc(p.name)}</b> 개발이 <b>동결</b> 상태다. 인력을 배분해야 진행된다.`);
    }
    if (s.cash < 400) warnings.push(`현금이 ${money(s.cash)}까지 떨어졌다. 차입·재고 처분·개발 동결을 검토하라.`);
    const runway = E.cashRunway(s);
    if (runway !== null && runway <= 8) {
      warnings.push(
        runway <= 0
          ? '이번 분기 지출을 감당할 현금이 없다. <b>증자·프로그램 매각</b>을 지금 검토하라.'
          : `최근 지출 속도라면 <b>${runway}분기 뒤 현금이 마른다</b>. 증자·프로그램 매각·개발 동결 중 하나는 지금 정해야 한다.`,
      );
    }
    if (s.debt >= CONFIG.maxDebt * 0.9) warnings.push(`차입이 한도(${money(CONFIG.maxDebt)})에 근접했다. 한 번 더 적자가 나면 파산이다.`);
    const idleLines = s.lines.filter((l) => l.idle).length;
    if (idleLines) warnings.push(`가동 중지된 라인이 ${idleLines}개 있다. 유지비는 계속 나간다.`);

    const events = s.events.length
      ? s.events.map((e) => `<li><b>${esc(e.name)}</b> — ${esc(e.text)}</li>`).join('')
      : '<li class="muted">특별한 일 없이 지나간 분기.</li>';

    const news = (s.news || []).length
      ? s.news.map((n) => `<li class="news-${n.kind}">${esc(n.text)}</li>`).join('')
      : '<li class="muted">경쟁사 카탈로그에 변동이 없다.</li>';

    const last = s.history[s.history.length - 1];
    const prev = s.history[s.history.length - 2];
    const rows = s.history.slice(-24);

    return `
      ${scenarioCard(s)}
      ${mandateCard(s)}
      ${decisionCard(s)}
      ${settlementCard(last, prev)}

      ${houseCard(s, folds)}

      ${foldCard(
        folds,
        'ov-airlines',
        '항공사 수요 프로필',
        `${AIRLINES.length}개사`,
        `<p class="muted">각 항공사는 자기 노선망 안에서 발주한다. 설계를 어느 대역에 맞출지가 곧 누구를 고객으로 삼을지다.</p>
         ${airlineDemandTable(s)}`,
      )}

      <section class="grid2">
        <div class="card">
          <h3>이번 분기 소식</h3>
          <ul class="events">${events}</ul>
          <details class="fold"${foldOpen(folds, 'ov-news', false) ? ' open' : ''}>
            <summary data-fold="ov-news"><b>업계 동향</b><span class="fold-val">${
              (s.news || []).length ? `${(s.news || []).length}건` : '변동 없음'
            }</span></summary>
            <ul class="events news">${news}</ul>
          </details>
        </div>
        ${
          // 손볼 게 없으면 "없다"고 적힌 카드를 세우지 않는다 — 빈 카드도 스크롤이다.
          // 남은 일은 하단 액션 바의 할 일 배지가 늘 세고 있다.
          warnings.length
            ? `<div class="card">
                 <h3>경영 경고</h3>
                 <ul class="warns">${warnings.map((w) => `<li>${w}</li>`).join('')}</ul>
               </div>`
            : ''
        }
      </section>

      <section class="cards">
        ${statCard('수주 잔고', num(E.totalBacklog(s)) + '기', money(E.backlogValue(s)) + ' 상당', '', spark(rows, 'backlog', 'accent'))}
        ${statCard('누적 인도', num(s.stats.delivered) + '기', '시장 점유율 ' + (E.marketShare(s) * 100).toFixed(1) + '%', '', spark(rows, 'share', 'accent'))}
        ${statCard('순자산', money(E.netWorth(s)), '현금 ' + money(s.cash) + ' · 부채 ' + money(s.debt), '', spark(rows, 'worth', 'good'))}
        ${statCard('평판', Math.round(s.reputation) + ' / 100', '엔지니어 ' + num(s.engineers) + '명', '', spark(rows, 'reputation', 'warn'))}
        ${
          last
            ? statCard(
                '전분기 손익',
                (last.net >= 0 ? '+' : '') + money(last.net),
                '매출 ' + money(last.revenue) + ' · 비용 ' + money(last.cost),
                last.net >= 0 ? 'good' : 'bad',
                spark(rows, 'net', last.net >= 0 ? 'good' : 'bad'),
              )
            : statCard('전분기 손익', '—', '아직 정산 전')
        }
        ${statCard('보유 기종', s.programs.filter((p) => p.phase === 'production').length + '종', s.lines.length + '개 라인 가동')}
      </section>

      ${rivalCard(s, folds)}

      <section class="card">
        <h3>최근 기록</h3>
        <ul class="log">${s.log.slice(0, 4).map(logItem).join('')}</ul>
        <p class="hint">전체 기록은 <b>기록</b> 탭에 있다.</p>
      </section>`;
  }

  function statCard(label, value, sub, tone, chart) {
    return `<div class="stat ${tone || ''}"><span class="stat-label">${label}</span><span class="stat-value">${value}</span><span class="stat-sub">${sub || ''}</span>${chart || ''}</div>`;
  }

  /** 통계 카드에 붙는 미니 곡선. 옛 세이브에 없는 항목이면 조용히 빈 문자열이 된다. */
  function spark(rows, key, cls) {
    return C.spark(
      rows.map((h) => h[key]).filter((v) => typeof v === 'number'),
      cls,
    );
  }

  /**
   * 이사회 목표 카드 — 5년짜리 눈금.
   * 최종 점수 하나로만 재면 중간이 없다. 남은 분기와 진행률을 늘 보이게 둔다.
   */
  function mandateCard(s) {
    const m = E.mandateStatus(s);
    if (!m) return '';
    const pct = Math.round(m.ratio * 100);
    const tone = m.met ? 'good' : m.quartersLeft <= 4 ? 'bad' : '';
    return `
      <section class="card mandate ${tone}">
        <div class="row between">
          <h3>이사회 목표 · ${esc(m.name)}</h3>
          <span class="${m.met ? 'good' : m.quartersLeft <= 4 ? 'bad' : 'muted'}">
            ${m.met ? '달성' : `${m.quartersLeft}분기 남음`}
          </span>
        </div>
        <p class="muted">${esc(m.text)} — ${esc(E.turnLabel(m.dueTurn))}까지</p>
        <div class="mandate-bar">${bar(pct, m.met ? 'good' : '')}</div>
        <p class="hint">현재 ${esc(m.format(m.now))} / 목표 ${esc(m.format(m.target))} · 달성하면 증자와 신임, 미달하면 조달 금리가 오른다.</p>
      </section>`;
  }

  /**
   * 결정 사건 카드 — 답을 기다리는 사건을 개요 맨 위에 세운다.
   * 고르지 않고 분기를 넘길 수 있지만 그때는 무대응이 적용되므로, 그 사실을 밝혀 둔다.
   */
  function decisionCard(s) {
    const d = s.decision;
    if (!d) return '';
    return `
      <section class="card decision">
        <h3>${esc(d.name)}</h3>
        <p class="decision-text">${richText(d.text)}</p>
        <div class="decision-options">
          ${d.options
            .map(
              (o) => `<button class="decision-opt" data-action="decide" data-opt="${esc(o.id)}">
                <b>${esc(o.label)}</b>
                <span class="muted">${esc(o.detail)}</span>
              </button>`,
            )
            .join('')}
        </div>
        <p class="hint">고르지 않고 분기를 넘기면 <b>무대응</b>으로 처리된다 — 그것도 하나의 선택이다.</p>
      </section>`;
  }

  /**
   * 직전 분기 결산 카드.
   * 정산 결과가 토스트 한 줄로만 흘러가면 무엇 때문에 적자였는지가 남지 않는다.
   * 개요 맨 위에 고정해 두고, 전분기 대비 증감을 같이 보여준다.
   */
  function settlementCard(last, prev) {
    if (!last) return '';
    const delta = (key, fmt, invert) => {
      if (!prev || typeof prev[key] !== 'number' || typeof last[key] !== 'number') return '';
      const d = last[key] - prev[key];
      if (Math.abs(d) < 1e-9) return '';
      const good = invert ? d < 0 : d > 0;
      return `<span class="delta ${good ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d))}</span>`;
    };

    return `
      <section class="card settle ${last.net >= 0 ? 'plus' : 'minus'}">
        <h3>${esc(last.label)} 결산</h3>
        <div class="settle-grid">
          <div class="settle-main">
            <span class="settle-label">분기 손익</span>
            <b class="${last.net >= 0 ? 'good' : 'bad'}">${last.net >= 0 ? '+' : ''}${money(last.net)}</b>
            ${delta('net', money)}
          </div>
          <div><span>매출</span><b>${money(last.revenue)}</b>${delta('revenue', money)}</div>
          <div><span>비용</span><b>${money(last.cost)}</b>${delta('cost', money, true)}</div>
          <div><span>인도</span><b>${num(last.delivered)}기</b>${delta('delivered', (v) => num(v) + '기')}</div>
          <div><span>수주 잔고</span><b>${num(last.backlog)}기</b>${delta('backlog', (v) => num(v) + '기')}</div>
          <div><span>현금</span><b>${money(last.cash)}</b>${delta('cash', money)}</div>
          <div><span>부채</span><b>${money(last.debt)}</b>${delta('debt', money, true)}</div>
        </div>
      </section>`;
  }

  function logItem(l) {
    return `<li class="log-${l.kind}"><span class="log-turn">${l.label}</span> ${esc(l.text)}</li>`;
  }

  // ─────────────────────────────── 설계 ───────────────────────────────

  function renderDesign(s, spec, designName, folds) {
    const seg = SEGMENTS[spec.segment];
    const segTabs = SEGMENT_ORDER.map(
      (id) =>
        `<button class="seg ${id === spec.segment ? 'on' : ''}" data-action="design-seg" data-seg="${id}">
           <b>${SEGMENTS[id].name}</b><span>${SEGMENTS[id].seats.min}–${SEGMENTS[id].seats.max}석</span>
         </button>`,
    ).join('');

    const legacyMat = LEGACY_MATERIAL_MAP[spec.material] || LEGACY_MATERIAL_MAP.aluminum;
    const partPicker = (table, key, current) =>
      Object.values(table)
        .map(
          (m) =>
            `<button class="mat ${m.id === current ? 'on' : ''}" data-action="design-${key}" data-mat="${m.id}">
             <b>${esc(m.name)}</b><span>${esc(m.desc)}</span>
           </button>`,
        )
        .join('');
    const fusMats = partPicker(FUSELAGE_MATERIALS, 'fuselage', spec.fuselage || legacyMat.fuselage);
    const wingMats = partPicker(WING_MATERIALS, 'wingmat', spec.wingMat || legacyMat.wingMat);

    // 그 시점에 실제로 살 수 있는 엔진만 보여준다. 성숙도가 덜 찬 신형은 경고를 단다.
    const year = E.yearOf(s.turn);
    // 지정한 엔진이 이미 단산됐으면 evaluate 가 그 시점 엔진으로 대체한다.
    // 그 결과를 먼저 구해 두지 않으면 어느 버튼도 선택 표시가 안 되고,
    // 플레이어는 자기가 무슨 엔진으로 착수하는지 모른 채 버튼을 누르게 된다.
    const sections = Airframe.sectionsFor(spec.segment)
      .map((c) => {
        const on = c.abreast === (spec.abreast ?? Airframe.DEFAULT_ABREAST[spec.segment]);
        const band = `${Math.round(c.rows[0] * c.abreast)}~${Math.round(c.rows[1] * c.abreast)}석`;
        return `<button class="mat ${on ? 'on' : ''}" data-action="design-abreast" data-abreast="${c.abreast}">
             <b>${esc(c.name)}</b><span>적정 ${band} · 객실 ${c.comfort >= 0 ? '+' : ''}${c.comfort} · 좌석당 연비 ×${c.effPerSeat.toFixed(2)} · 원가 ×${c.costPerSeat.toFixed(2)}</span>
           </button>`;
      })
      .join('');

    const dealCtx = E.engineDealContext(s);
    const domesticIds = s.localEngines || [];
    const effectiveEngine = (Engines.resolve(spec.segment, spec.engine, year, dealCtx.earlyEngines, domesticIds) || {}).id;
    const substituted = spec.engine && effectiveEngine !== spec.engine;
    const engines = Engines.available(spec.segment, year, dealCtx.earlyEngines, domesticIds)
      .slice()
      .sort((a, b) => a.eff - b.eff)
      .map((e) => {
        const immature = Engines.maturityRisk(e, year) > 1;
        const on = e.id === effectiveEngine;
        const early = year < e.eis;
        const offDeal = dealCtx.exclusiveMaker && e.maker !== dealCtx.exclusiveMaker;
        return `<button class="mat ${on ? 'on' : ''}" data-action="design-eng" data-eng="${e.id}">
             <b>${esc(e.name)}</b>
             <span>${esc(e.maker)} · 연비 ${e.eff >= 0 ? '+' : ''}${e.eff} · 단가 ×${e.costMult.toFixed(2)}${
               immature ? ' · <b class="warn">신형(초기 결함 위험)</b>' : ''
             }${early ? ' · <b>런칭 파트너 선공급</b>' : ''}${offDeal ? ' · <b class="warn">독점 계약 밖 (개발비 +8%)</b>' : ''}</span>
           </button>`;
      })
      .join('');

    const derivatives = s.programs
      .filter((p) => p.phase === 'production')
      .map(
        (p) =>
          `<button class="ghost" data-action="derive" data-id="${p.id}">${esc(p.name)} 파생형 설계</button>`,
      )
      .join('');

    // 접힌 섹션의 제목 옆에 지금 고른 값을 적는다 — 열지 않고도 무엇으로 설계 중인지 안다.
    const curAbreast = spec.abreast ?? Airframe.DEFAULT_ABREAST[spec.segment];
    const curSection = Airframe.sectionsFor(spec.segment).find((c) => c.abreast === curAbreast);
    const curFus = FUSELAGE_MATERIALS[spec.fuselage || legacyMat.fuselage];
    const curWing = WING_MATERIALS[spec.wingMat || legacyMat.wingMat];
    const optionTags = [
      spec.family && '패밀리',
      spec.etops && 'ETOPS',
      spec.growth && '성장 여유',
      spec.maintainable && '정비성',
      spec.engines === 4 && '4발',
      spec.dualSource && '이중화',
    ].filter(Boolean);

    return `
      ${renderDesignSummary(s, spec)}
      <section class="card">
        <h3>세그먼트</h3>
        <p class="muted">${esc(seg.desc)}</p>
        <div class="segs">${segTabs}</div>
      </section>

      <section class="grid2">
        <div class="stack">
          <section class="card">
            <h3>제원</h3>
            ${slider('seats', '좌석수', spec.seats, seg.seats.min, seg.seats.max, 1, '석')}
            ${slider('range', '항속거리', spec.range, seg.range.min, seg.range.max, 100, 'km')}
            ${slider('tech', '기술 투자', spec.tech, 0, 100, 1, '')}
            <p class="hint">기술 투자를 올리면 연비·정가가 오르지만 개발비·기간·결함 위험이 함께 오른다.</p>
            ${slider('wing', '날개 (단거리형 ↔ 장거리형)', spec.wing === undefined ? 45 : spec.wing, 0, 100, 1, '')}
            <p class="hint">오른쪽으로 갈수록 순항 연비가 좋아지고 <b>이착륙 성능이 나빠진다</b>. 짧은 활주로·고온고지 노선은 왼쪽 설계가 아니면 응찰 자체가 막힌다.</p>
            ${slider('fuelMargin', '연료 여유 (임무 최적 ↔ 노선 확장)', spec.fuelMargin === undefined ? 35 : spec.fuelMargin, 0, 100, 1, '')}
            <p class="hint">설계 항속보다 <b>먼 노선도 승객을 덜 태우면 뛸 수 있다</b>. 오른쪽으로 갈수록 그 폭이 넓어지지만, 탱크와 보강 구조를 짧은 노선에서도 지고 다녀 연비·원가·이착륙이 상시로 나빠진다.</p>
          </section>

          ${foldCard(
            folds,
            'design-section',
            '동체 단면',
            esc(curSection ? curSection.name : ''),
            `<div class="mats">${sections}</div>
             <p class="hint">좁게 많이 태우면 좌석당 연비·원가가 좋아지고 객실 점수가 떨어진다. 단면을 바꾸면 형식증명을 물려받을 수 없다 — 파생형의 뿌리가 되는 결정이다.</p>`,
          )}
          ${foldCard(
            folds,
            'design-fus',
            '동체 소재',
            esc(curFus ? curFus.name : ''),
            `<div class="mats">${fusMats}</div>
             <p class="hint">동체는 여압 사이클이 걸려 개발이 가장 어렵다. 대신 넓은 단면·높은 여압으로 <b>객실이 크게 좋아진다</b>.</p>`,
          )}
          ${foldCard(
            folds,
            'design-wingmat',
            '날개 소재',
            esc(curWing ? curWing.name : ''),
            `<div class="mats">${wingMats}</div>
             <p class="hint">날개는 가벼워야 종횡비를 높일 수 있다. <b>고종횡비 장거리 날개는 사실상 복합재라야 성립한다</b> — 알루미늄으로 밀어붙이면 중량이 연비 이득을 갉아먹는다.</p>`,
          )}
          ${foldCard(
            folds,
            'design-engine',
            '엔진',
            esc((Engines.get(effectiveEngine) || {}).name || ''),
            `<div class="mats">${engines}</div>
             <p class="hint">신형 엔진은 연비가 크게 좋지만 단가·개발비가 오르고, 취항 3년 안쪽이면 초기 결함 위험이 얹힌다.</p>
             ${
               substituted
                 ? `<p class="warn-box">원형 엔진은 더 이상 판매되지 않아 <b>${esc(
                     (Engines.get(effectiveEngine) || {}).name || '',
                   )}</b>로 대체된다 — 재장착이라 파생형 할인이 줄어든다.</p>`
                 : ''
             }`,
          )}
          ${foldCard(
            folds,
            'design-launch-options',
            '착수 옵션',
            optionTags.length ? esc(optionTags.join(' · ')) : '<span class="muted">없음</span>',
            `<div class="mats" id="design-options">${renderDesignOptions(s, spec)}</div>`,
          )}
        </div>
        <div class="card" id="design-preview">${renderDesignPreview(s, spec, designName)}</div>
      </section>

      ${derivatives ? `<section class="card"><h3>파생형</h3><p class="muted">기존 형식증명을 물려받아 개발비 66%, 기간 50%를 아낀다. 엔진까지 갈아 끼우면(재장착) 절감이 42%·28%로 줄어든다.</p><div class="row">${derivatives}</div></section>` : ''}`;
  }

  /**
   * 착수 옵션 — 패밀리·ETOPS.
   *
   * 이 블록은 **슬라이더를 움직이면 같이 갈아끼워야 한다**. 두 옵션 다 지금의
   * 항속·기술·날개 값에 따라 의미가 달라지기 때문이다: 파생형 허용 오차를 넘기면
   * 패밀리 승계가 끊기고, 항속이 짧으면 ETOPS 는 값을 못 한다. 미리보기만 새로
   * 그리면 여기가 옛 상태로 남아 실제 착수 결과와 어긋난다.
   */
  function renderDesignOptions(s, spec) {
    const ev = D.evaluate({ ...spec, ...E.designContext(s) });
    const family = ev.inFamily
      ? `<button class="mat on" disabled>
          <b>패밀리 승계</b><span>원형이 이미 패밀리라 공통 구조·조종석을 그대로 물려받는다. 선투자는 뿌리에서 한 번만 하므로 <b>추가 비용이 없다</b>.</span>
        </button>`
      : `<button class="mat ${spec.family ? 'on' : ''}" data-action="design-family">
          <b>패밀리로 개발</b><span>개발비 +22% · 기간 +8%. 이후 같은 단면의 파생형이 신규 설계 대비 22%(일반 34%)로 떨어지고, 항공사 공통성도 패밀리 단위로 쌓인다.</span>
        </button>`;
    // 4발이면 ETOPS 는 살 것이 없다 — 켜진 채 두면 숨은 spec.etops 만 토글돼,
    // 나중에 쌍발로 되돌렸을 때 개발비 +8%·인증 +1분기가 몰래 붙는다.
    const etops = ev.engines === 4
      ? `<button class="mat" disabled>
          <b>ETOPS 인증</b><span>4발은 ETOPS 규정 밖이다 — 인증 없이 대양 노선에 응찰·인도하므로 여기서 살 것이 없다.</span>
        </button>`
      : ev.etopsUsable
        ? `<button class="mat ${ev.etops ? 'on' : ''}" data-action="design-etops">
          <b>ETOPS 인증</b><span>개발비 +8% · 인증 +1분기. 없으면 ${num(ETOPS_RANGE_KM)}km 이상 노선은 응찰 자체가 불가능하다.</span>
        </button>`
        : `<button class="mat" disabled>
          <b>ETOPS 인증</b><span>이 항속(${num(ev.range)}km)으로는 ${num(ETOPS_RANGE_KM)}km 노선에 닿지 않는다. <b>${num(
            Math.ceil(ETOPS_USEFUL_RANGE),
          )}km 이상</b>부터 값을 한다.</span>
        </button>`;
    // 파생형은 구조(성장 여유·정비성·엔진 수)를 원형에서 물려받는다 — 토글이 아니라 사실이다.
    const inherit = ev.derivative;
    const growth = inherit
      ? `<button class="mat ${ev.growth ? 'on' : ''}" disabled>
          <b>성장 여유</b><span>원형에서 승계한다 — ${ev.growth ? '여유 있는 구조라 이 개조가 15% 싸고 빠르다' : '원형에 여유가 없어 재장착 시 연비 타협(−3)을 문다'}.</span>
        </button>`
      : `<button class="mat ${spec.growth ? 'on' : ''}" data-action="design-growth">
          <b>성장 여유</b><span>개발비 +6% · 원가 +3% · 연비 −1. 대신 이후 <b>파생형·재장착이 15% 싸고 빨라지고</b>, 재장착 때 신형 엔진의 연비를 온전히 받는다. A320 의 긴 다리가 neo 를 쉽게 만든 이야기다.</span>
        </button>`;
    const maintainable = inherit
      ? `<button class="mat ${ev.maintainable ? 'on' : ''}" disabled>
          <b>정비성 설계</b><span>원형에서 승계한다.</span>
        </button>`
      : `<button class="mat ${spec.maintainable ? 'on' : ''}" data-action="design-maintainable">
          <b>정비성 설계</b><span>개발비 +5% · 원가 +2%. 편당 고정비 −12%(운용경제 점수), 결함 위험 ×0.9, 운항 정지가 걸려도 1분기 짧다. 수수한 기체가 오래 팔리는 이유.</span>
        </button>`;
    const engines =
      spec.segment !== 'wide'
        ? ''
        : inherit
          ? `<button class="mat ${ev.engines === 4 ? 'on' : ''}" disabled>
              <b>${ev.engines === 4 ? '4발' : '쌍발'}</b><span>엔진 수는 원형에서 승계한다 — 바꾸면 새 기체다.</span>
            </button>`
          : `<button class="mat ${spec.engines === 4 ? 'on' : ''}" data-action="design-engines">
              <b>4발</b><span>ETOPS 가 <b>아예 필요 없다</b> — 인증 없이 대양 노선에 응찰·인도한다. 대신 개발비 +12% · 원가 +8% · 연비 −7: 유가가 오르면 그 감점이 몇 배로 돌아온다. 747 의 흥망이 이 트레이드다.</span>
            </button>`;
    const dual = inherit
      ? `<button class="mat ${ev.dualSource ? 'on' : ''}" disabled>
          <b>엔진 이중화</b><span>원형에서 승계한다${ev.dualSource ? ` — 대안 ${esc(ev.altEngineName || '')}` : ''}.</span>
        </button>`
      : ev.altEngine || !spec.dualSource
        ? `<button class="mat ${ev.dualSource ? 'on' : ''}" data-action="design-dual">
          <b>엔진 이중화</b><span>개발비 +10% · 원가 +3%. 두 공급사 엔진을 모두 인증한다 — 어느 항공사의 <b>선호 엔진 가산</b>이든 받고, 한쪽 공급이 서도 라인이 절반만 죽지 않는다.${
            ev.dualSource ? ` 대안: <b>${esc(ev.altEngineName || '')}</b>` : ' A330 이 그랬다.'
          }</span>
        </button>`
        : `<button class="mat" disabled>
          <b>엔진 이중화</b><span>이 시점 이 세그먼트에는 다른 공급사의 엔진이 없다 — 이중화할 상대가 없다.</span>
        </button>`;
    return family + etops + growth + maintainable + engines + dual;
  }

  function slider(key, label, value, min, max, step, unit) {
    return `<label class="slider">
      <span>${label}<b id="lbl-${key}">${num(value)}${unit}</b></span>
      <input type="range" data-action="design-input" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
    </label>`;
  }

  /**
   * 설계 요약 바 — 좁은 화면에서 상단에 붙어 따라다닌다.
   *
   * 2단 그리드가 1단으로 접히면 슬라이더는 위, 평가표는 저 아래로 밀린다.
   * 그러면 값을 움직이면서 그 결과를 볼 수가 없어 설계가 눈감고 하는 일이 된다.
   * 결정을 좌우하는 숫자만 뽑아 늘 보이게 둔다 (나머지 평가는 아래 미리보기 그대로).
   */
  function renderDesignSummary(s, spec) {
    const ev = D.evaluate({ ...spec, year: E.yearOf(s.turn), experience: E.companyExperience(s), ...E.engineDealContext(s) });
    const upfront = Math.round(ev.devCost * CONFIG.launchUpfrontRate);
    const affordable = s.cash >= upfront;
    const cell = (label, value, tone) =>
      `<span class="ds-cell ${tone || ''}"><i>${label}</i><b>${value}</b></span>`;
    return `<div class="design-sum" id="design-sum">
        <div class="ds-strip">
          ${cell('좌석', num(ev.seats) + '석')}
          ${cell('항속', num(ev.range) + 'km')}
          ${cell('개발비', money(ev.devCost))}
          ${cell('착수금', money(upfront), affordable ? '' : 'bad')}
          ${cell('기간', ev.devQuarters + '+' + ev.certQuarters + '분기')}
          ${cell('연비', String(ev.efficiency))}
          ${cell('객실', String(ev.comfort))}
        </div>
        <button class="ghost small ds-jump" data-action="goto-preview">평가 ▾</button>
      </div>`;
  }

  /** 설계 미리보기 — 슬라이더를 움직일 때 이 영역만 갈아끼운다. */
  function renderDesignPreview(s, spec, designName) {
    // 미리보기는 항상 "지금" 기준으로 평가한다. spec.year 를 들고 다니면 분기가
    // 지나도 갱신되지 않아, 이미 살 수 없는 엔진으로 계산된 값을 보여주게 된다.
    const ev = D.evaluate({ ...spec, ...E.designContext(s) });
    const upfront = Math.round(ev.devCost * CONFIG.launchUpfrontRate);
    const seg = SEGMENTS[spec.segment];

    // 현재 인력으로 실제 얼마나 걸리는지 — 표시 기간은 인력 100% 가정이라 오해를 부른다.
    // 엔진은 배분 가중치의 합으로 인력을 나누므로, 균등 배분이 아니라 실제 가중치로 계산해야
    // 미리보기와 실제 진행 속도가 어긋나지 않는다 (기존이 5/95 같은 편중이면 차이가 크다).
    const existingShare = s.programs
      .filter((p) => p.phase === 'dev' && p.share > 0)
      .reduce((a, p) => a + p.share, 0);
    const newShare = CONFIG.defaultProgramShare;
    const shareIfLaunched = newShare / (existingShare + newShare);
    const effective = Math.min(1.4, (s.engineers * shareIfLaunched) / ev.engineersNeeded);
    const realQuarters = effective > 0 ? Math.ceil(ev.devQuarters / effective) : Infinity;

    const affordable = s.cash >= upfront;
    const liquidity = s.cash + Math.max(0, CONFIG.maxDebt - s.debt);
    const heavy = ev.devCost > liquidity;

    return `
      <h3>설계 평가</h3>
      <table class="spec">
        <tr><th>총 개발비</th><td class="${heavy ? 'bad' : ''}">${money(ev.devCost)}</td></tr>
        <tr><th>착수금 (${Math.round(CONFIG.launchUpfrontRate * 100)}%)</th><td class="${affordable ? '' : 'bad'}">${money(upfront)}</td></tr>
        <tr><th>개발 기간</th><td>${ev.devQuarters}분기 <span class="muted">(현 인력 기준 약 ${realQuarters === Infinity ? '∞' : realQuarters}분기)</span></td></tr>
        ${
          ev.experience > 0
            ? `<tr><th>조직 경험</th><td>${ev.experience}점 <span class="muted">— 기간 −${ev.expTimeCut}% · 필요 인력 −${ev.expEngCut}% 반영됨</span></td></tr>`
            : ''
        }
        <tr><th>인증 기간</th><td>${ev.certQuarters}분기</td></tr>
        <tr><th>필요 인력</th><td>${num(ev.engineersNeeded)}명 <span class="muted">(보유 ${num(s.engineers)}명)</span></td></tr>
        <tr><th>연비 지수</th><td>${ev.efficiency} ${bar(ev.efficiency, 'eff')}</td></tr>
        <tr><th>이착륙 성능</th><td>${ev.fieldPerf} ${bar(ev.fieldPerf, 'eff')}</td></tr>
        <tr><th>항속 (만석 / 감톤 20%)</th><td>${num(ev.payloadRange.full)}km / ${num(ev.payloadRange.light)}km</td></tr>
        <tr><th>단면 적합도</th><td class="${ev.sectionFit < 80 ? 'bad' : ''}">${ev.sectionFit}% <span class="muted">${esc(ev.sectionName)}</span></td></tr>
        <tr><th>객실 쾌적성</th><td>${ev.comfort} ${bar(ev.comfort, 'comfort')}</td></tr>
        <tr><th>표준 생산원가</th><td>${money(ev.unitCostBase)}</td></tr>
        <tr><th>정가</th><td>${money(ev.listPrice)}</td></tr>
        <tr><th>결함 위험</th><td class="${ev.defectRisk > 0.25 ? 'bad' : ''}">${(ev.defectRisk * 100).toFixed(1)}%</td></tr>
        <tr><th>라인 건설비</th><td>${money(seg.lineCost)} <span class="muted">(분기 최대 ${seg.lineMaxRate}기)</span></td></tr>
      </table>
      ${heavy ? `<p class="warn-box">총 개발비가 현재 동원 가능한 자금(${money(liquidity)})을 넘는다. 이대로 착수하면 개발 도중 파산할 가능성이 매우 높다.</p>` : ''}
      ${
        spec.derivedFrom && !ev.derivative
          ? `<p class="warn-box">소재·기술·항속을 원형(${esc(spec.derivedFrom.name)})에서 너무 많이 바꿔 형식증명을 물려받을 수 없다. <b>신규 설계 비용</b>으로 계산된다.</p>`
          : ''
      }
      ${
        ev.derivative
          ? `<p class="hint">${esc(spec.derivedFrom.name)} 파생형으로 인정 — ${
              ev.reEngined
                ? ev.inFamily
                  ? '패밀리 내 <b>재장착</b>이라 개발비 56%·기간 40% 절감'
                  : '엔진을 갈아 끼운 <b>재장착</b>이라 개발비 42%·기간 28% 절감'
                : ev.inFamily
                  ? '<b>패밀리 내 파생형</b>이라 개발비 78%·기간 64% 절감'
                  : '개발비 66%·기간 50% 절감'
            }이 적용됐다.</p>`
          : ''
      }
      <div class="row">
        <input class="name-input" id="design-name" data-action="design-name" placeholder="기종명 (예: DN-200)" maxlength="18" value="${esc(designName || '')}">
        <button class="primary" data-action="launch" ${affordable ? '' : 'disabled'}>개발 착수 · ${money(upfront)}</button>
      </div>
      ${affordable ? '' : '<p class="warn-box">착수금이 부족하다.</p>'}`;
  }

  // ─────────────────────────────── 프로그램 ───────────────────────────────

  function renderPrograms(s, folds) {
    // 취소·매각된 기종은 목록에서 뺀다. 회고(종료 화면)에는 계보로 남는다.
    const active = s.programs.filter((p) => p.phase !== 'cancelled' && p.phase !== 'sold');
    if (!active.length) return '<div class="card"><p class="muted">아직 기종이 없다. 설계 탭에서 개발을 착수하라.</p></div>';

    return active
      .map((p) => {
        const eta = E.projectedQuarters(s, p);
        const rows = [];
        rows.push(`<tr><th>세그먼트</th><td>${SEGMENTS[p.segment].name} · ${p.seats}석 · ${num(p.range)}km</td></tr>`);
        // 엔진은 되돌릴 수 없는 선택이고 이후 파생형 비용(같은 엔진 34% vs 재장착 58%)을
        // 좌우한다. 화면에 없으면 플레이어가 자기 기체의 엔진을 확인할 방법이 없다.
        const inst = Engines.get(p.engine);
        if (inst) {
          // 해금 목록을 넘겨야 한다 — 국산 엔진은 게이트가 걸려 있어, 안 넘기면
          // 국산화한 기체가 매번 "단산"으로 보이고 파생형 안내까지 거짓이 된다.
          const gone = !Engines.inService(inst, E.yearOf(s.turn), [], s.localEngines || []);
          rows.push(
            `<tr><th>엔진</th><td>${esc(inst.name)} <span class="muted">${esc(inst.maker)}</span>${
              p.altEngine ? ` · 대안 ${esc((Engines.get(p.altEngine) || {}).name || '')}` : ''
            }${gone ? ' <span class="warn">단산 — 파생형은 재장착</span>' : ''}</td></tr>`,
          );
        }
        // ETOPS 는 되돌릴 수 없고 9,000km 이상 노선의 응찰 자격을 좌우한다.
        rows.push(
          `<tr><th>인증 / 계보</th><td>${
            p.engines === 4 ? '4발 ✓' : p.etops ? 'ETOPS ✓' : '<span class="muted">ETOPS 없음</span>'
          }${p.foreignCert && p.foreignCert.done ? ' · 서방 형식증명 ✓' : ''}${p.growth ? ' · 성장 여유' : ''}${p.maintainable ? ' · 정비성' : ''}${p.altEngine ? ' · 이중화' : ''}${
            p.familyId ? ' · 패밀리' : ''
          }${p.derivative ? ' · 파생형' : ''}${p.govMission ? ' · 특수기 파생' : ''}${p.acquired ? ' · 인수 프로그램' : ''}</td></tr>`,
        );
        rows.push(`<tr><th>연비 / 쾌적성</th><td>${p.efficiency} / ${p.comfort}</td></tr>`);
        rows.push(`<tr><th>정가 / 표준원가</th><td>${money(p.listPrice)} / ${money(p.unitCostBase)}</td></tr>`);
        // 개발 중에는 인증 진입 때 실측치로 재확정되므로 불확실성 밴드를 함께 보여준다.
        const riskBand = p.phase === 'dev' ? ` <span class="muted">±${p.windTunnel ? 8 : 30}%</span>` : '';
        rows.push(`<tr><th>결함 위험</th><td class="${p.defectRisk > 0.25 ? 'bad' : ''}">${(p.defectRisk * 100).toFixed(1)}%${riskBand}</td></tr>`);
        if (p.launchAid) {
          const owed = Math.max(0, Math.round(p.launchAid.amount * E.LAUNCH_AID_PAYBACK) - p.launchAid.repaid);
          rows.push(
            `<tr><th>정부 지원금</th><td>${money(p.launchAid.amount)} 수령${
              owed > 0 ? ` · 상환 잔액 <b>${money(owed)}</b> <span class="muted">(인도마다 계약가의 ${Math.round(E.LAUNCH_AID_ROYALTY * 100)}%)</span>` : ' · <b>상환 완료</b>'
            }</td></tr>`,
          );
        }
        if (p.phase === 'production') {
          rows.push(`<tr><th>생산 / 인도</th><td>${num(p.produced)}기 / ${num(p.delivered)}기</td></tr>`);
          rows.push(`<tr><th>현재 대당 원가</th><td>${money(E.currentUnitCost(s, p))} <span class="muted">(학습곡선·조달)</span></td></tr>`);
          rows.push(`<tr><th>미인도 재고</th><td>${p.stock}기</td></tr>`);
        }

        let control = '';
        if (p.phase === 'dev') {
          control = `
            <div class="devctl">
              ${bar(p.progress, 'prog')}
              <div class="row between">
                <span>진행 ${p.progress.toFixed(1)}%</span>
                <span class="${eta === Infinity ? 'bad' : ''}">완료까지 ${eta === Infinity ? '동결됨' : eta + '분기'}</span>
              </div>
              <label class="slider">
                <span>인력 배분<b id="lbl-share-${p.id}">${p.share}%${p.share <= 0 ? ' (동결)' : ''}</b></span>
                <input type="range" data-action="share" data-id="${p.id}" min="0" max="100" step="5" value="${p.share}">
              </label>
              <p class="hint">배분 0%는 동결 — 진행도와 개발비 지출이 모두 멈춘다. 필요 인력 ${num(p.engineersNeeded)}명.</p>
              <div class="row">
                <button data-action="quality" data-id="${p.id}" ${p.qualityInvests >= 3 ? 'disabled' : ''}>
                  품질 강화 (${p.qualityInvests}/3) · ${money(p.devCost * CONFIG.qualityInvestRate)}
                </button>
                <button data-action="wind-tunnel" data-id="${p.id}" ${p.windTunnel || p.progress >= 50 ? 'disabled' : ''}>
                  풍동·목업 ${p.windTunnel ? '완료 (±8%)' : p.progress >= 50 ? '시기 지남' : `· ${money(p.devCost * E.WIND_TUNNEL_COST_RATE)}`}
                </button>
                <button data-action="launch-aid" data-id="${p.id}" ${p.launchAid || p.progress >= 50 ? 'disabled' : ''}>
                  정부 지원 ${p.launchAid ? '수령함' : p.progress >= 50 ? '시기 지남' : `+${money(p.devCost * E.launchAidRate(s))}${((s.trait || {}).aid || {}).tensionMult === 0 ? '' : ' · 긴장↑'}`}
                </button>
                <button class="danger" data-action="cancel-prog" data-id="${p.id}">개발 중단</button>
              </div>
            </div>`;
        } else if (p.phase === 'cert') {
          // 중단 버튼이 없으면 인증 프로그램 3개가 슬롯을 물고 신규 착수가 영영 막힌다.
          const need = p.testHoursNeeded || 0;
          const flown = Math.min(need, p.testHours || 0);
          const left = E.certQuartersLeft(p);
          const nextCost = E.testAircraftCost(s, p);
          const maxed = (p.testFleet || 0) >= 6;
          control = `<div class="devctl">
            <p class="cert">시험비행 <b>${num(flown)} / ${num(need)}시간</b> — 시험기 ${p.testFleet || 0}대로 남은 ${isFinite(left) ? left + '분기' : '—'}</p>
            ${bar(need > 0 ? (flown / need) * 100 : 0)}
            ${p.findings ? `<p class="hint">심사 지적 ${p.findings}건 — 재시험이 얹혔다.</p>` : ''}
            <div class="row">
              <button data-action="test-aircraft" data-id="${p.id}" ${maxed ? 'disabled' : ''}>
                시험기 추가 (${p.testFleet || 0}/6) · ${money(nextCost)}
              </button>
              <button data-action="quality" data-id="${p.id}" ${p.qualityInvests >= 3 ? 'disabled' : ''}>품질 강화 (${p.qualityInvests}/3) · ${money(p.devCost * CONFIG.qualityInvestRate)}</button>
              ${
                p.etops
                  ? `<button data-action="early-etops" data-id="${p.id}" ${p.etopsEarly ? 'disabled' : ''}>
                      ${p.etopsEarly ? '조기 ETOPS 진행 중' : `조기 ETOPS · ${money(p.devCost * 0.05)}`}
                    </button>`
                  : ''
              }
              ${foreignCertControl(s, p)}
              <button class="danger" data-action="cancel-prog" data-id="${p.id}">개발 중단</button>
            </div>
            ${
              p.etops && !p.etopsEarly
                ? '<p class="hint">ETOPS 는 취항만으로 나오지 않는다 — <b>운항 실적 4분기</b>를 채우거나, 지금 조기 취득을 사서 취항과 동시에 대양 노선에 들어가라.</p>'
                : ''
            }
            ${foreignCertHint(s, p)}
            <p class="hint">시험기를 늘리면 취항이 빨라진다. 대신 개발 막바지 — 현금이 가장 마른 시점 — 에 돈이 먼저 나간다. 인증 후에는 개수해 제작비의 40%를 회수한다.</p>
          </div>`;
        } else if (p.phase === 'production') {
          const ordered = orderedBy(s, p.id);
          const lines = s.lines.filter((l) => l.programId === p.id).length;
          const certBtn = foreignCertControl(s, p);
          control = `<div class="devctl">
            <p>수주 잔고 <b>${ordered}기</b> · 전용 라인 <b>${lines}개</b></p>
            ${ordered > 0 && lines === 0 ? '<p class="warn-box">라인이 없어 인도할 수 없다. 생산 탭에서 라인을 세워라.</p>' : ''}
            ${certBtn ? `<div class="row">${certBtn}</div>${foreignCertHint(s, p)}` : ''}
          </div>`;
        }

        // 제원 열두 줄은 착수할 때 정한 값이라 매 분기 볼 것이 아니다. 손대는 것은
        // 아래 조작 블록(인력 배분·시험기·개량)이므로 그쪽을 화면에 먼저 올린다.
        const specLine = `${SEGMENTS[p.segment].name} · ${p.seats}석 · ${num(p.range)}km`;
        return `<div class="card program ${p.phase}">
          <div class="row between">
            <h3>${esc(p.name)} ${p.legacy ? '<span class="tag">노후 주력기</span>' : ''} ${p.derivative ? '<span class="tag">파생형</span>' : ''}</h3>
            <span class="phase ${p.phase}">${phaseLabel(p)}</span>
          </div>
          ${control}
          <details class="fold"${foldOpen(folds, 'prog-' + p.id, false) ? ' open' : ''}>
            <summary data-fold="prog-${p.id}"><b>제원</b><span class="fold-val">${specLine}</span></summary>
            <table class="spec">${rows.join('')}</table>
          </details>
        </div>`;
      })
      .join('');
  }

  // ─────────────────────────────── 생산 ───────────────────────────────

  /**
   * 같은 급·같은 동체 단면이라야 치구를 재활용할 수 있다 — 패밀리가 생산에서도
   * 값을 하는 지점. 판정은 엔진의 공유 함수를 그대로 쓴다. 화면이 따로 판정하면
   * 눌러도 거절당하는 버튼이 뜨거나(느슨하면) 되는 전환이 가려진다(빡빡하면).
   */
  function retoolTargets(s, line, from) {
    const targets = s.programs.filter(
      (t) => t.phase === 'production' && t.id !== line.programId && E.retoolCompatibility(from, t).ok,
    );
    if (!targets.length) return '';
    const grade = LINE_GRADES[line.grade] || LINE_GRADES.standard;
    const btns = targets
      .map((t) => {
        const cost = Math.round(SEGMENTS[t.segment].lineCost * grade.costMult * RETOOL_COST_RATE);
        return `<button data-action="retool-line" data-id="${line.id}" data-target="${t.id}" ${
          s.cash >= cost ? '' : 'disabled'
        }>${esc(t.name)}로 전환 · ${money(cost)}</button>`;
      })
      .join('');
    return `<div class="row">${btns}</div>`;
  }

  /**
   * UEC 국산화 카드 — 엔진 자회사가 있는 회사(UAC)에만 나온다.
   *
   * 진행 중이면 자금·기간 두 막대를 나란히 보여 준다. 하나만 보여 주면
   * "돈을 다 넣었는데 왜 안 끝나느냐"가 된다 — 둘 다 채워야 한다는 것이
   * 이 사업의 규칙이므로, 화면도 둘을 나란히 놓아야 한다.
   */
  function localEngineCard(s, folds) {
    const spec = E.localEngineSpec(s);
    if (!spec) return '';
    const proj = s.localEngineProject;

    if (proj) {
      const from = Engines.get(proj.target);
      const to = Engines.get(proj.engine);
      const need = proj.minQuarters ?? spec.minQuarters;
      const moneyPct = proj.cost > 0 ? (proj.funded / proj.cost) * 100 : 100;
      const timePct = need > 0 ? (proj.quarters / need) * 100 : 100;
      const left = Math.max(0, proj.cost - proj.funded);
      // 지금 낼 수 있는 만큼을 **항상** 하나 넣는다. 정액 단위(25%·50%)만 두면
      // 곳간이 그 아래인 플레이어는 버튼이 전부 잠긴 채, 엔진은 받아 주는
      // 금액을 화면으로는 넣을 방법이 없다 — 착수는 공짜라 그 상태가 흔하다.
      const affordable = Math.min(Math.floor(s.cash), left);
      const steps = [left, Math.round(proj.cost * 0.5), Math.round(proj.cost * 0.25), affordable]
        .filter((v, i, a) => v > 0 && a.indexOf(v) === i && v <= left)
        .sort((a, b) => a - b)
        .filter((v) => v <= s.cash)
        .slice(0, 3)
        .map((v) => `<button data-action="fund-local-engine" data-amount="${v}">+${money(v)}</button>`)
        .join('');
      return foldCard(
        folds,
        'prod-uec',
        `${esc(spec.maker)} 국산화`,
        `${esc(to ? to.name : proj.engine)} · ${Math.round(Math.min(moneyPct, timePct))}%`,
        `<p class="muted">${esc(from ? from.name : proj.target)} 자리에 <b>${esc(to ? to.name : proj.engine)}</b> 를 넣는다.
           ${proj.refit ? '엔진은 이미 우리 것이라 재장착 인증만 하면 된다.' : '자금과 기간을 <b>둘 다</b> 채워야 나온다.'}</p>
         <div class="row between"><span>개발비</span><span>${money(proj.funded)} / ${money(proj.cost)}</span></div>
         ${bar(moneyPct, 'prog')}
         <div class="row between"><span>기간</span><span>${proj.quarters} / ${need}분기</span></div>
         ${bar(timePct, 'ramp')}
         <div class="row">${
           steps ||
           (left <= 0
             ? '<span class="muted">개발비는 다 채웠다 — 남은 것은 기간이다.</span>'
             : '<span class="muted">지금은 넣을 현금이 없다. 한 푼이라도 생기면 그만큼 넣을 수 있다.</span>')
         }</div>
         <div class="row"><button class="danger" data-action="cancel-local-engine">개발 중단</button></div>`,
      );
    }

    const targets = E.localEngineTargets(s);
    const body = targets.length
      ? `<p class="muted">우리가 쓰고 있는 서방 엔진을 자회사 ${esc(spec.maker)} 것으로 갈아 끼운다.
           완성되면 <b>그 엔진을 달고 있던 우리 기종 전부</b>가 자동으로 바뀐다 —
           생산원가가 내려가고 공급 차질을 비켜 가며, 국가 발주 단가도 ${Math.round((spec.stateBonus || 0) * 100)}%p 더 받는다.
           대신 <b>초기 결함 위험이 오르고, 대개 연비가 처진다</b> — 그만큼 수주전에서 점수를 상시로 잃는다.
           <b>원가를 사고 수주 경쟁력을 파는 거래</b>다 — 곳간이 급한 회사의 수다.
           각 후보의 실제 증감은 아래에 숫자로 적혀 있다(낡은 서방 엔진을 쓰고 있었다면 연비가 오히려 오르기도 한다).</p>
         ${targets
           .map((t) => {
             const to = Engines.get(t.replacement);
             const cost = E.localEngineCost(s, t);
             const q = E.localEngineQuarters(s, t);
             const dEff = to.eff - t.engine.eff;
             const dCost = Math.round((to.costMult / t.engine.costMult - 1) * 100);
             // 착수 자체는 돈이 안 든다 — 자금은 뒤에서 채워 넣는다. 임의의 현금
             // 문턱으로 버튼을 잠그면 화면은 막는데 엔진은 허용하는, 서로 다른
             // 규칙 두 개가 생긴다.
             return `<button class="mat" data-action="start-local-engine" data-engine="${t.engine.id}">
                 <b>${esc(t.engine.name)} → ${esc(to.name)}</b>
                 <span>${money(cost)} · 최소 ${q}분기${t.refit ? ' <b>(재장착 — 엔진은 이미 우리 것)</b>' : ''}</span>
                 <span class="muted">대상: ${esc(t.programs.map((x) => x.name).join(' · '))}</span>
                 <span><span class="${dCost < 0 ? 'good' : 'bad'}">생산원가 ${dCost > 0 ? '+' : ''}${dCost}%</span> · <span class="${
                   dEff > 0 ? 'good' : dEff < 0 ? 'bad' : 'muted'
                 }">연비 ${dEff > 0 ? '+' : ''}${dEff}</span></span>
               </button>`;
           })
           .join('')}`
      : '<p class="muted">지금 국산화를 걸 서방 엔진이 없다. 서방 엔진을 단 기종이 있어야 대체할 것이 생긴다.</p>';

    return foldCard(folds, 'prod-uec', `${esc(spec.maker)} 국산화`, targets.length ? `후보 ${targets.length}종` : '', body);
  }

  function renderProduction(s, folds) {
    const ready = s.programs.filter((p) => p.phase === 'production');
    // 국산화는 개발 중 기종에도 걸 수 있어 양산 기종이 없어도 보여야 한다.
    if (!ready.length) {
      return `${localEngineCard(s, folds)}<div class="card"><p class="muted">양산 가능한 기종이 없다.</p></div>`;
    }

    const buildButtons = ready
      .map((p) => {
        const seg = SEGMENTS[p.segment];
        const grades = Object.values(LINE_GRADES)
          .map((g) => {
            const cost = Math.round(seg.lineCost * g.costMult);
            const rate = Math.round(seg.lineMaxRate * g.rateMult);
            return `<button data-action="build-line" data-id="${p.id}" data-grade="${g.id}" ${s.cash >= cost ? '' : 'disabled'}>
                ${esc(g.name)} · ${money(cost)} · 분기 ${rate}기 · 램프 ×${g.rampMult}
              </button>`;
          })
          .join('');
        return `<div class="line"><b>${esc(p.name)}</b><div class="row">${grades}</div></div>`;
      })
      .join('');

    const sourcing = OUTSOURCING[s.outsourcing] || OUTSOURCING.mid;
    const sourcingButtons = Object.values(OUTSOURCING)
      .map(
        (o) =>
          `<button class="mat ${o.id === sourcing.id ? 'on' : ''}" data-action="set-outsourcing" data-level="${o.id}">
             <b>${esc(o.name)}</b><span>단가 ×${o.costMult.toFixed(2)} · 공급 차질 ×${o.supplyRisk}</span>
           </button>`,
      )
      .join('');

    const lines = s.lines.length
      ? s.lines
          .map((l) => {
            const p = s.programs.find((x) => x.id === l.programId);
            const ordered = orderedBy(s, l.programId);
            return `<div class="line ${l.idle ? 'idle' : ''}">
              <div class="row between">
                <b>${esc(p ? p.name : '?')}</b>
                <span class="${l.idle ? 'bad' : 'good'}">${l.idle ? '가동 중지' : '가동 중'}</span>
              </div>
              <div class="row between"><span>가동률</span><span>${Math.round(l.ramp * 100)}%</span></div>
              ${bar(l.ramp * 100, 'ramp')}
              <p class="muted">${esc((LINE_GRADES[l.grade] || LINE_GRADES.standard).name)} · 분기 최대 ${l.capacity}기 · 이 기종 잔고 ${ordered}기</p>
              ${retoolTargets(s, l, p)}
              <div class="row">
                <button data-action="toggle-line" data-id="${l.id}">${l.idle ? '가동 재개' : '가동 중지'}</button>
                <button class="danger" data-action="close-line" data-id="${l.id}">폐쇄</button>
              </div>
            </div>`;
          })
          .join('')
      : '<p class="muted">가동 중인 라인이 없다.</p>';

    const stocks = ready
      .filter((p) => p.stock > 0)
      .map((p) => {
        const grounded = (s.effects.grounded && s.effects.grounded[p.id]) || 0;
        return `<div class="row between stockrow">
          <span><b>${esc(p.name)}</b> 미인도 재고 ${p.stock}기${grounded ? ` <span class="bad">· 운항 정지 ${grounded}분기</span>` : ''}</span>
          <button data-action="sell-stock" data-id="${p.id}" ${grounded ? 'disabled' : ''}>
            ${grounded ? '정지 중 처분 불가' : `정가 68%로 처분 · ${money(p.stock * p.listPrice * 0.68)}`}
          </button>
        </div>`;
      })
      .join('');

    const upgradeRows = ready
      .map((p) => {
        const btns = Object.entries(E.UPGRADES)
          .map(([kind, u]) => {
            const st = p.upgrades && p.upgrades[kind];
            if (st && st.applied) return `<span class="tag good">${esc(u.name)} 완료</span>`;
            if (st) {
              // doneTurn 분기가 오면 이미 applied 라 이 분기엔 항상 left ≥ 1 이다.
              const left = Math.max(1, st.doneTurn - s.turn);
              return `<span class="tag">${esc(u.name)} 진행 중 · ${left}분기 남음</span>`;
            }
            const cost = Math.round(p.devCost * u.costRate);
            return `<button data-action="upgrade" data-id="${p.id}" data-kind="${kind}" ${s.cash >= cost ? '' : 'disabled'}
                title="${esc(u.desc)}">${esc(u.name)} · ${money(cost)}</button>`;
          })
          .join('');
        return `<div class="line"><div class="row between"><b>${esc(p.name)}</b>
            <span class="muted">연비 ${p.efficiency} · 객실 ${p.comfort} · 인도 ${p.delivered || 0}기</span></div>
          <div class="row">${btns}</div></div>`;
      })
      .join('');

    // 라인 상태와 재고는 매 분기 보는 것이라 펼쳐 두고, 한 번 정하면 오래 가는
    // 설정(조달·신설·개량·서비스)은 접는다.
    return `
      ${servicesCard(s, folds)}
      ${researchCard(s, folds)}
      ${localEngineCard(s, folds)}
      ${foldCard(
        folds,
        'prod-sourcing',
        '조달 전략',
        esc(sourcing.name),
        `<p class="muted">외주를 늘리면 단가가 내려가지만 공급망 사고가 길어진다. 787이 실제로 치른 대가다.</p>
         <div class="mats">${sourcingButtons}</div>`,
      )}
      ${foldCard(
        folds,
        'prod-newline',
        '라인 신설',
        `${s.lines.length}개 가동 중`,
        `<p class="muted">라인은 주문 잔고 범위 안에서만 생산한다. 주문이 없으면 가동률이 서서히 떨어진다.
           재래식은 싸고 빨리 안정되지만 물량이 적고, 고속 자동화는 반대다 — 수요가 확실한 기종에만 값을 한다.</p>
         ${buildButtons}`,
      )}
      ${foldCard(
        folds,
        'prod-upgrades',
        '기체 개량',
        '',
        `<p class="muted">기체는 취항으로 끝나지 않는다 — PIP·윙렛·객실 리프레시가 몇 분기 뒤 신규 생산분과
           <b>이미 인도된 선단</b>에 함께 적용된다. 기존 운용사는 개조 키트를 사 가고(인도 1기당 정가의 1.2%),
           자기 기체가 낡게 방치되지 않는다는 신호에 신뢰가 오른다. 선단이 클수록 개량이 값을 한다.</p>
         ${upgradeRows}`,
      )}
      <section class="card"><h3>조립 라인</h3><div class="lines">${lines}</div></section>
      ${stocks ? `<section class="card"><h3>미인도 재고 (화이트테일)</h3><p class="muted">주문 취소 등으로 남은 기체. 오래 쥐고 있으면 유지비가 나간다.</p>${stocks}</section>` : ''}`;
  }

  /**
   * 장기 기술 연구 — 스컹크웍스. 분기마다 돈을 태워 몇 년 뒤 회사 상수를 바꾼다.
   * 효과는 완료 이후의 신규 설계·생산에만 붙는다.
   */
  function researchCard(s, folds) {
    const R = root.AirlinerData.RESEARCH_PROJECTS;
    const research = s.research || { active: null, progress: {}, done: {} };
    const rows = R.map((proj) => {
      const done = research.done[proj.id];
      const active = research.active === proj.id;
      const prog = research.progress[proj.id] || 0;
      if (done) return `<div class="line"><div class="row between"><b>${esc(proj.name)}</b><span class="tag good">완료 — ${esc(proj.effect)}</span></div></div>`;
      const status = active
        ? `<span class="tag">${prog}/${proj.quarters}분기 진행 중 · 분기 ${money(proj.costPerQuarter)}</span>
           <button data-action="research-stop">중단</button>`
        : `<button data-action="research-start" data-id="${proj.id}" ${research.active ? 'disabled' : ''}>
             착수 · 분기 ${money(proj.costPerQuarter)} × ${proj.quarters - prog}분기</button>`;
      return `<div class="line"><div class="row between"><b>${esc(proj.name)}</b>${prog > 0 && !active ? `<span class="muted">진행 ${prog}/${proj.quarters}</span>` : ''}</div>
        <p class="hint">${esc(proj.desc)} <b>${esc(proj.effect)}.</b></p>
        <div class="row">${status}</div></div>`;
    }).join('');
    // 연구소는 하나뿐이라 화면에서 매번 확인할 것은 "지금 무엇이 돌고 있나" 하나다.
    // 그 한 줄을 제목에 올리고 프로젝트 목록은 접는다.
    const running = research.active ? R.find((x) => x.id === research.active) : null;
    const doneCount = Object.keys(research.done || {}).length;
    const head = running
      ? `${esc(running.name)} ${research.progress[running.id] || 0}/${running.quarters}분기`
      : doneCount
        ? `${doneCount}건 완료 · 진행 중 없음`
        : '<span class="muted">진행 중 없음</span>';

    return foldCard(
      folds,
      'prod-research',
      '장기 기술 연구',
      head,
      `<p class="muted">연구소는 하나다 — 한 번에 한 프로젝트. 완료된 연구는 <b>그 이후의 신규 설계·생산</b>에 영구히 적용된다.
         이미 나는 기체는 소급되지 않는다. 중단하면 진행분은 남는다.</p>
       ${rows}`,
    );
  }

  /**
   * 서비스 사업 — 부품·정비와 화물형.
   * 신규 인도만이 매출이면 개발 공백기에 경영할 거리가 없다. 이미 팔아 둔 기체가
   * 얼마를 벌어다 주는지 여기서 보인다.
   */
  function servicesCard(s, folds) {
    const inc = E.serviceIncome(s);
    const order = ['none', 'regional', 'global'];
    const curIdx = order.indexOf(s.aftermarket);

    const tiers = order
      .map((id, i) => {
        const t = AFTERMARKET_TIERS[id];
        const owned = i <= curIdx;
        const cost = t.cost - (AFTERMARKET_TIERS[s.aftermarket] || AFTERMARKET_TIERS.none).cost;
        return `<button class="mat ${owned ? 'on' : ''}" data-action="aftermarket" data-tier="${id}"
                  ${owned || i !== curIdx + 1 ? 'disabled' : ''}>
                  <b>${esc(t.name)}</b>
                  <span>${owned ? '보유' : `${money(cost)} · 수익 ×${t.mult}`}</span>
                  <span class="muted">${esc(t.hint)}</span>
                </button>`;
      })
      .join('');

    const freighters = s.programs.filter((p) => p.phase === 'production');
    const freightButtons = freighters.length
      ? freighters
          .map((p) => {
            if (p.freighter) return `<span class="tag good">${esc(p.name)} 화물형 운영 중</span>`;
            if (p.freighterAt !== undefined) return `<span class="tag">${esc(p.name)} 개조 준비 중</span>`;
            return `<button data-action="freighter" data-id="${p.id}">${esc(p.name)} 화물형 개조 · ${money(p.devCost * FREIGHTER.devRate)}</button>`;
          })
          .join('')
      : '<span class="muted">양산 중인 기종이 없다.</span>';

    return foldCard(
      folds,
      'prod-services',
      '서비스 사업',
      `이번 분기 ${money(inc.total)}`,
      `
        <p class="muted">이미 팔아 둔 기체가 벌어다 주는 돈이다. 선단 ${num(inc.fleet)}기 기준 이번 분기 <b>${money(inc.total)}</b>
          <span class="muted">(부품·정비 ${money(inc.aftermarket)}${inc.freight ? ` · 화물 ${money(inc.freight)}` : ''}${inc.gov ? ` · 정부 지원 ${money(inc.gov)}` : ''})</span></p>
        <div class="mats">${tiers}</div>
        <h3 class="sub">화물형 개조</h3>
        <p class="hint">여객 수요가 꺾여도 화물은 돈다. 침체 분기에는 화물 수익이 ${FREIGHTER.slumpMult}배가 된다 — 불황 헤지다.</p>
        <div class="row wrap">${freightButtons}</div>
        <h3 class="sub">엔진 공급사</h3>
        ${engineRelationRows(s)}`,
    );
  }

  /** 공급사별 인도 실적과 계약 상태 — 독점 계약·런칭 파트너 제안의 배경 정보다. */
  function engineRelationRows(s) {
    const entries = Object.entries(s.engineRelations || {}).sort((a, b) => b[1] - a[1]);
    const deal = s.engineDeal && s.turn < s.engineDeal.until ? s.engineDeal : null;
    const early = Object.keys(s.engineEarlyAccess || {})
      .map((id) => (Engines.get(id) || {}).name)
      .filter(Boolean);
    const rows = entries.length
      ? entries
          .map(
            ([maker, units]) =>
              `<span class="tag ${deal && deal.maker === maker ? 'good' : ''}">${esc(maker)} ${num(units)}기${
                deal && deal.maker === maker ? ` · 독점 계약 ~${E.yearOf(deal.until)}년` : ''
              }</span>`,
          )
          .join('')
      : '<span class="muted">아직 인도 실적이 없다.</span>';
    const tension = s.tradeTension || 0;
    const tariff = (s.effects && s.effects.tradeTariffQuarters) || 0;
    return `
      <p class="hint">엔진 인도 실적이 쌓이면 독점 계약·신엔진 런칭 파트너 제안이 온다. 몰아주면 협상력이, 나눠 주면 공급 차질 내성이 생긴다.</p>
      <div class="row wrap">${rows}</div>
      ${
        tariff > 0
          ? `<p class="hint warn">보복 관세 발효 중 — ${tariff}분기 동안 북미·서유럽 인도에 ${Math.round(E.TRADE_TARIFF_RATE * 100)}% 관세.</p>`
          : tension >= 4
            ? `<p class="hint warn">무역 긴장 ${tension} — 정부 지원금의 청구서(WTO 판정)가 가까워지고 있다.</p>`
            : tension > 0
              ? `<p class="hint">무역 긴장 ${tension} <span class="muted">(정부 지원을 받을수록 쌓인다)</span></p>`
              : ''
      }`;
  }

  // ─────────────────────────────── 수주 ───────────────────────────────

  function renderRfps(s, discountDraft, folds) {
    if (!s.rfps.length) return '<div class="card"><p class="muted">이번 분기에는 새 입찰 공고가 없다.</p></div>';

    return s.rfps
      .map((rfp) => {
        const bid = s.bids[rfp.id];
        const candidates = s.programs.filter((p) => (p.phase === 'production' || p.phase === 'cert' || (p.phase === 'dev' && p.progress >= 40)) && p.segment === rfp.segment);
        const discount = bid ? bid.discount : (discountDraft && discountDraft[rfp.id]) ?? 0.1;
        const scored = candidates.map((p) => ({ p, sc: B.scoreBid(s, rfp, p, discount, bid && bid.terms) }));
        const anyBiddable = scored.some((x) => !x.sc.blocked);

        const options = renderBidCandidates(s, rfp, discount);

        const airline = AIRLINES.find((a) => a.id === rfp.airlineId);
        const tier = E.loyaltyTier ? E.loyaltyTier(s, rfp.airlineId) : 0;
        const tierBadge = tier === 2 ? ' <span class="tag good">핵심 고객</span>' : tier === 1 ? ' <span class="tag">단골</span>' : '';

        // 한 공고의 배경 설명만 12행이다. 좁은 화면에서 그걸 다 펼쳐 두면 공고 세 건에
        // 스크롤이 몇 화면씩 되고, 정작 손대야 할 후보·할인율이 화면 밖으로 밀린다.
        // 판단에 곧바로 쓰는 값만 칩으로 남기고 배경은 접는다 (펼침 상태는 ui.js 가 기억한다).
        const open = folds && folds.has(rfp.id);
        const chips = [
          `${rfp.segmentName} · ${rfp.reqSeats}석 · ${num(rfp.reqRange)}km`,
          `가격 민감도 ${rfp.priceSensitivity >= 1.2 ? '매우 높음' : rfp.priceSensitivity >= 1.0 ? '높음' : rfp.priceSensitivity >= 0.8 ? '보통' : '낮음'}`,
          `경쟁 ${rfp.rivalHint.label}`,
          `관계 ${Math.round(s.relations[rfp.airlineId] ?? 40)}`,
        ];
        if (rfp.reqEtops) chips.push('<b class="warn">ETOPS 필수</b>');
        if (rfp.reqField) chips.push(`<b class="warn">${rfp.fieldKind === 'short' ? '짧은 활주로' : '고온고지'}</b>`);
        if (bid) chips.push('<b class="good">응찰 중</b>');

        return `<div class="card rfp">
          <div class="row between">
            <h3>${esc(rfp.airlineName)} <span class="muted">${esc(rfp.home)}</span>${tierBadge}</h3>
            <span class="qty">${rfp.qty}기</span>
          </div>
          <div class="chips">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div>
          <details class="fold"${open ? ' open' : ''}>
          <summary data-fold="${rfp.id}">공고 배경 · 요구 조건</summary>
          <table class="spec">
            ${airline && airline.doctrine ? `<tr><th>구매 독트린</th><td><b>${esc(airline.doctrine)}</b> — ${esc(airline.doctrineNote || '')}</td></tr>` : ''}
            ${airline && airline.enginePref ? `<tr><th>선호 엔진</th><td>${esc(airline.enginePref)} <span class="muted">— 맞추면 +2 · 낯선 공급사는 −1 · 이중화는 어느 쪽이든 맞고 감점을 면한다</span></td></tr>` : ''}
            <tr><th>요구 기종</th><td>${rfp.segmentName} · ${rfp.reqSeats}석급 · ${num(rfp.reqRange)}km</td></tr>
            <tr><th>발주 배경</th><td>${
              rfp.deferredQuarters
                ? `<b class="warn">미뤄 둔 교체 ${rfp.deferredQuarters}분기치</b> — 불황에 묶였던 물량이 한꺼번에 나왔다`
                : '노후기 교체 · 노선 확장'
            }</td></tr>
            <tr><th>노선 성격</th><td>${esc(rfp.route || '—')}${
              rfp.reqField ? ` · <b class="warn">${rfp.fieldKind === 'short' ? '짧은 활주로' : '고온고지'} (이착륙 ${rfp.reqField} 이상)</b>` : ''
            }${rfp.reqEtops ? ' · <b class="warn">ETOPS 필수</b>' : ''}</td></tr>
            <tr><th>가격 민감도</th><td>${rfp.priceSensitivity >= 1.2 ? '매우 높음' : rfp.priceSensitivity >= 1.0 ? '높음' : rfp.priceSensitivity >= 0.8 ? '보통' : '낮음 (프리미엄 중시)'}</td></tr>
            <tr><th>경쟁 강도</th><td>${rfp.rivalHint.label}</td></tr>
            <tr><th>맞붙을 기종</th><td>${esc(rfp.rivalHint.rival || '—')}</td></tr>
            <tr><th>우리와의 관계</th><td>${Math.round(s.relations[rfp.airlineId] ?? 40)} / 100</td></tr>
            <tr><th>보유 우리 기체</th><td>${fleetSummary(s, rfp.airlineId)}</td></tr>
          </table>
          </details>
          ${
            !candidates.length
              ? '<p class="muted">이 세그먼트에 응찰 가능한 기종이 없다. <b>개발 40%</b>부터는 선주문으로 응찰할 수 있다 — 미인증 감점을 받지만 선수금이 개발을 먹인다.</p>'
              : !anyBiddable
                ? `<div class="cands" id="cands-${rfp.id}">${options}</div>
                   <p class="warn-box">보유 기종 중 이 공고의 요구를 만족하는 기체가 없다. 후속기 개발이 급하다.</p>`
                : `<div class="cands" id="cands-${rfp.id}">${options}</div>
                   <label class="slider">
                     <span>할인율<b id="disc-label-${rfp.id}">${Math.round(discount * 100)}%</b></span>
                     <input type="range" data-action="discount" data-rfp="${rfp.id}" min="0" max="${CONFIG.maxDiscount * 100}" step="1" value="${Math.round(discount * 100)}">
                   </label>
                   ${bidTerms(s, rfp)}
                   <div id="bidinfo-${rfp.id}">${renderBidInfo(s, rfp)}</div>`
          }
        </div>`;
      })
      .join('');
  }

  /** 후보 기종 버튼 — 표시 점수·가격이 현재 할인율을 반영해야 한다. */
  function renderBidCandidates(s, rfp, discount) {
    const bid = s.bids[rfp.id];
    return s.programs
      .filter((p) => (p.phase === 'production' || p.phase === 'cert' || (p.phase === 'dev' && p.progress >= 40)) && p.segment === rfp.segment)
      .map((p) => {
        const sc = B.scoreBid(s, rfp, p, discount, bid && bid.terms);
        const sel = bid && bid.programId === p.id;
        return `<button class="cand ${sel ? 'on' : ''} ${sc.blocked ? 'blocked' : ''}"
                  data-action="pick-bid" data-rfp="${rfp.id}" data-id="${p.id}" ${sc.blocked ? 'disabled' : ''}>
                  <b>${esc(p.name)}${sc.preorder ? ' <i class="warn">선주문</i>' : ''}</b>
                  <span>${sc.blocked ? sc.blocked : `점수 ${sc.total} · 대당 ${money(sc.price)}${sc.preorder ? ' · 미인증 감점 반영' : ''}`}</span>
                </button>`;
      })
      .join('');
  }

  /** 선택한 기종 + 할인율에 대한 입찰 요약 — 슬라이더 조작 시 이 영역만 갱신한다. */
  /**
   * 입찰 조건 — 인도 약속과 금융. 기종을 고르기 전에는 잠가 둔다(응찰이 없으면
   * 조건도 없다). 각 조건의 대가를 버튼에 그대로 적는다 — 가산점만 보이면
   * 언제나 최우선 인도가 정답이 된다.
   */
  function bidTerms(s, rfp) {
    const bid = s.bids[rfp.id];
    const t = B.normalizeTerms(bid && bid.terms);
    const group = (kind, table, current) =>
      Object.values(table)
        .map(
          (o) => `<button class="term ${current === o.id ? 'on' : ''}" data-action="bid-term"
                    data-rfp="${rfp.id}" data-kind="${kind}" data-value="${o.id}" ${bid ? '' : 'disabled'}>
                    <b>${esc(o.name)}${o.bonus ? ` <i class="${o.bonus > 0 ? 'good' : 'bad'}">${o.bonus > 0 ? '+' : ''}${o.bonus}점</i>` : ''}</b>
                    <span class="muted">${esc(o.hint)}</span>
                  </button>`,
        )
        .join('');

    return `<div class="terms">
        <div class="term-group">
          <span class="term-label">인도 약속</span>
          <div class="term-row">${group('pledge', BID_PLEDGES, t.pledge)}</div>
        </div>
        <div class="term-group">
          <span class="term-label">금융 조건</span>
          <div class="term-row">${group('financing', BID_FINANCING, t.financing)}</div>
        </div>
        ${bid ? '' : '<p class="hint">기종을 먼저 고르면 조건을 걸 수 있다.</p>'}
      </div>`;
  }

  function renderBidInfo(s, rfp) {
    const bid = s.bids[rfp.id];
    if (!bid) return '<p class="muted">입찰할 기종을 선택하라. 선택하지 않으면 이번 공고는 포기한다.</p>';
    const p = s.programs.find((x) => x.id === bid.programId);
    if (!p) return '';
    const sc = B.scoreBid(s, rfp, p, bid.discount, bid.terms);
    if (sc.blocked) return `<p class="warn-box">${sc.blocked} — 이 기종으로는 입찰할 수 없다.</p>`;

    const unitCost = E.currentUnitCost(s, p);
    const margin = sc.price - unitCost;
    const total = sc.price * rfp.qty;
    const pledge = BID_PLEDGES[sc.terms.pledge];
    const financing = BID_FINANCING[sc.terms.financing];
    const deposit = total * CONFIG.depositRate * financing.depositMult;
    // 약속을 지키려면 분기당 몇 기를 넘겨야 하나 — 라인 여력과 바로 비교된다.
    // 명목 최대치가 아니라 **지금 실제로 뽑히는 양**을 쓴다. 램프업 15%짜리 새 라인을
    // 만개로 보여 주면 지킬 수 없는 약속에 초록불을 켜 주는 셈이다. 이미 다른 주문이
    // 잡아먹고 있는 몫도 빼야 남는 여력이 된다.
    const perQuarter = Math.ceil(rfp.qty / pledge.dueQuarters);
    const output = E.effectiveOutput(s, p.id);
    const committed = s.backlog
      .filter((o) => o.programId === p.id && o.remaining > 0)
      .reduce((a, o) => a + o.remaining, 0);
    const capacity = Math.max(0, output - Math.min(output, Math.ceil(committed / 4)));

    return `<table class="spec">
        <tr><th>입찰 점수</th><td><b>${sc.total}</b> ${bar(sc.total, 'score')}${
          sc.termBonus ? ` <span class="${sc.termBonus > 0 ? 'good' : 'bad'}">(조건 ${sc.termBonus > 0 ? '+' : ''}${sc.termBonus})</span>` : ''
        }${
          sc.homeBias
            ? ` <span class="${sc.homeBias > 0 ? 'good' : 'bad'}">(${sc.homeBias > 0 ? '본국 +' : '낯선 시장 '}${sc.homeBias})</span>`
            : ''
        }</td></tr>
        <tr><th>대당 가격</th><td>${money(sc.price)} <span class="muted">(정가 ${money(p.listPrice)})</span></td></tr>
        <tr><th>현재 대당 원가</th><td>${money(unitCost)}</td></tr>
        <tr><th>대당 마진</th><td class="${margin >= 0 ? 'good' : 'bad'}">${margin >= 0 ? '+' : ''}${money(margin)}</td></tr>
        <tr><th>전량 수주 시</th><td>${money(total)} <span class="muted">(선수금 ${money(deposit)})</span></td></tr>
        <tr><th>인도 약속</th><td>${esc(pledge.name)}${
          pledge.penaltyRate
            ? ` · <b>${pledge.dueQuarters}분기 안에 ${rfp.qty}기</b> = 분기당 ${perQuarter}기 <span class="${capacity >= perQuarter ? 'good' : 'bad'}">(지금 실제 생산 ${output}기${committed ? ` · 기존 주문 몫을 빼면 ${capacity}기` : ''})</span>`
            : ' <span class="muted">· 기한 약속 없음</span>'
        }</td></tr>
        <tr><th>대금 회수</th><td>${
          financing.quarters
            ? `인도 시 ${Math.round(financing.onDelivery * 100)}%, 나머지는 ${financing.quarters}분기 분할 <span class="muted">(이자 ${(financing.interest * 100).toFixed(0)}%)</span>`
            : '인도 시 잔금 전액'
        }</td></tr>
      </table>
      <div class="parts">
        ${part('제원 적합', sc.parts.spec)}${part('가격', sc.parts.price)}${part('운용 경제성', sc.parts.op)}
        ${part('객실', sc.parts.comfort)}${part('평판', sc.parts.rep)}${part('관계', sc.parts.rel)}
        ${part('선단 공통성', sc.parts.common)}
      </div>
      <div class="row"><button class="ghost" data-action="withdraw" data-rfp="${rfp.id}">입찰 포기</button></div>`;
  }

  function part(label, v) {
    return `<div class="part"><span>${label}</span>${bar(v, 'part')}<b>${v}</b></div>`;
  }

  // ─────────────────────────────── 재무 ───────────────────────────────

  function renderFinance(s, folds) {
    const rating = E.creditRating(s);
    const rows = s.history
      .slice(-16)
      .reverse()
      .map(
        (h) => `<tr>
          <td>${h.label}</td>
          <td>${money(h.revenue)}</td>
          <td>${money(h.cost)}</td>
          <td class="${h.net >= 0 ? 'good' : 'bad'}">${h.net >= 0 ? '+' : ''}${money(h.net)}</td>
          <td>${h.delivered}기</td>
          <td>${money(h.cash)}</td>
          <td>${money(h.debt)}</td>
        </tr>`,
      )
      .join('');

    const room = CONFIG.maxDebt - s.debt;
    return `
      <section class="grid2">
        <div class="card">
          <h3>차입 / 상환</h3>
          <p class="muted">이번 분기 적용 등급 <b>${E.quarterGrade(s)}</b> · 이자율 ${(E.quarterRate(s) * 100).toFixed(2)}%${s.effects.rateBumpQuarters > 0 ? ` <b class="bad">(+${(s.effects.rateBump * 100).toFixed(1)}%p 신용경색)</b>` : ''} · 한도 ${money(CONFIG.maxDebt)} · 여유 ${money(room)}</p>
          <p class="hint">등급은 부채비율과 개발비 차감 전 손익으로 매겨진다. 이자율은 <b>분기 시작 시</b> 고정되므로, 지금 차입해도 이번 분기 청구는 위 등급 기준이다. 현재 잠정 등급은 <b>${rating.grade}</b> — 다음 분기 이자율은 이번 분기의 개발·생산·인도가 모두 끝난 뒤 다시 매겨진다.</p>
          <div class="row wrap">
            <button data-action="borrow" data-amt="1000" ${room <= 0 ? 'disabled' : ''}>${money(Math.min(1000, room))} 차입</button>
            <button data-action="borrow" data-amt="3000" ${room <= 0 ? 'disabled' : ''}>${money(Math.min(3000, room))} 차입</button>
            <button data-action="repay" data-amt="1000" ${s.cash < 1 || s.debt < 1 ? 'disabled' : ''}>${money(Math.min(1000, s.cash, s.debt))} 상환</button>
            <button data-action="repay" data-amt="3000" ${s.cash < 1 || s.debt < 1 ? 'disabled' : ''}>${money(Math.min(3000, s.cash, s.debt))} 상환</button>
          </div>
          <p class="hint">분기 이자 ${money(s.debt * E.quarterRate(s))}</p>
        </div>
        <div class="card">
          <h3>증자 · 회생</h3>
          ${equityBlock(s)}
        </div>
        <div class="card">
          <h3>인력</h3>
          <p class="muted">엔지니어 ${num(s.engineers)}명 · 분기 인건비 ${money(s.engineers * CONFIG.engineerCostPerQuarter)}</p>
          <div class="row wrap">
            <button data-action="hire" data-amt="500">500명 채용 · ${money(500 * CONFIG.engineerHireCost)}</button>
            <button data-action="hire" data-amt="1500">1,500명 채용 · ${money(1500 * CONFIG.engineerHireCost)}</button>
            <button class="danger" data-action="hire" data-amt="-500">500명 감원</button>
          </div>
          <p class="hint">인력이 많을수록 개발이 빨라지지만 분기 인건비가 계속 나간다.</p>
        </div>
      </section>
      <section class="card">
        <h3>분기 실적</h3>
        ${
          s.history.length
            ? C.bars({
                title: '분기 손익',
                height: 110,
                format: (v) => money(v),
                labels: s.history.slice(-24).map((h) => h.label),
                values: s.history.slice(-24).map((h) => h.net),
              }) + '<p class="hint">최근 24분기 손익. 20년 전체 곡선은 <b>추이</b> 탭에 있다.</p>'
            : ''
        }
        ${
          rows
            ? // 곡선이 흐름을 말해 주므로 숫자 표는 접어 둔다 — 스물네 줄이 그대로 스크롤이다.
              `<details class="fold"${foldOpen(folds, 'fin-hist', false) ? ' open' : ''}>
                 <summary data-fold="fin-hist"><b>분기별 숫자</b><span class="fold-val">최근 ${s.history.slice(-24).length}분기</span></summary>
                 <table class="hist"><thead><tr><th>분기</th><th>매출</th><th>비용</th><th>손익</th><th>인도</th><th>현금</th><th>부채</th></tr></thead><tbody>${rows}</tbody></table>
               </details>`
            : '<p class="muted">아직 정산된 분기가 없다.</p>'
        }
      </section>`;
  }

  /**
   * 경쟁 구도 — 세그먼트별 문턱 기종, 제조사별 누적 인도, 수주전 전적.
   * 상대를 "점수 문턱"이 아니라 이름과 전적을 가진 회사로 보여준다.
   */
  function rivalCard(s, folds) {
    const year = E.yearOf(s.turn);
    const segRows = SEGMENT_ORDER.map((seg) => {
      const sg = SEGMENTS[seg];
      const o = B.bestOffering(s, seg, Math.round(sg.seats.ref), Math.round(sg.range.ref));
      const mine = s.programs.filter((p) => p.segment === seg && p.phase === 'production');
      const ours = mine.length ? mine.map((p) => esc(p.name)).join(', ') : '<span class="muted">없음</span>';
      const pool = Fleet.availableTypes(seg, year).filter((t) => !(s.playerMakers || []).includes(t.maker) && !(s.acquiredTypes || {})[t.id]).length;
      return `<tr>
        <th>${sg.name}</th>
        <td>${o ? `<b>${esc(o.name)}</b>` : '—'} <span class="muted">· 판매 중 ${pool}종 · 우리: ${ours}</span></td>
      </tr>`;
    }).join('');

    const TOP = 6;
    const all = E.makerStandings(s);
    const standings = all.slice(0, TOP);
    const bars = C.shareBars(
      standings.map((r) => ({
        name: r.name,
        value: r.delivered,
        text: `${num(r.delivered)}기 · ${(r.share * 100).toFixed(1)}%`,
        highlight: r.us,
      })),
    );

    const duels = E.duelRecords(s).slice(0, 4);
    const duelLine = duels.length
      ? `<ul class="duels">${duels
          .map(
            (d) =>
              `<li><b>${esc(d.name)}</b> <span class="muted">${d.faced}회 맞붙어</span> <span class="good">${d.won}승</span> · <span>${d.split}분할</span> · <span class="bad">${d.lost}패</span>${d.lostQty ? ` <span class="muted">(놓친 물량 ${num(d.lostQty)}기)</span>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '<p class="muted">아직 맞붙은 수주전이 없다.</p>';

    const us = all.find((r) => r.us);
    return foldCard(
      folds,
      'ov-rivals',
      '경쟁 구도',
      us ? `우리 ${(us.share * 100).toFixed(1)}%` : '',
      `<p class="muted">지금 각 시장에서 우리가 이겨야 하는 상대다. 경쟁사는 실제 역사대로 신형을 내놓고 단산한다.</p>
       <table class="spec">${segRows}</table>
       <h3 class="sub">누적 인도 순위${all.length > TOP ? ` <span class="muted">· 상위 ${TOP}개</span>` : ''}</h3>
       ${bars}
       ${all.length > TOP ? '<p class="hint">전체 순위는 <b>추이</b> 탭에 있다.</p>' : ''}
       <h3 class="sub">수주전 전적</h3>
       ${duelLine}`,
    );
  }

  // ─────────────────────────────── 추이 ───────────────────────────────

  /** 마지막 N분기 기록. 전부 그리면 80분기가 한 화면에 눌려 들어가 흐름이 안 보인다. */
  function tail(s, n) {
    return s.history.slice(-n);
  }

  function pick(rows, key) {
    return rows.map((h) => (typeof h[key] === 'number' ? h[key] : null));
  }

  function labelsOf(rows) {
    return rows.map((h) => h.label);
  }

  function renderTrends(s, folds) {
    const rows = tail(s, 80);
    if (!rows.length) {
      return `<section class="card"><h3>경영 추이</h3><p class="muted">아직 정산된 분기가 없다. 분기를 한 번 넘기면 여기에 20년치 곡선이 쌓이기 시작한다.</p></section>`;
    }

    const labels = labelsOf(rows);
    const pct = (v) => (v * 100).toFixed(0) + '%';
    const standings = E.makerStandings(s);
    const shareRows = standings.map((r) => ({
      name: r.name,
      value: r.delivered,
      text: `${num(r.delivered)}기 · ${(r.share * 100).toFixed(1)}%`,
      highlight: r.us,
    }));

    const duels = E.duelRecords(s);
    const duelRows = duels.length
      ? `<table class="spec cols">
          <thead><tr><th>상대</th><th>붙은 횟수</th><th>완승</th><th>분할</th><th>완패</th><th>놓친 물량</th></tr></thead>
          <tbody>${duels
            .map(
              (d) => `<tr>
                <th>${esc(d.name)}</th>
                <td>${d.faced}</td>
                <td class="${d.won ? 'good' : 'muted'}">${d.won}</td>
                <td>${d.split}</td>
                <td class="${d.lost ? 'bad' : 'muted'}">${d.lost}</td>
                <td>${num(d.lostQty)}기</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>`
      : '<p class="muted">아직 경쟁사와 맞붙은 수주전이 없다.</p>';

    return `
      <section class="card">
        <h3>재무 추이</h3>
        <p class="muted">순자산이 곧 성적이다. 현금이 바닥을 기어도 순자산이 우상향이면 개발비가 자산으로 바뀌는 중이고, 둘이 같이 내려가면 사업이 녹고 있는 것이다.</p>
        ${C.line({
          title: '현금·부채·순자산 추이',
          height: 120,
          zero: true,
          format: (v) => money(v),
          labels,
          series: [
            { name: '순자산', values: pick(rows, 'worth'), cls: 'accent', fill: true },
            { name: '현금', values: pick(rows, 'cash'), cls: 'good' },
            { name: '부채', values: pick(rows, 'debt'), cls: 'bad' },
          ],
        })}
        ${legend([
          { name: '순자산', cls: 'accent' },
          { name: '현금', cls: 'good' },
          { name: '부채', cls: 'bad' },
        ])}
      </section>

      <section class="card">
        <h3>분기 손익</h3>
        <p class="muted">개발 중에는 적자가, 양산이 궤도에 오르면 흑자가 정상이다. 적자 구간이 길게 이어지면 그 프로그램이 회수되지 않고 있다는 뜻이다.</p>
        ${C.bars({ title: '분기 손익', height: 110, format: (v) => money(v), labels, values: pick(rows, 'net') })}
      </section>

      <section class="grid2">
        <div class="card">
          <h3>인도 · 수주 잔고</h3>
          ${C.line({
            title: '수주 잔고 추이',
            height: 130,
            zero: true,
            format: (v) => num(v) + '기',
            labels,
            series: [{ name: '수주 잔고', values: pick(rows, 'backlog'), cls: 'accent', fill: true }],
          })}
          ${C.bars({ title: '분기 인도', height: 110, format: (v) => num(v) + '기', labels, values: pick(rows, 'delivered') })}
          <p class="hint">위가 잔고, 아래가 실제 인도다. 잔고만 쌓이고 인도가 안 따라가면 라인이 모자란다.</p>
        </div>
        <div class="card">
          <h3>점유율 · 평판</h3>
          ${C.line({
            title: '시장 점유율 추이',
            height: 130,
            format: pct,
            labels,
            series: [{ name: '점유율', values: pick(rows, 'share'), cls: 'accent', fill: true }],
          })}
          ${C.line({
            title: '평판 추이',
            height: 110,
            format: (v) => Math.round(v),
            labels,
            series: [{ name: '평판', values: pick(rows, 'reputation'), cls: 'warn' }],
          })}
          <p class="hint">점유율은 우리 누적 인도 ÷ 업계 누적 인도다. 인도가 없는 분기에는 경쟁사만 쌓여 자연히 내려간다.</p>
        </div>
      </section>

      ${
        // 앞의 네 곡선이 "우리가 어떻게 가고 있나"라면, 아래 셋은 배경 지표다.
        // 매번 스크롤로 지나치는 대신 필요할 때 펼친다.
        foldCard(
          folds,
          'tr-market',
          '시장 지표',
          `연료 ${s.market.fuelIndex.toFixed(2)} · 수요 ${s.market.demandIndex.toFixed(2)}`,
          `<p class="muted">연료지수가 오르면 입찰 점수에서 연비 비중이 커지고, 수요지수가 내려가면 공고 자체가 줄어든다.</p>
           ${C.line({
             title: '연료·수요 지수 추이',
             height: 110,
             format: (v) => v.toFixed(2),
             labels,
             series: [
               { name: '연료지수', values: pick(rows, 'fuel'), cls: 'bad' },
               { name: '수요지수', values: pick(rows, 'demand'), cls: 'good' },
             ],
           })}
           ${legend([
             { name: '연료지수', cls: 'bad' },
             { name: '수요지수', cls: 'good' },
           ])}`,
        )
      }
      ${foldCard(
        folds,
        'tr-makers',
        '제조사별 누적 인도',
        `${standings.length}개사`,
        `<p class="muted">업계 인도량은 그 시점 카탈로그의 실력대로 갈린다. 787이 뜨면 보잉 몫이 늘고, 단산이 겹치면 줄어든다.</p>
         ${C.shareBars(shareRows)}`,
      )}
      ${foldCard(
        folds,
        'tr-duels',
        '수주전 전적',
        duels.length ? `${duels.length}개사와 맞붙음` : '',
        `<p class="muted">공고마다 그 시점 최강 기종이 상대로 나온다. 누구에게 얼마나 밀렸는지가 다음 설계의 근거다.</p>
         ${duelRows}`,
      )}`;
  }

  function legend(items) {
    return `<ul class="legend">${items.map((i) => `<li><i class="${i.cls}"></i>${esc(i.name)}</li>`).join('')}</ul>`;
  }

  // ─────────────────────────────── 종료 회고 ───────────────────────────────

  /**
   * 20년 회고 — 종료 화면 본문.
   * 등급 한 글자로 끝내면 무엇이 그 등급을 만들었는지가 남지 않는다. 점수 구성,
   * 남긴 기종, 곡선, 상대 전적까지 펼쳐 한 판의 이야기를 닫는다.
   */
  function renderCareer(s) {
    const r = E.careerReport(s);
    const rows = r.history;
    const labels = rows.map((h) => h.label);

    const breakdown = r.breakdown
      .map((b) => `<tr><th>${esc(b.label)}</th><td class="muted">${esc(b.detail)}</td><td class="pts">${num(b.points)}</td></tr>`)
      .join('');

    const programs = r.programs.length
      ? `<table class="spec cols career-programs">
          <thead><tr><th>기종</th><th>급</th><th>착수</th><th>인도</th><th>잔고</th><th>상태</th></tr></thead>
          <tbody>${r.programs
            .map(
              (p) => `<tr>
                <th>${esc(p.name)}${p.legacy ? ' <span class="muted">승계</span>' : ''}</th>
                <td class="muted wrap">${esc(p.segment)} · ${num(p.seats)}석 · ${num(p.range)}km</td>
                <td class="muted">${esc(p.launched)}</td>
                <td>${num(p.delivered)}기</td>
                <td class="muted">${num(p.backlog)}기</td>
                <td class="muted">${esc(phaseLabel(p))}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>`
      : '<p class="muted">끝내 한 기종도 남기지 못했다.</p>';

    const customers = r.customers.length
      ? C.shareBars(
          r.customers.slice(0, 6).map((c) => ({
            name: c.name,
            value: c.units,
            text: `${num(c.units)}기 · 관계 ${c.relation}`,
          })),
        )
      : '<p class="muted">우리 기체를 굴린 항공사가 없다.</p>';

    const standings = C.shareBars(
      r.standings.map((x) => ({
        name: x.name,
        value: x.delivered,
        text: `${num(x.delivered)}기 · ${(x.share * 100).toFixed(1)}%`,
        highlight: x.us,
      })),
    );

    const duels = r.duels.length
      ? `<ul class="duels">${r.duels
          .map(
            (d) =>
              `<li><b>${esc(d.name)}</b> <span class="muted">${d.faced}회</span> <span class="good">${d.won}승</span> · <span>${d.split}분할</span> · <span class="bad">${d.lost}패</span>${d.lostQty ? ` <span class="muted">(${num(d.lostQty)}기를 내줬다)</span>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '<p class="muted">경쟁사와 맞붙은 수주전이 없었다.</p>';

    return `
      <section class="career-sec">
        <h3>점수 구성</h3>
        <table class="spec">${breakdown}</table>
      </section>

      <section class="career-sec">
        <h3>20년 요약</h3>
        <table class="spec">
          <tr><th>누적 매출</th><td>${money(r.totalRevenue)}</td></tr>
          <tr><th>누적 개발비</th><td>${money(r.totalRd)}</td></tr>
          <tr><th>최고 분기</th><td>${
            r.best
              ? `${esc(r.best.label)} · <span class="${r.best.net >= 0 ? 'good' : 'bad'}">${r.best.net >= 0 ? '+' : ''}${money(r.best.net)}</span>`
              : '—'
          }</td></tr>
          <tr><th>최악 분기</th><td>${r.worst ? `${esc(r.worst.label)} · <span class="bad">${money(r.worst.net)}</span>` : '—'}</td></tr>
          <tr><th>최고 점유율</th><td>${(r.peakShare * 100).toFixed(1)}%</td></tr>
          <tr><th>최대 부채</th><td>${money(r.peakDebt)}</td></tr>
        </table>
      </section>

      <section class="career-sec">
        <h3>순자산 곡선</h3>
        ${C.line({
          title: '순자산 추이',
          height: 130,
          zero: true,
          format: (v) => money(v),
          labels,
          series: [{ name: '순자산', values: rows.map((h) => (typeof h.worth === 'number' ? h.worth : null)), cls: 'accent', fill: true }],
        })}
      </section>

      <section class="career-sec">
        <h3>남긴 기종</h3>
        ${programs}
      </section>

      ${
        (s.milestones || []).length
          ? `<section class="career-sec">
        <h3>이 회사의 순간들</h3>
        <ul class="duel-list">${s.milestones
          .map((m) => `<li><span class="muted">${esc(m.label)}</span> — ${esc(m.text)}</li>`)
          .join('')}</ul>
      </section>`
          : ''
      }

      <section class="career-sec">
        <h3>주요 고객</h3>
        ${customers}
      </section>

      <section class="career-sec">
        <h3>업계 최종 순위</h3>
        ${standings}
      </section>

      <section class="career-sec">
        <h3>수주전 전적</h3>
        ${duels}
      </section>`;
  }

  /**
   * 증자와 프로그램 매각 — 파산 말고 다른 출구.
   * 둘 다 공짜가 아니라는 걸 버튼 옆에 그대로 적는다.
   */
  function equityBlock(s) {
    const cap = E.equityCapacity(s);
    const rounds = s.equityRounds || 0;
    const dil = s.equityDilution || 0;
    const sellable = s.programs.filter((p) => p.phase === 'dev' || p.phase === 'cert');
    const runway = E.cashRunway(s);

    const amounts = [Math.round(cap.max * 0.4), Math.round(cap.max * 0.7), cap.max].filter((v, i, arr) => v >= 300 && arr.indexOf(v) === i);

    return `
      <p class="muted">현재 지분 희석 ${(dil * 100).toFixed(1)}% · 증자 ${rounds}/3회 사용${
        runway !== null ? ` · <b class="${runway <= 4 ? 'bad' : 'warn'}">현금 잔여 ${runway}분기</b>` : ''
      }</p>
      <p class="hint">증자는 최대 ${money(cap.max)}까지 받을 수 있고, 전액을 받으면 지분이 ${(cap.dilutionAtMax * 100).toFixed(1)}%p 희석된다. <b>희석된 만큼 최종 점수가 깎인다</b> — 잘 나갈 때 당겨 두는 편이 싸다.</p>
      <div class="row wrap">
        ${
          rounds >= 3
            ? '<span class="muted">증자 한도를 모두 썼다.</span>'
            : amounts
                .map((v) => `<button data-action="raise" data-amt="${v}">${money(v)} 증자</button>`)
                .join('')
        }
      </div>
      <h3 class="sub">프로그램 매각</h3>
      ${
        sellable.length
          ? `<p class="hint">개발·인증 중인 기종을 경쟁사에 넘긴다. 즉시 현금이 되지만 도면이 넘어가 그 시장 경쟁이 세진다.</p>
             <div class="row wrap">${sellable
               .map(
                 (p) =>
                   `<button class="danger" data-action="sell-program" data-id="${p.id}">${esc(p.name)} 매각 <span class="muted">(진척 ${Math.round(p.progress)}%)</span></button>`,
               )
               .join('')}</div>`
          : '<p class="muted">매각할 수 있는 개발 중 기종이 없다.</p>'
      }`;
  }

  // ─────────────────────────────── 기록 ───────────────────────────────

  const LOG_RECENT = 24;

  /**
   * 경영 기록 — 20년치가 쌓이면 한 탭이 일곱 화면이 된다.
   * 최근 것만 펼쳐 두고 나머지는 접는다 (지운 것이 아니라 접은 것임을 개수로 밝힌다).
   */
  function renderLog(s, folds) {
    const recent = s.log.slice(0, LOG_RECENT);
    const older = s.log.slice(LOG_RECENT);
    return `<section class="card">
        <h3>경영 기록</h3>
        <ul class="log">${recent.map(logItem).join('')}</ul>
        ${
          older.length
            ? `<details class="fold"${foldOpen(folds, 'log-older', false) ? ' open' : ''}>
                 <summary data-fold="log-older"><b>이전 기록</b><span class="fold-val">${num(older.length)}건</span></summary>
                 <ul class="log">${older.map(logItem).join('')}</ul>
               </details>`
            : ''
        }
      </section>`;
  }

  root.AirlinerPanels = {
    todoList,
    renderOverview,
    renderTrends,
    mandateCard,
    renderCareer,
    renderDesign,
    renderDesignSummary,
    renderDesignOptions,
    renderDesignPreview,
    renderPrograms,
    renderProduction,
    renderRfps,
    renderBidInfo,
    renderBidCandidates,
    bidTerms,
    renderFinance,
    renderLog,
    esc,
    richText,
    money,
    num,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
