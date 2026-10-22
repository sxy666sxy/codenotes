/* ============================================================
   app.js · CodeNotes 主逻辑
   ============================================================ */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var esc = function (s) { return HL.escape(String(s == null ? '' : s)); };

  var LS_KEY = 'codenotes.v1';
  var MAX_PREVIEW = 2 * 1024 * 1024;   // 单个文本文件预览上限（字符）

  /* ------------------------------------------------------------
     状态
  ------------------------------------------------------------ */
  var store = loadStore();

  var state = {
    project: null,
    sig: null,
    current: null,
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

    var first = pickFirstFile(entries);
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
    $$('#tree .trow.active').forEach(function (el) { el.classList.remove('active'); });
    if (!state.current) return;
    var row = $('#tree .trow.file[data-path="' + cssEsc(state.current) + '"]');
    if (row) {
      row.classList.add('active');
      var r = row.getBoundingClientRect();
      var box = $('#tree').getBoundingClientRect();
      if (r.top < box.top + 4 || r.bottom > box.bottom - 4) {
        row.scrollIntoView({ block: 'nearest' });
      }
    }
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
    } else if (entry.size > 6 * 1024 * 1024) {
      state.binary = true;
      state.notice = '文件超过 6MB，暂不载入预览。你仍然可以为它写整体注释。';
    } else if (ZipReader.isBinary(entry.data)) {
      state.binary = true;
      state.notice = '这是二进制文件，无法作为文本预览。你仍然可以为它写整体注释。';
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
  }

  function renderHead() {
    if (!state.current) return;
    var parts = state.current.split('/');
    var html = parts.map(function (p, i) {
      var name = esc(p);
      return i === parts.length - 1
        ? '<span class="last">' + name + '</span>'
        : '<span>' + name + '</span><span class="sep">/</span>';
    }).join('');
    $('#crumbs').innerHTML = html;

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
      var res = HL.render(raw, state.lang, state.hl);
      state.hl = res.st;
      var n = i + 1;
      var noteVal = notes[n];
      var row = document.createElement('div');
      row.className = 'crow';
      row.dataset.n = String(n);
      if (noteVal) row.classList.add('has-note');
      if (state.findTerm && raw.toLowerCase().indexOf(state.findTerm) >= 0) row.classList.add('hit');
      var html = res.html || ' ';
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

  function closeModal() { $('#modal').hidden = true; }

  /* ------------------------------------------------------------
     显示设置
  ------------------------------------------------------------ */
  function applyDisplaySettings() {
    var inline = store.settings.inlineNotes !== false;
    var tree = store.settings.treeNotes !== false;
    document.body.classList.toggle('no-inline-notes', !inline);
    document.body.classList.toggle('no-tree-notes', !tree);
  }

  function openSettings() {
    var inline = store.settings.inlineNotes !== false;
    var tree = store.settings.treeNotes !== false;

    openModal('显示设置', [
      '<div class="set-list">',
      '<div class="set-row"><div class="set-text"><b>行尾显示行注释</b>' +
      '<span>在每行代码后面显示「   # 注释」，即 3 个空格 + #。关闭后注释仍保留，只是不显示。</span></div>',
      '<button class="switch" role="switch" data-key="inlineNotes" aria-checked="' + inline + '"><i></i></button></div>',
      '<div class="set-row"><div class="set-text"><b>目录名称后显示注释</b>' +
      '<span>在左侧文件和文件夹名称后显示「（注释）」。注释是单独保存的，不会写进源码。</span></div>',
      '<button class="switch" role="switch" data-key="treeNotes" aria-checked="' + tree + '"><i></i></button></div>',
      '</div>'
    ].join(''), [{ label: '完成', primary: true, onClick: closeModal }]);

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

    $('#btnImport').addEventListener('click', function () { $('#fileInput').click(); });
    $('#btnWelcomeImport').addEventListener('click', function () { $('#fileInput').click(); });
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
          setNotesPanel(true);
          setTimeout(function () {
            var fn = $('#fileNote');
            if (fn) fn.focus();
          }, 120);
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

  function init() {
    applyTheme();
    applyDisplaySettings();

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
