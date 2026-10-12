const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
// Папку можно передать аргументом: npm run pack:special-sounds -- "C:\путь\к\звукам"
const SOURCE_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "sounds", "Ящики");
const OUTPUT_FILE = path.join(ROOT, "special-sounds-packed.json");
const ALLOWED_EXT = new Set([".mp3", ".ogg", ".wav"]);

function getMimeByExt(ext) {
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".wav") return "audio/wav";
  return "application/octet-stream";
}

function buildId(name, index) {
  const base = path.parse(name).name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!base) return `special-${index + 1}`;
  return `${base}-${index + 1}`;
}

function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(`Source folder not found: ${SOURCE_DIR}`);
  }

  const files = fs
    .readdirSync(SOURCE_DIR)
    .filter((f) => {
      const full = path.join(SOURCE_DIR, f);
      const ext = path.extname(f).toLowerCase();
      return fs.statSync(full).isFile() && ALLOWED_EXT.has(ext);
    })
    .sort((a, b) => a.localeCompare(b, "ru"));

  const sounds = files.map((file, index) => {
    const fullPath = path.join(SOURCE_DIR, file);
    const ext = path.extname(file).toLowerCase();
    const buffer = fs.readFileSync(fullPath);

    return {
      id: buildId(file, index),
      name: file,
      ext,
      mime: getMimeByExt(ext),
      data: buffer.toString("base64")
    };
  });

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: path.relative(ROOT, SOURCE_DIR).startsWith("..") ? SOURCE_DIR : path.relative(ROOT, SOURCE_DIR).replace(/\\/g, "/"),
    sounds
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(`[PACK] Packed ${sounds.length} file(s) to ${OUTPUT_FILE}`);
}

main();
