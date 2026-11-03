import * as fs from 'fs';
import * as zlib from 'zlib';

function createPng(width, height) {
  // Simple solid dark background with elegant emerald green card cut icon
  const rawData = Buffer.alloc((width * 4 + 1) * height);
  
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (width * 4 + 1);
    rawData[rowOffset] = 0; // Filter type: None

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      
      // Rounded card shape 1
      const inCard1 = x >= 24 && x <= 80 && y >= 32 && y <= 104;
      // Rounded card shape 2 (slanted/transposed)
      const inCard2 = x >= 48 && x <= 104 && y >= 20 && y <= 92;

      // Dark obsidian background: #0F141C
      let r = 15, g = 20, b = 28, a = 255;

      if (inCard2) {
        // Deep emerald: #059669
        r = 5; g = 150; b = 105;
      }
      if (inCard1) {
        // Bright mint/cyan: #10B981
        r = 16; g = 185; b = 129;
        // Border highlight
        if (x === 24 || x === 80 || y === 32 || y === 104) {
          r = 52; g = 211; b = 153;
        }
      }

      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(rawData);
  
  // PNG Header
  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  
  const ihdrChunk = makeChunk('IHDR', ihdrData);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([header, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(calcCrc(body), 0);
  
  return Buffer.concat([len, body, crc]);
}

function calcCrc(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

const png = createPng(128, 128);
fs.writeFileSync('media/icon.png', png);
console.log('Icon generated at media/icon.png');

