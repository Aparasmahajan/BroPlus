// Vault — secrets for `${vault:name}` references (ARCHITECTURE.md §8.3).
//
// Values are encrypted with Electron's safeStorage (DPAPI on Windows, Keychain
// on macOS) into <configDir>/api/vault.bin, and only ever decrypted in main at
// send time. The UI can list names, set and delete — it can never read a value
// back. Collections reference secrets by name, so a collection file you share
// or commit holds no secrets.
import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export class Vault {
  private readonly path: string;
  private data: Record<string, string> = {};
  private loaded = false;

  constructor(configDir: string) {
    this.path = join(configDir, 'api', 'vault.bin');
  }

  get available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async keys(): Promise<string[]> {
    await this.load();
    return Object.keys(this.data).sort();
  }

  async get(name: string): Promise<string | undefined> {
    await this.load();
    return this.data[name];
  }

  async set(name: string, value: string): Promise<void> {
    if (!this.available) throw new Error('Secure storage is not available on this system');
    await this.load();
    this.data[name] = value;
    await this.save();
  }

  async remove(name: string): Promise<void> {
    await this.load();
    delete this.data[name];
    await this.save();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const buf = await fs.readFile(this.path);
      this.data = JSON.parse(safeStorage.decryptString(buf)) as Record<string, string>;
    } catch {
      this.data = {}; // first run (or a vault from another OS user — unreadable by design)
    }
  }

  private async save(): Promise<void> {
    const enc = safeStorage.encryptString(JSON.stringify(this.data));
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, enc);
    await fs.rename(tmp, this.path);
  }
}
