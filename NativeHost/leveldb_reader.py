import struct
import glob
import os

try:
    import cramjam
    def _snappy(data):
        return bytes(cramjam.snappy.decompress_raw(data))
except Exception:
    def _snappy(data):
        raise RuntimeError("snappy decompression unavailable (pip install cramjam)")

MAGIC = 0xDB4775248B80FB57


def _varint(buf, pos):
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, pos


def _load_block(data, offset, size):
    block = data[offset:offset + size]
    comp = data[offset + size]
    if comp == 1:
        block = _snappy(block)
    elif comp != 0:
        return None
    return block


def _parse_block(block):
    n = len(block)
    if n < 4:
        return []
    num_restarts = struct.unpack("<I", block[n - 4:n])[0]
    restart_start = n - 4 - num_restarts * 4
    if restart_start < 0:
        restart_start = n - 4
    pos = 0
    last_key = b""
    entries = []
    while pos < restart_start:
        shared, pos = _varint(block, pos)
        non_shared, pos = _varint(block, pos)
        value_len, pos = _varint(block, pos)
        key = last_key[:shared] + block[pos:pos + non_shared]
        pos += non_shared
        value = block[pos:pos + value_len]
        pos += value_len
        last_key = key
        entries.append((key, value))
    return entries


def read_ldb(path):
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 48:
        return []
    footer = data[-48:]
    magic = struct.unpack("<Q", footer[40:48])[0]
    if magic != MAGIC:
        return []
    pos = 0
    _, pos = _varint(footer, pos)
    _, pos = _varint(footer, pos)
    index_off, pos = _varint(footer, pos)
    index_size, pos = _varint(footer, pos)

    index_block = _load_block(data, index_off, index_size)
    if index_block is None:
        return []
    out = []
    for _key, handle in _parse_block(index_block):
        if len(handle) < 2:
            continue
        try:
            hp = 0
            blk_off, hp = _varint(handle, hp)
            blk_size, hp = _varint(handle, hp)
            if blk_off + blk_size + 1 > len(data):
                continue
            block = _load_block(data, blk_off, blk_size)
            if block is None:
                continue
            for key, value in _parse_block(block):
                if len(key) < 8:
                    continue
                trailer = int.from_bytes(key[-8:], "little")
                seq = trailer >> 8
                deleted = (trailer & 0xFF) == 0
                out.append((key[:-8], None if deleted else value, seq))
        except Exception:
            continue
    return out


def read_log(path):
    with open(path, "rb") as f:
        data = f.read()
    records = []
    pos = 0
    pending = b""
    while pos + 7 <= len(data):
        block_remaining = 32768 - (pos % 32768)
        if block_remaining < 7:
            pos += block_remaining
            continue
        length = struct.unpack("<H", data[pos + 4:pos + 6])[0]
        rectype = data[pos + 6]
        payload = data[pos + 7:pos + 7 + length]
        pos += 7 + length
        if rectype == 1:
            records.append(payload)
        elif rectype == 2:
            pending = payload
        elif rectype == 3:
            pending += payload
        elif rectype == 4:
            records.append(pending + payload)
            pending = b""
    out = []
    for batch in records:
        if len(batch) < 12:
            continue
        seq = int.from_bytes(batch[0:8], "little")
        bp = 12
        try:
            while bp < len(batch):
                t = batch[bp]
                bp += 1
                klen, bp = _varint(batch, bp)
                key = batch[bp:bp + klen]
                bp += klen
                if t == 1:
                    vlen, bp = _varint(batch, bp)
                    value = batch[bp:bp + vlen]
                    bp += vlen
                    out.append((key, value, seq))
                elif t == 0:
                    out.append((key, None, seq))
                else:
                    break
                seq += 1
        except Exception:
            continue
    return out


def read_all(leveldb_dir):
    best = {}
    for path in sorted(glob.glob(os.path.join(leveldb_dir, "*.ldb"))):
        for key, value, seq in read_ldb(path):
            if key not in best or seq >= best[key][1]:
                best[key] = (value, seq)
    for path in sorted(glob.glob(os.path.join(leveldb_dir, "*.log"))):
        for key, value, seq in read_log(path):
            if key not in best or seq >= best[key][1]:
                best[key] = (value, seq)
    return {k: v for k, (v, _seq) in best.items() if v is not None}
