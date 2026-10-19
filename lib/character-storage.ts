import type { Character, CanvasBgItem } from "./character-types";
import { normalizeTimeZone } from "./character-time";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

/** 历史兼容：早期版本用这个错误码整卡拒绝导入，现在已改为并入人设，外部可按需识别 */
export const CHAR_BLOCKED_FIELDS = "CHAR_BLOCKED_FIELDS";

const STORAGE_KEY = "ai_phone_characters_v1";
const BG_ITEMS_STORAGE_KEY = "ai_phone_bg_items_v1";
export const CHARACTERS_UPDATED_EVENT = "characters-updated";

/**
 * 酒馆角色卡（chara_card_v2 / v3）里本产品没有独立字段的项。
 *
 * 这套产品是「人设 + 主动消息」模型，Character 里没有开场白 / 场景 / 示例对话的位置，
 * 但它们是唯一能塑造角色言行的正文素材，直接丢弃太浪费：
 * 导入时统一并入 persona（persona 是唯一会被注入提示词的角色正文）。
 * 卡内世界书（character_book）不在此列，需用户到「设置 → 世界书」单独导入。
 */
const SOFT_IMPORT_FIELD_LABELS: ReadonlyArray<{ keys: readonly string[]; label: string }> = [
  { keys: ["scenario"], label: "场景设定" },
  { keys: ["mes_example"], label: "示例对话" },
  { keys: ["first_mes", "greeting"], label: "开场白" },
  { keys: ["alternate_greetings"], label: "备选开场白" },
];

/** 导入时回传给 UI 的补充信息 */
export type CharacterImportInfo = {
  /** 被并入 persona 的字段中文名，如 ["场景设定", "示例对话"] */
  mergedFields: string[];
  /** 卡内是否带世界书（需到「设置 → 世界书」单独导入） */
  hasCharacterBook: boolean;
};
registerKvMigration(STORAGE_KEY);
registerKvMigration(BG_ITEMS_STORAGE_KEY);

// ── Read Cache (invalidated on writes) ──────────
let _charsCache: Character[] | null = null;

// ── localStorage CRUD ────────────────────────────────

export function generateWechatID(): string {
  const prefixes = ["138", "139", "150", "151", "158", "159", "170", "176", "186", "188", "199"];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = Math.floor(Math.random() * 100000000).toString().padStart(8, '0');
  return prefix + suffix;
}

export function loadCharacters(): Character[] {
  if (_charsCache) return _charsCache;
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    let needsSave = false;
    const chars = parsed.filter(isValidCharacter).map((raw: Character) => {
      const char = { ...raw } as Character & { greeting?: unknown; alternate_greetings?: unknown };
      if ("greeting" in char) {
        delete char.greeting;
        needsSave = true;
      }
      if ("alternate_greetings" in char) {
        delete char.alternate_greetings;
        needsSave = true;
      }
      if (!char.wechatID) {
        char.wechatID = generateWechatID();
        needsSave = true;
      }
      const normalizedTimeZone = normalizeTimeZone(char.timeZone);
      if (char.timeZone !== normalizedTimeZone) {
        if (normalizedTimeZone) char.timeZone = normalizedTimeZone;
        else delete char.timeZone;
        needsSave = true;
      }
      // Sanitize avatars: only keep data-URLs and http(s) URLs
      if (char.avatar && !char.avatar.startsWith("data:") && !char.avatar.startsWith("http://") && !char.avatar.startsWith("https://")) {
        char.avatar = null;
        needsSave = true;
      }
      return char as Character;
    });

    if (needsSave) {
      setTimeout(() => saveCharacters(chars), 0);
    }
    _charsCache = chars;
    return chars;
  } catch {
    return [];
  }
}

export function saveCharacters(chars: Character[]): void {
  if (typeof window === "undefined") return;
  kvSet(STORAGE_KEY, JSON.stringify(chars));
  _charsCache = null;
  window.dispatchEvent(new CustomEvent(CHARACTERS_UPDATED_EVENT));
}

export function loadBackgroundItems(): CanvasBgItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(BG_ITEMS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidBgItem);
  } catch {
    return [];
  }
}

export function saveBackgroundItems(items: CanvasBgItem[]): void {
  if (typeof window === "undefined") return;
  kvSet(BG_ITEMS_STORAGE_KEY, JSON.stringify(items));
}

function isValidBgItem(x: unknown): x is CanvasBgItem {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as CanvasBgItem).id === "string" &&
    typeof (x as CanvasBgItem).type === "string" &&
    typeof (x as CanvasBgItem).x === "number" &&
    typeof (x as CanvasBgItem).y === "number"
  );
}

function isValidCharacter(x: unknown): x is Character {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Character).id === "string" &&
    typeof (x as Character).name === "string"
  );
}

export function createCharacter(
  data: Omit<Character, "id" | "createdAt" | "updatedAt" | "wechatID"> & { wechatID?: string }
): Character {
  const now = new Date().toISOString();
  return {
    ...data,
    id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    wechatID: data.wechatID || generateWechatID(),
    tags: data.tags || [],
    createdAt: now,
    updatedAt: now,
  };
}

// ── JSON import/export ───────────────────────────────

export function exportCharacterAsJson(char: Character): void {
  const payload = {
    schema: "ai_phone_character",
    schema_version: "1.0",
    name: char.name,
    description: char.persona,
    personality: char.personality || "",
    avatar: char.avatar ?? "none",
    tags: char.tags || [],
    wechatID: char.wechatID || "",
    timeZone: char.timeZone || "",
    polaroidStyle: char.polaroidStyle ?? 0,
    polaroidSize: char.polaroidSize || "random",
    polaroidImageX: char.polaroidImageX ?? 50,
    polaroidImageY: char.polaroidImageY ?? 50,
    polaroidImageZoom: char.polaroidImageZoom ?? 1,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  triggerDownload(blob, `${sanitizeFilename(char.name)}.json`);
}

export type CharacterImportData = Omit<
  Character,
  "id" | "createdAt" | "updatedAt"
>;

/** 把卡里的字符串 / 字符串数组统一取成一段文本 */
function extractCardText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .join("\n\n---\n\n");
  }
  return "";
}

/** 把开场白 / 场景 / 示例对话并入人设，返回新的人设与已并入的字段名 */
function mergeCardExtras(
  persona: string,
  src: Record<string, unknown>,
  obj: Record<string, unknown>
): { persona: string; merged: string[] } {
  const parts: string[] = [];
  const merged: string[] = [];
  for (const { keys, label } of SOFT_IMPORT_FIELD_LABELS) {
    const pieces: string[] = [];
    for (const key of keys) {
      const text = extractCardText(src[key] ?? obj[key]);
      if (text) pieces.push(text);
    }
    if (pieces.length === 0) continue;
    parts.push(`【${label}】\n${pieces.join("\n\n")}`);
    if (!merged.includes(label)) merged.push(label);
  }
  if (parts.length === 0) return { persona, merged };
  const head = persona.trim();
  return { persona: head ? `${head}\n\n${parts.join("\n\n")}` : parts.join("\n\n"), merged };
}

export function parseCharacterFromJson(
  text: string,
  onInfo?: (info: CharacterImportInfo) => void
): CharacterImportData | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;

    // Helper: validate avatar — only accept data-URLs and http(s) URLs
    function validAvatar(v: unknown): string | null {
      if (typeof v !== "string" || !v.trim()) return null;
      const s = v.trim();
      if (s === "none") return null;
      if (s.startsWith("data:") || s.startsWith("http://") || s.startsWith("https://")) return s;
      return null;
    }

    // 本 App 自家格式：{ schema: "ai_phone_character", data }；
    // 酒馆 chara_card_v2 / v3：{ spec: "chara_card_v2", data }；
    // 老格式：字段直接摊在顶层。三种都要认，否则 v2 卡的 name/description 读不到。
    const dataLayer = obj.data && typeof obj.data === "object" && obj.data !== null
      ? obj.data as Record<string, unknown>
      : null;
    const looksWrapped =
      obj.schema === "ai_phone_character" ||
      (typeof obj.spec === "string" && /^chara_card/i.test(obj.spec)) ||
      Boolean(dataLayer && !obj.name && !obj.description);
    const src = (looksWrapped && dataLayer) ? dataLayer : obj;

    const polaroidStyle = typeof src.polaroidStyle === "number" && Number.isFinite(src.polaroidStyle)
      ? Math.max(0, Math.min(4, Math.round(src.polaroidStyle)))
      : undefined;
    const polaroidSize = src.polaroidSize === "small" || src.polaroidSize === "medium" || src.polaroidSize === "large"
      ? src.polaroidSize
      : "random" as const;
    const polaroidImageX = typeof src.polaroidImageX === "number" && Number.isFinite(src.polaroidImageX)
      ? Math.max(0, Math.min(100, src.polaroidImageX))
      : undefined;
    const polaroidImageY = typeof src.polaroidImageY === "number" && Number.isFinite(src.polaroidImageY)
      ? Math.max(0, Math.min(100, src.polaroidImageY))
      : undefined;
    const polaroidImageZoom = typeof src.polaroidImageZoom === "number" && Number.isFinite(src.polaroidImageZoom)
      ? Math.max(1, Math.min(3, src.polaroidImageZoom))
      : undefined;

    const { persona, merged } = mergeCardExtras(String(src.description ?? src.persona ?? ""), src, obj);
    const hasCharacterBook = Boolean(src.character_book ?? obj.character_book);
    onInfo?.({ mergedFields: merged, hasCharacterBook });

    return {
      name: String(src.name ?? ""),
      persona,
      avatar: validAvatar(src.avatar),
      personality: typeof src.personality === "string" && src.personality.trim() ? src.personality : undefined,
      tags: Array.isArray(src.tags) ? src.tags.map(String) : [],
      wechatID: typeof src.wechatID === "string" && src.wechatID.trim() ? src.wechatID : undefined,
      timeZone: normalizeTimeZone(src.timeZone ?? src.timezone ?? src.time_zone),
      polaroidStyle,
      polaroidSize,
      polaroidImageX,
      polaroidImageY,
      polaroidImageZoom,
    };
  } catch {
    return null;
  }
}

// ── PNG import/export ────────────────────────────────

/** base64 → UTF-8 文本（酒馆的 chara / ccv3 块就是 base64 的 JSON） */
function decodeBase64Utf8(b64: string): string | null {
  try {
    const bin = atob(b64.trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** zlib(deflate) 解压，用于 PNG 的 zTXt 文本块；环境不支持时返回 null */
async function inflateZlib(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const stream = new Blob([data as unknown as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function readPngTextChunk(u8: Uint8Array, keyword: string): Promise<string | null> {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== sig[i]) return null;
  }

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let offset = 8;

  while (offset + 12 <= u8.length) {
    const length = dv.getUint32(offset);
    const type = String.fromCharCode(
      u8[offset + 4],
      u8[offset + 5],
      u8[offset + 6],
      u8[offset + 7]
    );

    if (type === "tEXt") {
      const data = u8.subarray(offset + 8, offset + 8 + length);
      let sep = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) {
          sep = i;
          break;
        }
      }
      if (sep >= 0) {
        const kw = new TextDecoder().decode(data.subarray(0, sep));
        if (kw === keyword) {
          // tEXt 文本是 latin1 编码
          return new TextDecoder("latin1").decode(data.subarray(sep + 1));
        }
      }
    } else if (type === "iTXt") {
      const data = u8.subarray(offset + 8, offset + 8 + length);
      let pos = 0;
      while (pos < data.length && data[pos] !== 0) pos++;
      const kw = new TextDecoder().decode(data.subarray(0, pos));
      if (kw === keyword) {
        pos++; // skip null
        const compressionFlag = data[pos++];
        pos++; // compression method
        while (pos < data.length && data[pos] !== 0) pos++;
        pos++; // lang tag null
        while (pos < data.length && data[pos] !== 0) pos++;
        pos++; // translated keyword null
        if (compressionFlag === 0) {
          return new TextDecoder().decode(data.subarray(pos));
        }
        const inflated = await inflateZlib(data.subarray(pos));
        if (inflated) return new TextDecoder().decode(inflated);
      }
    } else if (type === "zTXt") {
      // zTXt: keyword\0 <压缩方法 1 字节> <zlib 压缩文本>
      const data = u8.subarray(offset + 8, offset + 8 + length);
      let sep = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) { sep = i; break; }
      }
      if (sep >= 0) {
        const kw = new TextDecoder().decode(data.subarray(0, sep));
        if (kw === keyword) {
          const inflated = await inflateZlib(data.subarray(sep + 2));
          if (inflated) return new TextDecoder().decode(inflated);
        }
      }
    }

    offset += 12 + length;
  }

  return null;
}

/**
 * 从 PNG 卡图里读角色数据。支持两类：
 * ① 本 App 自己导出的卡：私有块 ai_phone_character（URL 编码的 JSON）；
 * ② 酒馆（SillyTavern）卡图：v3 的 ccv3 块、v2 的 chara 块（base64 的 JSON），
 *    压缩存储的 zTXt 块也能解。
 */
export async function parseCharacterFromPng(
  buffer: ArrayBuffer,
  onInfo?: (info: CharacterImportInfo) => void
): Promise<CharacterImportData | null> {
  const u8 = new Uint8Array(buffer);

  // ① 本 App 自家格式
  const own = await readPngTextChunk(u8, "ai_phone_character");
  if (own) {
    try {
      return parseCharacterFromJson(decodeURIComponent(escape(atob(own))), onInfo);
    } catch {
      return null;
    }
  }

  // ② 酒馆卡图：v3 优先，其次 v2
  for (const keyword of ["ccv3", "chara"]) {
    const raw = await readPngTextChunk(u8, keyword);
    if (!raw) continue;
    const json = decodeBase64Utf8(raw);
    if (!json) continue;
    try {
      const data = parseCharacterFromJson(json, onInfo);
      if (data) return data;
    } catch {
      // 换下一个关键词继续尝试
    }
  }

  return null;
}

// ── CRC32 ────────────────────────────────────────────

let _crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    _crcTable[n] = c;
  }
  return _crcTable;
}

function crc32(buf: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildPngTextChunk(keyword: string, text: string): Uint8Array {
  const kwBytes = new TextEncoder().encode(keyword);
  // base64 是纯 ASCII，用 latin1 存储
  const textBytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) textBytes[i] = text.charCodeAt(i);
  const dataLen = kwBytes.length + 1 + textBytes.length;
  const typeBytes = new TextEncoder().encode("tEXt");

  const crcInput = new Uint8Array(4 + dataLen);
  crcInput.set(typeBytes, 0);
  crcInput.set(kwBytes, 4);
  crcInput[4 + kwBytes.length] = 0;
  crcInput.set(textBytes, 4 + kwBytes.length + 1);
  const crcVal = crc32(crcInput);

  const chunk = new Uint8Array(4 + 4 + dataLen + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, dataLen);
  chunk.set(typeBytes, 4);
  chunk.set(kwBytes, 8);
  chunk[8 + kwBytes.length] = 0;
  chunk.set(textBytes, 8 + kwBytes.length + 1);
  dv.setUint32(4 + 4 + dataLen, crcVal);
  return chunk;
}

function injectPngTextChunk(pngBytes: Uint8Array, chunk: Uint8Array): Uint8Array {
  // 在 IHDR 之后插入（偏移量 = 8签名 + 4长度 + 4类型 + 13数据 + 4CRC = 33）
  const insertAt = 33;
  const result = new Uint8Array(pngBytes.length + chunk.length);
  result.set(pngBytes.subarray(0, insertAt), 0);
  result.set(chunk, insertAt);
  result.set(pngBytes.subarray(insertAt), insertAt + chunk.length);
  return result;
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob failed"));
        return;
      }
      blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject);
    }, "image/png");
  });
}

function drawInitialsAvatar(ctx: CanvasRenderingContext2D, name: string): void {
  ctx.fillStyle = "#7a6080";
  ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath();
  ctx.arc(200, 200, 185, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 160px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText((name ?? "").charAt(0) || "?", 200, 210);
}

async function avatarToPngBytes(avatar: string | null, name: string): Promise<Uint8Array> {
  if (avatar) {
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            reject(new Error("No ctx"));
            return;
          }
          ctx.drawImage(img, 0, 0);
          canvasToPngBytes(canvas).then(resolve).catch(reject);
        };
        img.onerror = reject;
        img.src = avatar;
      });
    } catch {
      // Fallback below
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 400;
  const ctx = canvas.getContext("2d")!;
  drawInitialsAvatar(ctx, name);
  return canvasToPngBytes(canvas);
}

export async function exportCharacterAsPng(char: Character): Promise<void> {
  const payload = {
    schema: "ai_phone_character",
    schema_version: "1.0",
    name: char.name,
    description: char.persona,
    personality: char.personality || "",
    avatar: "none",
    tags: char.tags || [],
    wechatID: char.wechatID || "",
    timeZone: char.timeZone || "",
  };
  const jsonStr = JSON.stringify(payload);
  const base64 = btoa(unescape(encodeURIComponent(jsonStr)));

  const pngBytes = await avatarToPngBytes(char.avatar, char.name);
  const textChunk = buildPngTextChunk("ai_phone_character", base64);
  const finalBytes = injectPngTextChunk(pngBytes, textChunk);

  const blob = new Blob([finalBytes.buffer as ArrayBuffer], { type: "image/png" });
  triggerDownload(blob, `${sanitizeFilename(char.name)}.png`);
}

// ── 工具函数 ─────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return (name || "角色").replace(/[/\\:*?"<>|]/g, "_").slice(0, 60);
}

async function triggerDownload(blob: Blob, filename: string): Promise<void> {
  const { downloadFile } = await import("./download-utils");
  await downloadFile(blob, filename);
}
