module.exports = {
  servers: {
    one: { host: '192.0.2.50', username: 'root', password: 'pw-lb', privateIp: '10.0.0.1' },
    two: { host: '192.0.2.51', username: 'root', password: 'pw-lb', privateIp: '10.0.0.2' },
  },
  app: {
    name: 'production',
    path: '../app',
    servers: { one: {}, two: {} },
    env: { ROOT_URL: 'https://lb.example.com', MONGO_URL: 'mongodb://db.example.com/x' },
    docker: { image: 'zodern/meteor', imagePort: 3000 },
  },
  proxy: { domains: 'lb.example.com', loadBalancing: true, stickySessions: false, ssl: { forceSSL: true } },
};
