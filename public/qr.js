// QR-code als SVG-element (zonder innerHTML), op basis van qrcode-generator (MIT).
import qrcode from './vendor/qrcode.js';

export function qrSvg(text, { ecc = 'M', margin = 2 } = {}) {
  const q = qrcode(0, ecc);
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + margin} ${y + margin}h1v1h-1z`;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  const size = n + margin * 2;
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'qr');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d); p.setAttribute('fill', '#000');
  svg.append(bg, p);
  return svg;
}
