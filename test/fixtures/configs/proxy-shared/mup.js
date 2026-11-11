module.exports = {
  servers: { one: { host: '192.0.2.70', username: 'root', password: 'pw-shared' } },
  app: {
    name: 'shared-app',
    path: '../app',
    servers: { one: {} },
    env: { ROOT_URL: 'https://shared.example.com', MONGO_URL: 'mongodb://db.example.com/x' },
    docker: { image: 'zodern/meteor' },
  },
  proxy: {
    domains: 'shared.example.com',
    ssl: { letsEncryptEmail: 'admin@shared.example.com' },
    shared: {
      httpPort: 8080,
      httpsPort: 8443,
      clientUploadLimit: '20M',
      nginxConfig: './nginx-shared.conf',
      templatePath: './shared.tmpl',
      env: { DEFAULT_HOST: 'shared.example.com', SECRET_TOKEN: 'shared-secret-1' },
      envLetsEncrypt: { ACME_CA_URI: 'https://acme.example.com/dir', DEBUG: true, KEY: 'le-secret-123' },
    },
  },
};
