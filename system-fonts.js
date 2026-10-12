// Список установленных в Windows шрифтов для панели.
// Браузер не умеет перечислять шрифты, поэтому читаем названия семейств прямо из файлов
// (таблица "name" в TTF/OTF/TTC) — это те же имена, по которым их находит CSS font-family.
const fs = require("fs");
const path = require("path");

const FONT_DIRS = [
  path.join(process.env.WINDIR || "C:\\Windows", "Fonts"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"), // установленные «для себя»
].filter(Boolean);

const FONT_EXT = new Set([".ttf", ".otf", ".ttc"]);
const MAX_NAME_TABLE = 512 * 1024;

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const read = fs.readSync(fd, buf, 0, length, position);
  return read === length ? buf : buf.subarray(0, read);
}

function decodeName(buf, platformID, encodingID) {
  if (platformID === 0 || platformID === 3) {
    const copy = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
    return copy.swap16().toString("utf16le"); // UTF-16BE
  }
  if (platformID === 1 && encodingID === 0) return buf.toString("latin1");
  return null;
}

// Семейство одного шрифта (по смещению внутри файла: у .ttc их несколько).
// Берём «типографское» семейство (nameID 16, например "Segoe UI" для Segoe UI Light), иначе обычное (nameID 1).
function readFamily(fd, fontOffset) {
  const header = readAt(fd, fontOffset, 12);
  if (header.length < 12) return null;
  const numTables = header.readUInt16BE(4);
  if (!numTables || numTables > 200) return null;

  const dir = readAt(fd, fontOffset + 12, numTables * 16);
  let nameOffset = -1;
  let nameLength = 0;
  for (let i = 0; i + 16 <= dir.length; i += 16) {
    if (dir.toString("latin1", i, i + 4) === "name") {
      nameOffset = dir.readUInt32BE(i + 8);
      nameLength = Math.min(dir.readUInt32BE(i + 12), MAX_NAME_TABLE);
      break;
    }
  }
  if (nameOffset < 0) return null;

  const table = readAt(fd, nameOffset, nameLength);
  if (table.length < 6) return null;
  const count = table.readUInt16BE(2);
  const stringBase = table.readUInt16BE(4);

  const best = {}; // nameID -> { score, value }
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > table.length) break;
    const platformID = table.readUInt16BE(rec);
    const encodingID = table.readUInt16BE(rec + 2);
    const languageID = table.readUInt16BE(rec + 4);
    const nameID = table.readUInt16BE(rec + 6);
    if (nameID !== 1 && nameID !== 16) continue;

    const start = stringBase + table.readUInt16BE(rec + 10);
    const end = start + table.readUInt16BE(rec + 8);
    if (end > table.length) continue;
    const value = decodeName(table.subarray(start, end), platformID, encodingID);
    if (!value || !value.trim()) continue;

    // английское Windows-имя надёжнее всего совпадает с тем, что понимает CSS
    const score = platformID === 3 ? (languageID === 0x409 ? 3 : 2) : platformID === 0 ? 1 : 0;
    if (!best[nameID] || score > best[nameID].score) best[nameID] = { score, value: value.trim() };
  }
  return (best[16] || best[1] || {}).value || null;
}

function familiesInFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = readAt(fd, 0, 12);
    if (head.length < 12) return [];
    if (head.toString("latin1", 0, 4) === "ttcf") {
      const numFonts = Math.min(head.readUInt32BE(8), 64);
      const offsets = readAt(fd, 12, numFonts * 4);
      const out = [];
      for (let i = 0; i + 4 <= offsets.length; i += 4) {
        const family = readFamily(fd, offsets.readUInt32BE(i));
        if (family) out.push(family);
      }
      return out;
    }
    const family = readFamily(fd, 0);
    return family ? [family] : [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

let cache = null;

// Имена, которые панель может сохранить без искажений (sanitizeConfig оставляет только эти символы)
const SAFE_NAME = /^[\p{L}\p{N} _-]+$/u;

function listSystemFonts() {
  if (cache) return cache;
  const families = new Set();
  for (const dir of FONT_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const name of files) {
      if (!FONT_EXT.has(path.extname(name).toLowerCase())) continue;
      for (const family of familiesInFile(path.join(dir, name))) {
        if (!family.startsWith("@") && SAFE_NAME.test(family)) families.add(family);
      }
    }
  }
  cache = [...families].sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base" }));
  return cache;
}

module.exports = { listSystemFonts };
