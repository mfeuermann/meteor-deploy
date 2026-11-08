module.exports = {
  servers: { one: { host: '192.0.2.60', username: 'root', password: 'pw-reg' } },
  app: {
    name: 'reg-app',
    path: '../app',
    servers: { one: {} },
    env: { ROOT_URL: 'https://reg.example.com', MONGO_URL: 'mongodb://db.example.com/x' },
    docker: { image: 'zodern/meteor:latest', args: ['--cpus=2'], networks: ['backend'] },
    log: { opts: { 'max-size': '10m', 'max-file': 3 } },
    volumes: { '/a': '/b', '/c': '/d' },
  },
  privateDockerRegistry: { host: 'reg.example.com', imagePrefix: 'reg.example.com/team', username: 'u', password: 'registry-pw' },
};
