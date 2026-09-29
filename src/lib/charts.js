'use strict';
// Server-rendered SVG column chart (single series). Marks: ≤24px columns with
// a 4px rounded data-end, square at the baseline; 1px recessive gridlines on
// clean ticks; each column has a full-height hit area with a hover/focus tooltip.
const { esc, num, parseSql } = require('./util');

function niceStep(raw) {
  if (raw <= 1) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const dayLabel = (d) => parseSql(`${d} 00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function columnPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function barChart(series, { unit = 'clicks', label = 'Clicks per day', empty = 'No activity in this period yet.' } = {}) {
  const max = Math.max(0, ...series.map((s) => s.n));
  if (!max) return `<div class="chart-empty">${esc(empty)}</div>`;

  const W = 720;
  const H = 230;
  const padL = 40;
  const padR = 6;
  const padT = 14;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = (v) => padT + plotH - (v / top) * plotH;
  const slot = plotW / series.length;
  const barW = Math.max(2, Math.min(24, slot - 2));

  let grid = '';
  for (let v = 0; v <= top; v += step) {
    grid += `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`;
    grid += `<text class="axis-label" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${num(v)}</text>`;
  }

  let bars = '';
  series.forEach((s, i) => {
    const cx = padL + slot * i + slot / 2;
    const tip = `${dayLabel(s.date)} · ${num(s.n)} ${s.n === 1 ? unit.replace(/s$/, '') : unit}`;
    const h = (s.n / top) * plotH;
    bars += `<g class="bar-g" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}">`;
    bars += `<rect class="hit" x="${cx - slot / 2}" y="${padT}" width="${slot}" height="${plotH}"/>`;
    if (s.n > 0) bars += `<path class="bar" d="${columnPath(cx - barW / 2, y(s.n), barW, h, 4)}"/>`;
    bars += '</g>';
  });

  const ticks = [0, Math.floor((series.length - 1) / 2), series.length - 1];
  const xLabels = [...new Set(ticks)]
    .map((i) => {
      const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
      const x = i === 0 ? padL : i === series.length - 1 ? W - padR : padL + slot * i + slot / 2;
      return `<text class="axis-label" x="${x}" y="${H - 8}" text-anchor="${anchor}">${esc(dayLabel(series[i].date))}</text>`;
    })
    .join('');

  const peak = series.reduce((a, b) => (b.n > a.n ? b : a));
  const aria = `${label}. ${series.length} days, total ${num(series.reduce((t, s) => t + s.n, 0))}. Peak ${num(peak.n)} on ${dayLabel(peak.date)}.`;
  const rows = series
    .filter((s) => s.n > 0)
    .map((s) => `<tr><td>${esc(dayLabel(s.date))}</td><td class="num">${num(s.n)}</td></tr>`)
    .join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${grid}<line class="baseline" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>${bars}${xLabels}</svg>
<details class="chart-table"><summary>View as table</summary><div class="table-wrap"><table class="table"><thead><tr><th>Day</th><th class="num">${esc(unit[0].toUpperCase() + unit.slice(1))}</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

module.exports = { barChart };
