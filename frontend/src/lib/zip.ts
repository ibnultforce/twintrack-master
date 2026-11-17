/**
 * Builds a .zip of a few small files, stored without compression, so a download keeps its folders without adding a
 * dependency. Fine for text files of a few hundred kilobytes, such as a module's frontend pack.
 */

export interface ZipEntry {
  /** Forward slashes, such as `api/manifest.json`. */
  path: string;
  content: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bit 11 marks names as UTF-8. */
const UTF8_NAMES_FLAG = 0x0800;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;

export function buildZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const checksum = crc32(entry.content);
    const size = entry.content.length;

    const local = new DataView(new ArrayBuffer(LOCAL_HEADER_SIZE));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_NAMES_FLAG, true);
    local.setUint32(14, checksum, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    localParts.push(new Uint8Array(local.buffer), name, entry.content);

    const central = new DataView(new ArrayBuffer(CENTRAL_HEADER_SIZE));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, UTF8_NAMES_FLAG, true);
    central.setUint32(16, checksum, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), name);

    offset += LOCAL_HEADER_SIZE + name.length + size;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(END_RECORD_SIZE));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)].map((part) => part.slice().buffer), { type: 'application/zip' });
}
