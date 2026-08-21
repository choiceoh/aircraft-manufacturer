/*
 * 앱 컨트롤러 — HUD·탭·이벤트 위임·저장/불러오기.
 *
 * 모든 클릭/입력은 document 한 곳에서 data-action으로 위임 처리한다.
 * 패널을 통째로 다시 그려도 핸들러가 살아있고, 배선이 한 군데에 모인다.
 */
(function (root) {
  'use strict';

  const E = root.AirlinerEngine;
  const D = root.AirlinerDesign;
  const P = root.AirlinerPanels;
  const { CONFIG, SEGMENTS } = root.AirlinerData;

  const SAVE_KEY = 'airliner.save.v1';
  const money = E.fmtMoney;

  const ui = {
    state: null,
    tab: 'overview',
    spec: D.defaultSpec('narrow'),
    // 기종을 고르기 전에 만진 할인율 (RFP별). 선택 시 이 값을 그대로 물려준다.
    discountDraft: {},
    // 설계 미리보기가 통째로 교체돼도 입력한 기종명이 날아가지 않게 보관한다.
    designName: '',
    // 수주 공고에서 펼쳐 둔 배경 설명. 패널을 통째로 다시 그려도 방금 읽던 곳이
    // 접히지 않도록 여기에 기억한다 (details 의 open 상태는 innerHTML 교체로 날아간다).
    folds: new Set(),
    // 다음 렌더에서 한 번만 재생할 연출. 슬라이더를 움직일 때마다 화면이 페이드되면
    // 오히려 조작이 굼떠 보이므로, 탭 전환·분기 종료에서만 켠다.
    animate: null,
  };

  const TABS = [
    { id: 'overview', name: '개요' },
    { id: 'design', name: '설계' },
    { id: 'programs', name: '프로그램' },
    { id: 'production', name: '생산' },
    { id: 'rfps', name: '수주' },
    { id: 'finance', name: '재무' },
    { id: 'trends', name: '추이' },
    { id: 'log', name: '기록' },
  ];

  // ─────────────────────────────── 렌더 ───────────────────────────────

  function render() {
    const s = ui.state;
    const anim = ui.animate;
    ui.animate = null;
    renderHud(s, anim === 'turn');
    renderTabs(s);
    renderFoot(s);
    measureTopbar();

    const panel = document.getElementById('panel');
    // 클래스를 지웠다 다시 붙여야 같은 애니메이션이 다시 재생된다.
    panel.className = 'panel';
    if (anim) {
      void panel.offsetWidth;
      panel.className = 'panel enter';
    }
    // 접이 섹션이 있는 패널은 모두 같은 집합(ui.folds)을 받는다 — 어느 탭에서 접었든
    // 다시 그려도 그대로 있어야 한다.
    switch (ui.tab) {
      case 'design':
        panel.innerHTML = P.renderDesign(s, ui.spec, ui.designName, ui.folds);
        break;
      case 'programs':
        panel.innerHTML = P.renderPrograms(s, ui.folds);
        break;
      case 'production':
        panel.innerHTML = P.renderProduction(s, ui.folds);
        break;
      case 'rfps':
        panel.innerHTML = P.renderRfps(s, ui.discountDraft, ui.folds);
        break;
      case 'finance':
        panel.innerHTML = P.renderFinance(s, ui.folds);
        break;
      case 'trends':
        panel.innerHTML = P.renderTrends(s, ui.folds);
        break;
      case 'log':
        panel.innerHTML = P.renderLog(s, ui.folds);
        break;
      default:
        panel.innerHTML = P.renderOverview(s, ui.folds);
    }
    save();
  }

  function renderHud(s, flash) {
    // 종료 후 s.turn 은 이미 다음 인덱스라, 그대로 쓰면 존재하지 않는 분기가 뜬다.
    const shownTurn = s.gameOver ? s.gameOver.lastTurn ?? Math.max(0, s.turn - 1) : s.turn;
    const share = (E.marketShare(s) * 100).toFixed(1);
    const fuel = s.market.fuelIndex;
    const demand = s.market.demandIndex;
    const trend = (v) => (v >= 1.25 ? 'up' : v <= 0.8 ? 'down' : '');

    // 직전 정산 대비 증감. 숫자만 바뀌면 무엇이 움직였는지 눈에 안 들어온다.
    const last = s.history[s.history.length - 1];
    const prev = s.history[s.history.length - 2];
    const delta = (key, fmt, invert) => {
      if (!last || !prev || typeof last[key] !== 'number' || typeof prev[key] !== 'number') return '';
      const d = last[key] - prev[key];
      if (!d) return '';
      const good = invert ? d < 0 : d > 0;
      return `<i class="hud-delta ${good ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'}${fmt(Math.abs(d))}</i>`;
    };

    const hud = document.getElementById('hud');
    hud.className = 'hud' + (flash ? ' flash' : '');
    hud.innerHTML = `
      <div class="hud-left">
        <div class="hud-id">
          <div class="hud-company">${P.esc(s.company)}</div>
          <div class="hud-date">${E.turnLabel(shownTurn)} ${
            s.gameOver
              ? '<span class="muted">· 경영 종료</span>'
              : `<span class="muted">· ${CONFIG.totalTurns - s.turn}분기 남음</span>`
          }</div>
        </div>
        <!-- 진행을 지우는 버튼은 엄지가 늘 얹히는 하단이 아니라 여기 둔다.
             종료 뒤에는 하단 바가 '새 게임'을 정식 버튼으로 내주므로 여기서는 뺀다 —
             되돌릴 수 없는 입구가 화면에 둘 있을 이유가 없다. -->
        ${s.gameOver ? '' : '<button class="ghost small hud-new" data-action="new-game">새 게임</button>'}
      </div>
      <div class="hud-stats">
        ${hudStat('현금', money(s.cash), s.cash < 500 ? 'bad' : '', delta('cash', money))}
        ${hudStat('부채', money(s.debt), s.debt >= CONFIG.maxDebt * 0.9 ? 'bad' : '', delta('debt', money, true))}
        ${hudStat('수주 잔고', P.num(E.totalBacklog(s)) + '기', '', delta('backlog', (v) => P.num(v) + '기'))}
        ${hudStat('점유율', share + '%')}
        ${hudStat('평판', Math.round(s.reputation))}
        ${hudStat('연료지수', fuel.toFixed(2), trend(fuel))}
        ${hudStat('수요지수', demand.toFixed(2), trend(demand) === 'up' ? 'good' : trend(demand) === 'down' ? 'bad' : '')}
      </div>
      <button class="next hud-next" data-action="next-turn">분기 종료 ▸</button>`;
  }

  /**
   * 고정 헤더의 실제 높이를 CSS 변수로 넘긴다.
   * 설계 요약 바가 그 아래에 붙어야 하는데, 헤더 높이는 화면 폭·회사명 길이에 따라
   * 달라져 CSS 만으로는 알 수 없다.
   */
  function measureTopbar() {
    const bar = document.querySelector('.topbar');
    if (bar) document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
  }

  function hudStat(label, value, tone, delta) {
    return `<div class="hud-stat ${tone || ''}"><span>${label}</span><b>${value}${delta || ''}</b></div>`;
  }

  function renderTabs(s) {
    // 탭 배지는 "여기 손댈 게 있다"를 뜻한다. 좁은 화면에서는 개요의 경영 경고를
    // 읽으러 가는 것 자체가 스크롤 비용이라, 어느 탭에 일이 남았는지 여기서 알린다.
    const byTab = {};
    for (const t of P.todoList(s)) byTab[t.tab] = (byTab[t.tab] || 0) + 1;

    const el = document.getElementById('tabs');
    el.innerHTML = TABS.map((t) => {
      let badge = '';
      if (byTab[t.id]) badge = `<i class="todo">${byTab[t.id]}</i>`;
      else if (t.id === 'rfps' && s.rfps.length) badge = `<i>${s.rfps.length}</i>`;
      return `<button class="tab ${t.id === ui.tab ? 'on' : ''}" data-action="tab" data-tab="${t.id}">${t.name}${badge}</button>`;
    }).join('');

    // 탭이 여덟 개라 좁은 화면에서는 가로로 넘친다. 지금 보고 있는 탭이 스크롤 밖에
    // 있으면 어디에 있는지 알 수 없으므로 늘 화면 안으로 끌어온다.
    const on = el.querySelector('.tab.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  /**
   * 하단 액션 바 — 엄지가 닿는 자리에 이번 분기의 행동만 남긴다.
   * 분기 종료는 80번 누르는 버튼인데 HUD 안에 있으면 좁은 화면에서 손이 화면 꼭대기까지
   * 올라가야 한다. 남은 할 일 개수를 옆에 붙여 두어 "빠뜨린 게 있나"를 누르기 전에 안다.
   */
  function renderFoot(s) {
    const foot = document.getElementById('foot');
    if (!foot) return;
    if (s.gameOver) {
      foot.innerHTML = `<span class="muted">경영 종료 · 기록을 살펴보라</span>
        <button class="next" data-action="new-game">새 게임 ▸</button>`;
      return;
    }
    const todos = P.todoList(s);
    foot.innerHTML = `
      ${
        todos.length
          ? `<button class="todo-btn" data-action="todo">할 일 <i>${todos.length}</i></button>`
          : '<span class="muted">손봐야 할 일 없음</span>'
      }
      <button class="next foot-next" data-action="next-turn">분기 종료 ▸</button>`;
  }

  /** 할 일 시트 — 눌러서 그 탭으로 바로 건너뛴다. */
  function openTodoSheet() {
    const items = P.todoList(ui.state);
    const name = (id) => (TABS.find((t) => t.id === id) || {}).name || id;
    const body = items.length
      ? `<ul class="todo-list">${items
          .map(
            (t) => `<li><button data-action="goto-tab" data-tab="${t.tab}">
              <b>${P.esc(name(t.tab))}</b><span>${P.esc(t.text)}</span>
            </button></li>`,
          )
          .join('')}</ul>`
      : '<p class="muted">지금 손봐야 할 일은 없다. 분기를 넘겨도 좋다.</p>';
    openModal(`<h2 id="modal-title">지금 할 일</h2>${body}
      <div class="row modal-actions"><button class="ghost" data-action="close-modal">닫기</button></div>`);
  }

  function toast(text, tone) {
    const el = document.getElementById('toast');
    el.className = 'toast show ' + (tone || '');
    // 결정 결과·엔진 오류 문구에는 플레이어가 지은 프로그램 이름이 그대로 끼어든다.
    // 손익 강조처럼 우리가 넣은 <b> 만 살리고 나머지는 이스케이프한다(결정 카드와 같은 규칙).
    el.innerHTML = P.richText(text);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.className = 'toast'), 4200);
  }

  // ─────────────────────────────── 행동 처리 ───────────────────────────────

  /**
   * 확인 대화 — 네이티브 confirm() 을 쓰지 않는다.
   *
   * 좁은 화면에서 OS 팝업은 게임 밖 화면처럼 끼어들고, 무엇보다 **금액을 강조할 수 없다**.
   * 위약금이 얼마나 나가는지가 한 줄 평문에 묻히면 "손절" 버튼이 파산 버튼이 된다.
   * 되돌릴 수 없는 행동은 전부 이 대화를 지난다.
   */
  let pendingConfirm = null;

  function askConfirm(opts, onOk) {
    pendingConfirm = onOk;
    openModal(`
      <h2 id="modal-title">${P.esc(opts.title)}</h2>
      ${opts.body}
      <div class="row modal-actions">
        <button class="ghost" data-action="close-modal">취소</button>
        ${opts.altHtml || ''}
        <button class="${opts.okClass || (opts.danger ? 'danger' : 'primary')}" data-action="confirm-ok">${P.esc(opts.ok || '진행')}</button>
      </div>`);
  }

  /** engine 호출 결과를 그대로 토스트로 흘려보내는 공통 래퍼 */
  function act(result, okMsg) {
    if (!result) return false;
    if (!result.ok) {
      toast(result.error, 'bad');
      return false;
    }
    if (okMsg) toast(okMsg, 'good');
    render();
    return true;
  }

  // 게임 종료 뒤에도 허용되는 행동 — 나머지는 저장 상태를 바꿔 최종 성적과 어긋나게 만든다.
  const ALLOWED_AFTER_END = new Set(['tab', 'new-game', 'new-game-as', 'close-modal']);

  /**
   * 종료 후 잠금. 클릭뿐 아니라 슬라이더(input/change)도 막아야 한다 —
   * 인력 배분·할인율 슬라이더는 클릭 없이도 ui.state를 바꿔 저장까지 흘러간다.
   */
  function lockedAfterEnd(action) {
    if (!ui.state.gameOver) return false;
    if (ALLOWED_AFTER_END.has(action)) return false;
    return true;
  }

  /**
   * 탭 이동 — 스크롤을 맨 위로 되돌린다.
   * 좁은 화면에서 긴 패널을 한참 내려 보다 탭을 바꾸면, 새 패널의 한가운데가
   * 펼쳐진 채 시작해 지금 어디를 보고 있는지 알 수 없다.
   */
  function gotoTab(tab) {
    if (ui.tab !== tab) ui.animate = 'tab';
    ui.tab = tab;
    render();
    scrollTop();
  }

  function scrollTop() {
    if (typeof window !== 'undefined' && window.scrollTo) window.scrollTo(0, 0);
  }

  function onClick(ev) {
    // 접었다 편 자리는 기억해 둔다 — 후보를 고르면 패널을 통째로 다시 그리는데,
    // 그때마다 방금 펼쳐 읽던 공고 배경이 도로 접히면 같은 곳을 계속 다시 연다.
    const sum = ev.target.closest('summary[data-fold]');
    if (sum) {
      const id = sum.dataset.fold;
      if (ui.folds.has(id)) ui.folds.delete(id);
      else ui.folds.add(id);
      return;
    }

    const btn = ev.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const s = ui.state;
    const a = btn.dataset.action;

    if (lockedAfterEnd(a)) {
      toast('경영이 종료되어 더 이상 조작할 수 없다. 새 게임을 시작하라.', 'bad');
      return;
    }

    switch (a) {
      case 'tab':
        gotoTab(btn.dataset.tab);
        break;

      case 'goto-tab':
        closeModal();
        gotoTab(btn.dataset.tab);
        break;

      case 'todo':
        openTodoSheet();
        break;

      case 'confirm-ok': {
        const fn = pendingConfirm;
        closeModal();
        if (fn) fn();
        break;
      }

      case 'goto-preview': {
        const el = document.getElementById('design-preview');
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }

      case 'next-turn':
        nextTurn();
        break;

      case 'decide': {
        const r = E.decide(s, btn.dataset.opt);
        if (!r.ok) toast(r.error, 'bad');
        else {
          toast(r.text, 'good');
          ui.animate = 'turn';
          render();
        }
        break;
      }

      case 'test-aircraft': {
        const r = E.addTestAircraft(s, btn.dataset.id);
        if (act(r)) toast(`시험기를 한 대 더 띄웠다. 제작비 ${P.money(r.cost)}.`, 'good');
        break;
      }

      case 'early-etops': {
        const r = E.startEarlyEtops(s, btn.dataset.id);
        if (act(r)) toast(`조기 ETOPS 취득에 착수했다. 비용 ${P.money(r.cost)}.`, 'good');
        break;
      }

      case 'design-seg':
        ui.spec = D.defaultSpec(btn.dataset.seg, E.yearOf(s.turn));
        render();
        break;

      case 'design-fuselage':
        ui.spec.fuselage = btn.dataset.mat;
        render();
        break;

      case 'design-wingmat':
        ui.spec.wingMat = btn.dataset.mat;
        render();
        break;

      case 'design-eng':
        ui.spec.engine = btn.dataset.eng;
        render();
        break;

      case 'design-abreast':
        ui.spec.abreast = Number(btn.dataset.abreast);
        render();
        break;

      case 'design-family':
        ui.spec.family = !ui.spec.family;
        render();
        break;

      case 'design-etops':
        ui.spec.etops = !ui.spec.etops;
        render();
        break;

      case 'design-growth':
        ui.spec.growth = !ui.spec.growth;
        render();
        break;

      case 'design-maintainable':
        ui.spec.maintainable = !ui.spec.maintainable;
        render();
        break;

      case 'design-engines':
        ui.spec.engines = ui.spec.engines === 4 ? 2 : 4;
        render();
        break;

      case 'design-dual':
        ui.spec.dualSource = !ui.spec.dualSource;
        render();
        break;

      case 'wind-tunnel':
        act(E.investWindTunnel(s, btn.dataset.id));
        break;

      case 'launch-aid':
        act(E.investLaunchAid(s, btn.dataset.id));
        break;

      case 'derive': {
        const base = s.programs.find((p) => p.id === btn.dataset.id);
        if (base) {
          ui.spec = E.derivativeSpec(base, 20);
          ui.tab = 'design';
          toast(`${base.name} 파생형 설계를 불러왔다. 좌석수를 조정해 보라.`);
          render();
        }
        break;
      }

      case 'launch': {
        const nameEl = document.getElementById('design-name');
        const name = ((nameEl && nameEl.value) || ui.designName || '').trim();
        const r = E.launchProgram(s, ui.spec, name);
        if (act(r)) {
          ui.designName = '';
          ui.tab = 'programs';
          toast(`${r.program.name} 개발에 착수했다.`, 'good');
          render();
        }
        break;
      }

      case 'quality':
        act(E.investQuality(s, btn.dataset.id));
        break;

      case 'cancel-prog': {
        const p = s.programs.find((x) => x.id === btn.dataset.id);
        if (!p) break;
        // 선주문이 걸려 있으면 매몰비용보다 위약이 훨씬 클 수 있다. 확인창이
        // 그 돈을 말하지 않으면 "손절"인 줄 알고 누른 버튼이 파산 버튼이 된다.
        const voidCost = E.voidRefundFor ? E.voidRefundFor(s, p) : 0;
        askConfirm(
          {
            title: `${p.name} 개발 중단`,
            body: `<p>투입된 <b>${money(p.spent)}</b>는 회수되지 않고 평판도 떨어진다.</p>
              ${voidCost > 0 ? `<p class="warn-box">미인도 주문 파기로 선수금 반환·위약금 <b>${money(voidCost)}</b>이 즉시 나간다.</p>` : ''}`,
            ok: '개발 중단',
            danger: true,
          },
          () => act(E.cancelProgram(s, btn.dataset.id)),
        );
        break;
      }

      case 'upgrade':
        act(E.startUpgrade(s, btn.dataset.id, btn.dataset.kind));
        break;

      case 'set-outsourcing':
        act(E.setOutsourcing(s, btn.dataset.level));
        break;

      case 'retool-line':
        act(E.retoolLine(s, btn.dataset.id, btn.dataset.target));
        break;

      case 'build-line':
        act(E.buildLine(s, btn.dataset.id, btn.dataset.grade));
        break;

      case 'toggle-line':
        act(E.toggleLine(s, btn.dataset.id));
        break;

      case 'close-line': {
        // 환급은 등급별 실제 건설비의 20%라 라인마다 다르다. 비율만 적으면
        // 고속 자동화 라인을 재래식과 같은 값으로 착각하고 닫는다.
        const line = s.lines.find((l) => l.id === btn.dataset.id);
        const paid = line && typeof line.paidCost === 'number' ? line.paidCost : 0;
        askConfirm(
          {
            title: '조립 라인 폐쇄',
            body: `<p>건설비 ${money(paid)} 중 <b>${money(Math.round(paid * 0.2))}</b>만 회수된다 —
                 <b class="bad">${money(Math.round(paid * 0.8))}</b>은 그대로 사라진다.</p>
               <p class="muted">다시 세우려면 처음부터 짓고 램프업도 다시 밟아야 한다.</p>`,
            ok: '폐쇄',
            danger: true,
          },
          () => act(E.closeLine(s, btn.dataset.id)),
        );
        break;
      }

      case 'sell-stock': {
        const p = s.programs.find((x) => x.id === btn.dataset.id);
        if (p) act(E.sellStock(s, p.id, p.stock));
        break;
      }

      case 'pick-bid': {
        const rfpId = btn.dataset.rfp;
        const cur = s.bids[rfpId];
        const discount = cur ? cur.discount : ui.discountDraft[rfpId] ?? 0.1;
        E.setBid(s, rfpId, btn.dataset.id, discount);
        render();
        break;
      }

      case 'bid-term': {
        const r = E.setBidTerms(s, btn.dataset.rfp, { [btn.dataset.kind]: btn.dataset.value });
        if (!r.ok) toast(r.error, 'bad');
        else render();
        break;
      }

      case 'withdraw':
        E.setBid(s, btn.dataset.rfp, null);
        render();
        break;

      case 'aftermarket': {
        const r = E.upgradeAftermarket(s, btn.dataset.tier);
        act(r, r.ok ? '서비스망 투자를 마쳤다.' : null);
        break;
      }

      case 'freighter': {
        const r = E.startFreighter(s, btn.dataset.id);
        act(r, r.ok ? '화물형 개조에 착수했다.' : null);
        break;
      }

      case 'raise': {
        const r = E.raiseEquity(s, Number(btn.dataset.amt));
        act(r, r.ok ? '증자를 마쳤다. 지분이 희석됐다.' : null);
        break;
      }

      case 'sell-program': {
        const p = s.programs.find((x) => x.id === btn.dataset.id);
        const sell = () => {
          const r = E.sellProgram(s, btn.dataset.id);
          act(r, r.ok ? `${p ? p.name : '프로그램'}을 매각했다.` : null);
        };
        if (!p) {
          sell();
          break;
        }
        const sellVoid = E.voidRefundFor ? E.voidRefundFor(s, p) : 0;
        askConfirm(
          {
            title: `${p.name} 매각`,
            body: `<p>되돌릴 수 없다. 도면이 경쟁사로 넘어가 그 시장의 경쟁이 세진다.</p>
              ${sellVoid > 0 ? `<p class="warn-box">미인도 주문 파기로 선수금 반환·위약금 <b>${money(sellVoid)}</b>이 매각 대금에서 즉시 나간다.</p>` : ''}`,
            ok: '매각',
            danger: true,
          },
          sell,
        );
        break;
      }

      case 'borrow':
        act(E.borrow(s, Number(btn.dataset.amt)));
        break;

      case 'repay':
        act(E.repay(s, Number(btn.dataset.amt)));
        break;

      case 'hire':
        act(E.hireEngineers(s, Number(btn.dataset.amt)));
        break;

      case 'new-game':
        openCompanyPicker();
        break;

      case 'new-game-as':
        startNewGame(btn.dataset.company);
        break;

      case 'close-modal':
        closeModal();
        break;
    }
  }

  /**
   * 슬라이더 입력 — 드래그 중에 패널을 통째로 다시 그리면 드래그가 끊기므로,
   * 라벨과 해당 미리보기 영역만 직접 갱신한다.
   */
  function onInput(ev) {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    if (lockedAfterEnd(el.dataset.action)) return;
    const s = ui.state;

    if (el.dataset.action === 'design-name') {
      ui.designName = el.value;
      return; // 미리보기를 다시 그리면 입력 포커스가 끊긴다
    }

    if (el.dataset.action === 'design-input') {
      const key = el.dataset.key;
      ui.spec[key] = Number(el.value);
      const unit = key === 'seats' ? '석' : key === 'range' ? 'km' : '';
      const lbl = document.getElementById('lbl-' + key);
      if (lbl) lbl.textContent = P.num(ui.spec[key]) + unit;
      const prev = document.getElementById('design-preview');
      if (prev) prev.innerHTML = P.renderDesignPreview(s, ui.spec, ui.designName);
      // 착수 옵션도 지금 값에 달려 있다 — 항속·기술·날개를 움직이면 패밀리 승계가
      // 끊기거나 ETOPS 가 값을 하게 된다. 미리보기만 갈면 여기가 옛 상태로 남는다.
      const opts = document.getElementById('design-options');
      if (opts) opts.innerHTML = P.renderDesignOptions(s, ui.spec);
      // 좁은 화면에서는 평가표가 화면 밖으로 밀린다. 상단에 붙어 따라다니는 요약 바가
      // 슬라이더를 움직이는 동안 결과를 보여주는 유일한 창이라, 여기서 같이 갈아끼운다.
      const sum = document.getElementById('design-sum');
      if (sum) {
        // 좁은 화면에서 요약 바는 옆으로 밀어 보는 스트립이다. 통째로 갈아끼우면
        // 스크롤이 왼쪽 끝으로 되돌아가, 연비·객실을 보려고 밀어 둔 채 슬라이더를
        // 움직이면 첫 입력에서 보고 있던 칸이 사라진다.
        const strip = sum.querySelector('.ds-strip');
        const left = strip ? strip.scrollLeft : 0;
        sum.outerHTML = P.renderDesignSummary(s, ui.spec);
        const next = document.querySelector('#design-sum .ds-strip');
        if (next) next.scrollLeft = left;
      }
    } else if (el.dataset.action === 'share') {
      const p = s.programs.find((x) => x.id === el.dataset.id);
      if (!p) return;
      p.share = Number(el.value);
      const lbl = document.getElementById('lbl-share-' + p.id);
      if (lbl) lbl.textContent = p.share + '%' + (p.share <= 0 ? ' (동결)' : '');
    } else if (el.dataset.action === 'discount') {
      const rfpId = el.dataset.rfp;
      const bid = s.bids[rfpId];
      const pct = Number(el.value);
      const lbl = document.getElementById('disc-label-' + rfpId);
      if (lbl) lbl.textContent = pct + '%';
      ui.discountDraft[rfpId] = pct / 100; // 기종 미선택 상태에서도 값을 기억한다
      const rfp = s.rfps.find((r) => r.id === rfpId);

      if (bid) {
        E.setBid(s, rfpId, bid.programId, pct / 100);
        const info = document.getElementById('bidinfo-' + rfpId);
        if (info && rfp) info.innerHTML = P.renderBidInfo(s, rfp);
      }

      // 후보 버튼의 점수·가격은 기종 선택 여부와 무관하게 갱신한다.
      // 선택 후에만 갱신하면, 고르기 전 비교하는 동안 라벨의 할인율과
      // 후보에 표시된 점수가 서로 다른 기준이 된다.
      const cands = document.getElementById('cands-' + rfpId);
      if (cands && rfp) cands.innerHTML = P.renderBidCandidates(s, rfp, pct / 100);
    }
  }

  /** 모달이 열려 있으면 Esc 로 닫고, Tab 포커스를 모달 안에 가둔다. */
  function onKeydown(ev) {
    const modal = document.getElementById('modal');
    if (!modal || !modal.classList.contains('show')) return;
    if (ev.key === 'Escape') {
      closeModal();
      return;
    }
    if (ev.key !== 'Tab') return;
    const focusables = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  /** 슬라이더에서 손을 뗐을 때 파생 표시(완료 예상 등)를 최신화한다. */
  function onChange(ev) {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    if (lockedAfterEnd(el.dataset.action)) return;
    // 드래그가 끝난 시점에 저장한다. onInput 은 메모리 상태만 바꾸므로,
    // 여기서 저장하지 않으면 새로고침 시 이전 할인율로 되돌아간다.
    if (el.dataset.action === 'share') render();
    else if (el.dataset.action === 'discount') save();
  }

  // ─────────────────────────────── 턴 진행 ───────────────────────────────

  /**
   * 분기 종료 — 넘기기 전에 물어볼 것을 차례로 묻는다.
   *
   * acked 는 "이미 확인받은 항목"이다. 확인 대화가 비동기라 각 대화의 확정은
   * **끝내기가 아니라 이 함수로 되돌아오는 것**이어야 한다. 곧장 정산으로 뛰면
   * 미입찰을 확인해 준 순간 답하지 않은 결정까지 무대응으로 함께 넘어간다.
   */
  function nextTurn(acked) {
    acked = acked || {};
    const s = ui.state;
    // 응찰 가능한 기종이 하나도 없는 공고까지 세면(초반엔 대부분이 그렇다) 확인창이
    // 매 분기 뜨는데 수주 탭에 가도 고를 게 없다. 엔진의 무응찰 감점과 같은 기준을 쓴다.
    const unbid = s.rfps.filter((r) => !s.bids[r.id] && E.canBid(s, r)).length;
    if (unbid && s.rfps.length && ui.tab !== 'rfps' && !acked.unbid) {
      askConfirm(
        {
          title: `입찰하지 않은 공고 ${unbid}건`,
          body: '<p>응찰하지 않은 공고는 포기한 것으로 처리되고, 그 항공사와의 <b>관계가 깎인다</b>.</p>',
          ok: '그대로 분기 종료',
          okClass: 'ghost',
          altHtml: '<button class="primary" data-action="goto-tab" data-tab="rfps">공고 보러 가기</button>',
        },
        () => nextTurn({ ...acked, unbid: true }),
      );
      return;
    }

    // 답하지 않은 사건은 무대응으로 처리된다. 그 사실을 모르고 넘기지 않도록 한 번 묻는다.
    if (s.decision && !acked.decision) {
      askConfirm(
        {
          title: '답하지 않은 결정',
          body: `<p>"${P.esc(s.decision.name)}"에 답하지 않았다. 이대로 넘기면 <b>무대응</b>으로 처리된다.</p>`,
          ok: '무대응으로 종료',
          okClass: 'ghost',
          altHtml: '<button class="primary" data-action="goto-tab" data-tab="overview">결정 보러 가기</button>',
        },
        () => nextTurn({ ...acked, decision: true }),
      );
      return;
    }

    endTurnNow();
  }

  function endTurnNow() {
    const s = ui.state;
    const r = E.endTurn(s);
    if (!r.ok) {
      toast(r.error, 'bad');
      return;
    }

    const rep = r.report;
    const net = rep.revenue - rep.productionCost - rep.rdCost - rep.capex - rep.overhead - rep.interest;
    const bits = [`매출 ${money(rep.revenue)}`, `인도 ${rep.delivered}기`];
    if (rep.ordersWon) bits.push(`신규 수주 ${P.num(rep.ordersWon)}기`);
    toast(
      `${rep.label} 정산 — ${bits.join(' · ')} · 손익 <b>${net >= 0 ? '+' : ''}${money(net)}</b>`,
      net >= 0 ? 'good' : 'bad',
    );

    ui.tab = 'overview';
    ui.animate = 'turn';
    render();
    // 정산 결과는 개요 맨 위 결산 카드에 남는다. 스크롤이 아래에 있으면 그걸 못 본다.
    scrollTop();
    if (s.gameOver) showGameOver(s);
  }

  function showGameOver(s) {
    const g = s.gameOver;
    const bankrupt = g.reason === 'bankrupt';
    const body = `
      <h2 id="modal-title">${bankrupt ? '파산' : '20년의 경영이 끝났다'}</h2>
      <p class="go-reason">${
        bankrupt
          ? `${E.turnLabel(g.lastTurn ?? s.turn)}, 자금이 고갈되고 차입 한도까지 소진됐다. 회사는 법정관리에 들어간다.`
          : `${s.company}는 ${P.num(g.delivered)}기의 여객기를 세상에 내보냈다.`
      }</p>
      <div class="grade ${g.grade}">${g.grade}</div>
      <table class="spec">
        <tr><th>최종 점수</th><td>${P.num(g.score)}</td></tr>
        <tr><th>누적 인도</th><td>${P.num(g.delivered)}기</td></tr>
        <tr><th>시장 점유율</th><td>${(g.share * 100).toFixed(1)}%</td></tr>
        <tr><th>순자산</th><td>${money(g.worth)}</td></tr>
        <tr><th>최종 평판</th><td>${Math.round(s.reputation)} / 100</td></tr>
      </table>
      <div class="career">${P.renderCareer(s)}</div>
      <div class="row">
        <button class="primary" data-action="new-game">새 게임</button>
        <button class="ghost" data-action="close-modal">기록 살펴보기</button>
      </div>`;
    openModal(body, true);
  }

  /**
   * 모달 열기/닫기 — 스크린리더가 대화상자를 인지하고 키보드 포커스가
   * 뒤쪽 '분기 종료' 버튼에 남지 않도록 포커스를 옮기고 되돌린다.
   */
  let lastFocused = null;

  function openModal(bodyHtml, wide) {
    const modal = document.getElementById('modal');
    modal.querySelector('.modal-card').className = 'modal-card' + (wide ? ' wide' : '');
    modal.querySelector('.modal-body').innerHTML = bodyHtml;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    lastFocused = document.activeElement;
    const first = modal.querySelector('button');
    if (first) first.focus();
  }

  function closeModal() {
    pendingConfirm = null;
    const modal = document.getElementById('modal');
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    if (lastFocused && lastFocused.isConnected) lastFocused.focus();
    lastFocused = null;
    // 첫 실행 회사 선택을 닫는 모든 경로(버튼·Esc)가 여기를 지난다 — 어떤 식으로
    // 닫았든 "데네브로 간다"는 확정이고, 다음 리로드에 다시 물어보면 안 된다.
    if (ui.state && ui.state.pendingCompanyChoice) {
      delete ui.state.pendingCompanyChoice;
      save();
    }
  }

  // ─────────────────────────────── 저장 / 시작 ───────────────────────────────

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(ui.state));
    } catch (e) {
      /* 저장 실패는 게임 진행을 막지 않는다 (시크릿 모드 등) */
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      // 스키마가 바뀐 옛 세이브는 조용히 버린다.
      if (!s || s.version !== 1 || !Array.isArray(s.programs)) return null;
      // 이전 버전에서 저장된 상태에 새 필드를 채워 넣는다.
      return E.ensureShape(s);
    } catch (e) {
      return null;
    }
  }

  /**
   * 새 게임의 출발 시드.
   * 게임 진행 자체는 rng.js의 시드 고정 PRNG가 굴리고 이 값은 그 출발점일 뿐이지만,
   * 시드가 PRNG를 타고 전체 상태로 퍼지는 흐름을 코드 스캐너가 "취약한 난수"로 잡는다.
   * 게임 시드에 암호학적 강도가 필요하진 않아도 crypto를 쓰는 데 드는 비용이 없으므로
   * 경고를 남겨두는 대신 그냥 crypto로 뽑는다.
   */
  function randomSeed() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.getRandomValues === 'function') {
      return c.getRandomValues(new Uint32Array(1))[0] >>> 0;
    }
    // crypto가 없는 아주 오래된 브라우저 대비 (시드 품질만 떨어질 뿐 동작은 같다).
    const t = Date.now();
    return (t ^ (t << 13) ^ (t >>> 7)) >>> 0;
  }

  function startNewGame(companyId) {
    const seed = randomSeed();
    ui.state = E.newGame(seed, companyId);
    delete ui.state.pendingCompanyChoice;
    ui.tab = 'overview';
    ui.spec = D.defaultSpec('narrow', E.yearOf(ui.state ? ui.state.turn : 0));
    ui.discountDraft = {};
    ui.designName = '';
    // 접힘은 공고·기종 ID 로 기억한다. newGame 이 ID 카운터를 되돌리므로 비우지 않으면
    // 지난 판에서 펼쳐 둔 자리가 새 판의 엉뚱한 공고에서 열린 채 뜬다.
    ui.folds.clear();
    closeModal();
    render();
    const flagship = ui.state.programs[0];
    toast(`${ui.state.company} 경영을 시작한다. ${flagship ? flagship.name + '이(가)' : '주력기가'} 버텨주는 동안 후속기를 띄워라.`, 'good');
  }

  /** 새 게임 — 어느 회사로 20년을 시작할지 고른다. 실존 제조사는 경쟁 명단에서 빠진다. */
  function openCompanyPicker(firstRun) {
    const cards = E.PLAYABLE_COMPANIES.map((c) => {
      const legacies = c.legacies.map((l) => l.name).join(' · ');
      return `<button class="mat" data-action="new-game-as" data-company="${c.id}">
          <b>${P.esc(c.name)} <span class="muted">— ${P.esc(c.difficulty)}</span></b>
          <span>${P.esc(c.desc)}</span>
          <span class="muted">주력 ${P.esc(legacies)} · 자본 ${money(c.cash)} · 엔지니어 ${P.num(c.engineers)}명</span>
        </button>`;
    }).join('');
    openModal(
      `<h2 id="modal-title">어느 회사로 시작할까</h2>
       <p class="muted">${firstRun ? '' : '현재 진행 상황은 사라진다. '}실존 제조사를 고르면 그 회사는 경쟁 명단에서 빠지고, 1998년의 실제 위치를 본뜬 승계 상태로 시작한다. 등급 문턱은 데네브 기준이다 — 거인의 점수는 쉽게 나온다.</p>
       <div class="mats">${cards}</div>
       <div class="row"><button class="ghost" data-action="close-modal">취소</button></div>`,
      true,
    );
  }

  function boot() {
    const saved = load();
    ui.state = saved || E.newGame(randomSeed());
    // 설계 초안은 ui 리터럴에서 연도 없이(=1998) 만들어졌다. 세이브를 불러왔으면
    // 그 시점으로 다시 잡아 준다 — 안 그러면 2015년 세이브가 1998년 기본 엔진으로
    // 열리고, 그 엔진이 아직 팔리는 물건이면 대체 안내조차 뜨지 않는다.
    ui.spec = D.defaultSpec('narrow', E.yearOf(ui.state.turn));
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', measureTopbar);
    // 토스트는 화면 아래를 가린다. 다 읽었으면 눌러서 바로 치울 수 있어야 한다.
    const toastEl = document.getElementById('toast');
    if (toastEl) toastEl.addEventListener('click', () => (toastEl.className = 'toast'));
    render();
    if (ui.state.gameOver) showGameOver(ui.state);
    else if (saved && !saved.pendingCompanyChoice) toast('저장된 경영을 이어서 진행한다.');
    // 첫 방문이면 회사 선택부터 — 기본 판을 조용히 깔아 두는 대신 물어본다.
    // 모달을 닫으면 깔아 둔 데네브 판이 그대로 시작이다. render() 가 그 기본 판을
    // 즉시 저장하므로, 모달이 열린 채 새로고침해도 선택이 조용히 확정되지 않도록
    // "아직 고르는 중" 표식을 세이브에 남겨 두고 다시 물어본다.
    else {
      if (!saved || saved.pendingCompanyChoice) {
        ui.state.pendingCompanyChoice = true;
        save();
        openCompanyPicker(true);
      }
    }
  }

  root.AirlinerUI = { boot, ui };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
