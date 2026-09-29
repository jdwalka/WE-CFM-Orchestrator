import def from './worker.js';
import fs from 'node:fs';
const req = new Request('https://leaksnipe.win/blocked', {
  headers: {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    'cf-ray': 'preview-1',
    'cf-connecting-ip': '203.0.113.45',
    'x-forwarded-for': '198.51.100.7, 203.0.113.45',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-platform-version': '"15.0.0"',
    'sec-ch-ua-model': '""',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-arch': '"x86"',
    'sec-ch-ua-bitness': '"64"',
    'accept-language': 'en-US,en;q=0.9',
  },
});
const res = await def.fetch(req, {}, {});
const html = await res.text();
fs.writeFileSync('G:/WECRYP/cloudflare-block-page/preview.html', html);
console.log('preview', html.length, 'bytes, status', res.status);
