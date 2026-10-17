// Lightweight canvas line chart (no libraries). Theme-aware, HiDPI, hover tooltip.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function lineChart(canvas, { points, series, yMax, yFormat = v => String(v), xFormat }) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(200, rect.width), hgt = Math.max(100, rect.height);
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const padL = 46, padR = 10, padT = 10, padB = 22;
  const plotW = w - padL - padR, plotH = hgt - padT - padB;
  const grid = cssVar('--border') || '#232937';
  const faint = cssVar('--text-faint') || '#6b7383';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = faint;
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;

  if (!points.length) {
    ctx.textAlign = 'center';
    ctx.fillText('No data yet — samples are recorded every 10 seconds', w / 2, hgt / 2);
    return;
  }
  const max = yMax || Math.max(1, ...series.flatMap(s => points.map(p => p[s.key] || 0))) * 1.15;
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const x = t => padL + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const y = v => padT + plotH - (v / max) * plotH;

  for (let i = 0; i <= 4; i++) {
    const gy = padT + (plotH / 4) * i;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(yFormat(max * (1 - i / 4)), padL - 6, gy + 4);
  }
  ctx.textAlign = 'center';
  const fmt = xFormat || (t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  for (let i = 0; i <= 4; i++) {
    const t = t0 + ((t1 - t0) * i) / 4;
    ctx.fillText(fmt(t), Math.min(w - padR - 20, Math.max(padL + 20, x(t))), hgt - 6);
  }

  for (const s of series) {
    const color = cssVar(s.color) || s.color;
    ctx.beginPath();
    points.forEach((p, i) => { const px = x(p.t), py = y(p[s.key] || 0); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    if (s.fill) {
      ctx.lineTo(x(t1), padT + plotH);
      ctx.lineTo(x(t0), padT + plotH);
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  canvas.onmousemove = e => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const t = t0 + ((mx - padL) / plotW) * (t1 - t0);
    let best = points[0];
    for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    canvas.title = `${new Date(best.t).toLocaleString()}\n` + series.map(s => `${s.label}: ${yFormat(best[s.key] || 0)}`).join('\n');
  };
}
