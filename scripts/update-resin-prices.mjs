// Cập nhật giá nhựa mỗi sáng -> prices.json (Node 20, không cần thư viện ngoài).
// Nguồn: SunSirs (CNY/ton -> USD theo tỷ giá thực), BusinessAnalytiq (USD/MT), Resource Recycling RSS (cents/lb -> USD/ton).
// Nguyên tắc: KHÔNG bịa số. Nguồn nào quét không ra thì giữ giá cũ của kỳ trước và đánh dấu stale:true.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
export const SRC = {
  sun_pet: 'https://www.sunsirs.com/uk/prodetail-235.html',
  sun_hdpe: 'https://www.sunsirs.com/uk/prodetail-199.html',
  ba_pet: 'https://businessanalytiq.com/procurementanalytics/index/pet-price-index/',
  ba_hdpe: 'https://businessanalytiq.com/procurementanalytics/index/hdpe-price-index/',
  rr_plastics: 'https://resource-recycling.com/plastics/feed/',
  rr_recycling: 'https://resource-recycling.com/recycling/feed/',
  ba_rpet: 'https://businessanalytiq.com/procurementanalytics/index/recycled-pet-price-index/',
  ba_rhdpe: 'https://businessanalytiq.com/procurementanalytics/index/recycled-hdpe-price-index/',
};
const get = async (u, ms = 25000) => {
  const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html,application/xml,*/*' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};
const dec = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&');
export const strip = (h) => dec(String(h || '').replace(/<!\[CDATA\[|\]\]>/g, ' ').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const num = (s) => parseFloat(String(s).replace(/,/g, ''));
const inRange = (v, a, b) => Number.isFinite(v) && v >= a && v <= b;

/* SunSirs: bảng "ngày + giá (RMB/ton)" -> lấy dòng ngày mới nhất, đổi sang USD/ton. kw = từ khóa xác nhận đúng sản phẩm */
export function parseSunsirs(html, kw, fx) {
  const t = strip(html);
  if (!kw.test(t.slice(0, 4000))) return null;
  const pairs = [...t.matchAll(/(20\d\d-\d\d-\d\d)\s+([\d,]{4,9}(?:\.\d+)?)/g)].map((m) => [m[1], num(m[2])]).filter((p) => inRange(p[1], 2000, 30000)).sort((a, b) => b[0].localeCompare(a[0]));
  let v = pairs[0] && pairs[0][1];
  if (!v) { const m = /([\d,]{4,9}(?:\.\d+)?)\s*(?:Yuan|RMB|CNY)/i.exec(t); v = m && num(m[1]); }
  return inRange(v, 2000, 30000) && fx ? Math.round(v / fx) : null;
}
/* BusinessAnalytiq: số "USD ... /MT" đầu tiên hợp lý */
export function parseBA(html, kw) {
  const t = strip(html);
  if (kw && !kw.test(t.slice(0, 6000))) return null;
  const m = /(?:USD|US\$|\$)\s?([\d,]{3,6}(?:\.\d+)?)\s*(?:\/|per)\s*(?:MT|mt|ton|tonne|metric ton)/i.exec(t) || /([\d,]{3,6}(?:\.\d+)?)\s*(?:USD|US\$)\s*(?:\/|per)\s*(?:MT|ton|tonne)/i.exec(t);
  const v = m && num(m[1]);
  return inRange(v, 400, 6000) ? Math.round(v) : null;
}
/* Resource Recycling RSS: tìm câu có "rPET / HDPE ... xx cents per pound" ở các bài mới nhất -> USD/ton (x22.0462) */
export function parseRR(xml, kind) {
  const re = kind === 'pet'
    ? /\b(?:rPET|recycled PET|PET (?:bales?|flakes?|clear)|clear PET)\b[^.]{0,160}?(\d{1,3}(?:\.\d+)?)\s*(?:cents?|¢)\s*(?:per|\/)\s*(?:lb|pound)/i
    : /\b(?:rHDPE|recycled HDPE|natural HDPE|HDPE (?:bales?|natural|flakes?))\b[^.]{0,160}?(\d{1,3}(?:\.\d+)?)\s*(?:cents?|¢)\s*(?:per|\/)\s*(?:lb|pound)/i;
  for (const blk of String(xml).split(/<item[\s>]/i).slice(1)) {
    const m = re.exec(strip(blk));
    if (m) { const v = Math.round(num(m[1]) * 22.0462); if (inRange(v, 150, 4500)) return v; }
  }
  return null;
}
const first = async (list) => { for (const [name, fn] of list) { try { const v = await fn(); if (v) return { price: v, src: name }; } catch (e) { console.warn('  ✗', name, '-', e.message); } } return null; };

async function main() {
  const today = new Date(Date.now() + 7 * 3600e3);            // giờ Việt Nam
  const ddmmyyyy = `${String(today.getUTCDate()).padStart(2, '0')}/${String(today.getUTCMonth() + 1).padStart(2, '0')}/${today.getUTCFullYear()}`;
  let old = {}; try { old = JSON.parse(await readFile('prices.json', 'utf8')); } catch (e) { /* lần đầu */ }
  let fx = null; try { fx = (await (await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(15000) })).json()).rates.CNY; } catch (e) { console.warn('✗ tỷ giá CNY:', e.message); }
  console.log('FX CNY/USD =', fx);
  const cache = {}; const page = (u) => (cache[u] ||= get(u));
  const jobs = {
    pet_virgin: ['PET Virgin', [['SunSirs', async () => parseSunsirs(await page(SRC.sun_pet), /PET|polyethylene terephthalate|polyester/i, fx)], ['BusinessAnalytiq', async () => parseBA(await page(SRC.ba_pet), /PET/i)]]],
    hdpe_virgin: ['HDPE Virgin', [['SunSirs', async () => parseSunsirs(await page(SRC.sun_hdpe), /HDPE|high[- ]density/i, fx)], ['BusinessAnalytiq', async () => parseBA(await page(SRC.ba_hdpe), /HDPE/i)]]],
    rpet: ['PET Recycling', [['Resource Recycling', async () => parseRR(await page(SRC.rr_plastics), 'pet') || parseRR(await page(SRC.rr_recycling), 'pet')], ['BusinessAnalytiq', async () => parseBA(await page(SRC.ba_rpet), /recycl/i)]]],
    rhdpe: ['HDPE Recycling', [['Resource Recycling', async () => parseRR(await page(SRC.rr_plastics), 'hdpe') || parseRR(await page(SRC.rr_recycling), 'hdpe')], ['BusinessAnalytiq', async () => parseBA(await page(SRC.ba_rhdpe), /recycl/i)]]],
  };
  const items = {};
  for (const [key, [name, srcs]] of Object.entries(jobs)) {
    const o = (old.items && old.items[key]) || null;
    const r = await first(srcs);
    if (r) {
      const prev = o ? (o.date === ddmmyyyy ? o.prev : o.price) : null;
      const change = prev ? Math.round(((r.price - prev) / prev) * 10000) / 100 : null;
      items[key] = { name, price: r.price, unit: 'USD/ton', prev, change, src: r.src, date: ddmmyyyy, stale: false };
      console.log('✓', name, r.price, 'USD/ton', `(${r.src})`, change == null ? '' : change + '%');
    } else if (o) { items[key] = { ...o, stale: true }; console.warn('! giữ giá cũ:', name, o.price, o.date);
    } else console.warn('! không có dữ liệu:', name);
  }
  const out = { updated_at: new Date().toISOString(), date: ddmmyyyy, fx: { CNY: fx }, items };
  await writeFile('prices.json', JSON.stringify(out, null, 2) + '\n');
  console.log('Đã ghi prices.json');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
