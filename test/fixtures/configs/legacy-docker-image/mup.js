module.exports = {
  servers: { one: { host: '192.0.2.70', username: 'root', password: 'pw-legacy' } },
  app: {
    name: 'legacy',
    path: '../app',
    servers: { one: {} },
    env: { ROOT_URL: 'http://legacy.example.com', MONGO_URL: 'mongodb://db.example.com/x' },
  },
};
