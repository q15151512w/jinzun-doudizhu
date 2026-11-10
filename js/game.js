/* ============================================================
   金樽牌局 · 游戏主流程
   叫分 → 出牌 → 结算，渲染、动效与本地存档
   ============================================================ */
(function () {
  'use strict';

  const C = window.Cards;
  const AI = window.AI;
  const S = window.Sound;

  const HUMAN = 0;
  const NAMES = ['你', '听雨', '松风'];
  const GAME_KEY = 'jinzun.ddz.game.v1';

  const $ = (id) => document.getElementById(id);

  /* ------------------------- persistent data ------------------------- */

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(GAME_KEY) || '{}'); } catch (e) { saved = {}; }

  const initialChips = Number.isFinite(saved.chips) ? saved.chips : 2000;

  const state = {
    phase: 'lobby',                 // lobby | bidding | waiting | playing | between | over
    paused: false,
    pausedQueue: [],
    players: [0, 1, 2].map((i) => ({ index: i, hand: [], plays: 0, landlord: false })),
    bottom: [],
    landlord: -1,
    baseScore: 0,
    multiplier: 1,
    current: -1,
    lastPlay: null,
    consecutivePasses: 0,
    bidHighest: 0,
    bidWinner: -1,
    bidCount: 0,
    selected: new Set(),
    hints: [],
    hintIndex: 0,
    fresh: new Set(),
    chips: initialChips,
    rounds: Number.isFinite(saved.rounds) ? saved.rounds : 0,
    wins: Number.isFinite(saved.wins) ? saved.wins : 0
  };

  const timers = new Set();
  const speechTimers = { 1: null, 2: null };
  let toastTimer = null;

  const dom = {};
  const oppUI = {};
  const playZones = {};

  /* ------------------------- timer helpers ------------------------- */

  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      if (state.paused) {
        state.pausedQueue.push(fn);
        return;
      }
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
    state.pausedQueue = [];
  }

  /* ------------------------- card markup ------------------------- */

  function cardMarkup(card, opts) {
    opts = opts || {};
    const classes = ['card'];
    if (card.red) classes.push('red');
    if (card.joker) classes.push('joker');
    if (card.label === '10') classes.push('low');
    if (opts.extra) classes.push(opts.extra);
    const styleAttr = opts.style ? ` style="${opts.style}"` : '';

    if (card.joker) {
      const big = card.rank === 17;
      const corner = (br) => `
        <div class="c-corner${br ? ' c-br' : ''}">
          <span class="c-rank" style="font-family:var(--font-display);font-size:calc(var(--cw) * 0.22)">${big ? '大' : '小'}</span>
          <span class="c-suit" style="font-size:calc(var(--cw) * 0.18)">王</span>
        </div>`;
      return `<div class="${classes.join(' ')}" data-id="${card.id}"${styleAttr}>
        ${corner(false)}
        <div class="c-mid"><span class="joker-star">✦</span><span class="joker-vert">JOKER</span></div>
        ${corner(true)}
      </div>`;
    }

    const corner = (br) => `
      <div class="c-corner${br ? ' c-br' : ''}">
        <span class="c-rank">${card.label}</span>
        <span class="c-suit">${card.suit}</span>
      </div>`;

    return `<div class="${classes.join(' ')}" data-id="${card.id}"${styleAttr}>
      ${corner(false)}
      <div class="c-mid">${card.suit}</div>
      ${corner(true)}
    </div>`;
  }

  /* ------------------------- rendering ------------------------- */

  function fmt(n) {
    return n.toLocaleString('zh-CN');
  }

  function updateChips() {
    dom.chips.textContent = fmt(state.chips);
    dom.meChips.textContent = fmt(state.chips);
  }

  function updateHUD() {
    dom.baseScore.textContent = state.baseScore || '—';
    dom.multiplier.textContent = '×' + (state.multiplier || 1);
  }

  function renderHand(animateDeal) {
    const hand = state.players[HUMAN].hand;
    const n = hand.length;
    dom.hand.classList.toggle('deal-anim', !!animateDeal);
    dom.hand.innerHTML = hand.map((card, i) => {
      const t = n <= 1 ? 0 : i / (n - 1) - 0.5;
      const rot = t * Math.min(11, n * 0.62);
      const dy = Math.abs(t) * 8;
      const style = `--rot:${rot.toFixed(2)}deg;--dy:${dy.toFixed(1)}px;--deal-delay:${Math.min(i * 28, 480)}ms;z-index:${i + 1}`;
      let extra = '';
      if (state.selected.has(card.id)) extra += ' selected';
      if (state.fresh.has(card.id)) extra += ' fresh';
      return cardMarkup(card, { style, extra });
    }).join('');
  }

  function syncSelection() {
    dom.hand.querySelectorAll('.card').forEach((el) => {
      const id = Number(el.dataset.id);
      el.classList.toggle('selected', state.selected.has(id));
    });
    updatePlayButtons();
    updateSelectionStatus();
  }

  function updateCounts() {
    for (const idx of [1, 2]) {
      oppUI[idx].count.textContent = state.players[idx].hand.length;
    }
  }

  function renderRoles() {
    for (const idx of [1, 2]) {
      const el = oppUI[idx].role;
      if (state.landlord < 0) {
        el.textContent = '待定';
        el.className = 'p-role pending';
      } else if (state.landlord === idx) {
        el.textContent = '地主';
        el.className = 'p-role landlord';
      } else {
        el.textContent = '农民';
        el.className = 'p-role';
      }
    }
    const role = dom.meRole;
    if (state.landlord < 0) {
      role.textContent = '待定';
      role.className = 'p-role inline pending';
    } else if (state.landlord === HUMAN) {
      role.textContent = '地主';
      role.className = 'p-role inline landlord';
    } else {
      role.textContent = '农民';
      role.className = 'p-role inline';
    }
  }

  function renderBottomCards(faceUp) {
    dom.bcRow.innerHTML = state.bottom.map((card) => {
      if (!faceUp) return '<div class="card-back"></div>';
      return cardMarkup(card);
    }).join('');
  }

  function setActive(idx) {
    dom.meAvatar.classList.toggle('active', idx === HUMAN);
    for (const i of [1, 2]) {
      oppUI[i].avatar.classList.toggle('active', idx === i);
    }
  }

  function say(idx, text, ms) {
    if (idx === HUMAN) return;
    const ui = oppUI[idx];
    if (!ui) return;
    if (speechTimers[idx]) clearTimeout(speechTimers[idx]);
    ui.speech.textContent = text;
    ui.speech.classList.add('show');
    speechTimers[idx] = setTimeout(() => {
      ui.speech.classList.remove('show');
      speechTimers[idx] = null;
    }, ms || 1700);
  }

  function showToast(text, ms) {
    if (!dom.toast) return;
    if (toastTimer) clearTimeout(toastTimer);
    dom.toast.textContent = text;
    dom.toast.classList.add('show');
    toastTimer = setTimeout(() => {
      dom.toast.classList.remove('show');
      toastTimer = null;
    }, ms || 2100);
  }

  function showPlay(idx, cards, info) {
    const zone = playZones[idx];
    if (!zone) return;
    const danger = info.type === 'bomb' || info.type === 'rocket';
    zone.innerHTML = `
      <div class="play-cards">${C.sortCards(cards).map((c) => cardMarkup(c)).join('')}</div>
      <div class="combo-tag${danger ? ' danger' : ''}">${info.name}</div>`;
  }

  function clearPlayZone(idx) {
    if (playZones[idx]) playZones[idx].innerHTML = '';
  }

  function clearAllZones() {
    [0, 1, 2].forEach(clearPlayZone);
  }

  function setTurnStatus(text, urgent) {
    dom.turnStatus.textContent = text;
    dom.turnStatus.classList.toggle('urgent', !!urgent);
  }

  /* ------------------------- action bar ------------------------- */

  function renderBidActions() {
    if (state.phase !== 'bidding' || state.current !== HUMAN) {
      dom.actions.innerHTML = '';
      return;
    }
    const max = state.bidHighest;
    dom.actions.innerHTML = [
      `<button class="btn ghost" data-bid="0">不叫</button>`,
      [1, 2, 3].map((n) =>
        `<button class="btn ${n === 3 ? 'primary' : 'ghost'} bid-btn" data-bid="${n}" ${n <= max ? 'disabled' : ''}>${n}<small>分</small></button>`
      ).join('')
    ].join('');
    setTurnStatus(`轮到你叫分${max ? ` · 当前最高 ${max} 分` : ''}`, true);
    S.turn();
  }

  function renderPlayActions() {
    if (state.phase !== 'playing' || state.current !== HUMAN) {
      dom.actions.innerHTML = '';
      return;
    }
    const canPass = !!state.lastPlay;
    dom.actions.innerHTML = `
      ${canPass ? '<button class="btn ghost" data-act="pass">不出</button>' : ''}
      <button class="btn ghost" data-act="hint">提示</button>
      <button class="btn primary" data-act="play" ${state.selected.size ? '' : 'disabled'}>出牌</button>`;
    updateSelectionStatus();
  }

  function updatePlayButtons() {
    const btn = dom.actions.querySelector('[data-act="play"]');
    if (btn) btn.disabled = state.selected.size === 0;
  }

  function selectedCards() {
    const hand = state.players[HUMAN].hand;
    return hand.filter((c) => state.selected.has(c.id));
  }

  function updateSelectionStatus() {
    if (state.phase !== 'playing' || state.current !== HUMAN) return;
    const cards = selectedCards();
    if (!cards.length) {
      setTurnStatus(state.lastPlay ? '轮到你出牌' : '由你先出牌', true);
      return;
    }
    const info = C.analyze(cards);
    if (!info) {
      setTurnStatus(`已选 ${cards.length} 张 · 牌型不成立`, true);
    } else if (state.lastPlay && !C.beats(info, state.lastPlay.info)) {
      setTurnStatus(`${info.name} · 压不过上家`, true);
    } else {
      setTurnStatus(`${info.name} · ${cards.length} 张`, true);
    }
  }

  /* ------------------------- round lifecycle ------------------------- */

  function newRound() {
    clearTimers();
    state.paused = false;
    state.pausedQueue = [];
    state.phase = 'bidding';
    state.players.forEach((p) => {
      p.hand = [];
      p.plays = 0;
      p.landlord = false;
    });
    state.bottom = [];
    state.landlord = -1;
    state.baseScore = 0;
    state.multiplier = 1;
    state.lastPlay = null;
    state.consecutivePasses = 0;
    state.bidHighest = 0;
    state.bidWinner = -1;
    state.bidCount = 0;
    state.selected.clear();
    state.hints = [];
    state.hintIndex = 0;
    state.fresh.clear();

    clearAllZones();
    for (const idx of [1, 2]) {
      oppUI[idx].speech.classList.remove('show');
    }

    const deck = C.shuffle(C.createDeck());
    for (let i = 0; i < 3; i++) {
      state.players[i].hand = C.sortCards(deck.slice(i * 17, i * 17 + 17));
    }
    state.bottom = deck.slice(51);

    renderHand(true);
    updateCounts();
    renderRoles();
    renderBottomCards(false);
    updateHUD();
    updateChips();

    dom.actions.innerHTML = '';
    const starter = Math.floor(Math.random() * 3);
    state.current = starter;
    setActive(starter);
    setTurnStatus(`${NAMES[starter]} 先叫分`, false);

    // 发牌音效
    [0, 130, 260, 390].forEach((t) => setTimeout(() => S.deal(), t));

    showToast('叫分开始 · 三分即为地主');

    if (starter === HUMAN) {
      renderBidActions();
    } else {
      turnStatusForAIBid(starter);
      scheduleAIBid(starter);
    }
  }

  function turnStatusForAIBid(idx) {
    setTurnStatus(`${NAMES[idx]} 正在叫分…`, false);
  }

  function scheduleAIBid(idx) {
    later(() => {
      if (state.phase !== 'bidding' || state.current !== idx) return;
      const wanted = AI.decideBid(state.players[idx].hand, state.bidHighest);
      doBid(idx, wanted);
    }, 750 + Math.random() * 900);
  }

  function doBid(idx, score) {
    if (state.phase !== 'bidding') return;
    state.bidCount++;

    if (score > 0 && score > state.bidHighest) {
      state.bidHighest = score;
      state.bidWinner = idx;
      S.bid(score);
      say(idx, score === 3 ? '叫三分！' : `叫 ${score} 分`);
    } else {
      score = 0;
      S.pass();
      say(idx, '不叫');
    }

    if (score === 3 || state.bidCount >= 3) {
      dom.actions.innerHTML = '';
      setTurnStatus('揭晓地主…', false);
      later(finishBidding, 800);
      return;
    }

    state.current = (state.current + 1) % 3;
    setActive(state.current);
    if (state.current === HUMAN) {
      renderBidActions();
    } else {
      dom.actions.innerHTML = '';
      turnStatusForAIBid(state.current);
      scheduleAIBid(state.current);
    }
  }

  function finishBidding() {
    if (state.phase !== 'bidding') return;

    if (state.bidWinner < 0) {
      state.phase = 'between';
      setActive(-1);
      setTurnStatus('无人叫地主，重新发牌…', false);
      showToast('无人叫地主 · 重新发牌');
      later(newRound, 1700);
      return;
    }

    const winner = state.bidWinner;
    state.phase = 'waiting';
    state.landlord = winner;
    state.baseScore = state.bidHighest;
    state.players[winner].landlord = true;
    state.players[winner].hand = C.sortCards([...state.players[winner].hand, ...state.bottom]);

    state.fresh = new Set(state.bottom.map((c) => c.id));
    renderBottomCards(true);
    renderRoles();
    renderHand(false);
    updateCounts();
    updateHUD();
    dom.actions.innerHTML = '';
    setActive(winner);
    setTurnStatus(`${NAMES[winner]} 成为地主`, false);
    showToast(`${NAMES[winner]} 成为地主 · 底分 ${state.baseScore}`);
    S.chip();

    later(() => {
      state.phase = 'playing';
      state.current = winner;
      state.fresh.clear();
      beginTurn();
    }, 1200);
  }

  function beginTurn() {
    if (state.phase !== 'playing') return;

    if (state.lastPlay && state.consecutivePasses >= 2) {
      state.lastPlay = null;
      state.consecutivePasses = 0;
      clearAllZones();
    }

    state.selected.clear();
    state.hints = [];
    state.hintIndex = 0;
    syncSelection();

    const idx = state.current;
    setActive(idx);

    if (idx === HUMAN) {
      renderPlayActions();
      if (!state.paused) S.turn();
    } else {
      dom.actions.innerHTML = '';
      setTurnStatus(`${NAMES[idx]} 思考中…`, false);
      scheduleAITurn(idx);
    }
  }

  function scheduleAITurn(idx) {
    const player = state.players[idx];
    const last = state.lastPlay;
    const ctx = {
      self: idx,
      lastPlayer: last ? last.player : -1,
      landlord: state.landlord,
      counts: state.players.map((p) => p.hand.length)
    };
    const move = AI.choosePlay(player.hand, last, ctx);
    const delay = AI.thinkTime(move);

    later(() => {
      if (state.phase !== 'playing' || state.current !== idx) return;
      if (move && C.beats(move.info, state.lastPlay ? state.lastPlay.info : null)) {
        commitPlay(idx, move.cards);
      } else if (state.lastPlay) {
        doPass(idx);
      } else {
        // 理论上不会发生：领出必须有牌可出
        const fallback = C.generateMoves(player.hand);
        if (fallback.length) commitPlay(idx, fallback[0].cards);
      }
    }, delay);
  }

  /* ------------------------- actions ------------------------- */

  function commitPlay(idx, cards) {
    if (state.phase !== 'playing') return;
    const player = state.players[idx];
    const info = C.analyze(cards);
    if (!info) {
      if (idx === HUMAN) showToast('不是有效牌型');
      return;
    }
    const lastInfo = state.lastPlay ? state.lastPlay.info : null;
    if (!C.beats(info, lastInfo)) {
      if (idx === HUMAN) showToast('这手牌压不过上家');
      return;
    }

    player.hand = C.removeCards(player.hand, cards);
    player.plays++;

    state.lastPlay = { player: idx, cards: C.sortCards(cards), info };
    state.consecutivePasses = 0;
    state.selected.clear();

    if (idx === HUMAN) {
      renderHand(false);
    } else {
      updateCounts();
    }
    showPlay(idx, cards, info);

    if (info.type === 'bomb' || info.type === 'rocket') {
      state.multiplier *= 2;
      updateHUD();
      playBombFX(info.type);
    } else {
      S.play();
    }

    if (player.hand.length === 0) {
      endRound(idx);
      return;
    }

    dom.actions.innerHTML = '';
    if (idx === HUMAN) {
      setTurnStatus('出牌成功', false);
    } else {
      setTurnStatus(`${NAMES[idx]} 出了 ${info.name}`, false);
    }

    state.current = (idx + 1) % 3;
    later(beginTurn, 620);
  }

  function doPass(idx) {
    if (state.phase !== 'playing') return;
    if (!state.lastPlay) {
      if (idx === HUMAN) showToast('你先手，必须出牌');
      return;
    }

    state.consecutivePasses++;
    say(idx, '不出');
    S.pass();
    clearPlayZone(idx);

    if (idx === HUMAN) {
      state.selected.clear();
      syncSelection();
    }

    dom.actions.innerHTML = '';
    setTurnStatus(`${NAMES[idx]} 不出`, false);
    state.current = (idx + 1) % 3;
    later(beginTurn, 650);
  }

  function humanPlay() {
    if (state.phase !== 'playing' || state.current !== HUMAN) return;
    const cards = selectedCards();
    if (!cards.length) {
      showToast('请先选牌');
      return;
    }
    const info = C.analyze(cards);
    if (!info) {
      showToast('这副牌型不成立');
      return;
    }
    if (!C.beats(info, state.lastPlay ? state.lastPlay.info : null)) {
      showToast('压不过上家，换一手吧');
      return;
    }
    S.click();
    commitPlay(HUMAN, cards);
  }

  function humanPass() {
    if (state.phase !== 'playing' || state.current !== HUMAN) return;
    if (!state.lastPlay) {
      showToast('你先手，必须出牌');
      return;
    }
    S.click();
    doPass(HUMAN);
  }

  function humanHint() {
    if (state.phase !== 'playing' || state.current !== HUMAN) return;
    if (!state.hints.length) {
      state.hints = C.findBeatingMoves(
        state.players[HUMAN].hand,
        state.lastPlay ? state.lastPlay.info : null
      );
      state.hintIndex = 0;
    }
    if (!state.hints.length) {
      showToast(state.lastPlay ? '没有能压过的牌，只能不出' : '没有可出的牌');
      return;
    }
    const move = state.hints[state.hintIndex % state.hints.length];
    state.hintIndex++;
    state.selected = new Set(move.cards.map((c) => c.id));
    syncSelection();
    S.select();
    showToast(`提示 · ${move.info.name}`);
  }

  /* ------------------------- effects ------------------------- */

  function playBombFX(type) {
    const rocket = type === 'rocket';
    const fx = document.createElement('div');
    fx.className = rocket ? 'fx-sweep' : 'fx-flash';
    document.body.appendChild(fx);
    setTimeout(() => fx.remove(), 900);

    dom.table.classList.remove('shake');
    // 强制重排以便重复播放
    void dom.table.offsetWidth;
    dom.table.classList.add('shake');
    setTimeout(() => dom.table.classList.remove('shake'), 650);

    if (rocket) S.rocket();
    else S.bomb();
  }

  function burstConfetti() {
    const wrap = dom.confetti;
    wrap.innerHTML = '';
    const colors = ['#d9b878', '#f3dfad', '#57c2a0', '#c7574a', '#e8cd93', '#f6efe0'];
    for (let i = 0; i < 90; i++) {
      const el = document.createElement('i');
      el.style.left = (Math.random() * 100).toFixed(2) + '%';
      el.style.background = colors[i % colors.length];
      el.style.width = (4 + Math.random() * 6).toFixed(1) + 'px';
      el.style.height = (7 + Math.random() * 9).toFixed(1) + 'px';
      el.style.setProperty('--dx', (Math.random() * 220 - 110).toFixed(0) + 'px');
      el.style.setProperty('--rot', (360 + Math.random() * 900).toFixed(0) + 'deg');
      el.style.setProperty('--dur', (2.6 + Math.random() * 2.2).toFixed(2) + 's');
      el.style.setProperty('--delay', (Math.random() * 0.5).toFixed(2) + 's');
      wrap.appendChild(el);
    }
    setTimeout(() => { wrap.innerHTML = ''; }, 5500);
  }

  /* ------------------------- round end ------------------------- */

  function endRound(winnerIdx) {
    if (state.phase === 'over') return;
    state.phase = 'over';
    clearTimers();
    setActive(-1);
    dom.actions.innerHTML = '';
    setTurnStatus('本局终了', false);

    const landlord = state.landlord;
    const landlordWon = winnerIdx === landlord;
    const farmersPlays = state.players.reduce(
      (sum, p, i) => (i === landlord ? sum : sum + p.plays), 0
    );

    let springLabel = '—';
    if (landlordWon && farmersPlays === 0) {
      springLabel = '春天 ×2';
      state.multiplier *= 2;
    } else if (!landlordWon && state.players[landlord].plays === 1) {
      springLabel = '反春天 ×2';
      state.multiplier *= 2;
    }

    updateHUD();

    const humanIsLandlord = landlord === HUMAN;
    const humanWon = humanIsLandlord ? landlordWon : !landlordWon;
    const points = state.baseScore * state.multiplier;
    const delta = (humanWon ? 1 : -1) * points * (humanIsLandlord ? 2 : 1);

    state.chips += delta;
    state.rounds++;
    if (humanWon) state.wins++;

    updateChips();
    saveGame();

    later(() => {
      S[humanWon ? 'win' : 'lose']();
      if (humanWon) S.chip();
    }, 350);

    later(() => {
      showResult({
        winnerIdx,
        landlordWon,
        humanWon,
        humanIsLandlord,
        springLabel,
        delta
      });
    }, 1250);
  }

  function showResult(data) {
    dom.resultTitle.textContent = data.landlordWon ? '地主胜' : '农民胜';
    dom.resultTitle.classList.toggle('lose', !data.humanWon);
    dom.resultKicker.textContent = `${NAMES[data.winnerIdx]} 先走完手牌`;

    let sub;
    if (data.humanWon) {
      sub = data.humanIsLandlord ? '坐庄成功 · 通吃两家' : '与队友守住牌桌';
    } else {
      sub = data.humanIsLandlord ? '庄家失守 · 农民翻身' : '地主通吃 · 下局再战';
    }
    dom.resultSub.textContent = sub;

    dom.rsBase.textContent = state.baseScore;
    dom.rsMult.textContent = '×' + state.multiplier;
    dom.rsSpring.textContent = data.springLabel;

    dom.resultDelta.textContent = (data.delta >= 0 ? '+' : '') + fmt(data.delta);
    dom.resultDelta.classList.toggle('lose', data.delta < 0);

    dom.resultRecord.textContent =
      `累计 ${state.wins} 胜 / ${state.rounds} 局 · 玉筹 ${fmt(state.chips)}`;

    dom.resultOverlay.classList.add('show');
    if (data.humanWon) burstConfetti();
  }

  function saveGame() {
    try {
      localStorage.setItem(GAME_KEY, JSON.stringify({
        chips: state.chips,
        rounds: state.rounds,
        wins: state.wins
      }));
    } catch (e) { /* noop */ }
  }

  /* ------------------------- sound UI ------------------------- */

  function syncSoundUI() {
    dom.btnMusic.classList.toggle('muted', !S.isMusicOn());
    dom.btnSfx.classList.toggle('muted', !S.isSfxOn());
    dom.btnMusic.title = S.isMusicOn() ? '音乐：开' : '音乐：关';
    dom.btnSfx.title = S.isSfxOn() ? '音效：开' : '音效：关';
  }

  /* ------------------------- guide & overlays ------------------------- */

  function openGuide() {
    dom.guideOverlay.classList.add('show');
    if (['bidding', 'waiting', 'playing'].includes(state.phase)) {
      state.paused = true;
    }
  }

  function closeGuide() {
    dom.guideOverlay.classList.remove('show');
    if (state.paused) {
      state.paused = false;
      const queue = state.pausedQueue.splice(0);
      queue.forEach((fn, i) => later(fn, 120 + i * 320));
    }
  }

  function startGame() {
    S.unlock();
    if (S.isMusicOn()) S.startMusic();
    dom.startOverlay.classList.remove('show');
    dom.resultOverlay.classList.remove('show');
    newRound();
  }

  function goLobby() {
    dom.resultOverlay.classList.remove('show');
    dom.confetti.innerHTML = '';
    state.phase = 'lobby';
    clearTimers();
    dom.startOverlay.classList.add('show');
  }

  /* ------------------------- events ------------------------- */

  function cacheDom() {
    Object.assign(dom, {
      chips: $('chips'),
      meChips: $('meChips'),
      baseScore: $('baseScore'),
      multiplier: $('multiplier'),
      bcRow: $('bcRow'),
      hand: $('hand'),
      actions: $('actions'),
      turnStatus: $('turnStatus'),
      meAvatar: $('meAvatar'),
      meRole: $('meRole'),
      toast: $('toast'),
      table: $('table'),
      startOverlay: $('startOverlay'),
      guideOverlay: $('guideOverlay'),
      resultOverlay: $('resultOverlay'),
      resultTitle: $('resultTitle'),
      resultKicker: $('resultKicker'),
      resultSub: $('resultSub'),
      resultDelta: $('resultDelta'),
      resultRecord: $('resultRecord'),
      rsBase: $('rsBase'),
      rsMult: $('rsMult'),
      rsSpring: $('rsSpring'),
      confetti: $('confetti'),
      btnMusic: $('btn-music'),
      btnSfx: $('btn-sfx'),
      btnGuide: $('btn-guide'),
      btnStart: $('btn-start'),
      btnStartGuide: $('btn-start-guide'),
      btnGuideClose: $('btn-close-guide'),
      btnGuideOk: $('btn-guide-ok'),
      btnAgain: $('btn-again'),
      btnLobby: $('btn-lobby')
    });

    oppUI[1] = {
      avatar: $('oppLeftAvatar'),
      name: $('oppLeftName'),
      role: $('oppLeftRole'),
      count: $('oppLeftCount'),
      speech: $('oppLeftSpeech')
    };
    oppUI[2] = {
      avatar: $('oppRightAvatar'),
      name: $('oppRightName'),
      role: $('oppRightRole'),
      count: $('oppRightCount'),
      speech: $('oppRightSpeech')
    };
    playZones[0] = $('playHuman');
    playZones[1] = $('playLeft');
    playZones[2] = $('playRight');

    dom.btnStartGuide = $('btn-start-guide');
  }

  function bindEvents() {
    dom.btnStart.addEventListener('click', startGame);

    dom.actions.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      if (btn.dataset.bid !== undefined) {
        if (state.phase !== 'bidding' || state.current !== HUMAN) return;
        S.click();
        doBid(HUMAN, Number(btn.dataset.bid));
        return;
      }
      const act = btn.dataset.act;
      if (act === 'play') humanPlay();
      else if (act === 'pass') humanPass();
      else if (act === 'hint') humanHint();
    });

    dom.hand.addEventListener('click', (e) => {
      if (state.phase !== 'playing' || state.current !== HUMAN || state.paused) return;
      const el = e.target.closest('.card');
      if (!el) return;
      const id = Number(el.dataset.id);
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      el.classList.toggle('selected', state.selected.has(id));
      S.select();
      updatePlayButtons();
      updateSelectionStatus();
    });

    dom.btnMusic.addEventListener('click', () => {
      S.unlock();
      const on = !S.isMusicOn();
      S.setMusicEnabled(on);
      if (on) {
        S.startMusic();
        S.click();
      }
      syncSoundUI();
    });

    dom.btnSfx.addEventListener('click', () => {
      S.unlock();
      const on = !S.isSfxOn();
      S.setSfxEnabled(on);
      if (on) S.click();
      syncSoundUI();
    });

    dom.btnGuide.addEventListener('click', openGuide);
    dom.btnGuideClose.addEventListener('click', closeGuide);
    dom.btnGuideOk.addEventListener('click', closeGuide);
    if (dom.btnStartGuide) dom.btnStartGuide.addEventListener('click', openGuide);
    dom.guideOverlay.addEventListener('click', (e) => {
      if (e.target === dom.guideOverlay) closeGuide();
    });

    dom.btnAgain.addEventListener('click', () => {
      dom.resultOverlay.classList.remove('show');
      dom.confetti.innerHTML = '';
      newRound();
    });

    dom.btnLobby.addEventListener('click', goLobby);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dom.guideOverlay.classList.contains('show')) {
        closeGuide();
      }
    });

  }

  function init() {
    cacheDom();
    bindEvents();
    oppUI[1].name.textContent = NAMES[1];
    oppUI[2].name.textContent = NAMES[2];
    updateChips();
    updateHUD();
    renderRoles();
    syncSoundUI();
    dom.startOverlay.classList.add('show');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
