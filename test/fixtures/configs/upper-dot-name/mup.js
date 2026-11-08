module.exports = {
  servers: { one: { host: '192.0.2.80', username: 'root', password: 'pw-upper' } },
  app: {
    name: 'My.App',
    path: '../app',
    servers: { one: {} },
    env: { ROOT_URL: 'https://my.example.com', MONGO_URL: 'mongodb://db.example.com/x' },
    docker: { image: 'zodern/meteor' },
  },
};
