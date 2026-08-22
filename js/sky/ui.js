/*
 * 항공사 게임의 컨트롤러 — HUD·탭·이벤트 위임·저장.
 *
 * 제조사 쪽 `js/ui.js` 와 같은 구조다. 화면은 `js/sky/panels.js` 가 문자열로 만들고,
 * 여기서는 이벤트를 위임으로 받아 명령(`js/sky/actions.js`)을 부른 뒤 다시 그린다.
 * 위임이라야 패널을 통째로 갈아 끼워도 핸들러가 살아 있다.
 */
(function (root) {
  'use strict';

  const Cities = root.AirlinerCities;
  const St = root.AirlinerSkyState;
  const A = root.AirlinerSkyActions;
  const Ai = root.AirlinerSkyAi;
  const SP = root.AirlinerSkyPanels;
  const P = root.AirlinerPanels;

  const SAVE_KEY = 'airliner-sky-save-v1';

  const ui = {
    state: null,
    meId: null,
    tab: 'overview',
    folds: new Set(),
    animate: null,
  };

  /** 판이 끝난 뒤에도 되는 것 — 둘러보기와 새 판뿐이다. */
  const VIEW_ONLY = new Set(['tab', 'new-game', 'pick']);

  const TABS = [
    { id: 'overview', name: '개요' },
    { id: 'routes', name: '노선' },
    { id: 'open', name: '취항' },
    { id: 'fleet', name: '기재' },
    { id: 'map', name: '지도' },
    { id: 'history', name: '기록' },
  ];

  // ─────────────────────────────── 렌더 ───────────────────────────────

  function render() {
    const s = ui.state;
    const anim = ui.animate;
    ui.animate = null;
    renderHud(s);
    renderTabs();
    renderFoot(s);

    const panel = document.getElementById('panel');
    // 끝난 판에서는 조작 버튼을 눌리지 않게 한다. `onClick` 이 막고 토스트를 띄우기는
    // 하지만, 눌러 보기 전에는 못 쓴다는 걸 알 수 없는 버튼은 그 자체로 잘못된 화면이다.
    const over = isOver(s) ? ' over' : '';
    panel.className = 'panel' + over;
    if (anim) {
      void panel.offsetWidth;
      panel.className = 'panel enter' + over;
    }
    switch (ui.tab) {
      case 'routes':
        panel.innerHTML = SP.renderRoutes(s, ui.meId, ui.folds);
        break;
      case 'open':
        panel.innerHTML = SP.renderOpen(s, ui.meId);
        break;
      case 'fleet':
        panel.innerHTML = SP.renderFleet(s, ui.meId, ui.folds);
        break;
      case 'map':
        panel.innerHTML = SP.renderMap(s, ui.meId);
        centerMapOnHome();
        break;
      case 'history':
        panel.innerHTML = SP.renderHistory(s, ui.meId);
        break;
      default:
        panel.innerHTML = SP.renderOverview(s, ui.meId);
    }
    const bar = document.querySelector('.topbar');
    if (bar) document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
    save();
  }

  /**
   * 지도는 폭에 맞추지 않고 가로로 흐르므로, 열면 왼쪽 끝(아메리카)이 보인다.
   * 서울에 앉은 회사에게 첫 화면이 시카고이면 제 노선망을 찾으러 밀어야 한다.
   */
  function centerMapOnHome() {
    const svg = document.querySelector('svg.map');
    const wrap = svg && svg.closest('.map-wrap');
    if (!wrap) return;
    const home = Cities.get(svg.dataset.home);
    if (!home) return;
    const x = Cities.project(home.lat, home.lon).x * svg.clientWidth;
    wrap.scrollLeft = Math.max(0, x - wrap.clientWidth / 2);
  }

  function renderHud(s) {
    const me = St.airline(s, ui.meId);
    const last = me.results[me.results.length - 1];
    const eq = St.equity(s, me);
    document.getElementById('hud').innerHTML = `
      <div class="hud-left">
        <div class="hud-company">${P.esc(me.name)}</div>
        <div class="hud-date">${St.yearOf(s)}년 ${St.quarterOf(s)}분기 · ${P.esc(Cities.name(me.home))}</div>
      </div>
      <div class="hud-stats">
        <div class="hud-stat"><span>현금</span><b>${SP.money(me.cash)}</b></div>
        <div class="hud-stat"><span>자기자본</span><b>${SP.money(eq)}</b></div>
        <div class="hud-stat ${last && last.net < 0 ? 'bad' : 'good'}"><span>분기 순익</span><b>${
          last ? (last.net > 0 ? '+' : '') + SP.money(last.net) : '—'
        }</b></div>
      </div>`;
  }

  function renderTabs() {
    const el = document.getElementById('tabs');
    el.innerHTML = TABS.map(
      (t) => `<button class="tab ${t.id === ui.tab ? 'on' : ''}" data-action="tab" data-tab="${t.id}">${t.name}</button>`,
    ).join('');
    const on = el.querySelector('.tab.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  /**
   * 판이 끝났는가 — 마지막 분기를 넘겼거나, 우리 회사가 접혔거나, 아직 안 골랐거나.
   *
   * 셋을 함께 봐야 한다. 달력만 보면 회사가 5년째에 접혀도 남은 60분기를 계속 넘겨야
   * "새 게임" 버튼이 나오고, 그 사이 명령은 전부 실패하므로 할 수 있는 일이 없다.
   * 회사 선택 화면에서는 아직 판이 없으므로 `s` 가 비어 있다.
   */
  function isOver(s) {
    if (!s) return true;
    const me = St.airline(s, ui.meId);
    return s.turn >= s.totalTurns || !me || !me.alive;
  }

  function renderFoot(s) {
    const foot = document.getElementById('foot');
    if (!foot || !s) return;
    if (isOver(s)) {
      const me = St.airline(s, ui.meId);
      const why = me && !me.alive ? `${P.esc(me.name)} · 파산` : `${s.startYear + Math.floor((s.totalTurns - 1) / 4)}년 · 경영 종료`;
      foot.innerHTML = `<span class="muted">${why}</span>
        <button class="next" data-action="new-game">새 게임 ▸</button>`;
      return;
    }
    const idle = St.planesOf(s, ui.meId).filter((p) => p.routeId === null).length;
    foot.innerHTML = `
      ${idle ? `<button class="todo-btn" data-action="tab" data-tab="fleet">유휴 기재 <i>${idle}</i></button>` : '<span class="muted">유휴 기재 없음</span>'}
      <button class="next foot-next" data-action="next-turn">분기 종료 ▸</button>`;
  }

  function toast(text, kind) {
    const el = document.getElementById('toast');
    el.className = 'toast show ' + (kind || '');
    el.textContent = text;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.className = 'toast'), 4200);
  }

  /** 명령 결과를 그대로 토스트로 흘려보내는 공통 래퍼. */
  function run(result) {
    if (!result) return false;
    toast(result.msg, result.ok ? 'good' : 'bad');
    if (result.ok) render();
    return result.ok;
  }

  // ─────────────────────────────── 행동 ───────────────────────────────

  function nextTurn() {
    const s = ui.state;
    if (isOver(s)) return;
    // 플레이어 회사는 AI 가 건드리지 않는다 — 방금 내린 명령이 덮어써진다.
    St.advance(s, { beforeMarket: (st, rng) => Ai.actAll(st, rng, { playerId: ui.meId }) });
    const me = St.airline(s, ui.meId);
    if (!me.alive) {
      toast('회사가 문을 닫았다.', 'bad');
    } else {
      const r = me.results[me.results.length - 1];
      if (r) toast(`${St.yearOf(s)}년 ${St.quarterOf(s)}분기 — 순익 ${(r.net > 0 ? '+' : '') + SP.money(r.net)}`, r.net >= 0 ? 'good' : 'bad');
    }
    ui.animate = 'turn';
    render();
  }

  function onClick(e) {
    const summary = e.target.closest('summary[data-fold]');
    if (summary) {
      const id = summary.dataset.fold;
      if (ui.folds.has(id)) ui.folds.delete(id);
      else ui.folds.add(id);
      return; // details 가 알아서 여닫는다 — 다시 그리면 오히려 깜빡인다
    }
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'SELECT') return;
    const d = btn.dataset;
    const s = ui.state;
    const me = ui.meId;

    // 끝난 판에서는 화면을 둘러보는 것만 된다. 안 막으면 마지막 분기를 넘긴 뒤에도
    // 기재를 사고팔아 저장된 최종 성적과 순위가 바뀐다.
    if (isOver(s) && !VIEW_ONLY.has(d.action)) {
      if (s) toast('경영이 끝났다. 기록만 볼 수 있다.', 'bad');
      return;
    }

    switch (d.action) {
      case 'pick':
        newGame(d.id);
        break;
      case 'tab':
        ui.tab = d.tab;
        ui.animate = 'tab';
        render();
        break;
      case 'next-turn':
        nextTurn();
        break;
      case 'new-game':
        // 회사 선택으로 돌아간다. 그냥 `newGame()` 을 부르면 `airlines[0]`(대한항공)이
        // 잠자코 배정되어, 다른 회사를 고른 플레이어가 다음 판을 남의 회사로 시작한다.
        chooseCompany();
        break;
      case 'fare': {
        const r = s.routes.find((x) => x.id === +d.route);
        if (r) run(A.tuneRoute(s, me, r.id, { fareMul: r.fareMul + +d.delta }));
        break;
      }
      case 'freq': {
        const r = s.routes.find((x) => x.id === +d.route);
        if (r) run(A.tuneRoute(s, me, r.id, { freq: r.freq + +d.delta }));
        break;
      }
      case 'close-route':
        run(A.closeRoute(s, me, +d.route));
        break;
      case 'sell':
        run(A.sellAircraft(s, me, +d.plane));
        break;
      case 'buy':
        run(A.buyAircraft(s, me, d.type, 1));
        break;
      case 'detach': {
        // 한 대만 빼고 나머지를 그대로 다시 배속한다 — 노선을 접었다 여는 것과 달리
        // 개설비를 다시 물지 않는다.
        const keep = St.assignedTo(s, +d.route).map((p) => p.id).filter((id) => id !== +d.plane);
        if (!keep.length) {
          toast('마지막 기재는 뗄 수 없다. 접으려면 노선을 닫아라.', 'bad');
          break;
        }
        run(A.assignPlanes(s, me, +d.route, keep));
        break;
      }
      case 'shed':
        run(A.sellSlots(s, me, d.city, +d.count));
        break;
      case 'borrow':
        run(A.borrow(s, me, +d.amount));
        break;
      case 'repay':
        run(A.repay(s, me, +d.amount));
        break;
      case 'open-route': {
        const c = SP.openCandidates(s, me).find((x) => x.from === d.from && x.to === d.to);
        if (!c) {
          toast('그 사이 조건이 바뀌었다.', 'bad');
          render();
          break;
        }
        if (c.needFrom > 0 && !run(A.buySlots(s, me, c.from, c.needFrom))) break;
        if (c.needTo > 0 && !run(A.buySlots(s, me, c.to, c.needTo))) break;
        const freq = Math.min(c.freq, A.freeSlots(s, me, c.from), A.freeSlots(s, me, c.to));
        run(A.openRoute(s, me, c.from, c.to, [c.plane.id], freq, 1));
        break;
      }
      default:
        break;
    }
  }

  function onChange(e) {
    const sel = e.target.closest('select[data-action="assign"]');
    if (!sel || !sel.value) return;
    const s = ui.state;
    const routeId = +sel.value;
    const ids = St.assignedTo(s, routeId).map((p) => p.id).concat([+sel.dataset.plane]);
    run(A.assignPlanes(s, ui.meId, routeId, ids));
  }

  // ─────────────────────────────── 저장 ───────────────────────────────

  function save() {
    try {
      // `types` 는 카탈로그에서 다시 만들 수 있다. 넣으면 세이브가 몇 배로 부풀고,
      // 무엇보다 옛 세이브가 옛 기종표를 물고 다니게 된다.
      const { types, ...rest } = ui.state;
      localStorage.setItem(SAVE_KEY, JSON.stringify({ meId: ui.meId, tab: ui.tab, state: rest }));
    } catch (err) {
      /* 사파리 프라이빗 모드 등 — 저장 못 해도 게임은 굴러간다 */
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d || !d.state || !d.state.airlines) return false;
      d.state.types = St.typeTable(d.state.programs);
      ui.state = d.state;
      ui.meId = d.meId;
      ui.tab = d.tab || 'overview';
      return true;
    } catch (err) {
      return false;
    }
  }

  function newGame(meId) {
    const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    ui.state = St.newGame(seed);
    // 부르는 쪽이 회사를 정해야 한다. 기본값을 두면 "누구를 맡았는지"가 조용히 갈린다.
    ui.meId = meId || ui.state.airlines[0].id;
    ui.tab = 'overview';
    ui.folds = new Set();
    render();
  }

  /** 어느 회사를 맡을지 고른다. 판을 열기 전에 한 번만 묻는다. */
  function chooseCompany() {
    const s = St.newGame((Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0);
    // 지난 판을 놓는다. 안 놓으면 `isOver` 가 그 판을 보고 선택 버튼까지 얼린다
    // (끝난 판의 화면을 얼리는 `.panel.over` 가 그대로 남아 클릭이 안 먹었다).
    ui.state = null;
    const panel = document.getElementById('panel');
    panel.className = 'panel';
    document.getElementById('hud').innerHTML = '<div class="hud-left"><div class="hud-company">에어라이너 — 항공사</div></div>';
    document.getElementById('tabs').innerHTML = '';
    document.getElementById('foot').innerHTML = '<span class="muted">회사를 고르면 시작한다</span>';
    panel.innerHTML = `<section class="cards"><div class="card">
      <h3>어느 회사를 맡겠는가</h3>
      <p class="muted">모기지·창업 기단·성향이 다르다. 여기서 고른 회사만 당신이 굴리고, 나머지 열한 곳은 스스로 노선망을 편다.</p>
      <ul class="lines">${s.airlines
        .map((a) => {
          const rs = St.routesOf(s, a.id).filter((r) => r.active);
          return `<li><button class="ghost wide" data-action="pick" data-id="${P.esc(a.id)}">
            <b>${P.esc(a.name)}</b>
            <span class="muted">${P.esc(Cities.name(a.home))} · 기재 ${St.planesOf(s, a.id).length}대 · 노선 ${rs.length}개 · 현금 ${SP.money(a.cash)}</span>
          </button></li>`;
        })
        .join('')}</ul>
    </div></section>`;
  }

  function boot() {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    if (load()) render();
    else chooseCompany();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  root.AirlinerSkyUi = { ui, TABS, render, nextTurn, newGame, save, load };
})(typeof globalThis !== 'undefined' ? globalThis : this);
