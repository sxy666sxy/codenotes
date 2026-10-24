/* ============================================================
   zip.js · 零依赖 ZIP 读取（基于浏览器原生 DecompressionStream）

   设计目标：不设大小上限。
   - 导入时只读「目录区」，几百 MB 的包也是瞬间完成
   - 每个文件在真正打开时才读那一段字节并解压
   - 因此不会因为「包太大 / 文件太大」而跳过任何文件
   ============================================================ */
(function (global) {
  'use strict';

  var SIG_EOCD = 0x06054b50;
  var SIG_CD = 0x02014b50;
  var SIG_LOCAL = 0x04034b50;

  var MAX_FILES = 50000;               // 条目数量上限（防目录异常）
  var MAX_ENTRY = 1024 * 1024 * 1024;  // 单入口 1GB，纯粹防御性上限

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

  /** 把文件的某一段包装成流（按 1MB 分块，避免整块进内存） */
  function sliceStream(file, start, end) {
    var pos = start;
    return new ReadableStream({
      pull: function (controller) {
        if (pos >= end) { controller.close(); return; }
        var stop = Math.min(pos + 1024 * 1024, end);
        return file.slice(pos, stop).arrayBuffer().then(function (buf) {
          pos = stop;
          controller.enqueue(new Uint8Array(buf));
        });
      }
    });
  }

  /**
   * 只解出条目的前 maxBytes 字节（用于探测是否二进制、超大文本预览）
   * 流式解压 + 提前取消，不用把整个文件读进内存
   */
  async function readEntryHead(file, m, maxBytes) {
    var head = new Uint8Array(await file.slice(m.offset, m.offset + 30).arrayBuffer());
    var hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL) {
      throw new Error('ZIP 结构损坏：' + (m.path || ''));
    }
    var nl = hv.getUint16(26, true);
    var el = hv.getUint16(28, true);
    var start = m.offset + 30 + nl + el;
    var end = start + m.csize;
    if (end > file.size) throw new Error('ZIP 数据越界：' + (m.path || ''));

    if (m.method === 0) {
      var n = Math.min(maxBytes, end - start);
      return new Uint8Array(await file.slice(start, start + n).arrayBuffer());
    }
    if (m.method !== 8) throw new Error('不支持的压缩算法（method ' + m.method + '）');

    var stream = sliceStream(file, start, end).pipeThrough(new DecompressionStream('deflate-raw'));
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    try {
      while (total < maxBytes) {
        var r = await reader.read();
        if (r.done) break;
        var chunk = r.value;
        var remain = maxBytes - total;
        if (chunk.length > remain) chunk = chunk.subarray(0, remain);
        chunks.push(chunk);
        total += chunk.length;
      }
    } finally {
      try { reader.cancel(); } catch (e) { /* 忽略 */ }
    }
    var out = new Uint8Array(total);
    var off = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return out;
  }

  /** 读取单个条目（只读这一个文件对应的字节） */
  async function readEntry(file, m) {
    var head = new Uint8Array(await file.slice(m.offset, m.offset + 30).arrayBuffer());
    var hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL) {
      throw new Error('ZIP 结构损坏：' + (m.path || ''));
    }
    var nl = hv.getUint16(26, true);
    var el = hv.getUint16(28, true);
    var start = m.offset + 30 + nl + el;
    var end = start + m.csize;
    if (end > file.size) throw new Error('ZIP 数据越界：' + (m.path || ''));
    var raw = new Uint8Array(await file.slice(start, end).arrayBuffer());
    if (m.method === 0) return raw;
    if (m.method === 8) return await inflateRaw(raw);
    throw new Error('不支持的压缩算法（method ' + m.method + '）');
  }

  /** 只解析中央目录；不读取、不解压任何文件内容 */
  async function readZip(file, onProgress) {
    var size = file.size;
    if (size < 22) throw new Error('不是有效的 ZIP 文件');

    var tailLen = Math.min(size, 66000);
    var tail = new Uint8Array(await file.slice(size - tailLen).arrayBuffer());
    var dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    var eocd = -1;
    for (var i = tail.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到目录结构）');

    var count = dv.getUint16(eocd + 10, true);
    var cdSize = dv.getUint32(eocd + 12, true);
    var cdOffset = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式，请用普通 zip 重新压缩');
    }
    if (cdOffset + cdSize > size) throw new Error('ZIP 目录损坏');

    var cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    var cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);

    var entries = [];
    var skipped = 0;
    var p = 0;
    for (var k = 0; k < count; k++) {
      if (p + 46 > cd.length || cv.getUint32(p, true) !== SIG_CD) break;
      var flags = cv.getUint16(p + 8, true);
      var method = cv.getUint16(p + 10, true);
      var csize = cv.getUint32(p + 20, true);
      var usize = cv.getUint32(p + 24, true);
      var nameLen = cv.getUint16(p + 28, true);
      var extraLen = cv.getUint16(p + 30, true);
      var commentLen = cv.getUint16(p + 32, true);
      var localOffset = cv.getUint32(p + 42, true);
      var nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
      var name = decodeName(nameBytes, (flags & 0x800) !== 0);
      p += 46 + nameLen + extraLen + commentLen;

      if (!name || /\/$/.test(name) || /\\$/.test(name)) continue;
      if (shouldSkip(name)) continue;
      if (flags & 0x1) { skipped++; continue; }               // 加密文件无法解压
      if (usize > MAX_ENTRY || csize === 0xffffffff) { skipped++; continue; }
      if (entries.length >= MAX_FILES) break;

      entries.push({
        path: name.replace(/\\/g, '/'),
        size: usize,
        _zip: {
          file: file,
          offset: localOffset,
          method: method,
          csize: csize,
          path: name
        }
      });

      if (onProgress && k % 200 === 0) {
        onProgress({ phase: 'scan', done: k + 1, total: count });
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    }

    if (!entries.length) throw new Error('压缩包里没有可读取的文件');
    if (onProgress) onProgress({ phase: 'scan', done: count, total: count });
    return { entries: entries, skipped: skipped, skippedSize: 0 };
  }

  /**
   * 读取用户选择的对象：zip 只解析目录；单个文件也走懒加载
   */
  async function readAny(file, onProgress) {
    var head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    var isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4B &&
                (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);

    if (isZip) {
      return await readZip(file, onProgress);
    }

    if (/\.(tar|gz|tgz|rar|7z|bz2|xz)$/i.test(file.name)) {
      throw new Error('暂不支持该压缩格式，请先压缩成 .zip');
    }

    return {
      isZip: false,
      name: file.name,
      entries: [{ path: file.name, size: file.size, _file: file }],
      skipped: 0
    };
  }

  global.ZipReader = {
    readAny: readAny,
    readZip: readZip,
    readEntry: readEntry,
    readEntryHead: readEntryHead,
    decodeText: decodeText,
    isBinary: isBinary
  };
})(window);
