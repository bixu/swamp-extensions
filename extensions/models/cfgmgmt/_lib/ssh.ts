const SOCKET_DIR = "/tmp/cfgmgmt-ssh";

export interface SshConn {
  host: string;
  port: number;
  username: string;
  identityFile?: string;
  socketPath: string;
}

const POOL_KEY = "__cfgmgmt_ssh_pool";
(globalThis as Record<string, unknown>)[POOL_KEY] =
  (globalThis as Record<string, unknown>)[POOL_KEY] ||
  new Map<string, SshConn>();

function pool(): Map<string, SshConn> {
  return (globalThis as Record<string, unknown>)[POOL_KEY] as Map<
    string,
    SshConn
  >;
}

export interface ConnectOpts {
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
}

export async function getConnection(opts: ConnectOpts): Promise<SshConn> {
  const port = opts.port ?? 22;
  const key = `${opts.host}:${port}:${opts.username}`;
  const existing = pool().get(key);
  if (existing) return existing;

  try {
    await Deno.mkdir(SOCKET_DIR, { recursive: true });
  } catch {
    // already exists
  }

  const socketPath = `${SOCKET_DIR}/${opts.host}-${port}-${opts.username}`;
  const conn: SshConn = {
    host: opts.host,
    port,
    username: opts.username,
    identityFile: opts.privateKeyPath,
    socketPath,
  };

  // Check if a ControlMaster socket already exists and is alive
  let needMaster = true;
  try {
    const check = new Deno.Command("ssh", {
      args: [
        "-o", `ControlPath=${socketPath}`,
        "-O", "check",
        `${opts.username}@${opts.host}`,
      ],
      stdout: "null",
      stderr: "null",
    });
    const result = await check.output();
    if (result.code === 0) needMaster = false;
  } catch {
    // socket doesn't exist yet
  }

  if (needMaster) {
    const args = [
      "-M", "-N", "-f",
      "-o", `ControlPath=${socketPath}`,
      "-o", "ControlPersist=300",
      "-p", String(port),
      "-o", "StrictHostKeyChecking=no",
      "-o", "BatchMode=yes",
    ];
    if (opts.privateKeyPath) args.push("-i", opts.privateKeyPath);
    args.push(`${opts.username}@${opts.host}`);

    const cmd = new Deno.Command("ssh", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (output.code !== 0) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(`SSH ControlMaster failed for ${key}: ${stderr}`);
    }
  }

  pool().set(key, conn);
  return conn;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function exec(
  conn: SshConn,
  command: string,
): Promise<ExecResult> {
  const args = [
    "-o", `ControlPath=${conn.socketPath}`,
    "-p", String(conn.port),
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=yes",
  ];
  if (conn.identityFile) args.push("-i", conn.identityFile);
  args.push(`${conn.username}@${conn.host}`, command);

  const cmd = new Deno.Command("ssh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    exitCode: output.code,
  };
}

export async function writeFile(
  conn: SshConn,
  remotePath: string,
  content: string,
): Promise<void> {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, content);
    const args = [
      "-o", `ControlPath=${conn.socketPath}`,
      "-P", String(conn.port),
      "-o", "StrictHostKeyChecking=no",
      "-o", "BatchMode=yes",
    ];
    if (conn.identityFile) args.push("-i", conn.identityFile);
    args.push(tmpFile, `${conn.username}@${conn.host}:${remotePath}`);

    const cmd = new Deno.Command("scp", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (output.code !== 0) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(`scp to ${remotePath} failed: ${stderr}`);
    }
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
}

export interface BecomeOpts {
  become?: boolean;
  becomeUser?: string;
  becomePassword?: string;
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export function wrapSudo(command: string, opts?: BecomeOpts): string {
  if (!opts?.become) return command;
  const user = opts.becomeUser || "root";
  const escaped = shellEscape(command);
  if (opts.becomePassword) {
    const pw = shellEscape(opts.becomePassword);
    return `echo ${pw} | sudo -S -p '' -u ${user} -- sh -c ${escaped}`;
  }
  return `sudo -n -u ${user} -- sh -c ${escaped}`;
}

export async function writeFileAs(
  conn: SshConn,
  remotePath: string,
  content: string,
  opts?: BecomeOpts,
): Promise<void> {
  if (!opts?.become) {
    return writeFile(conn, remotePath, content);
  }
  const tmpName = `/tmp/.swamp-upload-${crypto.randomUUID()}`;
  await writeFile(conn, tmpName, content);
  const mv = wrapSudo(`mv ${shellEscape(tmpName)} ${shellEscape(remotePath)}`, opts);
  const result = await exec(conn, mv);
  if (result.exitCode !== 0) {
    await exec(conn, `rm -f ${shellEscape(tmpName)}`);
    throw new Error(`writeFileAs mv to ${remotePath} failed: ${result.stderr}`);
  }
}

export function closeAll(): void {
  for (const conn of pool().values()) {
    try {
      new Deno.Command("ssh", {
        args: [
          "-o", `ControlPath=${conn.socketPath}`,
          "-O", "exit",
          `${conn.username}@${conn.host}`,
        ],
        stdout: "null",
        stderr: "null",
      }).outputSync();
    } catch {
      // ignore close errors
    }
  }
  pool().clear();
}
