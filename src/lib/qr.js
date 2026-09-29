'use strict';
const QRCode = require('qrcode');

const opts = { margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0e4d2c', light: '#ffffff' } };

const svg = (text) => QRCode.toString(text, { ...opts, type: 'svg' });
const png = (text, width = 1024) => QRCode.toBuffer(text, { ...opts, type: 'png', width, margin: 2 });

module.exports = { svg, png };
