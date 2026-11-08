module.exports = {
  servers: { one: { host: '192.0.2.40', username: 'root', password: 'pw-proxy' } },
  app: {
    name: 'proxy-le',
    path: '../app',
    servers: { one: {} },
    env: { ROOT_URL: 'http://a.com:3000', MONGO_URL: 'mongodb://db.example.com/x' },
    docker: { image: 'zodern/meteor' },
  },
  proxy: { domains: 'a.com,www.a.com', ssl: { letsEncryptEmail: 'admin@a.com', forceSSL: true } },
};
