/**
 * dsh-quote —— 客户端脚本（由宿主插件作为 /dsh-quote/quote.js 原样提供）
 *
 * 功能：在对话区划选任意文字 → 浮出「引用」按钮 → 点击后把选中的文字
 *       以【引用】前缀插入到输入框，并把光标停在末尾。
 *
 * 依赖的 DOM 契约（来自 dsh-client-ui-conversation 的 ComposerContentEditable）：
 *   <div contenteditable role="textbox" data-composer-input aria-multiline="true">
 * 该编辑器是 Lexical，所以用 document.execCommand('insertText') 插入 ——
 * 它会产生真实的 beforeinput/input 事件，编辑器状态机会正常接收。
 */
(function () {
  if (window.__dshQuoteWidget) return;
  window.__dshQuoteWidget = true;

  // ─────────────────────────── 可调参数 ───────────────────────────
  var MARK = '\u275D';            // 插入输入框的引用标记前缀（❝）
  var STORE_URL = '/dsh-quote/store';  // 引用原文上传接口
  var QUOTE_PREFIX = '【引用】';   // 上传失败时的兜底前缀（直接插原文）
  var MAX_LEN = 4000;             // 单条引用最大长度（超出截断）
  var GAP = 8;                    // 按钮与选区之间的间距(px)
  // ────────────────────────────────────────────────────────────────

  var BTN_ID = 'dsh-quote-btn';

  // ---- 样式 ----
  var style = document.createElement('style');
  style.textContent = [
    '#' + BTN_ID + '{position:absolute;z-index:2147483000;display:none;',
    'align-items:center;padding:5px 10px;border-radius:8px;',
    'background:#2f2f2f;color:#fff;font-size:12px;line-height:1.2;',
    'border:1px solid rgba(255,255,255,.2);box-shadow:0 4px 16px rgba(0,0,0,.4);',
    'cursor:pointer;user-select:none;font-family:inherit;white-space:nowrap;',
    'transition:background .12s ease,transform .12s ease}',
    '#' + BTN_ID + ':hover{background:#414141;transform:translateY(-1px)}',
    '#' + BTN_ID + ':active{transform:translateY(0)}',
    '#' + BTN_ID + '[data-show="1"]{display:inline-flex}',
    '#' + BTN_ID + ' .ico{opacity:.75;margin-right:5px}'
  ].join('');
  document.head.appendChild(style);

  // ---- 按钮 ----
  var btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.type = 'button';
  btn.innerHTML = '<span class="ico">\u275D</span>引用';
  btn.title = '把选中的文字引用到输入框';
  document.body.appendChild(btn);

  // ---- 失败提示条（只在出错时出现，成功时完全静默）----
  var toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = [
        'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483001',
        'max-width:62vw', 'padding:10px 14px', 'border-radius:10px',
        'background:rgba(18,18,18,.96)', 'color:#7CFC9A', 'font-size:12px',
        'font-family:Consolas,monospace', 'white-space:pre-wrap', 'line-height:1.55',
        'border:1px solid rgba(124,252,154,.4)', 'box-shadow:0 6px 24px rgba(0,0,0,.55)',
        'pointer-events:none', 'transition:opacity .25s'
      ].join(';');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = '[dsh-quote] ' + msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl.__t);
    toastEl.__t = setTimeout(function () { toastEl.style.opacity = '0'; }, 8000);
  }

  // ---- 错误上报：脚本任何地方抛错都会在左下角弹出来 ----
  // （只用于排查；正常情况下永远不出现）
  window.addEventListener('error', function (ev) {
    try {
      var msg = ev && ev.message ? ev.message : '未知错误';
      var at = ev && ev.lineno ? (' 行' + ev.lineno) : '';
      toast('\u26A0\uFE0F 脚本错误: ' + msg + at);
    } catch (e) { /* 连上报都失败就算了 */ }
  });
  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev && ev.reason;
      toast('\u26A0\uFE0F 未处理的 Promise 错误: ' + (r && r.message ? r.message : String(r)));
    } catch (e) {}
  });

  var currentText = '';

  function composer() {
    return document.querySelector('[data-composer-input]');
  }

  function hide() {
    btn.removeAttribute('data-show');
    currentText = '';
  }

  function show(rect, text) {
    currentText = text;
    // 先显示才能量到尺寸
    btn.setAttribute('data-show', '1');
    var w = btn.offsetWidth, h = btn.offsetHeight;

    var left = rect.left + window.scrollX + rect.width / 2 - w / 2;
    var top = rect.top + window.scrollY - h - GAP;

    // 上方空间不够就放到选区下方
    if (rect.top - h - GAP < 0) {
      top = rect.bottom + window.scrollY + GAP;
    }
    // 水平方向别超出视口
    var minLeft = window.scrollX + 4;
    var maxLeft = window.scrollX + document.documentElement.clientWidth - w - 4;
    if (left < minLeft) left = minLeft;
    if (left > maxLeft) left = maxLeft;

    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
  }

  /** 选区是否位于「对话内容区」——输入框内部、按钮自身都不算 */
  function selectionInConversation() {
    var s = window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) return null;
    var range = s.getRangeAt(0);
    var node = range.commonAncestorContainer;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return null;
    if (el.closest('[data-composer-input]')) return null; // 输入框里不弹
    if (el.closest('#' + BTN_ID)) return null;
    var text = s.toString().replace(/\s+$/, '');
    if (!text.trim()) return null;
    return { range: range, text: text };
  }

  /**
   * 把一段文本插到输入框末尾。
   *
   * ⚠️ 曾经出过的 BUG：三层兜底是【同步】依次执行的，但 Lexical 的
   *    textContent 是异步更新的 —— execCommand 其实成功了，却因为
   *    立刻读 textContent 发现"没变"而误判失败，于是三层全跑了，
   *    同一个标记被插入 3 次（❝2 ❝2 ❝2）。
   *
   * 现在改成：每试一条路径就【等一下再检查】，只有确实没变才试下一条。
   */
  function insertRawText(payload, done) {
    var el = composer();
    if (!el) { toast('❌ 找不到输入框 [data-composer-input]'); if (done) done(false); return false; }

    el.focus();
    try {
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);          // 光标落到末尾
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* 忽略 */ }

    var before = el.textContent.length;

    var paths = [
      // 路径 1：execCommand —— Lexical 会收到真实 input 事件，首选
      function (node, text) { document.execCommand('insertText', false, text); },
      // 路径 2：合成 beforeinput
      function (node, text) {
        node.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: text
        }));
      },
      // 路径 3：直接改 DOM + 派发 input（最粗暴的兜底）
      function (node, text) {
        node.textContent = node.textContent + text;
        node.dispatchEvent(new InputEvent('input', {
          bubbles: true, inputType: 'insertText', data: text
        }));
      }
    ];

    function attempt(i) {
      if (i >= paths.length) {
        try { el.scrollTop = el.scrollHeight; } catch (e) {}
        if (done) done(el.textContent.length !== before);
        return;
      }
      try { paths[i](el, payload); } catch (e) { /* 换下一条 */ }
      // 关键：延迟检查，避开 Lexical 的异步 DOM 更新
      setTimeout(function () {
        if (el.textContent.length !== before) {
          try { el.scrollTop = el.scrollHeight; } catch (e) {}
          if (done) done(true);
          return;
        }
        attempt(i + 1);
      }, 150);
    }

    attempt(0);
    return true;
  }

  /**
   * 引用主入口：把原文上传到宿主仓库，输入框里只插入一个极短的标记 `❝N`。
   * 原文不进对话，所以你那边看不到、也不会和你后面打的字混在一起。
   * 上传失败时退回"插入原文"，保证引用不会丢。
   */
  function insertQuote(text) {
    if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN) + '…';

    fetch(STORE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: text,
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok && j.id) {
          insertRawText(MARK + j.id + ' ');
          // 成功时静默，不打扰你
        } else {
          insertRawText(QUOTE_PREFIX + text);
          toast('⚠️ 上传被拒（' + (j && j.error) + '），已退回插入原文');
        }
      })
      .catch(function (err) {
        insertRawText(QUOTE_PREFIX + text);
        toast('⚠️ 上传异常：' + err.message + '\n已退回插入原文');
      });

    return true;
  }

  // ================================================================
  //  引用标记渲染 + 点击跳转高亮
  //  对话里的 "❝N" 会被渲染成一个可点击的小方块（编号隐藏），
  //  点击后跳到原文位置并在原处画一个蓝框。
  //  高亮用 fixed 覆盖层实现，不往消息 DOM 里插东西，
  //  避免和 React 的渲染打架。
  // ================================================================

  var MARK_RX = /\u275D(\d+)/g;
  var decorateBusy = false;

  var chipCss = document.createElement('style');
  chipCss.textContent = [
    '.dshq-chip{display:inline-flex;align-items:center;gap:3px;',
    'padding:0 6px;margin:0 2px;border-radius:5px;cursor:pointer;',
    'background:rgba(56,139,253,.16);color:#7cb3ff;',
    'border:1px solid rgba(56,139,253,.45);font-size:.92em;line-height:1.5;',
    'vertical-align:baseline;user-select:none;transition:background .12s}',
    '.dshq-chip:hover{background:rgba(56,139,253,.32)}',
    '.dshq-chip::before{content:"\\275D";opacity:.8}'
  ].join('');
  document.head.appendChild(chipCss);

  /** 一个方块可以承载多个引用 id（相邻的标记会合并成一个） */
  function makeChip(ids) {
    var sp = document.createElement('span');
    sp.className = 'dshq-chip';
    sp.setAttribute('data-dshq-ids', ids.join(','));
    sp.setAttribute('contenteditable', 'false');
    sp.textContent = ids.join(' ');      // 编号显示在方块里：❝ 1 2 3
    sp.title = '点击跳转到引用的原文（#' + ids.join(' / #') + '）';
    return sp;
  }

  /** 把一棵子树里文本节点中的 ❝N 换成 chip */
  function decorate(root) {
    if (!root || root.nodeType !== 1 || decorateBusy) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || n.nodeValue.indexOf('\u275D') === -1) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('#dsh-quote-btn') || p.closest('.dshq-chip')) return NodeFilter.FILTER_REJECT;
        if (p.closest('[data-composer-input]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var targets = [], n;
    while ((n = walker.nextNode())) targets.push(n);
    if (!targets.length) return;

    decorateBusy = true;
    try {
      targets.forEach(function (node) {
        var text = node.nodeValue;
        var out = [], pending = [];

        function flush() {
          if (!pending.length) return;
          out.push({ ids: pending.slice() });
          pending = [];
        }
        function addText(s) { if (s) out.push({ text: s }); }

        var pos = 0, m;
        MARK_RX.lastIndex = 0;
        while ((m = MARK_RX.exec(text))) {
          var gap = text.slice(pos, m.index);
          if (pending.length) {
            // 已经是"连着标记"的状态：只有非空白间隔才断开
            if (gap && !/^\s+$/.test(gap)) { flush(); addText(gap); }
            // 纯空白 → 丢掉，让相邻标记并进同一个方块
          } else {
            addText(gap);
          }
          pending.push(m[1]);
          pos = m.index + m[0].length;
        }
        flush();
        addText(text.slice(pos));

        if (!out.length) return;

        var frag = document.createDocumentFragment();
        out.forEach(function (seg) {
          if (seg.ids) frag.appendChild(makeChip(seg.ids));
          else frag.appendChild(document.createTextNode(seg.text));
        });
        try { node.parentNode.replaceChild(frag, node); } catch (e) {}
      });
    } finally {
      setTimeout(function () { decorateBusy = false; }, 60);
    }
  }

  /** 在页面上找包含 needle 的第一个文本节点（跳过输入框） */
  function findTextNode(needle) {
    if (!needle) return null;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || n.nodeValue.indexOf(needle) === -1) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('[data-composer-input]') || p.closest('#dsh-quote-btn')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    return walker.nextNode();
  }

  // ── 蓝框管理 ────────────────────────────────────────────────────
  // 蓝框是 position:fixed 的覆盖层：页面一滚动它就留在原地指着空气了，
  // 所以只要发生滚动/滚轮/触摸滑动，立刻把它清掉。
  // lockUntil 是"刚画完的宽限期"，避免 scrollIntoView 自己触发的事件
  // 把刚画上的框马上删掉。
  var activeBoxes = [];
  var highlightLockUntil = 0;

  function clearHighlights() {
    if (Date.now() < highlightLockUntil) return;
    for (var i = 0; i < activeBoxes.length; i++) {
      try { activeBoxes[i].remove(); } catch (e) {}
    }
    activeBoxes = [];
  }

  /** 在文本节点内给 needle 画蓝框（fixed 覆盖层，3 秒后淡出） */
  function paintHighlight(node, needle) {
    var idx = node.nodeValue.indexOf(needle);
    if (idx < 0) return false;
    var range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + needle.length);
    var r = range.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return false;

    var box = document.createElement('div');
    box.style.cssText = [
      'position:fixed',
      'left:' + (r.left - 4) + 'px',
      'top:' + (r.top - 3) + 'px',
      'width:' + (r.width + 8) + 'px',
      'height:' + (r.height + 6) + 'px',
      'background:rgba(56,139,253,.30)',
      'border:1.5px solid rgba(90,160,255,.95)',
      'border-radius:4px',
      'box-shadow:0 0 0 3px rgba(56,139,253,.15)',
      'pointer-events:none',
      'z-index:2147482998',
      'transition:opacity .6s ease'
    ].join(';');
    document.body.appendChild(box);
    activeBoxes.push(box);

    highlightLockUntil = Date.now() + 400;   // 宽限期：这段时间内忽略滚动事件

    setTimeout(function () {
      box.style.opacity = '0';
      setTimeout(function () {
        try { box.remove(); } catch (e) {}
        var k = activeBoxes.indexOf(box);
        if (k >= 0) activeBoxes.splice(k, 1);
      }, 700);
    }, 3200);
    return true;
  }

  // 用户一滚动就收掉蓝框（滚轮 / 触摸滑动 / 键盘 / 任何容器滚动）
  window.addEventListener('wheel', clearHighlights, { passive: true });
  window.addEventListener('touchmove', clearHighlights, { passive: true });
  window.addEventListener('scroll', clearHighlights, true);
  document.addEventListener('keydown', function (e) {
    if (!e) return;
    var k = e.key;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'PageUp' || k === 'PageDown' ||
        k === 'Home' || k === 'End' || k === ' ') {
      clearHighlights();
    }
  }, true);

  /** 跳转并高亮：ids 是 id 数组（合并方块里可能有好几个） */
  function jumpToQuote(ids) {
    if (!ids || !ids.length) return;
    var results = [];
    var pending = ids.length;

    ids.forEach(function (id) {
      fetch('/dsh-quote/get/' + id, { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.ok || !j.text) return;
          var full = String(j.text).replace(/\s+/g, ' ').trim();
          // 先用前 24 字找，找不到再逐步缩短
          var cands = [full.slice(0, 24), full.slice(0, 14), full.slice(0, 8)];
          for (var i = 0; i < cands.length; i++) {
            if (cands[i].length < 4) break;
            var node = findTextNode(cands[i]);
            if (node) { results.push({ node: node, needle: cands[i] }); break; }
          }
        })
        .catch(function () {})
        .then(function () {
          pending--;
          if (pending > 0) return;
          if (!results.length) {
            toast('⚠️ 页面上找不到引用的原文（可能已被折叠或不在当前视图）');
            return;
          }
          try { results[0].node.parentElement.scrollIntoView({ block: 'center' }); }
          catch (e) { try { results[0].node.parentElement.scrollIntoView(); } catch (e2) {} }
          setTimeout(function () {
            results.forEach(function (r) { paintHighlight(r.node, r.needle); });
          }, 60);
        });
    });
  }

  // chip 点击（事件委托，兼容后续新增的 chip）
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var chip = t.closest('.dshq-chip');
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    var raw = chip.getAttribute('data-dshq-ids') || '';
    var ids = raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (ids.length) jumpToQuote(ids);
  }, true);

  // 首次装饰 + 监听后续 DOM 变化
  decorate(document.body);
  try {
    var mo = new MutationObserver(function (muts) {
      if (decorateBusy) return;
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'childList' && m.addedNodes && m.addedNodes.length) {
          for (var k = 0; k < m.addedNodes.length; k++) {
            var nd = m.addedNodes[k];
            if (nd.nodeType === 1) { decorate(nd); return; }
            if (nd.nodeType === 3 && nd.parentElement) { decorate(nd.parentElement); return; }
          }
        }
        if (m.type === 'characterData' && m.target && m.target.parentElement) {
          decorate(m.target.parentElement); return;
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch (e) { /* MutationObserver 不可用就算了 */ }

  // ---- 事件 ----

  // 鼠标松开后判断选区（mouseup 比 selectionchange 更贴合"用户划完了"）
  document.addEventListener('mouseup', function (e) {
    if (e.target && e.target.closest && e.target.closest('#' + BTN_ID)) return;
    setTimeout(function () {
      var hit = selectionInConversation();
      if (!hit) { hide(); return; }
      var rect = hit.range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) { hide(); return; }
      show(rect, hit.text);
    }, 10);
  }, true);

  // 键盘选择（Shift+方向键等）
  document.addEventListener('keyup', function (e) {
    if (e.key !== 'Shift' && !e.shiftKey) { return; }
    setTimeout(function () {
      var hit = selectionInConversation();
      if (!hit) { hide(); return; }
      show(hit.range.getBoundingClientRect(), hit.text);
    }, 10);
  }, true);

  // 选区被清掉就收起
  document.addEventListener('selectionchange', function () {
    var s = window.getSelection();
    if (!s || s.isCollapsed) hide();
  });

  // 滚动时收起（位置会飘）
  window.addEventListener('scroll', hide, true);

  // 点击别处收起（但点按钮本身不收起）
  document.addEventListener('mousedown', function (e) {
    if (e.target && e.target.closest && e.target.closest('#' + BTN_ID)) return;
    hide();
  }, true);

  // 按钮点击 → 插入
  btn.addEventListener('mousedown', function (e) {
    e.preventDefault();  // 防止点击时丢掉选区
    e.stopPropagation();
  });
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var text = currentText;
    var hit = selectionInConversation();
    if (hit) text = hit.text;
    // 这里原来有一句调试用的 toast，会把选中文字的前 30 个字显示在左下角 ——
    // 那正好破坏了「引用之后我这边看不着」的设计，已删掉。
    if (!text) { hide(); return; }
    insertQuote(text);
    try { window.getSelection().removeAllRanges(); } catch (err) {}
    hide();
  });

  // 快捷键：Ctrl/Cmd + Shift + Q
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'Q' || e.key === 'q')) {
      var hit = selectionInConversation();
      if (hit) {
        e.preventDefault();
        insertQuote(hit.text);
        try { window.getSelection().removeAllRanges(); } catch (err) {}
        hide();
      }
    }
  }, true);
})();
