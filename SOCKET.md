# flash.net.Socket over WebSocket

The local `feat/websocket-socket` branches implement the Flash Socket API using
native AVM2 ByteArrays and a binary WebSocket-to-TCP proxy. No SWF patch or
ExternalInterface shim is required for callers of `flash.net.Socket`.

Writes accumulate in an output ByteArray. `flush()` sends those bytes as a binary
WebSocket message and resets the output buffer. Received messages append to one
input byte stream; a frame is not an application message boundary. Reads use the
ByteArray codecs, including AMF0/AMF3. Failed reads restore the input position so
a fragmented UTF or AMF value can be retried after more data arrives.

## Configure the embedder

Set `socketProxy` in the player configuration. It can be a resolver returning a
`ws://` or `wss://` URL (or null to deny the destination):

```js
socketProxy: (host, port) => {
    const url = new URL('/ws/connect', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = new URLSearchParams({ host, port });
    return url.href;
}
```

Alternatively, use explicit mappings compatible with Ruffle's configuration:

```js
socketProxy: [
    { host: 'server.example', port: 5588, proxyUrl: 'wss://proxy.example/socket' }
]
```

Without a matching route, the socket dispatches `securityError`. The embedder and
proxy determine permitted destinations; this does not fetch Flash socket policy
files. The proxy must finish connecting to TCP before accepting the WebSocket,
forward binary data in both directions, and preserve write order.

The sibling Hono proxy implements that protocol at `/ws/connect`. Its
`loader-awayfl.html` now configures the resolver automatically. Restart the proxy
and rebuild with `just aqw`, then reload the AwayFL page.

## Supported behavior and limits

- `connect`, `socketData`, `ioError`, `securityError`, and remote `close` events;
  explicit `close()` does not emit `close`.
- Connection timeout (20 seconds by default), reconnect, and suppression of
  callbacks from replaced connections.
- Big/little endian primitives, byte copying with offsets, UTF strings, and
  ByteArray AMF object serialization.
- `readMultiByte` supports browser TextDecoder encodings and explicit ASCII /
  ISO-8859-1 decoding. `writeMultiByte` currently supports UTF-8, ASCII and
  ISO-8859-1; other write encodings throw instead of silently dropping data.
- `bytesPending` includes the output ByteArray and browser WebSocket queue. It
  cannot report the TCP proxy's queue or guarantee remote delivery.
- AIR additions such as `outputProgress`, endpoint address properties and
  `tcpNoDelay`, as well as `SecureSocket` and `XMLSocket`, are not implemented here.
  The Hono bridge itself enables TCP_NODELAY.

## Validation

From `awayfl-player`:

```sh
node scripts/check-socket.cjs
```

From `hono-proxy`:

```sh
deno test --allow-net src/socket-bridge_test.ts
```

The checks cover deferred flush, fragmented input/UTF, EOF retry, endian, offsets,
input compaction, events, invalid states, timeout, reconnect, routing, partial TCP
writes, frame ordering and connection cleanup.

A Chrome test also exercised the real AVM2 `$Bg` method bindings through Hono and
a local TCP echo server: integer, UTF-8, AMF0 and AMF3 values round-tripped across
fragmented reads, with no data sent before `flush()` and the expected AS EOF error
on an empty read. Game login and gameplay have
not been verified.

Reference: [AIR SDK Socket API](https://airsdk.dev/reference/actionscript/3.0/flash/net/Socket.html).

Production bundling and the focused checks pass. A full playerglobal TypeScript
check still reports existing graphics/file-picker and installed AVM2 declaration
mismatches; the Socket changes introduce no diagnostics in that check.

## AQW map-entry frame errors

The `fix/frame-script-errors` playerglobal branch isolates exceptions at the
MovieClip frame-callback boundary. Previously, a callback throwing during
`gotoAndPlay` also aborted its caller and any remaining callbacks in the copied
frame queue, and left `current_script_scope` pointing to the failing clip.
The adapter now reports the error, restores the previous scope, and processes
pending navigation. This follows Ruffle's `run_local_frame_scripts` error boundary;
it does not yet implement Flash's `uncaughtError` event dispatch.

The reported Battleon failure begins in `MainTimeline.frame8`, reading
`world.myAvatar.objData` before the avatar exists. That exception escaped through
`World.moveToCell` / `World.enterMap`; a later socket update then failed in
`userTreeWrite` with `world.myAvatar` still null. The change addresses the frame
error propagation rather than adding a null guard to the game or Socket.

```sh
node scripts/check-frame-script-errors.cjs
```

This check runs the actual MovieClip adapter and scene frame queue with minimal
dependencies. It covers queued initialization after an error, nested callback
scope, deferred navigation, diagnostics, and normal callbacks. It fails against
the previous adapter and passes with the fix.

Browser validation used the actual cached `town-battleon-18sep26.swf`, attached
under a mock World providing the map's startup hooks. Before the fix,
`gotoAndPlay('Blank')` threw the same frame-8 exception into its caller. With the
fix it returned normally, and the map's `cellSetup` callback ran on advancement.
This is an isolated reproduction; a full authenticated server join still needs
verification. Rebuild with `npm run build:prod` and hard-reload the loader page
before retrying. The existing Hono process can keep running.
