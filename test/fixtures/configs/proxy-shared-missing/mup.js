// proxy.shared names a file that does not exist: commands must stop before they change anything.
module.exports = {
  servers: { one: { host: '192.0.2.71', username: 'root', password: 'pw-missing' } },
  app: {
    name: 'missing-app',
    path: '../app',
    servers: { one: {} },
    env: { ROOT_URL: 'https://missing.example.com', MONGO_URL: 'mongodb://db.example.com/x' },
    docker: { image: 'zodern/meteor' },
  },
  proxy: { domains: 'missing.example.com', shared: { nginxConfig: './missing-nginx.conf' } },
};
