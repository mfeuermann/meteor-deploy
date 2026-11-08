module.exports = {
  servers: {
    one: { host: '192.0.2.10', username: 'root', password: 'example-pass-1' },
    two: { host: '192.0.2.11', username: 'root', password: 'example-pass-2' },
  },
  meteor: {
    name: 'example-app',
    path: '../app',
    servers: { one: {}, two: {} },
    buildOptions: { serverOnly: true },
    env: {
      ROOT_URL: 'http://192.0.2.10:8080',
      PORT: 8080,
      MONGO_URL: 'mongodb://user:secret@192.0.2.50:27017/example',
    },
    enableUploadProgressBar: true,
    dockerImage: 'zodern/meteor:latest',
    docker: {
      args: ['-v /etc/timezone:/etc/timezone', '-v /etc/localtime:/etc/localtime'],
    },
  },
};
