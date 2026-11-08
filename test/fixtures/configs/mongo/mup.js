module.exports = {
  servers: { one: { host: '192.0.2.30', username: 'root', password: 'pw-mongo' } },
  app: {
    name: 'my.mongo.app',
    path: '../app',
    servers: { one: {} },
    env: { ROOT_URL: 'http://mongo.example.com', MONGO_URL: 'mongodb://ignored/x' },
    docker: { image: 'zodern/meteor', args: ['--memory=1g'] },
  },
  mongo: { version: '6.0.13', servers: { one: {} } },
};
