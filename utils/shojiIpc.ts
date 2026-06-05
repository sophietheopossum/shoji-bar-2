import Gio from "gi://Gio"
import GLib from "gi://GLib"

// ShojiWM の TS 構成ランタイム(Node)が立てる Unix ソケットに接続するクライアント。
// 行区切り JSON:
//   送信: {"method": string, "params"?: unknown}（コマンド / fire-and-forget）
//        {"id": number, "method": ..., "params": ...}（応答が欲しいリクエスト）
//   受信: {"event": string, "payload": unknown}（broadcast）
//        {"id": number, "result"|"error": ...}（リクエストへの応答）
//
// 構成のホットリロードでソケットは作り直されるため、切断時は自動再接続する。

export type ShojiIpcMessage =
  | { event: string; payload: unknown }
  | { id: number; result?: unknown; error?: string }

export interface ShojiIpcClient {
  /** コマンド送信(応答不要) */
  send(method: string, params?: unknown): void
  /** id 付きリクエスト送信。応答は onMessage に {id, result} として届く */
  request(method: string, params?: unknown): void
  /** 切断して再接続を停止 */
  close(): void
}

export function shojiSocketPath(): string {
  const runtimeDir = GLib.getenv("XDG_RUNTIME_DIR") ?? "/tmp"
  const display = GLib.getenv("WAYLAND_DISPLAY") ?? "wayland-0"
  return `${runtimeDir}/shojiwm-${display}.sock`
}

export interface ShojiIpcOptions {
  /** 接続確立直後に毎回送るリクエスト(初期状態の取得など) */
  onConnect?: (client: ShojiIpcClient) => void
  /** 再接続までの待ち時間(ms) */
  reconnectMs?: number
}

export function connectShojiIpc(
  onMessage: (message: ShojiIpcMessage) => void,
  options: ShojiIpcOptions = {},
): ShojiIpcClient {
  const reconnectMs = options.reconnectMs ?? 1000

  let connection: Gio.SocketConnection | null = null
  let output: Gio.OutputStream | null = null
  let cancellable = new Gio.Cancellable()
  let reconnectTimer: number | null = null
  let closed = false

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      GLib.source_remove(reconnectTimer)
      reconnectTimer = null
    }
  }

  function teardownConnection() {
    if (!connection) {
      return
    }
    try {
      connection.close(null)
    } catch {
      // ignore
    }
    connection = null
    output = null
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer !== null) {
      return
    }
    reconnectTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, reconnectMs, () => {
      reconnectTimer = null
      tryConnect()
      return GLib.SOURCE_REMOVE
    })
  }

  function handleDisconnect() {
    teardownConnection()
    scheduleReconnect()
  }

  function readLoop(input: Gio.DataInputStream) {
    input.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, res) => {
      if (closed) {
        return
      }
      let line: string | null
      try {
        ;[line] = (stream as Gio.DataInputStream).read_line_finish_utf8(res)
      } catch {
        handleDisconnect()
        return
      }

      if (line === null) {
        // EOF: サーバが切断した
        handleDisconnect()
        return
      }

      const trimmed = line.trim()
      if (trimmed.length > 0) {
        try {
          onMessage(JSON.parse(trimmed) as ShojiIpcMessage)
        } catch {
          // 壊れた行は無視
        }
      }

      readLoop(input)
    })
  }

  function tryConnect() {
    if (closed) {
      return
    }

    const client = new Gio.SocketClient()
    const address = Gio.UnixSocketAddress.new(shojiSocketPath())

    client.connect_async(address, cancellable, (_src, res) => {
      if (closed) {
        return
      }
      try {
        connection = client.connect_finish(res)
      } catch {
        scheduleReconnect()
        return
      }

      output = connection.get_output_stream()
      const input = new Gio.DataInputStream({
        base_stream: connection.get_input_stream(),
      })
      readLoop(input)
      options.onConnect?.(api)
    })
  }

  function writeFrame(message: object) {
    if (!output) {
      return
    }
    try {
      output.write_all(JSON.stringify(message) + "\n", null)
    } catch {
      handleDisconnect()
    }
  }

  let nextRequestId = 1

  function send(method: string, params?: unknown) {
    writeFrame(params === undefined ? { method } : { method, params })
  }

  function request(method: string, params?: unknown) {
    const id = nextRequestId++
    writeFrame(params === undefined ? { id, method } : { id, method, params })
  }

  const api: ShojiIpcClient = {
    send,
    request,
    close() {
      closed = true
      clearReconnectTimer()
      cancellable.cancel()
      teardownConnection()
    },
  }

  tryConnect()
  return api
}
