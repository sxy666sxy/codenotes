/* ============================================================
   zip.js · 零依赖 ZIP 读取（基于浏览器原生 DecompressionStream）
   ============================================================ */
(function (global) {
  'use strict';

  var SIG_EOCD = 0x06054b50;
  var SIG_CD = 0x02014b50;
  var SIG_LOCAL = 0x04034b50;
  var MAX_FILE = 20 * 1024 * 1024;     // 单文件超过此大小不载入
  var MAX_TOTAL = 160 * 1024 * 1024;   // 解压总量上限

  var SKIP_PATHS = [
    /^__MACOSX(\/|$)/i,
    /(^|\/)\.DS_Store$/i,
    /(^|\/)Thumbs\.db$/i,
    /(^|\/)desktop\.ini$/i,
    /^\.git\/objects\//i,
    /(^|\/)node_modules\//i,
    /(^|\/)\.idea\//i,
    /(^|\/)\.vscode\//i
  ];

  function shouldSkip(name) {
    for (var i = 0; i < SKIP_PATHS.length; i++) {
      if (SKIP_PATHS[i].test(name)) return true;
    }
    return false;
  }

  function decodeName(bytes, utf8Flag) {
    if (utf8Flag) {
      try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { /* fall */ }
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      try { return new TextDecoder('gbk').decode(bytes); }
      catch (e2) {
        try { return new TextDecoder('iso-8859-1').decode(bytes); }
        catch (e3) { return ''; }
      }
    }
  }

  function isBinary(bytes) {
    var n = Math.min(bytes.length, 8000);
    for (var i = 0; i < n; i++) {
      if (bytes[i] === 0) return true;
    }
    return false;
  }

  function decodeText(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      bytes = bytes.subarray(3);
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), enc: 'UTF-16LE' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), enc: 'UTF-16BE' };
    }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), enc: 'UTF-8' };
    } catch (e) { /* 不是合法 UTF-8，尝试 GBK */ }
    try {
      return { text: new TextDecoder('gbk').decode(bytes), enc: 'GBK' };
    } catch (e) { /* 最后兜底 */ }
    return { text: new TextDecoder('utf-8').decode(bytes), enc: 'UTF-8（有损）' };
  }

  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器内核过旧：不支持 DecompressionStream，无法解压 zip');
    }
    var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  function findEocd(dv, len) {
    var start = len - 22;
    var floor = Math.max(0, len - 22 - 65535);
    for (var i = start; i >= floor; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  /**
   * 读取 zip 中的所有文件
   * @returns {Promise<{entries: Array, skipped: number, skippedSize: number}>}
   */
  async function readZip(file, onProgress) {
    var buf = new Uint8Array(await file.arrayBuffer());
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    var eocd = findEocd(dv, buf.length);
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到目录结构）');

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式，请用普通 zip 重新压缩');
    }
    if (cdOffset >= buf.length) throw new Error('ZIP 目录损坏');

    var metas = [];
    var p = cdOffset;
    for (var i = 0; i < count; i++) {
      if (p + 46 > buf.length || dv.getUint32(p, true) !== SIG_CD) break;
      var flags = dv.getUint16(p + 8, true);
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var usize = dv.getUint32(p + 24, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOffset = dv.getUint32(p + 42, true);
      var nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
      var name = decodeName(nameBytes, (flags & 0x800) !== 0);
      p += 46 + nameLen + extraLen + commentLen;

      if (!name || /\/$/.test(name) || /\\$/.test(name)) continue;
      if (shouldSkip(name)) continue;
      if (flags & 0x1) continue;                    // 加密文件
      metas.push({
        path: name.replace(/\\/g, '/'),
        method: method,
        csize: csize,
        usize: usize,
        offset: localOffset
      });
    }

    var entries = [];
    var skipped = 0;
    var total = 0;

    for (var k = 0; k < metas.length; k++) {
      var m = metas[k];
      try {
        if (m.usize > MAX_FILE || m.csize === 0xffffffff) { skipped++; continue; }
        if (total + m.usize > MAX_TOTAL) { skipped++; continue; }

        var lh = m.offset;
        if (lh + 30 > buf.length || dv.getUint32(lh, true) !== SIG_LOCAL) { skipped++; continue; }
        var nl = dv.getUint16(lh + 26, true);
        var el = dv.getUint16(lh + 28, true);
        var start = lh + 30 + nl + el;
        var end = start + m.csize;
        if (start > buf.length || end > buf.length) { skipped++; continue; }
        var raw = buf.subarray(start, end);

        var data;
        if (m.method === 0) {
          data = raw;
        } else if (m.method === 8) {
          data = await inflateRaw(raw);
        } else {
          skipped++; continue;                        // 不支持的压缩算法
        }

        total += data.length;
        entries.push({ path: m.path, size: data.length, data: data });
      } catch (err) {
        skipped++;
      }
      if (onProgress && (k % 5 === 0 || k === metas.length - 1)) {
        onProgress(k + 1, metas.length);
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }

    if (!entries.length) throw new Error('压缩包里没有可读取的文件');
    return { entries: entries, skipped: skipped, skippedSize: 0 };
  }

  /**
   * 读取用户选择的对象：zip 解压，普通文本直接作为单文件项目
   */
  async function readAny(file, onProgress) {
    var head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    var isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4B &&
                (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);

    if (isZip) {
      var res = await readZip(file, onProgress);
      return {
        isZip: true,
        name: file.name.replace(/\.zip$/i, ''),
        entries: res.entries,
        skipped: res.skipped
      };
    }

    if (/\.(tar|gz|tgz|rar|7z|bz2|xz)$/i.test(file.name)) {
      throw new Error('暂不支持该压缩格式，请先压缩成 .zip');
    }

    var bytes = new Uint8Array(await file.arrayBuffer());
    if (isBinary(bytes)) throw new Error('这不是 zip 包，也不是文本文件');
    return {
      isZip: false,
      name: file.name,
      entries: [{ path: file.name, size: bytes.length, data: bytes }],
      skipped: 0
    };
  }

  global.ZipReader = {
    readAny: readAny,
    readZip: readZip,
    decodeText: decodeText,
    isBinary: isBinary
  };
})(window);
