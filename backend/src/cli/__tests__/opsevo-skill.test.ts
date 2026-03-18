import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

describe('opsevo-skill CLI', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsevo-skill-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const cliPath = path.resolve(__dirname, '..', 'opsevo-skill.ts');

  function run(args: string): string {
    return execSync(`npx ts-node "${cliPath}" ${args}`, {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 15000,
    });
  }

  it('should print usage when no command is given', () => {
    const output = run('');
    expect(output).toContain('Usage:');
    expect(output).toContain('init');
  });

  it('should generate a node skill capsule skeleton', () => {
    const output = run('init --name test-skill --runtime node');
    expect(output).toContain('Skill Capsule "test-skill" created');

    const skillDir = path.join(tmpDir, 'test-skill');
    expect(fs.existsSync(skillDir)).toBe(true);

    // capsule.json
    const config = JSON.parse(fs.readFileSync(path.join(skillDir, 'capsule.json'), 'utf-8'));
    expect(config.name).toBe('test-skill');
    expect(config.version).toBe('0.1.0');
    expect(config.runtime).toBe('node');
    expect(config.entrypoint).toBe('index.ts');
    expect(config.id).toBeDefined();
    expect(Array.isArray(config.capabilities)).toBe(true);
    expect(config.inputSchema).toBeDefined();
    expect(config.outputSchema).toBeDefined();

    // SKILL.md
    const skillMd = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('name: test-skill');

    // index.ts
    expect(fs.existsSync(path.join(skillDir, 'index.ts'))).toBe(true);

    // __tests__/
    expect(fs.existsSync(path.join(skillDir, '__tests__', 'test-skill.test.ts'))).toBe(true);
  });

  it('should generate a python skill capsule skeleton', () => {
    const output = run('init --name py-skill --runtime python');
    expect(output).toContain('Skill Capsule "py-skill" created');

    const skillDir = path.join(tmpDir, 'py-skill');
    const config = JSON.parse(fs.readFileSync(path.join(skillDir, 'capsule.json'), 'utf-8'));
    expect(config.runtime).toBe('python');
    expect(config.entrypoint).toBe('main.py');

    expect(fs.existsSync(path.join(skillDir, 'main.py'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, '__tests__', 'test_py_skill.py'))).toBe(true);
  });

  it('should default to node runtime when --runtime is omitted', () => {
    run('init --name default-rt');
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'default-rt', 'capsule.json'), 'utf-8'),
    );
    expect(config.runtime).toBe('node');
  });

  it('should fail if directory already exists', () => {
    fs.mkdirSync(path.join(tmpDir, 'existing-skill'));
    expect(() => run('init --name existing-skill')).toThrow();
  });

  it('should fail on invalid skill name', () => {
    expect(() => run('init --name InvalidName')).toThrow();
    expect(() => run('init --name 123bad')).toThrow();
  });

  it('should generate capsule.json that passes validateSkillCapsule', () => {
    run('init --name valid-capsule --runtime node');
    const configPath = path.join(tmpDir, 'valid-capsule', 'capsule.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Inline validation matching the SkillCapsule schema requirements
    expect(typeof config.id).toBe('string');
    expect(config.id.length).toBeGreaterThan(0);
    expect(typeof config.name).toBe('string');
    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof config.description).toBe('string');
    expect(Array.isArray(config.capabilities)).toBe(true);
    expect(config.capabilities.length).toBeGreaterThan(0);
    expect(typeof config.inputSchema).toBe('object');
    expect(typeof config.outputSchema).toBe('object');
    expect(['node', 'python', 'bash']).toContain(config.runtime);
    expect(typeof config.entrypoint).toBe('string');
  });
});
