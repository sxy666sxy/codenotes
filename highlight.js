/* ============================================================
   highlight.js · 轻量语法高亮（按行扫描，跨行注释状态可延续）
   ============================================================ */
(function (global) {
  'use strict';

  function esc(s) {
    return s.replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }

  var KW_C = new Set(('abstract as async await bool boolean break byte case catch char class const ' +
    'constexpr constructor continue debugger declare default defer delete do double elif else enum ' +
    'eval except export extends extern false final finally float fn for foreach friend from func ' +
    'function get goto if impl implements import in inline instanceof interface is lambda let long ' +
    'loop match module mut namespace native new nil not null nullptr of operator or override package ' +
    'private protected pub public readonly ref return sealed self short signed sizeof static struct ' +
    'super switch synchronized template this throw throws transient true try type typeof typedef ' +
    'union unsafe unsigned use using var virtual void volatile where while with yield undefined')
    .split(/\s+/));

  var KW_HASH = new Set(('and as assert async await begin break case class continue def del do done ' +
    'each elif else elsif end ensure except exec exit export false fi finally for from function global ' +
    'goto if import in is lambda local module nil none not or pass print raise require rescue return ' +
    'self set then true try unless until when while with yield echo declare source shift unset ' +
    'True False None')
    .split(/\s+/));

  var KW_JSON = new Set(['true', 'false', 'null']);

  var CFG = {
    clike: { line: ['//'], blockOpen: '/*', blockEnd: '*/', kw: KW_C },
    hash:  { line: ['#'], blockOpen: null, blockEnd: null, kw: KW_HASH },
    json:  { line: [], blockOpen: null, blockEnd: null, kw: KW_JSON }
  };

  var EXT_LANG = {
    js: 'clike', jsx: 'clike', mjs: 'clike', cjs: 'clike', ts: 'clike', tsx: 'clike',
    java: 'clike', c: 'clike', h: 'clike', cpp: 'clike', cc: 'clike', cxx: 'clike', hpp: 'clike',
    cs: 'clike', go: 'clike', rs: 'clike', kt: 'clike', kts: 'clike', swift: 'clike',
    php: 'clike', dart: 'clike', scala: 'clike', m: 'clike', mm: 'clike', groovy: 'clike',
    vue: 'html', svelte: 'html',
    py: 'hash', pyw: 'hash', rb: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', fish: 'hash',
    yml: 'hash', yaml: 'hash', toml: 'hash', ini: 'hash', conf: 'hash', cfg: 'hash',
    pl: 'hash', r: 'hash', ps1: 'hash', mk: 'hash', make: 'hash', env: 'hash', properties: 'hash',
    json: 'json', jsonc: 'json', json5: 'json', geojson: 'json',
    html: 'html', htm: 'html', xhtml: 'html', xml: 'html', svg: 'html', xsl: 'html',
    css: 'css', scss: 'css', less: 'css', sass: 'css',
    md: 'md', markdown: 'md', mdx: 'md',
    sql: 'hash', gradle: 'clike'
  };

  function langOf(path) {
    var name = String(path || '').split('/').pop();
    if (/^\.(env|gitignore|gitattributes|dockerignore|npmrc|editorconfig)/i.test(name)) return 'hash';
    var m = /\.([A-Za-z0-9]+)$/.exec(name);
    if (!m) return 'plain';
    return EXT_LANG[m[1].toLowerCase()] || 'plain';
  }

  /* ---------------- 通用扫描器 ---------------- */
  function scanCode(line, cfg, st) {
    var out = '';
    var i = 0;
    var n = line.length;

    function push(cls, txt) {
      if (!txt) return;
      out += cls ? '<span class="t-' + cls + '">' + esc(txt) + '</span>' : esc(txt);
    }

    if (st && st.block) {
      var endIdx = line.indexOf(cfg.blockEnd);
      if (endIdx === -1) {
        push('com', line);
        return { html: out, st: { block: true } };
      }
      push('com', line.slice(0, endIdx + cfg.blockEnd.length));
      i = endIdx + cfg.blockEnd.length;
    }

    while (i < n) {
      if (cfg.blockOpen && line.startsWith(cfg.blockOpen, i)) {
        var e = line.indexOf(cfg.blockEnd, i + cfg.blockOpen.length);
        if (e === -1) {
          push('com', line.slice(i));
          return { html: out, st: { block: true } };
        }
        push('com', line.slice(i, e + cfg.blockEnd.length));
        i = e + cfg.blockEnd.length;
        continue;
      }

      var isLineComment = false;
      for (var li = 0; li < cfg.line.length; li++) {
        if (line.startsWith(cfg.line[li], i)) { isLineComment = true; break; }
      }
      if (isLineComment) {
        push('com', line.slice(i));
        break;
      }

      var c = line[i];

      if (c === '"' || c === "'" || c === '`') {
        var j = i + 1;
        while (j < n) {
          if (line[j] === '\\') { j += 2; continue; }
          if (line[j] === c) { j++; break; }
          j++;
        }
        if (j > n) j = n;
        push('str', line.slice(i, j));
        i = j;
        continue;
      }

      if (c >= '0' && c <= '9') {
        var nm = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(line.slice(i));
        if (nm) {
          push('num', nm[0]);
          i += nm[0].length;
          continue;
        }
      }

      var idm = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(line.slice(i));
      if (idm) {
        var word = idm[0];
        var isKw = cfg.kw && cfg.kw.has(word);
        if (isKw) {
          push('kw', word);
        } else {
          var k = i + word.length;
          while (k < n && (line[k] === ' ' || line[k] === '\t')) k++;
          push(line[k] === '(' ? 'fn' : 'var', word);
        }
        i += word.length;
        continue;
      }

      push(null, c);
      i++;
    }

    return { html: out, st: { block: false } };
  }

  /* ---------------- HTML / XML ---------------- */
  function scanHtml(line, st) {
    var out = '';
    var i = 0;
    var n = line.length;

    function push(cls, txt) {
      if (!txt) return;
      out += cls ? '<span class="t-' + cls + '">' + esc(txt) + '</span>' : esc(txt);
    }

    if (st && st.block) {
      var e0 = line.indexOf('-->');
      if (e0 === -1) {
        push('com', line);
        return { html: out, st: { block: true } };
      }
      push('com', line.slice(0, e0 + 3));
      i = e0 + 3;
    }

    while (i < n) {
      if (line.startsWith('<!--', i)) {
        var e1 = line.indexOf('-->', i + 4);
        if (e1 === -1) {
          push('com', line.slice(i));
          return { html: out, st: { block: true } };
        }
        push('com', line.slice(i, e1 + 3));
        i = e1 + 3;
        continue;
      }

      if (line[i] === '<' || line[i] === '&') {
        var tm = /^<\/?([A-Za-z][\w:.-]*)/.exec(line.slice(i));
        if (tm) {
          push('kw', tm[0]);
          i += tm[0].length;
          while (i < n && line[i] !== '>') {
            var am = /^([A-Za-z_:][\w:.-]*)/.exec(line.slice(i));
            if (am) {
              push('var', am[1]);
              i += am[1].length;
              var eq = /^\s*=\s*/.exec(line.slice(i));
              if (eq) {
                push(null, eq[0]);
                i += eq[0].length;
                if (line[i] === '"' || line[i] === "'") {
                  var q = line[i];
                  var e2 = line.indexOf(q, i + 1);
                  e2 = e2 < 0 ? n : e2 + 1;
                  push('str', line.slice(i, e2));
                  i = e2;
                }
              }
              continue;
            }
            push(null, line[i]);
            i++;
          }
          if (i < n && line[i] === '>') { push('kw', '>'); i++; }
          continue;
        }
        var em = /^&[#A-Za-z0-9]+;/.exec(line.slice(i));
        if (em) { push('num', em[0]); i += em[0].length; continue; }
      }

      var next = line.indexOf('<', i);
      if (next === -1) next = n;
      push(null, line.slice(i, next));
      i = next;
    }

    return { html: out, st: { block: false } };
  }

  /* ---------------- CSS ---------------- */
  function scanCss(line, st) {
    var out = '';
    var i = 0;
    var n = line.length;

    function push(cls, txt) {
      if (!txt) return;
      out += cls ? '<span class="t-' + cls + '">' + esc(txt) + '</span>' : esc(txt);
    }

    if (st && st.block) {
      var e0 = line.indexOf('*/');
      if (e0 === -1) {
        push('com', line);
        return { html: out, st: { block: true } };
      }
      push('com', line.slice(0, e0 + 2));
      i = e0 + 2;
    }

    // 行首属性名
    var pm = /^(\s*)(--?[\w-]+)(\s*:)/.exec(line);
    if (pm) {
      push(null, pm[1]);
      push('fn', pm[2]);
      push(null, pm[3]);
      i = pm[0].length;
    }

    while (i < n) {
      if (line.startsWith('/*', i)) {
        var e1 = line.indexOf('*/', i + 2);
        if (e1 === -1) {
          push('com', line.slice(i));
          return { html: out, st: { block: true } };
        }
        push('com', line.slice(i, e1 + 2));
        i = e1 + 2;
        continue;
      }

      var c = line[i];
      if (c === '"' || c === "'") {
        var j = i + 1;
        while (j < n) {
          if (line[j] === '\\') { j += 2; continue; }
          if (line[j] === c) { j++; break; }
          j++;
        }
        if (j > n) j = n;
        push('str', line.slice(i, j));
        i = j;
        continue;
      }
      if (c === '@') {
        var am = /^@[\w-]+/.exec(line.slice(i));
        if (am) { push('kw', am[0]); i += am[0].length; continue; }
      }
      if (c === '#') {
        var hm = /^#[0-9a-fA-F]{3,8}\b/.exec(line.slice(i));
        if (hm) { push('num', hm[0]); i += hm[0].length; continue; }
      }
      if (c >= '0' && c <= '9') {
        var nm = /^\d[\d.]*(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch|pt)?/.exec(line.slice(i));
        if (nm) { push('num', nm[0]); i += nm[0].length; continue; }
      }
      var idm = /^[A-Za-z_-][\w-]*/.exec(line.slice(i));
      if (idm) {
        var k = i + idm[0].length;
        while (k < n && line[k] === ' ') k++;
        push(line[k] === ':' ? 'fn' : 'var', idm[0]);
        i += idm[0].length;
        continue;
      }
      push(null, c);
      i++;
    }

    return { html: out, st: { block: false } };
  }

  /* ---------------- Markdown ---------------- */
  function scanMd(line, st) {
    if (st && st.fence) {
      if (/^\s*(```|~~~)/.test(line)) return { html: '<span class="t-com">' + esc(line) + '</span>', st: { fence: false } };
      return { html: '<span class="t-str">' + esc(line) + '</span>', st: { fence: true } };
    }
    if (/^\s*(```|~~~)/.test(line)) {
      return { html: '<span class="t-com">' + esc(line) + '</span>', st: { fence: true } };
    }
    var hm = /^(\s*#{1,6}\s+)(.*)$/.exec(line);
    if (hm) {
      return { html: '<span class="t-kw">' + esc(hm[1]) + '</span><span class="t-fn">' + esc(hm[2]) + '</span>', st: {} };
    }
    if (/^\s*>/.test(line)) {
      return { html: '<span class="t-com">' + esc(line) + '</span>', st: {} };
    }
    var out = '';
    var last = 0;
    var re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
    var m;
    while ((m = re.exec(line))) {
      out += esc(line.slice(last, m.index));
      out += '<span class="' + (m[1] ? 't-str' : 't-num') + '">' + esc(m[0]) + '</span>';
      last = re.lastIndex;
    }
    out += esc(line.slice(last));
    return { html: out, st: {} };
  }

  function render(line, lang, st) {
    if (line.length > 8000) {
      // 单行过长（压缩后的 bundle 之类）不做高亮，避免生成几十 MB 的 HTML
      return { html: esc(line), st: {} };
    }
    if (lang === 'html') return scanHtml(line, st);
    if (lang === 'css') return scanCss(line, st);
    if (lang === 'md') return scanMd(line, st);
    var cfg = CFG[lang];
    if (!cfg) return { html: esc(line), st: {} };
    return scanCode(line, cfg, st);
  }

  global.HL = { render: render, langOf: langOf, escape: esc };
})(window);
