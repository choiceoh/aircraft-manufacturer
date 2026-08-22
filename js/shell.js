/*
 * 껍데기 — 세 가지 모드를 한 페이지에 담는다.
 *
 * 제조사 게임과 항공사 게임은 이미 같은 번들을 쓴다(`airline.html` 이 `js/engine.js`
 * 까지 통째로 싣는다). 다른 것은 어느 컨트롤러가 화면을 잡느냐 하나뿐이라, 이 파일은
 * **누가 화면을 잡을지만** 정한다. 두 컨트롤러의 내부는 건드리지 않는다.
 *
 *   제조사            기체를 만들어 판다. 열두 항공사는 공고를 내는 손님이다.
 *   항공사            기체를 사서 굴린다. 제조사는 카탈로그다.
 *   제조사 + 자체 항공사   둘 다. 한 분기 버튼이 두 계층을 함께 넘긴다.
 *
 * **통합 모드의 분기 순서는 어느 버튼을 눌렀든 같다** — 제조사를 먼저 정산하고 항공사를
 * 뒤에 정산한다. 뒤집으면 이번 분기에 인증한 기종이 항공사 발주 목록에 한 분기 늦게
 * 나타나, 같은 판인데 누른 버튼에 따라 결과가 갈린다.
 */
(function (root) {
  'use strict';

  const KEY = 'airliner.mode.v1';

  const MODES = [
    {
      id: 'maker',
      name: '제조사',
      icon: '✈️',
      layers: ['maker'],
      line: '기체를 만들어 판다',
      desc: '설계하고, 인증받고, 열두 항공사의 공고에 응찰한다. 이 게임의 원래 이야기다.',
    },
    {
      id: 'airline',
      name: '항공사',
      icon: '🛫',
      layers: ['airline'],
      line: '기체를 사서 굴린다',
      desc: '노선을 열고 운임을 정하고 슬롯을 산다. 제조사는 카탈로그일 뿐이다.',
    },
    {
      id: 'group',
      name: '제조사 + 자체 항공사',
      icon: '🏢',
      layers: ['maker', 'airline'],
      line: '만들고, 직접 굴린다',
      desc:
        '제조사를 경영하면서 그 회사가 가진 항공사의 노선망까지 직접 편다. ' +
        '자체 발주는 확정된 런치 커스터머지만, 내 항공사와 노선에서 겨루는 항공사는 나를 경쟁자로 본다.',
    },
  ];

  const shell = { mode: null, layer: null };
  /** layerId → { boot, render, turn, isOver } — 컨트롤러가 스스로 등록한다. */
  const parts = {};
  const booted = {};
  /** 통합 모드에서 한 번의 분기 넘김이 서로를 다시 부르지 않도록 잠근다. */
  let turning = false;

  const modeOf = (id) => MODES.find((m) => m.id === id) || null;

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function remember(id) {
    try {
      if (id) localStorage.setItem(KEY, id);
      else localStorage.removeItem(KEY);
    } catch (e) {
      /* 시크릿 모드 등 — 저장 실패가 게임을 막지는 않는다 */
    }
  }

  /** 이 모드에서 이 계층이 도는가. */
  function has(layer) {
    const m = modeOf(shell.mode);
    return !!m && m.layers.indexOf(layer) !== -1;
  }

  /**
   * 지금 화면을 잡고 있는 계층인가.
   *
   * 통합 모드에서는 두 컨트롤러가 다 살아 있으므로, 화면을 안 잡은 쪽이 그리거나
   * 토스트를 띄우면 남의 패널을 덮어쓴다. 두 컨트롤러의 `render`·`toast` 가 이걸 먼저 묻는다.
   */
  function isActive(layer) {
    if (!shell.mode) return false;
    return has(layer) && shell.layer === layer;
  }

  function register(layer, api) {
    parts[layer] = api;
    // 껍데기가 이미 부팅을 마친 뒤에 등록되는 경우는 없지만(스크립트 순서상 항상 먼저다),
    // 순서가 바뀌어도 조용히 죽지 않도록 여기서도 한 번 깨운다.
    if (shell.mode && has(layer) && !booted[layer]) bootLayer(layer);
  }

  function bootLayer(layer) {
    const p = parts[layer];
    if (!p || booted[layer]) return;
    booted[layer] = true;
    if (typeof p.boot === 'function') p.boot();
  }

  /**
   * 분기를 넘긴다. 어느 계층의 버튼을 눌렀든 이 함수를 지난다.
   *
   * 제조사 → 항공사 순서로 고정한다(파일 첫머리 참조). 통합 모드가 아니면 도는 계층이
   * 하나뿐이라 순서는 의미가 없다.
   */
  /**
   * 분기 넘김의 **입구**. 어느 계층의 버튼을 눌렀든 여기로 온다.
   *
   * 제조사 계층은 넘기기 전에 물어볼 것이 있다(응찰 안 한 공고, 답 안 한 결정). 그
   * 확인 절차는 모달이라 비동기다 — 확인이 끝나면 그쪽이 `turn()` 을 부른다. 항공사
   * 화면에서 눌렀다고 이 절차를 건너뛰면, 같은 통합 판인데 어느 화면에서 눌렀느냐로
   * 입찰을 조용히 포기하고 결정이 기본값으로 처리된다.
   */
  function requestTurn() {
    if (turning) return;
    const maker = parts.maker;
    if (has('maker') && maker && typeof maker.askTurn === 'function') maker.askTurn();
    else turn();
  }

  /**
   * 분기 넘김의 **본체**. 확인이 끝난 뒤에 온다.
   *
   * 제조사 → 항공사 순서로 고정한다(파일 첫머리 참조). 통합 모드가 아니면 도는 계층이
   * 하나뿐이라 순서는 의미가 없다.
   */
  function turn() {
    if (turning) return;
    turning = true;
    try {
      const group = shell.mode === 'group' ? root.AirlinerSkyGroup : null;
      const maker = parts.maker;
      const air = parts.airline;
      // 통합 모드에서만 두 계층이 서로를 본다. 규칙은 전부 `js/sky/group.js` 에 있다 —
      // 껍데기는 언제 부를지만 안다.
      if (group && maker && air) {
        group.beforeTurns(maker.state(), air.state(), air.meId());
      }
      const report = has('maker') && maker && maker.turn ? maker.turn() : null;
      if (group && maker && air) {
        group.betweenTurns(maker.state(), air.state(), air.meId(), report);
      }
      if (has('airline') && air && air.turn) air.turn();
      if (group && maker && air) {
        group.afterTurns(maker.state(), air.state(), air.meId());
      }
      // **두 계층을 다 저장한다.** 각 컨트롤러는 자기 `render` 에서만 저장하는데,
      // 화면을 안 잡은 쪽의 `render` 는 그 자리에서 돌아간다. 그대로 두면 새로고침
      // 한 번에 한쪽 계층의 분기가 통째로 사라지고 두 판의 달력이 어긋난다.
      for (const layer of Object.keys(parts)) {
        if (has(layer) && typeof parts[layer].save === 'function') parts[layer].save();
      }
    } finally {
      turning = false;
    }
    if (shell.mode === 'group') renderLayerBar();
  }

  // ─────────────────────────────── 화면 ───────────────────────────────

  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /**
   * 계층 전환 막대. 탭 위에 붙는다.
   *
   * 계층이 둘인 통합 모드에서만 전환 단추가 뜨지만, **모드로 돌아가는 길은 어느 모드에서든
   * 있어야 한다** — 없으면 한 번 고른 모드에 갇힌다.
   */
  function renderLayerBar() {
    const bar = document.getElementById('layers');
    const m = modeOf(shell.mode);
    if (!bar) return;
    if (!m) {
      bar.innerHTML = '';
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const tabs =
      m.layers.length < 2
        ? `<span class="layer-name">${esc(m.icon)} ${esc(m.name)}</span>`
        : m.layers
            .map((id) => {
              const label = id === 'maker' ? '제조사' : '항공사';
              return `<button class="layer ${id === shell.layer ? 'on' : ''}" data-shell="layer" data-layer="${id}">${label}</button>`;
            })
            .join('');
    bar.innerHTML = `${tabs}<button class="layer alt" data-shell="pick-mode" title="모드 다시 고르기">모드 ▾</button>`;
  }

  function showLayer(layer) {
    if (!has(layer) || shell.layer === layer) return;
    shell.layer = layer;
    renderLayerBar();
    reveal(layer);
  }

  /** 계층이 화면을 잡았다. `show` 가 있으면 그쪽이 우선이다(판을 아직 안 연 계층이 있다). */
  function reveal(layer) {
    const p = parts[layer];
    if (!p || !booted[layer]) return;
    if (typeof p.show === 'function') p.show();
    else if (typeof p.render === 'function') p.render();
  }

  /**
   * 두 계층의 달력이 맞는가 — 통합 모드로 들어갈 때만 묻는다.
   *
   * 두 모드를 따로 굴리다 통합으로 들어오면, 10분기짜리 제조사와 갓 시작한 항공사가
   * 한 판으로 묶인다. 그때부터 매 분기 두 해가 어긋난 채 흐르고, 2000년대 시장·프로그램이
   * 1998년 분기로 복사된다. 조용히 그렇게 두지 않는다.
   */
  function turnOf(layer) {
    const p = parts[layer];
    if (!p || typeof p.state !== 'function') return 0;
    const st = p.state();
    return st && typeof st.turn === 'number' ? st.turn : 0;
  }

  function calendarsAligned() {
    return turnOf('maker') === turnOf('airline');
  }

  /** 달력이 어긋났을 때 — 새 통합 판을 열 것인지 묻는다. 판을 임의로 지우지 않는다. */
  function renderMismatch() {
    const panel = document.getElementById('panel');
    const foot = document.getElementById('foot');
    if (foot) foot.innerHTML = '<span class="muted">통합 판을 열려면 두 판이 같은 분기에서 시작해야 한다</span>';
    if (!panel) return;
    panel.className = 'panel';
    const y = (t) => 1998 + Math.floor(t / 4);
    panel.innerHTML = `<section class="cards"><div class="card full">
      <h3>두 판의 달력이 어긋나 있다</h3>
      <p class="muted">제조사는 <b>${y(turnOf('maker'))}년</b>, 항공사는 <b>${y(turnOf('airline'))}년</b>에 있다.
      통합 모드는 두 계층이 같은 분기를 함께 넘기는 판이라, 이대로 묶으면 매 분기 두 해가 어긋난 채 흐르고
      한쪽 시장이 다른 쪽의 지난 연도로 복사된다.</p>
      <p class="muted">새 통합 판을 열면 <b>양쪽의 저장된 경영이 지워진다.</b> 그대로 두려면 제조사나 항공사 모드로 돌아가라.</p>
      <div class="row">
        <button class="primary" data-shell="new-group">새 통합 판 시작</button>
        <button class="ghost" data-shell="pick-mode">모드로 돌아가기</button>
      </div>
    </div></section>`;
  }

  /** 양쪽 세이브를 지우고 통합 판을 처음부터 연다. */
  function startFreshGroup() {
    for (const layer of ['maker', 'airline']) {
      const p = parts[layer];
      if (p && typeof p.clearSave === 'function') p.clearSave();
    }
    remember('group');
    location.reload();
  }

  /** 모드를 안 골랐을 때의 첫 화면. */
  function renderPicker() {
    const panel = document.getElementById('panel');
    const hud = document.getElementById('hud');
    const tabs = document.getElementById('tabs');
    const foot = document.getElementById('foot');
    if (hud) hud.innerHTML = '<div class="hud-left"><div class="hud-company">에어라이너</div><div class="hud-date">1998 — 2017 · 20년</div></div>';
    if (tabs) tabs.innerHTML = '';
    if (foot) foot.innerHTML = '<span class="muted">모드를 고르면 시작한다</span>';
    renderLayerBar();
    if (!panel) return;
    panel.className = 'panel';
    panel.innerHTML = `<section class="cards"><div class="card full">
      <h3>무엇을 경영하겠는가</h3>
      <p class="muted">같은 세계, 같은 20년, 같은 기체다. 어느 쪽에 앉느냐만 다르다. 나중에 바꿀 수 있다.</p>
      <ul class="modes">${MODES.map(
        (m) => `<li><button class="ghost wide mode" data-shell="mode" data-mode="${esc(m.id)}">
          <b><span class="mode-icon" aria-hidden="true">${m.icon}</span> ${esc(m.name)}</b>
          <span class="mode-line">${esc(m.line)}</span>
          <span class="muted">${esc(m.desc)}</span>
        </button></li>`,
      ).join('')}</ul>
    </div></section>`;
  }

  /** 모드를 고른다. 이미 고른 모드를 다시 고르면 아무 일도 없다. */
  function choose(id) {
    const m = modeOf(id);
    if (!m || shell.mode === id) return;
    shell.mode = id;
    shell.layer = m.layers[0];
    remember(id);
    renderLayerBar();
    for (const layer of m.layers) bootLayer(layer);
    if (id === 'group' && !calendarsAligned()) {
      renderMismatch();
      return;
    }
    reveal(shell.layer);
  }

  /**
   * 모드를 다시 고른다. 판은 지우지 않는다 — 각 계층의 세이브는 그대로 남아 있어서,
   * 돌아오면 하던 경영을 이어서 한다.
   */
  function reset() {
    shell.mode = null;
    shell.layer = null;
    remember(null);
    renderPicker();
  }

  function onClick(e) {
    const el = e.target.closest('[data-shell]');
    if (!el) return;
    const kind = el.dataset.shell;
    if (kind === 'mode') {
      e.preventDefault();
      choose(el.dataset.mode);
    } else if (kind === 'layer') {
      e.preventDefault();
      showLayer(el.dataset.layer);
    } else if (kind === 'pick-mode') {
      e.preventDefault();
      reset();
    } else if (kind === 'new-group') {
      e.preventDefault();
      startFreshGroup();
    }
  }

  function boot() {
    document.addEventListener('click', onClick);
    const saved = stored();
    if (modeOf(saved)) {
      const m = modeOf(saved);
      shell.mode = m.id;
      shell.layer = m.layers[0];
      renderLayerBar();
      for (const layer of m.layers) bootLayer(layer);
      // 저장된 통합 판을 다시 열 때도 달력을 확인한다 — 다른 탭에서 한쪽만 굴렸을 수 있다.
      if (m.id === 'group' && !calendarsAligned()) renderMismatch();
    } else {
      renderPicker();
    }
  }

  root.AirlinerShell = { MODES, shell, register, has, isActive, turn, requestTurn, choose, reset, showLayer, boot };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
