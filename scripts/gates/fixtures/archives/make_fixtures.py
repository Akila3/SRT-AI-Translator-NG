# Inert hostile and limit-neighbour ZIP fixtures for Bundle H (implementation_plan.md §10.5, §14.8).
# AUTHORED-BY: opus-5.5-high
#
# Run once by hand; the gate suite reads the committed .zip files and never regenerates them, so a
# fixture is written by Python's zipfile (or patched from its output), never by the reader under test.
# Re-running rewrites byte-identical files (fixed timestamps).
import struct
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MiB = 1024 * 1024
DATE = (2026, 10, 16, 0, 0, 0)
SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n'.encode()
HE_1255 = '1\n00:00:01,000 --> 00:00:02,000\nשלום, את עייפה?\n\n2\n00:00:03,000 --> 00:00:04,000\nכן.\n'.encode('cp1255')


def info(name, method=zipfile.ZIP_DEFLATED, system=0, attr=0):
    zi = zipfile.ZipInfo(name, DATE)
    zi.compress_type = method
    zi.create_system = system
    zi.external_attr = attr
    return zi


def write(path, members, method=zipfile.ZIP_DEFLATED):
    with zipfile.ZipFile(HERE / path, 'w') as z:
        for name, data in members:
            z.writestr(info(name, method), data)


def patch(path, fn):
    p = HERE / path
    p.write_bytes(fn(bytearray(p.read_bytes())))


def set_sizes(buf, declared):
    """Rewrite every header's uncompressed size to `declared` (a size lie; CRC and data unchanged)."""
    i = 0
    while True:
        j = buf.find(b'PK\x03\x04', i)
        if j < 0:
            break
        struct.pack_into('<I', buf, j + 22, declared)
        i = j + 4
    i = 0
    while True:
        j = buf.find(b'PK\x01\x02', i)
        if j < 0:
            break
        struct.pack_into('<I', buf, j + 24, declared)
        i = j + 4
    return bytes(buf)


def set_flag(buf, bit):
    for sig, off in ((b'PK\x03\x04', 6), (b'PK\x01\x02', 8)):
        i = 0
        while True:
            j = buf.find(sig, i)
            if j < 0:
                break
            flags = struct.unpack_from('<H', buf, j + off)[0]
            struct.pack_into('<H', buf, j + off, flags | bit)
            i = j + 4
    return bytes(buf)


# ── valid ──
write('valid.zip', [('Movie.2026.srt', SRT), ('Subs/Movie.2026.HEB.srt', HE_1255), ('readme.txt', b'thanks')])
with zipfile.ZipFile(HERE / 'stored.zip', 'w') as z:
    z.writestr(info('Movie.srt', zipfile.ZIP_STORED), SRT)
    z.writestr(info('Folder/'), b'')

# ── hostile names (§10.5) ──
write('traversal.zip', [('good.srt', SRT), ('../evil.srt', SRT)])
write('absolute.zip', [('/etc/evil.srt', SRT)])
write('winslash.zip', [('..\\evil.srt', SRT)])
write('drive.zip', [('C:evil.srt', SRT)])
write('unc.zip', [('\\\\server\\share\\evil.srt', SRT)])
write('device.zip', [('CON.srt', SRT)])

# ── content (§10.5) ──
write('notsrt.zip', [('movie.srt', b'\x89PNG\r\n\x1a\n' + bytes(range(256)) * 4)])
write('corrupt_srt.zip', [('movie.srt', b'this is not a subtitle at all\njust prose\n')])
write('corrupt_deflate.zip', [('movie.srt', SRT * 20)])
patch('corrupt_deflate.zip', lambda b: bytes(b[:40]) + bytes(x ^ 0x5A for x in b[40:60]) + bytes(b[60:]))
write('nested.zip', [('movie.srt', SRT), ('inner.zip', (HERE / 'valid.zip').read_bytes())])
write('nested_disguised.zip', [('movie.srt', (HERE / 'valid.zip').read_bytes())])
write('encrypted.zip', [('movie.srt', SRT)])
patch('encrypted.zip', lambda b: set_flag(b, 0x1))
with zipfile.ZipFile(HERE / 'symlink.zip', 'w') as z:
    z.writestr(info('movie.srt', zipfile.ZIP_STORED, 3, (0o120777 << 16)), b'/etc/passwd')
write('bzip2.zip', [('movie.srt', SRT)], zipfile.ZIP_BZIP2)

# ── bombs and counts (§10.5, §14.8) ──
with zipfile.ZipFile(HERE / 'bomb_1gb.zip', 'w') as z:
    with z.open(info('movie.srt'), 'w') as f:
        block = b'\0' * MiB
        for _ in range(1024):
            f.write(block)
write('liar_32mb.zip', [('movie.srt', b'\0' * (32 * MiB))])
patch('liar_32mb.zip', lambda b: set_sizes(b, 100))
write('many_10000.zip', [(f'{i:05d}.srt', b'') for i in range(10000)])

# ── four neighbours per frozen limit (§14.8) ──
for n in (127, 128, 129):
    write(f'entries_{n}.zip', [(f'{i:03d}.srt', SRT) for i in range(n)])
for tag, size in (('below', MiB - 1), ('at', MiB), ('above', MiB + 1)):
    write(f'member_{tag}.zip', [('movie.srt', b'a' * size)])
write('member_lie.zip', [('movie.srt', b'a' * (MiB + 1))])
patch('member_lie.zip', lambda b: set_sizes(b, 1000))
write('total_below.zip', [(f'{i:02d}.srt', b'b' * MiB) for i in range(15)] + [('15.srt', b'b' * (MiB - 1))])
write('total_at.zip', [(f'{i:02d}.srt', b'b' * MiB) for i in range(16)])
write('total_above.zip', [(f'{i:02d}.srt', b'b' * MiB) for i in range(16)] + [('16.srt', b'b')])
write('total_lie.zip', [(f'{i:02d}.srt', b'b' * MiB) for i in range(16)] + [('16.srt', b'b' * 64)])
patch('total_lie.zip', lambda b: set_sizes(b, 1000))

for p in sorted(HERE.glob('*.zip')):
    print(f'{p.name:28} {p.stat().st_size:>9}')
