import { describe, expect, it } from 'vitest';
import { setupAll } from '../../../src/cli/commands/setup.js';
import { createContext, type CommandContext } from '../../../src/core/context.js';
import { renderMongoStartScript } from '../../../src/mongo/render.js';
import { builtInMongoProblem } from '../../../src/mongo/rules.js';
import { mongoSetup, mongoStart, mongoStop } from '../../../src/mongo/setup.js';
import { createReporter } from '../../../src/output/reporter.js';
import type { ExecResult, SshConnection } from '../../../src/ssh/connection.js';
import { tempDir } from '../../helpers/fs.js';

interface Opts {
  appServers?: string;
  mongo?: string;
  extra?: string;
}

const MUP = (o: Opts) => `module.exports = {
  servers: {
    one: { host: '192.0.2.1', username: 'root', password: 'pw' },
    two: { host: '192.0.2.2', username: 'root', password: 'pw' },
    db: { host: '192.0.2.9', username: 'root', password: 'pw' },
  },
  app: { name: 'myapp', path: '../app', servers: ${o.appServers ?? '{ one: {} }'}, env: { ROOT_URL: 'http://a.com' }, docker: { image: 'zodern/meteor' } },
  mongo: ${o.mongo ?? "{ version: '7.0.14', servers: { one: {} } }"},
  ${o.extra ?? ''}
};`;

/** What the fake server answers. `states` are the outputs of mongo-state.sh, in call order (the last repeats). */
interface World {
  states?: string[];
  startOutput?: string;
  /** Exit code and stderr of mongo-start.sh (default 0). */
  startFails?: { code: number; stderr: string };
}

const label = (s: string): string => {
  if (s.includes('# mongo-state.sh')) return 'state';
  if (s.includes('sudo mkdir -p /opt/mongodb')) return 'mongo-setup.sh';
  if (s.includes('Please run "mup mongo setup"')) return 'mongo-start.sh';
  if (s.includes('bash /opt/mongodb/mongo-start-current.sh')) return 'start-current';
  if (s.includes('docker exec mongodb mongod --shutdown') && !s.includes('docker run')) return 'mongo-stop.sh';
  if (s.includes('echo "acquired"')) return 'lock';
  if (s.includes('deploy.lock') || s.includes('LOCK_DIR')) return 'unlock';
  if (s.includes('minimumMajor=18')) return 'docker-setup';
  if (s.includes('# proxy-inputs.sh')) return 'proxy-digest';
  if (s.includes('/opt/mup-nginx-proxy/certs')) return 'proxy-setup';
  if (s.includes('sudo mkdir -p /opt/')) return 'meteor-setup';
  return s.trim().split('\n')[0].slice(0, 40);
};

const RUNNING_6 = 'set_up=1\nnew_version=6.0.13\ncurrent_version=6.0.13\nrunning=1\ncontainer=c1\nfcv=6.0';

async function setup(o: Opts = {}, world: World = {}) {
  const dir = tempDir({ '.deploy/mup.js': MUP(o), '.deploy/settings.json': '{"public":{}}' });
  const out: string[] = [];
  const log: string[] = [];
  const writes: Record<string, string> = {};
  let stateCalls = 0;
  const conn = (name: string) => {
    const run = async (s: string): Promise<ExecResult> => {
      const l = label(s);
      log.push(`${name}:${l}`);
      let stdout = '';
      if ((l === 'mongo-start.sh' || l === 'start-current') && world.startFails) return { code: world.startFails.code, stdout: world.startOutput ?? '', stderr: world.startFails.stderr };
      if (l === 'state') {
        const list = world.states ?? ['set_up=0\nrunning=0'];
        stdout = list[Math.min(stateCalls++, list.length - 1)];
      } else if (l === 'lock') stdout = 'acquired\n';
      else if (l === 'mongo-start.sh') stdout = world.startOutput ?? 'Different start script\n';
      else if (l === 'proxy-digest') stdout = 'digest=a\nrunning=1\n';
      return { code: 0, stdout, stderr: '' };
    };
    return {
      name,
      host: name,
      runScript: run,
      runScriptOrThrow: run,
      exec: run,
      writeFile: async (path: string, content: string) => {
        log.push(`${name}:write ${path}`);
        writes[path] = content;
      },
    } as unknown as SshConnection;
  };
  const ctx: CommandContext = await createContext(
    { config: '.deploy/mup.js' },
    {
      cwd: dir,
      reporter: createReporter({ verbose: false, tty: false, write: (s) => void out.push(s) }),
      sshPoolFactory: () => ({ get: async (n: string) => conn(n), closeAll: async () => {} }),
    },
  );
  // The lock writes its holder record first; that write is part of 'lock'.
  const steps = (server: string) =>
    log.filter((l) => l.startsWith(`${server}:`) && !l.includes('.deploy.lock')).map((l) => l.slice(server.length + 1));
  return { ctx, log, steps, writes, out: () => out.join('') };
}

describe('mongo setup', () => {
  it("writes MUP's start script after the setup script, under the lock", async () => {
    const s = await setup();
    await mongoSetup(s.ctx);
    expect(s.steps('one')).toEqual(['lock', 'state', 'mongo-setup.sh', 'write /opt/mongodb/mongo-start-new.sh', 'unlock']);
    expect(s.writes['/opt/mongodb/mongo-start-new.sh']).toBe(await renderMongoStartScript({ version: '7.0.14' }));
    expect(s.ctx.runner.history).toEqual(['mongo.setup']);
  });

  it('refuses a skipped series before writing anything', async () => {
    const s = await setup({}, { states: ['set_up=1\nnew_version=5.0.31\ncurrent_version=5.0.31\nrunning=1\ncontainer=c1\nfcv=5.0'] });
    await expect(mongoSetup(s.ctx)).rejects.toThrow(/one release series at a time[\s\S]*--allow-mongo-version-change/);
    expect(s.steps('one')).not.toContain('mongo-setup.sh');
    expect(Object.keys(s.writes).filter((w) => !w.includes('.deploy.lock'))).toEqual([]);
    expect(s.steps('one').at(-1)).toBe('unlock');
  });

  it('--allow-mongo-version-change writes anyway', async () => {
    const s = await setup({}, { states: ['set_up=1\nnew_version=5.0.31\ncurrent_version=5.0.31\nrunning=1\ncontainer=c1\nfcv=5.0'] });
    await mongoSetup(s.ctx, { allowVersionChange: true });
    expect(s.steps('one')).toContain('write /opt/mongodb/mongo-start-new.sh');
    expect(s.out()).toMatch(/allow-mongo-version-change/);
  });

  it('prints MUP\'s line without a mongo section', async () => {
    const s = await setup({ mongo: 'undefined' });
    await mongoSetup(s.ctx);
    expect(s.out()).toContain('Not setting up built-in mongodb since there is no mongo config');
    expect(s.log).toEqual([]);
  });
});

describe('mongo start', () => {
  it('start judges the scripts on the server, not the config', async () => {
    const s = await setup({}, { states: ['set_up=1\nnew_version=8.0.4\ncurrent_version=6.0.13\nrunning=1\ncontainer=c1\nfcv=6.0'] });
    await expect(mongoStart(s.ctx)).rejects.toThrow(/6\.0\.13 → 8\.0\.4/);
    expect(s.steps('one')).not.toContain('mongo-start.sh');
  });

  it("keeps a running container whose start script did not change without running MUP's script", async () => {
    // MUP's script would do nothing here, unless its "docker ps" (without sudo) fails for an
    // SSH user outside the docker group: then it recreates the container every time.
    const s = await setup({}, { states: [`${RUNNING_6}\nsame_script=1`] });
    await mongoStart(s.ctx);
    expect(s.steps('one')).toEqual(['lock', 'state', 'unlock']);
    expect(s.out()).toContain('MongoDB is up to date (container kept)');
  });

  it('starts a stopped container with the unchanged start script itself', async () => {
    // MUP's script decides with "docker ps -f name=mongodb", which also matches other
    // containers such as "mongodb-backup", and then starts nothing.
    const before = `${RUNNING_6.replace('running=1', 'running=0').replace('fcv=6.0', '')}\nsame_script=1`;
    const s = await setup({}, { states: [before, RUNNING_6] });
    await mongoStart(s.ctx);
    expect(s.steps('one')).toEqual(['lock', 'state', 'start-current', 'state', 'unlock']);
    expect(s.out()).toContain('MongoDB started');
  });

  it('fails when MongoDB does not run after the start script', async () => {
    const s = await setup({}, { states: ['set_up=1\nnew_version=6.0.13\nrunning=0', 'set_up=1\nnew_version=6.0.13\ncurrent_version=6.0.13\nrunning=0'] });
    await expect(mongoStart(s.ctx)).rejects.toThrow(/MongoDB is not running after the start script/);
  });

  it('reports a recreated container and how to raise the FCV after an upgrade', async () => {
    const before = 'set_up=1\nnew_version=7.0.14\ncurrent_version=6.0.13\nrunning=1\ncontainer=c1\nfcv=6.0';
    const after = 'set_up=1\nnew_version=7.0.14\ncurrent_version=7.0.14\nrunning=1\ncontainer=c2\nfcv=6.0';
    const s = await setup({}, { states: [before, after], startOutput: 'Different start script\n' });
    await mongoStart(s.ctx);
    expect(s.out()).toContain('MongoDB recreated: the start script changed (6.0.13 → 7.0.14)');
    expect(s.out()).toContain('setFeatureCompatibilityVersion: "7.0", confirm: true');
  });

  it("accepts MUP's replica set step failing on data that has the replica set already", async () => {
    // mongosh (MongoDB 6+) throws "already initialized" where the old mongo shell printed it,
    // so MUP's start script exits 1 after 20 tries although MongoDB runs fine.
    const before = `${RUNNING_6.replace('running=1', 'running=0')}\nsame_script=1`;
    const after = `${RUNNING_6}\nreplica_set=meteor`;
    const s = await setup({}, { states: [before, after], startOutput: 'Same start script\nCreating replica set\n', startFails: { code: 1, stderr: 'Failed connecting to mongo to create replica set\n' } });
    await mongoStart(s.ctx);
    expect(s.out()).toContain('MongoDB started');
  });

  it('a start script that fails otherwise still fails', async () => {
    const s = await setup({}, { states: [RUNNING_6.replace('running=1', 'running=0'), 'set_up=1\nrunning=0'], startOutput: 'Same start script\n', startFails: { code: 1, stderr: 'docker: Error response from daemon\n' } });
    await expect(mongoStart(s.ctx)).rejects.toThrow(/Starting MongoDB failed \(exit code 1\)[\s\S]*Error response from daemon/);
  });

  it('says how to set MongoDB up when the server has no start script', async () => {
    const s = await setup({}, { states: ['set_up=0\nrunning=0'] });
    await expect(mongoStart(s.ctx)).rejects.toThrow(/comet-deploy mongo setup/);
    expect(s.steps('one')).not.toContain('mongo-start.sh');
  });

  it('refuses without a mongo section', async () => {
    const s = await setup({ mongo: 'undefined' });
    await expect(mongoStart(s.ctx)).rejects.toThrow('The config has no "mongo" section.');
  });
});

describe('mongo stop', () => {
  it("runs MUP's stop script under the lock", async () => {
    const s = await setup({}, { states: [RUNNING_6] });
    await mongoStop(s.ctx);
    expect(s.steps('one')).toEqual(['lock', 'state', 'mongo-stop.sh', 'unlock']);
  });

  it('does nothing when there is no container', async () => {
    const s = await setup({}, { states: ['set_up=1\nrunning=0'] });
    await mongoStop(s.ctx);
    expect(s.steps('one')).not.toContain('mongo-stop.sh');
    expect(s.out()).toMatch(/not running/);
  });
});

describe('the one-app-server constraint', () => {
  it('start and setup skip with the reason when the constraint fails', async () => {
    const s = await setup({ appServers: '{ one: {}, two: {} }' });
    const reason = builtInMongoProblem(s.ctx.config)!;
    await mongoSetup(s.ctx);
    await mongoStart(s.ctx);
    expect(s.log).toEqual([]);
    expect(s.out()).toContain(reason);
  });
});

describe('setup', () => {
  it('setup runs mongo between the app dirs and the proxy', async () => {
    const s = await setup({ extra: "proxy: { domains: 'a.com' }," }, { states: ['set_up=0\nrunning=0', 'set_up=1\nnew_version=7.0.14\nrunning=0', 'set_up=1\nnew_version=7.0.14\ncurrent_version=7.0.14\nrunning=1\ncontainer=c1'] });
    await setupAll(s.ctx);
    expect(s.ctx.runner.history).toEqual(['default.setup', 'docker.setup', 'meteor.setup', 'mongo.setup', 'mongo.start', 'proxy.setup', 'proxy.start']);
    const steps = s.steps('one');
    expect(steps.indexOf('mongo-setup.sh')).toBeGreaterThan(steps.indexOf('meteor-setup'));
    expect(steps.indexOf('mongo-start.sh')).toBeLessThan(steps.indexOf('proxy-setup'));
    expect(s.out()).not.toMatch(/phase 2/);
  });

  it('setup skips mongo with the reason and goes on with the proxy', async () => {
    const s = await setup({ mongo: "{ version: '7.0.14', servers: { db: {} } }", extra: "proxy: { domains: 'a.com' }," });
    await setupAll(s.ctx);
    expect(s.log.filter((l) => l.includes('mongo'))).toEqual([]);
    expect(s.steps('one')).toContain('proxy-setup');
    const reason = builtInMongoProblem(s.ctx.config)!;
    // Once from validate, once from the setup step; the start step does not repeat it.
    expect(s.out()).toContain(`MongoDB is not set up: ${reason}`);
    expect(s.out()).not.toContain('MongoDB is not started');
  });

  it('a failing pre.mongo.start hook stops setup after the MongoDB setup', async () => {
    const s = await setup({ extra: "hooks: { 'pre.mongo.start': { localCommand: 'exit 7' } }," }, { states: ['set_up=0\nrunning=0', 'set_up=1\nnew_version=7.0.14\nrunning=0'] });
    await expect(setupAll(s.ctx)).rejects.toThrow('exited with code 7');
    expect(s.steps('one')).toContain('mongo-setup.sh');
    expect(s.steps('one')).not.toContain('mongo-start.sh');
  });
});
