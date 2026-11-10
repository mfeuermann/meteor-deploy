import { Meteor } from 'meteor/meteor';
import { WebApp } from 'meteor/webapp';

// Test fixture for comet-deploy (e2e scenarios): a native module, settings/env
// passthrough and a switch that makes the app crash on start.
if (process.env.CRASH_ON_START === '1') process.exit(1);

WebApp.handlers.get('/native', (req, res) => {
  const bcrypt = require('bcrypt');
  res.end(String(bcrypt.hashSync('x', 4).length));
});

WebApp.handlers.get('/env', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ s: Meteor.settings.public?.s, e: process.env.SPECIAL }));
});

Meteor.startup(() => {
  console.log('sample-app started');
});
