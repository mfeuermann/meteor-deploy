// The proxy also runs on "three", which has no app; load balancing is off in this config.
module.exports = {
  servers: {
    one: { host: '192.0.2.72', username: 'root', password: 'pw-extra', privateIp: '10.0.0.1' },
    three: { host: '192.0.2.73', username: 'root', password: 'pw-extra' },
  },
  app: {
    name: 'extra-app',
    path: '../app',
    servers: { one: {} },
    env: { ROOT_URL: 'https://extra.example.com', MONGO_URL: 'mongodb://db.example.com/x' },
    docker: { image: 'zodern/meteor' },
  },
  proxy: { domains: 'extra.example.com', servers: { one: {}, three: {} } },
};
