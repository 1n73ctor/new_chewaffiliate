'use strict';
const path = require('path');
const express = require('express');
require('express-async-errors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const config = require('./config');
const db = require('./db');
const settings = require('./lib/settings');
const auth = require('./lib/auth');
const icon = require('./lib/icons');
const util = require('./lib/util');
const constants = require('./lib/constants');
const { barChart } = require('./lib/charts');

const ASSET_VERSION = Date.now().toString(36);

function createApp() {
  db.migrate();
  require('./db/seed').ensureBaseData();

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          mediaSrc: ["'self'", 'https:'],
          fontSrc: ["'self'", 'data:'],
          frameSrc: ['https://www.youtube-nocookie.com', 'https://www.youtube.com', 'https://player.vimeo.com'],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"],
          formAction: ["'self'"],
          ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.isProd,
    }),
  );
  app.use(compression());
  app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.use('/uploads', express.static(config.uploadDir, { maxAge: config.isProd ? '7d' : 0 }));
  app.use(express.urlencoded({ extended: false, limit: '300kb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // res.page(view, locals): render a view inside a layout (public | office | admin | join).
  app.use((req, res, next) => {
    res.page = (view, locals = {}) => {
      const layout = locals.layout || res.locals.layout || 'public';
      res.render(view, locals, (err, html) => {
        if (err) return next(err);
        res.render(`layouts/${layout}`, { ...locals, body: html });
      });
    };
    Object.assign(res.locals, {
      site: settings.all(),
      icon,
      u: util,
      C: constants,
      barChart,
      baseUrl: config.baseUrl,
      currentPath: req.path,
      assetVersion: ASSET_VERSION,
      isProd: config.isProd,
      title: null,
      description: null,
      bodyClass: '',
    });
    next();
  });
  app.use(auth.flash);
  app.use(auth.loadUser);
  app.use(auth.csrf);

  app.use(require('./routes/track'));
  app.use(require('./routes/public'));
  app.use(require('./routes/auth'));
  app.use('/join', require('./routes/join'));
  app.use('/office', require('./routes/office'));
  app.use('/admin', require('./routes/admin'));
  app.use('/api/v1', require('./routes/api'));
  if (!config.isProd) app.use('/dev', require('./routes/dev'));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
    res.status(404).page('public/message', {
      title: 'Page not found',
      heading: 'We couldn’t find that page',
      message: 'The link may be old or mistyped.',
      actions: [{ href: '/', label: 'Go to homepage' }],
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.flash && res.flash('error', 'That file is too large.');
      return res.redirect('back');
    }
    console.error(err);
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server_error' });
    res.status(500);
    try {
      res.page('public/message', { title: 'Something went wrong', heading: 'Something went wrong', message: 'Please try again in a moment.' });
    } catch {
      res.send('Something went wrong.');
    }
  });

  return app;
}

module.exports = createApp;
