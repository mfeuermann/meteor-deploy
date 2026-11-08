module.exports = {
  servers: {
    one: { host: '192.0.2.20', username: 'deployer', pem: '~/.ssh/id_example', opts: { port: 2222 } },
    two: { host: '192.0.2.21', username: 'deployer', password: 'p@ss:w"rd' },
  },
  app: {
    name: 'per-server',
    path: '/srv/apps/per-server',
    servers: {
      one: { env: { PORT: 4000, ROLE: 'primary', EXTRA: 'one-only' }, bind: '127.0.0.1' },
      two: { settings: 'settings.two.json' },
    },
    env: { ROOT_URL: 'https://per-server.example.com', MONGO_URL: 'mongodb://db.example.com/x', FLAG: true, NUM: 7 },
    docker: { image: 'zodern/meteor:root', imagePort: 3001, bind: '0.0.0.0', networks: ['net-a'] },
    log: { driver: 'json-file', opts: { 'max-size': '50m' } },
    volumes: { '/data/uploads': '/uploads' },
    deployCheckWaitTime: 120,
    buildOptions: { buildLocation: '/tmp/per-server-build', debug: true },
  },
};
