import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Gio from "gi://Gio"

// cliphist によるクリップボード履歴の取得・復元・サムネイル生成。
// Astal にクリップボード機能は無いため CLI(cliphist + wl-copy + magick)を使う。
//   一覧:   cliphist list        → "<id>\t<preview>"
//   復元:   cliphist decode <id> | wl-copy
//   画像:   preview が "[[ binary data <size> <type> <WxH> ]]"

export type ClipEntry = {
  id: string
  preview: string
  isImage: boolean
  imageType?: string
  dims?: string
}

const THUMB_DIR = `${GLib.get_tmp_dir()}/shoji-bar-2-clip`
// 例: [[ binary data 378 KiB png 1087x1393 ]]
const IMAGE_PREVIEW =
  /^\[\[\s*binary data\s+.*?\b(png|jpe?g|gif|bmp|webp|tiff?|svg)\b\s+(\d+x\d+)/i

export async function listClipboard(): Promise<ClipEntry[]> {
  let out: string
  try {
    out = await execAsync(["cliphist", "list"])
  } catch (err) {
    console.error("[clipboard] cliphist list failed:", err)
    return []
  }

  const entries: ClipEntry[] = []
  for (const line of out.split("\n")) {
    if (line.length === 0) {
      continue
    }
    const tab = line.indexOf("\t")
    if (tab < 0) {
      continue
    }
    const id = line.slice(0, tab).trim()
    const preview = line.slice(tab + 1)
    if (!/^\d+$/.test(id)) {
      continue
    }
    const match = preview.match(IMAGE_PREVIEW)
    entries.push({
      id,
      preview,
      isImage: match !== null,
      imageType: match?.[1]?.toLowerCase(),
      dims: match?.[2],
    })
  }
  return entries
}

// 選択エントリをデコードしてクリップボードへ戻す。id は数字のみ検証済み。
export function copyEntry(id: string): Promise<string> {
  return execAsync(["bash", "-c", `cliphist decode ${id} | wl-copy`])
}

// 画像エントリを高さ固定の小さな PNG サムネイルにして、そのパスを返す。
// 既に生成済みならデコードし直さない。
export async function ensureThumbnail(entry: ClipEntry): Promise<string | null> {
  if (!entry.isImage) {
    return null
  }
  const path = `${THUMB_DIR}/${entry.id}.png`
  if (Gio.File.new_for_path(path).query_exists(null)) {
    return path
  }
  try {
    await execAsync([
      "bash",
      "-c",
      `mkdir -p '${THUMB_DIR}' && cliphist decode ${entry.id} | magick - -thumbnail 480x300 '${path}'`,
    ])
  } catch (err) {
    console.error("[clipboard] thumbnail failed:", err)
    return null
  }
  return path
}
