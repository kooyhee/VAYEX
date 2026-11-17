import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TextDecoder } from 'node:util';

export class Peer extends EventEmitter {
  constructor(socket, maxBytes) {
    super(); this.socket = socket; this.maxBytes = maxBytes; this.buffer = Buffer.alloc(0); this.fragments = []; this.fragmentBytes = 0; this.fragmented = false; this.blocked = false; this.closed = false;
    socket.on('data', chunk => this.consume(chunk));
    socket.on('drain', () => { this.blocked = false; this.emit('drain'); });
    // The upgraded socket is allowHalfOpen, so a client FIN ends nothing by itself.
    socket.on('end', () => this.close());
    socket.on('error', () => this.close());
    socket.on('close', () => { clearTimeout(this.closeTimer); this.closeTimer = null; this.closed = true; this.emit('close'); });
  }
  writeFrame(opcode, data, { allowClosed = false, bypassQueueLimit = false } = {}) {
    if (this.closed && !allowClosed) return false;
    const header = Buffer.alloc(data.length < 126 ? 2 : data.length <= 65535 ? 4 : 10);
    if (!bypassQueueLimit && this.socket.writableLength + header.length + data.length > this.maxBytes * 4) { this.close(1009); return false; }
    header[0] = 0x80 | opcode;
    if (header.length === 2) header[1] = data.length;
    else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(data.length, 2); }
    else { header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    this.socket.cork(); this.socket.write(header); const ok = this.socket.write(data); this.socket.uncork();
    if (!ok) this.blocked = true;
    return ok;
  }
  send(frame) { const data = Buffer.from(JSON.stringify(frame)); if (data.length > this.maxBytes) { this.close(1009); return false; } return this.writeFrame(1, data); }
  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    if (this.socket.writableLength + 4 > this.maxBytes * 4) {
      this.socket.destroy();
      return;
    }
    const data = Buffer.alloc(2); data.writeUInt16BE(code);
    this.writeFrame(8, data, { allowClosed:true, bypassQueueLimit:true });
    this.closeTimer = setTimeout(() => { this.closeTimer = null; this.socket.destroy(); }, 500); this.closeTimer.unref();
    this.socket.end();
  }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2 && !this.closed) {
      const b = this.buffer, fin = !!(b[0] & 128), opcode = b[0] & 15;
      if ((b[0] & 112) || !(b[1] & 128)) return this.close(1002);
      let length = b[1] & 127, offset = 2;
      if (length === 126) { if (b.length < 4) return; length = b.readUInt16BE(2); offset = 4; }
      if (length === 127) { if (b.length < 10) return; const n = b.readBigUInt64BE(2); if (n > BigInt(this.maxBytes)) return this.close(1009); length = Number(n); offset = 10; }
      if (length > this.maxBytes || (opcode >= 8 && (!fin || length > 125))) return this.close(1009);
      if (b.length < offset + 4 + length) return;
      const mask = b.subarray(offset, offset + 4), data = Buffer.from(b.subarray(offset + 4, offset + 4 + length));
      this.buffer = b.subarray(offset + 4 + length);
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      if (opcode === 8) return this.close();
      if (opcode === 9) { this.writeFrame(10, data); continue; }
      if (opcode === 10) continue;
      if (opcode !== 0 && opcode !== 1) return this.close(1003);
      if ((opcode === 0 && !this.fragmented) || (opcode === 1 && this.fragmented)) return this.close(1002);
      this.fragments.push(data); this.fragmentBytes += data.length;
      if (this.fragmentBytes > this.maxBytes) return this.close(1009);
      this.fragmented = !fin;
      if (fin) {
        const combined = Buffer.concat(this.fragments); this.fragments = []; this.fragmentBytes = 0;
        try { this.emit('message', JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(combined))); }
        catch { this.close(1007); }
      }
    }
  }
}
export function upgrade(request, socket, maxBytes) {
  const key = request.headers['sec-websocket-key'];
  if (request.headers.upgrade?.toLowerCase() !== 'websocket' || request.headers['sec-websocket-version'] !== '13' || !key || Buffer.from(key, 'base64').length !== 16) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return null; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new Peer(socket, maxBytes);
}
