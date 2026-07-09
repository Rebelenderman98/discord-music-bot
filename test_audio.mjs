import { spawn } from 'child_process';
import https from 'https';
import os from 'os';
import path from 'path';
import fs from 'fs';

const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const ytDlp = '.\\yt-dlp.exe';
import ffmpegStatic from 'ffmpeg-static';
console.log('ffmpeg:', ffmpegStatic);

// Approach 1: yt-dlp -g + https direct fetch
console.log('\n=== Approach 1: yt-dlp -g + https fetch ===');
try {
  const directUrl = await new Promise((resolve, reject) => {
    const yt = spawn(ytDlp, ['-g', '-f', 'bestaudio', url, '--no-warnings']);
    let out = '';
    yt.stdout.on('data', d => out += d.toString());
    yt.stderr.on('data', () => {});
    yt.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`)));
    yt.on('error', reject);
  });
  console.log('Got URL of length:', directUrl.length);
  const data = await new Promise((resolve, reject) => {
    https.get(directUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`status ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 100000) { res.destroy(); resolve(Buffer.concat(chunks)); } });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
  console.log('Got', data.length, 'bytes from direct fetch - OK');
} catch (e) {
  console.log('Approach 1 FAILED:', e.message);
}

// Approach 2: yt-dlp -o - pipe to ffmpeg stdin
console.log('\n=== Approach 2: yt-dlp pipe to ffmpeg stdin ===');
try {
  const data = await new Promise((resolve, reject) => {
    const yt = spawn(ytDlp, ['-f', 'bestaudio', '-o', '-', url, '--no-warnings']);
    const ff = spawn(ffmpegStatic, ['-i', 'pipe:0', '-f', 's16le', '-ac', '2', '-ar', '48000', '-vn', '-']);
    yt.stdout.pipe(ff.stdin);
    let errBuf = '';
    ff.stderr.on('data', d => errBuf += d.toString());
    const chunks = [];
    ff.stdout.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 100000) { ff.kill(); yt.kill(); resolve(Buffer.concat(chunks)); } });
    ff.on('error', (e) => { console.log('ffmpeg error:', e.message); reject(e); });
    yt.on('error', (e) => { console.log('yt error:', e.message); reject(e); });
    setTimeout(() => {
      if (chunks.length === 0) {
        console.log('stderr:', errBuf.substring(0, 500));
        reject(new Error('timeout'));
      }
    }, 15000);
  });
  console.log('Got', data.length, 'bytes from ffmpeg pipe - OK');
} catch (e) {
  console.log('Approach 2 FAILED:', e.message);
}

// Approach 3: yt-dlp -o - directly
console.log('\n=== Approach 3: yt-dlp -o - directly ===');
try {
  const data = await new Promise((resolve, reject) => {
    const yt = spawn(ytDlp, ['-f', 'bestaudio', '-o', '-', url, '--no-warnings']);
    const chunks = [];
    yt.stdout.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 100000) { yt.kill(); resolve(Buffer.concat(chunks)); } });
    yt.stderr.on('data', () => {});
    yt.on('error', reject);
    setTimeout(() => chunks.length === 0 ? reject(new Error('timeout')) : resolve(Buffer.concat(chunks)), 15000);
  });
  console.log('Got', data.length, 'bytes from yt-dlp direct - OK');
} catch (e) {
  console.log('Approach 3 FAILED:', e.message);
}

// Approach 4: yt-dlp download to temp file
console.log('\n=== Approach 4: temp file ===');
try {
  const tmp = path.join(os.tmpdir(), `test_${Date.now()}.opus`);
  await new Promise((resolve, reject) => {
    const yt = spawn(ytDlp, ['-f', 'bestaudio', '-o', tmp, url, '--no-warnings']);
    yt.stderr.on('data', () => {});
    yt.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    yt.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 20000);
  });
  const stat = fs.statSync(tmp);
  console.log('Downloaded file:', tmp, stat.size, 'bytes');
  fs.unlinkSync(tmp);
} catch (e) {
  console.log('Approach 4 FAILED:', e.message);
}

process.exit(0);
