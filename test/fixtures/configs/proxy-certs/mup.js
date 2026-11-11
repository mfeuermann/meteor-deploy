module.exports = {
  servers: { one: { host: '192.0.2.60', username: 'root', password: 'pw-certs' } },
  app: {
    name: 'certs-app',
    path: '../app',
    servers: { one: {} },
    env: { ROOT_URL: 'http://certs.example.com', MONGO_URL: 'mongodb://db.example.com/x' },
    docker: { image: 'zodern/meteor' },
  },
  proxy: {
    domains: 'certs.example.com,www.certs.example.com',
    ssl: { crt: './cert.crt', key: './cert.key', forceSSL: true },
    nginxServerConfig: './nginx-server.conf',
    nginxLocationConfig: './nginx-location.conf',
    clientUploadLimit: '50M',
  },
};
