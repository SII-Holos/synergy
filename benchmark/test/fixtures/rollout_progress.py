import base64
import ctypes
import ctypes.util
import json
import sqlite3
import sys
import zlib
from contextlib import closing
from pathlib import Path

# The record body column has no affinity, so it holds three forms and a reader
# that understands only one of them reports a recorded response as absent. This
# probe is the only non-TypeScript reader of that column, so it decodes all three
# rather than the two it was written against:
#
#   * `str` without a prefix: plain JSON.
#   * `str` with `z:`: the retired base64 deflate form.
#   * `bytes` whose first byte is 0x1A: the current frame, whose header carries
#     the codec and the declared decoded length.
#
# The declaration is what bounds decompression here too: the output buffer is
# allocated at exactly the declared size, and a result of any other length is
# rejected instead of trusted.
FRAME_MARKER = 0x1A
CODEC_RAW = 0
CODEC_ZSTD = 1
MAX_BODY_BYTES = 128 * 1024 * 1024
_LIBZSTD = None


def _read_varint(body: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 1
    index = offset
    while index < len(body) and index - offset < 5:
        byte = body[index]
        value += (byte & 0x7F) * shift
        index += 1
        if not byte & 0x80:
            return value, index
        shift *= 128
    raise ValueError("Invalid record length prefix")


def _zstd_library():
    # Resolved once: the probe re-reads every rollout row on each poll, so a
    # dlopen per body would repeat this lookup thousands of times per second.
    global _LIBZSTD
    if _LIBZSTD is None:
        lib = ctypes.CDLL(ctypes.util.find_library("zstd") or "libzstd.so.1")
        lib.ZSTD_decompress.restype = ctypes.c_size_t
        lib.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
        lib.ZSTD_isError.restype = ctypes.c_uint
        lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
        _LIBZSTD = lib
    return _LIBZSTD


def _zstd(payload: bytes, declared: int) -> bytes:
    lib = _zstd_library()
    source = ctypes.create_string_buffer(payload, len(payload))
    # The declared length sizes the destination exactly, so a frame that decodes
    # to more than it claims cannot make this allocate past the declared bound.
    target = ctypes.create_string_buffer(declared)
    written = lib.ZSTD_decompress(target, declared, source, len(payload))
    if lib.ZSTD_isError(written):
        raise ValueError("Stored record compression is invalid")
    if written != declared:
        raise ValueError("Stored record length disagrees with its header")
    return target.raw[:written]


def decode(body):
    if isinstance(body, (bytes, bytearray, memoryview)):
        frame = bytes(body)
        if len(frame) < 3 or frame[0] != FRAME_MARKER:
            raise ValueError("Stored record frame is invalid")
        codec = frame[1]
        declared, start = _read_varint(frame, 2)
        if not 0 <= declared <= MAX_BODY_BYTES:
            raise ValueError("Stored record length is out of range")
        payload = frame[start:]
        if codec == CODEC_ZSTD:
            return json.loads(_zstd(payload, declared).decode("utf-8"))
        if codec == CODEC_RAW:
            if len(payload) != declared:
                raise ValueError("Stored record length disagrees with its header")
            return json.loads(payload.decode("utf-8"))
        raise ValueError("Unknown record codec")
    if body.startswith("z:"):
        body = zlib.decompress(base64.b64decode(body[2:], validate=True)).decode()
    return json.loads(body)


root = Path(sys.argv[1] if len(sys.argv) > 1 else "/logs/agent/home/.synergy/data/storage")
namespace = json.loads((root / "manifest.json").read_text())["namespace"]
with closing(sqlite3.connect((root / "agent.sqlite").as_uri() + "?mode=ro", uri=True)) as db:
    rows = [
        (json.loads(key), decode(body))
        for key, body in db.execute(
            "SELECT key_text, body FROM storage_records WHERE namespace=? AND kind='rollout' AND body IS NOT NULL",
            (namespace,),
        )
    ]
calls = {
    (tuple(key[:6]), key[7])
    for key, value in rows
    if len(key) == 8 and key[4] == "runs" and key[6] == "calls" and value["purpose"] == "synergy"
}
print(
    any(
        len(key) == 9
        and key[6] == "attempts"
        and (tuple(key[:6]), key[7]) in calls
        and (value.get("response") or {}).get("bytes", 0) > 0
        for key, value in rows
    )
)
