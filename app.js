/* ============================================================
   app.js · CodeNotes 主逻辑
   ============================================================ */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function escAttr(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function compileHighlights() {
    var rules = store.settings.highlightRules || [];
    state.highlightRules = rules.map(function (r) {
      return {
        color: r.color || '#ff7b60',
        words: String(r.words || '').split(/[,，]/).map(function (w) { return w.trim(); }).filter(Boolean)
      };
    }).filter(function (r) { return r.words.length; });
  }

  function applyNoteColor() {
    var c = store.settings.noteColor;
    if (c) document.documentElement.style.setProperty('--inline-note-color', c);
    else document.documentElement.style.removeProperty('--inline-note-color');
  }

  function highlightTextSegment(text) {
    var rules = state.highlightRules;
    var matches = [];
    var isWordChar = /[A-Za-z0-9_$]/;
    rules.forEach(function (r) {
      r.words.forEach(function (w) {
        if (!w) return;
        var from = 0;
        var idx;
        while ((idx = text.indexOf(w, from)) !== -1) {
          var before = idx > 0 ? text.charAt(idx - 1) : '';
          var after = text.charAt(idx + w.length);
          var okBefore = !before || !isWordChar.test(before) || !isWordChar.test(w.charAt(0));
          var okAfter = !after || !isWordChar.test(after) || !isWordChar.test(w.charAt(w.length - 1));
          if (okBefore && okAfter) matches.push({ start: idx, end: idx + w.length, color: r.color });
          from = idx + w.length;
        }
      });
    });
    if (!matches.length) return text;
    matches.sort(function (a, b) { return a.start - b.start || (b.end - b.start) - (a.end - a.start); });
    var out = '';
    var pos = 0;
    matches.forEach(function (m) {
      if (m.start < pos) return;
      out += text.slice(pos, m.start);
      out += '<span class="t-custom" style="color:' + m.color + '">' + text.slice(m.start, m.end) + '</span>';
      pos = m.end;
    });
    return out + text.slice(pos);
  }

  function applyCustomHighlights(html) {
    if (!state.highlightRules.length || !html) return html;
    return html.replace(/(<[^>]*>)|([^<]+)/g, function (m, tag, text) {
      if (tag || !text) return m;
      return highlightTextSegment(text);
    });
  }

  var esc = function (s) { return HL.escape(String(s == null ? '' : s)); };

  var APP_VERSION = '1.4.5';
  var AI_PRESETS = [
    { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'qwen', name: '通义千问（阿里云）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'glm', name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'kimi', name: 'Moonshot Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { id: 'silicon', name: '硅基流动 SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    { id: 'custom', name: '自定义（OpenAI 兼容）', baseURL: '', model: '' }
  ];
  var LS_KEY = 'codenotes.v1';
  var MAX_PREVIEW = 8 * 1024 * 1024;   // 单个文本文件预览上限（字符）
  var MAX_LINE_CHARS = 4000;           // 单行显示上限（压缩代码常常几百万字符一行）

  /* ------------------------------------------------------------
     状态
  ------------------------------------------------------------ */
  var store = loadStore();

  var state = {
    highlightRules: [],
    project: null,
    sig: null,
    current: null,
    pdfPath: null,
    tab: 'code',
    text: '',
    lines: [],
    lang: 'plain',
    enc: '',
    binary: false,
    notice: '',
    truncated: false,
    modified: false,
    rendered: 0,
    hl: {},
    moreIO: null,
    editing: false,
    selectedLine: null,
    composerSaved: '',
    filter: '',
    findTerm: '',
    findMatches: [],
    findIndex: -1,
    expanded: new Set(),
    treeNotes: {},
    sidebar: false,
    notesPanel: false,
    fileNoteTimer: 0
  };

  /* ------------------------------------------------------------
     IndexedDB（只用来记住最近一次导入的压缩包）
  ------------------------------------------------------------ */
  var IDB_NAME = 'codenotes-db';

  function idb() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbPut(key, val) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readonly');
        var req = tx.objectStore('kv').get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  /* ------------------------------------------------------------
     存储
  ------------------------------------------------------------ */
  function loadStore() {
    var data = null;
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) data = JSON.parse(raw);
    } catch (e) { data = null; }
    if (!data || typeof data !== 'object') data = {};
    if (!data.projects || typeof data.projects !== 'object') data.projects = {};
    if (!data.settings || typeof data.settings !== 'object') {
      data.settings = { theme: 'auto', sidebar: true, notesPanel: true };
    }
    if (!data.settings.theme) data.settings.theme = 'auto';
    return data;
  }

  var saveTimer = 0;
  function saveStore() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(store));
      } catch (e) {
        toast('本地存储已满，注释可能未保存');
      }
    }, 220);
  }

  function ensureBucket() {
    if (!state.sig) return { notes: {}, expanded: [] };
    var b = store.projects[state.sig];
    if (!b) {
      b = store.projects[state.sig] = {
        name: state.project ? state.project.name : '',
        notes: {},
        expanded: [],
        updatedAt: Date.now()
      };
    }
    if (!b.notes) b.notes = {};
    return b;
  }

  function getRec(path) {
    var b = ensureBucket();
    return (path && b.notes[path]) || null;
  }

  function ensureRec(path) {
    var b = ensureBucket();
    if (!b.notes[path]) b.notes[path] = {};
    return b.notes[path];
  }

  function pruneRec(path) {
    var b = ensureBucket();
    var rec = b.notes[path];
    if (!rec) return;
    var hasLines = rec.lines && Object.keys(rec.lines).length;
    var hasFile = rec.file && rec.file.trim();
    var hasContent = typeof rec.content === 'string';
    if (!hasLines && !hasFile && !hasContent) delete b.notes[path];
  }

  function signature(name, entries) {
    var h = 5381;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var s = e.path;
      for (var j = 0; j < s.length; j++) h = ((h << 5) + h + s.charCodeAt(j)) | 0;
      h = ((h << 5) + h + (e.size | 0)) | 0;
    }
    return name + '::' + entries.length + '::' + (h >>> 0).toString(36);
  }

  /* ------------------------------------------------------------
     小工具
  ------------------------------------------------------------ */
  function fmtSize(n) {
    if (!n && n !== 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function isMobile() {
    return window.matchMedia('(max-width: 880px)').matches;
  }

  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('#toastWrap').appendChild(el);
    setTimeout(function () { el.remove(); }, 2700);
  }

  function busy(text) {
    $('#busyText').textContent = text || '处理中…';
    $('#busy').hidden = false;
  }

  function idle() { $('#busy').hidden = true; }

  function extOf(name) {
    var special = { Makefile: 'mk', Dockerfile: 'df', LICENSE: 'txt', '.gitignore': 'git', '.env': 'env' };
    if (special[name]) return special[name];
    if (name.charAt(0) === '.') return name.slice(1, 4) || '·';
    var i = name.lastIndexOf('.');
    if (i <= 0 || i === name.length - 1) return '·';
    return name.slice(i + 1, i + 5);
  }

  /* ------------------------------------------------------------
     主题 / 面板
  ------------------------------------------------------------ */
  function applyTheme() {
    var pref = store.settings.theme || 'auto';
    var resolved = pref;
    if (pref === 'auto') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
  }

  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var next = order[(order.indexOf(store.settings.theme || 'auto') + 1) % 3];
    store.settings.theme = next;
    saveStore();
    applyTheme();
    toast(next === 'auto' ? '主题：跟随系统' : next === 'light' ? '主题：浅色' : '主题：深色');
  }

  function updateScrim() {
    var on = isMobile() && (state.sidebar || state.notesPanel);
    document.body.classList.toggle('scrim-on', on);
  }

  function setSidebar(open, persist) {
    state.sidebar = !!open;
    document.body.classList.toggle('sb-open', state.sidebar);
    document.body.classList.toggle('sb-hidden', !state.sidebar);
    if (persist) { store.settings.sidebar = state.sidebar; saveStore(); }
    updateScrim();
  }

  function setNotesPanel(open) {
    state.notesPanel = !!open;
    document.body.classList.toggle('np-open', state.notesPanel);
    document.body.classList.toggle('np-hidden', !state.notesPanel);
    $('#btnNotes').classList.toggle('on', state.notesPanel);
    if (!isMobile()) { store.settings.notesPanel = state.notesPanel; saveStore(); }
    updateScrim();
  }

  function toggleSidebar() { setSidebar(!state.sidebar, true); }

  function toggleNotes() {
    if (!state.current) { toast('先打开一个文件'); return; }
    setNotesPanel(!state.notesPanel);
  }

  function closeSheets() {
    if (isMobile()) {
      setSidebar(false, false);
      setNotesPanel(false);
    }
  }

  /* ------------------------------------------------------------
     导入
  ------------------------------------------------------------ */
  async function importFile(file) {
    if (!file) return;
    if (file.size > 90 * 1024 * 1024) {
      toast('文件太大了（超过 90MB），请拆分后再导入');
      return;
    }
    busy('正在读取 ' + file.name + '…');
    var t0 = performance.now();
    try {
      var proj = await ZipReader.readAny(file, function (i, total) {
        busy('正在解压… ' + i + ' / ' + total);
      });
      busy('正在生成目录…');
      await new Promise(function (r) { setTimeout(r, 40); });
      loadProject(proj);
      rememberProject(file);
      var ms = Math.round(performance.now() - t0);
      toast('已导入 ' + proj.entries.length + ' 个文件' +
        (proj.skipped ? '，跳过 ' + proj.skipped + ' 个' : '') + ' · ' + ms + 'ms');
    } catch (err) {
      console.error(err);
      toast((err && err.message) || '导入失败');
    } finally {
      idle();
    }
  }

  function rememberProject(file) {
    if (!file || file.size > 40 * 1024 * 1024) return;
    idbPut('last', {
      name: file.name,
      size: file.size,
      blob: file,
      at: Date.now()
    }).catch(function () { /* 存不下就算了 */ });
  }

  function restoreLast() {
    if (new URLSearchParams(location.search).get('sample')) return;
    idbGet('last').then(function (rec) {
      if (!rec || !rec.blob || state.project) return;
      var f = new File([rec.blob], rec.name || 'project.zip', { type: 'application/zip' });
      busy('正在恢复上次的项目…');
      return ZipReader.readAny(f).then(function (proj) {
        loadProject(proj);
        toast('已恢复上次项目 · ' + proj.entries.length + ' 个文件');
      }).catch(function () {
        /* 压缩包损坏就忽略 */
      }).then(function () {
        idle();
      });
    }).catch(function () { /* 忽略 */ });
  }

  function loadProject(proj, opts) {
    opts = opts || {};
    var entries = proj.entries.slice().sort(function (a, b) {
      return a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true });
    });

    var byPath = new Map();
    entries.forEach(function (e) { byPath.set(e.path, e); });

    state.project = {
      name: proj.name || '未命名项目',
      isZip: !!proj.isZip,
      entries: entries,
      byPath: byPath,
      tree: buildTree(entries),
      textCache: new Map(),
      skipped: proj.skipped || 0
    };
    state.sig = signature(state.project.name, entries);

    var bucket = ensureBucket();
    state.expanded = new Set(bucket.expanded || []);
    state.treeNotes = Object.assign({}, bucket.treeNotes || {});
    if (opts.seed) seedDemoNotes(bucket, byPath);
    if (!state.expanded.size) expandDefault(state.project.tree);

    state.current = null;
    state.text = '';
    state.lines = [];
    state.selectedLine = null;
    state.composerSaved = '';
    $('#welcome').hidden = true;
    $('#notesPanel').hidden = false;

    renderProjectCard();
    renderTree();
    renderNoteStat();

    var target = null;
    if (store.lastFile && store.lastFile.sig === state.sig &&
        byPath.has(store.lastFile.path)) {
      target = byPath.get(store.lastFile.path);
    }
    var first = target || pickFirstFile(entries);
    if (first) openFile(first.path);
    if (isMobile()) {
      setSidebar(false, false);
      setNotesPanel(false);
    }
  }

  function pickFirstFile(entries) {
    if (!entries.length) return null;
    // 优先打开 README（任意层级，取最浅的）
    var readmes = entries.filter(function (e) {
      return /(^|\/)readme\.(md|txt|markdown)$/i.test(e.path);
    }).sort(function (a, b) {
      return a.path.split('/').length - b.path.split('/').length;
    });
    if (readmes.length) return readmes[0];
    // 其次是层级最浅、名字最靠前的文件
    return entries.slice().sort(function (a, b) {
      var da = a.path.split('/').length;
      var db = b.path.split('/').length;
      if (da !== db) return da - db;
      return a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true });
    })[0];
  }

  /* ------------------------------------------------------------
     目录树
  ------------------------------------------------------------ */
  function buildTree(entries) {
    var root = { type: 'dir', name: '', path: '', children: [], count: 0 };
    var map = new Map();
    map.set('', root);

    entries.forEach(function (e) {
      var parts = e.path.split('/').filter(Boolean);
      var p = '';
      for (var i = 0; i < parts.length; i++) {
        var isFile = i === parts.length - 1;
        p = p ? p + '/' + parts[i] : parts[i];
        var node = map.get(p);
        if (!node) {
          node = isFile
            ? { type: 'file', name: parts[i], path: p, size: e.size }
            : { type: 'dir', name: parts[i], path: p, children: [], count: 0 };
          map.set(p, node);
          var parentPath = parts.slice(0, i).join('/');
          var parent = map.get(parentPath);
          if (parent && parent.children) parent.children.push(node);
        }
      }
    });

    sortTree(root);
    countTree(root);
    return root;
  }

  function sortTree(node) {
    if (!node.children) return;
    node.children.sort(function (a, b) {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
    });
    node.children.forEach(sortTree);
  }

  function countTree(node) {
    if (node.type === 'file') return 1;
    var n = 0;
    (node.children || []).forEach(function (c) { n += countTree(c); });
    node.count = n;
    return n;
  }

  function expandDefault(root) {
    (root.children || []).forEach(function (c) {
      if (c.type === 'dir') {
        state.expanded.add(c.path);
        (c.children || []).forEach(function (gc) {
          if (gc.type === 'dir' && c.children.length <= 6) state.expanded.add(gc.path);
        });
      }
    });
    persistExpanded();
  }

  function persistExpanded() {
    if (!state.sig) return;
    var b = ensureBucket();
    b.expanded = Array.from(state.expanded);
    b.updatedAt = Date.now();
    saveStore();
  }

  var CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5 15.5 12 9 18.5"/></svg>';

  function dirMatches(node, q) {
    if (node.path.toLowerCase().indexOf(q) >= 0) return true;
    if (node.type === 'file') return false;
    for (var i = 0; i < node.children.length; i++) {
      if (dirMatches(node.children[i], q)) return true;
    }
    return false;
  }

  /* -------- 目录注释 / 行尾注释 辅助 -------- */
  function oneLine(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function treeNoteHtml(text) {
    var t = oneLine(text);
    if (!t) return '';
    if (t.length > 16) t = t.slice(0, 16) + '…';
    return '<span class="tree-note">（' + esc(t) + '）</span>';
  }

  function formatInlineNote(text) {
    // 3 个空格 + # 开头
    return '   # ' + oneLine(text);
  }

  function updateTreeLabel(path) {
    var row = $('#tree .trow[data-path="' + cssEsc(path) + '"]');
    if (!row) return;
    var name = row.dataset.name || path.split('/').pop();
    var note = '';
    if (row.dataset.kind === 'dir') {
      note = state.treeNotes[path] || '';
    } else {
      var rec = getRec(path);
      note = (rec && rec.file) || '';
    }
    var lbl = row.querySelector('.lbl');
    if (lbl) lbl.innerHTML = esc(name) + treeNoteHtml(note);
    row.classList.toggle('has-tree-note', !!oneLine(note));
  }

  function refreshRowNote(n) {
    var row = lineRow(n);
    if (!row) return;
    var rec = getRec(state.current);
    var val = (rec && rec.lines && rec.lines[n]) || '';
    var code = row.querySelector('.code');
    if (!code) return;
    var span = code.querySelector('.inline-note');
    if (val) {
      if (!span) {
        span = document.createElement('span');
        span.className = 'inline-note';
        code.appendChild(span);
      }
      span.textContent = formatInlineNote(val);
    } else if (span) {
      span.remove();
    }
    row.classList.toggle('has-note', !!val);
  }

  function setDirNote(path, val) {
    val = String(val || '').trim();
    if (val) state.treeNotes[path] = val;
    else delete state.treeNotes[path];
    var b = ensureBucket();
    b.treeNotes = state.treeNotes;
    saveStore();
    updateTreeLabel(path);
  }

  function editDirNote(path) {
    if (!path) return;
    var name = path.split('/').pop();
    var cur = state.treeNotes[path] || '';
    openModal('目录注释 · ' + name,
      '<p>保存后显示为「' + esc(name) + '（注释）」，只影响左侧目录显示，不会改动源码。</p>' +
      '<textarea id="dirNoteInput" placeholder="例如：核心逻辑 / 工具函数 / 暂时不用"></textarea>', [
      {
        label: '删除', onClick: function () {
          setDirNote(path, '');
          closeModal();
          toast('已删除目录注释');
        }
      },
      { label: '取消', onClick: closeModal },
      {
        label: '保存', primary: true, onClick: function () {
          var v = $('#dirNoteInput').value.trim();
          setDirNote(path, v);
          closeModal();
          toast(v ? '已保存目录注释' : '已删除目录注释');
        }
      }
    ]);
    $('#dirNoteInput').value = cur;
    setTimeout(function () { $('#dirNoteInput').focus(); }, 60);
  }

  var PENCIL = '<svg class="ico xs" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M4.5 19.5l.9-4.2L15.8 4.9a1.8 1.8 0 0 1 2.5 0l.8.8a1.8 1.8 0 0 1 0 2.5L8.7 18.6l-4.2.9z"/></svg>';

  function dirRow(node, depth, open) {
    var el = document.createElement('div');
    var note = state.treeNotes[node.path] || '';
    el.className = 'trow dir' + (open ? ' open' : '') + (oneLine(note) ? ' has-tree-note' : '');
    el.style.setProperty('--d', depth);
    el.dataset.path = node.path;
    el.dataset.kind = 'dir';
    el.dataset.name = node.name;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.innerHTML = CHEV +
      '<span class="lbl">' + esc(node.name) + treeNoteHtml(note) + '</span>' +
      (node.count ? '<span class="cnt">' + node.count + '</span>' : '') +
      '<span class="row-edit" role="button" tabindex="0" title="目录注释" aria-label="设置目录注释">' + PENCIL + '</span>';
    return el;
  }

  function fileRow(node, depth, bucket) {
    var el = document.createElement('div');
    el.className = 'trow file' + (state.current === node.path ? ' active' : '');
    el.style.setProperty('--d', depth);
    el.dataset.path = node.path;
    el.dataset.kind = 'file';
    el.dataset.name = node.name;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    var rec = bucket.notes[node.path];
    var fileNote = (rec && rec.file) || '';
    var hasNote = rec && ((rec.lines && Object.keys(rec.lines).length) || (rec.file && rec.file.trim()));
    if (oneLine(fileNote)) el.classList.add('has-tree-note');
    el.innerHTML = '<span class="ext">' + esc(extOf(node.name)) + '</span>' +
      '<span class="lbl">' + esc(node.name) + treeNoteHtml(fileNote) + '</span>' +
      (hasNote ? '<span class="note-dot"></span>' : '') +
      '<span class="row-edit" role="button" tabindex="0" title="文件注释" aria-label="编辑文件注释">' + PENCIL + '</span>';
    return el;
  }

  function renderTree() {
    var host = $('#tree');
    var scroll = host.scrollTop;
    host.innerHTML = '';

    if (!state.project) {
      host.innerHTML = '<div class="tree-empty">还没有导入项目。<br>点击顶部「导入压缩包」，或先载入示例。</div>';
      return;
    }

    var q = state.filter.trim().toLowerCase();
    var bucket = ensureBucket();
    var frag = document.createDocumentFragment();

    (function walk(node, depth) {
      (node.children || []).forEach(function (child) {
        if (child.type === 'dir') {
          if (q && !dirMatches(child, q)) return;
          var open = q ? true : state.expanded.has(child.path);
          frag.appendChild(dirRow(child, depth, open));
          if (open) walk(child, depth + 1);
        } else {
          if (q && child.path.toLowerCase().indexOf(q) < 0) return;
          frag.appendChild(fileRow(child, depth, bucket));
        }
      });
    })(state.project.tree, 0);

    host.appendChild(frag);
    host.scrollTop = scroll;
  }

  function markActiveRow() {
    highlightRow(state.current);
  }

  function cssEsc(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------
     打开文件
  ------------------------------------------------------------ */
  function openFile(path) {
    var entry = state.project && state.project.byPath.get(path);
    if (!entry) return;

    if (/\.pdf$/i.test(path)) {
      openPdfFromProject(path);
      return;
    }

    if (document.body.classList.contains('tab-pdf')) setTab('code');

    flushComposer();

    state.current = path;
    state.binary = false;
    state.notice = '';
    state.truncated = false;
    state.modified = false;
    state.editing = false;
    state.selectedLine = null;
    state.composerSaved = '';
    state.findTerm = '';
    state.findMatches = [];
    state.findIndex = -1;
    state.lang = HL.langOf(path);
    state.enc = '';

    var rec = getRec(path);
    var text = '';
    var enc = '';

    if (rec && typeof rec.content === 'string') {
      text = rec.content;
      enc = '本地修改';
      state.modified = true;
    } else if (entry.size > 24 * 1024 * 1024) {
      state.binary = true;
      state.notice = '文件超过 24MB，暂不载入预览。你仍然可以为它写整体注释。';
    } else {
      var cached = state.project.textCache.get(path);
      if (cached) {
        text = cached.text;
        enc = cached.enc;
      } else {
        var dec = ZipReader.decodeText(entry.data);
        text = dec.text;
        enc = dec.enc;
        state.project.textCache.set(path, dec);
      }
    }

    if (text.length > MAX_PREVIEW) {
      text = text.slice(0, MAX_PREVIEW);
      state.truncated = true;
    }

    state.text = text;
    state.enc = enc;
    state.lines = state.binary ? [] : text.split(/\r\n|\n|\r/);

    document.body.classList.remove('no-file');
    $('#welcome').hidden = true;
    $('#editor').hidden = false;
    $('#editorArea').hidden = true;
    $('#viewer').hidden = false;
    $('#btnEdit').textContent = '编辑';
    $('#btnEdit').classList.remove('on');
    $('#findbar').hidden = true;
    $('#btnFind').classList.remove('on');
    $('#findCount').textContent = '';

    renderHead();
    renderViewer();
    renderNotesUI();
    markActiveRow();
    renderNoteStat();

    // 记住这个文件，下次启动直接打开
    if (state.sig) {
      store.lastFile = { sig: state.sig, path: path, scroll: 0, at: Date.now() };
      saveStore();
    }
    var lf = store.lastFile;
    if (lf && lf.path === path && lf.scroll) {
      var want = lf.scroll;
      requestAnimationFrame(function () {
        var v = $('#viewer');
        if (v) v.scrollTop = want;
      });
    }
  }

  function renderHead() {
    if (!state.current) return;
    var parts = state.current.split('/');
    var fname = parts.pop() || state.current;
    var dir = parts.join('/');
    $('#crumbs').innerHTML = '<span class="fname">' + esc(fname) + '</span>' +
      (dir ? '<span class="fdir">' + esc(dir) + '/</span>' : '');

    var entry = state.project.byPath.get(state.current);
    var rec = getRec(state.current);
    var noteCount = rec && rec.lines ? Object.keys(rec.lines).length : 0;
    var bits = [];
    if (!state.binary) bits.push(state.lines.length + ' 行');
    bits.push(fmtSize(entry ? entry.size : 0));
    if (state.enc) bits.push(state.enc);
    if (state.truncated) bits.push('已截断');

    var meta = '<span>' + esc(bits.join(' · ')) + '</span>';
    if (state.modified) {
      meta += '<span class="pill warn">已修改<button data-act="revert">还原</button></span>';
    }
    if (noteCount) meta += '<span class="pill">' + noteCount + ' 行已注释</span>';
    $('#fileMeta').innerHTML = meta;

    $('#btnNotes').classList.toggle('on', state.notesPanel);
    updateChipCount();
  }

  function updateChipCount() {
    var rec = getRec(state.current);
    var n = rec && rec.lines ? Object.keys(rec.lines).length : 0;
    var badge = $('#fileNoteCount');
    badge.textContent = n;
    badge.hidden = !n;
  }

  /* ------------------------------------------------------------
     代码渲染
  ------------------------------------------------------------ */
  function renderViewer() {
    var box = $('#viewer');
    var host = $('#lines');
    host.innerHTML = '';
    box.scrollTop = 0;
    state.rendered = 0;
    state.hl = {};
    if (state.moreIO) { state.moreIO.disconnect(); state.moreIO = null; }

    if (state.binary) {
      host.innerHTML = '<div class="binary-note">' + esc(state.notice) + '</div>';
      updateFoot();
      return;
    }

    appendLines(0, Math.min(400, state.lines.length));
    addMoreButton();
    updateFoot();
  }

  function appendLines(from, to) {
    var host = $('#lines');
    var frag = document.createDocumentFragment();
    var rec = getRec(state.current);
    var notes = (rec && rec.lines) || {};

    for (var i = from; i < to; i++) {
      var raw = state.lines[i];
      var cut = raw.length > MAX_LINE_CHARS;
      var shown = cut ? raw.slice(0, MAX_LINE_CHARS) : raw;
      var res = HL.render(shown, state.lang, state.hl);
      state.hl = res.st;
      var n = i + 1;
      var noteVal = notes[n];
      var row = document.createElement('div');
      row.className = 'crow';
      row.dataset.n = String(n);
      if (noteVal) row.classList.add('has-note');
      if (state.findTerm && raw.toLowerCase().indexOf(state.findTerm) >= 0) row.classList.add('hit');
      var html = applyCustomHighlights(res.html || ' ');
      if (cut) html += '<span class="cut-mark"> … 已截断（原行 ' + raw.length + ' 字符）</span>';
      if (noteVal) html += '<span class="inline-note">' + esc(formatInlineNote(noteVal)) + '</span>';
      row.innerHTML = '<span class="ln">' + n + '</span><span class="code">' + html + '</span>';
      frag.appendChild(row);
    }
    host.appendChild(frag);
    state.rendered = to;
  }

  function addMoreButton() {
    var old = $('#lines .load-more');
    if (old) old.remove();
    if (state.moreIO) { state.moreIO.disconnect(); state.moreIO = null; }
    if (state.rendered >= state.lines.length) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'load-more';
    btn.textContent = '继续加载 · 还有 ' + (state.lines.length - state.rendered) + ' 行';
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      loadMore();
    });
    $('#lines').appendChild(btn);

    if (typeof IntersectionObserver !== 'undefined') {
      state.moreIO = new IntersectionObserver(function (ents) {
        if (ents.some(function (en) { return en.isIntersecting; })) loadMore();
      }, { root: $('#viewer'), rootMargin: '800px 0px' });
      state.moreIO.observe(btn);
    }
  }

  function loadMore() {
    if (state.rendered >= state.lines.length) return;
    var from = state.rendered;
    var to = Math.min(from + 400, state.lines.length);
    appendLines(from, to);
    addMoreButton();
    updateFoot();
  }

  function appendUntil(target) {
    var guard = 0;
    while (state.rendered < target && state.rendered < state.lines.length && guard < 80) {
      loadMore();
      guard++;
    }
  }

  function lineRow(n) {
    return $('#lines .crow[data-n="' + n + '"]');
  }

  function updateFoot() {
    var left = '';
    if (state.selectedLine) left = '第 ' + state.selectedLine + ' 行';
    else if (!state.binary) left = state.lines.length + ' 行';
    $('#edFootLeft').textContent = left;
    $('#edFootRight').textContent = (state.lang || '') + (state.enc ? ' · ' + state.enc : '');
  }

  /* ------------------------------------------------------------
     行选择 / 注释
  ------------------------------------------------------------ */
  function selectLine(n, opts) {
    opts = opts || {};
    if (state.selectedLine !== null && state.selectedLine !== n) flushComposer();

    state.selectedLine = n;
    $$('#lines .crow.sel').forEach(function (el) { el.classList.remove('sel'); });
    var row = lineRow(n);
    if (row) row.classList.add('sel');

    renderComposer();
    updateFoot();

    if (!state.notesPanel && !opts.silent) {
      setNotesPanel(true);
      // 手机上面板会盖住正文，把当前行滚到可见区顶部
      if (isMobile() && row) setTimeout(function () { row.scrollIntoView({ block: 'start' }); }, 80);
    }
    if (!isMobile() && opts.focus !== false) {
      var input = $('#noteInput');
      if (input && document.activeElement !== input) input.focus({ preventScroll: true });
    }
    // 让注释面板里的输入框可见
    if (state.notesPanel && isMobile()) {
      var comp = $('.composer');
      if (comp) comp.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderComposer() {
    var n = state.selectedLine;
    var rec = getRec(state.current);
    var existing = (rec && rec.lines && n !== null) ? (rec.lines[n] || '') : '';
    var head = $('#noteHeader');
    var input = $('#noteInput');
    var del = $('#btnDeleteNote');

    if (n === null) {
      head.textContent = '点击左侧代码行开始注释';
      input.value = '';
      input.disabled = true;
      del.hidden = true;
      state.composerSaved = '';
    } else {
      head.textContent = '第 ' + n + ' 行' + (existing ? ' · 已注释' : '');
      input.disabled = false;
      input.value = existing;
      state.composerSaved = existing;
      del.hidden = !existing;
    }
    $('.composer').classList.toggle('active', n !== null);
    $('#btnSaveNote').disabled = n === null;
  }

  function flushComposer() {
    if (state.selectedLine === null || !state.current) return;
    var input = $('#noteInput');
    if (!input || input.disabled) return;
    var val = input.value.trim();
    if (val === state.composerSaved) return;
    setLineNote(state.current, state.selectedLine, val);
    state.composerSaved = val;
  }

  function saveCurrentNote() {
    if (state.selectedLine === null) { toast('先点击一行代码'); return; }
    var val = $('#noteInput').value.trim();
    setLineNote(state.current, state.selectedLine, val);
    state.composerSaved = val;
    renderComposer();
    toast(val ? '已保存第 ' + state.selectedLine + ' 行的注释' : '已删除该行注释');
  }

  function setLineNote(path, n, val) {
    if (!path) return;
    var rec = ensureRec(path);
    if (val) {
      if (!rec.lines) rec.lines = {};
      rec.lines[n] = val;
    } else if (rec.lines) {
      delete rec.lines[n];
    }
    pruneRec(path);
    saveStore();

    refreshRowNote(n);
    renderNoteList();
    renderHead();
    renderNoteStat();
    refreshTreeDot(path);
  }

  function refreshTreeDot(path) {
    var row = $('#tree .trow.file[data-path="' + cssEsc(path) + '"]');
    if (!row) return;
    var rec = getRec(path);
    var has = rec && ((rec.lines && Object.keys(rec.lines).length) || (rec.file && rec.file.trim()));
    var dot = row.querySelector('.note-dot');
    if (has && !dot) {
      dot = document.createElement('span');
      dot.className = 'note-dot';
      row.appendChild(dot);
    } else if (!has && dot) {
      dot.remove();
    }
  }

  function renderNotesUI() {
    var rec = getRec(state.current);
    $('#fileNote').value = (rec && rec.file) || '';
    renderComposer();
    renderNoteList();
    renderNoteStat();
    updateChipCount();
  }

  function renderNoteList() {
    var host = $('#noteList');
    var rec = getRec(state.current);
    var lines = (rec && rec.lines) || {};
    var keys = Object.keys(lines).map(Number).sort(function (a, b) { return a - b; });

    $('#listCount').textContent = keys.length ? '(' + keys.length + ')' : '';
    $('#npCount').textContent = String(keys.length + (rec && rec.file && rec.file.trim() ? 1 : 0));

    if (!keys.length) {
      host.innerHTML = '<div class="empty-hint">还没有逐行注释。点击上方任意一行代码，在输入框里写下它的作用。</div>';
      return;
    }
    host.innerHTML = keys.map(function (n) {
      return '<button type="button" class="note-item" data-line="' + n + '">' +
        '<span class="nl">L' + n + '</span>' +
        '<span class="nt">' + esc(lines[n]) + '</span></button>';
    }).join('');
  }

  function renderNoteStat() {
    var total = 0;
    var files = 0;
    if (state.sig && store.projects[state.sig]) {
      var notes = store.projects[state.sig].notes || {};
      Object.keys(notes).forEach(function (p) {
        var rec = notes[p];
        var c = (rec.lines ? Object.keys(rec.lines).length : 0) + (rec.file && rec.file.trim() ? 1 : 0);
        if (c) { files++; total += c; }
      });
    }
    $('#noteStat').textContent = total ? total + ' 条注释 · ' + files + ' 个文件' : '0 条注释';
    renderProjectCard();
  }

  function renderProjectCard() {
    var nameEl = $('#projName');
    var metaEl = $('#projMeta');
    var statsEl = $('#projStats');

    if (!state.project) {
      nameEl.textContent = '未导入项目';
      metaEl.textContent = '导入 .zip 压缩文件夹开始';
      statsEl.innerHTML = '';
      return;
    }

    var totalSize = state.project.entries.reduce(function (a, e) { return a + e.size; }, 0);
    var noteCount = 0;
    var b = state.sig ? store.projects[state.sig] : null;
    if (b && b.notes) {
      Object.keys(b.notes).forEach(function (p) {
        var rec = b.notes[p];
        noteCount += (rec.lines ? Object.keys(rec.lines).length : 0) + (rec.file && rec.file.trim() ? 1 : 0);
      });
    }

    nameEl.textContent = state.project.name;
    metaEl.textContent = state.project.entries.length + ' 个文件 · ' + fmtSize(totalSize) +
      (state.project.isZip ? ' · ZIP' : '');
    statsEl.innerHTML =
      '<span class="stat-chip">' + state.project.entries.length + ' 文件</span>' +
      (noteCount ? '<span class="stat-chip on">' + noteCount + ' 条注释</span>' : '') +
      (state.project.skipped ? '<span class="stat-chip">跳过 ' + state.project.skipped + '</span>' : '');
  }

  /* ------------------------------------------------------------
     查找
  ------------------------------------------------------------ */
  function openFind() {
    if (!state.current || state.editing) return;
    $('#findbar').hidden = false;
    $('#btnFind').classList.add('on');
    var input = $('#findInput');
    input.focus();
    input.select();
  }

  function closeFind() {
    $('#findbar').hidden = true;
    $('#btnFind').classList.remove('on');
    clearFind();
  }

  function clearFind() {
    state.findTerm = '';
    state.findMatches = [];
    state.findIndex = -1;
    $('#findInput').value = '';
    $('#findCount').textContent = '';
    $$('#lines .crow.hit').forEach(function (el) { el.classList.remove('hit'); });
  }

  function runFind() {
    var term = $('#findInput').value.trim();
    state.findTerm = term.toLowerCase();
    state.findMatches = [];
    state.findIndex = -1;

    var set = new Set();
    if (state.findTerm) {
      for (var i = 0; i < state.lines.length; i++) {
        if (state.lines[i].toLowerCase().indexOf(state.findTerm) >= 0) {
          state.findMatches.push(i + 1);
          set.add(i + 1);
        }
      }
    }

    $$('#lines .crow').forEach(function (row) {
      row.classList.toggle('hit', set.has(Number(row.dataset.n)));
    });

    if (!state.findTerm) { $('#findCount').textContent = ''; return; }
    if (!state.findMatches.length) {
      $('#findCount').textContent = '无结果';
      return;
    }
    $('#findCount').textContent = '1 / ' + state.findMatches.length;
    state.findIndex = 0;
    jumpToLine(state.findMatches[0]);
  }

  function stepFind(dir) {
    if (!state.findMatches.length) return;
    state.findIndex = (state.findIndex + dir + state.findMatches.length) % state.findMatches.length;
    var n = state.findMatches[state.findIndex];
    $('#findCount').textContent = (state.findIndex + 1) + ' / ' + state.findMatches.length;
    jumpToLine(n);
  }

  function jumpToLine(n) {
    if (n > state.rendered) appendUntil(n + 40);
    var row = lineRow(n);
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(function () { row.classList.remove('flash'); }, 1100);
    selectLine(n, { focus: false, silent: true });
  }

  /* ------------------------------------------------------------
     编辑模式
  ------------------------------------------------------------ */
  function toggleEdit() {
    if (!state.current) return;
    if (state.binary) { toast('这个文件不支持编辑'); return; }

    if (!state.editing) {
      flushComposer();
      state.editing = true;
      var ta = $('#editorArea');
      ta.value = state.text;
      ta.hidden = false;
      $('#viewer').hidden = true;
      ta.focus();
      $('#btnEdit').textContent = '完成';
      $('#btnEdit').classList.add('on');
      closeFind();
      return;
    }

    state.editing = false;
    var val = $('#editorArea').value.replace(/\r\n/g, '\n');
    var changed = false;
    if (val !== state.text) {
      var rec = ensureRec(state.current);
      rec.content = val;
      saveStore();
      changed = true;
    }
    $('#editorArea').hidden = true;
    $('#viewer').hidden = false;
    $('#btnEdit').textContent = '编辑';
    $('#btnEdit').classList.remove('on');
    var path = state.current;
    openFile(path);
    if (changed) toast('修改已保存到本机');
  }

  function revertContent() {
    if (!state.current) return;
    var rec = getRec(state.current);
    if (!rec || typeof rec.content !== 'string') return;
    if (!window.confirm('放弃对这个文件的全部本地修改，恢复压缩包里的原始内容？')) return;
    delete rec.content;
    pruneRec(state.current);
    saveStore();
    openFile(state.current);
    toast('已恢复原始内容');
  }

  /* ------------------------------------------------------------
     导出
  ------------------------------------------------------------ */
  function textOf(path) {
    var rec = getRec(path);
    if (rec && typeof rec.content === 'string') return rec.content;
    var cached = state.project.textCache.get(path);
    if (cached) return cached.text;
    var entry = state.project.byPath.get(path);
    if (!entry) return '';
    var dec = ZipReader.decodeText(entry.data);
    state.project.textCache.set(path, dec);
    return dec.text;
  }

  function buildMarkdown() {
    var bucket = ensureBucket();
    var out = [];
    var fileCount = 0;
    var noteCount = 0;

    out.push('# ' + state.project.name + ' · 注释导出');
    out.push('');
    out.push('> 导出时间：' + new Date().toLocaleString('zh-CN'));
    out.push('');

    Object.keys(bucket.notes).sort().forEach(function (path) {
      var rec = bucket.notes[path];
      var lineKeys = rec.lines ? Object.keys(rec.lines).sort(function (a, b) { return a - b; }) : [];
      if (!rec.file && !lineKeys.length) return;
      fileCount++;

      out.push('## ' + path);
      if (rec.file) {
        out.push('');
        out.push('> ' + String(rec.file).replace(/\n/g, '\n> '));
      }
      var src = null;
      lineKeys.forEach(function (ln) {
        noteCount++;
        if (!src) {
          try { src = textOf(path).split(/\r\n|\n|\r/); } catch (e) { src = []; }
        }
        var code = (src[Number(ln) - 1] || '').trim();
        if (code.length > 120) code = code.slice(0, 120) + '…';
        out.push('');
        out.push('- **L' + ln + '**' + (code ? ' `' + code.replace(/`/g, '\\`') + '`' : ''));
        out.push('  ' + String(rec.lines[ln]).replace(/\n/g, '\n  '));
      });
      out.push('');
    });

    if (!fileCount) return '';
    out.push('---');
    out.push('');
    out.push('共 ' + fileCount + ' 个文件、' + noteCount + ' 条逐行注释 · 由 CodeNotes 导出');
    return out.join('\n');
  }

  function exportNotes() {
    if (!state.project) { toast('还没有导入项目'); return; }
    var md = buildMarkdown();
    if (!md) { toast('这个项目还没有任何注释'); return; }

    openModal('导出注释', '<p>已整理成本地注释文件。可以复制到剪贴板，或下载为 .md 文件。</p>' +
      '<textarea id="exportText" readonly></textarea>', [
      { label: '关闭', onClick: closeModal },
      {
        label: '复制', onClick: function () {
          copyText(md).then(function () { toast('已复制到剪贴板'); },
            function () { toast('复制失败，请长按文本手动复制'); });
        }
      },
      {
        label: '下载 .md', primary: true, onClick: function () { downloadFile(md, state.project.name + '-注释.md'); }
      }
    ]);
    $('#exportText').value = md;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        resolve();
      } catch (e) { reject(e); }
    });
  }

  function downloadFile(text, name) {
    try {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('已开始下载 ' + name);
    } catch (e) {
      toast('当前环境不支持下载，请用复制');
    }
  }

  /* ------------------------------------------------------------
     底部标签：代码 / PDF
  ------------------------------------------------------------ */
  var pdfState = { doc: null, page: 1, scale: 1, fit: true, name: '', token: 0 };

  function setCodeFont(px) {
    px = Math.max(4, Math.min(24, px));
    document.documentElement.style.setProperty('--code-size', (Math.round(px * 10) / 10) + 'px');
    return px;
  }

  function currentCodeFont() {
    var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--code-size'));
    return v || 13;
  }

  function bindCodeGestures() {
    var viewer = $('#viewer');
    if (!viewer) return;
    var pinch = null;

    viewer.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 2) return;
      var cs = currentCodeFont();
      pinch = { d: touchDist(e.touches), size: cs, cur: cs };
    }, { passive: true });

    viewer.addEventListener('touchmove', function (e) {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      pinch.cur = setCodeFont(pinch.size * (touchDist(e.touches) / pinch.d));
    }, { passive: false });

    viewer.addEventListener('touchend', function () {
      if (!pinch) return;
      store.settings.codeFont = pinch.cur;
      saveStore();
      pinch = null;
    });

    viewer.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      store.settings.codeFont = setCodeFont(currentCodeFont() + (e.deltaY < 0 ? 0.5 : -0.5));
      saveStore();
    }, { passive: false });
  }

  function setTab(tab) {
    state.tab = tab;
    var isPdf = tab === 'pdf';
    document.body.classList.toggle('tab-pdf', isPdf);
    $('#tabCode').classList.toggle('on', !isPdf);
    $('#tabPdf').classList.toggle('on', isPdf);
    $('#pdfView').hidden = !isPdf;

    if (isPdf) {
      if (!pdfState.doc && pdfState.pending) {
        var rec = pdfState.pending;
        pdfState.pending = null;
        openPdfData(new Uint8Array(rec.data), rec.name).then(function () {
          if (rec.page && rec.page > 1) goToPage(rec.page);
        });
      }
      $('#editor').hidden = true;
      $('#welcome').hidden = true;
      if (state.notesPanel) setNotesPanel(false);
      if (state.project) highlightRow(state.pdfPath || state.current);
      requestAnimationFrame(function () { if (pdfState.doc) refreshVisiblePages(); });
    } else {
      if (state.current) {
        $('#editor').hidden = false;
        $('#welcome').hidden = true;
        if (state.project) highlightRow(state.current);
      } else {
        $('#editor').hidden = true;
        $('#welcome').hidden = false;
      }
    }
  }

  function highlightRow(path) {
    $$('#tree .trow.active').forEach(function (el) { el.classList.remove('active'); });
    if (!path) return;
    var row = $('#tree .trow[data-path="' + cssEsc(path) + '"]');
    if (row) {
      row.classList.add('active');
      var r = row.getBoundingClientRect();
      var box = $('#tree').getBoundingClientRect();
      if (r.top < box.top + 4 || r.bottom > box.bottom - 4) row.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ---------------- PDF ---------------- */
  var pdfState = {
    doc: null, name: '', scale: 1, fit: true,
    baseW: 595, baseH: 842, pages: [],
    observer: null, current: 1, previewScale: 0,
    zipPdfs: [], lastData: null, transScale: 1, pending: null
  };
  var transCache = {};
  (function loadTransCache() {
    try { transCache = JSON.parse(localStorage.getItem('codenotes.trans.v1') || '{}') || {}; }
    catch (e) { transCache = {}; }
  })();

  function clampNum(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function touchDist(t) {
    var dx = t[0].clientX - t[1].clientX;
    var dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy) || 1;
  }

  function openPdfFromProject(path) {
    if (!state.project) return;
    var entry = state.project.byPath.get(path);
    if (!entry) return;
    state.pdfPath = path;
    pdfState.zipPdfs = [];
    highlightRow(path);
    if (isMobile()) setSidebar(false, false);
    openPdfData(new Uint8Array(entry.data), path.split('/').pop());
  }

  function openPdfFile(file) {
    if (!file) return;
    pdfState.zipPdfs = [];
    busy('正在打开 PDF…');
    file.arrayBuffer().then(function (buf) {
      openPdfData(new Uint8Array(buf), file.name);
    }).catch(function () {
      toast('读取 PDF 失败');
    }).then(function () { idle(); });
  }

  async function importPdfZip(file) {
    if (!file) return;
    busy('正在读取压缩包…');
    try {
      var res = await ZipReader.readZip(file, function (i, t) { busy('正在解压… ' + i + ' / ' + t); });
      var pdfs = res.entries.filter(function (e) { return /\.pdf$/i.test(e.path); });
      if (!pdfs.length) throw new Error('压缩包里没有 PDF 文件');
      pdfState.zipPdfs = pdfs.map(function (e) {
        return { name: e.path.split('/').pop(), path: e.path, data: new Uint8Array(e.data) };
      });
      await openPdfData(new Uint8Array(pdfs[0].data), pdfs[0].path.split('/').pop());
      setPdfOutline(true);
      if (pdfs.length > 1) toast('压缩包里有 ' + pdfs.length + ' 个 PDF，右侧目录可切换');
    } catch (err) {
      console.error(err);
      toast((err && err.message) || '导入 PDF 失败');
    } finally {
      idle();
    }
  }

  async function openPdfData(data, name) {
    setTab('pdf');
    pdfState.name = name || 'PDF';
    pdfState.current = 1;
    pdfState.fit = true;
    $('#pdfName').textContent = pdfState.name;
    $('#pdfEmpty').hidden = true;
    $('#pdfPages').innerHTML = '';
    setPdfPageLabel(1, 0, true);
    $('#pdfTrans').hidden = true;

    try {
      if (pdfState.doc) {
        try { pdfState.doc.destroy(); } catch (e) { /* 忽略 */ }
        pdfState.doc = null;
      }
      if (typeof pdfjsLib === 'undefined') throw new Error('PDF 引擎没有加载');
      // pdf.js 会接管这块内存，先留一份用于“下次自动打开”
      try { pdfState.lastData = new Uint8Array(data); } catch (e) { pdfState.lastData = null; }

      var task = pdfjsLib.getDocument({ data: data, isEvalSupported: false });
      var doc = await task.promise;
      pdfState.doc = doc;
      pdfState.trans = {};
      pdfState.showTrans = false;
      pdfState.pageBlocks = {};
      outlineTrans = null;
      outlineItemsFlat = [];
      var poBtn = $('#poTranslate');
      if (poBtn) poBtn.textContent = '译';
      $('#pdfTransToggle').hidden = true;
      $('#pdfTransToggle').classList.remove('on');
      var first = await doc.getPage(1);
      var vp1 = first.getViewport({ scale: 1 });
      pdfState.baseW = vp1.width;
      pdfState.baseH = vp1.height;
      await buildPages();
      buildOutline();
      savePdfSession();
    } catch (err) {
      console.error(err);
      $('#pdfPages').innerHTML = '';
      $('#pdfEmpty').hidden = false;
      setPdfPageLabel(1, 0, true);
      toast('PDF 打开失败：' + ((err && err.message) || '未知错误'));
    }
  }

  function fitScale() {
    var stage = $('#pdfStage');
    var avail = Math.max(160, stage.clientWidth - 24);
    return avail / pdfState.baseW;
  }

  async function buildPages() {
    var doc = pdfState.doc;
    if (!doc) return;
    var host = $('#pdfPages');
    host.innerHTML = '';
    pdfState.pages = [];
    if (pdfState.observer) { pdfState.observer.disconnect(); pdfState.observer = null; }
    if (pdfState.fit) pdfState.scale = fitScale();

    for (var i = 1; i <= doc.numPages; i++) {
      var wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap.dataset.page = i;
      var canvas = document.createElement('canvas');
      wrap.appendChild(canvas);
      wrap.style.width = Math.round(pdfState.baseW * pdfState.scale) + 'px';
      wrap.style.height = Math.round(pdfState.baseH * pdfState.scale) + 'px';
      host.appendChild(wrap);
      pdfState.pages.push({
        no: i, wrap: wrap, canvas: canvas,
        renderedScale: 0, rendering: false,
        w: pdfState.baseW, h: pdfState.baseH, page: null
      });
    }

    setPdfPageLabel(1, doc.numPages);
    observePages();
    renderPageAt(0);
    renderPageAt(1);
    var stage = $('#pdfStage');
    if (stage) stage.scrollTop = 0;
  }

  function observePages() {
    var stage = $('#pdfStage');
    if (typeof IntersectionObserver === 'undefined') return;
    pdfState.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        renderPageAt(Number(en.target.dataset.page) - 1);
      });
    }, { root: stage, rootMargin: '700px 0px' });
    pdfState.pages.forEach(function (p) { pdfState.observer.observe(p.wrap); });
  }

  async function renderPageAt(idx) {
    var p = pdfState.pages[idx];
    if (!p || !pdfState.doc) return;
    var s = pdfState.scale;
    if (p.renderedScale === s || p.rendering) return;
    p.rendering = true;
    try {
      var page = p.page || await pdfState.doc.getPage(p.no);
      p.page = page;
      if (Math.abs(pdfState.scale - s) > 0.001) return;
      var vp = page.getViewport({ scale: s });
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var canvas = p.canvas;
      canvas.width = Math.max(1, Math.floor(vp.width * dpr));
      canvas.height = Math.max(1, Math.floor(vp.height * dpr));
      canvas.style.width = vp.width + 'px';
      canvas.style.height = vp.height + 'px';
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
      }).promise;
      if (Math.abs(pdfState.scale - s) > 0.001) return;
      p.renderedScale = s;
      p.w = vp.width / s;
      p.h = vp.height / s;
      p.wrap.style.width = vp.width + 'px';
      p.wrap.style.height = vp.height + 'px';
    } catch (e) {
      console.warn('render page failed', p.no, e);
    } finally {
      p.rendering = false;
    }
  }

  function applyScale() {
    var stage = $('#pdfStage');
    // 记录缩放前当前页相对视口的位置，缩放后按差值补回 scrollTop，避免跳页
    var anchor = pdfState.pages[Math.max(0, (pdfState.current || 1) - 1)] || pdfState.pages[0];
    var offsetBefore = anchor ? anchor.wrap.getBoundingClientRect().top - stage.getBoundingClientRect().top : 0;

    pdfState.pages.forEach(function (p) {
      p.wrap.style.width = Math.round(p.w * pdfState.scale) + 'px';
      p.wrap.style.height = Math.round(p.h * pdfState.scale) + 'px';
      p.renderedScale = 0;
    });

    if (anchor) {
      var offsetAfter = anchor.wrap.getBoundingClientRect().top - stage.getBoundingClientRect().top;
      stage.scrollTop += (offsetAfter - offsetBefore);
    }

    refreshVisiblePages();
    renderTransOverlays();
    onPdfScroll();
  }

  function refreshVisiblePages() {
    if (!pdfState.doc) return;
    var stage = $('#pdfStage');
    var rect = stage.getBoundingClientRect();
    pdfState.pages.forEach(function (p, i) {
      var r = p.wrap.getBoundingClientRect();
      if (r.bottom >= rect.top - 700 && r.top <= rect.bottom + 700) renderPageAt(i);
    });
  }

  function onPdfScroll() {
    if (!pdfState.doc || !pdfState.pages.length) return;
    var stage = $('#pdfStage');
    var mid = stage.scrollTop + stage.clientHeight * 0.3;
    var best = 1;
    for (var i = 0; i < pdfState.pages.length; i++) {
      var p = pdfState.pages[i];
      if (p.wrap.offsetTop <= mid) best = p.no;
      else break;
    }
    pdfState.current = best;
    setPdfPageLabel(best, pdfState.doc.numPages);
    savePdfSession();
  }

  function pdfZoom(dir) {
    if (!pdfState.doc) return;
    pdfState.fit = false;
    pdfState.scale = clampNum(pdfState.scale * (dir > 0 ? 1.2 : 0.8), 0.2, 6);
    applyScale();
  }

  function pdfFit() {
    if (!pdfState.doc) return;
    pdfState.fit = true;
    pdfState.scale = fitScale();
    applyScale();
  }

  /* ---------------- PDF 文字查找 ---------------- */
  var pdfSearch = { term: '', matches: [], idx: -1 };

  function clearPdfHits() {
    var hits = document.querySelectorAll('.pdf-find-hit');
    Array.prototype.forEach.call(hits, function (el) { el.remove(); });
  }

  function openPdfFind() {
    if (!pdfState.doc) { toast('先打开一个 PDF'); return; }
    $('#pdfFind').hidden = false;
    setTimeout(function () { $('#pdfFindInput').focus(); }, 30);
  }

  function closePdfFind() {
    $('#pdfFind').hidden = true;
    clearPdfHits();
    $('#pdfFindCount').textContent = '';
  }

  async function getPageBlocks(no) {
    if (!pdfState.pageBlocks) pdfState.pageBlocks = {};
    if (pdfState.pageBlocks[no]) return pdfState.pageBlocks[no];
    var page = await pdfState.doc.getPage(no);
    var blocks = await extractBlocks(page);
    pdfState.pageBlocks[no] = blocks;
    return blocks;
  }

  async function runPdfSearch() {
    var term = $('#pdfFindInput').value.trim();
    clearPdfHits();
    pdfSearch.term = term;
    pdfSearch.matches = [];
    pdfSearch.idx = -1;
    if (!pdfState.doc || !term) { $('#pdfFindCount').textContent = ''; return; }

    var needle = term.toLowerCase();
    $('#pdfFindCount').textContent = '搜索中…';
    for (var p = 1; p <= pdfState.doc.numPages; p++) {
      var blocks = await getPageBlocks(p);
      for (var bi = 0; bi < blocks.length; bi++) {
        var lines = blocks[bi].lines || [];
        for (var li = 0; li < lines.length; li++) {
          var ln = lines[li];
          var t = String(ln.t || '').toLowerCase();
          var from = 0;
          var pos;
          while ((pos = t.indexOf(needle, from)) !== -1) {
            pdfSearch.matches.push({ page: p, x: ln.x, y: ln.y, w: ln.w, h: ln.h });
            from = pos + needle.length;
            if (pdfSearch.matches.length >= 500) break;
          }
          if (pdfSearch.matches.length >= 500) break;
        }
        if (pdfSearch.matches.length >= 500) break;
      }
      $('#pdfFindCount').textContent = '搜索中 ' + p + '/' + pdfState.doc.numPages;
      if (pdfSearch.matches.length >= 500) break;
    }

    if (!pdfSearch.matches.length) {
      $('#pdfFindCount').textContent = '无结果';
      return;
    }
    pdfSearch.idx = 0;
    showPdfMatch(0);
  }

  function showPdfMatch(i) {
    var m = pdfSearch.matches[i];
    if (!m) return;
    var n = pdfSearch.matches.length;
    pdfSearch.idx = i;
    $('#pdfFindCount').textContent = (i + 1) + ' / ' + n;
    goToPage(m.page);
    var stage = $('#pdfStage');
    var pw = pdfState.pages[m.page - 1];
    if (!pw) return;
    stage.scrollTop = pw.wrap.offsetTop + m.y * pdfState.scale - 90;
    clearPdfHits();
    var hit = document.createElement('div');
    hit.className = 'pdf-find-hit';
    hit.style.left = (m.x * pdfState.scale - 2) + 'px';
    hit.style.top = (m.y * pdfState.scale - 2) + 'px';
    hit.style.width = (m.w * pdfState.scale + 4) + 'px';
    hit.style.height = (m.h * pdfState.scale + 4) + 'px';
    pw.wrap.appendChild(hit);
  }

  function stepPdfMatch(dir) {
    if (!pdfSearch.matches.length) return;
    var i = (pdfSearch.idx + dir + pdfSearch.matches.length) % pdfSearch.matches.length;
    showPdfMatch(i);
  }

  /* ---------------- PDF 目录 / 跳页 ---------------- */
  function setPdfPageLabel(cur, total, blank) {
    var inp = $('#pdfPageInput');
    var tot = $('#pdfPageTotal');
    if (inp && document.activeElement !== inp) inp.value = blank ? '' : String(cur);
    if (tot) tot.textContent = '/ ' + (total || 0);
  }

  function goToPage(n) {
    if (!pdfState.doc) return;
    n = Math.max(1, Math.min(n, pdfState.pages.length));
    var p = pdfState.pages[n - 1];
    if (!p) return;
    var stage = $('#pdfStage');
    stage.scrollTop = p.wrap.offsetTop - 6;
    pdfState.current = n;
    setPdfPageLabel(n, pdfState.doc.numPages);
    renderPageAt(n - 1);
    onPdfScroll();
  }

  function setPdfOutline(open) {
    var panel = $('#pdfOutline');
    var willOpen = typeof open === 'boolean' ? open : panel.hidden;
    panel.hidden = !willOpen;
    if (willOpen) buildOutline();
  }

  function poSection(title, node) {
    var sec = document.createElement('div');
    sec.className = 'po-sec';
    var t = document.createElement('div');
    t.className = 'po-title';
    t.textContent = title;
    sec.appendChild(t);
    sec.appendChild(node);
    return sec;
  }

  var outlineSeq = 0;
  var outlineItemsFlat = [];
  var outlineTrans = null;
  async function buildOutline() {
    var body = $('#poBody');
    if (!body || !pdfState.doc) return;
    var token = ++outlineSeq;
    body.innerHTML = '';

    // 压缩包里的 PDF（始终显示，方便快速切换）
    if (pdfState.zipPdfs && pdfState.zipPdfs.length) {
      var list = document.createElement('div');
      pdfState.zipPdfs.forEach(function (item) {
        var btn = document.createElement('button');
        btn.className = 'po-item' + (item.name === pdfState.name ? ' on' : '');
        btn.textContent = item.path || item.name;
        btn.title = item.path || item.name;
        btn.addEventListener('click', function () {
          openPdfData(new Uint8Array(item.data), item.name);
        });
        list.appendChild(btn);
      });
      body.appendChild(poSection('压缩包内的 PDF（' + pdfState.zipPdfs.length + ' 个）', list));
    }

    var outline = null;
    try { outline = await pdfState.doc.getOutline(); } catch (e) { outline = null; }
    if (token !== outlineSeq) return;
    if (outline && outline.length) {
      var list2 = document.createElement('div');
      outlineItemsFlat = [];
      (function add(items, depth) {
        items.forEach(function (it) {
          var idx = outlineItemsFlat.push({ title: it.title || '(未命名)', dest: it.dest }) - 1;
          var btn = document.createElement('button');
          btn.className = 'po-item';
          btn.style.paddingLeft = (8 + depth * 12) + 'px';
          var label = outlineTrans && outlineTrans[idx] ? outlineTrans[idx] : (it.title || '(未命名)');
          btn.textContent = label;
          btn.title = outlineTrans && outlineTrans[idx]
            ? (it.title || '') + ' → ' + outlineTrans[idx]
            : (it.title || '');
          btn.addEventListener('click', function () { jumpToDest(it.dest); });
          list2.appendChild(btn);
          if (it.items && it.items.length) add(it.items, depth + 1);
        });
      })(outline, 0);
      body.appendChild(poSection('当前 PDF 书签' + (outlineTrans ? '（已翻译）' : ''), list2));
    } else {
      var empty = document.createElement('div');
      empty.className = 'po-title';
      empty.textContent = '这个 PDF 没有书签目录';
      body.appendChild(empty);
    }

  }

  async function translateOutline() {
    var btn = $('#poTranslate');
    if (outlineTrans) {
      outlineTrans = null;
      buildOutline();
      if (btn) btn.textContent = '译';
      return;
    }
    if (!outlineItemsFlat.length) { toast('这个 PDF 没有书签目录'); return; }
    if (btn) btn.textContent = '翻译中…';
    try {
      var titles = outlineItemsFlat.map(function (it) { return it.title; });
      var payload = titles.map(function (t, i) {
        return '【' + (i + 1) + '】' + t.replace(/\n/g, ' ');
      }).join('\n');
      var out = await translateChunk(payload);
      var parts = out.split(/【\s*(\d+)\s*】/);
      var map = {};
      for (var i = 1; i < parts.length; i += 2) {
        var n = Number(parts[i]);
        var txt = (parts[i + 1] || '').trim();
        if (n && txt) map[n] = txt;
      }
      if (!Object.keys(map).length) throw new Error('译文格式解析失败');
      outlineTrans = titles.map(function (t, i) { return map[i + 1] || t; });
      buildOutline();
      if (btn) btn.textContent = '原文';
    } catch (e) {
      if (btn) btn.textContent = '译';
      toast('目录翻译失败：' + ((e && e.message) || '未知错误'));
    }
  }

  async function jumpToDest(dest) {
    try {
      var d = typeof dest === 'string' ? await pdfState.doc.getDestination(dest) : dest;
      if (!d || !d[0]) return;
      var idx = await pdfState.doc.getPageIndex(d[0]);
      goToPage(idx + 1);
      if (isMobile()) setPdfOutline(false);
    } catch (e) {
      console.warn('jump failed', e);
    }
  }

  /* ---------------- PDF 会话记忆 ---------------- */
  function savePdfSession() {
    if (!pdfState.doc) return;
    clearTimeout(savePdfSession._t);
    savePdfSession._t = setTimeout(function () {
      try {
        idbPut('lastPdf', {
          name: pdfState.name,
          page: pdfState.current,
          tab: state.tab,
          at: Date.now(),
          data: pdfState.lastData || null
        }).catch(function () { /* 存不下就算了 */ });
      } catch (e) { /* 忽略 */ }
    }, 700);
  }

  function restorePdfSession() {
    // 只把上次的 PDF 放到内存里，启动仍然停在代码页；
    // 用户点「PDF 阅读」时再真正打开（并回到上次页码）。
    idbGet('lastPdf').then(function (rec) {
      if (!rec || !rec.data) return;
      pdfState.pending = rec;
    }).catch(function () { /* 忽略 */ });
  }

  /* ---------------- PDF 译文覆盖 ---------------- */
  function clearTransOverlays() {
    pdfState.pages.forEach(function (p) {
      var olds = p.wrap.querySelectorAll('.pdf-trans-overlay, .pdf-tr-block, .pdf-trans-base, .pdf-tr-cover');
      Array.prototype.forEach.call(olds, function (el) { el.remove(); });
    });
  }

  function renderTransOverlays() {
    if (!pdfState.pages) return;
    clearTransOverlays();
    if (!pdfState.showTrans) return;

    var s = pdfState.scale;
    pdfState.pages.forEach(function (p) {
      var t = pdfState.trans[p.no];

      // 没有译文：提示层
      if (!t) {
        var hint = document.createElement('div');
        hint.className = 'pdf-trans-overlay';
        hint.style.fontSize = Math.max(10, Math.round((p.wrap.clientWidth || 400) / 46)) + 'px';
        var tip = document.createElement('div');
        tip.className = 't-empty';
        tip.textContent = '（第 ' + p.no + ' 页还没有翻译，滚到这一页后点「译」）';
        hint.appendChild(tip);
        p.wrap.appendChild(hint);
        return;
      }

      // 逐块覆盖，保持原版式
      if (t.blocks && t.blocks.length) {
        var scale = pdfState.transScale || 1;

        // 1) 只把「文字所在的行」铺白，图片/图形保持可见
        t.blocks.forEach(function (b) {
          var rects = b.lines && b.lines.length ? b.lines : [{ x: b.x, y: b.y, w: b.w, h: b.h }];
          rects.forEach(function (ln) {
            var cover = document.createElement('div');
            cover.className = 'pdf-tr-cover';
            cover.style.left = (ln.x * s - 1) + 'px';
            cover.style.top = (ln.y * s - 1) + 'px';
            cover.style.width = (ln.w * s + 3) + 'px';
            cover.style.height = (ln.h * s + 3) + 'px';
            p.wrap.appendChild(cover);
          });
        });

        // 2) 译文块
        t.blocks.forEach(function (b) {
          if (!b.trans) return;
          var el = document.createElement('div');
          el.className = 'pdf-tr-block';
          var lineH = Math.max(3, (b.h * s) / Math.max(1, b.lineCount || 1));
          el.style.left = (b.x * s) + 'px';
          el.style.top = (b.y * s) + 'px';
          el.style.width = Math.max(16, b.w * s + 2) + 'px';
          el.style.height = Math.max(6, b.h * s + 1) + 'px';
          el.style.lineHeight = lineH + 'px';
          el.style.fontSize = Math.max(3, lineH * 0.78 * scale) + 'px';
          el.textContent = b.trans;
          p.wrap.appendChild(el);
        });

        // 3) 放不下先缩字号；缩到底还放不下就向下扩高，保证不裁字
        var blocks = p.wrap.querySelectorAll('.pdf-tr-block');
        Array.prototype.forEach.call(blocks, function (el) {
          var fs = parseFloat(el.style.fontSize) || 9;
          for (var k = 0; k < 12 && el.scrollHeight > el.clientHeight + 1 && fs > 2.6; k++) {
            fs *= 0.88;
            el.style.fontSize = fs + 'px';
          }
          if (el.scrollHeight > el.clientHeight + 2) {
            el.style.height = (el.scrollHeight + 2) + 'px';
            el.style.background = '#fff';
          }
        });
        return;
      }

      // 兜底：整页覆盖
      if (t.text) {
        var div = document.createElement('div');
        div.className = 'pdf-trans-overlay';
        div.style.fontSize = Math.max(9, Math.round((p.wrap.clientWidth || 400) / 46)) + 'px';
        div.textContent = t.text;
        p.wrap.appendChild(div);
      }
    });
  }

  function setTransScale(v) {
    pdfState.transScale = Math.max(0.5, Math.min(2, Math.round(v * 10) / 10));
    store.settings.transScale = pdfState.transScale;
    saveStore();
    renderTransOverlays();
    var label = $('#ptScaleLabel');
    if (label) label.textContent = Math.round(pdfState.transScale * 100) + '%';
  }

  function togglePdfTranslation(force) {
    pdfState.showTrans = typeof force === 'boolean' ? force : !pdfState.showTrans;
    var btn = $('#pdfTransToggle');
    var has = Object.keys(pdfState.trans).length > 0;
    btn.hidden = !has;
    btn.textContent = pdfState.showTrans ? '原文' : '译文';
    btn.classList.toggle('on', pdfState.showTrans);
    renderTransOverlays();
  }

  function applyTransPanelHeight() {
    var panel = $('#pdfTrans');
    if (!panel) return;
    if (!isMobile()) { panel.style.height = ''; return; }
    var h = Number(store.settings.transPanelH) || 0.58;
    h = Math.max(0.25, Math.min(0.92, h));
    panel.style.height = (h * 100) + 'dvh';
  }

  function bindTransPanelDrag() {
    var grip = $('#ptGrip');
    var panel = $('#pdfTrans');
    if (!grip || !panel) return;
    var drag = null;

    grip.addEventListener('pointerdown', function (e) {
      drag = { y: e.clientY, h: panel.getBoundingClientRect().height };
      panel.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
    });

    grip.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var next = drag.h + (drag.y - e.clientY);
      next = Math.max(140, Math.min(window.innerHeight * 0.92, next));
      panel.style.height = next + 'px';
    });

    grip.addEventListener('pointerup', function () {
      if (!drag) return;
      drag = null;
      panel.classList.remove('dragging');
      var ratio = panel.getBoundingClientRect().height / window.innerHeight;
      store.settings.transPanelH = Math.max(0.25, Math.min(0.92, ratio));
      saveStore();
    });
    grip.addEventListener('pointercancel', function () {
      drag = null;
      panel.classList.remove('dragging');
    });
  }

  function showTransResult(no, text) {
    var body = $('#ptBody');
    body.innerHTML = '';

    var pre = document.createElement('div');
    pre.className = 'pt-text';
    pre.textContent = text;
    body.appendChild(pre);

    var sizeRow = document.createElement('div');
    sizeRow.className = 'pt-actions pt-size';
    var minus = document.createElement('button');
    minus.className = 'btn sm';
    minus.textContent = 'A−';
    minus.addEventListener('click', function () { setTransScale((pdfState.transScale || 1) - 0.1); });
    var label = document.createElement('span');
    label.id = 'ptScaleLabel';
    label.className = 'pt-scale-label';
    label.textContent = Math.round((pdfState.transScale || 1) * 100) + '%';
    var plus = document.createElement('button');
    plus.className = 'btn sm';
    plus.textContent = 'A+';
    plus.addEventListener('click', function () { setTransScale((pdfState.transScale || 1) + 0.1); });
    var reset = document.createElement('button');
    reset.className = 'link-btn';
    reset.textContent = '重置';
    reset.addEventListener('click', function () { setTransScale(1); });
    sizeRow.appendChild(minus);
    sizeRow.appendChild(label);
    sizeRow.appendChild(plus);
    sizeRow.appendChild(reset);
    body.appendChild(sizeRow);

    var actions = document.createElement('div');
    actions.className = 'pt-actions';

    var toggle = document.createElement('button');
    toggle.className = 'btn sm';
    toggle.textContent = pdfState.showTrans ? '在 PDF 上显示原文' : '在 PDF 上显示译文';
    toggle.addEventListener('click', function () {
      togglePdfTranslation();
      toggle.textContent = pdfState.showTrans ? '在 PDF 上显示原文' : '在 PDF 上显示译文';
    });
    actions.appendChild(toggle);

    var close = document.createElement('button');
    close.className = 'btn sm primary';
    close.textContent = '关闭';
    close.addEventListener('click', function () { $('#pdfTrans').hidden = true; });
    actions.appendChild(close);

    body.appendChild(actions);
  }

  /* ---------------- PDF 手势：双指缩放 ---------------- */
  var pinch = null;
  function bindPdfGestures() {
    var stage = $('#pdfStage');
    if (!stage) return;

    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 2) return;
      var pages = $('#pdfPages');
      pinch = { d: touchDist(e.touches), s: pdfState.scale };
      var r = stage.getBoundingClientRect();
      var cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
      var cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top + stage.scrollTop;
      pages.style.transformOrigin = cx + 'px ' + cy + 'px';
    }, { passive: true });

    stage.addEventListener('touchmove', function (e) {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      var ratio = touchDist(e.touches) / pinch.d;
      var s = clampNum(pinch.s * ratio, 0.2, 6);
      pdfState.previewScale = s;
      $('#pdfPages').style.transform = 'scale(' + (s / pinch.s) + ')';
    }, { passive: false });

    stage.addEventListener('touchend', function (e) {
      if (!pinch || e.touches.length >= 2) return;
      var s = pdfState.previewScale || pinch.s;
      pinch = null;
      var pages = $('#pdfPages');
      pages.style.transform = '';
      pages.style.transformOrigin = '';
      pdfState.fit = false;
      pdfState.scale = s;
      pdfState.previewScale = 0;
      applyScale();
      onPdfScroll();
    });

    stage.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      pdfZoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  /* ---------------- PDF 翻译 ---------------- */
  function getTransCfg() {
    var t = store.settings.translate || {};
    return {
      provider: t.provider || 'llm',
      preset: t.preset || 'deepseek',
      baseURL: t.baseURL || 'https://api.deepseek.com/v1',
      model: t.model || 'deepseek-chat',
      apiKey: t.apiKey || '',
      target: t.target || '简体中文'
    };
  }

  function transKeyOf(no) {
    var c = getTransCfg();
    return pdfState.name + '#' + no + '#' + c.provider + '#' + c.model + '#' + c.target;
  }

  function saveTransCache() {
    var keys = Object.keys(transCache);
    if (keys.length > 120) {
      keys.slice(0, keys.length - 120).forEach(function (k) { delete transCache[k]; });
    }
    try { localStorage.setItem('codenotes.trans.v1', JSON.stringify(transCache)); } catch (e) { /* 满了就算了 */ }
  }

  async function extractBlocks(page) {
    var vp = page.getViewport({ scale: 1 });
    var content = await page.getTextContent();
    var items = [];
    (content.items || []).forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var tr = pdfjsLib.Util.transform(vp.transform, it.transform);
      var h = it.height || Math.hypot(tr[2], tr[3]) || 10;
      var w = it.width || 0;
      items.push({ text: it.str, x: tr[4], y: tr[5] - h, w: w, h: h, base: tr[5] });
    });
    if (!items.length) return [];

    items.sort(function (a, b) { return a.base - b.base || a.x - b.x; });

    var lines = [];
    items.forEach(function (it) {
      var ln = lines[lines.length - 1];
      if (ln && Math.abs(ln.base - it.base) <= Math.max(2, it.h * 0.45)) {
        ln.items.push(it);
        ln.base = (ln.base * ln.items.length + it.base) / (ln.items.length + 1);
      } else {
        lines.push({ base: it.base, items: [it] });
      }
    });

    lines.forEach(function (ln) {
      ln.items.sort(function (a, b) { return a.x - b.x; });
      var text = '';
      ln.items.forEach(function (it, i) {
        var needSpace = i > 0 && /[A-Za-z0-9,.;:)\]"'%]$/.test(text) && /^[A-Za-z0-9(\["']/.test(it.text);
        text += (needSpace ? ' ' : '') + it.text;
      });
      ln.text = text;
      ln.x = Math.min.apply(null, ln.items.map(function (i) { return i.x; }));
      ln.right = Math.max.apply(null, ln.items.map(function (i) { return i.x + i.w; }));
      ln.y = Math.min.apply(null, ln.items.map(function (i) { return i.y; }));
      ln.h = Math.max.apply(null, ln.items.map(function (i) { return i.h; }));
    });

    var blocks = [];
    lines.forEach(function (ln) {
      var b = blocks[blocks.length - 1];
      var gap = b ? ln.y - (b.y + b.h) : 1e9;
      if (b && gap < ln.h * 1.7 && Math.abs(ln.x - b.x) < ln.h * 3) {
        b.lines.push(ln);
        b.x = Math.min(b.x, ln.x);
        b.y = Math.min(b.y, ln.y);
        b.right = Math.max(b.right, ln.right);
        b.bottom = Math.max(b.bottom, ln.y + ln.h);
        b.text += '\n' + ln.text;
      } else {
        blocks.push({
          x: ln.x, y: ln.y, right: ln.right, bottom: ln.y + ln.h,
          h: ln.h, text: ln.text, lines: [ln]
        });
      }
    });

    return blocks.map(function (b) {
      return {
        x: b.x, y: b.y,
        w: Math.max(8, b.right - b.x),
        h: Math.max(6, b.bottom - b.y),
        lineCount: b.lines.length,
        lines: b.lines.map(function (ln) {
          return {
            x: ln.x, y: ln.y,
            w: Math.max(4, ln.right - ln.x),
            h: Math.max(4, ln.h),
            t: ln.text || ''
          };
        }),
        text: b.text
      };
    });
  }

  async function translateBlocks(blocks) {
    var batches = [];
    var cur = [];
    var size = 0;
    blocks.forEach(function (b, i) {
      var t = '【' + (i + 1) + '】' + b.text;
      if (size + t.length > 3500 && cur.length) { batches.push(cur); cur = []; size = 0; }
      cur.push({ idx: i, text: t });
      size += t.length + 2;
    });
    if (cur.length) batches.push(cur);

    var results = {};
    for (var bi = 0; bi < batches.length; bi++) {
      if (batches.length > 1) {
        $('#ptBody').innerHTML = '<div class="pt-loading"><span class="spinner sm"></span>正在翻译 第 ' +
          (bi + 1) + ' / ' + batches.length + ' 组…</div>';
      }
      var payload = batches[bi].map(function (x) { return x.text; }).join('\n\n');
      var out = await translateChunk(payload);
      var parts = out.split(/【\s*(\d+)\s*】/);
      for (var i = 1; i < parts.length; i += 2) {
        var n = Number(parts[i]);
        var txt = (parts[i + 1] || '').trim();
        if (n && txt) results[n] = txt;
      }
    }

    var got = Object.keys(results).length;
    if (!got) throw new Error('译文格式解析失败，请重试');

    blocks.forEach(function (b, i) { b.trans = results[i + 1] || ''; });
    return blocks;
  }

  function chunkText(text, size) {
    var lines = String(text).split('\n');
    var chunks = [];
    var cur = '';
    lines.forEach(function (ln) {
      while (ln.length > size) {
        if (cur) { chunks.push(cur); cur = ''; }
        chunks.push(ln.slice(0, size));
        ln = ln.slice(size);
      }
      if ((cur ? cur.length + 1 : 0) + ln.length > size && cur) {
        chunks.push(cur);
        cur = ln;
      } else {
        cur = cur ? cur + '\n' + ln : ln;
      }
    });
    if (cur) chunks.push(cur);
    return chunks;
  }

  async function translateChunk(text) {
    var cfg = getTransCfg();
    if (cfg.provider === 'google') return translateGoogle(text, cfg);
    return translateLLM(text, cfg);
  }

  async function translateGoogle(text, cfg) {
    var tl = /中文|zh/i.test(cfg.target) ? 'zh-CN' : 'en';
    var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + tl +
      '&dt=t&q=' + encodeURIComponent(text);
    var r = await fetch(url);
    if (!r.ok) throw new Error('翻译服务返回 ' + r.status + '（国内网络可能访问不了 Google，改用 DeepSeek）');
    var data = await r.json();
    if (!data || !data[0]) throw new Error('翻译结果解析失败');
    return data[0].map(function (seg) { return seg[0]; }).join('');
  }

  async function translateLLM(text, cfg) {
    if (!cfg.apiKey) throw new Error('还没有填 API Key。点「翻译设置」填写 DeepSeek Key（platform.deepseek.com 申请），或把服务改成免费 Google');
    var base = String(cfg.baseURL || '').replace(/\/+$/, '');
    if (!base) throw new Error('接口地址为空');
    var r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify({
        model: cfg.model || 'deepseek-chat',
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: '你是专业的技术文档翻译。用户会给你若干段带【n】编号的文本。请逐段翻译成' + cfg.target +
              '，输出时保留完全相同的【n】编号，段落顺序不变，段与段之间空一行。要求：忠实原文、术语准确、语句通顺；只输出译文，不要解释、不要附原文。'
          },
          { role: 'user', content: text }
        ]
      })
    });
    if (!r.ok) {
      var msg = '请求失败 ' + r.status;
      try {
        var j = await r.json();
        if (j && j.error && j.error.message) msg += '：' + j.error.message;
      } catch (e) { /* 忽略 */ }
      throw new Error(msg);
    }
    var data = await r.json();
    var out = data && data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content;
    if (!out) throw new Error('返回内容为空');
    return String(out).trim();
  }

  async function translateCurrentPage() {
    if (!pdfState.doc) { toast('先打开一个 PDF'); return; }
    var no = pdfState.current || 1;
    $('#pdfTrans').hidden = false;
    applyTransPanelHeight();
    $('#ptTitle').textContent = '翻译 · 第 ' + no + ' 页';
    var body = $('#ptBody');

    var key = transKeyOf(no);
    if (transCache[key]) {
      pdfState.trans[no] = transCache[key];
      togglePdfTranslation(true);
      showTransResult(no, transCache[key].text);
      return;
    }

    body.innerHTML = '<div class="pt-loading"><span class="spinner sm"></span>正在提取文字…</div>';
    try {
      var page = await pdfState.doc.getPage(no);
      var blocks = await extractBlocks(page);
      if (!blocks.length) {
        body.innerHTML = '<p class="pt-hint">这一页提取不到文字，可能是扫描件/图片型 PDF，暂时无法翻译。</p>';
        return;
      }
      body.innerHTML = '<div class="pt-loading"><span class="spinner sm"></span>正在翻译（' +
        blocks.length + ' 段）…</div>';
      var done = await translateBlocks(blocks);
      var textOut = done.map(function (b) { return b.trans; }).filter(Boolean).join('\n\n');
      var record = { blocks: done, text: textOut };
      transCache[key] = record;
      saveTransCache();
      pdfState.trans[no] = record;
      togglePdfTranslation(true);
      showTransResult(no, textOut);
    } catch (err) {
      console.error(err);
      body.innerHTML = '';
      var p = document.createElement('p');
      p.className = 'pt-hint';
      p.textContent = '翻译失败：' + ((err && err.message) || '未知错误');
      body.appendChild(p);
      var actions = document.createElement('div');
      actions.className = 'pt-actions';
      var retry = document.createElement('button');
      retry.className = 'btn sm';
      retry.textContent = '重试';
      retry.addEventListener('click', translateCurrentPage);
      actions.appendChild(retry);
      var cfgBtn = document.createElement('button');
      cfgBtn.className = 'btn sm';
      cfgBtn.textContent = '翻译设置';
      cfgBtn.addEventListener('click', openSettings);
      actions.appendChild(cfgBtn);
      body.appendChild(actions);
    }
  }

  /* ---------------- 直接选文件夹 ---------------- */
  function dirPickerSupported() {
    try { return 'webkitdirectory' in document.createElement('input'); } catch (e) { return false; }
  }

  function isSkippedPath(path) {
    return /(^|\/)(node_modules|\.git|\.gradle|\.idea|\.vscode|__MACOSX)(\/|$)/.test(path) ||
      /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(path);
  }

  function nativeDirAvailable() {
    return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DirPicker);
  }

  function base64ToBytes(b64) {
    var bin = atob(b64 || '');
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function pickFolder() {
    if (nativeDirAvailable()) { pickNativeDirectory(); return; }
    if (dirPickerSupported()) { $('#dirInput').click(); return; }
    toast('当前环境不支持直接选文件夹，请用压缩包导入');
  }

  async function pickNativeDirectory() {
    busy('正在读取文件夹…（文件多时会慢一点）');
    try {
      var res = await Promise.race([
        window.Capacitor.Plugins.DirPicker.pick(),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('选择文件夹超时，请重试或改用压缩包')); }, 120000);
        })
      ]);
      var entries = [];
      var skipped = 0;
      var list = res.files || [];
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (isSkippedPath(f.p)) { skipped++; continue; }
        var bytes = base64ToBytes(f.d);
        if (!bytes.length) { skipped++; continue; }
        entries.push({ path: f.p, size: bytes.length, data: bytes });
        if (i % 20 === 0) busy('正在解析… ' + (i + 1) + ' / ' + list.length);
      }
      if (!entries.length) throw new Error('文件夹里没有可读取的文件');
      loadProject({ name: res.name || '文件夹', isZip: false, entries: entries, skipped: skipped });
      toast('已导入文件夹「' + (res.name || '') + '」· ' + entries.length + ' 个文件' +
        (res.truncated ? '（内容过多已截断）' : ''));
    } catch (err) {
      var msg = String((err && err.message) || err || '');
      if (msg.indexOf('cancel') < 0) toast('读取文件夹失败：' + msg);
    } finally {
      idle();
    }
  }

  async function importDirectory(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    busy('正在读取文件夹…');
    try {
      var entries = [];
      var skipped = 0;
      var total = 0;
      var root = ((files[0].webkitRelativePath || '').split('/')[0]) || '文件夹';

      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var rel = f.webkitRelativePath || f.name;
        var path = rel.indexOf('/') >= 0 ? rel.split('/').slice(1).join('/') : rel;
        if (!path) continue;
        if (isSkippedPath(path) || f.size > 40 * 1024 * 1024) { skipped++; continue; }
        if (total + f.size > 80 * 1024 * 1024) { skipped++; continue; }

        var data = new Uint8Array(await f.arrayBuffer());
        total += data.length;
        entries.push({ path: path, size: data.length, data: data });
        if (i % 6 === 0) busy('正在读取… ' + (i + 1) + ' / ' + files.length);
      }

      if (!entries.length) throw new Error('这个文件夹里没有可读取的文件');
      var flat = !files.some(function (f) { return !!f.webkitRelativePath; });
      loadProject({ name: root, isZip: false, entries: entries, skipped: skipped });
      toast('已导入「' + root + '」· ' + entries.length + ' 个文件' +
        (flat ? '（系统没返回目录结构）' : '') + (skipped ? '，跳过 ' + skipped + ' 个' : ''));
    } catch (err) {
      console.error(err);
      toast((err && err.message) || '读取文件夹失败');
    } finally {
      idle();
    }
  }

  /* ------------------------------------------------------------
     弹窗
  ------------------------------------------------------------ */
  function openModal(title, bodyHtml, buttons) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHtml;
    var foot = $('#modalFoot');
    foot.innerHTML = '';
    (buttons || []).forEach(function (b) {
      var el = document.createElement('button');
      el.className = 'btn' + (b.primary ? ' primary' : '');
      el.textContent = b.label;
      el.addEventListener('click', b.onClick);
      foot.appendChild(el);
    });
    $('#modal').hidden = false;
  }

  function closeModal() {
    $('#modal').hidden = true;
    var card = document.querySelector('.modal-card');
    if (card) card.classList.remove('modal-wide');
  }

  /* ------------------------------------------------------------
     显示设置
  ------------------------------------------------------------ */
  function applyDisplaySettings() {
    var inline = store.settings.inlineNotes !== false;
    var tree = store.settings.treeNotes !== false;
    var wrap = store.settings.wrapCode === true;
    document.body.classList.toggle('no-inline-notes', !inline);
    document.body.classList.toggle('no-tree-notes', !tree);
    document.body.classList.toggle('code-wrap', wrap);
  }

  function ruleRowsHtml() {
    var rules = store.settings.highlightRules || [];
    return rules.map(function (r, i) {
      return '<div class="rule-row" data-i="' + i + '">' +
        '<input type="color" class="rule-color" value="' + escAttr(r.color || '#ff7b72') + '">' +
        '<input type="text" class="rule-words" value="' + escAttr(r.words || '') + '" placeholder="如 TODO,FIXME">' +
        '<button class="icon-btn sm rule-del" title="删除这组"><svg class="ico sm"><use href="#i-x"/></svg></button>' +
        '</div>';
    }).join('');
  }

  function updateRule(i, key, val) {
    var arr = store.settings.highlightRules || [];
    if (!arr[i]) return;
    arr[i][key] = val;
    saveStore();
    compileHighlights();
  }

  function addRule() {
    var arr = (store.settings.highlightRules || []).slice();
    arr.push({ color: '#ff7b72', words: '' });
    store.settings.highlightRules = arr;
    saveStore();
    compileHighlights();
    openSettings();
  }

  function removeRule(i) {
    var arr = (store.settings.highlightRules || []).slice();
    arr.splice(i, 1);
    store.settings.highlightRules = arr;
    saveStore();
    compileHighlights();
    openSettings();
  }

  function saveTransSettings() {
    var get = function (sel, dflt) { var el = $(sel); return el ? el.value : dflt; };
    var val = get('#trProvider', 'llm:deepseek');
    var provider = val === 'google' ? 'google' : 'llm';
    var preset = val === 'google'
      ? ((store.settings.translate && store.settings.translate.preset) || 'deepseek')
      : (val.split(':')[1] || 'deepseek');
    store.settings.translate = {
      provider: provider,
      preset: preset,
      apiKey: get('#trKey', ''),
      baseURL: get('#trBase', ''),
      model: get('#trModel', ''),
      target: get('#trTarget', '简体中文')
    };
    saveStore();
  }

  function settingsTabBtn(key, label, active) {
    return '<button class="set-tab' + (key === active ? ' on' : '') + '" data-tab="' + key + '">' +
      esc(label) + '</button>';
  }

  function openSettings(tab) {
    var active = tab || 'code';
    var inline = store.settings.inlineNotes !== false;
    var tree = store.settings.treeNotes !== false;
    var wrap = store.settings.wrapCode === true;
    var tr = getTransCfg();

    var codePanel = [
      '<div class="set-list">',
      '<div class="set-row"><div class="set-text"><b>行尾显示行注释</b>' +
      '<span>在每行代码后面显示「   # 注释」（3 个空格 + #）。关闭后注释仍保留，只是不显示。</span></div>',
      '<button class="switch" role="switch" data-key="inlineNotes" aria-checked="' + inline + '"><i></i></button></div>',
      '<div class="set-row"><div class="set-text"><b>目录名称后显示注释</b>' +
      '<span>在左侧文件和文件夹名称后显示「（注释）」，注释单独保存，不写进源码。</span></div>',
      '<button class="switch" role="switch" data-key="treeNotes" aria-checked="' + tree + '"><i></i></button></div>',
      '<div class="set-row"><div class="set-text"><b>代码自动换行</b>' +
      '<span>关闭时（默认）长行不换行，可以左右滑动查看；打开后按窗口宽度折行。</span></div>',
      '<button class="switch" role="switch" data-key="wrapCode" aria-checked="' + wrap + '"><i></i></button></div>',
      '</div>',
      '<div class="set-sep">代码高亮</div>',
      '<div class="set-row"><div class="set-text"><b>注释文字颜色</b>' +
      '<span>行尾「# 注释」的颜色，只影响显示</span></div>' +
      '<input type="color" id="noteColor" value="' + (store.settings.noteColor || '#f2b64b') + '"></div>',
      '<div class="set-field" style="padding-bottom:2px">自定义高亮词（每组一行，词用逗号分隔，如 TODO,FIXME,危险）</div>',
      '<div id="ruleList">' + ruleRowsHtml() + '</div>',
      '<button class="btn sm" id="btnAddRule" style="margin:2px 2px 10px">+ 添加一组</button>',
      '<div class="set-sep">数据与备份</div>',
      '<div class="set-field"><span id="dataPath" style="font-size:11.5px;line-height:1.7;color:var(--muted)">读取中…</span></div>',
      '<div class="set-row"><div class="set-text"><b>导出备份</b>' +
      '<span>全部注释 + 设置导出为 .json，保存位置由你选（可存到任意文件夹）</span></div>' +
      '<button class="btn sm" id="btnBackup">导出</button></div>',
      '<div class="set-row"><div class="set-text"><b>导入备份</b>' +
      '<span>从 .json 恢复，会覆盖当前全部数据</span></div>' +
      '<button class="btn sm" id="btnRestore">导入</button></div>',
      '<div class="set-row"><div class="set-text"><b>备份里包含 AI Key</b>' +
      '<span>默认不包含；打开后导出的 .json 会带上 API Key，注意保管</span></div>' +
      '<button class="switch" role="switch" data-key="backupIncludeKey" aria-checked="' +
      (store.settings.backupIncludeKey === true) + '"><i></i></button></div>'
    ].join('');

    var presetOptions = AI_PRESETS.map(function (p) {
      var on = tr.provider === 'llm' && (tr.preset || 'deepseek') === p.id;
      return '<option value="llm:' + p.id + '"' + (on ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    }).join('');
    var pdfPanel = [
      '<label class="set-field">服务商',
      '<select id="trProvider">',
      presetOptions,
      '<option value="google"' + (tr.provider === 'google' ? ' selected' : '') + '>免费 Google（无需 Key）</option>',
      '</select></label>',
      '<div id="trLlmFields">',
      '<label class="set-field">API Key<input id="trKey" type="password" autocomplete="off" placeholder="sk-..."></label>',
      '<label class="set-field">接口地址<input id="trBase" autocomplete="off" placeholder="https://api.deepseek.com/v1"></label>',
      '<label class="set-field">模型<input id="trModel" autocomplete="off" placeholder="deepseek-chat"></label>',
      '</div>',
      '<label class="set-field">目标语言<input id="trTarget" autocomplete="off" placeholder="简体中文"></label>',
      '<div class="set-sep">账户</div>',
      '<div class="set-row"><div class="set-text"><b>AI 余额</b>' +
      '<span id="balText">用上面的 API Key 查询（DeepSeek）</span></div>' +
      '<button class="btn sm" id="btnBalance">刷新</button></div>'
    ].join('');

    var guidePanel = guideHtml();

    openModal('设置', [
      '<div class="set-shell">',
      '<div class="set-brand-row">',
      '<img src="icon.jpg" alt="">',
      '<div class="set-brand-text"><b>CodeNotes</b><span>v' + APP_VERSION + '</span></div>',
      '</div>',
      '<div class="set-main">',
      '<aside class="set-nav">',
      settingsTabBtn('code', '代码注释及高亮', active),
      settingsTabBtn('pdf', 'PDF · AI 配置', active),
      settingsTabBtn('guide', '软件使用说明', active),
      '</aside>',
      '<div class="set-panels">',
      '<section class="set-panel" data-panel="code"' + (active === 'code' ? '' : ' hidden') + '>' + codePanel + '</section>',
      '<section class="set-panel" data-panel="pdf"' + (active === 'pdf' ? '' : ' hidden') + '>' + pdfPanel + '</section>',
      '<section class="set-panel" data-panel="guide"' + (active === 'guide' ? '' : ' hidden') + '>' + guidePanel + '</section>',
      '</div>',
      '</div>',
      '</div>'
    ].join(''), [{ label: '完成', primary: true, onClick: closeModal }]);

    var card = document.querySelector('.modal-card');
    if (card) card.classList.add('modal-wide');

    // 左侧切换
    $$('.set-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.dataset.tab;
        $$('.set-tab').forEach(function (b) { b.classList.toggle('on', b === btn); });
        $$('.set-panel').forEach(function (p) { p.hidden = p.dataset.panel !== key; });
      });
    });

    $$('#modalBody .switch').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.dataset.key;
        var next = btn.getAttribute('aria-checked') !== 'true';
        btn.setAttribute('aria-checked', String(next));
        store.settings[key] = next;
        saveStore();
        applyDisplaySettings();
      });
    });

    var ncEl = $('#noteColor');
    if (ncEl) {
      ncEl.addEventListener('input', function () {
        store.settings.noteColor = this.value;
        applyNoteColor();
        saveStore();
      });
    }
    $$('#ruleList .rule-row').forEach(function (row) {
      var i = Number(row.dataset.i);
      var c = row.querySelector('.rule-color');
      var w = row.querySelector('.rule-words');
      var d = row.querySelector('.rule-del');
      if (c) c.addEventListener('input', function () { updateRule(i, 'color', this.value); });
      if (w) w.addEventListener('change', function () { updateRule(i, 'words', this.value); });
      if (d) d.addEventListener('click', function () { removeRule(i); });
    });
    var addBtn = $('#btnAddRule');
    if (addBtn) addBtn.addEventListener('click', addRule);

    var keyEl = $('#trKey');
    if (keyEl) keyEl.value = tr.apiKey;
    var baseEl = $('#trBase');
    if (baseEl) baseEl.value = tr.baseURL;
    var modelEl = $('#trModel');
    if (modelEl) modelEl.value = tr.model;
    var targetEl = $('#trTarget');
    if (targetEl) targetEl.value = tr.target;

    var sel = $('#trProvider');
    var fields = $('#trLlmFields');
    var syncFields = function () {
      if (!fields) return;
      // 只有「免费 Google」不需要 Key/地址/模型，其它服务商都要显示
      var isGoogle = sel && sel.value === 'google';
      fields.style.display = isGoogle ? 'none' : '';
    };
    syncFields();
    if (sel) {
      sel.addEventListener('change', function () {
        var val = sel.value;
        if (val === 'google') {
          saveTransSettings();
          syncFields();
          return;
        }
        var pid = val.split(':')[1];
        var preset = AI_PRESETS.filter(function (p) { return p.id === pid; })[0];
        var cur = getTransCfg();
        var next = {
          provider: 'llm',
          preset: pid,
          apiKey: cur.apiKey,
          target: cur.target,
          baseURL: (preset && preset.baseURL) || cur.baseURL,
          model: (preset && preset.model) || cur.model
        };
        store.settings.translate = next;
        saveStore();
        if (baseEl) baseEl.value = next.baseURL;
        if (modelEl) modelEl.value = next.model;
        syncFields();
      });
    }
    ['#trKey', '#trBase', '#trModel', '#trTarget'].forEach(function (q) {
      var el = $(q);
      if (el) el.addEventListener('change', saveTransSettings);
    });

    var balBtn = $('#btnBalance');
    if (balBtn) balBtn.addEventListener('click', refreshBalance);
    var backupBtn = $('#btnBackup');
    if (backupBtn) backupBtn.addEventListener('click', exportBackup);
    var restoreBtn = $('#btnRestore');
    if (restoreBtn) restoreBtn.addEventListener('click', importBackup);
    showDataPath();
  }

  function guideHtml() {
    return [
      '<div class="guide">',
      '<p><b>CodeNotes</b>：本地代码 / 文档注释工具。左侧目录、右侧正文，所有数据只存在本机。</p>',

      '<h4>一、导入</h4>',
      '<ul>',
      '<li>顶栏 <b>上传图标</b>：导入压缩包（.zip）或直接选文件夹（安卓用系统目录选择器，保留完整目录结构）</li>',
      '<li>顶栏 <b>PDF 图标</b>：选单个 PDF，或导入「内含 PDF 的压缩包」</li>',
      '<li>记事本模式：任何文件都按原样显示，乱码也照实显示，不跳过</li>',
      '</ul>',

      '<h4>二、代码阅读与注释</h4>',
      '<ul>',
      '<li>左侧目录：点击切换文件、点文件夹折叠/展开、顶部输入框筛选</li>',
      '<li>文件夹行尾的 <b>铅笔</b>：写目录注释，显示成「名称（注释）」</li>',
      '<li>代码区：行号 + 语法高亮；默认<b>不换行、可左右滑动</b>，双指捏合可缩放字号（4~24px），桌面 Ctrl+滚轮</li>',
      '<li>点任意一行 → 右侧写注释 → 保存（Ctrl+Enter）；行尾显示「   # 注释」，颜色可在设置里改，注释行不再整行高亮</li>',
      '<li>设置里可添加<b>多组自定义高亮词</b>（颜色 + 逗号分隔的词）</li>',
      '<li>右上角「查找」在文件内搜索；「编辑」可改文本；「导出」导出 Markdown 笔记</li>',
      '</ul>',

      '<h4>三、PDF</h4>',
      '<ul>',
      '<li>连续上下滚动翻页，双指捏合缩放，放大后可左右滑动；页码框输入数字可直接跳页</li>',
      '<li><b>查找</b>：搜索 PDF 文字，命中高亮，↑↓ 逐处跟踪</li>',
      '<li><b>目录</b>：压缩包内其它 PDF 一键切换、PDF 书签（可整体翻译书签标题）</li>',
      '<li><b>译</b>：翻译当前页（按原文段落排版、保留图片）；完成后「原文 / 译文」切换，A− / A+ 调译文字号，拖顶部手柄调面板高度</li>',
      '<li>扫描件/图片型 PDF 没有文字层，无法翻译</li>',
      '</ul>',

      '<h4>四、AI 配置</h4>',
      '<ul>',
      '<li>服务商支持 DeepSeek、OpenAI、通义千问、智谱 GLM、Moonshot Kimi、硅基流动、自定义（OpenAI 兼容）与免费 Google</li>',
      '<li>选服务商会自动填好接口地址和模型，只需填对应的 API Key</li>',
      '<li>「AI 余额」点刷新可查 DeepSeek 账户余额</li>',
      '</ul>',

      '<h4>五、数据与备份</h4>',
      '<ul>',
      '<li>注释和设置保存在应用私有目录，系统文件管理器看不到；卸载应用会清空</li>',
      '<li><b>导出备份</b>：全部注释 + 设置存成 .json，保存位置由你选（可另选任意文件夹）</li>',
      '<li><b>导入备份</b>：从任意位置的 .json 恢复</li>',
      '<li>备份默认<b>不包含 API Key</b>，需要的话在下方打开开关</li>',
      '</ul>',

      '<h4>六、启动记忆</h4>',
      '<ul>',
      '<li>启动默认回到<b>代码页</b>，并打开上次看的文件（含滚动位置）</li>',
      '<li>上次的 PDF 会在你点「PDF 阅读」时直接续上，页码不变</li>',
      '</ul>',
      '</div>'
    ].join('');
  }

  function openGuide() {
    openSettings('guide');
  }

  function nativeBridge() {
    return !!(window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DirPicker);
  }

  function buildBackupJson() {
    var settings = JSON.parse(JSON.stringify(store.settings || {}));
    if (!store.settings.backupIncludeKey && settings.translate) {
      delete settings.translate.apiKey;
    }
    return JSON.stringify({
      app: 'CodeNotes',
      version: APP_VERSION,
      at: Date.now(),
      settings: settings,
      projects: store.projects,
      lastFile: store.lastFile || null
    }, null, 2);
  }

  async function showDataPath() {
    var el = $('#dataPath');
    if (!el) return;
    if (nativeBridge() && window.Capacitor.Plugins.DirPicker.dataDir) {
      try {
        var d = await window.Capacitor.Plugins.DirPicker.dataDir();
        el.textContent = '注释和设置保存在应用私有目录：' + d.dir + '（WebView 存储，系统文件管理器看不到）。卸载应用会清空，建议定期导出备份。';
        return;
      } catch (e) { /* 忽略 */ }
    }
    el.textContent = '注释和设置保存在浏览器本地存储（localStorage / IndexedDB）。清理站点数据会清空，建议定期导出备份。';
  }

  async function exportBackup() {
    var content = buildBackupJson();
    var name = 'codenotes-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    try {
      if (nativeBridge() && window.Capacitor.Plugins.DirPicker.saveText) {
        await window.Capacitor.Plugins.DirPicker.saveText({ name: name, content: content });
        toast('备份已导出到你选择的位置');
        return;
      }
      var blob = new Blob([content], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
      toast('已开始下载备份');
    } catch (e) {
      var msg = String((e && e.message) || e);
      if (msg.indexOf('cancel') < 0) toast('导出失败：' + msg);
    }
  }

  async function importBackup() {
    if (nativeBridge() && window.Capacitor.Plugins.DirPicker.openText) {
      try {
        var res = await window.Capacitor.Plugins.DirPicker.openText();
        applyBackup(res.text);
      } catch (e) {
        var msg = String((e && e.message) || e);
        if (msg.indexOf('cancel') < 0) toast('导入失败：' + msg);
      }
      return;
    }
    $('#backupInput').click();
  }

  function applyBackup(text) {
    try {
      var d = JSON.parse(text);
      if (!d || d.app !== 'CodeNotes') throw new Error('不是 CodeNotes 备份文件');
      if (d.settings) store.settings = d.settings;
      if (d.projects) store.projects = d.projects;
      if (d.lastFile) store.lastFile = d.lastFile;
      localStorage.setItem(LS_KEY, JSON.stringify(store));
      toast('备份已恢复，正在重新载入…');
      setTimeout(function () { location.reload(); }, 700);
    } catch (e) {
      toast('导入失败：' + ((e && e.message) || '文件格式不对'));
    }
  }

  async function refreshBalance() {
    var el = $('#balText');
    if (!el) return;
    var cfg = getTransCfg();
    if (!cfg.apiKey) {
      el.textContent = '还没有填 API Key（在上方「PDF 翻译」里填写）';
      return;
    }
    el.textContent = '查询中…';
    try {
      var base = String(cfg.baseURL || 'https://api.deepseek.com/v1').replace(/\/+$/, '').replace(/\/v1$/, '');
      var r = await fetch(base + '/user/balance', {
        headers: { 'Authorization': 'Bearer ' + cfg.apiKey }
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var d = await r.json();
      var info = (d.balance_infos || [])[0];
      if (!info) throw new Error('该服务不支持余额查询');
      el.textContent = '可用 ' + info.total_balance + ' ' + info.currency +
        '（赠送 ' + info.granted_balance + '，充值 ' + info.topped_up_balance + '）';
    } catch (e) {
      el.textContent = '查询失败：' + ((e && e.message) || '未知错误');
    }
  }

  function openGuide() {
    openModal('使用说明', [
      '<div class="guide">',
      '<p><b>CodeNotes</b> 是本地代码 / 文档注释工具：左侧目录、右侧正文，数据只存在本机。</p>',
      '<h4>一、导入代码</h4>',
      '<ul>',
      '<li>顶栏 <b>上传图标</b> → 压缩包 / 文件夹</li>',
      '<li>安卓的「文件夹」用系统目录选择器，保留完整的子目录结构</li>',
      '<li>乱码、二进制文件也照原样显示（记事本模式），不跳过</li>',
      '</ul>',
      '<h4>二、注释</h4>',
      '<ul>',
      '<li>点任意一行 → 在右侧写注释 → 保存（或 Ctrl+Enter）</li>',
      '<li>行尾会以「   # 注释」显示，可在设置里关掉</li>',
      '<li>文件夹行尾的铅笔可写目录注释，显示成「名称（注释）」</li>',
      '<li>右上角 <b>导出</b> 可把注释导出成 Markdown</li>',
      '</ul>',
      '<h4>三、PDF</h4>',
      '<ul>',
      '<li>顶栏 <b>PDF 图标</b> → 选 PDF 文件或导入压缩包；项目里的 PDF 在左侧直接点开</li>',
      '<li>连续滚动翻页，双指捏合缩放，放大后可以左右滑动</li>',
      '<li><b>目录</b>：压缩包内其它 PDF、书签、页面跳转</li>',
      '<li><b>查找</b>：搜索 PDF 文字，用 ↑↓ 逐个跟踪命中位置</li>',
      '<li><b>译</b>：翻译当前页；完成后用「原文 / 译文」切换，A− / A+ 调字号，拖顶部手柄调面板高度</li>',
      '</ul>',
      '<h4>四、设置</h4>',
      '<ul>',
      '<li>行尾注释、目录注释、代码自动换行开关</li>',
      '<li>PDF 翻译：填 DeepSeek / OpenAI 兼容的 API Key（质量优先），也可切免费 Google</li>',
      '<li>AI 余额：点「刷新」查询当前 Key 的余额</li>',
      '</ul>',
      '<h4>五、数据</h4>',
      '<ul>',
      '<li>注释保存在本机，卸载应用会清空，重要内容请先导出</li>',
      '<li>会自动记住上次打开的项目、PDF 和页码</li>',
      '</ul>',
      '</div>'
    ].join(''), [{ label: '知道了', primary: true, onClick: closeModal }]);
  }

  /* ------------------------------------------------------------
     示例项目
  ------------------------------------------------------------ */
  function demoProject() {
    var enc = new TextEncoder();
    var mk = function (path, text) { return { path: path, size: 0, data: enc.encode(text) }; };

    var files = [
      mk('README.md', [
        '# CodeNotes 示例项目',
        '',
        '这是一份用来体验 CodeNotes 的迷你示例：',
        '',
        '- 左侧是真实的目录结构，文件夹可以折叠',
        '- 点击文件切换，点击任意一行写注释',
        '- 注释保存在浏览器本地，和源码分开',
        '',
        '## 目录说明',
        '',
        '| 目录 | 内容 |',
        '| --- | --- |',
        '| src/ | 一个虚构的小型编辑器 |',
        '| python/ | 数据清洗脚本 |',
        '| config/ | 配置文件 |',
        '',
        '## 建议的体验顺序',
        '',
        '1. 打开 `src/main.js`，试着点第 12 行写一句注释',
        '2. 在左侧折叠 / 展开 `src/core`',
        '3. 点右上角「注释」收起面板，看正文是否变宽',
        '4. 点右上角导出，看看注释笔记长什么样'
      ].join('\n')),

      mk('src/main.js', [
        "import { tokenize } from './core/lexer.js';",
        "import { renderLines } from './core/renderer.js';",
        '',
        'export const state = {',
        '  project: null,',
        '  current: null,',
        '  notes: new Map(),',
        '};',
        '',
        '// 导入压缩包后建立目录树',
        'export function loadProject(project) {',
        '  state.project = project;',
        '  return buildTree(project.entries);',
        '}',
        '',
        'export function buildTree(entries) {',
        "  const root = { type: 'dir', name: '', path: '', children: [] };",
        '  for (const entry of entries) {',
        "    const parts = entry.path.split('/');",
        '    let cursor = root;',
        '    let prefix = "";',
        '    parts.forEach((part, index) => {',
        '      prefix = prefix ? `${prefix}/${part}` : part;',
        '      const isFile = index === parts.length - 1;',
        "      let node = (cursor.children || []).find(c => c.name === part);",
        '      if (!node) {',
        '        node = {',
        "          type: isFile ? 'file' : 'dir',",
        '          name: part,',
        '          path: prefix,',
        '          children: isFile ? undefined : [],',
        '        };',
        '        cursor.children.push(node);',
        '      }',
        '      cursor = node;',
        '    });',
        '  }',
        '  return root;',
        '}',
        '',
        '// 打开文件：切换前先保存正在编辑的注释',
        'export function openFile(path) {',
        '  flushNote();',
        '  const entry = state.project.byPath.get(path);',
        '  if (!entry) return;',
        '  state.current = path;',
        '  const tokens = tokenize(entry.text, entry.lang);',
        '  renderLines(tokens, { notes: state.notes.get(path) });',
        '}',
        '',
        'export function flushNote() {',
        '  const draft = document.querySelector("#note-input");',
        '  if (!draft || !state.current) return;',
        '  state.notes.set(state.current, draft.value);',
        '}'
      ].join('\n')),

      mk('src/core/lexer.js', [
        '// 一个只够用的词法分析器：把源码切成 token',
        'const KEYWORDS = new Set([',
        "  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',",
        "  'class', 'new', 'import', 'export', 'from', 'async', 'await', 'try', 'catch',",
        ']);',
        '',
        'export function tokenize(source, lang = "js") {',
        '  const tokens = [];',
        '  let i = 0;',
        '  while (i < source.length) {',
        '    const ch = source[i];',
        '',
        '    // 跳过空白，但保留换行',
        '    if (/\\s/.test(ch)) {',
        "      if (ch === '\\n') tokens.push({ type: 'newline' });",
        '      i += 1;',
        '      continue;',
        '    }',
        '',
        '    // 注释',
        "    if (source.startsWith('//', i)) {",
        "      const end = source.indexOf('\\n', i);",
        "      const stop = end === -1 ? source.length : end;",
        "      tokens.push({ type: 'comment', value: source.slice(i, stop) });",
        '      i = stop;',
        '      continue;',
        '    }',
        '',
        '    // 字符串',
        "    if (ch === '\"' || ch === \"'\") {",
        '      let j = i + 1;',
        '      while (j < source.length && source[j] !== ch) {',
        "        if (source[j] === '\\\\') j += 1;",
        '        j += 1;',
        '      }',
        "      tokens.push({ type: 'string', value: source.slice(i, j + 1) });",
        '      i = j + 1;',
        '      continue;',
        '    }',
        '',
        '    // 标识符 / 关键字',
        '    const word = /^[A-Za-z_$][\\w$]*/.exec(source.slice(i));',
        '    if (word) {',
        "      tokens.push({ type: KEYWORDS.has(word[0]) ? 'keyword' : 'name', value: word[0] });",
        '      i += word[0].length;',
        '      continue;',
        '    }',
        '',
        '    tokens.push({ type: "punct", value: ch });',
        '    i += 1;',
        '  }',
        '  return tokens;',
        '}'
      ].join('\n')),

      mk('src/core/renderer.js', [
        '// 把 token 渲染成一行一行的 DOM',
        "import { escapeHtml } from './escape.js';",
        '',
        'const CHUNK = 400;',
        '',
        'export function renderLines(tokens, options = {}) {',
        "  const host = document.querySelector('#lines');",
        "  host.innerHTML = '';",
        '  const lines = splitLines(tokens);',
        '  let rendered = 0;',
        '',
        '  const draw = () => {',
        '    const until = Math.min(rendered + CHUNK, lines.length);',
        '    for (let n = rendered; n < until; n += 1) {',
        '      host.appendChild(buildRow(n + 1, lines[n], options));',
        '    }',
        '    rendered = until;',
        '    if (rendered < lines.length) requestAnimationFrame(draw);',
        '  };',
        '  draw();',
        '}',
        '',
        'function buildRow(no, tokens, options) {',
        "  const row = document.createElement('div');",
        "  row.className = 'crow';",
        '  row.dataset.n = String(no);',
        "  const note = options.notes ? options.notes[no] : '';",
        "  row.innerHTML = `<span class=\"ln\">${no}</span>` +",
        '    `<span class="code">${tokens.map(renderToken).join(\'\')}</span>`;',
        "  if (note) row.classList.add('has-note');",
        '  return row;',
        '}',
        '',
        'function renderToken(token) {',
        "  if (token.type === 'newline') return '\\n';",
        '  return `<span class="t-${token.type}">${escapeHtml(token.value)}</span>`;',
        '}',
        '',
        'function splitLines(tokens) {',
        '  const lines = [[]];',
        '  for (const token of tokens) {',
        "    if (token.type === 'newline') lines.push([]);",
        '    else lines[lines.length - 1].push(token);',
        '  }',
        '  return lines;',
        '}'
      ].join('\n')),

      mk('src/core/escape.js', [
        'export function escapeHtml(text) {',
        '  return String(text)',
        "    .replace(/&/g, '&amp;')",
        "    .replace(/</g, '&lt;')",
        "    .replace(/>/g, '&gt;');",
        '}'
      ].join('\n')),

      mk('python/analyze.py', [
        '"""统计一个压缩包里各语言的代码行数。"""',
        '',
        'import io',
        'import zipfile',
        'from collections import Counter',
        '',
        '',
        'def count_lines(zip_path):',
        '    stats = Counter()',
        '    with zipfile.ZipFile(zip_path) as zf:',
        '        for info in zf.infolist():',
        '            if info.is_dir():',
        '                continue',
        '            ext = info.filename.rsplit(".", 1)[-1].lower()',
        '            if ext not in {"py", "js", "ts", "java", "go"}:',
        '                continue',
        '            try:',
        '                text = zf.read(info).decode("utf-8")',
        '            except UnicodeDecodeError:',
        '                text = zf.read(info).decode("gbk", "ignore")',
        '            stats[ext] += len(text.splitlines())',
        '    return stats',
        '',
        '',
        'if __name__ == "__main__":',
        '    for lang, n in count_lines("project.zip").most_common():',
        '        print(f"{lang:>5}: {n:>6} 行")'
      ].join('\n')),

      mk('config/settings.json', [
        '{',
        '  "theme": "auto",',
        '  "fontSize": 13,',
        '  "autoSave": true,',
        '  "sidebar": {',
        '    "width": 276,',
        '    "collapsed": false',
        '  }',
        '}'
      ].join('\n')),

      mk('assets/app.css', [
        ':root {',
        '  --accent: #2f6bff;',
        '  --code-size: 13px;',
        '}',
        '',
        '.crow {',
        '  display: flex;',
        '  font: var(--code-size) / 1.7 ui-monospace, monospace;',
        '}',
        '',
        '.crow.has-note {',
        '  background: rgba(217, 119, 6, 0.08);',
        '}',
        '',
        '.t-kw { color: #7c3aed; }',
        '.t-str { color: #16794a; }',
        '.t-com { color: #8b93a1; font-style: italic; }'
      ].join('\n'))
    ];

    files.forEach(function (f) { f.size = f.data.length; });
    return { isZip: false, name: '示例项目', entries: files, skipped: 0 };
  }

  function seedDemoNotes(bucket, byPath) {
    if (Object.keys(bucket.notes).length) return;

    var add = function (path, needle, note) {
      var entry = byPath.get(path);
      if (!entry) return;
      var text;
      try { text = ZipReader.decodeText(entry.data).text; } catch (e) { return; }
      var lines = text.split(/\r\n|\n|\r/);
      var idx = -1;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(needle) >= 0) { idx = i + 1; break; }
      }
      if (idx < 0) return;
      var rec = bucket.notes[path] || (bucket.notes[path] = {});
      if (!rec.lines) rec.lines = {};
      rec.lines[idx] = note;
    };

    add('src/main.js', 'export function loadProject', '导入压缩包后，把文件列表整理成目录树，再交给左侧面板渲染。');
    add('src/main.js', 'export function openFile', '切换文件前先 flushNote()，否则正在写的注释会丢。');
    add('src/core/lexer.js', 'export function tokenize', '词法分析：把源码切成 token 序列，注释、字符串、关键字分别标记。');
    add('src/core/renderer.js', 'const CHUNK = 400', '分块渲染：一次 400 行，长文件也不会卡住。');
    add('config/settings.json', '"theme"', 'auto 跟随系统，也可以固定 light / dark。');

    var r = bucket.notes['README.md'] || (bucket.notes['README.md'] = {});
    r.file = '示例项目说明：先读这里，再看 src/ 里的实现。左侧目录里的橙点表示这个文件已有注释。';
    bucket.updatedAt = Date.now();
  }

  /* ------------------------------------------------------------
     事件绑定
  ------------------------------------------------------------ */
  function bindEvents() {
    $('#btnSidebar').addEventListener('click', toggleSidebar);
    $('#btnSidebarClose').addEventListener('click', function () { setSidebar(false, true); });
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnTheme').addEventListener('click', cycleTheme);
    $('#btnExport').addEventListener('click', exportNotes);
    $('#btnNotes').addEventListener('click', toggleNotes);
    $('#notesClose').addEventListener('click', function () { setNotesPanel(false); });
    $('#btnCollapse').addEventListener('click', function () {
      state.expanded.clear();
      persistExpanded();
      renderTree();
      toast('目录已全部折叠');
    });

    $('#btnImport').addEventListener('click', function (e) {
      e.stopPropagation();
      $('#importMenu').hidden = !$('#importMenu').hidden;
      $('#pdfMenu').hidden = true;
    });
    $('#btnImportZip').addEventListener('click', function () {
      $('#importMenu').hidden = true;
      $('#fileInput').click();
    });
    $('#btnImportDir').addEventListener('click', function () {
      $('#importMenu').hidden = true;
      pickFolder();
    });
    document.addEventListener('click', function (e) {
      if (!$('#importMenu').hidden && !e.target.closest('#importWrap')) $('#importMenu').hidden = true;
      if (!$('#pdfMenu').hidden && !e.target.closest('#pdfWrap')) $('#pdfMenu').hidden = true;
      // 点 PDF 目录以外的地方收起目录
      if (!$('#pdfOutline').hidden && !e.target.closest('#pdfOutline') && !e.target.closest('#btnPdfOutline')) {
        setPdfOutline(false);
      }
    });

    $('#btnPdfImport').addEventListener('click', function (e) {
      e.stopPropagation();
      $('#pdfMenu').hidden = !$('#pdfMenu').hidden;
      $('#importMenu').hidden = true;
    });
    $('#btnPdfFile').addEventListener('click', function () {
      $('#pdfMenu').hidden = true;
      $('#pdfInput').click();
    });
    $('#btnPdfZip').addEventListener('click', function () {
      $('#pdfMenu').hidden = true;
      $('#pdfZipInput').click();
    });
    $('#pdfZipInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) importPdfZip(f);
    });
    $('#pdfPageInput').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var n = parseInt(this.value, 10);
      if (!isNaN(n) && pdfState.doc) goToPage(n);
      else if (pdfState.doc) setPdfPageLabel(pdfState.current, pdfState.doc.numPages);
      this.blur();
    });
    $('#pdfPageInput').addEventListener('focus', function () { this.select(); });
    $('#pdfPageInput').addEventListener('blur', function () {
      if (!pdfState.doc) return;
      var n = parseInt(this.value, 10);
      if (!isNaN(n) && n !== pdfState.current) goToPage(n);
      else setPdfPageLabel(pdfState.current, pdfState.doc.numPages);
    });

    $('#btnPdfFind').addEventListener('click', openPdfFind);
    $('#pdfFindClose').addEventListener('click', closePdfFind);
    $('#pdfFindPrev').addEventListener('click', function () { stepPdfMatch(-1); });
    $('#pdfFindNext').addEventListener('click', function () { stepPdfMatch(1); });
    var pdfFindTimer = 0;
    $('#pdfFindInput').addEventListener('input', function () {
      clearTimeout(pdfFindTimer);
      pdfFindTimer = setTimeout(runPdfSearch, 400);
    });
    $('#pdfFindInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); stepPdfMatch(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') closePdfFind();
    });

    $('#btnPdfOutline').addEventListener('click', function () { setPdfOutline(); });
    $('#poClose').addEventListener('click', function () { setPdfOutline(false); });
    $('#poTranslate').addEventListener('click', translateOutline);

    $('#btnWelcomeImport').addEventListener('click', function () { $('#fileInput').click(); });
    $('#btnWelcomeDir').addEventListener('click', function () { pickFolder(); });
    $('#backupInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      f.text().then(applyBackup).catch(function () { toast('读取备份失败'); });
    });

    $('#dirInput').addEventListener('change', function (e) {
      var files = e.target.files;
      if (files && files.length) importDirectory(files);
      e.target.value = '';
    });
    $('#btnDemo').addEventListener('click', loadDemo);
    $('#btnWelcomeDemo').addEventListener('click', loadDemo);

    $('#fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) importFile(f);
    });

    $('#btnFind').addEventListener('click', function () {
      if ($('#findbar').hidden) openFind(); else closeFind();
    });
    $('#findClose').addEventListener('click', closeFind);
    $('#findInput').addEventListener('input', runFind);
    $('#findPrev').addEventListener('click', function () { stepFind(-1); });
    $('#findNext').addEventListener('click', function () { stepFind(1); });
    $('#findInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') closeFind();
    });

    $('#tabCode').addEventListener('click', function () { setTab('code'); });
    $('#tabPdf').addEventListener('click', function () { setTab('pdf'); });
    $('#btnEmptyOpen').addEventListener('click', function () { $('#pdfInput').click(); });
    $('#pdfInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) openPdfFile(f);
    });
    $('#pdfZoomIn').addEventListener('click', function () { pdfZoom(1); });
    $('#pdfZoomOut').addEventListener('click', function () { pdfZoom(-1); });
    $('#pdfFit').addEventListener('click', function () { pdfFit(); });
    $('#btnTranslate').addEventListener('click', translateCurrentPage);
    $('#pdfTransToggle').addEventListener('click', function () { togglePdfTranslation(); });
    $('#ptClose').addEventListener('click', function () { $('#pdfTrans').hidden = true; });
    bindTransPanelDrag();
    $('#pdfStage').addEventListener('scroll', onPdfScroll, { passive: true });
    bindCodeGestures();
    bindPdfGestures();

    $('#btnEdit').addEventListener('click', toggleEdit);
    $('#fileMeta').addEventListener('click', function (e) {
      var t = e.target.closest('[data-act="revert"]');
      if (t) revertContent();
    });

    $('#tree').addEventListener('click', function (e) {
      var edit = e.target.closest('.row-edit');
      if (edit) {
        e.stopPropagation();
        var erow = edit.closest('.trow');
        if (!erow) return;
        if (erow.dataset.kind === 'dir') {
          editDirNote(erow.dataset.path);
        } else {
          openFile(erow.dataset.path);
          if (isMobile()) setSidebar(false, false);
          if (!/\.pdf$/i.test(erow.dataset.path)) {
            setNotesPanel(true);
            setTimeout(function () {
              var fn = $('#fileNote');
              if (fn) fn.focus();
            }, 120);
          }
        }
        return;
      }
      var row = e.target.closest('.trow');
      if (!row) return;
      if (row.dataset.kind === 'dir') {
        var p = row.dataset.path;
        if (state.expanded.has(p)) state.expanded.delete(p);
        else state.expanded.add(p);
        persistExpanded();
        renderTree();
      } else {
        openFile(row.dataset.path);
        if (isMobile()) setSidebar(false, false);
      }
    });

    $('#tree').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var t = e.target;
      if (t && t.classList && (t.classList.contains('trow') || t.classList.contains('row-edit'))) {
        e.preventDefault();
        t.click();
      }
    });

    $('#treeFilter').addEventListener('input', function (e) {
      state.filter = e.target.value;
      $('#btnClearFilter').hidden = !state.filter;
      renderTree();
    });
    $('#btnClearFilter').addEventListener('click', function () {
      state.filter = '';
      $('#treeFilter').value = '';
      $('#btnClearFilter').hidden = true;
      renderTree();
    });

    var viewScrollTimer = 0;
    $('#viewer').addEventListener('scroll', function () {
      clearTimeout(viewScrollTimer);
      viewScrollTimer = setTimeout(function () {
        if (!store.lastFile || store.lastFile.path !== state.current) return;
        store.lastFile.scroll = $('#viewer').scrollTop;
        saveStore();
      }, 400);
    }, { passive: true });

    $('#lines').addEventListener('click', function (e) {
      if (e.target.closest('.load-more')) return;
      var row = e.target.closest('.crow');
      if (!row) return;
      selectLine(Number(row.dataset.n));
    });

    $('#noteList').addEventListener('click', function (e) {
      var item = e.target.closest('.note-item');
      if (!item) return;
      if (state.editing) {
        toggleEdit();
        setTimeout(function () { jumpToLine(Number(item.dataset.line)); }, 30);
      } else {
        jumpToLine(Number(item.dataset.line));
      }
    });

    $('#btnSaveNote').addEventListener('click', saveCurrentNote);
    $('#btnDeleteNote').addEventListener('click', function () {
      if (state.selectedLine === null) return;
      setLineNote(state.current, state.selectedLine, '');
      renderComposer();
      toast('已删除该行注释');
    });
    $('#noteInput').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        saveCurrentNote();
      }
    });
    $('#noteInput').addEventListener('blur', function () {
      setTimeout(function () {
        if (document.activeElement === $('#noteInput')) return;
        flushComposer();
      }, 120);
    });

    var fileNoteTimer = 0;
    $('#fileNote').addEventListener('input', function () {
      clearTimeout(fileNoteTimer);
      fileNoteTimer = setTimeout(function () {
        if (!state.current) return;
        var val = $('#fileNote').value.trim();
        var rec = ensureRec(state.current);
        if (val) rec.file = val; else delete rec.file;
        pruneRec(state.current);
        saveStore();
        renderNoteList();
        renderNoteStat();
        refreshTreeDot(state.current);
        updateTreeLabel(state.current);
        renderHead();
      }, 400);
    });

    $('#scrim').addEventListener('click', closeSheets);
    $('#modalClose').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', function (e) {
      if (e.target === $('#modal')) closeModal();
    });

    // 拖动导入
    var dragDepth = 0;
    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer) return;
      dragDepth++;
      if ($('#welcome').hidden === false) $('#dropzone').classList.add('drag');
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('#dropzone').classList.remove('drag');
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      $('#dropzone').classList.remove('drag');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importFile(f);
    });

    // 快捷键
    document.addEventListener('keydown', function (e) {
      var meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleSidebar();
      } else if (meta && (e.key === 'f' || e.key === 'F')) {
        if (!state.current) return;
        e.preventDefault();
        openFind();
      } else if (meta && (e.key === 's' || e.key === 'S')) {
        if (document.activeElement === $('#noteInput')) { e.preventDefault(); saveCurrentNote(); }
        else if (state.editing) { e.preventDefault(); toggleEdit(); }
      } else if (e.key === 'Escape') {
        if (!$('#importMenu').hidden) { $('#importMenu').hidden = true; return; }
        if (!$('#modal').hidden) { closeModal(); return; }
        if (document.activeElement === $('#findInput')) { closeFind(); return; }
        closeSheets();
        $('#dropzone').classList.remove('drag');
      }
    });

    var wasMobile = isMobile();
    window.addEventListener('resize', function () {
      clearTimeout(window.__cnResize);
      window.__cnResize = setTimeout(function () {
        var m = isMobile();
        if (m !== wasMobile) {
          wasMobile = m;
          // 从桌面宽度切到手机宽度时，把抽屉收回
          if (m) { setSidebar(false, false); setNotesPanel(false); }
        }
        if (!m) document.body.classList.remove('scrim-on');
        updateScrim();
        if (pdfState.doc && pdfState.fit) { pdfState.scale = fitScale(); applyScale(); }
      }, 150);
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener &&
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  }

  /* ------------------------------------------------------------
     启动
  ------------------------------------------------------------ */
  function loadDemo() {
    var proj = demoProject();
    loadProject(proj, { seed: true });
    if (isMobile()) setSidebar(false, false);
    toast('已载入示例项目 · 左侧点开 src/ 看看');
  }

  function showFatal(msg) {
    var el = document.getElementById('errBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'errBanner';
      el.className = 'err-banner';
      el.addEventListener('click', function () { el.remove(); });
      document.body.appendChild(el);
    }
    el.textContent = '出错了：' + String(msg).slice(0, 300) + '（点我关闭）';
  }

  function init() {
    window.addEventListener('error', function (e) { showFatal(e.message || '脚本错误'); });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e.reason;
      showFatal((r && (r.message || r)) || '未处理的错误');
    });

    applyTheme();
    applyDisplaySettings();
    compileHighlights();
    applyNoteColor();
    pdfState.transScale = Number(store.settings.transScale) || 1;
    if (store.settings.codeFont) setCodeFont(Number(store.settings.codeFont) || 13);

    if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }
    if (!dirPickerSupported() && !nativeDirAvailable()) {
      $('#btnImportDir').hidden = true;
      $('#btnWelcomeDir').hidden = true;
    }

    var mobile = isMobile();
    var sb = mobile ? false : (store.settings.sidebar !== false);
    var np = mobile ? false : (store.settings.notesPanel !== false);
    setSidebar(sb, false);
    setNotesPanel(np);

    document.body.classList.add('no-file');
    $('#welcome').hidden = false;
    $('#editor').hidden = true;
    renderTree();
    renderProjectCard();
    renderNoteStat();
    renderComposer();
    bindEvents();
    updateScrim();

    var sample = new URLSearchParams(location.search).get('sample');
    if (sample === 'zip') {
      busy('正在载入示例压缩包…');
      fetch('demo-project.zip')
        .then(function (r) { return r.blob(); })
        .then(function (blob) {
          var f = new File([blob], 'demo-project.zip', { type: 'application/zip' });
          return importFile(f);
        })
        .catch(function () { toast('示例压缩包载入失败'); })
        .then(function () { idle(); });
    } else {
      restoreLast();
    }

    setTimeout(restorePdfSession, 900);

    // PWA：离线可用（http/https 下才注册）
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* 忽略 */ });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
