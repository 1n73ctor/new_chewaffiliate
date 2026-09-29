'use strict';
const config = require('./config');
const createApp = require('./app');

const app = createApp();
app.listen(config.port, () => {
  console.log(`Chew Network affiliate site running at ${config.baseUrl}`);
});
